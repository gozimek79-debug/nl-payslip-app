import { Pool, type PoolClient, type QueryResultRow } from 'pg';

const connectionString = process.env.DATABASE_URL;
const pool = connectionString
  ? new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 2_000 })
  : null;

export const databaseConfigured = Boolean(pool);

export async function checkDatabase(): Promise<'connected' | 'unavailable' | 'not_configured'> {
  if (!pool) return 'not_configured';
  try {
    await pool.query('SELECT 1');
    return 'connected';
  } catch {
    return 'unavailable';
  }
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  if (!pool) return [];
  const result = await pool.query<T>(text, values);
  return result.rows;
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T | null> {
  if (!pool) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
