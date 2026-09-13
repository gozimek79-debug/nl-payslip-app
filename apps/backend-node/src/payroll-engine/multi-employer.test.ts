import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineMultiEmployerOutcomes, resolveLoonheffingskortingAssignment } from './multi-employer.js';
import type { PayslipComputationOutcome, PayslipComputationResult } from './payslip-model.js';

test('CO4: two employers both claiming the credit is refused, never silently resolved to the first one', () => {
  const result = resolveLoonheffingskortingAssignment({ A: true, B: true });
  assert.deepEqual(result, { status: 'invalid', employers_claiming: ['A', 'B'] });
});

test('CO4: an unassigned employer stays unknown, never defaults to "not claiming"', () => {
  const result = resolveLoonheffingskortingAssignment({ A: true, B: 'unknown' });
  assert.deepEqual(result, { status: 'unknown', employers_unassigned: ['B'] });
});

test('CO4: exactly one employer claiming, the rest explicitly not, is valid', () => {
  const result = resolveLoonheffingskortingAssignment({ A: true, B: false, C: false });
  assert.deepEqual(result, { status: 'valid', employer_claiming: 'A' });
});

test('CO4: no employer claiming it at all is a valid (if unusual) state, not an error', () => {
  const result = resolveLoonheffingskortingAssignment({ A: false, B: false });
  assert.deepEqual(result, { status: 'valid', employer_claiming: null });
});

function fakeCompleteOutcome(payout: number): PayslipComputationOutcome {
  return {
    status: 'complete',
    result: { payout_amount: payout } as PayslipComputationResult,
  };
}

test('CO1: combineMultiEmployerOutcomes sums per-employer payouts computed independently, not from pooled inputs', () => {
  const view = combineMultiEmployerOutcomes({
    A: fakeCompleteOutcome(776.09),
    B: fakeCompleteOutcome(1754.12),
  });
  assert.deepEqual(view.per_employer_payout, { A: 776.09, B: 1754.12 });
  assert.equal(view.combined_payout, 2530.21);
  assert.ok(view.annual_return_notice.length > 0);
});

test('CQ1: the combined view states the annual-return caveat but never computes a settlement figure', () => {
  const view = combineMultiEmployerOutcomes({ A: fakeCompleteOutcome(500) });
  assert.ok(/aangifte/i.test(view.annual_return_notice), 'must name the annual return, not compute it');
});

test('an incomplete employer outcome makes the combined total null, not a partial sum presented as the whole', () => {
  const view = combineMultiEmployerOutcomes({
    A: fakeCompleteOutcome(776.09),
    B: { status: 'incomplete', missing_fields: ['pension'], tax_is_upper_bound: true, gross_total: 900, taxable_base: 900, table_tax_after_korting: 100, bt_tax: 0, total_tax: 100 },
  });
  assert.deepEqual(view.per_employer_payout, { A: 776.09, B: null });
  assert.equal(view.combined_payout, null, 'a partial sum would understate what is actually owed - null is the honest signal, not a silently-wrong number');
});
