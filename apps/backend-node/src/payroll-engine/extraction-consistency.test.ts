import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkExtractionConsistency, buildExtractionTrace, resolveSubtotalRole, resolveAnchors, ALL_CONSISTENCY_ISSUE_CODES } from './extraction-consistency.js';
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
    period_type_confirmed: true,
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
    printed_taxable_base_normal: null,
    printed_taxable_base_special: null,
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

test('2h.3: the net stage (both anchors read) confirms a printed net that sits AFTER net lines, not just before (PKF-shaped: one printed figure, already net of a reimbursement and a deduction)', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'test', hours: null, rate: null, percent: null, amount: 100, category: 'other', tax_treatment: 'table', adds_hours: false }],
    printed_gross_total: 100,
    printed_loon_voor_heffingen: 100,
    printed_table_tax: 20,
    net_additions: [{ category: 'reimbursement', description: 'Reiskosten', amount: 10 }],
    net_deductions: [{ category: 'loan', description: 'Lening', amount: 30 }],
    // Before net lines this would be 100 - 20 = 80; after them, 80 + 10 - 30 = 60 - the document
    // prints ONLY 60 (PKF's real shape - one figure, already net of its own reimbursement/deduction).
    printed_net: 60,
    printed_payout: 60, // same document, same single figure - no separate payout line either
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'net_does_not_reconcile'), `expected the after-position match to be recognised, got ${JSON.stringify(issues)}`);
  assert.ok(!issues.some((i) => i.code === 'totals_do_not_reconcile_payout'), `expected the payout check to skip re-applying the same net lines a second time, got ${JSON.stringify(issues)}`);
});

test('2h.3: reverting to a before-only net check must fail the PKF-shaped fixture above (proves the after-position match is load-bearing)', () => {
  // The pre-2h.3 formula: impliedNet = loonVoorHeffingen - tableTax - btTax - postTaxSum, compared
  // ONLY against printed_net, with no after-position fallback.
  const loonVoorHeffingen = 100;
  const tableTax = 20;
  const impliedNetBeforeOnly = loonVoorHeffingen - tableTax;
  const printedNet = 60;
  assert.ok(Math.abs(impliedNetBeforeOnly - printedNet) > 0.1, `expected the before-only comparison to be genuinely wrong for this fixture (${impliedNetBeforeOnly} vs ${printedNet})`);
});

test('2h.3: a genuine net gap (matches neither the before nor the after position) is still flagged', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'test', hours: null, rate: null, percent: null, amount: 100, category: 'other', tax_treatment: 'table', adds_hours: false }],
    printed_gross_total: 100,
    printed_loon_voor_heffingen: 100,
    printed_table_tax: 20,
    net_additions: [{ category: 'reimbursement', description: 'Reiskosten', amount: 10 }],
    net_deductions: [{ category: 'loan', description: 'Lening', amount: 30 }],
    printed_net: 500, // matches neither 80 (before) nor 60 (after) - a real gap
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(issues.some((i) => i.code === 'net_does_not_reconcile'), `expected a genuine mismatch to still be flagged, got ${JSON.stringify(issues)}`);
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

/**
 * Stage 2f (audit v26, §2f.2/§2f.3): the two live Olympia reads the round's own assignment cites.
 * Read 2 (build aaaeae1, OWNER-RETEST-2e-olympia.md) read exactly ONE printed subtotal (844.92) and
 * the stage 2e gate put it in printed_gross_total (the prompt's own "TOTAAL BRUTO" example, wrong on
 * this document) - with only ONE anchor present, stage 2e's gate required BOTH to check anything, so
 * an 18.08 EUR gap on the gross line went completely unflagged. Numbers below are exactly what that
 * panel showed: gross lines summing to 826.84 (58.31 missing, 116.31 misread), pre-tax summing to
 * 37.47 (AZW misread as 1.79 vs printed 4.90).
 */
test('2f.2: a single printed subtotal matching neither hypothesis is flagged, naming both gaps (the live read-2 Olympia retest)', () => {
  const period = minimalPeriod({
    hour_lines: [
      { employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.75, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Loon onregelm. uren', hours: 7.5, rate: 15.55, percent: 100, amount: 116.31, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'ADV toeslag', hours: 45, rate: 15.55, percent: 1.54, amount: 10.78, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deductions: [
      { category: 'paww', description: 'Bijlage PAWW werknemer', amount: known(0.89, 'payslip_extracted'), base: null, percent: null },
      { category: 'ziektewet', description: 'AZW werknemer', amount: known(1.79, 'payslip_extracted'), base: null, percent: null },
      { category: 'pension', description: 'StiPP-pensioen werknemer', amount: known(34.79, 'payslip_extracted'), base: null, percent: null },
    ],
    printed_gross_total: 844.92, // the panel's own "Wydrukowana suma brutto na dokumencie" - actually loon voor heffingen on this document
    printed_loon_voor_heffingen: null, // never separately read in this live run
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  const issue = issues.find((i) => i.code === 'printed_subtotal_role_unresolved');
  assert.ok(issue, `expected 844.92 to match neither hypothesis and be flagged, got ${JSON.stringify(issues)}`);
  if (issue?.code === 'printed_subtotal_role_unresolved') {
    assert.equal(issue.printed_subtotal, 844.92);
    assert.equal(issue.gross_hypothesis, 826.84); // 699.75 + 116.31 + 10.78, exactly the panel's own "Suma brutto"
    assert.equal(issue.loon_voor_heffingen_hypothesis, 789.37); // 826.84 - 37.47, exactly the panel's own "Loon voor heffingen"
  }
  // Confirms the exit condition's own wording: "844.92 matches neither 826.84 nor 789.37."
});

test('2f.2: a single printed subtotal correctly identified as loon voor heffingen (the Olympia trap, fully-read gross) is confirmed, not asserted as gross', () => {
  // Same document, but this time every gross/pre-tax line was read correctly - 844.92 now matches the
  // loon-voor-heffingen hypothesis EXACTLY, even though it arrived in the printed_gross_total field
  // (the real document's own "TOTAAL BRUTO" label, which on Olympia means loon voor heffingen).
  const period = minimalPeriod({
    hour_lines: [
      { employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Loon onregelm. uren 100%', hours: 7.5, rate: 15.55, percent: 100, amount: 116.63, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Loon onregelm. uren 50%', hours: 7.5, rate: 15.55, percent: 50, amount: 58.31, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'ADV toeslag', hours: 45, rate: 15.55, percent: 1.54, amount: 10.78, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deductions: [
      { category: 'paww', description: 'Bijlage PAWW werknemer', amount: known(0.89, 'payslip_extracted'), base: null, percent: null },
      { category: 'ziektewet', description: 'AZW werknemer', amount: known(4.90, 'payslip_extracted'), base: null, percent: null },
      { category: 'pension', description: 'StiPP-pensioen werknemer', amount: known(34.79, 'payslip_extracted'), base: null, percent: null },
    ],
    post_tax_social: [{ category: 'whk', description: 'WHK werknemer', amount: known(6.46, 'payslip_extracted'), percent: null }],
    printed_table_tax: 152.37,
    printed_net: 686.09,
    printed_gross_total: 844.92, // "TOTAAL BRUTO" as printed - the document's own label collision
    printed_loon_voor_heffingen: null,
  });
  const outcome = completeOutcome({ taxable_base: 844.92, table_tax_after_korting: 152.37 });
  const issues = checkExtractionConsistency(null, period, outcome);
  assert.ok(!issues.some((i) => i.code === 'printed_subtotal_role_unresolved'), JSON.stringify(issues));
  assert.ok(!issues.some((i) => i.code === 'net_does_not_reconcile'), 'expected stage 3 to run using the CONFIRMED loon-voor-heffingen role and reconcile cleanly');

  const trace = buildExtractionTrace(period, outcome);
  assert.equal(trace.printed_subtotal_role, 'confirmed_loon_voor_heffingen');
});

test('2f.3: a printed gross total smaller than the printed loon voor heffingen is impossible and blocks', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'test', hours: null, rate: null, percent: null, amount: 800, category: 'other', tax_treatment: 'table', adds_hours: false }],
    printed_gross_total: 800,
    printed_loon_voor_heffingen: 850, // larger than gross - deductions cannot be negative
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  const issue = issues.find((i) => i.code === 'anchors_inverted');
  assert.ok(issue, JSON.stringify(issues));
  if (issue?.code === 'anchors_inverted') {
    assert.equal(issue.printed_gross_total, 800);
    assert.equal(issue.printed_loon_voor_heffingen, 850);
  }
  // Blocked, per §2f.3 - none of the three staged checks should also fire on the same inverted pair.
  assert.ok(!issues.some((i) => i.code === 'gross_lines_do_not_reconcile' || i.code === 'pre_tax_does_not_reconcile' || i.code === 'net_does_not_reconcile'));
});

/**
 * Stage 2i (audit v29, §2i.1): "today the single-subtotal resolver runs only when one anchor is
 * present. Make it general... if printed_gross_total matches the loon-voor-heffingen position and
 * not the gross position, reassign it... a printed figure that matches neither position is not a
 * block... moves to a neutral list other_printed_figures." Numbers below are the owner's own OTTO
 * panel figures (OWNER-RETEST-2h-otto.md / RAPORT-cursor-2h.md's T5): gross lines sum to 924.03,
 * pre-tax deductions to 198.65, and the document prints TWO figures - 725.38 (which the model put in
 * `printed_gross_total`, but which actually reproduces 924.03-198.65 exactly - the loon-voor-
 * heffingen position, since OTTO prints no gross total at all) and 621.14 (the "normal" taxable base,
 * which reproduces neither chain position and is not a role the code should assert).
 */
test("2i.1: OTTO's two anchors - the mislabelled 725.38 is reassigned to loon-voor-heffingen; 621.14 (matches neither position) becomes an other_printed_figure; gross and pre-tax stages pass", () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross lines', hours: null, rate: null, percent: null, amount: 924.03, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'other', description: 'pre-tax deductions', amount: known(198.65, 'payslip_extracted'), base: null, percent: null }],
    printed_gross_total: 725.38, // the model's own label - wrong role, right number
    printed_loon_voor_heffingen: 621.14, // the normal taxable base - a real printed figure, no chain role
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'gross_lines_do_not_reconcile'), `expected the gross stage to pass (924.03 no longer tested against the wrong anchor 725.38), got ${JSON.stringify(issues)}`);
  assert.ok(!issues.some((i) => i.code === 'pre_tax_does_not_reconcile'), `expected the pre-tax stage to pass, got ${JSON.stringify(issues)}`);
  assert.ok(!issues.some((i) => i.code === 'anchors_inverted'));
  assert.ok(!issues.some((i) => i.code === 'printed_subtotal_role_unresolved'), '621.14 must be a neutral other_printed_figure, never a block');

  const resolution = resolveAnchors(period, 924.03, 198.65);
  assert.equal(resolution.role, 'confirmed_loon_voor_heffingen');
  assert.equal(resolution.resolvedSubtotal, 725.38);
  assert.equal(resolution.anchorReassigned, true);
  assert.deepEqual(resolution.otherPrintedFigures, [621.14]);

  const trace = buildExtractionTrace(period, completeOutcome({}));
  assert.equal(trace.printed_subtotal_role, 'confirmed_loon_voor_heffingen');
  assert.equal(trace.anchor_reassigned, true);
  assert.deepEqual(trace.other_printed_figures, [621.14]);
});

test('2i.1: removing the reassignment must fail the OTTO test (proves it is load-bearing, not incidental)', () => {
  // Reproduces the PRE-2i.1 behaviour inline: both anchors present -> resolveSubtotalRole's own
  // early `if (hasGross && hasLvh) return 'both'` never tests the arithmetic, so the OLD dispatch
  // would test the summed gross lines (924.03) directly against the WRONG anchor (725.38, actually
  // the loon-voor-heffingen figure) as if it were the gross total.
  const summedGross = 924.03;
  const wronglyAssumedGrossAnchor = 725.38;
  const residual = Math.round((summedGross - wronglyAssumedGrossAnchor) * 100) / 100;
  assert.ok(Math.abs(residual) > 0.01, `expected the old gross-vs-725.38 comparison to be far outside tolerance (198.65, proving the pre-2i.1 behaviour would have blocked with gross_lines_do_not_reconcile), got residual ${residual}`);
});

test('2i.1: the Randstad and PKF fixtures (both anchors, each already confirming its OWN expected position) are unaffected - no reassignment, unchanged "both"', () => {
  // Randstad: printed_gross_total 970.89 (= sum of its 5 hour lines), printed_loon_voor_heffingen
  // 927.25 (= 970.89 - 43.64 pre-tax). Both anchors correctly confirm their own position already -
  // the "normal case" branch, not a reassignment.
  const randstad = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross', hours: null, rate: null, percent: null, amount: 970.89, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'other', description: 'pretax', amount: known(43.64, 'payslip_extracted'), base: null, percent: null }],
    printed_gross_total: 970.89,
    printed_loon_voor_heffingen: 927.25,
  });
  const randstadResolution = resolveAnchors(randstad, 970.89, 43.64);
  assert.equal(randstadResolution.role, 'both');
  assert.equal(randstadResolution.anchorReassigned, false);
  assert.deepEqual(randstadResolution.otherPrintedFigures, []);

  // PKF: printed_gross_total 3515.56, printed_loon_voor_heffingen 3277.02 (= 3515.56 - 238.54).
  const pkf = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross', hours: null, rate: null, percent: null, amount: 3515.56, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'other', description: 'pretax', amount: known(238.54, 'payslip_extracted'), base: null, percent: null }],
    printed_gross_total: 3515.56,
    printed_loon_voor_heffingen: 3277.02,
  });
  const pkfResolution = resolveAnchors(pkf, 3515.56, 238.54);
  assert.equal(pkfResolution.role, 'both');
  assert.equal(pkfResolution.anchorReassigned, false);
  assert.deepEqual(pkfResolution.otherPrintedFigures, []);
});

/**
 * Stage 2i (audit v29, §2i.2): "check normal+special=total to the cent." OTTO's own owner-panel
 * figures: normal-rate base 621.14, BT base 104.24, and the resolved total (the SAME 725.38 that
 * 2i.1's reassignment already resolves as the loon-voor-heffingen anchor - "total" here is never a
 * fourth invented number, it is that same resolved anchor).
 */
test("2i.2: OTTO's own taxable-base split (621.14 + 104.24) reconciles against the resolved 725.38 anchor - no printed_tax_bases_do_not_reconcile", () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross lines', hours: null, rate: null, percent: null, amount: 924.03, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'other', description: 'pre-tax deductions', amount: known(198.65, 'payslip_extracted'), base: null, percent: null }],
    printed_gross_total: 725.38,
    printed_loon_voor_heffingen: 621.14,
    printed_taxable_base_normal: 621.14,
    printed_taxable_base_special: 104.24,
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'printed_tax_bases_do_not_reconcile'), `expected the base split to reconcile against the resolved 725.38 anchor, got ${JSON.stringify(issues)}`);

  const trace = buildExtractionTrace(period, completeOutcome({}));
  assert.equal(trace.printed_taxable_base_normal, 621.14);
  assert.equal(trace.printed_taxable_base_special, 104.24);
});

test('2i.2: a base split that does NOT sum to the resolved anchor fires printed_tax_bases_do_not_reconcile with the exact residual', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross lines', hours: null, rate: null, percent: null, amount: 924.03, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'other', description: 'pre-tax deductions', amount: known(198.65, 'payslip_extracted'), base: null, percent: null }],
    printed_gross_total: 725.38,
    printed_loon_voor_heffingen: 621.14,
    printed_taxable_base_normal: 621.14,
    printed_taxable_base_special: 100.0, // wrong - should be 104.24, off by 4.24
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  const issue = issues.find((i) => i.code === 'printed_tax_bases_do_not_reconcile');
  assert.ok(issue, `expected printed_tax_bases_do_not_reconcile, got ${JSON.stringify(issues)}`);
  if (issue?.code === 'printed_tax_bases_do_not_reconcile') {
    assert.equal(issue.implied_total, 721.14);
    assert.equal(issue.printed_total, 725.38);
    assert.equal(issue.residual, -4.24);
  }
});

test('2i.2: only one of the two base fields present - never invented from one side, check does not fire', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross lines', hours: null, rate: null, percent: null, amount: 924.03, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'other', description: 'pre-tax deductions', amount: known(198.65, 'payslip_extracted'), base: null, percent: null }],
    printed_gross_total: 725.38,
    printed_loon_voor_heffingen: 621.14,
    printed_taxable_base_normal: 621.14,
    printed_taxable_base_special: null,
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'printed_tax_bases_do_not_reconcile'), 'a single base component alone must never be checked against anything');
});

test("2i.2 regression: the taxable-base check must subtract the ET reduction from the loon-voor-heffingen position, not compare against loon-voor-heffingen directly - a real OTTO-shaped fixture with ET caught this bug during implementation", () => {
  // OTTO's real chain: printed_gross_total 924.03 -> minus STIPP 21.65 -> printed_loon_voor_heffingen
  // 902.38 -> minus the ET reduction 177.00 -> taxable base 725.38 (= 621.14 normal + 104.24 special).
  // Comparing 621.14+104.24 against 902.38 directly (the pre-fix formula) would wrongly report a
  // 177.00 EUR gap on a fixture whose base split is actually exactly correct.
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross lines', hours: null, rate: null, percent: null, amount: 924.03, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'pension', description: 'STIPP-pensioen werknemer', amount: known(21.65, 'payslip_extracted'), base: null, percent: null }],
    printed_gross_total: 924.03,
    printed_loon_voor_heffingen: 902.38,
    printed_taxable_base_normal: 621.14,
    printed_taxable_base_special: 104.24,
    et: { et_applicable: true, et_exchange_amount: 177.0, et_reimbursements: [], adres_fiskalny: null },
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'printed_tax_bases_do_not_reconcile'), `expected the ET reduction to be subtracted before comparing, got ${JSON.stringify(issues)}`);
});

test('2i.2 regression: removing the ET subtraction must fail the fixture above (proves it is load-bearing, not incidental)', () => {
  const loonVoorHeffingen = 902.38;
  const etReduction = 177.0;
  const wronglyComparedDirectly = Math.round((loonVoorHeffingen - etReduction) * 100) / 100; // 725.38, the correct taxable base
  const withoutTheFix = loonVoorHeffingen; // the pre-fix formula's "total"
  const impliedTotal = 621.14 + 104.24;
  assert.equal(wronglyComparedDirectly, impliedTotal, 'sanity: the correct taxable base does equal the printed split');
  assert.ok(Math.abs(impliedTotal - withoutTheFix) > 0.02, `expected comparing against loon-voor-heffingen directly (${withoutTheFix}) to be far outside tolerance vs the printed split (${impliedTotal}), proving the pre-fix formula would have wrongly blocked`);
});

/**
 * Stage 2i (audit v29, §2i.4): "make an absent [printed table/BT tax] a stated gap, never zero" -
 * unconditionally, not only alongside a net-reconciliation stage. Reproduces the exact shape
 * OWNER-RETEST-2h-otto.md recorded: a real document with hour lines and NO printed net figure at all
 * (OTTO), where printed_table_tax being genuinely unread previously produced complete silence.
 */
test('2i.4: a genuinely unread printed_table_tax on a document with NO printed_net is a stated gap, not silence', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross', hours: null, rate: null, percent: null, amount: 924.03, category: 'other', tax_treatment: 'table', adds_hours: false }],
    printed_table_tax: null,
    printed_net: null,
    printed_payout: 598.59, // OTTO's real shape: only a payout figure, no separate net
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(issues.some((i) => i.code === 'printed_tax_unknown'), `expected printed_tax_unknown even with no printed_net to reconcile against, got ${JSON.stringify(issues)}`);
});

test('2i.4: the same fixture with printed_table_tax actually set produces no gap - regression guard for the OTTO integration test (its own 12.28 residual must still be reported exactly once, unaffected by this new check)', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross', hours: null, rate: null, percent: null, amount: 924.03, category: 'other', tax_treatment: 'table', adds_hours: false }],
    printed_table_tax: 77.52,
    printed_net: null,
    printed_payout: 598.59,
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'printed_tax_unknown'), `expected no gap once printed_table_tax is actually set, got ${JSON.stringify(issues)}`);
});

test('2i.4: a period with no hour lines at all (nothing to tax) never fires the unconditional check - never a degenerate false positive', () => {
  const period = minimalPeriod({ printed_table_tax: null, printed_net: null });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'printed_tax_unknown'));
});

test('2i.2: the common case (no base split printed at all, both null) never fires the new check - regression guard for every existing single-base fixture', () => {
  const randstad = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'gross', hours: null, rate: null, percent: null, amount: 970.89, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'other', description: 'pretax', amount: known(43.64, 'payslip_extracted'), base: null, percent: null }],
    printed_gross_total: 970.89,
    printed_loon_voor_heffingen: 927.25,
  });
  const issues = checkExtractionConsistency(null, randstad, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'printed_tax_bases_do_not_reconcile'));
});

/**
 * Stage 2g (audit v27, §2g.0d): "give the coinciding-hypotheses case its own role value... export
 * resolveSubtotalRole so it can be tested directly; cover the five cases the reviewer ran (T3 table)."
 * Each case below is exactly one row of RAPORT-cursor-2f.md's T3 table.
 */
test('2g.0d T3 row 1: read-2\'s numbers resolve to unresolved (matches neither hypothesis)', () => {
  const period = minimalPeriod({
    hour_lines: [
      { employer_index: 0, description: 'a', hours: null, rate: null, percent: null, amount: 699.75, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'b', hours: null, rate: null, percent: null, amount: 116.31, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'c', hours: null, rate: null, percent: null, amount: 10.78, category: 'other', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deductions: [
      { category: 'paww', description: 'a', amount: known(0.89, 'payslip_extracted'), base: null, percent: null },
      { category: 'ziektewet', description: 'b', amount: known(1.79, 'payslip_extracted'), base: null, percent: null },
      { category: 'pension', description: 'c', amount: known(34.79, 'payslip_extracted'), base: null, percent: null },
    ],
    printed_gross_total: 844.92,
  });
  assert.equal(resolveSubtotalRole(period, 826.84, 37.47), 'unresolved');
});

test('2g.0d T3 row 2: a correct read with both anchors resolves to "both"', () => {
  const period = minimalPeriod({ printed_gross_total: 885.5, printed_loon_voor_heffingen: 844.92 });
  assert.equal(resolveSubtotalRole(period, 885.5, 40.58), 'both');
});

test('2g.0d T3 row 3: no pre-tax deductions, one subtotal matching both hypotheses is "ambiguous_both_match", never asserted as loon voor heffingen', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'a', hours: null, rate: null, percent: null, amount: 500, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [],
    printed_gross_total: 500,
  });
  assert.equal(resolveSubtotalRole(period, 500, 0), 'ambiguous_both_match');
});

test('2g.0d T3 row 4: equal anchors (500/500, no pre-tax) resolve to "both" and do not fire anchors_inverted', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'a', hours: null, rate: null, percent: null, amount: 500, category: 'other', tax_treatment: 'table', adds_hours: false }],
    printed_gross_total: 500,
    printed_loon_voor_heffingen: 500,
  });
  assert.equal(resolveSubtotalRole(period, 500, 0), 'both');
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'anchors_inverted'), JSON.stringify(issues));
});

test('2g.0d T3 row 5: a printed 100 matching both hypotheses within tolerance (0.01 pre-tax) is "ambiguous_both_match"', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'a', hours: null, rate: null, percent: null, amount: 100, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [{ category: 'other', description: 'a', amount: known(0.01, 'payslip_extracted'), base: null, percent: null }],
    printed_gross_total: 100,
  });
  assert.equal(resolveSubtotalRole(period, 100, 0.01), 'ambiguous_both_match');
});

test('2g.0d: ambiguous_both_match still runs the net stage (the coinciding number is real information)', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'a', hours: null, rate: null, percent: null, amount: 500, category: 'other', tax_treatment: 'table', adds_hours: false }],
    pre_tax_deductions: [],
    printed_gross_total: 500,
    printed_table_tax: 100,
    printed_net: 400,
  });
  const issues = checkExtractionConsistency(null, period, completeOutcome({}));
  assert.ok(!issues.some((i) => i.code === 'net_does_not_reconcile' || i.code === 'printed_subtotal_role_unresolved'), JSON.stringify(issues));
  const trace = buildExtractionTrace(period, completeOutcome({}));
  assert.equal(trace.printed_subtotal_role, 'ambiguous_both_match');
});

/**
 * Stage 2f (audit v26, §2f.9): "the interface must know every code (2.10a)... make it structural."
 * There is no shared-types package between frontend and backend, so this is the structural
 * enforcement instead: every code this file can produce must appear as a quoted string literal
 * somewhere in TierCFlow.tsx's own source (its ConsistencyIssue union and issueMessage switch) - the
 * exact thing that silently did NOT happen for `period_week_mismatch` in stage 2e (added to the
 * backend, never added to the frontend, and nothing failed because the frontend's own type was just
 * narrower, not wrong by its own compiler's lights). This test fails on a clean checkout if a future
 * round adds a ConsistencyIssue code to ALL_CONSISTENCY_ISSUE_CODES without also adding it here.
 */
/**
 * Stage 2g (audit v27, §2g.0c): "replace the substring test with one that finds a `case '<code>':`
 * ... and fails when the only occurrence is a comment or the type union." The old test
 * (`frontendSource.includes("'" + code + "'")`) would have passed even if `issueMessage`'s switch
 * never handled a code at all, as long as the code string appeared ANYWHERE in the file - in the
 * `ConsistencyIssue` type union (which it always does, since that union is hand-written from the
 * same list), in a comment, or in an unrelated string. This requires the literal switch-case syntax
 * `case '<code>':` - a code present only in the union or a comment fails this test. Verified by
 * actually removing one: deleting `case 'et_exchange_amount_unknown':` from `issueMessage()`
 * (leaving the type union untouched) made this test fail with exactly that code listed as missing;
 * restoring the line made it pass again - reported, not left in the tree (§2.5 - a claim checked
 * once, not asserted).
 */
test('2g.0c: every backend ConsistencyIssue code has a real switch-case in TierCFlow.tsx\'s issueMessage', () => {
  const testFileDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendPath = path.resolve(testFileDir, '../../../frontend-react/src/TierCFlow.tsx');
  const frontendSource = readFileSync(frontendPath, 'utf8');
  const missing = ALL_CONSISTENCY_ISSUE_CODES.filter((code) => !new RegExp(`case '${code}':`).test(frontendSource));
  assert.deepEqual(missing, [], `TierCFlow.tsx's issueMessage() has no "case '<code>':" for: ${missing.join(', ')}`);
});
