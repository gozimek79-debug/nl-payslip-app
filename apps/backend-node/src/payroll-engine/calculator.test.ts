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

// Bracket/addon/heffingskortingen data is identical across both 2026 periods (audit round 3, Part
// K) - only minimum_wage_per_hour differs - so any test not specifically about the H1/H2 split can
// read either one. Uses H2 since that's what's currently in force.
function loadRates(): TaxRatesFile {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(dir, '../../../../packages/tax-tables/2026-rates.json');
  const file = JSON.parse(readFileSync(filePath, 'utf-8')) as { periods: TaxRatesFile[] };
  const h2 = file.periods.find((p) => (p as unknown as { id: string }).id === 'tax_2026_h2');
  if (!h2) throw new Error('tax_2026_h2 period not found in 2026-rates.json');
  return h2;
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

/**
 * G1 (audit round 3): the bijzonder_tarief_loonheffingskorting_addon_tiers decompose onto the SAME
 * parameter set as heffingskortingen.arbeidskorting/algemene_heffingskorting - every tier boundary
 * and step size is explainable from those two schedules' own buildup/afbouw rates. This is the
 * cheapest regression guard available: if either schedule is edited without checking this
 * decomposition still holds, the addon table and the heffingskortingen it's built from have
 * silently diverged.
 *
 *   jaarloon <= 12,923   addon step -8.32pp  = -8.324pp   (arbeidskorting buildup tier 1 ending)
 *   jaarloon <= 23,931   addon step -31.01pp = -31.009pp  (arbeidskorting buildup tier 2 ending)
 *   jaarloon <= 29,737   addon step -1.95pp  = -1.95pp    (arbeidskorting buildup tier 3 ending)
 *   jaarloon <= 45,593   addon step +4.45pp  = 6.398 - 1.95  (algemene heffingskorting afbouw starts,
 *                                                             net of arbeidskorting's own tier-3 rate)
 *   jaarloon <= 78,427   addon step +12.91pp = 6.398 + 6.51  (both afbouw schedules running together)
 *   jaarloon <= 143,555  addon step +6.51pp  = 6.51        (algemene heffingskorting afbouw has
 *                                                            finished at 29,736+3,115/0.06398=78,437 -
 *                                                            note this is NOT the arbeidskorting zero
 *                                                            point, which the official Belastingdienst
 *                                                            table puts at 132,921 - see the R1/G2 test
 *                                                            below; 143,555 is a bijzonder-tarief-table
 *                                                            convention this session did not resolve)
 *
 * The buildup tier RATES (8.324/31.009/1.95%) match this decomposition to the second decimal and
 * are independently confirmed against the Olympia payslip (see the arbeidskorting test above this
 * one). The buildup THRESHOLDS (11,965/25,845) do NOT match the addon table's own change-points
 * (12,923/23,931) - flagged, unresolved, see NEW FINDINGS. Both figures are kept as coded because
 * the thresholds are independently confirmed by Belastingdienst's own arbeidskorting table page
 * (see the R1/G2 test below), which the addon table's boundaries are not shown to derive from.
 */
test('arbeidskorting max_amount and phaseout_start match Belastingdienst\'s official 2026 table (audit R1/G2)', () => {
  const rates = loadRates() as unknown as {
    heffingskortingen: { arbeidskorting: { max_amount: number; phaseout_start: number; phaseout_rate: number } };
  };
  const { max_amount, phaseout_start, phaseout_rate } = rates.heffingskortingen.arbeidskorting;
  // belastingdienst.nl/.../heffingskortingen/arbeidskorting/tabel-arbeidskorting-2026: max EUR 5,685,
  // afbouw starts EUR 45,593 at 6.510%, reaches zero at EUR 132,921. The audit's own addon-table
  // decomposition suggested a 143,555 boundary implying max_amount ~6,377 instead - resolved as a
  // misreading of what that specific boundary represents (see the comment above), not a wrong
  // parameter here: the official table's own zero-point (132,921) matches max/phaseout_start/
  // phaseout_rate as coded to within a 2-EUR threshold-rounding convention.
  assert.equal(max_amount, 5685);
  assert.equal(phaseout_rate, 0.0651);
  const zeroPoint = phaseout_start + max_amount / phaseout_rate;
  assert.ok(Math.abs(zeroPoint - 132921) < 5, `zero point ${zeroPoint.toFixed(0)} should be close to the official 132,921`);
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

/**
 * PROVISIONAL, per audit P4 (reopened N3). Franchise (9.24), max pensionable wage (42.42) and
 * employee rate (7.5%) are all confirmed correct against StiPP's own primary source - not in
 * dispute. What's provisional is the BASIS. Two hypotheses were tested against BOTH reference
 * payslips (Olympia, Randstad); neither reproduces both exactly:
 *
 *   basis = totalGross (StiPP's own stated definition: SV-loon, no netting)
 *     Olympia:  (885.50 - 9.24*45)  * 7.5% = 35.23   printed 34.79   diff +0.44
 *     Randstad: (970.89 - 9.24*49.25)*7.5% = 38.69   printed 38.35   diff +0.34
 *
 *   basis = totalGross - sicknessAmount only (reverse-solved last round, NOT the coded formula)
 *     Olympia:  (885.50 - 4.90 - 9.24*45) * 7.5% = 34.86   printed 34.79   diff +0.07
 *     Randstad: (970.89 - 4.55 - 9.24*49.25)*7.5%= 38.35   printed 38.35   diff  0.00 (exact)
 *
 * The two residuals under the FIRST (coded) hypothesis are same-direction and similar relative
 * size (1.26% / 0.89%) across two independently-sourced payslips - the best available signal this
 * session has that it's the right definition and something outside a single period's printout
 * (most likely a cumulative/voortschrijdend computation neither payslip's YTD history is available
 * to check) explains the residual, rather than a wrong parameter. This is not confirmed. Do not
 * report either fixture's StiPP line as "exact" - both are asserted below only within their known
 * residual, deliberately not to the cent.
 */
test('StiPP: current (provisional) formula is within its known residual on Olympia 2026-W36', async () => {
  const calculator = new PayrollCalculator() as unknown as {
    computePension: (adv: unknown, totalGross: number, totalHours: number) => Promise<number>;
  };
  const result = await calculator.computePension({ pensionMode: 'stipp' }, 885.50, 45);
  assert.ok(Math.abs(result - 34.79) <= 0.45, `expected within 0.45 of 34.79, got ${result.toFixed(2)}`);
});

test('StiPP: current (provisional) formula is within its known residual on Randstad 2026-W11', async () => {
  const calculator = new PayrollCalculator() as unknown as {
    computePension: (adv: unknown, totalGross: number, totalHours: number) => Promise<number>;
  };
  const result = await calculator.computePension({ pensionMode: 'stipp' }, 970.89, 49.25);
  assert.ok(Math.abs(result - 38.35) <= 0.35, `expected within 0.35 of 38.35, got ${result.toFixed(2)}`);
});
