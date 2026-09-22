import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayslipAnalysisPayload } from './payslip-analysis-payload.js';
import { known, type PayslipPeriod, type PayslipComputationOutcome } from './payslip-model.js';

/**
 * Stage 2c (v15): the payslip -> analysis-model boundary. These tests exist to prove the boundary
 * actually holds, not just that the code compiles - a privacy boundary asserted without a test that
 * tries to break it is exactly the kind of claim this project's own standing rules (§2.2/§2.3) exist
 * to distrust.
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

const EMPTY_OUTCOME: PayslipComputationOutcome = {
  status: 'complete',
  result: {
    gross_total: 0, hours_worked: 0, pre_tax_deductions_total: 0, loon_voor_heffingen: 0,
    taxable_base: 0, table_tax: 0, table_tax_after_korting: 0, bt_tax: 0,
    algemene_heffingskorting: 0, arbeidskorting: 0, total_tax: 0, post_tax_social_total: 0,
    wage_net: 0, net_additions_total: 0, net_deductions_total: 0, period_net: 0,
    payout_adjustments_total: 0, payout_amount: 0,
  },
};

test('2c: a description matching a known PII pattern (IBAN) is stripped, independently of extraction-time filtering', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'Correctie NL91ABNA0417164300', hours: null, rate: null, percent: null, amount: 10, category: 'other', tax_treatment: 'table', adds_hours: false }],
  });
  const { payload, redactedFields } = buildPayslipAnalysisPayload(period, EMPTY_OUTCOME, []);
  assert.equal(payload.hour_lines.length, 1);
  assert.equal(payload.hour_lines[0]?.label, '');
  assert.deepEqual(redactedFields, ['hour_lines[0].description']);
});

test('2c: an ordinary payslip line description passes through unchanged', () => {
  const period = minimalPeriod({
    hour_lines: [{ employer_index: 0, description: 'Godziny przepracowane', hours: 40, rate: 15, percent: null, amount: 600, category: 'regular', tax_treatment: 'table', adds_hours: true }],
  });
  const { payload, redactedFields } = buildPayslipAnalysisPayload(period, EMPTY_OUTCOME, []);
  assert.equal(payload.hour_lines[0]?.label, 'Godziny przepracowane');
  assert.deepEqual(redactedFields, []);
});

test('2c: business employer/hirer names pass through - they are not the protected category', () => {
  const period = minimalPeriod({
    employers: [{ name: 'Olympia Services B.V.', franchise_bearing: true }],
    hirer: { name: 'DSV Solutions' },
  });
  const { payload } = buildPayslipAnalysisPayload(period, EMPTY_OUTCOME, []);
  assert.deepEqual(payload.employers, ['Olympia Services B.V.']);
  assert.equal(payload.hirer, 'DSV Solutions');
});

test('2c: an unknown (not-yet-provided) deduction amount is sent as null, never coerced to zero (§2.1)', () => {
  const period = minimalPeriod({
    pre_tax_deductions: [{ category: 'pension', description: 'StiPP', amount: { provenance: 'unknown', value: null }, base: null, percent: null }],
  });
  const { payload } = buildPayslipAnalysisPayload(period, EMPTY_OUTCOME, []);
  assert.equal(payload.pre_tax_deductions[0]?.amount, null);
  assert.equal(payload.pre_tax_deductions[0]?.provenance, 'unknown');
});

test('2c: the payload shape has no field capable of carrying a name, address, DOB, IBAN or employee number - by construction, not by convention', () => {
  const period = minimalPeriod({});
  const { payload } = buildPayslipAnalysisPayload(period, EMPTY_OUTCOME, []);
  const keys = Object.keys(payload);
  // The allowlist itself is the assertion: only these keys exist, and none of them is a plausible
  // home for personal identity - "employers"/"hirer" are business names, not the employee's own.
  assert.deepEqual(keys.sort(), [
    'discrepancies', 'employers', 'hirer', 'hour_lines', 'net_additions', 'net_deductions',
    'outcome', 'period_label', 'period_type', 'post_tax_social', 'pre_tax_deductions', 'reservations',
  ]);
});

test('2c: KNOWN LIMITATION - a bare name in a free-text description is not caught by the regex net (documented, not silently assumed safe)', () => {
  // Neither pii-patterns.ts's regex (BSN/IBAN/email/phone) nor this file's second pass can reliably
  // detect an arbitrary person's name - there is no general pattern for "a name". This test exists so
  // the gap is visible in the suite, not just in a comment: this line WOULD reach the analysis
  // payload unchanged. The bound on this risk is structural elsewhere (the extraction schema itself
  // never asks for a name field), not this function.
  const period = minimalPeriod({
    // A synthetic placeholder name (not a real person's) - even in a test demonstrating a gap, the
    // standing privacy rule against reproducing real PII anywhere in the repo still applies.
    hour_lines: [{ employer_index: 0, description: 'Correctie voor J. Voorbeeld', hours: null, rate: null, percent: null, amount: 10, category: 'other', tax_treatment: 'table', adds_hours: false }],
  });
  const { payload, redactedFields } = buildPayslipAnalysisPayload(period, EMPTY_OUTCOME, []);
  assert.equal(payload.hour_lines[0]?.label, 'Correctie voor J. Voorbeeld');
  assert.deepEqual(redactedFields, []);
});
