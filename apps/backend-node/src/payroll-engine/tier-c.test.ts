import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapExtractionToPeriod, resolveEtExchangeAmountFromExtraction, type TierCExtraction } from './tier-c.js';
import { computePayslipPeriod, tableTaxToleranceFor, type PayslipComputationRates } from './payslip-model.js';
import { comparePeriodToDocument, resolveNetReconciliationBasis } from './discrepancy.js';
import { checkExtractionConsistency, buildExtractionTrace } from './extraction-consistency.js';

/**
 * Tier C integration tests (audit BP1/BP4), in the required fixture order: Olympia, PKF, Randstad,
 * OTTO. Each test hand-builds a TierCExtraction shaped exactly as a correctly-functioning widened AI
 * extraction (see tier-c.ts's own mapping-gap comment block) would produce for that real document -
 * an AI vision call cannot be run deterministically in this test environment, so this tests the
 * MAPPING + COMPUTATION + DISCREPANCY pipeline end to end, the same way payslip-model.test.ts tests
 * the engine by hand-building PayslipPeriod objects rather than depending on a live model.
 *
 * BP4's shipping condition, restated as what these tests actually assert:
 *   - fixtures that reproduce at model level (payslip-model.test.ts) still reproduce through this
 *     integrated mapping/computation path - same tolerances, same expected figures.
 *   - the discrepancy list reports a correct payslip as correct: Olympia, PKF and Randstad must
 *     produce an EMPTY discrepancy list. A verifier that flags a valid payslip is worse than none.
 *   - OTTO is the deliberate exception: its already-documented 12.28 EUR table-tax gap
 *     (payslip-model.test.ts, round 8/9) must show up as a REAL discrepancy here too - proving the
 *     comparator actually detects a mismatch, not just that it stays silent for everything.
 */

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

const RATES_2025: PayslipComputationRates = {
  loonheffing_brackets: [
    { min: 0, max: 38441, rate: 0.3582 },
    { min: 38441, max: 76817, rate: 0.3748 },
    { min: 76817, max: 999999999, rate: 0.495 },
  ],
  heffingskortingen: {
    algemene_heffingskorting: { max_amount: 3068, phaseout_start: 28406, phaseout_rate: 0.06337 },
    arbeidskorting: {
      max_amount: 5599,
      phaseout_start: 43072,
      phaseout_rate: 0.0651,
      buildup_tiers: [
        { max: 12169, rate: 0.08053 },
        { max: 26288, rate: 0.3003 },
        { max: 43071, rate: 0.02258 },
      ],
    },
  },
  period_multiplier: 52,
};

function baseExtraction(overrides: Partial<TierCExtraction>): TierCExtraction {
  return {
    period_label: null,
    period_end_date: null,
    payment_date: null,
    period_type: 'week',
    is_correction: false,
    version: 1,
    employer_names: [],
    hirer_name: null,
    hours_per_week: null,
    minimum_wage_printed: null,
    hour_lines: [],
    pre_tax_deduction_lines: [],
    post_tax_deduction_lines: [],
    bijzonder_tarief_printed_percent: null,
    bijzonder_tarief_jaarloon: null,
    et_exchange_amount: null,
    et_reimbursement_lines: [],
    net_lines: [],
    payout_adjustment_lines: [],
    reservation_lines: [],
    printed_table_tax: null,
    printed_bt_tax: null,
    printed_algemene_heffingskorting: null,
    printed_arbeidskorting: null,
    reported_total_net: null,
    reported_net_paid: null,
    printed_gross_total: null,
    printed_loon_voor_heffingen: null,
    printed_taxable_base_normal: null,
    printed_taxable_base_special: null,
    printed_table_tax_label: null,
    printed_bt_tax_label: null,
    printed_algemene_heffingskorting_label: null,
    printed_arbeidskorting_label: null,
    printed_net_label: null,
    printed_payout_label: null,
    truncated: false,
    redacted_fields: [],
    unreadable_amount_fields: [],
    ...overrides,
  };
}

test('Tier C integration: Fixture 4 Olympia maps, computes and reports NO discrepancy', () => {
  const extraction = baseExtraction({
    period_label: 'week 36/2026',
    period_end_date: '2026-09-06',
    employer_names: ['Olympia Services B.V.'],
    hirer_name: 'DSV Contract Logistics B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Loon onregelm. uren 100%', hours: 7.5, rate: 15.55, percent: 100, amount: 116.63, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Loon onregelm. uren 50%', hours: 7.5, rate: 15.55, percent: 50, amount: 58.31, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'ADV toeslag', hours: 45, rate: 15.55, percent: 1.54, amount: 10.78, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Bijdrage PAWW werknemer', amount: 0.89, category: 'paww', placement: 'pre_tax', base: 885.5, percent: 0.1 },
      { description: 'AZW werknemer', amount: 4.9, category: 'ziektewet', placement: 'pre_tax', base: null, percent: null },
      { description: 'STIPP-pensioen werknemer', amount: 34.79, category: 'pension', placement: 'pre_tax', base: 879.71, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      // v24 (§2e.4): deliberately left as the model would have misclassified it ('other') - the
      // deterministic label override below must reclassify this to 'whk' on the label alone, the
      // model's own category is advisory and ignored.
      { description: 'WHK werknemer', amount: 6.46, category: 'other', placement: 'post_tax', base: null, percent: null },
    ],
    net_lines: [{ description: 'Onb. reiskosten woon/werk', amount: 90.0, category: 'reimbursement' }],
    reservation_lines: [
      { type: 'vakantiedagen', opgebouwd: 3.91, paid_out: 0 },
      { type: 'vakantiedagen_bovenwettelijk', opgebouwd: 0.98, paid_out: 0 },
      { type: 'vakantiegeld', opgebouwd: 78.51, paid_out: 0 },
    ],
    printed_table_tax: 152.37,
    printed_arbeidskorting: 108.71,
    reported_net_paid: 776.09, // CL: exercises the newly-wired payout_mismatch check with a real, already-verified figure
    // v24 (§2e.3): the document's own two chain subtotals - 885.50 = sum of the four gross lines
    // above; 844.92 = 885.50 - 40.58 (the three real pre-tax deductions), both already independently
    // confirmed by this test's own assertions below.
    printed_gross_total: 885.5,
    printed_loon_voor_heffingen: 844.92,
  });

  // v24 (§2e.4): the deterministic label override reclassifies "WHK werknemer" to 'whk' even though
  // the raw extraction above says 'other' - confirms the override actually runs, not just that a
  // correctly-labelled fixture happens to pass.
  const period = mapExtractionToPeriod(extraction, 14.99); // wml_applicable resolved separately (N4) - see the test below for the "stale on document" case
  assert.equal(period.post_tax_social[0]?.category, 'whk', 'expected the deterministic label override to reclassify "WHK werknemer", ignoring the extraction\'s own "other"');

  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  assert.equal(outcome.result.gross_total, 885.5);
  assert.ok(Math.abs(outcome.result.payout_amount - 776.09) <= 0.5, `payout ${outcome.result.payout_amount} vs printed 776.09`);

  // v24 (§2e.8): "the Olympia Tier C integration test never runs the gate... make it run the gate."
  // A correct read must pass it cleanly - this is the "corrected read" the buggy-read regression test
  // below is compared against.
  const consistencyIssues = checkExtractionConsistency(extraction.payment_date, period, outcome);
  assert.deepEqual(consistencyIssues, [], `expected a correct Olympia read to pass the consistency gate cleanly, got ${JSON.stringify(consistencyIssues)}`);

  const discrepancies = comparePeriodToDocument(period, outcome);
  // Olympia's own wml_printed (14.71) genuinely differs from wml_applicable (14.99, resolved
  // separately) - this IS expected to surface, per audit N4, as an informational staleness signal,
  // not absorbed into silence. Every OTHER discrepancy code must be absent - this is a correct
  // payslip everywhere except that one already-known printed-minimum-wage staleness.
  assert.deepEqual(discrepancies.map((d) => d.code), ['minimum_wage_stale_on_document']);
  // Stage 1: a genuine 0.28 EUR staleness gap (an out-of-date printed rate, not extraction noise)
  // must classify as 'finding' - the confirmation band here (0.10) exists only for a trivial
  // single-cent-range OCR misread, not to soften a real, already-verified fact into a question.
  assert.equal(discrepancies[0]?.status, 'finding', `expected 'finding' for Olympia's real 0.28 EUR staleness gap, got ${discrepancies[0]?.status}`);
});

/**
 * Stage 2e (audit v24) - the regression fixture from the round's own assignment, VERBATIM: the live,
 * buggy Mistral read of Olympia W36/2026 that an independent review diagnosed as five defects. This
 * locks in the specific failure the round fixes (2e.1's sign handling) and documents, by assertion,
 * exactly which of the other four defects this round's fixes DO and do NOT repair - a defect this test
 * does not close is a defect still open, not one silently fixed by accident.
 *
 * Defect 1 (sign lost) - FIXED here: the raw extraction below carries deduction/tax amounts exactly
 * as the buggy live read produced them (negative, printed-sign-preserved); mapExtractionToPeriod must
 * normalise them to magnitudes before they reach the model, so gross+deductions is never computed as
 * gross+|deductions|.
 * Defect 2 (missing 58.31 gross line) - NOT fixed by this round (no code change makes a vision model
 * see a line it skipped); reproduced deliberately so the resulting gross (827.16, short by 58.31) is
 * asserted, not silently 885.50.
 * Defect 3 (699.75 computed vs 699.78 printed) - NOT fixed by this round for the SAME reason (the
 * prompt change in 2e.2 cannot be exercised by a hand-built fixture that never calls a real model);
 * reproduced as 699.75, per the assignment's own fixture.
 * Defect 4 (AZW misread as 1.23 vs printed 4.90) - explicitly unrepairable by code (§2e.3's own
 * words): stays 1.23 here.
 * Defect 5 (AZW still 'other') - FIXED here: 2e.4's deterministic label override reclassifies it to
 * 'ziektewet' regardless of the extraction's own category.
 */
test('Stage 2e regression: the live buggy Olympia read must not reproduce 864.07/718.16 after the sign fix', () => {
  const extraction = baseExtraction({
    period_label: 'week 36/2026',
    hour_lines: [
      { employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.75, category: 'regular', tax_treatment: 'table', adds_hours: true }, // defect 3: computed, not transcribed (699.78 printed)
      { employer_index: 0, description: 'Loon onregelm. uren 100%', hours: 7.5, rate: 15.55, percent: 100, amount: 116.63, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      // defect 2: the 50% irregular-hours line (58.31) is deliberately ABSENT - the live read never saw it.
      { employer_index: 0, description: 'ADV toeslag', hours: 45, rate: 15.55, percent: 1.54, amount: 10.78, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      // defect 1: negative, exactly as the buggy live read produced them (the printed sign, uncorrected).
      { description: 'Bijlage PAWW werknemer', amount: -0.89, category: 'paww', placement: 'pre_tax', base: null, percent: null },
      { description: 'AZW werknemer', amount: -1.23, category: 'other', placement: 'pre_tax', base: null, percent: null }, // defects 4+5: misread amount, wrong category
      { description: 'StiPP-pensioen werknemer', amount: -34.79, category: 'pension', placement: 'pre_tax', base: null, percent: null },
    ],
    post_tax_deduction_lines: [
      { description: 'WHK werknemer', amount: -6.46, category: 'whk', placement: 'post_tax', base: null, percent: null },
    ],
    printed_table_tax: 152.37,
    reported_total_net: 686.09,
    reported_net_paid: 776.09,
  });

  const period = mapExtractionToPeriod(extraction, null);
  // Defect 5, fixed: the label override reclassifies "AZW werknemer" to 'ziektewet' despite the
  // extraction's own (wrong) 'other' - independent of defect 4 (the amount), which no code can fix.
  assert.equal(period.pre_tax_deductions[1]?.category, 'ziektewet');

  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const trace = buildExtractionTrace(period, outcome);

  // Defect 1, fixed: sign no longer lost. Gross is still short by the missing 58.31 line (defect 2,
  // not fixed here) and pre-tax is still off by the 3.67 AZW misread (defect 4, not fixed here) - but
  // the CHAIN ARITHMETIC now subtracts instead of adding, so it must not reproduce the reviewer's
  // reported 864.07 (loon voor heffingen) or 718.16 (implied net).
  assert.notEqual(trace.loon_voor_heffingen, 864.07);
  assert.notEqual(trace.implied_net, 718.16);
  // What it produces instead, asserted exactly (per 2e.1: "report what it produces instead") - this
  // is the assignment's own stated "correct chain with these very lines, subtracting magnitudes":
  // 827.16 (gross, still short by 58.31) - 36.91 (pre-tax, now positive) = 790.25;
  // 790.25 - 152.37 (tax) - 6.46 (WHK) = 631.42.
  assert.equal(trace.gross_total, 827.16);
  assert.equal(trace.pre_tax_deductions_sum, 36.91);
  assert.equal(trace.loon_voor_heffingen, 790.25);
  assert.equal(trace.implied_net, 631.42);
});

test('Tier C integration: Fixture 3 PKF maps, computes and reports NO discrepancy', () => {
  // Corrected against the actual source document this round (audit BQ), not just the earlier
  // curated fixture summary: hours_per_week (40,00, printed) and a vakantiegeld reservation
  // (281,24, printed - both absent from the version of this fixture built last round) are real,
  // printed data this test was missing; jaarloon_bt (38.000,00) IS printed here ("Jaarloon BT:"),
  // correcting the earlier "essentially never printed" claim; the real printed BT rate is TWO
  // components summed ("Tarief BT: 35,75 + 4,45%"), not one pre-summed figure - confirms
  // extractTierCPayslip's own prompt needs to handle that format, not just Randstad's single-number
  // one. Deduction descriptions below use the exact real text, not a paraphrase (audit BK3).
  const extraction = baseExtraction({
    period_label: '2026-8-M',
    period_end_date: '2026-08-31',
    period_type: 'month',
    employer_names: ['PKF / Post Finsterwolde BV'],
    hours_per_week: 40.0,
    minimum_wage_printed: 14.99,
    hour_lines: [
      { employer_index: 0, description: 'Salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk uren 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk uren 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deduction_lines: [
      { description: 'Paww Wn', amount: 3.52, category: 'paww', placement: 'pre_tax', base: 3515.56, percent: 0.1 },
      { description: 'Pensioenpremie Wn', amount: 229.03, category: 'pension', placement: 'pre_tax', base: 1601.58, percent: 14.3 },
      { description: 'WGA-Gat Verzekering Wn', amount: 5.99, category: 'wga_gat', placement: 'pre_tax', base: 3277.02, percent: 0.183 },
    ],
    post_tax_deduction_lines: [
      { description: 'gediff. WGA wn', amount: 11.31, category: 'gediff_wga', placement: 'post_tax', base: 3277.02, percent: 0.345 },
    ],
    net_lines: [
      { description: 'Reiskostenvergoeding (onbelast)', amount: 91.25, category: 'reimbursement' },
      { description: 'Inhouding Personeelsvereniging', amount: 4.0, category: 'union' },
      { description: 'Inhouding Lening', amount: 1100.0, category: 'loan' },
    ],
    reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 281.24, paid_out: 0 }],
    bijzonder_tarief_printed_percent: 40.2, // printed as "35,75 + 4,45%" - see comment above
    bijzonder_tarief_jaarloon: 38000,
    printed_table_tax: 276.42,
    printed_bt_tax: 222.42,
    // Stage 2h (§2h.3): PKF's document prints ONE net-shaped figure (1754.12) that is printed AFTER
    // its own net_lines (a 91.25 travel reimbursement, a 4.00 union deduction, a 1100.00 loan
    // deduction) - it is "Totaal netto" and "Totaal" at once (§2h.3's own instruction: "the PKF
    // fixture's missing reported_total_net is filled" - filled with the SAME real number as
    // reported_net_paid below, because this document has no separate pre-net-lines figure to read).
    // This is deliberately the fixture that would misfire under a wage_net-only comparison: the
    // reviewer measured a spurious ~1012 EUR residual reproducing exactly that.
    reported_total_net: 1754.12,
    reported_net_paid: 1754.12, // CL: exercises payout_mismatch with the already-verified real figure
    printed_gross_total: 3515.56, // sum of the three hour_lines above
    printed_loon_voor_heffingen: 3277.02, // 3515.56 - 238.54 (the three real pre-tax deductions)
  });

  const period = mapExtractionToPeriod(extraction, 14.99);
  assert.equal(period.post_tax_social[0]?.category, 'gediff_wga', 'expected the abbreviated "gediff." label to still classify as gediff_wga, not fall through to plain wga');
  // PKF is a MONTHLY document - the period_multiplier must match period_type, not the RATES_2026
  // constant's own default (52, for the weekly fixtures). Same bug shape N2/AN3 exist to catch:
  // an annual-formula tax reconstruction is wrong at the multiplier level, not just the tolerance.
  const outcome = computePayslipPeriod(period, { ...RATES_2026, period_multiplier: 12 }, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  assert.equal(outcome.result.gross_total, 3515.56);
  assert.ok(Math.abs(outcome.result.payout_amount - 1754.12) <= 1.5, `payout ${outcome.result.payout_amount} vs printed 1754.12`);

  const consistencyIssues = checkExtractionConsistency(extraction.payment_date, period, outcome);
  assert.deepEqual(consistencyIssues, [], `expected a correct PKF read to pass the consistency gate cleanly, got ${JSON.stringify(consistencyIssues)}`);

  // Stage 2h (§2h.3): PKF's printed net (1754.12) confirms period_net, not wage_net - the two differ
  // by over a thousand euros here (a real 91.25 reimbursement and a real 1100.00 loan deduction).
  // Confirms the test actually exercises the distinction the fix depends on, the same way the 2g.0a
  // regression test confirmed wage_net !== period_net for Olympia.
  assert.notEqual(outcome.result.wage_net, outcome.result.period_net, 'PKF fixture must genuinely separate the two net figures, or this test would pass either way');
  assert.equal(resolveNetReconciliationBasis(outcome, period.printed_net, tableTaxToleranceFor(period.period_type)), 'period_net');

  const discrepancies = comparePeriodToDocument(period, outcome);
  assert.deepEqual(discrepancies, [], `expected NO net_mismatch on PKF's correct read; got ${JSON.stringify(discrepancies)}`);
});

test('2h.3 regression: reverting to a wage_net-only comparison must fail PKF (proves the both-fields fix is load-bearing, not incidental)', () => {
  // Deliberately reproduces discrepancy.ts's PRE-2h.3 net_mismatch logic inline (wage_net compared
  // alone, tableTolerance, no fallback to period_net) against the exact same PKF fixture used above -
  // this is the "removing the fix must fail the PKF test" proof the assignment asks for, kept as a
  // permanent regression rather than a one-off manual check.
  const extraction = baseExtraction({
    period_label: '2026-8-M', period_end_date: '2026-08-31', period_type: 'month',
    employer_names: ['PKF / Post Finsterwolde BV'], hours_per_week: 40.0, minimum_wage_printed: 14.99,
    hour_lines: [
      { employer_index: 0, description: 'Salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk uren 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk uren 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deduction_lines: [
      { description: 'Paww Wn', amount: 3.52, category: 'paww', placement: 'pre_tax', base: 3515.56, percent: 0.1 },
      { description: 'Pensioenpremie Wn', amount: 229.03, category: 'pension', placement: 'pre_tax', base: 1601.58, percent: 14.3 },
      { description: 'WGA-Gat Verzekering Wn', amount: 5.99, category: 'wga_gat', placement: 'pre_tax', base: 3277.02, percent: 0.183 },
    ],
    post_tax_deduction_lines: [{ description: 'gediff. WGA wn', amount: 11.31, category: 'gediff_wga', placement: 'post_tax', base: 3277.02, percent: 0.345 }],
    net_lines: [
      { description: 'Reiskostenvergoeding (onbelast)', amount: 91.25, category: 'reimbursement' },
      { description: 'Inhouding Personeelsvereniging', amount: 4.0, category: 'union' },
      { description: 'Inhouding Lening', amount: 1100.0, category: 'loan' },
    ],
    reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 281.24, paid_out: 0 }],
    bijzonder_tarief_printed_percent: 40.2, bijzonder_tarief_jaarloon: 38000,
    printed_table_tax: 276.42, printed_bt_tax: 222.42,
    reported_total_net: 1754.12, reported_net_paid: 1754.12,
    printed_gross_total: 3515.56, printed_loon_voor_heffingen: 3277.02,
  });
  const period = mapExtractionToPeriod(extraction, 14.99);
  const outcome = computePayslipPeriod(period, { ...RATES_2026, period_multiplier: 12 }, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;

  const tolerance = tableTaxToleranceFor(period.period_type);
  const wageOnlyResidual = Math.round((outcome.result.wage_net - (period.printed_net as number)) * 100) / 100;
  assert.ok(Math.abs(wageOnlyResidual) > tolerance, `expected the wage_net-only comparison to be WAY outside tolerance on PKF (proving the old logic would misfire), got residual ${wageOnlyResidual}`);
});

test('Tier C integration: Fixture 1 Randstad (a correction, v2) maps, computes and reports NO discrepancy', () => {
  // Corrected against the real source document this round (audit BQ): a hirer is printed here too
  // (Emballagefabriek H. Post B.V.) - not only Olympia, as the earlier gap-analysis comment claimed;
  // jaarloon_bt IS printed ("Jaarloon bijz. beloning 46074"), as a single number (contrast PKF's
  // two-part-sum format); the Ziektewet line's real printed text is longer than what was hand-entered
  // last round (audit BK3's as-printed-term requirement).
  const extraction = baseExtraction({
    period_label: 'week 2026-11',
    period_end_date: '2026-04-30',
    is_correction: true,
    version: 2,
    employer_names: ['Randstad'],
    hirer_name: 'Emballagefabriek H. Post B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'Bruto loon uren', hours: 38.0, rate: 17.09, percent: null, amount: 649.42, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 125%', hours: 2.0, rate: 17.09, percent: 125, amount: 42.73, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 150%', hours: 9.25, rate: 17.09, percent: 150, amount: 237.12, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Compensatie ADV', hours: null, rate: null, percent: null, amount: 39.61, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Compensatie overgangsregeling', hours: null, rate: null, percent: null, amount: 2.01, category: 'other', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Premie PAWW', amount: 0.74, category: 'paww', placement: 'pre_tax', base: 970.89, percent: 0.08 },
      { description: 'Premie aanvullende verzekering Ziektewet premiegroep II A', amount: 4.55, category: 'ziektewet', placement: 'pre_tax', base: 970.89, percent: 0.7 },
      { description: 'Pensioenpremie', amount: 38.35, category: 'pension', placement: 'pre_tax', base: null, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      { description: 'Premie WGA', amount: 12.33, category: 'wga', placement: 'post_tax', base: null, percent: 1.33 },
    ],
    net_lines: [{ description: 'Reiskosten woon-werk', amount: 36.0, category: 'reimbursement' }],
    payout_adjustment_lines: [
      { description: 'Verrekend met openstaande schuld', amount: -47.53 },
      { description: 'Eerder betaald', amount: -744.73 },
    ],
    bijzonder_tarief_printed_percent: 50.47,
    bijzonder_tarief_jaarloon: 46074,
    printed_table_tax: 71.31,
    printed_bt_tax: 141.24,
    // Stage 2h (§2h.3): Randstad's "TOTAAL NETTO LOON" prints BEFORE the 36.00 travel reimbursement -
    // confirms wage_net, per the reviewer's own T2 table.
    reported_total_net: 702.37,
    reported_net_paid: -53.89, // CL: the real printed final figure, an amount OWED (negative) - exercises payout_mismatch on a signed value too
    printed_gross_total: 970.89, // sum of the five hour_lines above
    printed_loon_voor_heffingen: 927.25, // 970.89 - 43.64 (the three real pre-tax deductions)
  });

  // Paid 30-04-2026, within H1 2026 - wml_applicable is 14.71 here, NOT 14.99 (that's H2). Matches
  // the document's own printed figure, so no staleness discrepancy expected for this one.
  const period = mapExtractionToPeriod(extraction, 14.71);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  assert.ok(Math.abs(outcome.result.wage_net - 702.37) <= 0.5, `wage_net ${outcome.result.wage_net} vs printed 702.37`);
  const finalPayout = outcome.result.wage_net + outcome.result.net_additions_total + outcome.result.payout_adjustments_total;
  assert.ok(Math.abs(finalPayout - -53.89) <= 0.5, `final payout ${finalPayout} vs printed -53.89 (owed)`);
  // Stage 2h (§2h.3): period_net (wage_net + the 36.00 reimbursement) must NOT also match 702.37 -
  // otherwise this fixture couldn't tell "matches wage_net" from "matches both" apart.
  assert.equal(resolveNetReconciliationBasis(outcome, period.printed_net, tableTaxToleranceFor(period.period_type)), 'wage_net');

  const consistencyIssues = checkExtractionConsistency(extraction.payment_date, period, outcome);
  assert.deepEqual(consistencyIssues, [], `expected a correct Randstad read to pass the consistency gate cleanly, got ${JSON.stringify(consistencyIssues)}`);

  const discrepancies = comparePeriodToDocument(period, outcome);
  assert.deepEqual(discrepancies, []);
});

test('Tier C integration: Fixture 2 OTTO (two employers, ET) maps and computes; the documented table-tax gap surfaces as a real discrepancy', () => {
  const extraction = baseExtraction({
    period_label: '33/2025',
    period_end_date: '2025-08-17',
    employer_names: ['DHL Supply Chain (NL) B.V.', 'KF Service & Beheer B.V.'],
    minimum_wage_printed: 14.4,
    hour_lines: [
      { employer_index: 0, description: 'Godziny przepracowane (DHL)', hours: 24.0, rate: 14.45, percent: null, amount: 346.8, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 30%', hours: 21.25, rate: 4.34, percent: 30, amount: 92.23, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 100%', hours: 2.75, rate: 14.45, percent: 100, amount: 39.74, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 1, description: 'Godziny przepracowane (KF)', hours: 19.0, rate: 14.4, percent: null, amount: 273.6, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek wakacyjny', hours: null, rate: null, percent: null, amount: 56.31, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Wymiana pw. urlopu ustawowego', hours: 0.77, rate: 14.43, percent: null, amount: 11.11, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Jednorazowa zapłata', hours: null, rate: null, percent: null, amount: 98.24, category: 'other', tax_treatment: 'bt', adds_hours: false },
      { employer_index: 0, description: 'Wynagrodzenie kierowcy brutto', hours: null, rate: null, percent: null, amount: 6.0, category: 'other', tax_treatment: 'bt', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Emerytura STIPP', amount: 21.65, category: 'pension', placement: 'pre_tax', base: null, percent: 4 },
      // v26 (§2f.5): FIXTURES fixture 2, Krok 2 - printed +0.51/-0.51, exactly as a live extraction
      // would carry them under the new "transcribe the sign, backend decides magnitude" prompt policy.
      // Without the credit exception, Math.abs would turn Rekompensata into ANOTHER 0.51 deduction
      // (a credit becoming a charge) instead of the two netting to 0 as they do on the real document.
      { description: 'PAWW Rekompensata', amount: 0.51, category: 'paww', placement: 'pre_tax', base: null, percent: null },
      { description: 'PAWW Opłata', amount: -0.51, category: 'paww', placement: 'pre_tax', base: null, percent: null },
    ],
    et_exchange_amount: 177.0,
    et_reimbursement_lines: [
      { description: 'Zwrot kosztów utrzymania ET', amount: 33.0, category: 'reimbursement' },
      { description: 'Zwrot za zakwaterowanie ET', amount: 144.0, category: 'reimbursement' },
    ],
    net_lines: [
      { description: 'Potrącenie własnego wkładu WHK', amount: 1.55, category: 'other' },
      { description: 'Nominalna składka ubezpieczenia zdrowotnego', amount: 38.01, category: 'health_insurance' },
      { description: 'Potrącenie kosztów przewozu', amount: 2.63, category: 'transport' },
      { description: 'Potrącenie za zakwaterowanie', amount: 144.0, category: 'housing' },
    ],
    bijzonder_tarief_printed_percent: 38.45,
    printed_table_tax: 77.52,
    printed_bt_tax: 40.08,
    // Stage 2h (§2h.3): OTTO's "KWOTA DO WYPŁATY" (598.59) is the document's only net-shaped figure,
    // and per the reviewer's own T2 table it IS the final payout, not a distinct pre-net-lines net -
    // this document prints no separate "Totaal netto" at all. Set in reported_net_paid (-> printed_
    // payout), never in reported_total_net (-> printed_net, which stays null - nothing to read there).
    reported_net_paid: 598.59,
    printed_gross_total: 924.03, // sum of the eight hour_lines above
    printed_loon_voor_heffingen: 902.38, // 924.03 - 21.65 (STIPP; Rekompensata/Opłata net to 0) - matches payslip-model.ts's own documented anchor
  });

  const period = mapExtractionToPeriod(extraction, 14.4);
  // Two employers detected -> franchise_bearing must be 'unknown' for both (audit BP1 gap note),
  // never guessed even though round 7/8's own analysis concluded DHL likely carries it.
  assert.equal(period.employers.length, 2);
  assert.ok(period.employers.every((e) => e.franchise_bearing === 'unknown'));
  // v26 (§2f.5): the credit exception nets Rekompensata/Opłata to 0, same as the printed document -
  // confirms the sign policy neither adds a phantom 0.51 charge nor a phantom 0.51 refund.
  assert.equal(
    period.pre_tax_deductions.reduce((sum, d) => sum + (d.amount.value ?? 0), 0),
    21.65,
    'expected PAWW Rekompensata (+0.51, a credit) and PAWW Opłata (-0.51, an ordinary deduction) to net to exactly the STIPP amount',
  );

  const outcome = computePayslipPeriod(period, RATES_2025, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  assert.equal(outcome.result.taxable_base, 725.38);
  assert.equal(outcome.result.bt_tax.toFixed(2), '40.08'); // exact - flat percentage, not a table lookup
  // v26 (§2f.6): "make the OTTO integration test assert the components against the fixture (taxable
  // base 725.38, ET additions once) and report the net residual against 598.59 without widening any
  // tolerance (the 12.28 table-tax gap is known)." Before the fix, et_reimbursement_lines were counted
  // in BOTH net_additions and et.et_reimbursements, and computePayslipPeriod summed both -
  // period_net/payout_amount would have been ~775.59 (598.59 + a double-counted 177.00), not merely
  // 12.28 off. period_net still isn't exactly 598.59 here: the ENGINE's own table_tax_after_korting
  // (not the printed 77.52) feeds this computation, and that 12.28 EUR gap (§6.2) is a separate,
  // already-documented, unrelated defect - not something this fix touches or a tolerance to widen.
  assert.equal(outcome.result.net_additions_total, 177, 'expected the 33.00 + 144.00 ET reimbursements counted ONCE, not twice');
  const periodNetResidual = Math.round((outcome.result.period_net - 598.59) * 100) / 100;
  console.log(`  [2f.6] OTTO period_net ${outcome.result.period_net} vs fixture 598.59 -> residual ${periodNetResidual} EUR (the already-documented 12.28 table-tax gap, not a new defect)`);
  assert.ok(Math.abs(periodNetResidual - 12.28) < 0.01, `expected the residual to equal exactly the documented table-tax gap (12.28), got ${periodNetResidual} - a different residual would mean a NEW defect, not the known one`);
  assert.equal(outcome.result.payout_amount, outcome.result.period_net, 'no payout adjustments in this fixture - payout must equal period_net exactly');

  // v24 (§2e.8): the gate must run here too, and must NOT block - OTTO's table-tax gap is a real
  // employer/engine discrepancy (checked below), not an extraction-consistency problem. Confirms the
  // gate and the discrepancy comparator catch different failure classes, not the same one twice.
  const consistencyIssues = checkExtractionConsistency(extraction.payment_date, period, outcome);
  assert.deepEqual(consistencyIssues, [], `expected OTTO's extraction to pass the consistency gate - its gap is a discrepancy, not a consistency issue, got ${JSON.stringify(consistencyIssues)}`);

  const discrepancies = comparePeriodToDocument(period, outcome);
  const tableTaxDiscrepancy = discrepancies.find((d) => d.code === 'table_tax_mismatch');
  assert.ok(tableTaxDiscrepancy, 'expected the already-documented table-tax gap to surface as a real discrepancy, not be silently absorbed');
  assert.ok(Math.abs((tableTaxDiscrepancy?.residual ?? 0) + 12.28) < 0.5, `expected a residual near -12.28, got ${tableTaxDiscrepancy?.residual}`);
  // Stage 1: a 12.28 EUR residual is 24x the weekly tolerance (0.50) - nowhere near plausible
  // single-line extraction noise (confirmation band tops out at 1.5x). Must stay 'finding'.
  assert.equal(tableTaxDiscrepancy?.status, 'finding', `expected 'finding' for OTTO's real 12.28 EUR gap, got ${tableTaxDiscrepancy?.status}`);

  // Stage 2h (§2h.3): now that printed_payout is set (598.59), the SAME already-documented 12.28 gap
  // (payout_amount === period_net here, no payout adjustments) also surfaces as payout_mismatch - not
  // a new defect, the same root cause seen from its other comparison. net_mismatch must NOT appear:
  // printed_net stays null on this document (nothing was printed at that position to compare).
  const payoutDiscrepancy = discrepancies.find((d) => d.code === 'payout_mismatch');
  assert.ok(payoutDiscrepancy, 'expected the same table-tax gap to also surface as payout_mismatch now that printed_payout is set');
  // Same root cause as table_tax_mismatch, opposite sign as seen from the net side: our engine
  // withholds LESS table tax than printed, so our computed payout comes out HIGHER than the printed
  // 598.59 by the same 12.28 EUR (matches the pre-existing [2f.6] console log for period_net above).
  assert.ok(Math.abs((payoutDiscrepancy?.residual ?? 0) - 12.28) < 0.5, `expected a residual near +12.28, got ${payoutDiscrepancy?.residual}`);
  assert.ok(!discrepancies.some((d) => d.code === 'net_mismatch'), `expected no net_mismatch - OTTO's document prints no separate net figure to compare, got ${JSON.stringify(discrepancies)}`);
  assert.equal(resolveNetReconciliationBasis(outcome, period.printed_net, tableTaxToleranceFor(period.period_type)), 'not_applicable');
  // Stage 2i (§2i.0e): "group payout_mismatch under table_tax_mismatch when they have the same cause
  // (structured related_to, one row on the panel; the OTTO 12.28 case)." The two residuals mirror
  // exactly (-12.28 vs +12.28), so the arithmetic itself - not merely both codes firing together -
  // links them.
  assert.equal(payoutDiscrepancy?.related_to, 'table_tax_mismatch', `expected payout_mismatch linked to table_tax_mismatch as the same root cause, got ${JSON.stringify(payoutDiscrepancy)}`);
  assert.equal(tableTaxDiscrepancy?.related_to, null, 'the root cause itself carries no related_to - it is not related to itself');
});

/**
 * Stage 2j (audit v30, §2j.1): "the OTTO regression test named in 2j.1 exists, failed before the fix
 * (shown in the report, not just asserted), and passes after." RAPORT-cursor-2i.md's MAJOR finding:
 * the existing OTTO integration test above sets `printed_gross_total: 924.03` and
 * `printed_loon_voor_heffingen: 902.38` - the CORRECT, computed chain values, never what OTTO's real
 * document actually prints (which is 725.38 in the position the model calls "gross total" and 621.14 in
 * the position it calls "loon voor heffingen" - see FIXTURES/OWNER-RETEST-2h-otto.md). 2i.1's own
 * "OTTO" test invented a pre-tax sum of 198.65 (the ET reduction still lumped into ordinary pre-tax) to
 * make 924.03-198.65 land on 725.38 - but 2i.3, in the SAME commit, correctly pulls that ET line OUT of
 * pre-tax. This test is the one the reviewer asked for: the REAL printed anchors (725.38/621.14),
 * through the REAL mapper (with the ET line misfiled as pre-tax, exactly as a live model would produce
 * it, reclassified by 2i.3's own mapper-side backstop), through the REAL gate.
 */
test('2j.1 REGRESSION: the real, mislabelled OTTO anchors (725.38/621.14) through the real mapper (ET reclassified out of pre-tax by 2i.3) must pass the gate with no issues - failed before 2j.1, must pass after', () => {
  const extraction = baseExtraction({
    period_label: '33/2025',
    period_end_date: '2025-08-17',
    employer_names: ['DHL Supply Chain (NL) B.V.', 'KF Service & Beheer B.V.'],
    minimum_wage_printed: 14.4,
    hour_lines: [
      { employer_index: 0, description: 'Godziny przepracowane (DHL)', hours: 24.0, rate: 14.45, percent: null, amount: 346.8, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 30%', hours: 21.25, rate: 4.34, percent: 30, amount: 92.23, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 100%', hours: 2.75, rate: 14.45, percent: 100, amount: 39.74, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 1, description: 'Godziny przepracowane (KF)', hours: 19.0, rate: 14.4, percent: null, amount: 273.6, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek wakacyjny', hours: null, rate: null, percent: null, amount: 56.31, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Wymiana pw. urlopu ustawowego', hours: 0.77, rate: 14.43, percent: null, amount: 11.11, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Jednorazowa zapłata', hours: null, rate: null, percent: null, amount: 98.24, category: 'other', tax_treatment: 'bt', adds_hours: false },
      { employer_index: 0, description: 'Wynagrodzenie kierowcy brutto', hours: null, rate: null, percent: null, amount: 6.0, category: 'other', tax_treatment: 'bt', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Emerytura STIPP', amount: 21.65, category: 'pension', placement: 'pre_tax', base: null, percent: 4 },
      { description: 'PAWW Rekompensata', amount: 0.51, category: 'paww', placement: 'pre_tax', base: null, percent: null },
      { description: 'PAWW Opłata', amount: -0.51, category: 'paww', placement: 'pre_tax', base: null, percent: null },
      // The live model's actual observed filing (OWNER-RETEST-2h-otto.md): the ET reduction misfiled
      // as an ordinary pre-tax line. 2i.3's mapper-side isEtExchangeLabel backstop must pull this out.
      { description: 'Nieopod. część wyn. 100%', amount: 177.0, category: 'other', placement: 'pre_tax', base: null, percent: null },
    ],
    et_exchange_amount: null, // not read directly - reproducing the live extraction gap 2i.3 fixes via the mapper
    et_reimbursement_lines: [
      { description: 'Zwrot kosztów utrzymania ET', amount: 33.0, category: 'reimbursement' },
      { description: 'Zwrot za zakwaterowanie ET', amount: 144.0, category: 'reimbursement' },
    ],
    net_lines: [
      { description: 'Potrącenie własnego wkładu WHK', amount: 1.55, category: 'other' },
      { description: 'Nominalna składka ubezpieczenia zdrowotnego', amount: 38.01, category: 'health_insurance' },
      { description: 'Potrącenie kosztów przewozu', amount: 2.63, category: 'transport' },
      { description: 'Potrącenie za zakwaterowanie', amount: 144.0, category: 'housing' },
    ],
    bijzonder_tarief_printed_percent: 38.45,
    printed_table_tax: 77.52,
    printed_bt_tax: 40.08,
    reported_net_paid: 598.59,
    // The REAL printed anchors, exactly as OTTO's own document prints them (FIXTURES /
    // OWNER-RETEST-2h-otto.md) - the document prints ONE subtotal-shaped number (725.38, "RAZEM
    // PODSTAWA") that the model reads into printed_gross_total (a label the document does not use at
    // all for this figure), and a SECOND number (621.14, the normal-rate base component) into
    // printed_loon_voor_heffingen. Neither is actually gross or lvh - this is the exact shape 2i.1/2i.2
    // were built for but never tested against.
    printed_gross_total: 725.38,
    printed_loon_voor_heffingen: 621.14,
    printed_taxable_base_normal: 621.14,
    printed_taxable_base_special: 104.24,
  });

  const period = mapExtractionToPeriod(extraction, 14.4);
  // Sanity: 2i.3's reclassifier did its job - pre-tax is 21.65 (STIPP + the Rekompensata/Opłata net-
  // zero pair), NOT 198.65, and et_exchange_amount is 177.00, resolved from the misfiled line.
  assert.equal(
    period.pre_tax_deductions.reduce((sum, d) => sum + (d.amount.value ?? 0), 0),
    21.65,
    'expected the ET line reclassified OUT of pre-tax deductions - pre-tax must be 21.65 (STIPP), not 198.65',
  );
  assert.equal(period.et?.et_exchange_amount, 177, 'expected et_exchange_amount resolved from the misfiled pre-tax line');

  const outcome = computePayslipPeriod(period, RATES_2025, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  assert.equal(outcome.result.taxable_base, 725.38, 'sanity: the engine itself still computes the correct taxable base');

  const issues = checkExtractionConsistency(extraction.payment_date, period, outcome);
  assert.deepEqual(issues, [], `expected the gate to pass on OTTO's real, mislabelled anchors once ET is resolved to the correct chain position - got ${JSON.stringify(issues)}`);
});

/**
 * Stage 2i (audit v29, §2i.2): "find out how the mapper decides which gross lines fall under the
 * special (bijzonder tarief) base... if the engine gets 104.24 right today, say so with the test that
 * shows it, and do not rebuild it." Answer, confirmed by this test: mapExtractionToPeriod does NOT
 * decide anything - `tax_treatment: line.tax_treatment` (tier-c.ts) is a straight pass-through of
 * whatever the model itself read per hour_line, exactly like every other AK2 "read, never inferred"
 * field. The actual split into normal-base vs BT-base sums happens downstream, in
 * payslip-model.ts's `summariseHourLines` (`tableGross`/`btGross`, keyed off each line's own
 * tax_treatment) - already proven exact for OTTO by payslip-model.test.ts's own "Fixture 2 OTTO" test
 * (bt_tax.toFixed(2) === '40.08', the flat 38.45% of 104.24). This test adds the mapping-boundary half
 * of that proof: an extraction whose two BT lines are tagged 'bt' (as the OTTO document read) maps
 * straight through into a PayslipPeriod that reproduces the same 104.24/621.14 split - and stays
 * correct even with the new printed_taxable_base_normal/special fields set, since those two fields are
 * a passive verification target (2i.2), never an input the split itself uses.
 */
test("2i.2: the mapper does not decide the BT split - tax_treatment is a straight per-line pass-through, and printed_taxable_base_normal/special map through unchanged", () => {
  const extraction = baseExtraction({
    period_label: '33/2025',
    period_end_date: '2025-08-17',
    employer_names: ['DHL Supply Chain (NL) B.V.', 'KF Service & Beheer B.V.'],
    minimum_wage_printed: 14.4,
    hour_lines: [
      { employer_index: 0, description: 'Godziny przepracowane (DHL)', hours: 24.0, rate: 14.45, percent: null, amount: 346.8, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 30%', hours: 21.25, rate: 4.34, percent: 30, amount: 92.23, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 100%', hours: 2.75, rate: 14.45, percent: 100, amount: 39.74, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 1, description: 'Godziny przepracowane (KF)', hours: 19.0, rate: 14.4, percent: null, amount: 273.6, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek wakacyjny', hours: null, rate: null, percent: null, amount: 56.31, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Wymiana pw. urlopu ustawowego', hours: 0.77, rate: 14.43, percent: null, amount: 11.11, category: 'other', tax_treatment: 'table', adds_hours: false },
      // The two lines OTTO's own model read tagged 'bt' - nothing in tier-c.ts's mapping layer
      // inspects "Jednorazowa zapłata" or "Wynagrodzenie kierowcy brutto" by name to decide this;
      // relabelling them 'table' here (proving the pass-through) would change the computed split.
      { employer_index: 0, description: 'Jednorazowa zapłata', hours: null, rate: null, percent: null, amount: 98.24, category: 'other', tax_treatment: 'bt', adds_hours: false },
      { employer_index: 0, description: 'Wynagrodzenie kierowcy brutto', hours: null, rate: null, percent: null, amount: 6.0, category: 'other', tax_treatment: 'bt', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Emerytura STIPP', amount: 21.65, category: 'pension', placement: 'pre_tax', base: null, percent: 4 },
      { description: 'PAWW Rekompensata', amount: 0.51, category: 'paww', placement: 'pre_tax', base: null, percent: null },
      { description: 'PAWW Opłata', amount: -0.51, category: 'paww', placement: 'pre_tax', base: null, percent: null },
    ],
    et_exchange_amount: 177.0,
    et_reimbursement_lines: [
      { description: 'Zwrot kosztów utrzymania ET', amount: 33.0, category: 'reimbursement' },
      { description: 'Zwrot za zakwaterowanie ET', amount: 144.0, category: 'reimbursement' },
    ],
    bijzonder_tarief_printed_percent: 38.45,
    printed_table_tax: 77.52,
    printed_bt_tax: 40.08,
    reported_net_paid: 598.59,
    printed_gross_total: 924.03,
    printed_loon_voor_heffingen: 902.38,
    // Stage 2i (§2i.2): the owner's panel figures - the split verification target, never the input.
    printed_taxable_base_normal: 621.14,
    printed_taxable_base_special: 104.24,
  });

  const period = mapExtractionToPeriod(extraction, 14.4);
  // The mapping boundary: tax_treatment on each hour_line survived unchanged, in order.
  const jednorazowa = period.hour_lines.find((l) => l.description === 'Jednorazowa zapłata');
  const kierowca = period.hour_lines.find((l) => l.description === 'Wynagrodzenie kierowcy brutto');
  assert.equal(jednorazowa?.tax_treatment, 'bt');
  assert.equal(kierowca?.tax_treatment, 'bt');
  assert.equal(period.printed_taxable_base_normal, 621.14);
  assert.equal(period.printed_taxable_base_special, 104.24);

  const outcome = computePayslipPeriod(period, RATES_2025, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  // The downstream split, driven entirely by the per-line tags just confirmed above - the engine
  // reproduces both the special base (98.24 + 6.00) and the normal base (725.38 - 104.24) exactly,
  // with no rebuild needed for this stage (§2i.2's own instruction).
  assert.equal(outcome.result.taxable_base, 725.38);
  assert.equal(outcome.result.bt_tax.toFixed(2), '40.08');

  // The new 2i.2 consistency check: 621.14 + 104.24 must reconcile against the resolved 725.38 anchor
  // (2i.1's own reassignment) - it does, so the gate stays clean, same as the un-split OTTO fixture.
  const consistencyIssues = checkExtractionConsistency(extraction.payment_date, period, outcome);
  assert.ok(!consistencyIssues.some((i) => i.code === 'printed_tax_bases_do_not_reconcile'), `expected the base split to reconcile, got ${JSON.stringify(consistencyIssues)}`);
});

/**
 * Stage 2i (audit v29, §2i.3): "the 177.00 'Nieopod. część wyn. 100%' is the ET exchange reduction...
 * fix prompt and mapper so a line reducing taxable base by the ET reimbursement amount is read into
 * et_exchange_amount." Reproduces the EXACT failure OWNER-RETEST-2h-otto.md recorded on the live
 * build: the model read the amount correctly (177.00) but left it in pre_tax_deduction_lines under
 * category 'other' - this test proves the mapper-side backstop reclassifies it without any prompt
 * change at all (the prompt fix is the OTHER half - a mocked-model test can prove the mapper handles a
 * misfiled line; it cannot prove the live model now files it correctly in the first place - only a real
 * upload can, per the assignment's own "say what mocked-model tests can/cannot prove").
 */
test("2i.3: an ET-labelled line left in pre_tax_deduction_lines is reclassified into et_exchange_amount and removed from pre_tax_deductions", () => {
  const extraction = baseExtraction({
    hour_lines: [{ employer_index: 0, description: 'gross', hours: 40, rate: 15, percent: null, amount: 600, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    pre_tax_deduction_lines: [
      { description: 'Emerytura STIPP', amount: 21.65, category: 'pension', placement: 'pre_tax', base: null, percent: 4 },
      { description: 'Nieopod. część wyn. 100%', amount: 177.0, category: 'other', placement: 'pre_tax', base: null, percent: null },
    ],
    et_exchange_amount: null, // the model did NOT report it directly - exactly the observed live failure
    et_reimbursement_lines: [
      { description: 'Zwrot kosztów utrzymania ET', amount: 33.0, category: 'reimbursement' },
      { description: 'Zwrot za zakwaterowanie ET', amount: 144.0, category: 'reimbursement' },
    ],
  });

  assert.equal(resolveEtExchangeAmountFromExtraction(extraction), 177, 'expected the shared resolver to find 177.00 via the mislabelled pre-tax line');

  const period = mapExtractionToPeriod(extraction, null);
  assert.equal(period.pre_tax_deductions.length, 1, 'expected the ET-labelled line removed from pre_tax_deductions, leaving only STIPP');
  assert.equal(period.pre_tax_deductions[0]?.description, 'Emerytura STIPP');
  assert.ok(period.et?.et_applicable);
  assert.equal(period.et?.et_exchange_amount, 177, 'expected the reclassified amount to land in et_exchange_amount');
  assert.equal(period.et?.et_reimbursements.length, 2);
});

test('2i.3: an explicit et_exchange_amount is never overwritten by a mislabelled pre-tax line, but the line is still pulled out of pre-tax (never double-counted)', () => {
  const extraction = baseExtraction({
    hour_lines: [{ employer_index: 0, description: 'gross', hours: 40, rate: 15, percent: null, amount: 600, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    pre_tax_deduction_lines: [
      { description: 'Nieopod. część wyn. 100%', amount: 999.0, category: 'other', placement: 'pre_tax', base: null, percent: null }, // a stale/duplicate reading, deliberately wrong
    ],
    et_exchange_amount: 177.0, // the model's own direct reading wins
    et_reimbursement_lines: [],
  });
  assert.equal(resolveEtExchangeAmountFromExtraction(extraction), 177, 'expected the explicit reading to win over the mislabelled line');
  const period = mapExtractionToPeriod(extraction, null);
  assert.equal(period.pre_tax_deductions.length, 0, 'expected the ET-labelled line excluded from pre-tax even though it was not the source of the value used');
  assert.equal(period.et?.et_exchange_amount, 177);
});

test('2i.3: no ET-labelled line and no explicit reading resolves to null - never invented', () => {
  const extraction = baseExtraction({
    pre_tax_deduction_lines: [{ description: 'Emerytura STIPP', amount: 21.65, category: 'pension', placement: 'pre_tax', base: null, percent: 4 }],
    et_exchange_amount: null,
    et_reimbursement_lines: [],
  });
  assert.equal(resolveEtExchangeAmountFromExtraction(extraction), null);
  const period = mapExtractionToPeriod(extraction, null);
  assert.equal(period.et, null, 'expected no ET arrangement at all - nothing printed, nothing to reclassify');
});

test("2i.3: the controller's own gap check must read the SAME resolution as the mapper - reproduced here as a direct call, proving the two cannot disagree", () => {
  // The exact shape that would have falsely blocked before this fix: reimbursements present, the raw
  // et_exchange_amount field null, but a mislabelled pre-tax line the mapper CAN resolve.
  const extraction = baseExtraction({
    pre_tax_deduction_lines: [{ description: 'Nieopod. część wyn. 100%', amount: 177.0, category: 'other', placement: 'pre_tax', base: null, percent: null }],
    et_exchange_amount: null,
    et_reimbursement_lines: [{ description: 'Zwrot kosztów utrzymania ET', amount: 177.0, category: 'reimbursement' }],
  });
  // tier-c.controller.ts's own gap check: `et_reimbursement_lines.length > 0 && resolveEtExchangeAmountFromExtraction(extraction) === null`.
  const wouldBlock = extraction.et_reimbursement_lines.length > 0 && resolveEtExchangeAmountFromExtraction(extraction) === null;
  assert.equal(wouldBlock, false, 'expected the controller to NOT raise et_exchange_amount_unknown once the mapper can resolve the reading');
});

/**
 * Stage 2i (§2i.3): "when base reduction equals sum of reimbursements gate can confirm reading" - the
 * new et_reduction_reimbursement_mismatch check, direct on checkExtractionConsistency.
 */
test('2i.3: 33.00 + 144.00 reimbursements matching a 177.00 exchange amount exactly - no mismatch issue (the gate confirms the reading)', () => {
  const extraction = baseExtraction({
    hour_lines: [{ employer_index: 0, description: 'gross', hours: 40, rate: 15, percent: null, amount: 600, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    et_exchange_amount: 177.0,
    et_reimbursement_lines: [
      { description: 'Zwrot kosztów utrzymania ET', amount: 33.0, category: 'reimbursement' },
      { description: 'Zwrot za zakwaterowanie ET', amount: 144.0, category: 'reimbursement' },
    ],
  });
  const period = mapExtractionToPeriod(extraction, null);
  const outcome = computePayslipPeriod(period, RATES_2025, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  const issues = checkExtractionConsistency(extraction.payment_date, period, outcome);
  assert.ok(!issues.some((i) => i.code === 'et_reduction_reimbursement_mismatch'), `expected the matching reimbursements to confirm the reading, got ${JSON.stringify(issues)}`);
});

test('2i.3: an incomplete reimbursement list (only 33.00 of a 177.00 reduction) fires et_reduction_reimbursement_mismatch with the exact residual', () => {
  const extraction = baseExtraction({
    hour_lines: [{ employer_index: 0, description: 'gross', hours: 40, rate: 15, percent: null, amount: 600, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    et_exchange_amount: 177.0,
    et_reimbursement_lines: [{ description: 'Zwrot kosztów utrzymania ET', amount: 33.0, category: 'reimbursement' }], // the 144.00 line missing
  });
  const period = mapExtractionToPeriod(extraction, null);
  const outcome = computePayslipPeriod(period, RATES_2025, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  const issues = checkExtractionConsistency(extraction.payment_date, period, outcome);
  const issue = issues.find((i) => i.code === 'et_reduction_reimbursement_mismatch');
  assert.ok(issue, `expected et_reduction_reimbursement_mismatch, got ${JSON.stringify(issues)}`);
  if (issue?.code === 'et_reduction_reimbursement_mismatch') {
    assert.equal(issue.et_exchange_amount, 177);
    assert.equal(issue.reimbursements_sum, 33);
    assert.equal(issue.residual, -144);
  }
});

/**
 * Stage 2 body ("Dutch terms as printed... not canonical"): the printed_*_label plumbing. Uses a
 * synthetic fixture, deliberately NOT one of the four real documents above - no real-document text
 * for these six labels has been confirmed yet (per §2.2, that requires a real vision extraction to
 * observe, not something to assert from memory), so this tests only that the mechanism carries
 * whatever the extraction reports through to the discrepancy the user sees, verbatim, and degrades to
 * null (never a fabricated canonical term) when the extraction did not capture one.
 */
test('2.0-body: an as-printed label captured by extraction reaches the discrepancy exactly as given', () => {
  const extraction = baseExtraction({
    hour_lines: [{ employer_index: 0, description: 'Test regular hours', hours: 40, rate: 15, percent: null, amount: 600, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    printed_table_tax: 50, // far outside tolerance on purpose, so a discrepancy is guaranteed to push
    printed_table_tax_label: 'Loonheffing', // synthetic - not asserted to be what any real document prints
  });
  const period = mapExtractionToPeriod(extraction, null);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  const tableTax = discrepancies.find((d) => d.code === 'table_tax_mismatch');
  assert.ok(tableTax, 'expected a table_tax_mismatch discrepancy given the deliberately wide gap');
  assert.equal(tableTax?.printed_label, 'Loonheffing');
});

test('2.0-body: no label captured -> printed_label is null, never a guessed canonical term', () => {
  const extraction = baseExtraction({
    hour_lines: [{ employer_index: 0, description: 'Test regular hours', hours: 40, rate: 15, percent: null, amount: 600, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    printed_table_tax: 50,
    // printed_table_tax_label left at baseExtraction's default: null
  });
  const period = mapExtractionToPeriod(extraction, null);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  const tableTax = discrepancies.find((d) => d.code === 'table_tax_mismatch');
  assert.ok(tableTax);
  assert.equal(tableTax?.printed_label, null);
});

/**
 * ============================================================================================
 * BW - extraction-noise false-positive test (audit round "TIER DEFINITIONS, FINAL", order item 1).
 * ============================================================================================
 * BQ4's question, restated: "if extraction noise alone generates discrepancies, the product accuses
 * employers on the strength of its own OCR errors." Every test above uses a HAND-BUILT extraction
 * that already matches its real document exactly - none of them exercise what happens when the
 * extraction is off in ways a real vision read plausibly would be. These tests do: each takes the
 * PKF or Randstad extraction (both confirmed byte-for-byte against the real PDF, audit BQ) and
 * perturbs exactly one field the way a real OCR/vision misread plausibly would, then checks whether
 * comparePeriodToDocument() manufactures a discrepancy on what is still, underneath the noise, a
 * correct payslip. This is a measurement, not a prediction - the assertions below record what was
 * actually observed running this code, not what was expected going in.
 *
 * Each noise scenario is classified FALSE POSITIVE (a correct payslip gets flagged) or CLEAN
 * (tolerance correctly absorbs the noise, or the comparator correctly has nothing to compare against
 * a field it never checks). The measured rate is reported in the round's report, not just here.
 */

test('BW1: description-only noise (diacritics dropped, case changed) changes nothing - CLEAN', () => {
  // Real documents drop diacritics inconsistently (audit BQ's OTTO finding: "zaplata" not "zapłata").
  // description is never used in computation (only category/tax_treatment/amount are) - this test
  // exists to CONFIRM that design choice holds, not just assert it in a comment.
  const extraction = baseExtraction({
    period_label: 'week 2026-11',
    period_end_date: '2026-04-30',
    is_correction: true,
    version: 2,
    employer_names: ['Randstad'],
    hirer_name: 'Emballagefabriek H. Post B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'BRUTO LOON UREN', hours: 38.0, rate: 17.09, percent: null, amount: 649.42, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'bruto loon overuren 125', hours: 2.0, rate: 17.09, percent: 125, amount: 42.73, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'bruto loon overuren 150', hours: 9.25, rate: 17.09, percent: 150, amount: 237.12, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'compensatie adv', hours: null, rate: null, percent: null, amount: 39.61, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'compensatie overgangsregeling', hours: null, rate: null, percent: null, amount: 2.01, category: 'other', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'premie paww', amount: 0.74, category: 'paww', placement: 'pre_tax', base: 970.89, percent: 0.08 },
      { description: 'premie aanvullende verzekering ziektewet premiegroep ii a (no diacritics)', amount: 4.55, category: 'ziektewet', placement: 'pre_tax', base: 970.89, percent: 0.7 },
      { description: 'pensioenpremie', amount: 38.35, category: 'pension', placement: 'pre_tax', base: null, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      { description: 'premie wga', amount: 12.33, category: 'wga', placement: 'post_tax', base: null, percent: 1.33 },
    ],
    net_lines: [{ description: 'reiskosten woon-werk', amount: 36.0, category: 'reimbursement' }],
    payout_adjustment_lines: [
      { description: 'verrekend met openstaande schuld', amount: -47.53 },
      { description: 'eerder betaald', amount: -744.73 },
    ],
    bijzonder_tarief_printed_percent: 50.47,
    bijzonder_tarief_jaarloon: 46074,
    printed_table_tax: 71.31,
    printed_bt_tax: 141.24,
  });

  const period = mapExtractionToPeriod(extraction, 14.71);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW1] description-noise discrepancies: ${discrepancies.length === 0 ? 'none (CLEAN, as expected)' : JSON.stringify(discrepancies)}`);
  assert.deepEqual(discrepancies, [], 'description-only noise must never manufacture a discrepancy - description is not a computation input');
});

test('CL: a reimbursement misclassified as a deduction now correctly surfaces as payout_mismatch (closes last round\'s false-negative gap)', () => {
  // Last round found that net_mismatch/payout_mismatch were declared but never pushed - a net_lines
  // classification error (a genuine reimbursement read as a deduction, flipping it from
  // net_additions into net_deductions) would silently produce a wrong final payout with "no
  // discrepancy" reported. This is the Randstad fixture with exactly that one error introduced:
  // 'reiskosten woon-werk' (a real, untaxed travel reimbursement) misclassified from category
  // 'reimbursement' to 'transport' (a real NetDeductionCategory) - everything else is unchanged from
  // the clean, real-document-verified fixture.
  const extraction = baseExtraction({
    period_label: 'week 2026-11',
    period_end_date: '2026-04-30',
    is_correction: true,
    version: 2,
    employer_names: ['Randstad'],
    hirer_name: 'Emballagefabriek H. Post B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'Bruto loon uren', hours: 38.0, rate: 17.09, percent: null, amount: 649.42, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 125%', hours: 2.0, rate: 17.09, percent: 125, amount: 42.73, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 150%', hours: 9.25, rate: 17.09, percent: 150, amount: 237.12, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Compensatie ADV', hours: null, rate: null, percent: null, amount: 39.61, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Compensatie overgangsregeling', hours: null, rate: null, percent: null, amount: 2.01, category: 'other', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Premie PAWW', amount: 0.74, category: 'paww', placement: 'pre_tax', base: 970.89, percent: 0.08 },
      { description: 'Premie aanvullende verzekering Ziektewet premiegroep II A', amount: 4.55, category: 'ziektewet', placement: 'pre_tax', base: 970.89, percent: 0.7 },
      { description: 'Pensioenpremie', amount: 38.35, category: 'pension', placement: 'pre_tax', base: null, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      { description: 'Premie WGA', amount: 12.33, category: 'wga', placement: 'post_tax', base: null, percent: 1.33 },
    ],
    net_lines: [{ description: 'Reiskosten woon-werk', amount: 36.0, category: 'transport' }], // NOISE: was 'reimbursement'
    payout_adjustment_lines: [
      { description: 'Verrekend met openstaande schuld', amount: -47.53 },
      { description: 'Eerder betaald', amount: -744.73 },
    ],
    bijzonder_tarief_printed_percent: 50.47,
    bijzonder_tarief_jaarloon: 46074,
    printed_table_tax: 71.31,
    printed_bt_tax: 141.24,
    reported_net_paid: -53.89, // the real printed figure - unchanged by the noise, since it's what the document actually says
  });

  const period = mapExtractionToPeriod(extraction, 14.71);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [CL] reimbursement-misclassified-as-deduction discrepancies: ${JSON.stringify(discrepancies)}`);
  const payoutMismatch = discrepancies.find((d) => d.code === 'payout_mismatch');
  assert.ok(payoutMismatch, 'BEFORE this round: this error passed silently as "no discrepancy". AFTER: payout_mismatch must fire - the 36 EUR moved from net_additions to net_deductions is a real 72 EUR swing in the final payout.');
  // Stage 1 (audit "CONSOLIDATED ASSIGNMENT" round): a 72 EUR swing is nowhere near plausible
  // single-line extraction noise (the confirmation band tops out at 1.5x tableTolerance) - this must
  // classify as 'finding', stated plainly, never softened into a mere confirmation question.
  assert.equal(payoutMismatch?.status, 'finding', `expected 'finding' for a 72 EUR swing, got ${payoutMismatch?.status}`);
  // Stage 2i (§2i.0e): this fixture's table tax IS correct (71.31, unchanged) - no table_tax_mismatch
  // exists to link against, so the genuinely UNRELATED payout error must stay unlinked, not grouped
  // under a tax discrepancy that never fired. Proves the linking is gated on the arithmetic actually
  // being present, not merely "any tax code plus any payout code in the same list".
  assert.ok(!discrepancies.some((d) => d.code === 'table_tax_mismatch'), 'expected no table_tax_mismatch in this fixture (its printed tax is correct)');
  assert.equal(payoutMismatch?.related_to, null, 'expected an unrelated payout error to stay unlinked when no tax discrepancy exists to link it to');
});

test('BW2: a small ambiguous line misclassified table->bt (a plausible AI judgment error) - measured', () => {
  // Randstad's "Compensatie overgangsregeling" (2.01 EUR) has no explicit tax marker on the document
  // beyond context; a vision read could plausibly file it as a bonus-shaped BT line instead of a
  // table-taxed one. Real document text and every other field is unchanged from the clean Randstad
  // fixture - only this one line's tax_treatment is flipped, exactly the kind of single-field
  // extraction slip BQ4 is asking about.
  const extraction = baseExtraction({
    period_label: 'week 2026-11',
    period_end_date: '2026-04-30',
    is_correction: true,
    version: 2,
    employer_names: ['Randstad'],
    hirer_name: 'Emballagefabriek H. Post B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'Bruto loon uren', hours: 38.0, rate: 17.09, percent: null, amount: 649.42, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 125%', hours: 2.0, rate: 17.09, percent: 125, amount: 42.73, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 150%', hours: 9.25, rate: 17.09, percent: 150, amount: 237.12, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Compensatie ADV', hours: null, rate: null, percent: null, amount: 39.61, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Compensatie overgangsregeling', hours: null, rate: null, percent: null, amount: 2.01, category: 'other', tax_treatment: 'bt', adds_hours: false }, // NOISE: was 'table'
    ],
    pre_tax_deduction_lines: [
      { description: 'Premie PAWW', amount: 0.74, category: 'paww', placement: 'pre_tax', base: 970.89, percent: 0.08 },
      { description: 'Premie aanvullende verzekering Ziektewet premiegroep II A', amount: 4.55, category: 'ziektewet', placement: 'pre_tax', base: 970.89, percent: 0.7 },
      { description: 'Pensioenpremie', amount: 38.35, category: 'pension', placement: 'pre_tax', base: null, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      { description: 'Premie WGA', amount: 12.33, category: 'wga', placement: 'post_tax', base: null, percent: 1.33 },
    ],
    net_lines: [{ description: 'Reiskosten woon-werk', amount: 36.0, category: 'reimbursement' }],
    payout_adjustment_lines: [
      { description: 'Verrekend met openstaande schuld', amount: -47.53 },
      { description: 'Eerder betaald', amount: -744.73 },
    ],
    bijzonder_tarief_printed_percent: 50.47,
    bijzonder_tarief_jaarloon: 46074,
    printed_table_tax: 71.31,
    printed_bt_tax: 141.24,
  });

  const period = mapExtractionToPeriod(extraction, 14.71);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW2] tax_treatment-misclassification discrepancies: ${JSON.stringify(discrepancies)}`);
  // Measured, not assumed: moving 2.01 EUR from the table-taxed to the BT-taxed bucket shifts both
  // table_tax and bt_tax by a small amount. Whether that crosses the tolerance band is the actual
  // question BW2 answers - assert on what running the code showed, not on an assumption made before
  // running it.
  assert.ok(discrepancies.every((d) => d.code === 'table_tax_mismatch' || d.code === 'bt_tax_mismatch'), 'only tax-figure codes should be able to fire from a tax_treatment change');
  // Stage 1 (audit "CONSOLIDATED ASSIGNMENT" round, Tier C): a single plausible AI misjudgment on
  // one small ambiguous line is exactly the case the confirmation band exists for - both codes
  // measured here must classify as 'confirm' (a question), never 'finding' (a stated accusation).
  assert.ok(discrepancies.every((d) => d.status === 'confirm'), `expected both to classify as 'confirm', got: ${JSON.stringify(discrepancies.map((d) => ({ code: d.code, status: d.status })))}`);
});

test('BW3: a five-cent OCR digit-slip on the printed BT-tax figure - re-measured after CJ\'s retune', () => {
  // CJ (audit "SEVERAL EMPLOYERS AT ONCE" round): this test originally measured a FALSE POSITIVE
  // here under bt_tax_mismatch's old 0.01 EXACT_TOLERANCE (a real product gap this test itself
  // surfaced). BT_TAX_TOLERANCE is now 0.10 (discrepancy.ts) specifically to absorb this class of
  // noise - re-running the identical scenario after the retune is the CJ instruction ("retune
  // tolerances, re-run BW"), not a new scenario. (Also fixing a labelling error from last round: 0.05
  // EUR is a five-cent slip, not a one-cent one - the number was always right, the name was not.)
  const base = baseExtraction({
    period_label: '2026-8-M',
    period_end_date: '2026-08-31',
    period_type: 'month',
    employer_names: ['PKF / Post Finsterwolde BV'],
    hours_per_week: 40.0,
    minimum_wage_printed: 14.99,
    hour_lines: [
      { employer_index: 0, description: 'Salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk uren 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk uren 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deduction_lines: [
      { description: 'Paww Wn', amount: 3.52, category: 'paww', placement: 'pre_tax', base: 3515.56, percent: 0.1 },
      { description: 'Pensioenpremie Wn', amount: 229.03, category: 'pension', placement: 'pre_tax', base: 1601.58, percent: 14.3 },
      { description: 'WGA-Gat Verzekering Wn', amount: 5.99, category: 'wga_gat', placement: 'pre_tax', base: 3277.02, percent: 0.183 },
    ],
    post_tax_deduction_lines: [
      { description: 'gediff. WGA wn', amount: 11.31, category: 'gediff_wga', placement: 'post_tax', base: 3277.02, percent: 0.345 },
    ],
    net_lines: [
      { description: 'Reiskostenvergoeding (onbelast)', amount: 91.25, category: 'reimbursement' },
      { description: 'Inhouding Personeelsvereniging', amount: 4.0, category: 'union' },
      { description: 'Inhouding Lening', amount: 1100.0, category: 'loan' },
    ],
    reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 281.24, paid_out: 0 }],
    bijzonder_tarief_printed_percent: 40.2,
    bijzonder_tarief_jaarloon: 38000,
    printed_table_tax: 276.42,
    printed_bt_tax: 222.47, // NOISE: real printed figure is 222.42 - a five-cent digit slip
  });

  const period = mapExtractionToPeriod(base, 14.99);
  const outcome = computePayslipPeriod(period, { ...RATES_2026, period_multiplier: 12 }, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW3] five-cent bt_tax OCR slip discrepancies (post-CJ-retune): ${JSON.stringify(discrepancies)}`);
  assert.deepEqual(discrepancies, [], 'CJ RESOLVED: the retuned 0.10 BT_TAX_TOLERANCE now correctly absorbs this five-cent OCR slip - CLEAN');
});

test('BW3b: a 0.20 EUR bt_tax slip still correctly fires past the retuned tolerance - the retune is not a blank check', () => {
  // Same PKF base as BW3, but the noise is now large enough (0.20 EUR, twice BT_TAX_TOLERANCE) that
  // it must still be caught - proves CJ's retune widened the band, it did not remove it.
  const extraction = baseExtraction({
    period_label: '2026-8-M',
    period_end_date: '2026-08-31',
    period_type: 'month',
    employer_names: ['PKF / Post Finsterwolde BV'],
    hours_per_week: 40.0,
    minimum_wage_printed: 14.99,
    hour_lines: [
      { employer_index: 0, description: 'Salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk uren 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk uren 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deduction_lines: [
      { description: 'Paww Wn', amount: 3.52, category: 'paww', placement: 'pre_tax', base: 3515.56, percent: 0.1 },
      { description: 'Pensioenpremie Wn', amount: 229.03, category: 'pension', placement: 'pre_tax', base: 1601.58, percent: 14.3 },
      { description: 'WGA-Gat Verzekering Wn', amount: 5.99, category: 'wga_gat', placement: 'pre_tax', base: 3277.02, percent: 0.183 },
    ],
    post_tax_deduction_lines: [
      { description: 'gediff. WGA wn', amount: 11.31, category: 'gediff_wga', placement: 'post_tax', base: 3277.02, percent: 0.345 },
    ],
    net_lines: [
      { description: 'Reiskostenvergoeding (onbelast)', amount: 91.25, category: 'reimbursement' },
      { description: 'Inhouding Personeelsvereniging', amount: 4.0, category: 'union' },
      { description: 'Inhouding Lening', amount: 1100.0, category: 'loan' },
    ],
    reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 281.24, paid_out: 0 }],
    bijzonder_tarief_printed_percent: 40.2,
    bijzonder_tarief_jaarloon: 38000,
    printed_table_tax: 276.42,
    printed_bt_tax: 222.62, // NOISE: real printed figure is 222.42 - a 0.20 EUR slip, twice BT_TAX_TOLERANCE
  });

  const period = mapExtractionToPeriod(extraction, 14.99);
  const outcome = computePayslipPeriod(period, { ...RATES_2026, period_multiplier: 12 }, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW3b] 0.20 EUR bt_tax slip discrepancies: ${JSON.stringify(discrepancies)}`);
  const btMismatch = discrepancies.find((d) => d.code === 'bt_tax_mismatch');
  assert.ok(btMismatch, 'a 0.20 EUR slip must still be caught - the retune widened the band, it did not remove it');
  // Stage 1: still inside BT's confirmation band (1.5) - a modest, plausible OCR slip on the printed
  // figure should read as a question, not an accusation, even though it's beyond the silent tolerance.
  assert.equal(btMismatch?.status, 'confirm', `expected 'confirm' for a 0.20 EUR slip, got ${btMismatch?.status}`);
});

test('BW4: a table-tax OCR slip within the period tolerance band - correctly absorbed, CLEAN', () => {
  // Same PKF fixture, but the noise this time is on printed_table_tax and stays inside the monthly
  // tolerance (1.50) already established from real table-rounding behavior (N2/AN3) - this is the
  // control case proving the tolerance band does its job for realistically-sized OCR noise on a
  // figure that isn't held to EXACT_TOLERANCE.
  const extraction = baseExtraction({
    period_label: '2026-8-M',
    period_end_date: '2026-08-31',
    period_type: 'month',
    employer_names: ['PKF / Post Finsterwolde BV'],
    hours_per_week: 40.0,
    minimum_wage_printed: 14.99,
    hour_lines: [
      { employer_index: 0, description: 'Salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk uren 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk uren 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deduction_lines: [
      { description: 'Paww Wn', amount: 3.52, category: 'paww', placement: 'pre_tax', base: 3515.56, percent: 0.1 },
      { description: 'Pensioenpremie Wn', amount: 229.03, category: 'pension', placement: 'pre_tax', base: 1601.58, percent: 14.3 },
      { description: 'WGA-Gat Verzekering Wn', amount: 5.99, category: 'wga_gat', placement: 'pre_tax', base: 3277.02, percent: 0.183 },
    ],
    post_tax_deduction_lines: [
      { description: 'gediff. WGA wn', amount: 11.31, category: 'gediff_wga', placement: 'post_tax', base: 3277.02, percent: 0.345 },
    ],
    net_lines: [
      { description: 'Reiskostenvergoeding (onbelast)', amount: 91.25, category: 'reimbursement' },
      { description: 'Inhouding Personeelsvereniging', amount: 4.0, category: 'union' },
      { description: 'Inhouding Lening', amount: 1100.0, category: 'loan' },
    ],
    reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 281.24, paid_out: 0 }],
    bijzonder_tarief_printed_percent: 40.2,
    bijzonder_tarief_jaarloon: 38000,
    printed_table_tax: 276.72, // NOISE: real printed figure is 276.42 - a 0.30 slip, inside the 1.50 monthly band
    printed_bt_tax: 222.42,
  });

  const period = mapExtractionToPeriod(extraction, 14.99);
  const outcome = computePayslipPeriod(period, { ...RATES_2026, period_multiplier: 12 }, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW4] table-tax OCR slip (within tolerance) discrepancies: ${JSON.stringify(discrepancies)}`);
  assert.deepEqual(discrepancies, [], 'a 0.30 EUR slip on printed_table_tax must stay inside the 1.50 monthly tolerance');
});

/**
 * BW5 (historical) found `net_mismatch`/`payout_mismatch` never pushed at all; a later round (CL)
 * wired both. Stage 2g (audit v27, §2g.0a) found the wiring for `net_mismatch` itself was wrong,
 * live, via the new HTTP-level `/analyze` test - the first fixture to set BOTH `reported_total_net`
 * and a real net addition together (every fixture before it had left one or the other unset, so this
 * never actually ran). `discrepancy.ts` compared `result.period_net` (AFTER net additions/deductions)
 * against `period.printed_net` - but the prompt's own field definition says `printed_net` is the
 * figure BEFORE them ("suma PRZED doliczeniem zwrotów kosztów... i korekt wypłaty"). The two would
 * misalign by exactly the net additions/deductions total on every real payslip that has any -
 * Olympia's real 90.00 travel reimbursement makes this fire on every correct read of it. Fixed:
 * `discrepancy.ts` now compares `result.wage_net` (before additions) instead.
 */
test('2g.0a regression: net_mismatch compares wage_net (before net additions), not period_net (after) - a correct read with a real travel reimbursement must not misfire', () => {
  const extraction = baseExtraction({
    hour_lines: [{ employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 885.5, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    pre_tax_deduction_lines: [
      { description: 'Bijlage PAWW werknemer', amount: 0.89, category: 'paww', placement: 'pre_tax', base: null, percent: null },
      { description: 'AZW werknemer', amount: 4.9, category: 'ziektewet', placement: 'pre_tax', base: null, percent: null },
      { description: 'StiPP-pensioen werknemer', amount: 34.79, category: 'pension', placement: 'pre_tax', base: null, percent: null },
    ],
    post_tax_deduction_lines: [{ description: 'WHK werknemer', amount: 6.46, category: 'whk', placement: 'post_tax', base: null, percent: null }],
    net_lines: [{ description: 'Reiskosten woon/werk', amount: 90.0, category: 'reimbursement' }],
    printed_table_tax: 152.37,
    reported_total_net: 686.09, // "Totaal netto" - BEFORE the 90.00 reiskosten addition
    reported_net_paid: 776.09, // "Totaal" - AFTER it
  });
  const period = mapExtractionToPeriod(extraction, null);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  // Confirms the test actually exercises the bug: wage_net (before additions) and period_net (after)
  // must genuinely differ by the reimbursement amount, or this test would pass either way.
  assert.notEqual(outcome.result.wage_net, outcome.result.period_net);
  assert.ok(Math.abs(outcome.result.period_net - outcome.result.wage_net - 90) < 0.01);
  assert.equal(resolveNetReconciliationBasis(outcome, period.printed_net, tableTaxToleranceFor(period.period_type)), 'wage_net');

  const discrepancies = comparePeriodToDocument(period, outcome);
  assert.ok(!discrepancies.some((d) => d.code === 'net_mismatch'), `expected no net_mismatch on a correct read, got ${JSON.stringify(discrepancies)}`);
});

