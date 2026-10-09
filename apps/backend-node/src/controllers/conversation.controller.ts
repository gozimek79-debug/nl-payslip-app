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

/**
 * R2 backend boundary: `POST /api/scenario/turn` - one conversation turn.
 *
 * Public request: `{ scenario?, message, locale, conversation? }`. There is NO field through which a caller
 * can supply trusted context or claim a trust mode - the request schema is strict, and the public route
 * always runs with `trusted: null`. (Server-trusted facts exist only as a server-internal, Symbol-branded
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
    })
    .optional(),
});

const turnRateLimit = ipRateLimit(SCENARIO_TURN_RATE_LIMIT.routeName, SCENARIO_TURN_RATE_LIMIT.limit, SCENARIO_TURN_RATE_LIMIT.windowSeconds, SCENARIO_TURN_RATE_LIMIT.onUnknown);

router.post('/turn', turnRateLimit, async (req, res) => {
  const parsed = turnRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error_code: 'invalid_input', details: parsed.error.flatten() });
  }

  const fetched = await fetchRates('week');
  if (!fetched) return res.status(503).json({ error_code: 'tax_rates_unavailable' });

  try {
    const { scenario, message, locale, conversation } = parsed.data;
    const result = await runConversationTurn(
      { ...(scenario ? { scenario: scenario as unknown as ScenarioV1 } : {}), message, locale, ...(conversation ? { conversation: conversation as never } : {}) },
      { agent: defaultConversationAgent(), rates: fetched.rates, trusted: null },
    );
    return res.json(result);
  } catch (error) {
    console.error('scenario turn failed', error instanceof Error ? error.message : 'unknown error');
    return res.status(500).json({ error_code: 'turn_failed' });
  }
});

export default router;
