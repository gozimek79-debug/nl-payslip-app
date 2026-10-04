import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  CallBudget, EXPECTED_MODEL, MAX_GEMINI_CALLS, RUNNER_EXPIRES_AT, gate, loadFrozenRequests, preflight, runAcceptance, sanitizeError,
  authorizeRun, oneShotKey, CONFIRM_VALUE, ONE_SHOT_TTL_SECONDS, P2_LIVE_RUN_ID, patchProbeMatches, P2_PATCH_PROBE_EXPECTED_SHA256,
  type FrozenRequest, type RunEvent, type RuntimeFacts,
} from './preview-acceptance.js';
import { upstashOneShotStore, OneShotStoreError, type OneShotStore, type AcquireResult } from './one-shot-store.js';
import { FROZEN_REQUESTS_JSON, FROZEN_REQUESTS_SHA256 } from './frozen-requests.js';
import { payslipBatch, contractBatch, rawPayslip } from '../test-support/fact-fixtures.js';
import { extractPayslipFacts, extractContractFacts, type FactReadRequest, type FactReadOptions } from '../ai-service/gemini-client.js';

/**
 * P2 LIVE (ZADANIE-P2-LIVE-VERCEL.md §3/§5/§6/§8): the temporary Preview runner's gate, synthetic-only
 * corpus, hard 7-call budget, stop-on-failure, and the no-secret / no-env-dump response path.
 */

const SECRET = 'test-only-fake-key-value-must-never-leave';
const before = new Date(Date.parse(RUNNER_EXPIRES_AT) - 60_000);
const ready: RuntimeFacts = { vercelEnv: 'preview', geminiKeyPresent: true, model: EXPECTED_MODEL, sensitivePatchProbePresent: false, sensitivePatchProbeMatches: false, oneShotStoreConfigured: true, now: before };
const frozen = () => loadFrozenRequests(FROZEN_REQUESTS_JSON, FROZEN_REQUESTS_SHA256);

function fakeReaders(fail?: (seq: number) => Error | null) {
  const sent: number[] = [];
  const seqOf = (pages: number[], images: string[]) => frozenBySignature.get(`${pages.join(',')}|${images.join('')}`) ?? 0;
  const read = (kind: 'payslip' | 'contract') => async (req: { pages: number[]; images: string[]; totalPages: number }, _options?: FactReadOptions) => {
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
  for (const forbidden of [SECRET, 'key=', 'generativelanguage', 'GEMINI_API_KEY', 'Authorization', 'VERCEL_', 'DATABASE_URL', 'process.env', 'upstash', 'P2_LOCK', 'loonto:p2-live']) {
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
  assert.deepEqual([...new Set(envReads)].sort(), ['process.env.GEMINI_API_KEY', 'process.env.P2_LOCK_REDIS_TOKEN', 'process.env.P2_LOCK_REDIS_URL', 'process.env.P2_PATCH_PROBE', 'process.env.VERCEL_ENV']);
  assert.ok(handler.includes('Boolean(process.env.GEMINI_API_KEY)') && handler.split('process.env.GEMINI_API_KEY').length === 2, 'the key is read once, as a presence boolean');
  for (const source of [handler, core]) {
    for (const forbidden of [/console\./, /\.\.\.process\.env/, /JSON\.stringify\(process\.env/, /Object\.(keys|entries|values)\(process\.env/, /readFile/, /req\.on\(/, /req\.body/, /\bfetch\(/, /authorization/i]) {
      assert.ok(!forbidden.test(source), `forbidden pattern ${forbidden} in the runner`);
    }
  }
});

// --- P2 LIVE.1 (ZADANIE-P2-LIVE.1-SECURITY-FIX.md §2/§8, Cursor P2LR-02): a timeout cancels the request ---

/** A reader whose request for one sequence number never answers on its own: it only ends when its signal
 * aborts, and then settles a little later (like a torn-down socket) - recorded so the test can see order. */
function hangingReaders(hangSeq: number, log: string[], settleDelayMs = 25) {
  const fast = fakeReaders();
  const signals = new Map<number, AbortSignal>();
  const calls = new Map<number, number>();
  const wrap = (inner: typeof fast.readPayslip) => async (req: FactReadRequest, options: FactReadOptions) => {
    const seq = frozenBySignature.get(`${req.pages.join(',')}|${req.images.join('')}`) ?? 0;
    calls.set(seq, (calls.get(seq) ?? 0) + 1);
    if (seq !== hangSeq) return inner(req, options);
    signals.set(seq, options.signal!);
    log.push(`started-${seq}`);
    return new Promise<never>((_, reject) => {
      options.signal!.addEventListener('abort', () => {
        log.push(`abort-observed-${seq}`);
        setTimeout(() => { log.push(`settled-${seq}`); reject(new DOMException('This operation was aborted', 'AbortError')); }, settleDelayMs);
      });
    });
  };
  return { signals, calls, readPayslip: wrap(fast.readPayslip), readContract: wrap(fast.readContract) };
}

test('P2 LIVE.1 P2LR-02: a canary timeout aborts the signal the reader received, waits for it to settle, uses one slot, no retry, nothing else starts', async () => {
  const log: string[] = [];
  const readers = hangingReaders(1, log);
  const events: RunEvent[] = [];
  const end = await runAcceptance(frozen(), { ...readers, model: () => EXPECTED_MODEL, callWaitMs: 30, emit: (e) => { events.push(e); log.push(`emit-${e.type}`); } });
  assert.equal(readers.signals.get(1)?.aborted, true, 'the timer aborted the signal handed to the reader');
  assert.deepEqual([...readers.calls.entries()], [[1, 1]], 'one request, never retried, nothing else sent');
  assert.ok(log.indexOf('settled-1') < log.indexOf('emit-call'), 'the timed-out call is reported only after the request settled');
  assert.ok(log.indexOf('settled-1') < log.indexOf('emit-end'), 'final accounting happens after the aborted request settled');
  const call = events.find((e) => e.type === 'call');
  assert.deepEqual(call && call.type === 'call' ? [call.callNumber, call.outcome, call.error, call.batch] : null, [1, 'failed', { name: 'AbortError', kind: 'timeout', httpStatus: null }, null]);
  assert.deepEqual({ sent: end.callsSent, ok: end.callsOk, failed: end.callsFailed, stoppedBy: end.stoppedBy }, { sent: 1, ok: 0, failed: 1, stoppedBy: 'payslip-text pages 1 timeout' });
  assert.equal(events.filter((e) => e.type === 'skipped' && e.reason === 'stopped_after_failure').length, 6);
});

test('P2 LIVE.1 P2LR-02: a timeout inside a document chain is one slot, and that chain never starts its next call', async () => {
  const log: string[] = [];
  const readers = hangingReaders(3, log);
  const end = await runAcceptance(frozen(), { ...readers, model: () => EXPECTED_MODEL, callWaitMs: 40, emit: (e) => log.push(`emit-${e.type}`) });
  assert.equal(readers.signals.get(3)?.aborted, true);
  assert.equal(readers.calls.get(3), 1, 'no retry of the timed-out request');
  assert.equal(readers.calls.get(4), undefined, 'contract-text p5 is never started after p1-4 timed out');
  assert.equal(end.callsFailed, 1);
  assert.equal(end.callsSent, [...readers.calls.values()].reduce((a, b) => a + b, 0), 'every started request holds exactly one slot');
  assert.ok(log.indexOf('settled-3') < log.indexOf('emit-end'));
});

test('P2 LIVE.1 P2LR-02: a reader that ignores the abort and succeeds late still cannot report success', async () => {
  const lateSuccess = async (req: FactReadRequest) => {
    await new Promise((r) => setTimeout(r, 40));
    return payslipBatch(undefined, req.pages, req.totalPages);
  };
  const events: RunEvent[] = [];
  const end = await runAcceptance(frozen().slice(0, 1), { readPayslip: lateSuccess, readContract: lateSuccess, model: () => EXPECTED_MODEL, callWaitMs: 10, emit: (e) => events.push(e) });
  const call = events.find((e) => e.type === 'call');
  assert.deepEqual(call && call.type === 'call' ? [call.outcome, call.error?.kind, call.batch] : null, ['failed', 'timeout', null], 'the late result is discarded, never emitted');
  assert.deepEqual({ ok: end.callsOk, failed: end.callsFailed }, { ok: 0, failed: 1 });
});

async function withMockedGemini<T>(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, body: () => Promise<T>): Promise<T> {
  const saved = { fetch: globalThis.fetch, key: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
  globalThis.fetch = fetchImpl as typeof fetch;
  process.env.GEMINI_API_KEY = SECRET;
  delete process.env.GEMINI_MODEL;
  try {
    return await body();
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.key;
    if (saved.model !== undefined) process.env.GEMINI_MODEL = saved.model;
  }
}

test('P2 LIVE.1 P2LR-02: through the real fact reader, the runner timeout aborts the actual fetch (mocked - no network)', async () => {
  const seen: { signal?: AbortSignal | null; count: number } = { count: 0 };
  const events: RunEvent[] = [];
  const end = await withMockedGemini((_url, init) => {
    seen.count += 1;
    seen.signal = init.signal;
    return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError'))));
  }, () => runAcceptance(frozen(), { readPayslip: extractPayslipFacts, readContract: extractContractFacts, model: () => EXPECTED_MODEL, callWaitMs: 20, emit: (e) => events.push(e) }));
  assert.equal(seen.signal?.aborted, true, 'fetch received the runner signal and saw it aborted');
  assert.equal(seen.count, 1, 'one fetch, no retry, nothing after the canary');
  assert.deepEqual({ sent: end.callsSent, failed: end.callsFailed, stoppedBy: end.stoppedBy }, { sent: 1, failed: 1, stoppedBy: 'payslip-text pages 1 timeout' });
  assert.ok(!events.map((e) => JSON.stringify(e)).join('\n').includes(SECRET));
});

test('P2 LIVE.1 P2LR-02: production callers that pass no signal are unchanged - same fetch request, no signal, same result', async () => {
  const inits: RequestInit[] = [];
  const answer = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(rawPayslip()) }] }, finishReason: 'STOP' }] }), { status: 200 });
  const req: FactReadRequest = { images: [], imagePages: [], pages: [1], totalPages: 1, textLines: [{ page: 1, text: 'Uurloon 16,20' }] };
  const [plain, withSignal] = await withMockedGemini(async (_url, init) => { inits.push(init); return answer(); }, async () => [
    await extractPayslipFacts(req),
    await extractPayslipFacts(req, { signal: new AbortController().signal }),
  ]);
  assert.equal('signal' in inits[0]!, false, 'no signal key at all when the caller supplies none');
  assert.deepEqual(Object.keys(inits[0]!).sort(), ['body', 'headers', 'method']);
  assert.equal(inits[1]!.signal instanceof AbortSignal, true);
  assert.deepEqual(plain, withSignal, 'the optional signal does not change what is read');
  assert.equal(extractPayslipFacts.length, 1, 'one required parameter - existing single-argument callers still type-check');
  assert.equal(extractContractFacts.length, 1);
});

// --- P2 LIVE.3 (ZADANIE-P2-LIVE.3-EPHEMERAL-UPSTASH.md §5-§10/§13, Cursor P2LR-01): one run in total ---

const TEST_REDIS = { url: 'https://example-lock-test.upstash.io', token: 'test-only-fake-redis-token-must-never-leave' };

/** An in-memory stand-in for the external Redis: the check and the set happen in one synchronous step after
 * the (simulated) network hop, exactly as Redis executes SET NX atomically - so Promise.all races are real. */
function atomicFakeStore(log: string[] = []) {
  const keys = new Map<string, number>();
  let attempts = 0;
  const store: OneShotStore = {
    async acquire(key, ttlSeconds) {
      attempts += 1;
      log.push('lock-attempt');
      await new Promise((r) => setTimeout(r, Math.random() * 5));
      if (keys.has(key)) return 'already_consumed';
      keys.set(key, ttlSeconds);
      return 'acquired';
    },
  };
  return { store, keys, attempts: () => attempts };
}

/** The handler's POST path in miniature: authorize (gates, then lock), and only on ok run the frozen plan. */
async function postOnce(store: OneShotStore | null, readers: { readPayslip: never | ((...a: never[]) => unknown); readContract: never | ((...a: never[]) => unknown) } & Record<string, unknown>, overrides: Partial<RuntimeFacts> = {}, callWaitMs?: number) {
  const decision = await authorizeRun({ rt: { ...ready, ...overrides }, method: 'POST', confirmation: CONFIRM_VALUE, plannedCalls: 7, corpusSha256: FROZEN_REQUESTS_SHA256, store });
  if (!decision.ok) return decision;
  await runAcceptance(frozen(), { readPayslip: readers.readPayslip as never, readContract: readers.readContract as never, model: () => EXPECTED_MODEL, emit: () => {}, ...(callWaitMs ? { callWaitMs } : {}) });
  return decision;
}

test('P2 LIVE.3 one-shot #8/#9: the first valid POST acquires and runs; a second sequential POST is refused before any reader', async () => {
  const lock = atomicFakeStore();
  const readers = fakeReaders();
  assert.deepEqual(await postOnce(lock.store, readers), { ok: true });
  assert.equal(readers.sent.length, 7);
  assert.deepEqual([...lock.keys.entries()], [[`loonto:p2-live:${P2_LIVE_RUN_ID}:${FROZEN_REQUESTS_SHA256}`, ONE_SHOT_TTL_SECONDS]], 'key = purpose + stable run id + corpus hash; TTL 72 h');
  assert.equal(ONE_SHOT_TTL_SECONDS, 259_200);
  const again = fakeReaders();
  assert.deepEqual(await postOnce(lock.store, again), { ok: false, status: 409, refused: 'run_already_consumed' });
  assert.equal(again.sent.length, 0, '0 Gemini calls for the refused request');
});

test('P2 LIVE.3 one-shot #10: concurrent valid POSTs - exactly one acquires and runs', async () => {
  const lock = atomicFakeStore();
  const readers = fakeReaders();
  const results = await Promise.all(Array.from({ length: 6 }, () => postOnce(lock.store, readers)));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok && r.status === 409).length, 5);
  assert.equal(readers.sent.length, 7, 'one run of 7 calls in total, not 6 x 7');
});

test('P2 LIVE.3 one-shot #11/#12/#13: retry after a disconnect, after a failed run or after a timed-out run cannot reacquire', async () => {
  // disconnect: the run was authorized and started; the client is gone; the retry is refused
  const disconnected = atomicFakeStore();
  assert.equal((await authorizeRun({ rt: ready, method: 'POST', confirmation: CONFIRM_VALUE, plannedCalls: 7, corpusSha256: FROZEN_REQUESTS_SHA256, store: disconnected.store })).ok, true);
  const retry = fakeReaders();
  assert.deepEqual(await postOnce(disconnected.store, retry), { ok: false, status: 409, refused: 'run_already_consumed' });
  assert.equal(retry.sent.length, 0);
  // failure: the canary fails; the lock stays consumed
  const failed = atomicFakeStore();
  assert.deepEqual(await postOnce(failed.store, fakeReaders(() => new Error('Gemini generateContent call failed: HTTP 503'))), { ok: true });
  assert.deepEqual(await postOnce(failed.store, fakeReaders()), { ok: false, status: 409, refused: 'run_already_consumed' });
  // timeout: the canary is aborted; the lock stays consumed
  const timedOut = atomicFakeStore();
  assert.deepEqual(await postOnce(timedOut.store, hangingReaders(1, [], 5), {}, 15), { ok: true });
  assert.deepEqual(await postOnce(timedOut.store, fakeReaders()), { ok: false, status: 409, refused: 'run_already_consumed' });
});

test('P2 LIVE.3 one-shot #14: a store error or timeout fails closed - 503, no reader call', async () => {
  for (const failure of [new OneShotStoreError('unreachable'), new OneShotStoreError('timeout'), new Error('anything')]) {
    const readers = fakeReaders();
    const broken: OneShotStore = { acquire: async () => { throw failure; } };
    assert.deepEqual(await postOnce(broken, readers), { ok: false, status: 503, refused: 'one_shot_store_unavailable' });
    assert.equal(readers.sent.length, 0);
  }
  const odd: OneShotStore = { acquire: async () => 'maybe' as unknown as AcquireResult };
  assert.deepEqual(await postOnce(odd, fakeReaders()), { ok: false, status: 503, refused: 'one_shot_store_unavailable' }, 'only an explicit "acquired" opens the run');
});

test('P2 LIVE.3 one-shot #16: the lock is claimed before any reader call', async () => {
  const log: string[] = [];
  const lock = atomicFakeStore(log);
  const inner = fakeReaders();
  const logged = (read: typeof inner.readPayslip) => async (req: FactReadRequest, options?: FactReadOptions) => { log.push('reader'); return read(req, options); };
  await postOnce(lock.store, { readPayslip: logged(inner.readPayslip), readContract: logged(inner.readContract) });
  assert.equal(log[0], 'lock-attempt');
  assert.equal(log.indexOf('lock-attempt'), log.lastIndexOf('lock-attempt'), 'one lock attempt per POST');
  assert.ok(log.indexOf('reader') > 0);
});

test('P2 LIVE.3 one-shot #17/#18: invalid requests, failed gates, a missing store and the preflight never consume the lock', async () => {
  const lock = atomicFakeStore();
  const base = { method: 'POST', confirmation: CONFIRM_VALUE as string | undefined, plannedCalls: 7, corpusSha256: FROZEN_REQUESTS_SHA256, store: lock.store as OneShotStore | null };
  const cases: Array<[Parameters<typeof authorizeRun>[0], number, string]> = [
    [{ ...base, rt: { ...ready, vercelEnv: 'production' } }, 403, 'not_preview'],
    [{ ...base, rt: ready, method: 'PUT' }, 405, 'method_not_allowed'],
    [{ ...base, rt: ready, confirmation: undefined }, 400, 'confirmation_missing'],
    [{ ...base, rt: { ...ready, now: new Date(RUNNER_EXPIRES_AT) } }, 412, 'runner_expired'],
    [{ ...base, rt: { ...ready, geminiKeyPresent: false } }, 412, 'gemini_key_missing'],
    [{ ...base, rt: { ...ready, model: 'gemini-3-flash-preview' } }, 412, 'model_mismatch'],
    [{ ...base, rt: ready, plannedCalls: 8 }, 412, 'plan_exceeds_budget'],
    [{ ...base, rt: { ...ready, oneShotStoreConfigured: false } }, 412, 'one_shot_store_not_configured'],
    [{ ...base, rt: ready, store: null }, 412, 'one_shot_store_not_configured'],
  ];
  for (const [input, status, refused] of cases) assert.deepEqual(await authorizeRun(input), { ok: false, status, refused });
  preflight(ready, frozen(), FROZEN_REQUESTS_SHA256);
  assert.equal(lock.attempts(), 0, 'none of these touched the lock');
  assert.deepEqual(await authorizeRun({ ...base, rt: ready }), { ok: true }, 'so the valid request still gets the one run');
  const pre = preflight(ready, frozen(), FROZEN_REQUESTS_SHA256);
  assert.equal(pre.oneShotStoreConfigured, true);
  assert.equal(pre.runId, P2_LIVE_RUN_ID);
});

/** A stand-in for the Upstash REST endpoint with real SET NX EX semantics over one shared keyspace. */
function fakeUpstash() {
  const keyspace = new Map<string, string>();
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    if (init.headers && (init.headers as Record<string, string>).Authorization !== `Bearer ${TEST_REDIS.token}`) return new Response(JSON.stringify({ error: 'WRONGPASS' }), { status: 401 });
    const [cmd, key, value, nx, ex, ttl] = JSON.parse(String(init.body)) as string[];
    if (cmd !== 'SET' || nx !== 'NX' || ex !== 'EX' || !/^\d+$/.test(ttl ?? '')) return new Response(JSON.stringify({ error: 'ERR syntax' }), { status: 400 });
    if (keyspace.has(key!)) return new Response(JSON.stringify({ result: null }), { status: 200 });
    keyspace.set(key!, value!);
    return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { keyspace, requests, fetchImpl };
}

test('P2 LIVE.3 adapter: sends exactly SET key marker NX EX ttl to the Upstash origin; OK -> acquired, null -> already_consumed', async () => {
  const upstash = fakeUpstash();
  const store = upstashOneShotStore(TEST_REDIS, { fetchImpl: upstash.fetchImpl });
  const key = oneShotKey(FROZEN_REQUESTS_SHA256);
  assert.equal(await store.acquire(key, ONE_SHOT_TTL_SECONDS), 'acquired');
  assert.equal(await store.acquire(key, ONE_SHOT_TTL_SECONDS), 'already_consumed');
  assert.equal(upstash.requests[0]!.url, 'https://example-lock-test.upstash.io');
  assert.equal(upstash.requests[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(upstash.requests[0]!.init.body)), ['SET', key, 'consumed', 'NX', 'EX', '259200']);
  assert.deepEqual([...upstash.keyspace.keys()], [key], 'the store holds nothing but the lock marker');
});

test('P2 LIVE.3 adapter: separate instances (cold starts) share the external authority - exactly one acquires', async () => {
  const upstash = fakeUpstash();
  const key = oneShotKey(FROZEN_REQUESTS_SHA256);
  const results = await Promise.all(Array.from({ length: 8 }, () => upstashOneShotStore(TEST_REDIS, { fetchImpl: upstash.fetchImpl }).acquire(key, ONE_SHOT_TTL_SECONDS)));
  assert.deepEqual(results.filter((r) => r === 'acquired').length, 1);
  assert.deepEqual(results.filter((r) => r === 'already_consumed').length, 7);
});

test('P2 LIVE.3 adapter #15: malformed, error, non-200 and ambiguous replies all fail closed', async () => {
  const replies: Array<[() => Response, string]> = [
    [() => new Response('not json', { status: 200 }), 'malformed_reply'],
    [() => new Response(JSON.stringify({}), { status: 200 }), 'malformed_reply'],
    [() => new Response(JSON.stringify({ result: 'QUEUED' }), { status: 200 }), 'malformed_reply'],
    [() => new Response(JSON.stringify({ result: 1 }), { status: 200 }), 'malformed_reply'],
    [() => new Response(JSON.stringify({ result: 'OK', error: 'x' }), { status: 200 }), 'malformed_reply'],
    [() => new Response(JSON.stringify(['OK']), { status: 200 }), 'malformed_reply'],
    [() => new Response(JSON.stringify(null), { status: 200 }), 'malformed_reply'],
    [() => new Response(JSON.stringify({ error: 'ERR' }), { status: 400 }), 'http_status'],
    [() => new Response(JSON.stringify({ result: 'OK' }), { status: 500 }), 'http_status'],
  ];
  for (const [make, code] of replies) {
    const store = upstashOneShotStore(TEST_REDIS, { fetchImpl: (async () => make()) as unknown as typeof fetch });
    await assert.rejects(store.acquire(oneShotKey(FROZEN_REQUESTS_SHA256), ONE_SHOT_TTL_SECONDS), (e: unknown) => e instanceof OneShotStoreError && e.code === code);
    assert.deepEqual(await postOnce(store, fakeReaders()), { ok: false, status: 503, refused: 'one_shot_store_unavailable' });
  }
});

test('P2 LIVE.3 adapter: unreachable, timeout and invalid configuration fail closed - and errors never carry the URL or token', async () => {
  const seen: { signal?: AbortSignal | null } = {};
  const hanging = upstashOneShotStore(TEST_REDIS, { timeoutMs: 15, fetchImpl: ((_u: string, init: RequestInit) => { seen.signal = init.signal; return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))); }) as unknown as typeof fetch });
  const unreachable = upstashOneShotStore(TEST_REDIS, { fetchImpl: (async () => { throw new TypeError(`fetch failed ${TEST_REDIS.url} ${TEST_REDIS.token}`); }) as unknown as typeof fetch });
  let sent = 0;
  const counting = (async () => { sent += 1; return new Response(JSON.stringify({ result: 'OK' })); }) as unknown as typeof fetch;
  const invalid = [
    { url: 'http://example-lock-test.upstash.io', token: TEST_REDIS.token },
    { url: 'https://attacker.example.com', token: TEST_REDIS.token },
    { url: 'https://user:pass@example-lock-test.upstash.io', token: TEST_REDIS.token },
    { url: 'not a url', token: TEST_REDIS.token },
    { url: TEST_REDIS.url, token: '' },
  ];
  const errors: unknown[] = [];
  for (const [store, code] of [[hanging, 'timeout'], [unreachable, 'unreachable']] as const) {
    await assert.rejects(store.acquire(oneShotKey(FROZEN_REQUESTS_SHA256), ONE_SHOT_TTL_SECONDS), (e: unknown) => { errors.push(e); return e instanceof OneShotStoreError && e.code === code; });
  }
  assert.equal(seen.signal?.aborted, true, 'the store request itself is aborted on timeout');
  for (const config of invalid) {
    await assert.rejects(upstashOneShotStore(config, { fetchImpl: counting }).acquire(oneShotKey(FROZEN_REQUESTS_SHA256), ONE_SHOT_TTL_SECONDS), (e: unknown) => { errors.push(e); return e instanceof OneShotStoreError && e.code === 'invalid_config'; });
  }
  await assert.rejects(upstashOneShotStore(TEST_REDIS, { fetchImpl: counting }).acquire('some:other:key', 60), (e: unknown) => e instanceof OneShotStoreError && e.code === 'invalid_request', 'no route to arbitrary keys');
  assert.equal(sent, 0, 'the token is never sent to a non-https or non-upstash.io host');
  for (const e of errors) {
    const text = `${(e as Error).message} ${(e as Error).stack ?? ''} ${JSON.stringify(e)}`;
    assert.ok(!text.includes(TEST_REDIS.token) && !text.includes('example-lock-test') && !text.includes('attacker'), 'store errors carry a code only');
  }
});

test('P2 LIVE.3 source assertion: the lock adapter logs nothing, reads no environment, and exposes no command but SET NX EX', () => {
  const adapter = readFileSync(new URL('../../src/p2-live/one-shot-store.ts', import.meta.url), 'utf-8');
  assert.ok(!/process\.env/.test(adapter) && !/console\./.test(adapter), 'credentials arrive as arguments; nothing is logged');
  assert.deepEqual([...adapter.matchAll(/'(SET|GET|DEL|EVAL|FLUSHALL|KEYS|SCAN|EXPIRE|PERSIST)'/g)].map((m) => m[1]), ['SET'], 'the only Redis command is the atomic SET');
  assert.ok(/'NX', 'EX'/.test(adapter));
  const handler = readFileSync(new URL('../../../../api/p2-live-acceptance.ts', import.meta.url), 'utf-8');
  assert.equal(handler.split('process.env.P2_LOCK_REDIS_TOKEN').length, 3, 'the token is read for the presence boolean and for the adapter, nowhere else');
  assert.ok(handler.indexOf('authorizeRun(') < handler.indexOf('runAcceptance('), 'the run starts only after authorization');
});

// --- P2 LIVE.6 (ZADANIE-P2-LIVE.6-PROBE-EXPIRY.md §3/§4): dummy-probe exact-value proof, boolean only ---

const PROBE_MARKER = 'p2-patch-probe-v1-cd99a44d3600da9e5fb52ebb5eddaf76a297f47af879bd6ad84f48604f4fe830';

test('P2 LIVE.6 probe #1-#3: the exact dummy marker matches; any other value or a missing value does not', () => {
  assert.equal(createHash('sha256').update(PROBE_MARKER).digest('hex'), P2_PATCH_PROBE_EXPECTED_SHA256, 'the committed hash is the task-defined marker hash');
  assert.equal(patchProbeMatches(PROBE_MARKER), true);
  for (const other of [`${PROBE_MARKER} `, PROBE_MARKER.toUpperCase(), PROBE_MARKER.slice(0, -1), 'p2-patch-probe-v1', P2_PATCH_PROBE_EXPECTED_SHA256]) {
    assert.equal(patchProbeMatches(other), false, 'a different value never matches');
  }
  for (const missing of [undefined, '']) {
    assert.equal(Boolean(missing), false, 'presence is false for a missing probe');
    assert.equal(patchProbeMatches(missing), false, 'and so is the match');
  }
});

test('P2 LIVE.6 probe #4/#5: the preflight carries two booleans only - never the marker or any hash of it', () => {
  for (const [present, matches] of [[true, true], [true, false], [false, false]] as const) {
    const pre = preflight({ ...ready, sensitivePatchProbePresent: present, sensitivePatchProbeMatches: matches }, frozen(), FROZEN_REQUESTS_SHA256);
    assert.deepEqual([pre.sensitivePatchProbePresent, pre.sensitivePatchProbeMatches], [present, matches]);
    assert.equal(typeof pre.sensitivePatchProbeMatches, 'boolean');
    const json = JSON.stringify(pre);
    for (const forbidden of [PROBE_MARKER, 'p2-patch-probe', P2_PATCH_PROBE_EXPECTED_SHA256, 'P2_PATCH_PROBE']) assert.ok(!json.includes(forbidden), `preflight must not contain ${forbidden}`);
  }
});

test('P2 LIVE.6 probe #7: POST authorization ignores the probe - same decision whether it matches or not', async () => {
  for (const matches of [true, false]) {
    const lock = atomicFakeStore();
    assert.deepEqual(await authorizeRun({ rt: { ...ready, sensitivePatchProbePresent: matches, sensitivePatchProbeMatches: matches }, method: 'POST', confirmation: CONFIRM_VALUE, plannedCalls: 7, corpusSha256: FROZEN_REQUESTS_SHA256, store: lock.store }), { ok: true });
    assert.deepEqual(await authorizeRun({ rt: { ...ready, geminiKeyPresent: false, sensitivePatchProbeMatches: matches }, method: 'POST', confirmation: CONFIRM_VALUE, plannedCalls: 7, corpusSha256: FROZEN_REQUESTS_SHA256, store: lock.store }), { ok: false, status: 412, refused: 'gemini_key_missing' });
  }
});

test('P2 LIVE.6 probe #6/#8/#9 source assertion: only the dummy is hashed, in the handler, and GET returns before any lock or reader', () => {
  const handler = readFileSync(new URL('../../../../api/p2-live-acceptance.ts', import.meta.url), 'utf-8');
  const core = readFileSync(new URL('../../src/p2-live/preview-acceptance.ts', import.meta.url), 'utf-8');
  assert.equal([...handler.matchAll(/patchProbeMatches\(([^)]*)\)/g)].map((m) => m[1]).join('|'), 'process.env.P2_PATCH_PROBE', 'the hash check receives the dummy and nothing else');
  assert.equal(handler.split('process.env.P2_PATCH_PROBE').length, 3, 'the dummy is read for presence and for the match, nowhere else');
  assert.ok(!/createHash/.test(handler), 'the handler hashes nothing itself');
  assert.equal(core.split('createHash(').length, 3, 'the core hashes only the frozen corpus and the dummy probe');
  const getBranch = handler.indexOf("req.method === 'GET'");
  assert.ok(getBranch > 0 && getBranch < handler.indexOf('authorizeRun(') && getBranch < handler.indexOf('runAcceptance('), 'GET returns the preflight before the lock and before any reader');
  assert.ok(!/Object\.(keys|entries|values)\(process\.env|\.\.\.process\.env|JSON\.stringify\(process\.env/.test(handler + core), 'no environment enumeration');
});
