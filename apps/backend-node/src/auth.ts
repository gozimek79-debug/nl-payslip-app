import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { query } from './database.js';

const COOKIE_NAME = 'loonto_session';
const SESSION_DAYS = 30;

export type AuthUser = { id: string; email: string };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function readCookie(req: Request, name: string): string | null {
  const cookies = req.headers.cookie?.split(';') ?? [];
  for (const cookie of cookies) {
    const [key, ...value] = cookie.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

export async function createSession(userId: string, res: Response): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 * interval '1 day'))`,
    [userId, hashToken(token), SESSION_DAYS],
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export async function currentUser(req: Request): Promise<AuthUser | null> {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;
  const users = await query<AuthUser>(
    `SELECT u.id, u.email
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.deleted_at IS NULL`,
    [hashToken(token)],
  );
  return users[0] ?? null;
}

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'Zaloguj się, aby zobaczyć tę stronę.' });
      return;
    }
    res.locals.user = user;
    next();
  } catch {
    res.status(503).json({ error: 'Logowanie jest chwilowo niedostępne.' });
  }
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, COOKIE_NAME);
  if (token) await query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashToken(token)]);
  res.clearCookie(COOKIE_NAME, { path: '/' });
}
