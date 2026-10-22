import { ADVISOR_SYSTEM_PROMPT, contextNote } from './advisor-prompt.js';
import { ADVISOR_TOOL_NAMES, ADVISOR_TOOLS, claimSourcesFromKnowledge, claimSourcesFromTool, executeTool, type ToolContext } from './advisor-tools.js';
import { checkClaims, claimsUsed, rewriteInstruction, type ClaimIssueCode, type ClaimSource } from './claim-check.js';
import { numbersInText } from './grounding.js';
import type { AdvisorBudget } from './advisor-config.js';
import type { AdvisorMessage, AdvisorModel, ToolCall } from './advisor-model.js';

/**
 * AI-001 Dialogue Orchestrator - one advisor turn, server-owned.
 *
 *   history + current message -> MODEL (may request tools) -> server runs validated tools -> MODEL ... -> written answer
 *   -> claim check (claim-check.ts: every amount grounded AND described as what it is; no asserted entitlement)
 *   -> one rewrite if the check fails, then fail closed -> answer
 *
 * The answer the user reads is the model's own text. Nothing here writes user-visible prose: when the model cannot be
 * reached, times out, or keeps writing an ungrounded amount, the turn reports that state and the interface says so -
 * there is no fallback questionnaire and no template pretending to be the advisor.
 */

export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface AdvisorTurnInput {
  locale: 'pl' | 'en';
  message: string;
  history: HistoryMessage[];
  /** Claims already shown and checked in earlier turns (e.g. an orientation result) - still grounded, still that kind. */
  earlierClaims: ClaimSource[];
  today: string;
}

export type AdvisorTurnOutcome =
  | {
    status: 'ok';
    text: string;
    toolCalls: Array<{ name: string; status: string }>;
    modelCalls: number;
    groundingRewrite: boolean;
    /** Issue codes the FIRST draft had (logged; the delivered text passed the check). */
    checks: ClaimIssueCode[];
    /** The sources behind the amounts of the delivered text (kept for later turns). */
    claims: ClaimSource[];
    usage: { promptTokens: number; completionTokens: number };
  }
  | { status: 'unavailable'; reason: 'timeout' | 'provider_error' | 'empty_answer' | 'budget_exhausted'; modelCalls: number; toolCalls: Array<{ name: string; status: string }> }
  | { status: 'withheld'; reason: 'ungrounded_amount' | 'mislabelled_amount' | 'unsupported_entitlement'; checks: ClaimIssueCode[]; modelCalls: number; toolCalls: Array<{ name: string; status: string }> };

function withheldReason(codes: readonly ClaimIssueCode[]): 'ungrounded_amount' | 'mislabelled_amount' | 'unsupported_entitlement' {
  if (codes.includes('ungrounded_amount')) return 'ungrounded_amount';
  if (codes.includes('unsupported_entitlement')) return 'unsupported_entitlement';
  return 'mislabelled_amount';
}

const KNOWN_TOOLS = new Set<string>(ADVISOR_TOOL_NAMES);

export async function runAdvisorTurn(input: AdvisorTurnInput, ctx: ToolContext, model: AdvisorModel, budget: AdvisorBudget): Promise<AdvisorTurnOutcome> {
  const started = Date.now();
  const toolCalls: Array<{ name: string; status: string }> = [];
  const usage = { promptTokens: 0, completionTokens: 0 };
  const toolClaims: ClaimSource[] = [];
  let modelCalls = 0;

  const messages: AdvisorMessage[] = [
    { role: 'system', content: ADVISOR_SYSTEM_PROMPT },
    { role: 'system', content: contextNote({ locale: input.locale, documentStatus: ctx.documentStatus, today: input.today }) },
    ...input.history.map((m) => (m.role === 'user' ? { role: 'user' as const, content: m.text } : { role: 'assistant' as const, content: m.text })),
    { role: 'user', content: input.message },
  ];

  async function call(toolChoice: 'auto' | 'none') {
    const remaining = budget.turnDeadlineMs - (Date.now() - started);
    if (remaining <= 1000) throw Object.assign(new Error('turn deadline'), { name: 'TimeoutError' });
    const timeoutMs = Math.min(budget.callTimeoutMs, remaining);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    modelCalls += 1;
    try {
      const response = await model.complete({ messages, tools: ADVISOR_TOOLS, toolChoice, maxOutputTokens: budget.maxOutputTokens, signal: controller.signal, timeoutMs });
      if (response.usage) {
        usage.promptTokens += response.usage.promptTokens;
        usage.completionTokens += response.usage.completionTokens;
      }
      return response;
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error('call timeout'), { name: 'TimeoutError' });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function runTools(calls: ToolCall[]) {
    messages.push({ role: 'assistant', content: null, toolCalls: calls });
    calls.forEach((c, index) => {
      if (index >= budget.maxToolCallsPerRound || !KNOWN_TOOLS.has(c.name)) {
        toolCalls.push({ name: KNOWN_TOOLS.has(c.name) ? c.name : 'unknown_tool', status: 'refused' });
        messages.push({ role: 'tool', toolCallId: c.id, content: JSON.stringify({ error: index >= budget.maxToolCallsPerRound ? 'too_many_tool_calls_in_one_round' : 'unknown_tool' }) });
        return;
      }
      const execution = executeTool(c.name, c.arguments, ctx);
      toolCalls.push({ name: c.name, status: execution.status });
      toolClaims.push(...claimSourcesFromTool(c.name, execution.result));
      messages.push({ role: 'tool', toolCallId: c.id, content: JSON.stringify(execution.result) });
    });
  }

  try {
    let draft: string | null = null;
    // Tool rounds, keeping one model call in reserve for a grounding rewrite.
    while (draft === null) {
      const lastCall = modelCalls >= budget.maxModelCalls - 2;
      const response = await call(lastCall ? 'none' : 'auto');
      if (response.toolCalls.length > 0 && !lastCall) {
        runTools(response.toolCalls);
        continue;
      }
      draft = (response.content ?? '').trim();
      if (!draft) return { status: 'unavailable', reason: 'empty_answer', modelCalls, toolCalls };
    }

    // What every number Loonto can supply IS (claim-check.ts): tool results, the document, the user, earlier turns.
    const userNumbers = [...input.history.filter((m) => m.role === 'user').map((m) => m.text), input.message].flatMap((t) => numbersInText(t));
    const sources: ClaimSource[] = [
      ...toolClaims,
      ...claimSourcesFromKnowledge(ctx.knowledge),
      ...input.earlierClaims,
      ...userNumbers.map((value) => ({ value, kind: 'user_stated' as const })),
    ];
    const percents = sources.map((s) => s.value);
    let issues = checkClaims(draft, sources, percents);
    const checks = [...new Set(issues.map((i) => i.code))];
    let groundingRewrite = false;
    if (issues.length > 0) {
      if (modelCalls >= budget.maxModelCalls) return { status: 'withheld', reason: withheldReason(checks), checks, modelCalls, toolCalls };
      groundingRewrite = true;
      messages.push({ role: 'assistant', content: draft });
      messages.push({ role: 'system', content: rewriteInstruction(issues) });
      const rewrite = await call('none');
      draft = (rewrite.content ?? '').trim();
      issues = draft ? checkClaims(draft, sources, percents) : [];
      if (!draft || issues.length > 0) return { status: 'withheld', reason: withheldReason(issues.length > 0 ? issues.map((i) => i.code) : checks), checks, modelCalls, toolCalls };
    }
    return { status: 'ok', text: draft, toolCalls, modelCalls, groundingRewrite, checks, claims: claimsUsed(draft, sources), usage };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { status: 'unavailable', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'provider_error', modelCalls, toolCalls };
  }
}
