import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareReaderExtractions } from './reader-comparison.js';
import type { TierCExtraction } from './tier-c.js';

/**
 * Stage 2s (audit v51, §2s.2): the required disagreement matrix from the task itself - Cursor's
 * self-consistent `699,59`/`699,51` pair, OTTO's repeated `0,51`/`0,52` line, the reservation
 * `78,51`/`78,59`, a line only one reading has, and both readings agreeing on everything.
 */
function baseExtraction(overrides: Partial<TierCExtraction> = {}): TierCExtraction {
  return {
    period_label: 'week 36/2026', period_end_date: '2026-09-06', payment_date: null, period_type: 'week',
    is_correction: false, version: 1, employer_names: [], hirer_name: null,
    hours_per_week: null, minimum_wage_printed: null,
    hour_lines: [], pre_tax_deduction_lines: [], post_tax_deduction_lines: [],
    bijzonder_tarief_printed_percent: null, bijzonder_tarief_jaarloon: null,
    et_exchange_amount: null, et_reimbursement_lines: [], net_lines: [], payout_adjustment_lines: [], reservation_lines: [],
    printed_table_tax: null, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
    reported_total_net: null, reported_net_paid: null,
    printed_gross_total: null, printed_loon_voor_heffingen: null,
    printed_taxable_base_normal: null, printed_taxable_base_special: null,
    printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null,
    printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
    truncated: false, redacted_fields: [], unreadable_amount_fields: [],
    ...overrides,
  };
}

function hourLine(overrides: Partial<TierCExtraction['hour_lines'][number]> = {}) {
  return {
    employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null,
    amount: 699.78, category: 'regular' as const, tax_treatment: 'table' as const, adds_hours: true,
    ...overrides,
  };
}

test('2s.2: both readings agreeing on everything produces no issues', () => {
  const a = baseExtraction({ hour_lines: [hourLine()] });
  const b = baseExtraction({ hour_lines: [hourLine()] });
  assert.deepEqual(compareReaderExtractions(a, b), []);
});

test("2s.2: Cursor's self-consistent 699,59/699,51 pair - a genuine hour_line amount disagreement is flagged, never resolved", () => {
  const a = baseExtraction({ hour_lines: [hourLine({ amount: 699.59 })] });
  const b = baseExtraction({ hour_lines: [hourLine({ amount: 699.51 })] });
  const issues = compareReaderExtractions(a, b);
  assert.deepEqual(issues, [
    { code: 'reader_line_disagreement', list: 'hour_lines', line_key: 'regular::loon normaal', index: 0, field: 'amount', value_a: 699.59, value_b: 699.51 },
  ]);
});

test('2s.2: OTTO shape - two lines sharing a description, one digit apart on one side, pairs positionally and flags only the mismatched pair', () => {
  const line1 = { description: 'PAWW Rekompensata', amount: 0.51, category: 'paww' as const, placement: 'pre_tax' as const, base: null, percent: null };
  const a = baseExtraction({ pre_tax_deduction_lines: [line1, { ...line1, amount: 0.51 }] });
  const b = baseExtraction({ pre_tax_deduction_lines: [line1, { ...line1, amount: 0.52 }] });
  const issues = compareReaderExtractions(a, b);
  assert.deepEqual(issues, [
    { code: 'reader_line_disagreement', list: 'pre_tax_deduction_lines', line_key: 'paww::paww rekompensata', index: 1, field: 'amount', value_a: 0.51, value_b: 0.52 },
  ]);
});

test('2s.2: the reservation 78,51/78,59 - a reservation_lines disagreement is flagged the same way', () => {
  const a = baseExtraction({ reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 78.51, paid_out: 0 }] });
  const b = baseExtraction({ reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 78.59, paid_out: 0 }] });
  const issues = compareReaderExtractions(a, b);
  assert.deepEqual(issues, [
    { code: 'reader_line_disagreement', list: 'reservation_lines', line_key: 'vakantiegeld::vakantiegeld', index: 0, field: 'opgebouwd', value_a: 78.51, value_b: 78.59 },
  ]);
});

test('2s.2: a line only reading A has is flagged only_in_a, never silently dropped or treated as a value of zero', () => {
  const a = baseExtraction({ hour_lines: [hourLine(), hourLine({ description: 'Loon onregelm. uren 50%', category: 'irregular_surcharge', amount: 58.31, adds_hours: false })] });
  const b = baseExtraction({ hour_lines: [hourLine()] });
  const issues = compareReaderExtractions(a, b);
  assert.deepEqual(issues, [{ code: 'reader_line_only_in_a', list: 'hour_lines', line_key: 'irregular_surcharge::loon onregelm. uren 50%', count: 1 }]);
});

test('2s.2: a line only reading B has is flagged only_in_b', () => {
  const a = baseExtraction({ hour_lines: [hourLine()] });
  const b = baseExtraction({ hour_lines: [hourLine(), hourLine({ description: 'Overwerk', category: 'overtime', amount: 100 })] });
  const issues = compareReaderExtractions(a, b);
  assert.deepEqual(issues, [{ code: 'reader_line_only_in_b', list: 'hour_lines', line_key: 'overtime::overwerk', count: 1 }]);
});

test('2s.2: unequal counts on both non-zero sides (a split or merged line) is flagged ambiguous, never guessed at', () => {
  const line = { description: 'Loon onregelm.', amount: 30, category: 'irregular_surcharge' as const, tax_treatment: 'table' as const, adds_hours: false, employer_index: 0, hours: null, rate: null, percent: null };
  const a = baseExtraction({ hour_lines: [{ ...line, amount: 70 }] });
  const b = baseExtraction({ hour_lines: [{ ...line, amount: 30 }, { ...line, amount: 40 }] });
  const issues = compareReaderExtractions(a, b);
  assert.deepEqual(issues, [{ code: 'reader_line_ambiguous_alignment', list: 'hour_lines', line_key: 'irregular_surcharge::loon onregelm.', count_a: 1, count_b: 2 }]);
});

test('2s.2: description-only noise (diacritics, case) between two readers never counts as a disagreement', () => {
  const a = baseExtraction({ hour_lines: [hourLine({ description: 'Loon normaal' })] });
  const b = baseExtraction({ hour_lines: [hourLine({ description: 'LOON NORMÁÁL' })] });
  assert.deepEqual(compareReaderExtractions(a, b), []);
});

test('2s.2: a scalar field disagreement (printed_table_tax) is flagged, naming both values, choosing neither', () => {
  const a = baseExtraction({ printed_table_tax: 145.51 });
  const b = baseExtraction({ printed_table_tax: 152.37 });
  assert.deepEqual(compareReaderExtractions(a, b), [{ code: 'reader_field_disagreement', field: 'printed_table_tax', value_a: 145.51, value_b: 152.37 }]);
});

test("2s.2: one reader seeing a value the other reads as null is a disagreement, not silence", () => {
  const a = baseExtraction({ printed_bt_tax: 40.08 });
  const b = baseExtraction({ printed_bt_tax: null });
  assert.deepEqual(compareReaderExtractions(a, b), [{ code: 'reader_field_disagreement', field: 'printed_bt_tax', value_a: 40.08, value_b: null }]);
});

test('2s.2: many disagreements are each reported individually - there is no threshold that clears them or disables the check', () => {
  const a = baseExtraction({ printed_table_tax: 100, printed_bt_tax: 10, reported_total_net: 500, reported_net_paid: 500, printed_gross_total: 700 });
  const b = baseExtraction({ printed_table_tax: 200, printed_bt_tax: 20, reported_total_net: 501, reported_net_paid: 502, printed_gross_total: 701 });
  const issues = compareReaderExtractions(a, b);
  const fields = issues.filter((i) => i.code === 'reader_field_disagreement').map((i) => (i as { field: string }).field);
  assert.deepEqual(new Set(fields), new Set(['printed_table_tax', 'printed_bt_tax', 'reported_total_net', 'reported_net_paid', 'printed_gross_total']));
  assert.equal(issues.length, 5, 'expected every one of the 5 disagreeing fields reported, none suppressed for being "too many"');
});

test('2s.2: employer_names compared as an order-independent, noise-tolerant set', () => {
  const a = baseExtraction({ employer_names: ['DHL', 'KF Logistics'] });
  const b = baseExtraction({ employer_names: ['KF Logistics', 'DHL'] });
  assert.deepEqual(compareReaderExtractions(a, b), []);
  const c = baseExtraction({ employer_names: ['DHL'] });
  assert.equal(compareReaderExtractions(a, c).length, 1);
});
