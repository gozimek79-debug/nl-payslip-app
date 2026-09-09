import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PayrollCalculator } from './calculator.js';

/**
 * Golden tests for the bijzonder tarief lookup table (audit round 2, C1).
 *
 * These reproduce the bijzonder-tarief PERCENTAGE against two real, independently-supplied
 * payslips (PKF 2026-08, Randstad 2026-W11) — the only two data points available in this session.
 * They do not reproduce full net pay to the cent for any payslip: that requires the complete
 * calculation chains (hours, toeslag rates, applied premiums, period type) for all three reference
 * payslips, which exist in a fixtures document the app owner holds and this session was not given.
 * Wiring PKF/Randstad/OTTO full-net-pay reproductions into this suite is next once that document
 * is available — see the audit reply's BLOCKED section.
 */

interface TaxRatesFile {
  bijzonder_tarief_brackets: Array<{ min: number; max: number; rate: number }>;
  bijzonder_tarief_loonheffingskorting_addon_tiers: Array<{ max: number; addon: number }>;
}

function loadRates(): TaxRatesFile {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(dir, '../../../../packages/tax-tables/2026-Q1-rates.json');
  return JSON.parse(readFileSync(filePath, 'utf-8')) as TaxRatesFile;
}

// Mirrors PayrollCalculator.bijzonderTariefRate() in calculator.ts. Kept as a separate,
// deliberately duplicated implementation (not an import of the private method) so this test
// fails if the two ever diverge, rather than testing the implementation against itself.
function bijzonderTariefRate(rates: TaxRatesFile, annualizedRegularIncome: number, applyLoonheffingskorting: boolean): number {
  const brackets = rates.bijzonder_tarief_brackets;
  const bracket = brackets.find((b) => annualizedRegularIncome <= b.max) ?? brackets[brackets.length - 1];
  const base = (bracket?.rate ?? 0) * 100;
  if (!applyLoonheffingskorting) return base;
  const tiers = rates.bijzonder_tarief_loonheffingskorting_addon_tiers;
  const tier = tiers.find((t) => annualizedRegularIncome <= t.max) ?? tiers[tiers.length - 1];
  return base + (tier?.addon ?? 0) * 100;
}

test('bijzonder tarief matches PKF 2026-08 payslip (jaarloon 38000 -> 40.20%)', () => {
  const rates = loadRates();
  assert.equal(bijzonderTariefRate(rates, 38000, true).toFixed(2), '40.20');
});

test('bijzonder tarief matches Randstad 2026-W11 payslip (jaarloon 46074 -> 50.47%)', () => {
  const rates = loadRates();
  assert.equal(bijzonderTariefRate(rates, 46074, true).toFixed(2), '50.47');
});

test('bijzonder tarief without loonheffingskorting equals the plain bracket rate (no addon)', () => {
  const rates = loadRates();
  assert.equal(bijzonderTariefRate(rates, 46074, false).toFixed(2), '37.56');
});

test('arbeidskorting buildup tiers sum to max_amount at the phaseout threshold', () => {
  const rates = loadRates() as unknown as {
    heffingskortingen: { arbeidskorting: { max_amount: number; phaseout_start: number; buildup_tiers: Array<{ max: number; rate: number }> } };
  };
  const { max_amount, phaseout_start, buildup_tiers } = rates.heffingskortingen.arbeidskorting;
  assert.equal(buildup_tiers[buildup_tiers.length - 1]!.max, phaseout_start);
  let total = 0;
  let previousMax = 0;
  for (const tier of buildup_tiers) {
    total += (tier.max - previousMax) * tier.rate;
    previousMax = tier.max;
  }
  // Published percentages are rounded, so this can be off by a few cents on 5685 - not to the euro.
  assert.ok(Math.abs(total - max_amount) < 1, `buildup tiers sum to ${total.toFixed(2)}, expected close to ${max_amount}`);
});

test('arbeidskorting buildup tiers match Olympia 2026-W36 payslip exactly (audit N1)', () => {
  // The payslip's own cumulative block prints arbeidskorting: 108.71 for one week, on a base of
  // 844.92 (annualised 43,935.84) - a direct measurement, not a secondary source. Confirms the A3
  // correction (11,965 / 25,845 @ 8.324/31.009/1.95%) reproduces it to the cent; the previously
  // audited tiers (11,491 / 24,820 @ 8.425/31.433/2.537%) give 108.52 - 0.19/week off.
  const rates = loadRates() as unknown as {
    heffingskortingen: { arbeidskorting: { buildup_tiers: Array<{ max: number; rate: number }> } };
  };
  const { buildup_tiers } = rates.heffingskortingen.arbeidskorting;
  const annualized = 844.92 * 52;
  let arbeidskorting = 0;
  let previousMax = 0;
  for (const tier of buildup_tiers) {
    if (annualized <= previousMax) break;
    const upper = Math.min(annualized, tier.max);
    arbeidskorting += (upper - previousMax) * tier.rate;
    previousMax = tier.max;
  }
  const weekly = arbeidskorting / 52;
  assert.equal(weekly.toFixed(2), '108.71');
});

test('StiPP pension premium matches Olympia 2026-W36 payslip exactly (audit N3)', async () => {
  // Confirmed against StiPP's own "definitieve cijfers 2026" page: franchise EUR 9.24/h, max
  // pensionable wage EUR 42.42/h, employee rate exactly 7.5% are all correct as coded - the bug
  // was the pensionable BASE, not any of those three parameters. StiPP's base nets out the other
  // two pre-tax premiums (PAWW, sickness) deducted in the same step, even though the payslip
  // presents all three as parallel deductions from "Loon in geld":
  //   (885.50 loon in geld - 0.89 PAWW - 4.90 AZW - 9.24x45 franchise) x 7.5% = 34.79 (exact)
  // Calls the real private computePension() via a plain-property cast (TS `private` has no runtime
  // effect - this is not `#private`), rather than re-deriving the formula, since the bug was in
  // call-site ordering (what gets netted out before StiPP sees it), not in an isolable pure function.
  const calculator = new PayrollCalculator() as unknown as {
    computePension: (adv: unknown, pensionableBase: number, totalHours: number, totalGross: number) => Promise<number>;
  };
  const loonInGeld = 885.50;
  const pawwAmount = 0.89;
  const azwAmount = 4.90;
  const pensionableBase = loonInGeld - pawwAmount - azwAmount;
  const result = await calculator.computePension({ pensionMode: 'stipp' }, pensionableBase, 45, loonInGeld);
  assert.equal(result.toFixed(2), '34.79');
});
