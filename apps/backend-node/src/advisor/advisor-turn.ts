import { ADVISOR_SYSTEM_PROMPT, contextNote } from './advisor-prompt.js';
import { ADVISOR_TOOL_NAMES, ADVISOR_TOOLS, executeTool, type ToolContext } from './advisor-tools.js';
import { numbersInText, numbersInValue, ungroundedAmounts } from './grounding.js';
import type { AdvisorBudget } from './advisor-config.js';
import type { AdvisorMessage, AdvisorModel, ToolCall } from './advisor-model.js';

/**
 * AI-001 Dialogue Orchestrator - one advisor turn, server-owned.
 *
 *   history + current message -> MODEL (may request tools) -> server runs validated tools -> MODEL ... -> written answer
 *   -> money-grounding check (one rewrite if an amount is ungrounded, then fail closed) -> answer
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
  /** Amounts already shown and checked in earlier turns (e.g. an orientation result) - still grounded. */
  earlierGroundedAmounts: number[];
  today: string;
}

export type AdvisorTurnOutcome =
  | {
    status: 'ok';
    text: string;
    toolCalls: Array<{ name: string; status: string }>;
    modelCalls: number;
    groundingRewrite: boolean;
    usage: { promptTokens: number; completionTokens: number };
  }
  | { status: 'unavailable'; reason: 'timeout' | 'provider_error' | 'empty_answer' | 'budget_exhausted'; modelCalls: number; toolCalls: Array<{ name: string; status: string }> }
  | { status: 'withheld'; reason: 'ungrounded_amount'; modelCalls: number; toolCalls: Array<{ name: string; status: string }> };

const KNOWN_TOOLS = new Set<string>(ADVISOR_TOOL_NAMES);

export async function runAdvisorTurn(input: AdvisorTurnInput, ctx: ToolContext, model: AdvisorModel, budget: AdvisorBudget): Promise<AdvisorTurnOutcome> {
  const started = Date.now();
  const toolCalls: Array<{ name: string; status: string }> = [];
  const usage = { promptTokens: 0, completionTokens: 0 };
  const toolNumbers: number[] = [];
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
      numbersInValue(execution.result, toolNumbers);
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

    const allowed = [
      ...toolNumbers,
      ...input.earlierGroundedAmounts,
      ...[...input.history.filter((m) => m.role === 'user').map((m) => m.text), input.message].flatMap((t) => numbersInText(t)),
      ...(ctx.knowledge ? ctx.knowledge.facts.flatMap((f) => (typeof f.value === 'number' ? [f.value] : [])) : []),
    ];
    let ungrounded = ungroundedAmounts(draft, allowed);
    let groundingRewrite = false;
    if (ungrounded.length > 0) {
      if (modelCalls >= budget.maxModelCalls) return { status: 'withheld', reason: 'ungrounded_amount', modelCalls, toolCalls };
      groundingRewrite = true;
      messages.push({ role: 'assistant', content: draft });
      messages.push({
        role: 'system',
        content: `Loonto check: your draft contains money amounts that no tool, document fact or user message provides (${ungrounded.join(', ')}). Rewrite the answer WITHOUT them. Use only amounts from tool results; where an amount cannot be calculated yet, say so instead of estimating.`,
      });
      const rewrite = await call('none');
      draft = (rewrite.content ?? '').trim();
      ungrounded = ungroundedAmounts(draft, allowed);
      if (!draft || ungrounded.length > 0) return { status: 'withheld', reason: 'ungrounded_amount', modelCalls, toolCalls };
    }
    return { status: 'ok', text: draft, toolCalls, modelCalls, groundingRewrite, usage };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    return { status: 'unavailable', reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'provider_error', modelCalls, toolCalls };
  }
}
