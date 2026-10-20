import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

/**
 * R3-B.2: the browser session a server-held document record is bound to.
 *
 * Vercel Authentication protects the whole deployment at the edge, but it gives the Express app no verifiable user
 * identity - so no owner id is invented here. Instead the server issues its own random session id in an HttpOnly,
 * SameSite=Strict cookie scoped to /api, and every document record is stored under the SHA-256 of that id. A record
 * reference therefore works only from the browser that created it (a leaked reference is useless elsewhere) and only
 * until the record expires. JavaScript never sees the id; it is never logged.
 */

export const DOCUMENT_SESSION_COOKIE = 'loonto_doc_session';
export const DOCUMENT_SESSION_MAX_AGE_SECONDS = 2 * 60 * 60;
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.split('=');
    if (rawName?.trim() === name) return rest.join('=').trim();
  }
  return null;
}

export function sessionHash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex');
}

/** The current session's hash, or null when the request carries no well-formed session cookie. */
export function readSessionHash(req: Request): string | null {
  const id = cookieValue(req, DOCUMENT_SESSION_COOKIE);
  return id && SESSION_ID.test(id) ? sessionHash(id) : null;
}

/** The current session's hash; a new session cookie is issued when the request has none. */
export function ensureSessionHash(req: Request, res: Response): string {
  const existing = readSessionHash(req);
  if (existing) return existing;
  const id = randomBytes(32).toString('base64url');
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
  res.cookie(DOCUMENT_SESSION_COOKIE, id, { httpOnly: true, sameSite: 'strict', secure, path: '/api', maxAge: DOCUMENT_SESSION_MAX_AGE_SECONDS * 1000 });
  return sessionHash(id);
}
