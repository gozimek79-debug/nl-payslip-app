import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translations } from './translations.ts';

/**
 * Stage 2u (audit v53, §2u.6 item 12): "full PL/EN parity for provisional state and correction
 * controls." `translations` is declared `Record<Lang, typeof pl>`, which the compiler only enforces
 * in ONE direction (the `en` object must have every key `pl` has - a key present only on `en` is not
 * a type error, since `en` is assigned by identifier, not as a fresh object literal). This test closes
 * the other direction at runtime: every top-level section, and every key within it, must exist on
 * BOTH languages - not scoped to this stage's own new keys, since a parity gap anywhere is the same
 * bug this test exists to catch, structural, never content (copy is expected to differ).
 */
function deepKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) keys.push(...deepKeys(v, path));
    else keys.push(path);
  }
  return keys.sort();
}

test('2u.6: every translations.pl key path has a matching translations.en key path, and vice versa', () => {
  const plKeys = deepKeys(translations.pl);
  const enKeys = deepKeys(translations.en);
  const missingFromEn = plKeys.filter((k) => !enKeys.includes(k));
  const missingFromPl = enKeys.filter((k) => !plKeys.includes(k));
  assert.deepEqual(missingFromEn, [], `keys present in pl but missing from en: ${JSON.stringify(missingFromEn)}`);
  assert.deepEqual(missingFromPl, [], `keys present in en but missing from pl: ${JSON.stringify(missingFromPl)}`);
});

test("2u.1: the provisional-result copy exists in both languages and is genuinely distinct from the clean-read copy (never the same string reused)", () => {
  for (const lang of ['pl', 'en'] as const) {
    const t = translations[lang].tierC;
    assert.ok(t.provisionalResultTitle.length > 0);
    assert.ok(t.provisionalPayoutLabel.length > 0);
    assert.notEqual(t.provisionalResultTitle, t.wageNet, `${lang}: the provisional title must not reuse the clean-read heading`);
    assert.notEqual(t.provisionalPayoutLabel, t.payoutAmount, `${lang}: the provisional payout label must not reuse "Amount payable"/"Do wypłaty"`);
  }
});

test('2u.3: the PRO-projection-eligible note exists in both languages and is distinct from the plain "read correctly" note', () => {
  for (const lang of ['pl', 'en'] as const) {
    const t = translations[lang].proDocuments;
    assert.ok(t.payslipEligibleForProjection.length > 0);
    assert.notEqual(t.payslipEligibleForProjection, t.payslipSummaryOk(''));
  }
});
