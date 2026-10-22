import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVISOR_COPY } from './advisor-copy.ts';
import { fetchAvailability } from './advisor-client.ts';
import { textBlocks } from './advisor-text.ts';
import { advisorHarness, okTurn, pdf, resolvedWithContext } from './advisor-test-support.ts';

/**
 * AI-001 advisor screen state, driven with a RECORDED backend (placeholder answer texts). These tests prove what the
 * interface sends, shows and refuses to make up - not how well the model talks (that is the real-model run).
 */

const advisorTexts = (state: { thread: Array<{ from: string; text?: string }> }) => state.thread.filter((i) => i.from === 'advisor').map((i) => i.text);
const notices = (state: { thread: Array<Record<string, unknown>> }) => state.thread.filter((i) => i.from === 'notice').map((i) => (i.kind === 'error' ? `error:${i.failure}` : `info:${i.info}`));

test('AI-001 store: the thread shows the model text verbatim; later turns carry only the opaque conversation reference', async () => {
  const h = advisorHarness([okTurn('MODEL-ANSWER-1', { conversationRef: 'conv-1' }), okTurn('MODEL-ANSWER-2\n\n- point', { conversationRef: 'conv-2' })]);
  await h.store.send('  Pracuję 7 dni w tygodniu, 56 godzin. Ile dostanę?  ');
  await h.store.send('A za noc?');
  const [first, second] = h.turnCalls();
  assert.deepEqual(first?.body, { message: 'Pracuję 7 dni w tygodniu, 56 godzin. Ile dostanę?', locale: 'pl' }, 'words + locale only - no facts, values or provenance');
  assert.deepEqual(second?.body, { message: 'A za noc?', locale: 'pl', conversationRef: 'conv-1' });
  const s = h.store.getState();
  assert.deepEqual(advisorTexts(s), ['MODEL-ANSWER-1', 'MODEL-ANSWER-2\n\n- point'], 'nothing added to, or substituted for, the model text');
  assert.deepEqual(s.thread.map((i) => i.from), ['user', 'advisor', 'user', 'advisor']);
  assert.equal(s.conversationRef, 'conv-2');
  assert.equal(s.busy, false);
});

test('AI-001 store: no model on this host -> said honestly, nothing sent, no substitute answer', async () => {
  const h = advisorHarness([], { status: { advisorAvailable: false, visionAvailable: false } });
  await h.store.checkAvailability();
  await h.store.send('Ile dostanę?');
  assert.equal(h.store.getState().advisorAvailable, false);
  assert.equal(h.store.getState().readerAvailable, false);
  assert.equal(h.turnCalls().length, 0);
  assert.deepEqual(h.store.getState().thread, []);

  const h2 = advisorHarness([{ status: 503, body: { error_code: 'advisor_unavailable', reason: 'not_configured' } }]);
  await h2.store.send('Ile dostanę?');
  assert.deepEqual(notices(h2.store.getState()), ['error:advisor_not_configured']);
  assert.deepEqual(advisorTexts(h2.store.getState()), []);
  assert.equal(h2.store.getState().advisorAvailable, false, 'the composer locks after the server says so');
});

test('AI-001 store: provider failure -> the honest notice, no answer; retry resends the same words once', async () => {
  const h = advisorHarness([{ status: 503, body: { error_code: 'advisor_unavailable', reason: 'provider_error' } }, okTurn('MODEL-ANSWER')]);
  await h.store.send('Ile wyszło mi za 4 godziny w nocy?');
  assert.deepEqual(notices(h.store.getState()), ['error:advisor_unavailable']);
  assert.deepEqual(advisorTexts(h.store.getState()), []);
  assert.equal(h.store.getState().lastFailedMessage, 'Ile wyszło mi za 4 godziny w nocy?');
  await h.store.retry();
  assert.deepEqual(h.turnCalls().map((c) => c.body?.message), ['Ile wyszło mi za 4 godziny w nocy?', 'Ile wyszło mi za 4 godziny w nocy?']);
  assert.deepEqual(h.store.getState().thread.map((i) => i.from), ['user', 'notice', 'advisor'], 'the user message is not duplicated');
  assert.equal(h.store.getState().lastFailedMessage, null);
});

test('AI-001 store: an answer withheld by the server (ungrounded amount) is never shown', async () => {
  const h = advisorHarness([{ status: 502, body: { error_code: 'answer_withheld' } }]);
  await h.store.send('Ile zarobię?');
  assert.deepEqual(notices(h.store.getState()), ['error:answer_withheld']);
  assert.deepEqual(advisorTexts(h.store.getState()), []);
});

test('AI-001 store: an expired conversation restarts once, out loud - never a loop', async () => {
  const h = advisorHarness([okTurn('A1', { conversationRef: 'conv-1' }), { status: 409, body: { error_code: 'conversation_invalid' } }, okTurn('A2', { conversationRef: 'conv-9' })]);
  await h.store.send('pierwsze');
  await h.store.send('drugie');
  const calls = h.turnCalls();
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.body?.conversationRef, 'conv-1');
  assert.equal(calls[2]?.body?.conversationRef, undefined, 'asked again in a fresh conversation');
  assert.deepEqual(notices(h.store.getState()), ['info:conversation_restarted']);
  assert.deepEqual(advisorTexts(h.store.getState()), ['A1', 'A2']);

  const h2 = advisorHarness([okTurn('A1', { conversationRef: 'conv-1' }), { status: 409, body: { error_code: 'conversation_invalid' } }, { status: 409, body: { error_code: 'conversation_invalid' } }]);
  await h2.store.send('pierwsze');
  await h2.store.send('drugie');
  assert.equal(h2.turnCalls().length, 3, 'one retry only');
  assert.deepEqual(notices(h2.store.getState()), ['info:conversation_restarted', 'error:conversation_invalid']);
});

test('AI-001 store: documents - only an explicit read sends anything; the advisor gets an opaque reference, never facts or file names', async () => {
  const h = advisorHarness([okTurn('MODEL-ANSWER')], { resolve: resolvedWithContext('ctx-1') });
  h.store.addFiles([pdf('synthetic-payslip-anna.pdf')], 'payslip');
  assert.equal(h.calls.length, 0, 'selecting a file sends nothing');
  await h.store.read();
  assert.deepEqual(h.reads, [{ name: 'synthetic-payslip-anna.pdf', kind: 'payslip' }], 'the existing reader, payslip route');
  const resolve = h.calls.find((c) => c.url === '/api/profile/resolve');
  assert.ok(resolve, 'the existing profile route builds the server-held context');
  assert.deepEqual((resolve.body?.documents as Array<Record<string, unknown>>)[0]?.batchRefs, ['batch-ref-1'], 'sent by reference');
  assert.equal(h.store.getState().documentContextRef, 'ctx-1');
  assert.deepEqual(notices(h.store.getState()), ['info:document_read']);
  await h.store.send('Ile wyszło mi za 4 godziny w nocy?');
  const body = h.turnCalls()[0]?.body;
  assert.deepEqual(body, { message: 'Ile wyszło mi za 4 godziny w nocy?', locale: 'pl', documentContextRef: 'ctx-1' });
  assert.ok(!JSON.stringify(h.turnCalls()).includes('anna'), 'no file name reaches the advisor route');
});

test('AI-001 store: an expired document context is said out loud; the question is asked again without it and the document can be re-read', async () => {
  const h = advisorHarness([{ status: 409, body: { error_code: 'document_context_invalid' } }, okTurn('MODEL-ANSWER')], { resolve: resolvedWithContext('ctx-1') });
  h.store.addFiles([pdf()], 'payslip');
  await h.store.read();
  await h.store.send('Za te 584 to co?');
  const calls = h.turnCalls();
  assert.equal(calls[0]?.body?.documentContextRef, 'ctx-1');
  assert.equal(calls[1]?.body?.documentContextRef, undefined);
  const s = h.store.getState();
  assert.equal(s.documentContextRef, null);
  assert.equal(s.docs[0]?.status, 'selected', 'ready to be read again (an explicit action)');
  assert.deepEqual(notices(s), ['info:document_read', 'info:document_expired']);
  assert.deepEqual(advisorTexts(s), ['MODEL-ANSWER']);
});

test('AI-001 store: unreadable documents and rejected files are reported, never silently used', async () => {
  const h = advisorHarness([], { read: async () => ({ status: 'error', errorCode: 'vision_unavailable' }), resolve: { profile: { fields: {} } } });
  h.store.addFiles([new File(['x'], 'notes.txt', { type: 'text/plain' }), pdf()], 'contract_base');
  assert.deepEqual(h.store.getState().fileErrors, [{ name: 'notes.txt', reason: 'type' }]);
  assert.equal(h.store.getState().docs.length, 1);
  await h.store.read();
  assert.deepEqual(h.reads.map((r) => r.kind), ['contract']);
  const s = h.store.getState();
  assert.equal(s.docs[0]?.status, 'failed');
  assert.equal(s.documentContextRef, null);
  assert.deepEqual(notices(s), ['info:document_failed']);
});

test('AI-001 store: network loss and timeouts map to honest notices', async () => {
  const offline = advisorHarness([new TypeError('Failed to fetch')]);
  await offline.store.send('hej');
  assert.deepEqual(notices(offline.store.getState()), ['error:network']);
  const slow = advisorHarness([Object.assign(new Error('aborted'), { name: 'AbortError' })]);
  await slow.store.send('hej');
  assert.deepEqual(notices(slow.store.getState()), ['error:timeout']);
  const limited = advisorHarness([{ status: 429, body: { error: 'Too many requests' } }]);
  await limited.store.send('hej');
  assert.deepEqual(notices(limited.store.getState()), ['error:rate_limited']);
});

test('AI-001 store: reset forgets the conversation and the documents, keeps what is known about the host', async () => {
  const h = advisorHarness([okTurn('A1', { conversationRef: 'conv-1' })], { resolve: resolvedWithContext() });
  await h.store.checkAvailability();
  h.store.addFiles([pdf()], 'payslip');
  await h.store.read();
  await h.store.send('hej');
  h.store.reset();
  const s = h.store.getState();
  assert.deepEqual([s.thread, s.docs, s.conversationRef, s.documentContextRef], [[], [], null, null]);
  assert.equal(s.advisorAvailable, true);
});

test('AI-001 availability: read from /api/ai/status; anything unclear stays unknown (null), never "available"', async () => {
  const at = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.deepEqual(await fetchAvailability(at(200, { advisorAvailable: true, visionAvailable: false })), { advisor: true, reader: false });
  assert.deepEqual(await fetchAvailability(at(200, { visionAvailable: true })), { advisor: null, reader: true });
  assert.deepEqual(await fetchAvailability(at(500, {})), { advisor: null, reader: null });
  assert.deepEqual(await fetchAvailability((async () => { throw new TypeError('offline'); }) as unknown as typeof fetch), { advisor: null, reader: null });
});

test('AI-001 copy: PL/EN parity; the outage wording the task requires; module statuses never upgraded', () => {
  const keys = (v: unknown, p = ''): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).flatMap(([k, x]) => keys(x, p ? `${p}.${k}` : k)) : [p]);
  assert.deepEqual(keys(ADVISOR_COPY.pl).sort(), keys(ADVISOR_COPY.en).sort());
  assert.match(ADVISOR_COPY.pl.failures.advisor_unavailable, /AI doradca jest chwilowo niedostępny/);
  assert.match(ADVISOR_COPY.pl.unavailableTitle, /AI doradca jest chwilowo niedostępny/);
  assert.equal(ADVISOR_COPY.pl.navigation.status.coming_soon, 'W przygotowaniu');
  for (const lang of ['pl', 'en'] as const) {
    const c = ADVISOR_COPY[lang];
    assert.ok(Object.values(c.failures).every((t) => t.length > 0));
    assert.ok(Object.values(c.info).every((t) => t.length > 0));
    assert.match(c.orientation.note, lang === 'pl' ? /nie jest to Twoja wypłata/ : /not your pay/);
  }
});

test('AI-001 text: paragraphs and bullet lists only; markup is shown as text, never interpreted', () => {
  assert.deepEqual(textBlocks('Pierwszy akapit\nciąg dalszy.\n\n- **jeden**\n- dwa\n\n1. a\n2) b\n\nKoniec <b>x</b>'), [
    { kind: 'p', text: 'Pierwszy akapit ciąg dalszy.' },
    { kind: 'ul', items: ['jeden', 'dwa'] },
    { kind: 'ol', items: ['a', 'b'] },
    { kind: 'p', text: 'Koniec <b>x</b>' },
  ]);
  assert.deepEqual(textBlocks('### Nagłówek\r\nTekst'), [{ kind: 'p', text: 'Nagłówek Tekst' }]);
  assert.deepEqual(textBlocks('   \n\n'), []);
});

// ---------------------------------------------------------------------------------------------
// Containment (source checks)
// ---------------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(here, file), 'utf-8');
const sources = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts') && f !== 'advisor-test-support.ts');
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('AI-001 containment: the advisor screen calls only its own route and the read-only status; documents via the existing helpers', () => {
  const urls = new Set<string>();
  for (const file of sources) for (const m of code(file).matchAll(/['`](\/api\/[^'`]+)['`]/g)) urls.add(m[1] as string);
  assert.deepEqual([...urls].sort(), ['/api/advisor/v1/turn', '/api/ai/status'], 'profile resolve via pro-profile-prefill.ts, reader routes via document-facts-reader.ts');
  assert.deepEqual(sources.filter((f) => /\bfetch\(/.test(code(f))), ['AdvisorPro.tsx'], 'the browser fetch is bound once, in the screen\'s dependencies');
  for (const file of sources) {
    const source = read(file);
    for (const forbidden of ['XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'dangerouslySetInnerHTML', 'innerHTML', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'planDocumentBatches']) assert.ok(!source.includes(forbidden), `${file}: ${forbidden}`);
    assert.ok(!/source:\s*'(document|cao_rule|official_rule|intelligence_memory)'/.test(source), `${file} never builds a verified source`);
  }
});

test('AI-001 containment: the ONLY advisor message the interface creates is the server\'s model answer', () => {
  const store = code('advisor-store.ts');
  assert.equal([...store.matchAll(/push\(\{ from: 'advisor'/g)].length, 1, 'one place adds an advisor message');
  assert.match(store, /push\(\{ from: 'advisor', text: r\.answer\.text,/);
  assert.match(code('advisor-client.ts'), /data\.status === 'ok' && typeof \(data\.answer as \{ text\?: unknown \} \| undefined\)\?\.text === 'string'/, 'no answer text -> a failure, never an empty or made-up answer');
  // The old scripted dialogue engines are not part of the advisor.
  for (const file of sources) for (const banned of ['r3b-turn', 'r3b-flow', 'next-question', 'R3A_COPY', 'r3a-demo', 'scenario/turn']) assert.ok(!read(file).includes(banned), `${file}: ${banned}`);
});

test('FIN-02 hand-off: a payslip read in Payslip Analysis reaches the advisor by its server reference only, said in the thread', async () => {
  const { createAdvisorStore } = await import('./advisor-store.ts');
  const { recordedBackend } = await import('./advisor-test-support.ts');
  const backend = recordedBackend([okTurn('MODEL-ANSWER')]);
  const store = createAdvisorStore({ fetchImpl: backend.fetchImpl, readFacts: async () => ({ status: 'error', errorCode: 'unused' }), today: () => '2026-10-22' }, 'pl', { documentContextRef: 'ctx-from-analysis' });
  assert.deepEqual(notices(store.getState()), ['info:document_from_analysis']);
  await store.send('Za te 584 to co?');
  assert.deepEqual(backend.turnCalls()[0]?.body, { message: 'Za te 584 to co?', locale: 'pl', documentContextRef: 'ctx-from-analysis' });
  assert.match(ADVISOR_COPY.pl.info.document_from_analysis, /bez ponownego wysyłania pliku/);
});
