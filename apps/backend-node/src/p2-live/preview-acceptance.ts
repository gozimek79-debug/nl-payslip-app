import { createHash } from 'node:crypto';
import type { FactReadRequest } from '../ai-service/gemini-client.js';
import type { PayslipFactsBatch, ContractFactsBatch } from '../payroll-engine/document-facts.js';

/**
 * P2 LIVE (ZADANIE-P2-LIVE-VERCEL.md) - TEMPORARY core of the Preview-only acceptance runner
 * (`api/p2-live-acceptance.ts`). It exists for ONE run of the synthetic P2 corpus through the production
 * Gemini fact readers inside a Vercel Preview runtime, and is removed by the cleanup commit after it.
 *
 * Safety by construction:
 * - it never reads the environment: the handler passes only the facts the gate needs (environment name,
 *   whether a key is configured, the resolved model) - never a value;
 * - the only documents it can send are the frozen synthetic read requests (integrity-checked by hash);
 * - every Gemini request takes a slot from a 7-slot budget first - call #8 is refused, nothing retries;
 * - no new call starts after the first failure;
 * - it emits only allowlisted fields: call metadata and the mapped synthetic fact batch - never an error
 *   message (a transport error can carry a URL), a header or an environment value.
 */

export const EXPECTED_MODEL = 'gemini-3.1-pro-preview';
export const MAX_GEMINI_CALLS = 7;
/** After this instant the runner refuses to run, so the immutable Preview deployment cannot be reused. */
export const RUNNER_EXPIRES_AT = '2026-10-02T23:15:00Z';
export const CONFIRM_HEADER = 'x-p2-live-confirm';
export const CONFIRM_VALUE = 'run-synthetic-corpus-once';
/** The one synthetic corpus this runner may read (scripts/p2-reference/generate-corpus.mjs) and each document's reader. */
export const SYNTHETIC_DOCUMENTS = {
  'payslip-text': 'payslip',
  'payslip-photo': 'payslip',
  'contract-text': 'contract',
  'annex-text': 'contract',
  'contract-scan': 'contract',
} as const;
export type SyntheticDocumentId = keyof typeof SYNTHETIC_DOCUMENTS;

export interface FrozenRequest extends FactReadRequest {
  seq: number;
  doc: SyntheticDocumentId;
  kind: 'payslip' | 'contract';
}

/** Parses the frozen read requests; anything that is not the intact synthetic plan is refused. */
export function loadFrozenRequests(json: string, sha256: string): FrozenRequest[] {
  if (createHash('sha256').update(json).digest('hex') !== sha256) throw new Error('frozen_corpus_integrity');
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_GEMINI_CALLS) throw new Error('frozen_corpus_shape');
  return parsed.map((item: unknown, index): FrozenRequest => {
    const r = item as Partial<FrozenRequest>;
    const doc = r.doc as SyntheticDocumentId;
    const ok = r.seq === index + 1
      && Object.hasOwn(SYNTHETIC_DOCUMENTS, doc) && r.kind === SYNTHETIC_DOCUMENTS[doc]
      && Array.isArray(r.pages) && r.pages.length > 0 && Array.isArray(r.imagePages) && typeof r.totalPages === 'number'
      && Array.isArray(r.images) && r.images.length === r.imagePages.length && r.images.every((img) => typeof img === 'string' && img.startsWith('data:image/jpeg;base64,'))
      && Array.isArray(r.textLines) && r.textLines.every((l) => typeof l?.page === 'number' && typeof l.text === 'string' && r.pages!.includes(l.page));
    if (!ok) throw new Error('frozen_corpus_shape');
    return { seq: r.seq!, doc, kind: r.kind!, pages: r.pages!, imagePages: r.imagePages!, totalPages: r.totalPages!, images: r.images!, textLines: r.textLines! };
  });
}

export interface RuntimeFacts {
  vercelEnv: string | undefined;
  geminiKeyPresent: boolean;
  model: string;
  /** Presence only of the temporary dummy variable proving a value-less env edit keeps a Sensitive value. */
  sensitivePatchProbePresent: boolean;
  now: Date;
}

export type GateRefusal = 'not_preview' | 'runner_expired' | 'gemini_key_missing' | 'model_mismatch' | 'plan_exceeds_budget';

export function gate(rt: RuntimeFacts, plannedCalls: number): GateRefusal | null {
  if (rt.vercelEnv !== 'preview') return 'not_preview';
  if (rt.now.getTime() >= Date.parse(RUNNER_EXPIRES_AT)) return 'runner_expired';
  if (!rt.geminiKeyPresent) return 'gemini_key_missing';
  if (rt.model !== EXPECTED_MODEL) return 'model_mismatch';
  if (plannedCalls > MAX_GEMINI_CALLS) return 'plan_exceeds_budget';
  return null;
}

const KNOWN_ENVIRONMENTS = ['production', 'preview', 'development'];

export function preflight(rt: RuntimeFacts, requests: FrozenRequest[], corpusSha256: string) {
  return {
    runner: 'p2-live-acceptance',
    environment: KNOWN_ENVIRONMENTS.includes(rt.vercelEnv ?? '') ? rt.vercelEnv : 'unknown',
    geminiKeyPresent: rt.geminiKeyPresent,
    sensitivePatchProbePresent: rt.sensitivePatchProbePresent,
    model: rt.model,
    modelLocked: rt.model === EXPECTED_MODEL,
    plannedCalls: requests.length,
    budget: MAX_GEMINI_CALLS,
    callCounter: 0,
    expiresAt: RUNNER_EXPIRES_AT,
    corpusSha256,
    corpus: requests.map((r) => ({ seq: r.seq, doc: r.doc, kind: r.kind, pages: r.pages, imagePages: r.imagePages, images: r.images.length, textLines: r.textLines.length })),
    gate: gate(rt, requests.length) ?? 'ready',
  };
}

/** Hands out at most `max` call slots; the slot is taken BEFORE the request is sent. */
export class CallBudget {
  private used = 0;
  constructor(readonly max: number = MAX_GEMINI_CALLS) {}
  take(): number {
    if (this.used >= this.max) throw new Error('call_budget_exhausted');
    this.used += 1;
    return this.used;
  }
  get count(): number {
    return this.used;
  }
}

export type FactReader = (req: FactReadRequest) => Promise<PayslipFactsBatch | ContractFactsBatch>;

export type ErrorKind = 'http' | 'no_content' | 'invalid_json' | 'network' | 'timeout' | 'other';
export interface SanitizedError {
  name: string;
  kind: ErrorKind;
  httpStatus: number | null;
}

class RunnerWaitTimeout extends Error {
  constructor() {
    super('runner wait timeout');
    this.name = 'TimeoutError';
  }
}

const ERROR_NAMES = ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError'];

/** Classifies a reader failure without forwarding its message (a transport error may carry the request URL). */
export function sanitizeError(error: unknown): SanitizedError {
  const name = error instanceof Error && ERROR_NAMES.includes(error.name) ? error.name : 'Error';
  const message = error instanceof Error ? error.message : '';
  const status = /\bHTTP (\d{3})\b/.exec(message);
  const kind: ErrorKind = error instanceof RunnerWaitTimeout ? 'timeout'
    : status ? 'http'
    : message.startsWith('Gemini returned no extractable content') ? 'no_content'
    : error instanceof SyntaxError ? 'invalid_json'
    : error instanceof TypeError && message === 'fetch failed' ? 'network'
    : 'other';
  return { name, kind, httpStatus: status ? Number(status[1]) : null };
}

export type RunEvent =
  | { type: 'start'; startedAt: string; model: string; plannedCalls: number; budget: number; expiresAt: string }
  | { type: 'call'; seq: number; doc: SyntheticDocumentId; kind: 'payslip' | 'contract'; pages: number[]; imagePages: number[]; callNumber: number; model: string; ms: number; outcome: 'ok' | 'failed'; error: SanitizedError | null; batch: PayslipFactsBatch | ContractFactsBatch | null }
  | { type: 'skipped'; seq: number; doc: SyntheticDocumentId; pages: number[]; reason: 'stopped_after_failure' | 'time_budget' | 'call_budget_exhausted' }
  | { type: 'end'; callsSent: number; callsOk: number; callsFailed: number; stoppedBy: string | null; elapsedMs: number };

export interface RunDeps {
  readPayslip: FactReader;
  readContract: FactReader;
  model: () => string;
  emit: (event: RunEvent) => void;
  now?: () => number;
  /** Longest wait for one reader call before the runner gives up on it and stops. */
  callWaitMs?: number;
  /** Wall-clock budget of the whole run (the function's maxDuration is 300 s). */
  runBudgetMs?: number;
  /** No new call starts with less than this left of the run budget. */
  minStartMs?: number;
  budget?: CallBudget;
}

/**
 * Runs the frozen plan once. The first request is a canary sent alone (it surfaces a key, model or quota
 * failure after one call); the remaining requests then run as one sequential chain per document, the
 * chains concurrently, so the run fits the 300 s function limit. A failure anywhere stops every chain
 * before its next call; calls already in flight finish and are reported.
 */
export async function runAcceptance(requests: FrozenRequest[], deps: RunDeps): Promise<Extract<RunEvent, { type: 'end' }>> {
  const now = deps.now ?? Date.now;
  const callWaitMs = deps.callWaitMs ?? 170_000;
  const runBudgetMs = deps.runBudgetMs ?? 280_000;
  const minStartMs = deps.minStartMs ?? 30_000;
  const budget = deps.budget ?? new CallBudget();
  const t0 = now();
  let stoppedBy: string | null = null;
  let callsOk = 0;
  let callsFailed = 0;
  deps.emit({ type: 'start', startedAt: new Date(t0).toISOString(), model: deps.model(), plannedCalls: requests.length, budget: budget.max, expiresAt: RUNNER_EXPIRES_AT });

  const send = async (r: FrozenRequest): Promise<void> => {
    if (stoppedBy) return deps.emit({ type: 'skipped', seq: r.seq, doc: r.doc, pages: r.pages, reason: 'stopped_after_failure' });
    const left = runBudgetMs - (now() - t0);
    if (left < minStartMs) {
      stoppedBy = 'time_budget';
      return deps.emit({ type: 'skipped', seq: r.seq, doc: r.doc, pages: r.pages, reason: 'time_budget' });
    }
    let callNumber: number;
    try {
      callNumber = budget.take();
    } catch {
      stoppedBy = 'call_budget_exhausted';
      return deps.emit({ type: 'skipped', seq: r.seq, doc: r.doc, pages: r.pages, reason: 'call_budget_exhausted' });
    }
    const read = r.kind === 'payslip' ? deps.readPayslip : deps.readContract;
    const request: FactReadRequest = { images: r.images, imagePages: r.imagePages, pages: r.pages, totalPages: r.totalPages, textLines: r.textLines };
    const started = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const batch = await Promise.race([
        read(request),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RunnerWaitTimeout()), Math.min(callWaitMs, left)); }),
      ]);
      callsOk += 1;
      deps.emit({ type: 'call', seq: r.seq, doc: r.doc, kind: r.kind, pages: r.pages, imagePages: r.imagePages, callNumber, model: deps.model(), ms: now() - started, outcome: 'ok', error: null, batch });
    } catch (error) {
      callsFailed += 1;
      const safe = sanitizeError(error);
      stoppedBy = stoppedBy ?? `${r.doc} pages ${r.pages.join(',')} ${safe.kind}${safe.httpStatus ? ` ${safe.httpStatus}` : ''}`;
      deps.emit({ type: 'call', seq: r.seq, doc: r.doc, kind: r.kind, pages: r.pages, imagePages: r.imagePages, callNumber, model: deps.model(), ms: now() - started, outcome: 'failed', error: safe, batch: null });
    } finally {
      clearTimeout(timer);
    }
  };

  const [canary, ...rest] = requests;
  if (canary) await send(canary);
  const chains = new Map<SyntheticDocumentId, FrozenRequest[]>();
  for (const r of rest) chains.set(r.doc, [...(chains.get(r.doc) ?? []), r]);
  await Promise.all([...chains.values()].map(async (chain) => {
    for (const r of chain) await send(r);
  }));

  const end = { type: 'end' as const, callsSent: budget.count, callsOk, callsFailed, stoppedBy, elapsedMs: now() - t0 };
  deps.emit(end);
  return end;
}
