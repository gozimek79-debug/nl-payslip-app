import express from 'express';
import { z } from 'zod';
import { fetchRates } from './tier-a.controller.js';
import { scenarioSchema } from './scenario.controller.js';
import { ipRateLimit } from '../rate-limiter.js';
import { SCENARIO_TURN_RATE_LIMIT } from '../scenario/scenario-config.js';
import type { ScenarioV1 } from '../scenario/scenario-types.js';
import { CONVERSATION_LOCALES, NEXT_QUESTION_KINDS } from '../conversation/conversation-types.js';
import { defaultConversationAgent } from '../conversation/conversation-agent.js';
import { runConversationTurn } from '../conversation/conversation-turn.js';
import { trustedContextFromProfile, type TrustedContext } from '../conversation/trusted-context.js';
import type { PayrollProfile } from '../payroll-engine/payroll-profile.js';
import type { DocumentKnowledge } from '../document-context/knowledge.js';
import { readSessionHash } from '../document-context/session.js';
import { getRecord } from '../document-context/store.js';

/**
 * R2 backend boundary: `POST /api/scenario/turn` - one conversation turn.
 *
 * Public request: `{ scenario?, message, locale, conversation?, documentContextRef? }`. There is NO field through which
 * a caller can supply trusted facts or claim a trust mode - the request schema is strict. Without `documentContextRef`
 * the route runs with `trusted: null`. R3-B.2: `documentContextRef` is an opaque reference to a document context
 * THIS server built (profile.controller.ts) from batches ITS reader route stored for this browser session; the
 * server loads it, and only then builds the TrustedContext (trustedContextFromProfile) and the Document Knowledge
 * the turn answers from. An unknown / expired / other-session reference fails closed: 409, nothing processed. (Server-trusted facts exist only as a server-internal, Symbol-branded
 * object; see conversation/trusted-context.ts.) A Scenario that arrives carrying a verified source
 * (document / cao_rule / official_rule / intelligence_memory) is therefore self-declared and is rejected.
 *
 * Response: the ConversationTurnResult - the updated Scenario, what was applied, the R1 PUBLIC evaluation,
 * one deterministic next question and stable codes. Never the system prompt, model text, reasoning,
 * provider diagnostics, engine input/result or any trusted-context object.
 */

const router = express.Router();

const turnRequestSchema = z.strictObject({
  scenario: scenarioSchema.optional(),
  message: z.string().min(1).max(1000),
  locale: z.enum(CONVERSATION_LOCALES),
  conversation: z
    .strictObject({
      pendingQuestion: z.strictObject({ field: z.string().max(80), kind: z.enum(NEXT_QUESTION_KINDS) }).optional(),
      declinedAssumptions: z.array(z.string().max(80)).max(25).optional(),
      hoursClarification: z.strictObject({ statedWeeklyTotal: z.number().min(0).max(168).optional(), weekdayOnly: z.literal(false).optional() }).optional(),
      // R3-B: selection-only (conversation-types.ts ConversationDigest.deferredFields) - never a value or a source.
      deferredFields: z.array(z.string().max(80)).max(40).optional(),
    })
    .optional(),
  documentContextRef: z.string().max(64).optional(),
});

const turnRateLimit = ipRateLimit(SCENARIO_TURN_RATE_LIMIT.routeName, SCENARIO_TURN_RATE_LIMIT.limit, SCENARIO_TURN_RATE_LIMIT.windowSeconds, SCENARIO_TURN_RATE_LIMIT.onUnknown);

router.post('/turn', turnRateLimit, async (req, res) => {
  const parsed = turnRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error_code: 'invalid_input', details: parsed.error.flatten() });
  }

  let trusted: TrustedContext | null = null;
  let documentKnowledge: DocumentKnowledge | null = null;
  if (parsed.data.documentContextRef !== undefined) {
    const record = await getRecord(parsed.data.documentContextRef, readSessionHash(req), 'context');
    if (!record) return res.status(409).json({ error_code: 'document_context_invalid' });
    try {
      trusted = trustedContextFromProfile(record.profile as PayrollProfile);
    } catch {
      return res.status(409).json({ error_code: 'document_context_invalid' });
    }
    documentKnowledge = record.knowledge as DocumentKnowledge;
  }

  const fetched = await fetchRates('week');
  if (!fetched) return res.status(503).json({ error_code: 'tax_rates_unavailable' });

  try {
    const { scenario, message, locale, conversation } = parsed.data;
    const result = await runConversationTurn(
      { ...(scenario ? { scenario: scenario as unknown as ScenarioV1 } : {}), message, locale, ...(conversation ? { conversation: conversation as never } : {}) },
      { agent: defaultConversationAgent(), rates: fetched.rates, trusted, documentKnowledge },
    );
    return res.json(result);
  } catch (error) {
    console.error('scenario turn failed', error instanceof Error ? error.message : 'unknown error');
    return res.status(500).json({ error_code: 'turn_failed' });
  }
});

export default router;
