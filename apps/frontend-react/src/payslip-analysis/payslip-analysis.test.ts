import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparisonState, groupIssues, printedSummary, type ReplayView } from './payslip-analysis.ts';
import { PAYSLIP_COPY } from './payslip-copy.ts';
import type { PrintedFactView } from '../pro-profile-prefill.ts';
import { analysed, FIXTURES, payslipHarness, pdf } from './payslip-test-support.ts';

/**
 * FIN-02 Payslip Analysis - the screen's state and derivations, driven by the RECORDED real backend (fixtures generated
 * by the backend contract test). These prove what is sent, what is shown and what is withheld; the reader itself is
 * the existing adapter (its own tests), and no live provider is involved.
 */

const facts = (name: string) => ((FIXTURES.cases[name]?.resolve as { documentContext: { knowledge: { facts: PrintedFactView[] } } }).documentContext.knowledge.facts);
const replayOf = (name: string) => FIXTURES.cases[name]?.replay as unknown as ReplayView;

test('FIN-02 flow: nothing is sent until the explicit read; then reader -> resolve -> replay, all BY SERVER REFERENCE', async () => {
  const h = payslipHarness('normal');
  await h.store.checkReader();
  h.store.selectFile(pdf('synthetic-payslip-week41.pdf'));
  assert.deepEqual([h.calls.length, h.reads.length], [0, 0], 'selecting a file sends nothing');
  await h.store.read();
  assert.deepEqual(h.reads, [{ name: 'synthetic-payslip-week41.pdf', kind: 'payslip' }], 'the existing reader, payslip route');
  assert.deepEqual(h.calls.map((c) => c.url), ['/api/profile/resolve', '/api/pro/payslip-replay']);
  const refs = h.recorded.read.batchRefs;
  const document = (h.calls[0]?.body?.documents as Array<Record<string, unknown>>)[0];
  assert.deepEqual(document?.batchRefs, refs);
  assert.equal(document?.factBatches, undefined, 'never echoed batch JSON');
  assert.deepEqual(h.calls[1]?.body, { batchRefs: refs }, 'the replay gets the reference only');
  assert.ok(!JSON.stringify(h.calls).includes('synthetic-payslip-week41'), 'no file name leaves the browser');
  const s = h.store.getState();
  assert.equal(s.phase, 'done');
  assert.equal(s.error, null);
  assert.equal(s.contextRef, (h.recorded.resolve as { documentContext: { ref: string } }).documentContext.ref, 'the context the PRO advisor can use');
  assert.equal(s.replay?.source, 'server_reference');
});

test('FIN-02 printed facts: gross, net and payout stay apart; what was not printed is null, never 0; lines keep their labels', () => {
  const normal = printedSummary(facts('normal'));
  assert.deepEqual([normal.gross, normal.net?.value, normal.payout?.value], [null, 509.92, 584.92]);
  assert.deepEqual([normal.period, normal.periodStart, normal.periodEnd], ['week 41/2026', '2026-10-05', '2026-10-11']);
  assert.deepEqual(normal.rates.map((r) => r.value), [15.55]);
  assert.equal(normal.regularHours, 36);
  assert.equal(normal.tax.length, 0, 'no printed tax - nothing invented');
  assert.deepEqual(normal.payLines.map((l) => [l.label, l.hours, l.amount]), [['Loon normaal', 36, 559.8], ['ADV toeslag', null, 8.62]]);
  assert.deepEqual(normal.surcharges.map((s) => [s.label, s.percent]), [['ADV toeslag', 1.54]]);
  assert.deepEqual(normal.reimbursements.map((r) => [r.label, r.value]), [['Onb. Reiskosten', 75]]);
  const full = printedSummary(facts('no_mismatch'));
  assert.ok(full.gross && full.net && full.payout);
  assert.equal(new Set([full.gross?.value, full.net?.value, full.payout?.value]).size, 3, 'three different printed totals, never merged');
  assert.equal(full.tax.length, 1);
  const unknown = printedSummary(facts('unknown_premium'));
  assert.ok(!unknown.payLines.some((l) => l.label === 'Nachttoeslag' && l.amount !== null), 'an unreadable amount is not shown as an amount');
});

test('FIN-02 checks: the comparison with Loonto\'s calculation is shown ONLY when every input was read', () => {
  const normal = comparisonState(replayOf('normal'));
  assert.equal(normal.kind, 'limited', 'no printed tax');
  assert.deepEqual(normal.kind === 'limited' && normal.gaps.map((g) => g.code), ['printed_tax_unknown']);
  assert.equal(comparisonState(replayOf('unknown_premium')).kind, 'limited');
  const partial = comparisonState(replayOf('partial'));
  assert.deepEqual(partial.kind === 'limited' && partial.pagesNotRead, [2], 'an unread page could explain any difference');
  assert.deepEqual(comparisonState(replayOf('no_mismatch')), { kind: 'substantiated', discrepancies: [] });
  // Every input read, but a page was not: still withheld - the unread page could hold the explaining item.
  const pageMissing = { ...replayOf('no_mismatch'), coverage: { totalPages: 2, processedPages: [1], notProcessedPages: [2] } };
  assert.deepEqual(comparisonState(pageMissing), { kind: 'limited', gaps: [], pagesNotRead: [2] });
  const mismatch = comparisonState(replayOf('known_mismatch'));
  assert.equal(mismatch.kind, 'substantiated');
  assert.ok(mismatch.kind === 'substantiated' && mismatch.discrepancies.some((d) => d.code === 'table_tax_mismatch'));
  assert.deepEqual(comparisonState(replayOf('period_unknown')), { kind: 'unavailable', reason: 'period_type_unknown' });
  // The payslip's own arithmetic is a separate group from missing inputs and uncertain readings.
  const groups = groupIssues(replayOf('known_mismatch').needsConfirmation ?? []);
  assert.deepEqual(groups.arithmetic.map((i) => i.code), ['net_does_not_reconcile']);
  assert.deepEqual(groups.gaps, []);
});

test('FIN-02 provider unavailable: no reader on this host -> nothing is read; a reader error is reported, nothing else runs', async () => {
  const none = payslipHarness('normal', { vision: false });
  await none.store.checkReader();
  none.store.selectFile(pdf());
  await none.store.read();
  assert.deepEqual([none.reads.length, none.calls.length, none.store.getState().phase], [0, 0, 'selected']);
  const failing = await analysed('normal', { read: { status: 'error', errorCode: 'reader_provider_error' } });
  assert.deepEqual(failing.store.getState().error, { stage: 'read', code: 'reader_provider_error' });
  assert.deepEqual([failing.calls.length, failing.store.getState().facts], [0, null], 'no facts, no checks after a failed read');
  const thrown = await analysed('normal', { read: async () => { throw new Error('pdf broken'); } });
  assert.deepEqual(thrown.store.getState().error, { stage: 'read', code: 'file_unreadable' });
});

test('FIN-02 server provenance: a read without server references is NOT analysed from browser data', async () => {
  const h = await analysed('normal', { read: { status: 'done', factBatches: [{ forged: true }], coverage: { totalPages: 1, notProcessedPages: [], reason: null } } });
  assert.deepEqual(h.store.getState().error, { stage: 'reference', code: 'server_reference_unavailable' });
  assert.equal(h.calls.length, 0);
});

test('FIN-02 malformed or failed steps: honest, recoverable states (resolve failure, expired reading, tax tables, replay error)', async () => {
  const resolveBad = await analysed('normal', { resolve: { status: 400, body: { error_code: 'invalid_input' } } });
  assert.deepEqual(resolveBad.store.getState().error, { stage: 'facts', code: 'analysis_failed' });
  const expired = await analysed('normal', { replay: { status: 409, body: { error_code: 'document_reference_invalid' } } });
  assert.deepEqual([expired.store.getState().replayProblem, expired.store.getState().facts?.length !== undefined], ['document_expired', true], 'facts still shown');
  const rates = await analysed('normal', { replay: { status: 503, body: { error_code: 'tax_rates_unavailable' } } });
  assert.equal(rates.store.getState().replayProblem, 'tax_rates_unavailable');
  const broken = await analysed('normal', { replay: { status: 200, body: { status: 'ok' } } });
  assert.equal(broken.store.getState().replayProblem, 'replay_failed', 'a malformed replay answer is not trusted');
  // Retrying the analysis re-uses the server-held reading - no new provider call.
  await broken.store.retryAnalysis();
  assert.equal(broken.reads.length, 1);
});

test('FIN-02 files: only the reader\'s types; a rejected file is reported, never read', () => {
  const h = payslipHarness('normal');
  h.store.selectFile(new File(['x'], 'notes.txt', { type: 'text/plain' }));
  assert.deepEqual([h.store.getState().fileError, h.store.getState().file], ['type', null]);
  h.store.selectFile(pdf());
  assert.deepEqual([h.store.getState().phase, h.store.getState().fileError], ['selected', null]);
  h.store.removeFile();
  assert.equal(h.store.getState().phase, 'empty');
});

test('FIN-02 copy: PL/EN parity; past amounts are never a forecast; differences are never proof', () => {
  const keys = (v: unknown, p = ''): string[] => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).flatMap(([k, x]) => keys(x, p ? `${p}.${k}` : k)) : [p]);
  assert.deepEqual(keys(PAYSLIP_COPY.pl).sort(), keys(PAYSLIP_COPY.en).sort());
  assert.match(PAYSLIP_COPY.pl.printedNote, /nie prognoza/);
  assert.match(PAYSLIP_COPY.en.printedNote, /not a forecast/);
  assert.match(PAYSLIP_COPY.pl.notProof, /nie dowód błędu ani naruszenia prawa/);
  assert.match(PAYSLIP_COPY.pl.notRead, /to nie znaczy 0/);
  assert.match(PAYSLIP_COPY.pl.causes.minimum_wage_violation, /nie stwierdza naruszenia/);
});

// ---------------------------------------------------------------------------------------------
// Containment (source checks)
// ---------------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts') && f !== 'payslip-test-support.ts');
const code = (f: string) => readFileSync(path.join(here, f), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('FIN-02 containment: the existing endpoints only, through the existing helpers; no AI text, no storage, no HTML from data', () => {
  const urls = new Set<string>();
  for (const f of sources) for (const m of code(f).matchAll(/['`](\/api\/[^'`]+)['`]/g)) urls.add(m[1] as string);
  assert.deepEqual([...urls].sort(), ['/api/ai/status', '/api/pro/payslip-replay'], 'resolve via pro-profile-prefill.ts, reader routes via document-facts-reader.ts');
  for (const f of sources) {
    const source = readFileSync(path.join(here, f), 'utf-8');
    for (const forbidden of ['dangerouslySetInnerHTML', 'innerHTML', 'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', '/api/advisor', 'groq', 'factBatches:', 'planDocumentBatches']) assert.ok(!source.includes(forbidden), `${f}: ${forbidden}`);
    assert.ok(!/source:\s*'(document|cao_rule|official_rule)'/.test(source), `${f} never builds a verified source`);
  }
  assert.match(code('PayslipAnalysis.tsx'), /readDocumentFacts\(file, kind, browserReaderDeps\(await import\('\.\.\/local-ocr\.ts'\)\)\)/, 'the existing reader, loaded on demand');
});
