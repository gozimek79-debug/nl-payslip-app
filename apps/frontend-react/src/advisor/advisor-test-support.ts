import type { DocumentReadOutcome, FactReaderKind } from '../document-facts-reader.ts';
import { createAdvisorStore } from './advisor-store.ts';
import type { AdvisorLocale } from './advisor-client.ts';

/**
 * Test-only (AI-001): a RECORDED backend for the advisor screen - fixed HTTP answers for `/api/advisor/v1/turn`,
 * `/api/ai/status` and `/api/profile/resolve`, every request recorded. It proves what the interface sends, shows and
 * refuses to make up; the answer texts are placeholders and say nothing about the advisor's conversational quality
 * (that is the real model's job, tested separately against the branch Preview).
 */

export type TurnReply = { status: number; body: unknown } | Error;
export interface RecordedCall { url: string; body: Record<string, unknown> | null }

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function okTurn(text: string, extra: Record<string, unknown> = {}): TurnReply {
  return {
    status: 200,
    body: {
      status: 'ok', conversationRef: 'conv-ref', memory: 'server_session', answer: { text, author: 'model' },
      meta: { provider: 'recorded', model: 'recorded-test-model', modelCalls: 1, tools: [], groundingRewrite: false, latencyMs: 5 },
      orientation: null, navigation: [], documentStatus: 'none', ...extra,
    },
  };
}

export function recordedBackend(turns: TurnReply[], options: { status?: unknown; resolve?: unknown; resolveStatus?: number } = {}) {
  const calls: RecordedCall[] = [];
  let next = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ url, body });
    if (url === '/api/ai/status') return json(200, options.status ?? { advisorAvailable: true, visionAvailable: true });
    if (url === '/api/profile/resolve') return json(options.resolveStatus ?? 200, options.resolve ?? {});
    if (url === '/api/advisor/v1/turn') {
      const reply = turns[next++];
      if (reply === undefined) throw new Error('no recorded turn left');
      if (reply instanceof Error) throw reply;
      return json(reply.status, reply.body);
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls, turnCalls: () => calls.filter((c) => c.url === '/api/advisor/v1/turn') };
}

export function advisorHarness(turns: TurnReply[], options: Parameters<typeof recordedBackend>[1] & { read?: (file: File, kind: FactReaderKind) => Promise<DocumentReadOutcome>; lang?: AdvisorLocale } = {}) {
  const backend = recordedBackend(turns, options);
  const reads: Array<{ name: string; kind: FactReaderKind }> = [];
  const store = createAdvisorStore({
    fetchImpl: backend.fetchImpl,
    readFacts: async (file, kind) => {
      reads.push({ name: file.name, kind });
      return options.read ? options.read(file, kind) : { status: 'done', factBatches: [{ synthetic: true }], batchRefs: ['batch-ref-1'], coverage: { totalPages: 1, notProcessedPages: [], reason: null } };
    },
    today: () => '2026-10-21',
  }, options.lang ?? 'pl');
  return { store, reads, ...backend };
}

export const pdf = (name = 'synthetic-payslip.pdf') => new File([new Uint8Array([37, 80, 68, 70])], name, { type: 'application/pdf' });

/** A resolve answer with a server-held document context (as `/api/profile/resolve` returns for documents sent by reference). */
export const resolvedWithContext = (ref = 'doc-context-ref') => ({
  profile: { fields: {} }, extractionTable: [], decisionResults: [], issues: [], readiness: null,
  documentContext: { ref, knowledge: { version: 1, facts: [] } },
});

/**
 * FIN-03: RECORDED engine-result cards in the shape `/api/advisor/v1/turn` returns (`calculation`). The computed one has
 * the figures the backend engine produced for synthetic case D (40 h Mon-Fri x 16 EUR, tax credit applied, deductions
 * estimated by Loonto after the user agreed) - the interface only shows them, it never computes anything.
 */
export const computedCalculation = () => ({
  status: 'computed', resultType: 'calculated_engine_estimate', period: 'week', currency: 'EUR', ratesSource: 'database', ratesAsOf: '2026-10-21',
  figures: { grossTotal: 640, totalTax: 60.14, wageNet: 558.94, payoutAmount: 558.94, hoursWorked: 40 },
  payoutRange: null,
  inputs: [
    { field: 'work.regularWeekdayHours', source: 'user_stated', value: 40, usedByEngine: true },
    { field: 'pay.hourlyRate', source: 'user_stated', value: 16, usedByEngine: true },
    { field: 'tax.loonheffingskorting', source: 'user_stated', value: 'applied', usedByEngine: true },
    { field: 'deductions.mode', source: 'loonto_assumption', value: 'estimate', usedByEngine: true },
  ],
  assumptionsUsed: ['deductions.mode'], warnings: ['assumption_in_use', 'sector_premium_estimated'], missing: [], unsupported: [], invalid: [],
});

export const blockedCalculation = () => ({
  status: 'blocked', resultType: 'calculated_engine_estimate', period: 'week', currency: 'EUR', ratesSource: 'database', ratesAsOf: '2026-10-21',
  figures: null, payoutRange: null,
  inputs: [{ field: 'pay.hourlyRate', source: 'user_stated', value: 16, usedByEngine: false }],
  assumptionsUsed: [], warnings: [],
  missing: [{ field: 'pay.saturdayPremiumPercent', reason: 'missing_required', canOfferAssumption: false }, { field: 'deductions.mode', reason: 'missing_required', canOfferAssumption: true }],
  unsupported: [], invalid: [],
});
