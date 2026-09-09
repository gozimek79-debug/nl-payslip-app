import type { NextFunction, Request, Response } from 'express';
import { databaseConfigured, query } from './database.js';

/**
 * Fixed-window rate limiter backed by Postgres, not in-process memory — this app runs as
 * stateless Vercel serverless functions, so an in-memory counter would reset (or diverge across
 * concurrent instances) on every cold start and would not actually limit anything.
 *
 * The increment is a single atomic UPSERT: the CASE expressions reset the window when it has
 * expired and increment it otherwise, all inside one statement, so concurrent requests for the
 * same key cannot race past the limit against each other the way a separate read-then-write would.
 *
 * Fails open (allows the request) when the database is not configured or the query itself fails —
 * consistent with the rest of the app's "static fallback over hard failure" pattern. This means a
 * misconfigured deployment loses the rate limit rather than becoming unusable; that tradeoff is a
 * deliberate choice for a public-facing tool with no user accounts on most of the routes, not an
 * oversight.
 */
export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  if (!databaseConfigured) return true;
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
    return count <= limit;
  } catch (error) {
    console.error(`Rate limit check failed for "${key}"`, error);
    return true;
  }
}

/**
 * Express middleware factory. `routeName` scopes the limit per endpoint group so uploading a
 * payslip and analysing a contract don't share one budget; the client is identified by IP
 * (req.ip, which reflects X-Forwarded-For correctly because app.ts sets `trust proxy`).
 */
export function ipRateLimit(routeName: string, limit: number, windowSeconds: number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `${routeName}:${req.ip ?? 'unknown'}`;
    const allowed = await checkRateLimit(key, limit, windowSeconds);
    if (!allowed) {
      res.status(429).json({ error: 'Zbyt wiele żądań z tego adresu. Spróbuj ponownie za chwilę.' });
      return;
    }
    next();
  };
}
