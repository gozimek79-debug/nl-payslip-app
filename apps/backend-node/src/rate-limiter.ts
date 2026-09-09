import type { NextFunction, Request, Response } from 'express';
import { databaseConfigured, query } from './database.js';

type RateLimitOutcome = 'allowed' | 'denied' | 'unknown';

/**
 * Fixed-window rate limiter backed by Postgres, not in-process memory — this app runs as
 * stateless Vercel serverless functions, so an in-memory counter would reset (or diverge across
 * concurrent instances) on every cold start and would not actually limit anything.
 *
 * The increment is a single atomic UPSERT: the CASE expressions reset the window when it has
 * expired and increment it otherwise, all inside one statement, so concurrent requests for the
 * same key cannot race past the limit against each other the way a separate read-then-write would.
 *
 * Returns 'unknown' (rather than true/false) when the database is not configured or the query
 * itself fails, so the caller decides what "can't tell" should mean for that route — see
 * ipRateLimit below. There is no single right answer for every route (audit R5/J1): a route that
 * only writes a database row can fail open safely; a route that spends real money on every request
 * (Groq inference) must fail closed, or a database outage turns into unbounded spend.
 */
async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitOutcome> {
  if (!databaseConfigured) return 'unknown';
  try {
    const rows = await query<{ count: number }>(
      `INSERT INTO rate_limits (key, window_start, count)
       VALUES ($1, now(), 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start < now() - ($2 * interval '1 second') THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start < now() - ($2 * interval '1 second') THEN now() ELSE rate_limits.window_start END
       RETURNING count`,
      [key, windowSeconds],
    );
    const count = rows[0]?.count ?? 0;
    return count <= limit ? 'allowed' : 'denied';
  } catch (error) {
    console.error(`Rate limit check failed for "${key}"`, error);
    return 'unknown';
  }
}

/**
 * Express middleware factory. `routeName` scopes the limit per endpoint group so uploading a
 * payslip and analysing a contract don't share one budget; the client is identified by IP
 * (req.ip, which reflects X-Forwarded-For correctly because app.ts sets `trust proxy`).
 *
 * `onUnknown` decides what happens when the limit itself can't be checked (audit R5/J1):
 *   - 'allow' (fail open) — for routes that only write a database row. A missed rate limit on
 *     these is an annoyance, not a cost; refusing a legitimate user because the limiter itself is
 *     down would be a worse outcome than letting a request through unchecked.
 *   - 'deny' (fail closed) — for routes that invoke paid AI inference. Here "can't check the
 *     limit" and "someone could hit this in an unbounded loop right now" are the same risk, and an
 *     unenforceable limit on a route that spends money on every call is worse than a false 503.
 */
export function ipRateLimit(routeName: string, limit: number, windowSeconds: number, onUnknown: 'allow' | 'deny') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `${routeName}:${req.ip ?? 'unknown'}`;
    const outcome = await checkRateLimit(key, limit, windowSeconds);
    if (outcome === 'denied' || (outcome === 'unknown' && onUnknown === 'deny')) {
      const status = outcome === 'unknown' ? 503 : 429;
      const message = outcome === 'unknown'
        ? 'Ta funkcja jest chwilowo niedostępna (nie można zweryfikować limitu żądań). Spróbuj ponownie za chwilę.'
        : 'Zbyt wiele żądań z tego adresu. Spróbuj ponownie za chwilę.';
      res.status(status).json({ error: message });
      return;
    }
    next();
  };
}
