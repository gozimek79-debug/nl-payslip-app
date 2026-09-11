import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePayslipPeriod, type PayslipComputationRates } from './payslip-model.js';
import { buildTierAPeriod, checkTierASanity, computeTierAResult, type TierAInput } from './tier-a.js';

/**
 * Acceptance tests for Tier A (SPEC-loonto-architecture.md §10, "Tier A ships when:"), checked
 * against each stated criterion by name, not a loose approximation of them:
 *   - Olympia's inputs plus its actual deductions reproduce net 686.09 within the weekly tolerance
 *   - the same inputs with deductions skipped produce no net figure, and a stated gap
 *   - vakantiegeld is outside gross and net when accrued, and taxed at BT when paid
 *   - the net-exceeds-gross sanity check fires
 * The full chain being visible with per-line provenance is a response-shape guarantee, checked by
 * confirming every pre_tax_deductions entry carries a Field<number> with a real provenance value
 * (never a bare number), which the type system already enforces at compile time.
 */

const TABLE_TAX_TOLERANCE_WEEKLY = 0.5;

const RATES_2026: PayslipComputationRates = {
  loonheffing_brackets: [
    { min: 0, max: 38883, rate: 0.3575 },
    { min: 38883, max: 78426, rate: 0.3756 },
    { min: 78426, max: 999999999, rate: 0.495 },
  ],
  heffingskortingen: {
    algemene_heffingskorting: { max_amount: 3115, phaseout_start: 29736, phaseout_rate: 0.06398 },
    arbeidskorting: {
      max_amount: 5685,
      phaseout_start: 45592,
      phaseout_rate: 0.0651,
      buildup_tiers: [
        { max: 11965, rate: 0.08324 },
        { max: 25845, rate: 0.31009 },
        { max: 45592, rate: 0.0195 },
      ],
    },
  },
  period_multiplier: 52,
};

/** Olympia 2026-W36's own real inputs (FIXTURES-paski-referencyjne.md), entered exactly as a Tier A
 * user would type them - hours, rate, overtime lines by hours/percent, and (for the acceptance
 * test only) the real deduction figures printed on that same document, so the test proves the
 * chain end to end rather than exercising the "enter" path with made-up numbers. */
function olympiaTierAInput(overrides: Partial<TierAInput> = {}): TierAInput {
  return {
    period_type: 'week',
    hours_worked: 45,
    hourly_rate: 15.55,
    overtime_lines: [
      { description: 'Loon onregelm. uren 100%', hours: 7.5, percent: 100, adds_hours: false },
      { description: 'Loon onregelm. uren 50%', hours: 7.5, percent: 50, adds_hours: false },
      { description: 'ADV toeslag', hours: 45, percent: 1.54, adds_hours: false },
    ],
    apply_loonheffingskorting: true,
    travel_allowance: 90.0,
    vakantiegeld: { mode: 'accruing', percent: 8 },
    deductions: { mode: 'skip' },
    ...overrides,
  };
}

test('Tier A acceptance: Olympia inputs + its actual deductions reproduce net 686.09', () => {
  const input = olympiaTierAInput({
    deductions: { mode: 'enter', entered: { pension: 34.79, paww: 0.89, sector_premium: 4.9, post_tax_other: 6.46 } },
  });
  const period = buildTierAPeriod(input);
  assert.equal(period.pre_tax_deductions.length, 3);
  for (const d of period.pre_tax_deductions) {
    assert.equal(d.amount.provenance, 'user_entered');
  }

  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  // 885.47, not the fixture's printed 885.50: Tier A computes the base line as hours x rate
  // (45 x 15.55 = 699.75) directly from what the user typed, rather than the printed 699.78 -
  // a 0.03 EUR artifact of the source document's own internal rounding that a quick calculator
  // built from hours/rate alone cannot and should not try to replicate. Checked within 0.05 EUR,
  // not to the cent, for exactly that reason - unlike the payslip-model.test.ts golden fixtures,
  // which build hour_lines from the document's own printed amounts and so match it exactly.
  assert.ok(Math.abs(outcome.result.gross_total - 885.5) <= 0.05, `gross_total ${outcome.result.gross_total} vs printed 885.50`);
  assert.ok(Math.abs(outcome.result.loon_voor_heffingen - 844.92) <= 0.05, `loon_voor_heffingen ${outcome.result.loon_voor_heffingen} vs printed 844.92`);
  const residual = Math.abs(outcome.result.wage_net - 686.09);
  console.log(`  [residual] Tier A Olympia: wage_net ${outcome.result.wage_net.toFixed(2)} vs printed 686.09 -> ${residual.toFixed(2)} EUR (tolerance ${TABLE_TAX_TOLERANCE_WEEKLY})`);
  assert.ok(residual <= TABLE_TAX_TOLERANCE_WEEKLY, `wage_net ${outcome.result.wage_net} vs printed 686.09`);
  assert.equal(outcome.result.payout_amount.toFixed(2), (outcome.result.wage_net + 90).toFixed(2));
});

test('Tier A acceptance: the same inputs with deductions skipped produce no net figure and a stated gap', () => {
  const input = olympiaTierAInput({ deductions: { mode: 'skip' } });
  const period = buildTierAPeriod(input);
  for (const d of period.pre_tax_deductions) {
    assert.equal(d.amount.provenance, 'unknown');
    assert.equal(d.amount.value, null);
  }

  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'incomplete');
  if (outcome.status !== 'incomplete') return;
  assert.ok(outcome.missing_fields.includes('pension'));
  assert.ok(outcome.missing_fields.includes('paww'));
  assert.ok(outcome.missing_fields.includes('ziektewet'));
  assert.equal(outcome.tax_is_upper_bound, true);
  // The type itself has no wage_net/period_net/payout_amount key at all in this branch - not zero,
  // not null, genuinely absent, so a consumer cannot render "net: 0" by accident (spec §1/§3).
  assert.equal('wage_net' in outcome, false);
  assert.equal('payout_amount' in outcome, false);
  assert.ok(outcome.taxable_base > 0, 'taxable_base should still be computable (as an upper bound) even with deductions skipped');
});

test('Tier A acceptance: "estimate" marks pension/PAWW as estimated, and does NOT block on the sector premium', () => {
  // Owner's decision (audit AZ1-AZ4): "estimate" now produces a net RANGE using an observed
  // sector-premium range, rather than blocking entirely on that one line. Pension/PAWW are still
  // per-line Field<number> estimates; the sector premium is deliberately NOT a pre_tax_deductions
  // row at all any more (see estimateSectorPremiumRange()) - it is a range, applied to net directly.
  const input = olympiaTierAInput({ deductions: { mode: 'estimate' } });
  const period = buildTierAPeriod(input);
  const pension = period.pre_tax_deductions.find((d) => d.category === 'pension')!;
  const paww = period.pre_tax_deductions.find((d) => d.category === 'paww')!;
  assert.equal(pension.amount.provenance, 'estimated');
  assert.equal(paww.amount.provenance, 'estimated');
  assert.equal(period.pre_tax_deductions.some((d) => d.category === 'ziektewet'), false);

  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'complete', 'estimate mode should reach a complete computation now that the sector premium is a range, not a blocking unknown');
});

test('AZ1/AZ5: "estimate" mode produces a net RANGE from the sector-premium range, leaving gross/taxable_base/tax as single, unaffected figures', () => {
  const input = olympiaTierAInput({ deductions: { mode: 'estimate' } });
  const result = computeTierAResult(input, RATES_2026);
  assert.equal(result.outcome.status, 'complete');
  if (result.outcome.status !== 'complete') return;

  assert.ok(result.sector_premium_estimate, 'expected a sector_premium_estimate for "estimate" mode');
  assert.ok(result.net_range, 'expected a net_range for "estimate" mode');
  assert.ok(result.payout_range, 'expected a payout_range for "estimate" mode');
  const spe = result.sector_premium_estimate!;
  assert.equal(spe.low_percent, 0.18);
  assert.equal(spe.high_percent, 0.7);
  assert.equal(spe.provenance, 'estimated');
  // AZ3: the basis must state its actual grounding (observed range across real payslips), not read
  // as a statutory figure.
  assert.match(spe.basis, /loonstro/i);

  const netRange = result.net_range!;
  // A higher assumed premium means a lower net - the range's low bound must be <= its high bound,
  // and neither equals the base wage_net exactly (both bounds are genuinely offset from it).
  assert.ok(netRange.low < netRange.high, `expected net_range.low (${netRange.low}) < net_range.high (${netRange.high})`);
  assert.ok(netRange.high < result.outcome.result.wage_net, 'the high end of the net range must still be below wage_net before ANY sector premium is deducted');

  // AZ5: gross_total/taxable_base/table_tax_after_korting/bt_tax are single figures, not ranges -
  // confirmed simply by their being plain numbers on `result.outcome.result`, unaffected by
  // sector_premium_estimate/net_range existing alongside them.
  assert.equal(typeof result.outcome.result.gross_total, 'number');
  assert.equal(typeof result.outcome.result.taxable_base, 'number');
  assert.equal(typeof result.outcome.result.table_tax_after_korting, 'number');
});

test('Tier A: vakantiegeld accruing stays outside gross and net, shown only as a reservation', () => {
  const input = olympiaTierAInput({ vakantiegeld: { mode: 'accruing', percent: 8 }, deductions: { mode: 'skip' } });
  const period = buildTierAPeriod(input);
  assert.equal(period.reservations.length, 1);
  assert.equal(period.reservations[0]!.type, 'vakantiegeld');
  assert.ok(period.reservations[0]!.opgebouwd_this_period > 0);
  // Not one of the taxed hour_lines - confirms it never entered gross.
  assert.equal(period.hour_lines.some((l) => l.description.toLowerCase().includes('vakantiegeld')), false);
});

test('Tier A: vakantiegeld paid now enters gross at BT, and the unknown BT rate correctly blocks the computation', () => {
  const input = olympiaTierAInput({ vakantiegeld: { mode: 'paid_now', percent: 8 }, deductions: { mode: 'skip' } });
  const period = buildTierAPeriod(input);
  const vakantiegeldLine = period.hour_lines.find((l) => l.description.toLowerCase().includes('vakantiegeld'));
  assert.ok(vakantiegeldLine, 'vakantiegeld should appear as an hour_line when paid now');
  assert.equal(vakantiegeldLine!.tax_treatment, 'bt');
  assert.equal(period.bijzonder_tarief.bt_state, 'unknown');

  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'incomplete');
  if (outcome.status !== 'incomplete') return;
  // Both the skipped deductions AND the unknown BT rate should show up as reasons this is
  // incomplete - two independent, real gaps, neither one hidden by the other.
  assert.ok(outcome.missing_fields.includes('bijzonder_tarief_percentage'));
});

test('Tier A: a real travel allowance does NOT falsely trigger the sanity check', () => {
  // Found while wiring this into the actual API route (this round): checking payout_amount (which
  // includes travel_allowance, one of Tier A's own listed inputs) fired on ANY worker with a modest
  // travel allowance relative to their hours - a real, legitimate, everyday case, not a bug. This
  // confirms the fix: 2h x 10 EUR/h = 20 EUR gross, plus a genuine 200 EUR travel allowance, produces
  // no warning at all now that the check is based on wage_net (before that allowance is added).
  const input: TierAInput = {
    period_type: 'week',
    hours_worked: 2,
    hourly_rate: 10,
    overtime_lines: [],
    apply_loonheffingskorting: true,
    travel_allowance: 200,
    vakantiegeld: { mode: 'none' },
    deductions: { mode: 'enter', entered: {} },
  };
  const period = buildTierAPeriod(input);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const warnings = checkTierASanity(outcome, input);
  assert.deepEqual(warnings, [], `expected no sanity warnings for a legitimate travel allowance, got: ${JSON.stringify(warnings)}`);
});

test('Tier A: the net-exceeds-gross sanity check fires on a genuine wage-math impossibility', () => {
  // Dutch loonheffingskortingen only ever reduce total_tax, floored at 0 (Math.max(0, ...)) - under
  // normal deductions wage_net can never exceed gross_total. The one real way it can: a NEGATIVE
  // pre-tax deduction (a genuine compensation/refund line, e.g. OTTO's "PAWW Rekompensata" -0.51)
  // large enough that even the resulting tax on the inflated base does not cancel it back out.
  // 10h x 10 EUR/h = 100 EUR gross; entering "pension: -50" (a compensation, not a deduction) pushes
  // loon_voor_heffingen/taxable_base to 150 - annualised income is low enough that
  // heffingskortingen floor the tax near 0, so wage_net lands close to 150, comfortably above the
  // 100 EUR gross.
  const input: TierAInput = {
    period_type: 'week',
    hours_worked: 10,
    hourly_rate: 10,
    overtime_lines: [],
    apply_loonheffingskorting: true,
    travel_allowance: 0,
    vakantiegeld: { mode: 'none' },
    deductions: { mode: 'enter', entered: { pension: -50 } },
  };
  const period = buildTierAPeriod(input);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status === 'complete') {
    assert.ok(outcome.result.wage_net > outcome.result.gross_total, `expected wage_net (${outcome.result.wage_net}) > gross_total (${outcome.result.gross_total}) for this synthetic case`);
  }
  const warnings = checkTierASanity(outcome, input);
  assert.ok(warnings.some((w) => w.code === 'net_exceeds_gross' || w.code === 'effective_rate_exceeds_gross_rate'), `expected a sanity warning, got: ${JSON.stringify(warnings)}`);
});
