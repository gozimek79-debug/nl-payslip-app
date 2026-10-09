import { randomUUID } from 'node:crypto';
import type { PayslipComputationRates } from '../payroll-engine/payslip-model.js';
import { evaluateScenario, type ScenarioEvaluationResult } from '../scenario/scenario-evaluate.js';
import { toPublicEvaluation } from '../scenario/scenario-public.js';
import { SCENARIO_FIELDS, SCENARIO_FIELD_PATHS, SCENARIO_SCHEMA_VERSION, type ScenarioFieldPath, type ScenarioV1 } from '../scenario/scenario-types.js';
import { canonicalize, getAt, isRecord } from '../scenario/scenario-util.js';
import type { AgentInput, ConversationAgent } from './conversation-agent.js';
import type {
  AgentStatus,
  ConversationDigest,
  ConversationLocale,
  ConversationTurnResult,
  NextQuestionSpec,
  PatchIssue,
  PatchNote,
  ResponseHint,
  TurnIntent,
  TurnStatus,
} from './conversation-types.js';
import { interpretDeterministically } from './deterministic-interpreter.js';
import { selectNextQuestion } from './next-question.js';
import { applyScenarioPatch } from './patch-authority.js';
import { EMPTY_PATCH, type ScenarioPatchV1 } from './scenario-patch.js';
import { findUnbackedVerifiedValues, isTrustedContext, mergeTrustedContext, type TrustedContext } from './trusted-context.js';

/**
 * One conversation turn (R2 §1 binding flow):
 *
 *   Scenario (+ trusted context, server-internal only)
 *     -> trust check: every verified value must be backed by the trusted context, else the turn is rejected
 *     -> deterministic interpreter, or ONE model call (or the deterministic fallback)
 *     -> ScenarioPatch (schema-validated) -> authority / provenance guard -> atomic application
 *     -> R1 Scenario Core: evaluateScenario (Tier A runs only inside it) -> public projection
 *     -> deterministic next-question selector
 *
 * No Tier A call, no HTTP call to /api/tier-a/calculate, no persistence, no session state: the Scenario
 * and a tiny digest are request-carried. The model output never reaches the client.
 */

export interface TurnRequest {
  scenario?: ScenarioV1;
  message: string;
  locale: ConversationLocale;
  conversation?: ConversationDigest;
}

export interface TurnDependencies {
  /** The model, or null when none is configured (deterministic-only operation). */
  agent: ConversationAgent | null;
  rates: PayslipComputationRates;
  /** SERVER-INTERNAL trusted facts. Never built from request JSON; the public route passes none. */
  trusted?: TrustedContext | null;
  newId?: () => string;
}

export function emptyScenario(scenarioId: string): ScenarioV1 {
  return { schemaVersion: SCENARIO_SCHEMA_VERSION, scenarioId, periodType: 'week', work: {}, pay: {}, tax: {} };
}

/** Compact, personal-data-free view of the Scenario for the model (Lock §40). */
function scenarioDigest(scenario: ScenarioV1): AgentInput['scenario'] {
  const out: AgentInput['scenario'] = [];
  for (const field of SCENARIO_FIELD_PATHS) {
    const node = getAt(scenario, field);
    if (!isRecord(node)) continue;
    const entry: AgentInput['scenario'][number] = { field, state: String(node.state) };
    if ('value' in node) entry.value = node.value;
    if (typeof node.low === 'number') entry.low = node.low;
    if (typeof node.high === 'number') entry.high = node.high;
    if (Array.isArray(node.options)) entry.options = node.options;
    if (Array.isArray(node.candidates)) entry.options = node.candidates.filter(isRecord).map((c) => c.value);
    if (typeof node.source === 'string') entry.source = node.source;
    out.push(entry);
  }
  return out;
}

function missingDigest(evaluation: ScenarioEvaluationResult): AgentInput['missing'] {
  if (evaluation.status === 'blocked') return evaluation.requirements.slice(0, 8).map((r) => ({ field: r.field, reason: r.reason }));
  if (evaluation.status === 'invalid') return evaluation.issues.slice(0, 8).map((i) => ({ field: i.path, reason: i.code }));
  return [];
}

function cleanDeclined(list: readonly string[] | undefined): ScenarioFieldPath[] {
  const out: ScenarioFieldPath[] = [];
  for (const field of list ?? []) {
    if (Object.prototype.hasOwnProperty.call(SCENARIO_FIELDS, field) && !out.includes(field as ScenarioFieldPath)) out.push(field as ScenarioFieldPath);
  }
  return out;
}

const NO_MUTATION_INTENTS: ReadonlySet<TurnIntent> = new Set<TurnIntent>(['off_topic', 'decline_assumption', 'clarification_request']);

function responseHintFor(args: {
  status: TurnStatus;
  intent: TurnIntent;
  agentStatus: AgentStatus;
  usedModelOrFallback: boolean;
  evaluation: ScenarioEvaluationResult;
}): ResponseHint {
  const { status, intent, agentStatus, evaluation } = args;
  if (status === 'rejected') return { code: 'patch_rejected' };
  if (args.usedModelOrFallback && agentStatus !== 'ok' && agentStatus !== 'not_needed') return { code: 'agent_unavailable', params: { agentStatus } };
  if (intent === 'off_topic') return { code: 'off_topic' };
  if (evaluation.status === 'unsupported') {
    const first = evaluation.unsupported[0];
    return { code: 'unsupported_concept', params: first?.kind === 'concept' ? { concept: first.concept } : { capability: first?.kind === 'capability' ? first.capability : 'unknown' } };
  }
  if (intent === 'unsupported_concept') return { code: 'unsupported_concept' };
  if (evaluation.status === 'invalid') return { code: 'scenario_invalid' };
  if (evaluation.status === 'computed') return { code: 'result_ready' };
  if (intent === 'calculation_request') return { code: 'cannot_calculate_without_inputs' };
  if (intent === 'clarification_request') return { code: 'clarification_requested' };
  if (intent === 'unclear') return { code: 'message_unclear' };
  return { code: 'needs_information' };
}

export async function runConversationTurn(request: TurnRequest, deps: TurnDependencies): Promise<ConversationTurnResult> {
  if (deps.trusted !== undefined && deps.trusted !== null && !isTrustedContext(deps.trusted)) {
    // Programming error, never a request path: anything that is not a server-built TrustedContext is refused.
    throw new TypeError('trusted context must be created by createTrustedContext / trustedContextFromProfile');
  }
  const trusted = deps.trusted ?? null;
  const newId = deps.newId ?? randomUUID;
  const turnId = newId();
  const declinedIn = cleanDeclined(request.conversation?.declinedAssumptions);
  const incoming = request.scenario ? (canonicalize(request.scenario) as ScenarioV1) : emptyScenario(newId());

  // 1. RT-001: a verified value must be backed by THIS turn's trusted context. Otherwise it is
  //    self-declared trust - the turn is rejected before any interpretation, model call or evaluation.
  const unbacked = findUnbackedVerifiedValues(incoming, trusted);
  if (unbacked.length > 0) {
    return {
      turnId,
      status: 'rejected',
      intent: 'unclear',
      agentStatus: 'not_needed',
      scenario: incoming,
      patchApplied: null,
      patchIssues: unbacked.map((u) => ({ code: 'untrusted_provenance_in_scenario' as const, field: u.field, params: { source: u.source } })),
      patchNotes: [],
      evaluation: null,
      nextQuestion: null,
      conversation: { declinedAssumptions: declinedIn },
      responseHint: { code: 'untrusted_scenario' },
    };
  }

  // 2. Server-trusted facts (internal path only).
  const notes: PatchNote[] = [];
  let scenario = incoming;
  if (trusted) {
    const merged = mergeTrustedContext(scenario, trusted);
    scenario = merged.scenario;
    notes.push(...merged.notes);
  }

  // 3. What the server would ask now - computed deterministically, never taken from the client.
  const before = evaluateScenario(scenario, deps.rates);
  const current: NextQuestionSpec | null = selectNextQuestion({ scenario, evaluation: before, declinedAssumptions: declinedIn });

  // 4. Interpretation: deterministic first; otherwise at most ONE model call; otherwise no change.
  let intent: TurnIntent = 'unclear';
  let agentStatus: AgentStatus = 'not_needed';
  let patch: ScenarioPatchV1 = EMPTY_PATCH;
  let usedModelOrFallback = false;
  const declined = [...declinedIn];

  const deterministic = interpretDeterministically(request.message, current);
  if (deterministic) {
    intent = deterministic.intent;
    patch = deterministic.patch;
    if (deterministic.declined && !declined.includes(deterministic.declined)) declined.push(deterministic.declined);
  } else if (deps.agent) {
    usedModelOrFallback = true;
    const outcome = await deps.agent.interpret({
      locale: request.locale,
      message: request.message,
      scenario: scenarioDigest(scenario),
      requestedConcepts: (scenario.requestedConcepts ?? []).map((c) => c.concept),
      currentQuestion: current ? { field: current.field, kind: current.kind, ...(current.suggestedAssumption ? { suggestedAssumption: current.suggestedAssumption } : {}) } : null,
      missing: missingDigest(before),
    });
    agentStatus = outcome.status;
    if (outcome.status === 'ok') {
      intent = outcome.output.intent;
      if (NO_MUTATION_INTENTS.has(intent) && outcome.output.patch.ops.length > 0) {
        // An off-topic / decline / clarification turn must not mutate. A model that says otherwise is not trusted.
        agentStatus = 'invalid_output';
        intent = 'unclear';
      } else {
        patch = outcome.output.patch;
        if (intent === 'decline_assumption' && current?.kind === 'offer_assumption' && current.field !== 'work.hours' && !declined.includes(current.field)) declined.push(current.field);
      }
    }
  } else {
    usedModelOrFallback = true;
    agentStatus = 'not_configured';
  }

  // 5. Guard + atomic application + R1 validation.
  let status: TurnStatus = 'unchanged';
  let patchIssues: PatchIssue[] = [];
  let patchApplied: ConversationTurnResult['patchApplied'] = null;
  if (patch.ops.length > 0) {
    const result = applyScenarioPatch(scenario, patch);
    if (result.status === 'rejected') {
      status = 'rejected';
      patchIssues = result.issues;
    } else if (result.status === 'applied') {
      status = 'updated';
      scenario = result.scenario;
      patchApplied = result.applied;
      notes.push(...result.notes);
    } else {
      notes.push(...result.notes);
    }
  }

  // 6. R1 is the arithmetic and readiness authority; the client only ever sees its public projection.
  const evaluation = status === 'updated' ? evaluateScenario(scenario, deps.rates) : before;
  const nextQuestion = selectNextQuestion({ scenario, evaluation, declinedAssumptions: declined });

  return {
    turnId,
    status,
    intent,
    agentStatus,
    scenario: canonicalize(scenario) as ScenarioV1,
    patchApplied,
    patchIssues,
    patchNotes: notes,
    evaluation: toPublicEvaluation(evaluation),
    nextQuestion,
    conversation: { ...(nextQuestion ? { pendingQuestion: { field: nextQuestion.field, kind: nextQuestion.kind } } : {}), declinedAssumptions: declined },
    responseHint: responseHintFor({ status, intent, agentStatus, usedModelOrFallback, evaluation }),
  };
}
