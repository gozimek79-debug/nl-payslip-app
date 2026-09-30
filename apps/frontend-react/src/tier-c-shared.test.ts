import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  issueKey, correctableFieldPath, getPeriodFieldByPath, setPeriodFieldByPath,
  outstandingAmountUnreadablePaths, openNeedsConfirmation, isPayslipFullyReproduced,
  type ConsistencyIssue, type TierCPeriodResponse,
} from './tier-c-shared.ts';

/**
 * Stage 2u (audit v53 - auditor ruling): "Any Stage 2u frontend test that only proves behavior inside
 * unimported TierCFlow.tsx does not satisfy the stage. Add tests around the actual ProDocuments
 * behavior." This file tests the pure, shared logic ProDocuments.tsx (the actual live PRO surface)
 * uses for the provisional-result/confirm/correct behavior - the same logic a future TierCFlow
 * reconnect would reuse unchanged, per the auditor's own "reuse logic, not dead UI" instruction.
 */

function basePeriod(overrides: Partial<TierCPeriodResponse> = {}): TierCPeriodResponse {
  return {
    period_label: 'week 36/2026', period_type: 'week', period_type_confirmed: true, period_end_date: '2026-09-06',
    is_correction: false, version: 1, contract_hours: null, payout_adjustments: [],
    bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
    et: null, employers: [{ name: null, franchise_bearing: true }], hirer: null,
    hour_lines: [
      { description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true },
    ],
    pre_tax_deductions: [], post_tax_social: [], net_additions: [], net_deductions: [], reservations: [],
    wml_printed: null, wml_applicable: null,
    printed_table_tax: 152.37, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
    printed_net: 500, printed_payout: null,
    printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null,
    printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
    ...overrides,
  };
}

test('2u.2: issueKey is unique per amount_unreadable field, stable for every other code', () => {
  const a: ConsistencyIssue = { code: 'amount_unreadable', field: 'hour_lines[0].amount' };
  const b: ConsistencyIssue = { code: 'amount_unreadable', field: 'hour_lines[1].amount' };
  assert.notEqual(issueKey(a), issueKey(b), 'two different unread fields must never collide on the same key');
  const c1: ConsistencyIssue = { code: 'totals_do_not_reconcile_net', implied_net: 1, printed_net: 2, residual: 1 };
  const c2: ConsistencyIssue = { code: 'totals_do_not_reconcile_net', implied_net: 9, printed_net: 9, residual: 0 };
  assert.equal(issueKey(c1), issueKey(c2), 'a non-amount_unreadable code is unique by code alone (at most one instance per response)');
});

test('2u.2: correctableFieldPath names a path for every correctable code, null for diagnosis-only codes', () => {
  assert.equal(correctableFieldPath({ code: 'totals_do_not_reconcile_net', implied_net: 1, printed_net: 2, residual: 1 }), 'printed_net');
  assert.equal(correctableFieldPath({ code: 'totals_do_not_reconcile_payout', implied_payout: 1, printed_payout: 2, residual: 1 }), 'printed_payout');
  assert.equal(correctableFieldPath({ code: 'et_exchange_amount_unknown' }), 'et.et_exchange_amount');
  assert.equal(correctableFieldPath({ code: 'amount_unreadable', field: 'hour_lines[2].amount' }), 'hour_lines[2].amount');
  assert.equal(correctableFieldPath({ code: 'zero_tax_nonzero_base', taxable_base: 1, printed_table_tax: 1 }), null, 'v17: diagnosis-only codes stay uncorrectable');
});

test('2u.2: getPeriodFieldByPath/setPeriodFieldByPath round-trip every correctable path shape', () => {
  const period = basePeriod({
    net_additions: [{ category: 'reimbursement', description: 'Reiskosten', amount: 90 }],
    net_deductions: [{ category: 'other', description: 'Voorschot', amount: 20 }],
    payout_adjustments: [{ description: 'Correctie', amount: 5 }],
    reservations: [{ type: 'vakantiegeld', opgebouwd_this_period: 30, paid_out_this_period: 0 }],
    et: { et_applicable: true, et_exchange_amount: 33, et_reimbursements: [], adres_fiskalny: null },
  });
  const cases: Array<[string, number]> = [
    ['hour_lines[0].amount', 711.11],
    ['net_additions[0].amount', 91.11],
    ['net_deductions[0].amount', 21.11],
    ['payout_adjustments[0].amount', 6.11],
    ['reservations[0].opgebouwd_this_period', 31.11],
    ['reservations[0].paid_out_this_period', 1.11],
    ['et.et_exchange_amount', 34.11],
    ['printed_net', 501.11],
    ['printed_payout', 601.11],
  ];
  for (const [path, value] of cases) {
    const updated = setPeriodFieldByPath(period, path, value);
    assert.equal(getPeriodFieldByPath(updated, path), value, `expected ${path} to round-trip to ${value}`);
    // Every OTHER path on the ORIGINAL period must be unaffected by this one write - proves each
    // branch edits only its own line/field, never a sibling.
    assert.equal(getPeriodFieldByPath(period, 'hour_lines[0].amount'), 699.78, `${path}'s own write must not disturb hour_lines[0].amount`);
  }
});

test('2u.2: outstandingAmountUnreadablePaths names every OTHER unread field, excluding the one being resolved', () => {
  const needsConfirmation: ConsistencyIssue[] = [
    { code: 'amount_unreadable', field: 'hour_lines[0].amount' },
    { code: 'amount_unreadable', field: 'net_additions[0].amount' },
    { code: 'totals_do_not_reconcile_net', implied_net: 1, printed_net: 2, residual: 1 },
  ];
  assert.deepEqual(outstandingAmountUnreadablePaths(needsConfirmation), ['hour_lines[0].amount', 'net_additions[0].amount'], 'both unread fields listed when nothing is excluded');
  assert.deepEqual(outstandingAmountUnreadablePaths(needsConfirmation, 'hour_lines[0].amount'), ['net_additions[0].amount'], 'the field being resolved right now is excluded from its own flaggedFieldPaths');
});

test('2u.1/2u.3: openNeedsConfirmation drops only the confirmed issue, keeps every other one visible', () => {
  const issues: ConsistencyIssue[] = [
    { code: 'totals_do_not_reconcile_net', implied_net: 512.62, printed_net: 500, residual: 12.62 },
    { code: 'amount_unreadable', field: 'hour_lines[1].amount' },
  ];
  const confirmed = new Set([issueKey(issues[0]!)]);
  const open = openNeedsConfirmation(issues, confirmed);
  assert.deepEqual(open, [issues[1]], 'confirming one issue must not silently clear the other');
  assert.deepEqual(openNeedsConfirmation(issues, new Set()), issues, 'nothing confirmed yet - both stay open');
});

test('2u.3: isPayslipFullyReproduced is false while any discrepancy or needsConfirmation item is open', () => {
  const oneOpenIssue: ConsistencyIssue[] = [{ code: 'et_exchange_amount_unknown' }];
  assert.equal(isPayslipFullyReproduced(0, oneOpenIssue, new Set()), false, 'an open needsConfirmation item alone must block eligibility');
  assert.equal(isPayslipFullyReproduced(1, [], new Set()), false, 'a real discrepancy alone must block eligibility, even with nothing to confirm');
  assert.equal(isPayslipFullyReproduced(0, [], new Set()), true, 'a genuinely clean read is eligible');
});

test('2u.3: isPayslipFullyReproduced becomes true once the last open issue is confirmed - proves the exact "resolve then become eligible" transition 2u.3 requires', () => {
  const issues: ConsistencyIssue[] = [{ code: 'totals_do_not_reconcile_net', implied_net: 512.62, printed_net: 500, residual: 12.62 }];
  assert.equal(isPayslipFullyReproduced(0, issues, new Set()), false, 'not yet eligible - the issue is still open');
  const confirmed = new Set([issueKey(issues[0]!)]);
  assert.equal(isPayslipFullyReproduced(0, issues, confirmed), true, 'eligible now that the one open issue was confirmed');
});
