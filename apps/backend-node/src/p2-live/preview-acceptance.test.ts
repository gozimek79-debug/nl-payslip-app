import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  CallBudget, EXPECTED_MODEL, MAX_GEMINI_CALLS, RUNNER_EXPIRES_AT, gate, loadFrozenRequests, preflight, runAcceptance, sanitizeError,
  type FrozenRequest, type RunEvent, type RuntimeFacts,
} from './preview-acceptance.js';
import { FROZEN_REQUESTS_JSON, FROZEN_REQUESTS_SHA256 } from './frozen-requests.js';
import { payslipBatch, contractBatch } from '../test-support/fact-fixtures.js';

/**
 * P2 LIVE (ZADANIE-P2-LIVE-VERCEL.md §3/§5/§6/§8): the temporary Preview runner's gate, synthetic-only
 * corpus, hard 7-call budget, stop-on-failure, and the no-secret / no-env-dump response path.
 */

const SECRET = 'test-only-fake-key-value-must-never-leave';
const before = new Date(Date.parse(RUNNER_EXPIRES_AT) - 60_000);
const ready: RuntimeFacts = { vercelEnv: 'preview', geminiKeyPresent: true, model: EXPECTED_MODEL, sensitivePatchProbePresent: false, now: before };
const frozen = () => loadFrozenRequests(FROZEN_REQUESTS_JSON, FROZEN_REQUESTS_SHA256);

function fakeReaders(fail?: (seq: number) => Error | null) {
  const sent: number[] = [];
  const seqOf = (pages: number[], images: string[]) => frozenBySignature.get(`${pages.join(',')}|${images.join('')}`) ?? 0;
  const read = (kind: 'payslip' | 'contract') => async (req: { pages: number[]; images: string[]; totalPages: number }) => {
    const seq = seqOf(req.pages, req.images);
    sent.push(seq);
    const failure = fail?.(seq);
    if (failure) throw failure;
    return kind === 'payslip' ? payslipBatch(undefined, req.pages, req.totalPages) : contractBatch(undefined, req.pages, req.totalPages);
  };
  return { sent, readPayslip: read('payslip'), readContract: read('contract') };
}
const frozenBySignature = new Map(frozen().map((r) => [`${r.pages.join(',')}|${r.images.join('')}`, r.seq]));

test('P2 LIVE §5: the frozen corpus is exactly the synthetic P2 plan - 5 synthetic documents, 7 reads, integrity-checked', () => {
  const requests = frozen();
  assert.deepEqual(requests.map((r) => [r.seq, r.doc, r.kind, r.pages.join(',')]), [
    [1, 'payslip-text', 'payslip', '1'],
    [2, 'payslip-photo', 'payslip', '1'],
    [3, 'contract-text', 'contract', '1,2,3,4'],
    [4, 'contract-text', 'contract', '5'],
    [5, 'annex-text', 'contract', '1'],
    [6, 'contract-scan', 'contract', '1,2,3'],
    [7, 'contract-scan', 'contract', '4'],
  ]);
  assert.equal(requests.length, MAX_GEMINI_CALLS);
  assert.ok(requests.flatMap((r) => r.textLines).some((l) => l.text.includes('Synthetic Uitzend B.V.')), 'the text layer is the synthetic employer');
  assert.throws(() => loadFrozenRequests(FROZEN_REQUESTS_JSON.replace('Synthetic', 'Synthetik'), FROZEN_REQUESTS_SHA256), /frozen_corpus_integrity/);
  const foreign = JSON.stringify([{ ...JSON.parse(FROZEN_REQUESTS_JSON)[0], doc: 'owner-payslip' }]);
  assert.throws(() => loadFrozenRequests(foreign, createHash('sha256').update(foreign).digest('hex')), /frozen_corpus_shape/, 'a document outside the synthetic set is refused');
});

test('P2 LIVE §3/§7: the gate refuses production, an expired runner, a missing key, another model and an over-budget plan', () => {
  assert.equal(gate(ready, 7), null);
  assert.equal(gate({ ...ready, vercelEnv: 'production' }, 7), 'not_preview');
  assert.equal(gate({ ...ready, vercelEnv: undefined }, 7), 'not_preview');
  assert.equal(gate({ ...ready, now: new Date(RUNNER_EXPIRES_AT) }, 7), 'runner_expired');
  assert.equal(gate({ ...ready, geminiKeyPresent: false }, 7), 'gemini_key_missing');
  assert.equal(gate({ ...ready, model: 'gemini-3-flash-preview' }, 7), 'model_mismatch', 'no fallback to a Flash/Lite model');
  assert.equal(gate(ready, 8), 'plan_exceeds_budget');
});

test('P2 LIVE §6: the budget hands out 7 slots and refuses call #8', () => {
  const budget = new CallBudget();
  for (let i = 1; i <= 7; i += 1) assert.equal(budget.take(), i);
  assert.throws(() => budget.take(), /call_budget_exhausted/);
  assert.equal(budget.count, 7);
});

test('P2 LIVE §6: a full run sends each frozen request exactly once - 7 calls, canary first', async () => {
  const events: RunEvent[] = [];
  const readers = fakeReaders();
  const end = await runAcceptance(frozen(), { ...readers, model: () => EXPECTED_MODEL, emit: (e) => events.push(e) });
  assert.equal(readers.sent[0], 1, 'the canary is sent alone, first');
  assert.deepEqual([...readers.sent].sort(), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(readers.sent.indexOf(3) < readers.sent.indexOf(4) && readers.sent.indexOf(6) < readers.sent.indexOf(7), 'batches of one document stay in page order');
  assert.deepEqual({ sent: end.callsSent, ok: end.callsOk, failed: end.callsFailed, stoppedBy: end.stoppedBy }, { sent: 7, ok: 7, failed: 0, stoppedBy: null });
  assert.equal(events.filter((e) => e.type === 'call').length, 7);
});

test('P2 LIVE §6: more requests than the budget - call #8 is refused, never sent', async () => {
  const requests = frozen();
  const eight: FrozenRequest[] = [...requests, { ...requests[6]!, seq: 8 }];
  const events: RunEvent[] = [];
  const readers = fakeReaders();
  const end = await runAcceptance(eight, { ...readers, model: () => EXPECTED_MODEL, emit: (e) => events.push(e) });
  assert.equal(readers.sent.length, 7);
  assert.equal(end.callsSent, 7);
  assert.ok(events.some((e) => e.type === 'skipped' && e.reason === 'call_budget_exhausted'));
});

test('P2 LIVE §6/§10: a failing canary stops the run after ONE call - nothing retried, nothing else sent', async () => {
  const readers = fakeReaders((seq) => (seq === 1 ? new Error('Gemini generateContent call failed: HTTP 404') : null));
  const events: RunEvent[] = [];
  const end = await runAcceptance(frozen(), { ...readers, model: () => EXPECTED_MODEL, emit: (e) => events.push(e) });
  assert.deepEqual(readers.sent, [1]);
  assert.deepEqual({ sent: end.callsSent, ok: end.callsOk, failed: end.callsFailed }, { sent: 1, ok: 0, failed: 1 });
  assert.equal(end.stoppedBy, 'payslip-text pages 1 http 404');
  assert.equal(events.filter((e) => e.type === 'skipped' && e.reason === 'stopped_after_failure').length, 6);
});

test('P2 LIVE §6: a failure inside a document chain stops that chain before its next call', async () => {
  const readers = fakeReaders((seq) => (seq === 3 ? new TypeError('fetch failed') : null));
  const end = await runAcceptance(frozen(), { ...readers, model: () => EXPECTED_MODEL, emit: () => {} });
  assert.ok(!readers.sent.includes(4), 'contract-text p5 is never sent after p1-4 failed');
  assert.equal(end.callsFailed, 1);
  assert.ok(end.callsSent <= 7);
});

test('P2 LIVE §8: no secret, error message or environment value reaches the response stream or the preflight', async () => {
  const leakyError = new Error(`Gemini generateContent call failed: HTTP 403 https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${SECRET}`);
  const readers = fakeReaders((seq) => (seq === 5 ? leakyError : null));
  const lines: string[] = [];
  await runAcceptance(frozen(), { ...readers, model: () => EXPECTED_MODEL, emit: (e) => lines.push(JSON.stringify(e)) });
  lines.push(JSON.stringify(preflight({ ...ready, sensitivePatchProbePresent: true }, frozen(), FROZEN_REQUESTS_SHA256)));
  const output = lines.join('\n');
  for (const forbidden of [SECRET, 'key=', 'generativelanguage', 'GEMINI_API_KEY', 'Authorization', 'VERCEL_', 'DATABASE_URL', 'process.env']) {
    assert.ok(!output.includes(forbidden), `response path must not contain ${forbidden}`);
  }
  const failed = lines.map((l) => JSON.parse(l) as RunEvent).find((e) => e.type === 'call' && e.outcome === 'failed');
  assert.deepEqual(failed && failed.type === 'call' ? failed.error : null, { name: 'Error', kind: 'http', httpStatus: 403 });
  const allowed = { start: ['type', 'startedAt', 'model', 'plannedCalls', 'budget', 'expiresAt'], call: ['type', 'seq', 'doc', 'kind', 'pages', 'imagePages', 'callNumber', 'model', 'ms', 'outcome', 'error', 'batch'], skipped: ['type', 'seq', 'doc', 'pages', 'reason'], end: ['type', 'callsSent', 'callsOk', 'callsFailed', 'stoppedBy', 'elapsedMs'] } as Record<string, string[]>;
  for (const line of lines.slice(0, -1)) {
    const event = JSON.parse(line) as { type: string };
    assert.deepEqual(Object.keys(event).filter((k) => !allowed[event.type]!.includes(k)), [], `only allowlisted fields in a ${event.type} event`);
  }
  assert.deepEqual(sanitizeError(new Error(`boom ${SECRET}`)), { name: 'Error', kind: 'other', httpStatus: null });
});

test('P2 LIVE §8 source assertion: the handler reads only allowlisted env names, the key only as a boolean, logs nothing, accepts no documents', () => {
  const handler = readFileSync(new URL('../../../../api/p2-live-acceptance.ts', import.meta.url), 'utf-8');
  const core = readFileSync(new URL('../../src/p2-live/preview-acceptance.ts', import.meta.url), 'utf-8');
  assert.ok(!core.includes('process.env'), 'the core never touches the environment');
  const envReads = [...handler.matchAll(/process\.env(\.[A-Z0-9_]+|\b)/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(envReads)].sort(), ['process.env.GEMINI_API_KEY', 'process.env.P2_PATCH_PROBE', 'process.env.VERCEL_ENV']);
  assert.ok(handler.includes('Boolean(process.env.GEMINI_API_KEY)') && handler.split('process.env.GEMINI_API_KEY').length === 2, 'the key is read once, as a presence boolean');
  for (const source of [handler, core]) {
    for (const forbidden of [/console\./, /\.\.\.process\.env/, /JSON\.stringify\(process\.env/, /Object\.(keys|entries|values)\(process\.env/, /readFile/, /req\.on\(/, /req\.body/, /\bfetch\(/, /authorization/i]) {
      assert.ok(!forbidden.test(source), `forbidden pattern ${forbidden} in the runner`);
    }
  }
});
