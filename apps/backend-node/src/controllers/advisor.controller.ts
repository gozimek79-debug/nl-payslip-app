import express from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fetchRates } from './tier-a.controller.js';
import { ipRateLimit } from '../rate-limiter.js';
import { ensureSessionHash } from '../document-context/session.js';
import { getRecord, putRecord } from '../document-context/store.js';
import type { DocumentKnowledge } from '../document-context/knowledge.js';
import { emptyScenario } from '../conversation/conversation-turn.js';
import { mergeTrustedContext, trustedContextFromProfile } from '../conversation/trusted-context.js';
import { isVerifiedSource } from '../conversation/conversation-types.js';
import type { PayrollProfile } from '../payroll-engine/payroll-profile.js';
import { SCENARIO_FIELD_PATHS, type ScenarioV1 } from '../scenario/scenario-types.js';
import { canonicalize, getAt, isRecord, withValueAt } from '../scenario/scenario-util.js';
import { advisorBudget, MAX_ADVISOR_MESSAGE_STORED, MAX_USER_MESSAGE } from '../advisor/advisor-config.js';
import { defaultAdvisorModel } from '../advisor/advisor-model.js';
import { runAdvisorTurn, type HistoryMessage } from '../advisor/advisor-turn.js';
import { moneyAmountsIn } from '../advisor/grounding.js';
import type { ToolContext } from '../advisor/advisor-tools.js';

/**
 * AI-001: `POST /api/advisor/v1/turn` - one turn of the model-led AI Advisor in Calculator PRO. A NEW, versioned route:
 * the public R2 `/api/scenario/turn` and the R1 `/api/scenario/evaluate` are untouched.
 *
 * Request (strict): `{ message, locale, conversationRef?, documentContextRef? }`. The conversation (bounded history,
 * the user's own scenario values, amounts already grounded) is held by the SERVER for this browser session (the same
 * session-bound store as document contexts, 2 h); the client keeps only its opaque reference. Document facts reach the
 * advisor only through a server-held document context of the same session; values the client sends are never facts.
 *
 * Response: the model-written answer plus what the interface needs around it (tool names, a structured orientation
 * result for its own card, offered navigation). When no model is configured, the model fails or times out, the answer
 * is `503 advisor_unavailable`; an answer that keeps an ungrounded money amount is `502 answer_withheld`. Logs carry
 * counts, tool names and latency only - never message text or document content.
 */

const router = express.Router();

const turnSchema = z.strictObject({
  message: z.string().trim().min(1).max(MAX_USER_MESSAGE),
  locale: z.enum(['pl', 'en']),
  conversationRef: z.string().max(64).optional(),
  documentContextRef: z.string().max(64).optional(),
});

interface StoredConversation {
  version: 1;
  messages: HistoryMessage[];
  /** User values only - document values are merged fresh from the trusted context each turn. */
  userScenario: ScenarioV1;
  documentContextRef: string | null;
  groundedAmounts: number[];
}

const MAX_STORED_MESSAGES = 40;
const MAX_GROUNDED_AMOUNTS = 60;

function isStoredConversation(value: unknown): value is StoredConversation {
  return isRecord(value) && value.version === 1 && Array.isArray(value.messages) && isRecord(value.userScenario) && Array.isArray(value.groundedAmounts);
}

/** Drops every value with a verified source (document, rules): only the server's trusted context may supply those. */
export function withoutVerifiedValues(scenario: ScenarioV1): ScenarioV1 {
  let out = scenario;
  for (const field of SCENARIO_FIELD_PATHS) {
    const node = getAt(out, field);
    if (!isRecord(node)) continue;
    if (node.state === 'conflict' && Array.isArray(node.candidates)) {
      const rest = node.candidates.filter((c) => !(isRecord(c) && isVerifiedSource(c.source)));
      if (rest.length === node.candidates.length) continue;
      out = withValueAt(out, field, rest.length === 0 ? undefined : rest.length === 1 ? { state: 'known', ...(rest[0] as object) } : { ...node, candidates: rest });
    } else if (isVerifiedSource(node.source)) {
      out = withValueAt(out, field, undefined);
    }
  }
  return canonicalize(out) as ScenarioV1;
}

const turnRateLimit = ipRateLimit('advisor-turn', 30, 300, 'deny');

router.post('/v1/turn', turnRateLimit, async (req, res) => {
  const parsed = turnSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error_code: 'invalid_input' });
  const { message, locale, conversationRef, documentContextRef } = parsed.data;

  const model = defaultAdvisorModel();
  if (!model) return res.status(503).json({ error_code: 'advisor_unavailable', reason: 'not_configured' });

  const sessionHash = ensureSessionHash(req, res);
  let conversation: StoredConversation = { version: 1, messages: [], userScenario: emptyScenario(randomUUID()), documentContextRef: null, groundedAmounts: [] };
  if (conversationRef !== undefined) {
    const record = await getRecord(conversationRef, sessionHash, 'advisor');
    if (!record || !isStoredConversation(record.conversation)) return res.status(409).json({ error_code: 'conversation_invalid' });
    conversation = record.conversation;
  }

  // The document context: a reference the client names now, or the one this conversation already uses.
  const contextRef = documentContextRef ?? conversation.documentContextRef;
  let documentStatus: ToolContext['documentStatus'] = 'none';
  let knowledge: DocumentKnowledge | null = null;
  let scenario = conversation.userScenario;
  if (contextRef) {
    const record = await getRecord(contextRef, sessionHash, 'context');
    if (!record && documentContextRef !== undefined) return res.status(409).json({ error_code: 'document_context_invalid' });
    if (record) {
      try {
        const trusted = trustedContextFromProfile(record.profile as PayrollProfile);
        scenario = mergeTrustedContext(scenario, trusted).scenario;
        knowledge = record.knowledge as DocumentKnowledge;
        documentStatus = 'available';
      } catch {
        documentStatus = 'expired';
      }
    } else {
      documentStatus = 'expired';
    }
  }

  const fetched = await fetchRates('week');
  const budget = advisorBudget();
  const history = conversation.messages.slice(-budget.historyMessages);
  const ctx: ToolContext = {
    userMessages: [...conversation.messages.filter((m) => m.role === 'user').map((m) => m.text), message],
    currentMessage: message, knowledge, documentStatus, scenario, rates: fetched?.rates ?? null, orientation: null, navigation: [],
  };

  const started = Date.now();
  const outcome = await runAdvisorTurn({ locale, message, history, earlierGroundedAmounts: conversation.groundedAmounts, today: new Date().toISOString().slice(0, 10) }, ctx, model, budget);
  const latencyMs = Date.now() - started;
  console.info('advisor turn', JSON.stringify({
    outcome: outcome.status, reason: 'reason' in outcome ? outcome.reason : null, modelCalls: outcome.modelCalls, tools: outcome.toolCalls.map((t) => `${t.name}:${t.status}`),
    latencyMs, documentStatus, ...(outcome.status === 'ok' ? { promptTokens: outcome.usage.promptTokens, completionTokens: outcome.usage.completionTokens, groundingRewrite: outcome.groundingRewrite } : {}),
  }));

  if (outcome.status === 'unavailable') return res.status(503).json({ error_code: 'advisor_unavailable', reason: outcome.reason });
  if (outcome.status === 'withheld') return res.status(502).json({ error_code: 'answer_withheld', reason: outcome.reason });

  const next: StoredConversation = {
    version: 1,
    messages: [...conversation.messages, { role: 'user' as const, text: message }, { role: 'assistant' as const, text: outcome.text.slice(0, MAX_ADVISOR_MESSAGE_STORED) }].slice(-MAX_STORED_MESSAGES),
    userScenario: withoutVerifiedValues(ctx.scenario),
    documentContextRef: contextRef ?? null,
    groundedAmounts: [...conversation.groundedAmounts, ...moneyAmountsIn(outcome.text)].slice(-MAX_GROUNDED_AMOUNTS),
  };
  const newRef = await putRecord(sessionHash, { kind: 'advisor', conversation: next });

  return res.json({
    status: 'ok',
    conversationRef: newRef,
    memory: newRef ? 'server_session' : 'unavailable',
    answer: { text: outcome.text, author: 'model' },
    meta: { provider: model.provider, model: model.model, modelCalls: outcome.modelCalls, tools: outcome.toolCalls, groundingRewrite: outcome.groundingRewrite, latencyMs },
    orientation: ctx.orientation,
    navigation: ctx.navigation,
    documentStatus,
  });
});

export default router;
