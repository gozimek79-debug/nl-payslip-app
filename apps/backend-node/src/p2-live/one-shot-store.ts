/**
 * P2 LIVE.3 (ZADANIE-P2-LIVE.3-EPHEMERAL-UPSTASH.md, Cursor P2LR-01) - TEMPORARY one-shot lock for the
 * Preview acceptance runner, removed with it. The authority is an external Redis (a dedicated, disposable
 * Upstash database holding nothing but this lock marker), so the claim holds across HTTP requests,
 * concurrent requests, client retries and separate serverless instances - never in-process memory.
 *
 * The only command ever sent is the atomic create-if-absent `SET <key> <marker> NX EX <ttl>`:
 *   "OK"  -> 'acquired'          (this request owns the single run)
 *   null  -> 'already_consumed'  (any earlier request, finished or not, already owns it)
 *   anything else, any transport/HTTP/parse failure, or a timeout -> OneShotStoreError (fail closed).
 * The marker is never released or deleted; the disposable database expiring is the cleanup.
 * Credentials arrive as arguments (the handler reads them), are sent only to an https *.upstash.io host,
 * and never appear in an error: errors carry a fixed code only.
 */

export type AcquireResult = 'acquired' | 'already_consumed';

export interface OneShotStore {
  acquire(key: string, ttlSeconds: number): Promise<AcquireResult>;
}

export type OneShotStoreErrorCode = 'invalid_config' | 'invalid_request' | 'timeout' | 'unreachable' | 'http_status' | 'malformed_reply';

export class OneShotStoreError extends Error {
  constructor(readonly code: OneShotStoreErrorCode) {
    super(`one-shot store: ${code}`);
    this.name = 'OneShotStoreError';
  }
}

const LOCK_MARKER = 'consumed';
const KEY_PATTERN = /^loonto:p2-live:[a-z0-9-]+:[0-9a-f]{64}$/;

function upstashRestUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname.endsWith('.upstash.io') && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function upstashOneShotStore(config: { url: string; token: string }, options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): OneShotStore {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async acquire(key, ttlSeconds) {
      const url = upstashRestUrl(config.url);
      if (!url || !config.token) throw new OneShotStoreError('invalid_config');
      if (!KEY_PATTERN.test(key) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new OneShotStoreError('invalid_request');
      // One timeout covers the whole exchange - connect, status and body - so the store can never hang the run.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let reply: unknown;
      try {
        let res: Response;
        try {
          res = await fetchImpl(url.origin, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(['SET', key, LOCK_MARKER, 'NX', 'EX', String(ttlSeconds)]),
            signal: controller.signal,
          });
        } catch {
          throw new OneShotStoreError(controller.signal.aborted ? 'timeout' : 'unreachable');
        }
        if (res.status !== 200) throw new OneShotStoreError('http_status');
        try {
          reply = await res.json();
        } catch {
          throw new OneShotStoreError(controller.signal.aborted ? 'timeout' : 'malformed_reply');
        }
      } finally {
        clearTimeout(timer);
      }
      if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw new OneShotStoreError('malformed_reply');
      const keys = Object.keys(reply);
      const result = (reply as { result?: unknown }).result;
      if (keys.length !== 1 || keys[0] !== 'result') throw new OneShotStoreError('malformed_reply');
      if (result === 'OK') return 'acquired';
      if (result === null) return 'already_consumed';
      throw new OneShotStoreError('malformed_reply');
    },
  };
}
