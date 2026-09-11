import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePayslipPeriod, type PayslipComputationRates } from './payslip-model.js';
import { buildTierAPeriod, checkTierASanity, type TierAInput } from './tier-a.js';

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

test('Tier A acceptance: "estimate" marks pension/PAWW as estimated and leaves sector premium unknown', () => {
  const input = olympiaTierAInput({ deductions: { mode: 'estimate' } });
  const period = buildTierAPeriod(input);
  const pension = period.pre_tax_deductions.find((d) => d.category === 'pension')!;
  const paww = period.pre_tax_deductions.find((d) => d.category === 'paww')!;
  const sector = period.pre_tax_deductions.find((d) => d.category === 'ziektewet')!;
  assert.equal(pension.amount.provenance, 'estimated');
  assert.equal(paww.amount.provenance, 'estimated');
  // Deliberately NOT defaulted (audit round, point 4) - no reliable population-level figure found
  // for the employee-deducted sector premium, unlike StiPP and PAWW which are both sourced and
  // uniform. Estimating it anyway would repeat exactly the failure this architecture change targets.
  assert.equal(sector.amount.provenance, 'unknown');

  // A partial estimate (2 of 3 known, 1 genuinely unknown) still blocks the final net figure -
  // "estimated" does not mean "good enough to proceed," it means "labelled, not fabricated."
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'incomplete');
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

test('Tier A: the net-exceeds-gross sanity check fires', () => {
  // Dutch loonheffingskortingen only ever reduce total_tax, floored at 0 (Math.max(0, ...)) - they
  // can never make wage_net exceed taxable_base on their own, so a low-rate/high-credit case alone
  // does not trigger this. What DOES, realistically: a small number of worked hours (small taxed
  // gross) combined with a large UNTAXED reimbursement (travel_allowance, added after tax as
  // net_additions) - exactly the shape the spec's own example describes (a small period where the
  // reconstructed net-per-hour comfortably exceeds the entered gross-per-hour, unflagged in the old
  // build). Here: 2h x 10 EUR/h = 20 EUR gross, but a 200 EUR travel allowance pushes the final
  // payout well above gross_total.
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
  assert.ok(warnings.some((w) => w.code === 'net_exceeds_gross' || w.code === 'effective_rate_exceeds_gross_rate'), `expected a sanity warning, got: ${JSON.stringify(warnings)}`);
});
