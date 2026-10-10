import type { PublicScenarioEvaluation } from '../scenario/scenario-public.js';
import type { ScenarioFieldPath, ScenarioUnit, ScenarioV1, ScenarioValueSource, UnsupportedConcept } from '../scenario/scenario-types.js';

/**
 * R2 Conversation Core - stable contracts (LOONTO-ARCHITECTURE-UX-LOCK-v1.1 §4-§6, §15-§17, §40-§42).
 *
 * Binding flow: user message -> (deterministic interpreter | ONE LLM call) -> ScenarioPatch -> schema
 * validation -> authority / provenance guard -> deterministic, atomic patch application -> R1 Scenario
 * Core (validate / evaluate; Tier A only inside R1) -> deterministic next-question selector.
 *
 * Everything here is data - stable codes and parameters, never user-facing prose (CONVENTIONS.md). The
 * LLM interprets language; it never calculates, never decides readiness, never picks provenance.
 */

export const CONVERSATION_LOCALES = ['pl', 'en'] as const;
export type ConversationLocale = (typeof CONVERSATION_LOCALES)[number];

/** What the user's message was about - language-neutral. */
export const TURN_INTENTS = [
  'provide_information',
  'correction',
  'dont_know',
  'accept_assumption',
  'decline_assumption',
  'calculation_request',
  'clarification_request',
  'off_topic',
  'unsupported_concept',
  'unclear',
] as const;
export type TurnIntent = (typeof TURN_INTENTS)[number];

/** How the interpretation was obtained. `not_needed` = resolved deterministically, no model call. */
export const AGENT_STATUSES = ['not_needed', 'ok', 'not_configured', 'timeout', 'provider_error', 'invalid_output'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Sources that only SERVER-TRUSTED context may create (RT-001). A public caller or the LLM never can. */
export const VERIFIED_SOURCES = ['document', 'cao_rule', 'official_rule', 'intelligence_memory'] as const satisfies readonly ScenarioValueSource[];
export type VerifiedSource = (typeof VERIFIED_SOURCES)[number];

export function isVerifiedSource(source: unknown): source is VerifiedSource {
  return typeof source === 'string' && (VERIFIED_SOURCES as readonly string[]).includes(source);
}

// ---------------------------------------------------------------------------------------------
// Patch issues
// ---------------------------------------------------------------------------------------------

export const PATCH_ISSUE_CODES = [
  // shape
  'patch_schema_invalid',
  'too_many_ops',
  'unknown_field',
  'engine_field_forbidden',
  'duplicate_field_in_patch',
  'value_type_mismatch',
  'choice_not_allowed',
  'range_not_allowed_for_choice',
  'alternatives_not_allowed_for_number',
  'unknown_concept',
  // provenance / authority (RT-001)
  'untrusted_provenance_elevation',
  'invalid_source',
  'assumption_must_use_catalog',
  'assumption_not_in_catalog',
  'assumption_field_already_known',
  'cannot_erase_verified',
  'cannot_override_verified',
  'cannot_replace_verified_with_assumption',
  /** F4: `accept_assumption` is valid only for the assumption the server is offering RIGHT NOW. */
  'assumption_not_offered',
  'no_conflict_to_resolve',
  'conflict_pick_out_of_range',
  // whole-scenario
  'scenario_validation_failed',
  'untrusted_provenance_in_scenario',
  /** F3: a `loonto_assumption` in the incoming Scenario that is not the server's own catalogued node. */
  'untrusted_loonto_assumption',
] as const;
export type PatchIssueCode = (typeof PATCH_ISSUE_CODES)[number];

export interface PatchIssue {
  code: PatchIssueCode;
  opIndex?: number;
  field?: string;
  params?: Record<string, number | string>;
}

/** Non-blocking notes about how an accepted op was applied. */
export const PATCH_NOTE_CODES = [
  'assumption_kept_as_assumption',
  'verified_value_kept_in_conflict',
  'value_already_verified',
  'explicit_override_of_verified',
  'trusted_value_added',
  'trusted_value_upgraded',
  'trusted_value_conflicts_with_user',
  /** F1: the model classified a weekly total as weekday hours without the user saying so - not written. */
  'weekday_hours_withheld',
] as const;
export type PatchNoteCode = (typeof PATCH_NOTE_CODES)[number];
export interface PatchNote {
  code: PatchNoteCode;
  field: string;
}

// ---------------------------------------------------------------------------------------------
// Next question
// ---------------------------------------------------------------------------------------------

export const NEXT_QUESTION_KINDS = ['provide_value', 'offer_assumption', 'resolve_conflict', 'correct_value', 'clarify_hours_composition'] as const;
export type NextQuestionKind = (typeof NEXT_QUESTION_KINDS)[number];

export type AnswerMode = 'number' | 'choice' | 'yes_no' | 'pick_candidate' | 'overtime_distribution' | 'hours_by_category';

export type FallbackOption = 'upload_document' | 'give_range' | 'split_hours' | 'compute_both_variants' | 'use_estimate';

/** ONE deterministic question. The choice of WHAT to ask is made by code from the R1 result; wording is
 * R3's job (it renders `prompt.key` with `prompt.params` in the interface language). */
export interface NextQuestionSpec {
  kind: NextQuestionKind;
  field: ScenarioFieldPath | 'work.hours';
  /** Requirement reason (missing / unknown / conflict / engine_requires), an R1 issue code, or `user_does_not_know`. */
  reasonCode: string;
  answerMode: AnswerMode;
  unit?: ScenarioUnit;
  options?: unknown[];
  /** For `resolve_conflict`: the competing values and where each came from. */
  candidates?: Array<{ value: unknown; source: ScenarioValueSource }>;
  /** True when an explicit, catalogued Loonto assumption could answer this field. */
  canUseAssumption: boolean;
  /** Present only for `offer_assumption`: what Loonto proposes, always marked as an assumption. */
  suggestedAssumption?: { value?: unknown; options?: unknown[]; source: 'loonto_assumption' };
  /** Ways forward when the user cannot answer ("I don't know" must not dead-end, Lock §5.5). */
  fallbackOptions: FallbackOption[];
  priority: number;
  prompt: { key: string; params: Record<string, string | number> };
}

// ---------------------------------------------------------------------------------------------
// Conversation digest (request-carried, untrusted, harmless - it only steers which question is asked)
// ---------------------------------------------------------------------------------------------

export interface ConversationDigest {
  /** The question the previous turn asked, echoed back by the client. */
  pendingQuestion?: { field: ScenarioFieldPath | 'work.hours'; kind: NextQuestionKind };
  /** Fields whose offered assumption the user declined - not offered again. */
  declinedAssumptions?: ScenarioFieldPath[];
  /**
   * F1: the user gave a weekly total of hours WITHOUT saying they are Monday-Friday regular hours. The total
   * is NOT committed to the Scenario (that would be a hidden default); it only parameterises the one
   * clarification question. `weekdayOnly: false` = the user said the total includes other kinds of hours.
   */
  hoursClarification?: HoursClarification;
}

export interface HoursClarification {
  statedWeeklyTotal?: number;
  weekdayOnly?: false;
}

export const RESPONSE_HINT_CODES = [
  'result_ready',
  'needs_information',
  'off_topic',
  'unsupported_concept',
  'patch_rejected',
  'agent_unavailable',
  'untrusted_scenario',
  'scenario_invalid',
  'cannot_calculate_without_inputs',
  'clarification_requested',
  'message_unclear',
] as const;
export type ResponseHintCode = (typeof RESPONSE_HINT_CODES)[number];
export interface ResponseHint {
  code: ResponseHintCode;
  params?: Record<string, string | number>;
}

export type TurnStatus = 'updated' | 'unchanged' | 'rejected';

/** The PUBLIC result of one turn. No prompt, no model output text, no engine structures, no trusted-context
 * object - only Scenario Core public data and stable codes. */
export interface ConversationTurnResult {
  turnId: string;
  status: TurnStatus;
  intent: TurnIntent;
  agentStatus: AgentStatus;
  /** The Scenario to carry into the next turn (unchanged when the patch was rejected). */
  scenario: ScenarioV1;
  /** The operations as APPLIED (server-assigned provenance), or null when nothing was applied. */
  patchApplied: AppliedOp[] | null;
  patchIssues: PatchIssue[];
  patchNotes: PatchNote[];
  /** R1 public evaluation of `scenario`; null only when the incoming Scenario itself was rejected as untrusted. */
  evaluation: PublicScenarioEvaluation | null;
  nextQuestion: NextQuestionSpec | null;
  conversation: ConversationDigest;
  responseHint: ResponseHint | null;
}

/** An operation as applied by the server, with the provenance the SERVER assigned. */
export type AppliedOp =
  | { op: 'write'; field: ScenarioFieldPath; node: unknown }
  | { op: 'remove'; field: ScenarioFieldPath }
  | { op: 'request_concept'; concept: UnsupportedConcept }
  | { op: 'withdraw_concept'; concept: UnsupportedConcept }
  | { op: 'set_label'; label: string };
