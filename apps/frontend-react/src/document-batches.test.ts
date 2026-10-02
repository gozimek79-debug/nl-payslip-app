import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDocumentBatches, IMAGE_PAGES_PER_BATCH, TEXT_PAGES_PER_BATCH, MAX_PAGES_PER_DOCUMENT } from './document-batches.ts';

/** P2 (ZADANIE-P2-LOONTO-PRO.md §P2.9/§P2.17 #15): no PRO document is silently truncated. */

const textDoc = (pages: number, chars = 3000) => ({ pageCount: pages, itemsPerPage: Array(pages).fill(80), charsPerPage: Array(pages).fill(chars) });
const scan = (pages: number) => ({ pageCount: pages, itemsPerPage: Array(pages).fill(0), charsPerPage: Array(pages).fill(0) });

function coveredPages(plan: ReturnType<typeof planDocumentBatches>): number[] {
  return plan.batches.flatMap((b) => b.pages);
}

test('P2.17 #15: a 10-page scan is read completely, three pages per call - never just its first three', () => {
  const plan = planDocumentBatches(scan(10));
  assert.equal(plan.mode, 'image');
  assert.deepEqual(plan.batches.map((b) => b.pages), [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]);
  assert.ok(plan.batches.every((b) => b.imagePages.length <= IMAGE_PAGES_PER_BATCH && b.imagePages.join() === b.pages.join()));
  assert.deepEqual(plan.notProcessedPages, []);
});

test('P2.17 #6: a text-layer contract is read from its page-indexed text - all pages, layout images only for a small call', () => {
  const contract = planDocumentBatches(textDoc(8));
  assert.equal(contract.mode, 'text');
  assert.deepEqual(contract.batches, [{ pages: [1, 2, 3, 4, 5, 6, 7, 8], imagePages: [] }]);
  const payslip = planDocumentBatches(textDoc(2));
  assert.deepEqual(payslip.batches, [{ pages: [1, 2], imagePages: [1, 2] }]);
  const long = planDocumentBatches(textDoc(25));
  assert.deepEqual(long.batches.map((b) => b.pages.length), [TEXT_PAGES_PER_BATCH, 5]);
  assert.deepEqual(coveredPages(long), Array.from({ length: 25 }, (_, i) => i + 1));
});

test('P2.9: a thin text page (signature page, scanned page with a printed header) is always sent as an image too', () => {
  const doc = { pageCount: 8, itemsPerPage: [80, 80, 2, 80, 80, 80, 80, 3], charsPerPage: [3000, 3000, 40, 3000, 3000, 3000, 3000, 25] };
  const plan = planDocumentBatches(doc);
  assert.equal(plan.mode, 'text');
  assert.deepEqual(plan.batches, [{ pages: [1, 2, 3, 4, 5, 6, 7, 8], imagePages: [3, 8] }]);
  const manyThin = planDocumentBatches({ pageCount: 8, itemsPerPage: Array(8).fill(2), charsPerPage: Array(8).fill(50) });
  assert.ok(manyThin.batches.every((b) => b.imagePages.length <= IMAGE_PAGES_PER_BATCH), 'never more images per call than the request budget allows');
  assert.ok(manyThin.batches.every((b) => b.pages.every((p) => b.imagePages.includes(p))), 'every thin page still gets its image');
  assert.deepEqual(coveredPages(manyThin), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('P2.9: a page with no text layer sends the whole document down the image path (a mixed document is never read text-only)', () => {
  const mixed = { pageCount: 4, itemsPerPage: [80, 80, 0, 80], charsPerPage: [3000, 3000, 0, 3000] };
  const plan = planDocumentBatches(mixed);
  assert.equal(plan.mode, 'image');
  assert.deepEqual(coveredPages(plan), [1, 2, 3, 4]);
});

test('P2.9: beyond the per-document limit, the unread pages are listed by number with a reason - never hidden', () => {
  const plan = planDocumentBatches(scan(MAX_PAGES_PER_DOCUMENT + 5));
  assert.deepEqual(coveredPages(plan), Array.from({ length: MAX_PAGES_PER_DOCUMENT }, (_, i) => i + 1));
  assert.deepEqual(plan.notProcessedPages, [31, 32, 33, 34, 35]);
  assert.equal(plan.notProcessedReason, 'document_too_long');
  assert.equal(planDocumentBatches(scan(3)).notProcessedReason, null);
});

test('P2.9: a text batch is split before it would exceed the per-call text budget', () => {
  const heavy = planDocumentBatches(textDoc(10, 50_000));
  assert.ok(heavy.batches.length > 1);
  assert.deepEqual(coveredPages(heavy), Array.from({ length: 10 }, (_, i) => i + 1));
  assert.ok(heavy.batches.every((b) => b.pages.length * 50_000 <= 180_000));
});

test('P2.8: a photo is one page read from its image', () => {
  assert.deepEqual(planDocumentBatches(scan(1)), { mode: 'image', batches: [{ pages: [1], imagePages: [1] }], notProcessedPages: [], notProcessedReason: null });
});
