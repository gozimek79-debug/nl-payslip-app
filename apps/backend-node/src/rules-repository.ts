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
