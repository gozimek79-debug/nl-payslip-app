import { randomBytes } from 'node:crypto';
import { databaseConfigured, query } from '../database.js';
import { DOCUMENT_SESSION_MAX_AGE_SECONDS } from './session.js';

/**
 * R3-B.2: server-owned, short-lived document records (the trust anchor between "Gemini read this document on this
 * server" and "this conversation may use it").
 *
 *   batch   - one fact batch exactly as THIS server's reader route produced it from Gemini;
 *   context - the Payroll Profile this server resolved from such batches, plus its sanitized Document Knowledge.
 *
 * The client only ever holds an opaque random reference. A record is returned only for the same session (see
 * session.ts) and before it expires; nothing a client sends is ever stored as a document fact. No PDF, no page image
 * and no text layer is stored - only the extracted facts, for at most two hours, then deleted.
 *
 * Postgres (the existing DATABASE_URL). The table creates itself on first use, like `rate_limits`; migration
 * packages/database/migrations/005-document-contexts.sql documents the same DDL. Without a database the store is
 * simply unavailable: references are not issued and every conversation runs in the untrusted mode (`trusted: null`).
 */

export type StoredRecord =
  | { kind: 'batch'; documentKind: 'payslip' | 'contract'; batch: unknown }
  | { kind: 'context'; profile: unknown; knowledge: unknown };

const DDL = `CREATE TABLE IF NOT EXISTS document_contexts (
  ref text PRIMARY KEY,
  session_hash text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`;
const UNDEFINED_TABLE = '42P01';
export const DOCUMENT_REF = /^[A-Za-z0-9_-]{32}$/;

async function withTable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== UNDEFINED_TABLE) throw error;
    await query(DDL);
    return run();
  }
}

export const storeAvailable = () => databaseConfigured;

/** Stores a record for this session; returns its opaque reference, or null when the store is unavailable. */
export async function putRecord(sessionHash: string, record: StoredRecord): Promise<string | null> {
  if (!databaseConfigured) return null;
  const ref = randomBytes(24).toString('base64url');
  try {
    await withTable(async () => {
      await query('DELETE FROM document_contexts WHERE expires_at < now()');
      await query(
        `INSERT INTO document_contexts (ref, session_hash, kind, payload, expires_at) VALUES ($1, $2, $3, $4, now() + ($5 * interval '1 second'))`,
        [ref, sessionHash, record.kind, JSON.stringify(record), DOCUMENT_SESSION_MAX_AGE_SECONDS],
      );
    });
    return ref;
  } catch (error) {
    // Never log the record (personal payroll data) - the error class only.
    console.error('document context store error', error instanceof Error ? error.name : 'unknown');
    return null;
  }
}

/** The record behind a reference - only for the SAME session, only before it expires, only of the expected kind. */
export async function getRecord<K extends StoredRecord['kind']>(ref: string, sessionHash: string | null, kind: K): Promise<Extract<StoredRecord, { kind: K }> | null> {
  if (!databaseConfigured || !sessionHash || !DOCUMENT_REF.test(ref)) return null;
  try {
    const rows = await withTable(() => query<{ kind: string; payload: unknown }>(
      'SELECT kind, payload FROM document_contexts WHERE ref = $1 AND session_hash = $2 AND expires_at > now()',
      [ref, sessionHash],
    ));
    const row = rows[0];
    if (!row || row.kind !== kind) return null;
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    return payload && typeof payload === 'object' && (payload as { kind?: unknown }).kind === kind ? (payload as Extract<StoredRecord, { kind: K }>) : null;
  } catch (error) {
    console.error('document context store error', error instanceof Error ? error.name : 'unknown');
    return null;
  }
}
