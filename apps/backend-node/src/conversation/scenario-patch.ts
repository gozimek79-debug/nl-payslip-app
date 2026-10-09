import { z } from 'zod';
import { TURN_INTENTS } from './conversation-types.js';

/**
 * ScenarioPatch V1 - the ONLY thing an interpreter (deterministic or LLM) may produce to change a Scenario.
 *
 * Closed and strict: every object is a strictObject (an unknown key - e.g. a payroll result the model
 * decided to add - makes the whole patch invalid), there is no merge operation, no JSON pointer, no array
 * index and no nested path syntax. A field is ONE of the Scenario field-table paths; that membership, the
 * value's type for that field and every provenance rule are checked by the authority guard
 * (patch-authority.ts) - this schema only fixes the shape.
 *
 * Provenance: ops carry NO trusted provenance. `source` exists only so an attempt to claim one can be
 * recognised and REJECTED (RT-001); the only accepted value is 'user'. Loonto assumptions are never a
 * free value - they enter through `accept_assumption`, whose value comes from the server's catalogue.
 */

export const MAX_PATCH_OPS = 12;

const fieldRef = z.string().min(1).max(80);
const sourceClaim = z.string().max(40).optional();

const distributionValue = z.union([
  z.strictObject({ kind: z.literal('even'), days: z.number() }),
  z.strictObject({ kind: z.literal('explicit'), byDay: z.strictObject({ mon: z.number(), tue: z.number(), wed: z.number(), thu: z.number(), fri: z.number() }) }),
]);

/** A field value: a number, a short choice string, or an overtime distribution. The guard checks which
 * one the target field actually accepts. */
export const patchValue = z.union([z.number(), z.string().max(40), distributionValue]);

export const patchOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set'), field: fieldRef, value: patchValue, source: sourceClaim }),
  z.strictObject({ op: z.literal('set_range'), field: fieldRef, low: z.number(), high: z.number(), source: sourceClaim }),
  z.strictObject({ op: z.literal('set_alternatives'), field: fieldRef, options: z.array(patchValue).min(2).max(10), source: sourceClaim }),
  z.strictObject({ op: z.literal('set_unknown'), field: fieldRef }),
  z.strictObject({ op: z.literal('set_conflict'), field: fieldRef, candidates: z.array(z.strictObject({ value: patchValue, source: sourceClaim })).min(2).max(5) }),
  z.strictObject({ op: z.literal('remove'), field: fieldRef }),
  z.strictObject({ op: z.literal('accept_assumption'), field: fieldRef }),
  z.strictObject({ op: z.literal('resolve_conflict'), field: fieldRef, pick: z.number().int().min(0).max(9) }),
  z.strictObject({ op: z.literal('request_concept'), concept: z.string().min(1).max(80) }),
  z.strictObject({ op: z.literal('withdraw_concept'), concept: z.string().min(1).max(80) }),
  z.strictObject({ op: z.literal('set_label'), label: z.string().max(200) }),
]);

export const scenarioPatchSchema = z.strictObject({
  version: z.literal(1),
  // Shape allows a few more than MAX_PATCH_OPS so an over-long patch is reported as `too_many_ops`
  // (a precise code) rather than a generic schema error; anything far larger is a schema error.
  ops: z.array(patchOpSchema).max(50),
});

export type PatchValue = z.infer<typeof patchValue>;
export type PatchOp = z.infer<typeof patchOpSchema>;
export type ScenarioPatchV1 = z.infer<typeof scenarioPatchSchema>;

/** Semantic hints the model may attach. Never prose: the model's own words never reach the client. */
export const AGENT_HINTS = ['none', 'greeting', 'thanks', 'asks_for_result', 'asks_for_explanation', 'ambiguous_hours', 'needs_document'] as const;

/** The complete structured output the LLM must return - nothing else is accepted. */
export const agentOutputSchema = z.strictObject({
  intent: z.enum(TURN_INTENTS),
  patch: scenarioPatchSchema,
  hint: z.enum(AGENT_HINTS).optional(),
});
export type AgentOutput = z.infer<typeof agentOutputSchema>;

export function parseScenarioPatch(value: unknown): { ok: true; patch: ScenarioPatchV1 } | { ok: false } {
  const parsed = scenarioPatchSchema.safeParse(value);
  return parsed.success ? { ok: true, patch: parsed.data } : { ok: false };
}

export const EMPTY_PATCH: ScenarioPatchV1 = { version: 1, ops: [] };
