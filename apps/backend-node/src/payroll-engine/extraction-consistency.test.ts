import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkExtractionConsistency, buildExtractionTrace } from './extraction-consistency.js';
import { known, type PayslipPeriod, type PayslipComputationOutcome, type PayslipComputationResult } from './payslip-model.js';

/**
 * Stage 2b (audit "CONSOLIDATED ASSIGNMENT" v12): tests for the pre-comparison consistency gate.
 * Numbers below reproduce the auditor's own disclosed Stage 2a report on the real Olympia payslip
 * (both the app's actual wrong output and the document's real figures are already published in that
 * report, not fresh PII) - the exact run that motivated this gate, so this locks in that the gate
 * actually catches it rather than testing an invented scenario.
 */

function minimalPeriod(overrides: Partial<PayslipPeriod>): PayslipPeriod {
  return {
    period_label: null,
    period_type: 'week',
    period_end_date: null,
    is_correction: false,
    version: 1,
    employers: [{ name: null, franchise_bearing: 'unknown' }],
    hirer: null,
    contract_hours: null,
    hour_lines: [],
    pre_tax_deductions: [],
    bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
    et: null,
    post_tax_social: [],
    net_additions: [],
    net_deductions: [],
    payout_adjustments: [],
    reservations: [],
    wml_printed: null,
    wml_applicable: null,
    printed_table_tax: null,
    printed_bt_tax: null,
    printed_algemene_heffingskorting: null,
    printed_arbeidskorting: null,
    printed_net: null,
    printed_payout: null,
    printed_gross_total: null,
    printed_loon_voor_heffingen: null,
    printed_table_tax_label: null,
    printed_bt_tax_label: null,
    printed_algemene_heffingskorting_label: null,
    printed_arbeidskorting_label: null,
    printed_net_label: null,
    printed_payout_label: null,
    ...overrides,
  };
}

function completeOutcome(overrides: Partial<PayslipComputationResult>): PayslipComputationOutcome {
  return {
    status: 'complete',
    result: {
      gross_total: 0, hours_worked: 0, pre_tax_deductions_total: 0, loon_voor_heffingen: 0,
      taxable_base: 0, table_tax: 0, table_tax_after_korting: 0, bt_tax: 0,
      algemene_heffingskorting: 0, arbeidskorting: 0, total_tax: 0, post_tax_social_total: 0,
      wage_net: 0, net_additions_total: 0, net_deductions_total: 0, period_net: 0,
      payout_adjustments_total: 0, payout_amount: 0,
      ...overrides,
    },
  };
}

test('2b: zero computed tax on a real taxable base, against a nonzero printed reference, is flagged', () => {
  const period = minimalPeriod({ printed_table_tax: 152.37 });
  const outcome = completeOutcome({ taxable_base: 844.92, table_tax_after_korting: 0 });
  const issues = checkExtractionConsistency(null, period, outcome);
  assert.ok(issues.some((i) => i.code === 'zero_tax_nonzero_base'));
});

test('2b: zero computed tax is NOT flagged when the document itself prints no tax reference (nothing to conflict with)', () => {
  const period = minimalPeriod({ printed_table_tax: null });
  const outcome = completeOutcome({ taxable_base: 844.92, table_tax_after_korting: 0 });
  const issues = checkExtractionConsistency(null, period, outcome);
  assert.ok(!issues.some((i) => i.code === 'zero_tax_nonzero_base'));
});

test('2b: a genuinely tiny taxable base with zero tax is not flagged - not every zero is the failure', () => {
  const period = minimalPeriod({ printed_table_tax: 0.5 });
  const outcome = completeOutcome({ taxable_base: 2, table_tax_after_korting: 0 });
  const issues = checkExtractionConsistency(null, period, outcome);
  assert.ok(!issues.some((i) => i.code === 'zero_tax_nonzero_base'));
});

test('2b: payment date and period end date disagreeing on year is flagged (Olympia: 2026 payment, 2025-read period end)', () => {
  const period = minimalPeriod({ period_end_date: '2025-09-08' });
  const outcome = completeOutcome({});
  const issues = checkExtractionConsistency('2026-09-08', period, outcome);
  const issue = issues.find((i) => i.code === 'period_year_mismatch');
  assert.ok(issue);
});

test('2b: matching years are not flagged', () => {
  const period = minimalPeriod({ period_end_date: '2026-09-08' });
  const outcome = completeOutcome({});
  const issues = checkExtractionConsistency('2026-09-08', period, outcome);
  assert.ok(!issues.some((i) => i.code === 'period_year_mismatch'));
});

test('2b: a printed date range spanning six weeks on a period labelled "week" is flagged (the actual Olympia misread)', () => {
  const period = minimalPeriod({ period_label: '26-07-2025 t/m 08-09-2025', period_type: 'week' });
  const outcome = completeOutcome({});
  const issues = checkExtractionConsistency(null, period, outcome);
  const issue = issues.find((i) => i.code === 'period_length_mismatch');
  assert.ok(issue);
  if (issue?.code === 'period_length_mismatch') assert.equal(issue.implied_days, 45);
});

test('2b: a genuine one-week date range on a period labelled "week" is not flagged', () => {
  const period = minimalPeriod({ period_label: '01-09-2026 t/m 07-09-2026', period_type: 'week' });
  const outcome = completeOutcome({});
  const issues = checkExtractionConsistency(null, period, outcome);
  assert.ok(!issues.some((i) => i.code === 'period_length_mismatch'));
});

test('2b: a label with no parseable date range is never flagged - nothing to check, not an inferred failure', () => {
  const period = minimalPeriod({ period_label: 'week 36/2026', period_type: 'week' });
  const outcome = completeOutcome({});
  const issues = checkExtractionConsistency(null, period, outcome);
  assert.ok(!issues.some((i) => i.code === 'period_length_mismatch'));
});

test('2b: a StiPP/pension line filed under "other" is flagged as miscategorized (the actual Olympia miss)', () => {
  const period = minimalPeriod({
    pre_tax_deductions: [{ category: 'other', description: 'A29 werknemer', amount: known(34.79, 'payslip_extracted'), base: null, percent: null }],
  });
  const outcome = completeOutcome({});
  // description alone ("A29 werknemer") does not match any keyword - this proves the check does NOT
  // invent a match from a garbled label; it only fires when the label itself names a known category.
  assert.ok(!checkExtractionConsistency(null, period, outcome).some((i) => i.code === 'deduction_miscategorized'));

  const correctlyLabelled = minimalPeriod({
    pre_tax_deductions: [{ category: 'other', description: 'StiPP pensioenpremie', amount: known(34.79, 'payslip_extracted'), base: null, percent: null }],
  });
  const issues = checkExtractionConsistency(null, correctlyLabelled, outcome);
  const issue = issues.find((i) => i.code === 'deduction_miscategorized');
  assert.ok(issue);
  if (issue?.code === 'deduction_miscategorized') assert.equal(issue.suggested_category, 'pension');
});

test('2d.3: "AZW werknemer" (read correctly, not garbled) filed under "other" is flagged - the exact v19 retest scenario', () => {
  // Distinct from the "A29 werknemer" test above: this is the case where the DESCRIPTION was read
  // correctly and the CATEGORY assignment is what's wrong - the keyword backstop's job. The garbled-
  // description case (A29) is a different, structurally unfixable failure mode (see ocr-client.test.ts
  // and payslip-analysis-payload.test.ts's KNOWN LIMITATION test) - conflating the two would hide
  // that this one IS supposed to be caught, and was.
  const period = minimalPeriod({
    pre_tax_deductions: [{ category: 'other', description: 'AZW werknemer', amount: known(4.90, 'payslip_extracted'), base: null, percent: null }],
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  const issue = issues.find((i) => i.code === 'deduction_miscategorized');
  assert.ok(issue, 'expected "AZW werknemer" in category "other" to be caught by the ziektewet keyword backstop');
  if (issue?.code === 'deduction_miscategorized') assert.equal(issue.suggested_category, 'ziektewet');
});

test('2b: a correctly-categorized pension line is never flagged', () => {
  const period = minimalPeriod({
    pre_tax_deductions: [{ category: 'pension', description: 'StiPP pensioenpremie', amount: known(34.79, 'payslip_extracted'), base: null, percent: null }],
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'deduction_miscategorized'));
});

test('2b: a WHK line filed under "other" post-tax is flagged', () => {
  const period = minimalPeriod({
    post_tax_social: [{ category: 'other', description: 'WHK werknemer', amount: known(6.46, 'payslip_extracted'), percent: null }],
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  const issue = issues.find((i) => i.code === 'deduction_miscategorized' && i.placement === 'post_tax');
  assert.ok(issue);
});

test('2b: the document\'s own totals not reconciling is flagged - reproduces the actual Olympia run (2 of 4 deductions captured, wrong net)', () => {
  // Real figures from the disclosed Stage 2a report: gross 885.50, AZW 4.90 + StiPP 34.79 captured
  // (PAWW 0.89 and WHK 6.46 both missing), printed_table_tax correctly read as 152.37, but the
  // extracted "net" (776.09) was actually the document's final Totaal, not its Totaal netto (686.09).
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'test', hours: null, rate: null, percent: null, amount: 885.50, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [
      { category: 'other', description: 'A29 werknemer', amount: known(4.90, 'payslip_extracted'), base: null, percent: null },
      { category: 'other', description: 'A29 werknemer', amount: known(34.79, 'payslip_extracted'), base: null, percent: null },
    ],
    printed_table_tax: 152.37,
    printed_net: 776.09,
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  const issue = issues.find((i) => i.code === 'totals_do_not_reconcile_net');
  assert.ok(issue, 'expected the arithmetic mismatch to be caught with nothing but the extracted figures');
  if (issue?.code === 'totals_do_not_reconcile_net') {
    assert.equal(issue.implied_net, 693.44); // 885.50 - 4.90 - 34.79 - 152.37
    assert.ok(Math.abs(issue.residual) > 80, `expected a large residual, got ${issue.residual}`);
  }
});

test('2b: correctly-extracted totals (all four real deductions, correct net) reconcile cleanly', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'test', hours: null, rate: null, percent: null, amount: 885.50, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [
      { category: 'ziektewet', description: 'AZW werknemer', amount: known(4.90, 'payslip_extracted'), base: null, percent: null },
      { category: 'pension', description: 'StiPP pensioenpremie', amount: known(34.79, 'payslip_extracted'), base: null, percent: null },
      { category: 'paww', description: 'PAWW werknemer', amount: known(0.89, 'payslip_extracted'), base: null, percent: null },
    ],
    post_tax_social: [{ category: 'whk', description: 'WHK werknemer', amount: known(6.46, 'payslip_extracted'), percent: null }],
    printed_table_tax: 152.37,
    printed_net: 686.09, // the document's real Totaal netto: 885.50 - 4.90 - 34.79 - 0.89 - 152.37 - 6.46
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'totals_do_not_reconcile_net'), JSON.stringify(issues));
});

test('2b: Totaal netto -> Totaal not reconciling is flagged when travel reimbursement is missing from net_additions', () => {
  const period = minimalPeriod({
    printed_net: 686.09,
    printed_payout: 776.09, // the real Totaal, 90.00 higher - but net_additions is empty (travel not extracted)
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  const issue = issues.find((i) => i.code === 'totals_do_not_reconcile_payout');
  assert.ok(issue);
  if (issue?.code === 'totals_do_not_reconcile_payout') assert.equal(issue.residual, -90);
});

test('2b: Totaal netto -> Totaal reconciles once the travel reimbursement is captured as a net addition', () => {
  const period = minimalPeriod({
    printed_net: 686.09,
    printed_payout: 776.09,
    net_additions: [{ category: 'reimbursement', description: 'Reiskosten', amount: 90 }],
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'totals_do_not_reconcile_payout'));
});

test('2b: an unknown (not-yet-provided) deduction amount skips the net-reconciliation check rather than treating it as zero', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'test', hours: null, rate: null, percent: null, amount: 885.50, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'pension', description: 'StiPP', amount: { provenance: 'unknown', value: null }, base: null, percent: null }],
    printed_table_tax: 152.37,
    printed_net: 686.09,
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'totals_do_not_reconcile_net'));
});

test('2b: a fully clean, correctly-extracted period produces no issues at all', () => {
  const period = minimalPeriod({
    period_label: 'week 36/2026',
    period_type: 'week',
    // v24 (§2e.6): must be a date actually inside ISO week 36/2026 (Sep 1-7) now that
    // period_week_mismatch checks the label against this date - Sep 6 is the real Olympia document's
    // own confirmed period_end_date (tier-c.test.ts), reused here rather than an arbitrary date that
    // happened to never be checked before.
    period_end_date: '2026-09-06',
    hour_lines: [{ employer_index: 0, description: 'test', hours: null, rate: null, percent: null, amount: 885.50, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [
      { category: 'ziektewet', description: 'AZW werknemer', amount: known(4.90, 'payslip_extracted'), base: null, percent: null },
      { category: 'pension', description: 'StiPP pensioenpremie', amount: known(34.79, 'payslip_extracted'), base: null, percent: null },
      { category: 'paww', description: 'PAWW werknemer', amount: known(0.89, 'payslip_extracted'), base: null, percent: null },
    ],
    post_tax_social: [{ category: 'whk', description: 'WHK werknemer', amount: known(6.46, 'payslip_extracted'), percent: null }],
    printed_table_tax: 152.37,
    printed_net: 686.09,
    printed_payout: 776.09,
    net_additions: [{ category: 'reimbursement', description: 'Reiskosten', amount: 90 }],
  });
  const outcome = completeOutcome({ taxable_base: 844.92, table_tax_after_korting: 152.37 });
  const issues = checkExtractionConsistency('2026-09-06', period, outcome);
  assert.deepEqual(issues, [], JSON.stringify(issues));
});

test('2e.6: a week-number label disagreeing with the period end date\'s own ISO week is flagged', () => {
  const period = minimalPeriod({ period_label: 'week 36/2026', period_type: 'week', period_end_date: '2026-09-13' }); // ISO week 37, not 36
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  const issue = issues.find((i) => i.code === 'period_week_mismatch');
  assert.ok(issue, 'expected the label\'s week 36 to be checked against period_end_date\'s actual ISO week (37) and flagged');
  if (issue?.code === 'period_week_mismatch') {
    assert.equal(issue.label_week, 36);
    assert.equal(issue.end_date_week, 37);
  }
});

test('2e.6: a week-number label agreeing with the period end date\'s own ISO week is not flagged', () => {
  const period = minimalPeriod({ period_label: 'week 36/2026', period_type: 'week', period_end_date: '2026-09-06' });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'period_week_mismatch'));
});

test('2e.6: a year-first label shape ("week 2026-11") is never parsed as week/year - not confirmed against a real document, stays unflagged rather than guessed', () => {
  const period = minimalPeriod({ period_label: 'week 2026-11', period_type: 'week', period_end_date: '2026-04-30' });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'period_week_mismatch'));
});

/**
 * Stage 2d (v19, §2d.1): buildExtractionTrace supplies the blocking panel's "what we read" section -
 * the full chain, independent of which specific check fired. Tested separately from
 * checkExtractionConsistency's own tests because the panel needs this even for issues (like
 * period_length_mismatch) that have nothing to do with the gross-to-net arithmetic at all.
 */
test('2d.1: buildExtractionTrace reproduces the real Olympia chain end to end (all four deductions correctly read)', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 885.50, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    pre_tax_deductions: [
      { category: 'ziektewet', description: 'AZW werknemer', amount: known(4.90, 'payslip_extracted'), base: null, percent: null },
      { category: 'pension', description: 'STiPP-pensioen werknemer', amount: known(34.79, 'payslip_extracted'), base: null, percent: null },
      { category: 'paww', description: 'Bijdrage PAWW werknemer', amount: known(0.89, 'payslip_extracted'), base: null, percent: null },
    ],
    post_tax_social: [{ category: 'whk', description: 'WHK werknemer', amount: known(6.46, 'payslip_extracted'), percent: null }],
    printed_table_tax: 152.37,
    printed_net: 686.09,
    printed_payout: 776.09,
    net_additions: [{ category: 'reimbursement', description: 'Onb.Reiskosten woon/werk', amount: 90 }],
  });
  const outcome = completeOutcome({ taxable_base: 844.92, table_tax_after_korting: 152.37 });
  const trace = buildExtractionTrace(period, outcome);

  assert.equal(trace.gross_total, 885.50);
  assert.equal(trace.pre_tax_deductions_sum, 40.58); // 4.90 + 34.79 + 0.89
  assert.equal(trace.loon_voor_heffingen, 844.92); // matches the real printed "loon voor heffingen"
  assert.equal(trace.post_tax_deductions_sum, 6.46);
  assert.equal(trace.implied_net, 686.09); // 885.50 - 40.58 - 152.37 - 6.46, matches the real "Totaal netto"
  assert.equal(trace.implied_payout, 776.09); // 686.09 + 90.00, matches the real "Totaal"
  assert.equal(trace.hour_lines.length, 1);
  assert.equal(trace.pre_tax_deductions.length, 3);
  assert.equal(trace.pre_tax_deductions[0]?.category, 'ziektewet');
  assert.equal(trace.pre_tax_deductions[0]?.label, 'AZW werknemer');
});

test('2d.1: buildExtractionTrace reports an unknown deduction as null, never coerced to zero (§2.1), and the chain built on top of it is also null, not a wrong number', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'test', hours: null, rate: null, percent: null, amount: 885.50, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'pension', description: 'StiPP', amount: { provenance: 'unknown', value: null }, base: null, percent: null }],
  });
  const outcome = completeOutcome({});
  const trace = buildExtractionTrace(period, outcome);

  assert.equal(trace.pre_tax_deductions[0]?.amount, null);
  assert.equal(trace.pre_tax_deductions_sum, null);
  assert.equal(trace.loon_voor_heffingen, null); // depends on pre_tax_deductions_sum - must not silently become gross_total - 0
  assert.equal(trace.implied_net, null); // depends on the same unknown sum
});
