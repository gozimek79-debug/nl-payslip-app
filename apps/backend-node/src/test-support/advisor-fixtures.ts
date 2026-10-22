import type { AdvisorModel, ModelRequest, ModelResponse } from '../advisor/advisor-model.js';
import type { ToolContext } from '../advisor/advisor-tools.js';
import type { DialogueTurn } from '../advisor/hours-statements.js';
import { emptyScenario } from '../conversation/conversation-turn.js';
import { mergeTrustedContext, trustedContextFromProfile } from '../conversation/trusted-context.js';
import { buildDocumentKnowledge } from '../document-context/knowledge.js';
import { mergePayslipBatches } from '../payroll-engine/document-facts.js';
import { resolvePayrollProfile, type ProfileDocumentInput } from '../payroll-engine/payroll-profile.js';
import { RATES_2026 } from './scenario-fixtures.js';

/**
 * Test-only (AI-001): a RECORDED model for the advisor's deterministic tests - it replays fixed responses in order and
 * records every request. It proves the orchestration, tools and guards around a model; it is NOT evidence of the
 * advisor's conversational quality (that needs the real model, separately and with an approved budget).
 */

export type Step = ModelResponse | Error | ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>);

export interface RecordedModel extends AdvisorModel {
  requests: ModelRequest[];
}

export function recordedModel(steps: Step[]): RecordedModel {
  let i = 0;
  const model: RecordedModel = {
    provider: 'recorded',
    model: 'recorded-test-model',
    requests: [],
    async complete(request) {
      model.requests.push(structuredClone({ ...request, signal: undefined }) as unknown as ModelRequest);
      const step = steps[i++];
      if (step === undefined) throw Object.assign(new Error('no more recorded steps'), { name: 'ProviderError' });
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(request) : step;
    },
  };
  return model;
}

export const say = (text: string): ModelResponse => ({ content: text, toolCalls: [], usage: { promptTokens: 100, completionTokens: 20 } });
export const callTools = (...calls: Array<[string, unknown]>): ModelResponse => ({
  content: null,
  toolCalls: calls.map(([name, args], index) => ({ id: `call-${index}-${name}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })),
  usage: { promptTokens: 120, completionTokens: 10 },
});

export function payslipDocument(batches: Parameters<typeof mergePayslipBatches>[0], documentId = 'doc-1'): ProfileDocumentInput {
  return { index: 0, documentId, label: 'payslip-1', role: 'payslip', effectiveDate: null, facts: mergePayslipBatches(batches) };
}

/** A tool context as the advisor route builds it - optionally with a server-held document context. `messages` are the
 * user's messages; `dialogue` gives the whole conversation instead (the advisor's turns included). */
export function toolContext(options: { messages?: string[]; dialogue?: DialogueTurn[]; documents?: ProfileDocumentInput[]; documentStatus?: ToolContext['documentStatus'] } = {}): ToolContext {
  const dialogue: DialogueTurn[] = options.dialogue ?? (options.messages ?? ['hej']).map((text) => ({ role: 'user', text }));
  const userTexts = dialogue.filter((t) => t.role === 'user').map((t) => t.text);
  let scenario = emptyScenario('advisor-test');
  let knowledge = null;
  if (options.documents) {
    const profile = resolvePayrollProfile({ asOfDate: '2026-10-21', documents: options.documents });
    scenario = mergeTrustedContext(scenario, trustedContextFromProfile(profile)).scenario;
    knowledge = buildDocumentKnowledge(options.documents, profile);
  }
  return {
    dialogue, currentMessage: userTexts[userTexts.length - 1] as string, knowledge,
    documentStatus: options.documentStatus ?? (options.documents ? 'available' : 'none'), scenario, rates: RATES_2026, orientation: null, navigation: [],
  };
}
