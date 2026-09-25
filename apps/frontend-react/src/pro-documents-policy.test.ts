import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDocument, removeDocument, setDocumentType, setEffectiveDate, routeForDocument, isReadyToSubmit, type ProDocumentMeta } from './pro-documents-policy.ts';

/** Stage 3.0 (audit v40, §3.0.4): "the multi-add/remove UI" and "document correctly routed to
 * payslip vs. contract vs. annex extraction" - the two frontend exit criteria this file's own
 * functions are pulled out to make directly testable. */

test('3.0.4: addDocument appends without mutating the original list', () => {
  const original: ProDocumentMeta[] = [{ id: 'a', documentType: 'payslip', effectiveDate: null }];
  const next = addDocument(original, { id: 'b', documentType: 'contract_base', effectiveDate: null });
  assert.equal(original.length, 1, 'the original list must be untouched');
  assert.equal(next.length, 2);
  assert.equal(next[1]?.id, 'b');
});

test('3.0.4: removeDocument removes exactly the named entry, leaving the rest in order', () => {
  const list: ProDocumentMeta[] = [
    { id: 'a', documentType: 'payslip', effectiveDate: null },
    { id: 'b', documentType: 'contract_base', effectiveDate: null },
    { id: 'c', documentType: 'contract_annex', effectiveDate: '2026-03-01' },
  ];
  const next = removeDocument(list, 'b');
  assert.deepEqual(next.map((e) => e.id), ['a', 'c']);
});

test('3.0.4: removeDocument on an id not present is a no-op', () => {
  const list: ProDocumentMeta[] = [{ id: 'a', documentType: 'payslip', effectiveDate: null }];
  assert.deepEqual(removeDocument(list, 'nonexistent'), list);
});

test('3.0.4: setDocumentType changes only the named entry, and clears effectiveDate when switching AWAY from an annex', () => {
  const list: ProDocumentMeta[] = [{ id: 'a', documentType: 'contract_annex', effectiveDate: '2026-03-01' }];
  const next = setDocumentType(list, 'a', 'payslip');
  assert.equal(next[0]?.documentType, 'payslip');
  assert.equal(next[0]?.effectiveDate, null, 'a stale annex date must not survive a type change away from annex');
});

test('3.0.4: setDocumentType keeps any existing effectiveDate when switching TO an annex', () => {
  const list: ProDocumentMeta[] = [{ id: 'a', documentType: 'payslip', effectiveDate: null }];
  const next = setEffectiveDate(setDocumentType(list, 'a', 'contract_annex'), 'a', '2026-05-01');
  assert.equal(next[0]?.documentType, 'contract_annex');
  assert.equal(next[0]?.effectiveDate, '2026-05-01');
});

test('3.0.4: document correctly routed to payslip vs. contract vs. annex extraction', () => {
  assert.equal(routeForDocument('payslip'), 'tier_c');
  assert.equal(routeForDocument('contract_base'), 'contract');
  assert.equal(routeForDocument('contract_annex'), 'contract');
});

test('3.0.4: isReadyToSubmit is false for an empty list', () => {
  assert.equal(isReadyToSubmit([]), false);
});

test('3.0.4: isReadyToSubmit is false while an annex has no effective date yet', () => {
  const list: ProDocumentMeta[] = [
    { id: 'a', documentType: 'contract_base', effectiveDate: null },
    { id: 'b', documentType: 'contract_annex', effectiveDate: null },
  ];
  assert.equal(isReadyToSubmit(list), false);
});

test('3.0.4: isReadyToSubmit is true once every annex has a date - base/payslip entries never need one', () => {
  const list: ProDocumentMeta[] = [
    { id: 'a', documentType: 'payslip', effectiveDate: null },
    { id: 'b', documentType: 'contract_base', effectiveDate: null },
    { id: 'c', documentType: 'contract_annex', effectiveDate: '2026-03-01' },
  ];
  assert.equal(isReadyToSubmit(list), true);
});
