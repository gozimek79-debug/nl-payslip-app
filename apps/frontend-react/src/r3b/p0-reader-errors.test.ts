import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createR3BStore } from './r3b-flow.ts';
import { readReportLines } from './r3b-describe.ts';
import { R3B_COPY } from './r3b-copy.ts';
import { harness, pdf, readOk } from './r3b-test-support.ts';

/**
 * P0 (2026-10-20): the CEO's read failed with `vision_unavailable` on an old Preview (no reader configured there), and
 * two Production reads were killed by the 60 s function limit (a non-JSON 504). The interface must say which failure it
 * is - and on a host without a reader, say so BEFORE anything is uploaded - instead of "the document is unreadable".
 */

const PL = R3B_COPY.pl;

test('P0: on a host without a configured reader, reading is disabled and explained up front - nothing is sent', async () => {
  const h = harness({ reads: { 'pasek.pdf': readOk('payslip_week33_1680') } });
  const store = createR3BStore({ ...h.deps, readerStatus: async () => false }, 'pl');
  await store.checkReader();
  assert.equal(store.getState().readerAvailable, false);
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  assert.equal(h.readCalls.length, 0, 'no document content leaves the browser');
  assert.equal(store.getState().docs[0]?.status, 'selected');
  assert.match(PL.offer.readerUnavailable, /nie jest tu skonfigurowany/);
  assert.match(PL.offer.readerUnavailable, /nl-payslip-app\.vercel\.app/, 'points to the main version');
});

test('P0: an unknown reader status (or none) never blocks reading; a configured host reads normally', async () => {
  for (const readerStatus of [undefined, async () => null, async () => true, async () => { throw new Error('offline'); }]) {
    const h = harness({ reads: { 'pasek.pdf': readOk('payslip_week33_1680') } });
    const store = createR3BStore({ ...h.deps, ...(readerStatus ? { readerStatus } : {}) }, 'pl');
    await store.checkReader();
    assert.notEqual(store.getState().readerAvailable, false);
    store.addFiles([pdf('pasek.pdf')], 'payslip');
    await store.read();
    assert.equal(h.readCalls.length, 1);
  }
});

test('P0: a vision_unavailable answer switches reading off for this host; the reset keeps that knowledge', async () => {
  const h = harness({ reads: { 'pasek.pdf': { status: 'error', errorCode: 'vision_unavailable' } } });
  const store = createR3BStore(h.deps, 'pl');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  assert.equal(store.getState().readerAvailable, false);
  store.reset();
  assert.equal(store.getState().readerAvailable, false);
});

test('P0: each failure is named for what it is - never "the document cannot be read" for a timeout or a lost connection', async () => {
  const cases: Array<[string, RegExp]> = [
    ['vision_unavailable', /nie jest skonfigurowany.*Preview/],
    ['reader_timeout', /nie zdążył .* w limicie czasu/],
    ['reader_provider_error', /usługa Gemini zwróciła błąd/],
    ['network_error', /brak połączenia z serwerem Loonto/],
    ['unexpected_response', /nieoczekiwaną odpowiedź/],
    ['request_too_large', /za duże do wysłania/],
    ['page_render_failed', /nie udało się przygotować stron/],
    ['extraction_failed', /nie da się bezpiecznie odczytać/],
  ];
  for (const [code, pattern] of cases) {
    const h = harness({ reads: { 'pasek.pdf': { status: 'error', errorCode: code } } });
    const store = createR3BStore(h.deps, 'pl');
    store.addFiles([pdf('pasek.pdf')], 'payslip');
    await store.read();
    const report = store.getState().messages.map((m) => m.block).find((b) => b.kind === 'read_report');
    assert.ok(report && report.kind === 'read_report');
    const [line] = readReportLines(report.items, report.anyRead, store.getState().docs, PL);
    assert.match(line ?? '', pattern, code);
    assert.ok(!(line ?? '').includes(PL.readReport.errors.unknown as string), `${code} is not the generic message`);
  }
  for (const lang of ['pl', 'en'] as const) {
    for (const [code] of cases) assert.ok(R3B_COPY[lang].readReport.errors[code], `${lang} copy for ${code}`);
  }
});

test('P0 live finding C: a document rate that is a CONFLICT is announced as "both kept, none chosen" - never as taken from the document', async () => {
  const { describeTurn } = await import('./r3b-describe.ts');
  const turn = (hourlyRate: unknown) => ({
    kind: 'turn' as const, deferredNow: [],
    context: { docsRead: true, rateFoundInDocs: true, premiumsInDocs: [], contractHours: null, documentFields: [], conflictFields: [] },
    result: {
      turnId: 't', status: 'unchanged', intent: 'document_question', agentStatus: 'not_needed', patchApplied: null, patchIssues: [],
      patchNotes: [{ code: 'trusted_value_added', field: 'pay.hourlyRate' }], evaluation: { status: 'blocked' }, nextQuestion: null, conversation: {}, responseHint: null,
      scenario: { schemaVersion: 1, scenarioId: 's', periodType: 'week', work: {}, tax: {}, pay: { hourlyRate } },
    },
  }) as never;
  const conflict = describeTurn(turn({ state: 'conflict', candidates: [{ value: 18.2, source: 'document' }, { value: 18.75, source: 'document' }] }), PL, 'pl');
  assert.ok(conflict.lines.includes('Stawka godzinowa brutto: dokument podaje dwie różne wartości — zostawiam obie, nie wybieram żadnej.'));
  assert.ok(!conflict.lines.some((l) => l.includes('uwzględniam odczyt')));
  const known = describeTurn(turn({ state: 'known', value: 17.3, source: 'document' }), PL, 'pl');
  assert.ok(known.lines.some((l) => l.includes('uwzględniam odczyt z Twojego dokumentu')));
  assert.ok(R3B_COPY.en.turn.notes.trusted_conflict_added);
});
