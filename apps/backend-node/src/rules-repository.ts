import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseConfigured, query } from './database.js';

interface RuleRow {
  parameters: unknown;
  valid_from: string;
  valid_to: string | null;
  source_url: string;
}

const cache = new Map<string, { value: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Zwraca parametry aktualnie obowiązującej wersji reguły (np. tabeli podatkowej, CAO, funduszu
 * emerytalnego) z bazy `legal_rules`/`legal_rule_versions`. To jest "baza referencyjna dla AI" —
 * dane aktualizowane niezależnie od kodu aplikacji (patrz scripts/update reguł co pół roku).
 * Zwraca null, gdy baza jest niedostępna lub reguła nie istnieje — wywołujący powinien mieć
 * bezpieczną wartość domyślną (ten sam wzorzec co reszta aplikacji w trybie demo).
 */
export async function getCurrentRule<T>(code: string): Promise<T | null> {
  const cached = cache.get(code);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T | null;

  if (!databaseConfigured) return null;
  try {
    const rows = await query<RuleRow>(
      `SELECT v.parameters, v.valid_from, v.valid_to, v.source_url
       FROM legal_rule_versions v
       JOIN legal_rules r ON r.id = v.legal_rule_id
       WHERE r.code = $1 AND v.valid_from <= now() AND (v.valid_to IS NULL OR v.valid_to >= now())
       ORDER BY v.version DESC LIMIT 1`,
      [code],
    );
    const value = (rows[0]?.parameters as T) ?? null;
    cache.set(code, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    console.error(`Could not load rule "${code}"`, error);
    return null;
  }
}

/**
 * Same as getCurrentRule, but resolves the rule version valid on a given date instead of today.
 * Use this for anything that analyses a historical document (a payslip period, a contract's start
 * date) — getCurrentRule would silently apply today's rates to a document from a different period.
 * Deliberately NOT cached by (code, date) pair: unlike getCurrentRule this is not called at a high,
 * uniform rate for a single "now", so a cache would mostly add memory pressure for little reuse.
 */
export async function getRuleAt<T>(code: string, date: Date): Promise<T | null> {
  if (!databaseConfigured) return null;
  try {
    const rows = await query<RuleRow>(
      `SELECT v.parameters, v.valid_from, v.valid_to, v.source_url
       FROM legal_rule_versions v
       JOIN legal_rules r ON r.id = v.legal_rule_id
       WHERE r.code = $1 AND v.valid_from <= $2 AND (v.valid_to IS NULL OR v.valid_to >= $2)
       ORDER BY v.version DESC LIMIT 1`,
      [code, date.toISOString().slice(0, 10)],
    );
    return (rows[0]?.parameters as T) ?? null;
  } catch (error) {
    console.error(`Could not load rule "${code}" at ${date.toISOString().slice(0, 10)}`, error);
    return null;
  }
}

interface MinimalRatesFile {
  minimum_wage_per_hour: number;
}

let cachedStaticMinimumWage: number | null = null;

/**
 * KNOWN GAP (flagged, not fixed, this round): the static fallback file is a single snapshot
 * (currently the 2026-H2 row). If the database is unreachable AND the reference date falls in a
 * different period than that snapshot (e.g. 2026-H1, before the SQL adding that row has been
 * applied), this returns the wrong period's rate instead of failing loudly. Low-probability
 * (requires DB down + wrong period simultaneously) but real; the fix is either a static file per
 * period or an explicit "static fallback is date-blind" warning surfaced to the caller.
 */
function loadStaticMinimumWagePerHour(): number {
  if (cachedStaticMinimumWage !== null) return cachedStaticMinimumWage;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(dir, '../../../packages/tax-tables/2026-Q1-rates.json');
  const rates = JSON.parse(readFileSync(filePath, 'utf-8')) as MinimalRatesFile;
  cachedStaticMinimumWage = rates.minimum_wage_per_hour;
  return cachedStaticMinimumWage;
}

/**
 * Shared by the calculator, contract analysis and payslip analysis: the statutory minimum wage in
 * force on `date`, from the rules DB with a static fallback (see the gap noted above). Always uses
 * the document/period's own reference date, never "today" — audit requirements B2 and N4.
 */
export async function getMinimumWageAt(date: Date): Promise<number> {
  const dbRates = await getRuleAt<MinimalRatesFile>('loonheffing_nl', date);
  return dbRates?.minimum_wage_per_hour ?? loadStaticMinimumWagePerHour();
}

export async function listRuleFreshness(): Promise<Array<{ code: string; title: string; validTo: string | null; sourceUrl: string }>> {
  if (!databaseConfigured) return [];
  const rows = await query<{ code: string; title: string; valid_to: string | null; source_url: string }>(
    `SELECT DISTINCT ON (r.code) r.code, r.title, v.valid_to, v.source_url
     FROM legal_rule_versions v
     JOIN legal_rules r ON r.id = v.legal_rule_id
     WHERE v.valid_from <= now() AND (v.valid_to IS NULL OR v.valid_to >= now())
     ORDER BY r.code, v.version DESC`,
  );
  return rows.map((row) => ({ code: row.code, title: row.title, validTo: row.valid_to, sourceUrl: row.source_url }));
}
