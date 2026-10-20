import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDocumentFacts, type DocumentReaderDeps } from './document-facts-reader.ts';
import type { DocumentSource } from './local-ocr.ts';

/**
 * R3-B: the reader adapter extracted from ProDocuments.tsx. These tests pin the exact behaviour the inline
 * `readDocument` had (request bodies, batch planning, partial failure, coverage, error code) - the PRO flow and the
 * R3-B conversation both run this one implementation. No network, no pdf.js: every dependency is a stub.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const LONG = 'x'.repeat(400);

function textSource(pages: number): DocumentSource {
  return {
    isPdf: true, pageCount: pages,
    lines: Array.from({ length: pages }, (_, i) => ({ page: i + 1, text: `${LONG} page ${i + 1}` })),
    itemsPerPage: Array.from({ length: pages }, () => 5), charsPerPage: Array.from({ length: pages }, () => LONG.length + 7),
  };
}
const scanSource = (pages: number): DocumentSource => ({ isPdf: true, pageCount: pages, lines: [], itemsPerPage: Array.from({ length: pages }, () => 0), charsPerPage: Array.from({ length: pages }, () => 0) });

interface Call { url: string; body: { pages: number[]; totalPages: number; images: string[]; imagePages: number[]; textLines: Array<{ page: number; text: string }> } }

function deps(source: DocumentSource, respond: (call: Call, index: number) => { status: number; json: unknown } | 'throw' | 'bad_json'): DocumentReaderDeps & { calls: Call[]; rendered: number[][]; photos: number } {
  const calls: Call[] = [];
  const rendered: number[][] = [];
  const d = {
    calls, rendered, photos: 0,
    readSource: async () => source,
    renderImages: async (_file: File, _text: boolean, pages: number[]) => { rendered.push(pages); return { images: pages.map((p) => `data:image/jpeg;base64,PAGE${p}`) }; },
    photo: async () => { d.photos += 1; return { image: 'data:image/jpeg;base64,PHOTO' }; },
    fetchImpl: (async (url: string, init: RequestInit) => {
      const call = { url, body: JSON.parse(String(init.body)) as Call['body'] };
      calls.push(call);
      const r = respond(call, calls.length - 1);
      if (r === 'throw') throw new TypeError('network down');
      if (r === 'bad_json') return { ok: false, status: 502, json: async () => { throw new SyntaxError('not json'); } } as unknown as Response;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json } as unknown as Response;
    }) as unknown as typeof fetch,
  };
  return d;
}

const file = (type = 'application/pdf') => new File(['%PDF-synthetic'], 'synthetic.pdf', { type });
const okBatch = (call: Call) => ({ status: 200, json: { batch: { kind: 'payslip', pages: call.body.pages } } });

test('reader adapter: a text-layer document is read in one batch from its page text - no image, every page covered', async () => {
  const d = deps(textSource(4), okBatch);
  const out = await readDocumentFacts(file(), 'payslip', d);
  assert.equal(d.calls.length, 1);
  assert.equal(d.calls[0]?.url, '/api/pro/payslip-facts');
  assert.deepEqual(d.calls[0]?.body.pages, [1, 2, 3, 4]);
  assert.deepEqual(d.calls[0]?.body.images, []);
  assert.equal(d.calls[0]?.body.textLines.length, 4);
  assert.deepEqual(out, { status: 'done', factBatches: [{ kind: 'payslip', pages: [1, 2, 3, 4] }], coverage: { totalPages: 4, notProcessedPages: [], reason: null } });
});

test('reader adapter: a scan is read three pages per call; a failed batch is reported by page and the rest is kept', async () => {
  const d = deps(scanSource(4), (call) => (call.body.pages.includes(4) ? { status: 503, json: { error_code: 'vision_unavailable' } } : okBatch(call)));
  const out = await readDocumentFacts(file(), 'contract', d);
  assert.deepEqual(d.calls.map((c) => [c.url, c.body.pages, c.body.imagePages]), [['/api/pro/contract-facts', [1, 2, 3], [1, 2, 3]], ['/api/pro/contract-facts', [4], [4]]]);
  assert.deepEqual(d.rendered, [[1, 2, 3], [4]]);
  assert.equal(out.status, 'done');
  assert.deepEqual(out.status === 'done' && out.coverage, { totalPages: 4, notProcessedPages: [4], reason: 'batch_failed' });
});

test('reader adapter: nothing read is an error with the route\'s own code - never a "done" document', async () => {
  const unavailable = await readDocumentFacts(file(), 'payslip', deps(scanSource(1), () => ({ status: 503, json: { error_code: 'vision_unavailable' } })));
  assert.deepEqual(unavailable, { status: 'error', errorCode: 'vision_unavailable' });
  const network = await readDocumentFacts(file(), 'payslip', deps(scanSource(1), () => 'throw'));
  assert.deepEqual(network, { status: 'error', errorCode: undefined });
  const html = await readDocumentFacts(file(), 'payslip', deps(scanSource(1), () => 'bad_json'));
  assert.deepEqual(html, { status: 'error', errorCode: undefined }, 'a non-JSON error page (e.g. a 413) is a failure');
});

test('reader adapter: a photo is one page sent through the photo budget; a document over 30 pages names the pages not read', async () => {
  const photo = deps({ isPdf: false, pageCount: 1, lines: [], itemsPerPage: [0], charsPerPage: [0] }, okBatch);
  const photoOut = await readDocumentFacts(file('image/jpeg'), 'payslip', photo);
  assert.equal(photo.photos, 1);
  assert.deepEqual(photo.calls[0]?.body.images, ['data:image/jpeg;base64,PHOTO']);
  assert.equal(photoOut.status, 'done');
  const long = await readDocumentFacts(file(), 'contract', deps(textSource(31), okBatch));
  assert.deepEqual(long.status === 'done' && long.coverage, { totalPages: 31, notProcessedPages: [31], reason: 'document_too_long' });
});

test('reader adapter: ProDocuments uses the adapter - no second copy of the reader loop - and keeps its replay for payslips only', () => {
  const pro = readFileSync(path.join(here, 'ProDocuments.tsx'), 'utf-8');
  assert.match(pro, /readDocumentFacts\(entry\.file, kind, READER_DEPS\)/);
  assert.ok(!pro.includes('/api/pro/${kind}-facts'), 'the reader route is called only by the adapter');
  assert.ok(!pro.includes('planDocumentBatches'), 'batch planning lives in the adapter');
  assert.match(pro, /kind === 'payslip' \? await replayPayslip\(read\.factBatches\) : \{\}/);
  assert.match(pro, /translateErrorCode\(read\.errorCode\)/);
});

test('R3-B.2 reader adapter: the server-held batch references are kept - only when EVERY batch has one', async () => {
  const withRefs = await readDocumentFacts(file(), 'payslip', deps(scanSource(4), (call) => ({ status: 200, json: { batch: { kind: 'payslip', pages: call.body.pages }, batchRef: `ref-${call.body.pages[0]}` } })));
  assert.deepEqual(withRefs.status === 'done' && withRefs.batchRefs, ['ref-1', 'ref-4']);
  const partial = await readDocumentFacts(file(), 'payslip', deps(scanSource(4), (call, i) => ({ status: 200, json: { batch: { kind: 'payslip', pages: call.body.pages }, ...(i === 0 ? { batchRef: 'ref-1' } : {}) } })));
  assert.equal(partial.status === 'done' && partial.batchRefs, undefined, 'a document with an unreferenced batch can only be echoed');
  const failedBatch = await readDocumentFacts(file(), 'payslip', deps(scanSource(4), (call) => (call.body.pages.includes(4) ? { status: 503, json: { error_code: 'vision_unavailable' } } : { status: 200, json: { batch: { kind: 'payslip', pages: call.body.pages }, batchRef: 'ref-1' } })));
  assert.deepEqual(failedBatch.status === 'done' && failedBatch.batchRefs, ['ref-1'], 'references of the batches that were read');
});
