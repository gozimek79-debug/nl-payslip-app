import { randomUUID } from 'node:crypto';
import type { PayslipComputationRates } from '../payroll-engine/payslip-model.js';
import { evaluateScenario, type ScenarioEvaluationResult } from '../scenario/scenario-evaluate.js';
import { toPublicEvaluation } from '../scenario/scenario-public.js';
import { SCENARIO_FIELDS, SCENARIO_FIELD_PATHS, SCENARIO_SCHEMA_VERSION, type ScenarioFieldPath, type ScenarioV1 } from '../scenario/scenario-types.js';
import { canonicalize, getAt, isRecord } from '../scenario/scenario-util.js';
import { findForgedAssumptions } from './assumption-catalog.js';
import type { AgentInput, ConversationAgent } from './conversation-agent.js';
import { agentDocumentDigest, answerFacts, type DocumentKnowledge, type DocumentTopic } from '../document-context/knowledge.js';
import { documentQuestionTopics } from '../document-context/document-questions.js';
import type {
  AgentStatus,
  AnswerNotAppliedReason,
  AnswerSource,
  DocumentAnswer,
  ConversationDigest,
  ConversationLocale,
  ConversationTurnResult,
  HoursClarification,
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
import { guardModelPatch, hoursCompositionEvidence } from './support-guard.js';
import { findUnbackedVerifiedValues, isTrustedContext, mergeTrustedContext, type TrustedContext } from './trusted-context.js';

/**
 * One conversation turn (R2 §1 binding flow):
 *
 *   Scenario (+ trusted context, server-internal only)
 *     -> trust checks: every verified value must be backed by the trusted context (RT-001), and every
 *        Loonto assumption must be the server's own catalogued node (F3) - else the turn is rejected
 *     -> deterministic interpreter, or ONE model call (or the deterministic fallback)
 *     -> support guard (M3/M4): a model op the user's present message contradicts (unit) or does not support
 *        (hours kind + quantity) is withheld with a note; an unclassified hours total becomes ONE
 *        hours-composition clarification, never a Scenario value
 *     -> ScenarioPatch (schema-validated) -> authority / provenance guard (incl. the F4 offer binding)
 *     -> atomic application -> R1 Scenario Core: evaluateScenario (Tier A runs only inside it)
 *     -> public projection -> deterministic next-question selector
 *   R3-B.2: a question about the document ("Jaka jest moja stawka?") is answered from the server-held Document
 *   Knowledge of this turn's document context - never from client JSON, never by the model's own words - and the
 *   pending question stays open. The model may see a sanitized digest of those facts to understand the user, but
 *   the support guard still writes only values the user stated.
 *
 * No Tier A call, no HTTP call to the Tier A route, no persistence, no session state: the Scenario and a tiny
 * digest are request-carried. The model output never reaches the client.
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
  /** R3-B.2: SERVER-HELD facts of the documents this turn's trusted context was resolved from (never request JSON). */
  documentKnowledge?: DocumentKnowledge | null;
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

/**
 * The request-carried clarification, kept only if well-formed. M2: it is unsigned client data - it steers which
 * question is asked and what number that question displays, and NOTHING else: no reply turns it into a value.
 */
function cleanClarification(value: HoursClarification | undefined): HoursClarification | null {
  if (!value || typeof value !== 'object') return null;
  const total = value.statedWeeklyTotal;
  return {
    ...(typeof total === 'number' && Number.isFinite(total) && total >= 0 && total <= 168 ? { statedWeeklyTotal: total } : {}),
    ...(value.weekdayOnly === false ? { weekdayOnly: false as const } : {}),
  };
}

/** R3-B: the request-carried deferral list, kept only for real fields (selection only - see ConversationDigest). */
function cleanDeferred(list: readonly string[] | undefined): Array<ScenarioFieldPath | 'work.hours'> {
  const out: Array<ScenarioFieldPath | 'work.hours'> = [];
  for (const field of list ?? []) {
    const valid = field === 'work.hours' || Object.prototype.hasOwnProperty.call(SCENARIO_FIELDS, field);
    if (valid && !out.includes(field as ScenarioFieldPath | 'work.hours')) out.push(field as ScenarioFieldPath | 'work.hours');
  }
  return out;
}

/** R3-B: after "nie wiem" (or a declined offer) the selector would ask for the same value again - a loop. An offer
 * of the catalogued assumption right after "nie wiem" is a different way forward, so it is not a repeat. */
function repeatsAfterDontKnow(intent: TurnIntent, current: NextQuestionSpec | null, next: NextQuestionSpec | null): boolean {
  if (intent !== 'dont_know' && intent !== 'decline_assumption') return false;
  if (!current || !next || next.field !== current.field) return false;
  return next.kind === current.kind || next.kind === 'provide_value';
}

const NO_MUTATION_INTENTS: ReadonlySet<TurnIntent> = new Set<TurnIntent>(['off_topic', 'decline_assumption', 'clarification_request', 'document_question']);

/**
 * R3-B.2: an unsupported concept (e.g. a night allowance) makes the evaluation `unsupported` - nothing can be calculated
 * - but it must not end the conversation: the other, calculable requirements are still asked. Selection only; the
 * public evaluation stays `unsupported` and no result appears.
 */
function selectionEvaluation(scenario: ScenarioV1, evaluation: ScenarioEvaluationResult, rates: PayslipComputationRates): ScenarioEvaluationResult {
  if (evaluation.status !== 'unsupported' || !scenario.requestedConcepts?.length) return evaluation;
  const { requestedConcepts: _unsupported, ...calculable } = scenario;
  return evaluateScenario(calculable, rates);
}

function documentAnswerFor(knowledge: DocumentKnowledge | null, topics: DocumentTopic[]): DocumentAnswer {
  return { available: knowledge !== null, topics, items: answerFacts(knowledge, topics) };
}

function responseHintFor(args: {
  status: TurnStatus;
  intent: TurnIntent;
  agentStatus: AgentStatus;
  usedModelOrFallback: boolean;
  evaluation: ScenarioEvaluationResult;
  notApplied: AnswerNotAppliedReason | null;
}): ResponseHint {
  const { status, intent, agentStatus, evaluation } = args;
  if (status === 'rejected') return { code: 'patch_rejected' };
  if (intent === 'document_question') return { code: 'document_answer' };
  if (args.notApplied) return { code: 'answer_not_applied', params: { reason: args.notApplied } };
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
  if (intent === 'dont_know' && status === 'unchanged') return { code: 'user_does_not_know' };
  return { code: 'needs_information' };
}

function rejectedTurn(turnId: string, scenario: ScenarioV1, issues: PatchIssue[], declined: ScenarioFieldPath[], code: ResponseHint['code'], deferred: Array<ScenarioFieldPath | 'work.hours'> | null = null): ConversationTurnResult {
  return {
    turnId,
    status: 'rejected',
    intent: 'unclear',
    agentStatus: 'not_needed',
    scenario,
    patchApplied: null,
    patchIssues: issues,
    patchNotes: [],
    evaluation: null,
    nextQuestion: null,
    conversation: { declinedAssumptions: declined, ...(deferred ? { deferredFields: deferred } : {}) },
    responseHint: { code },
    documentAnswer: null,
    answerSource: 'none',
  };
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
  const clarificationIn = cleanClarification(request.conversation?.hoursClarification);
  // R3-B: deferral is opted into by carrying the list (even empty); without it the turn behaves exactly as before.
  const deferralMode = Array.isArray(request.conversation?.deferredFields);
  const deferredIn = cleanDeferred(request.conversation?.deferredFields);
  const incoming = request.scenario ? (canonicalize(request.scenario) as ScenarioV1) : emptyScenario(newId());

  // 1a. RT-001: a verified value must be backed by THIS turn's trusted context. Otherwise it is
  //     self-declared trust - the turn is rejected before any interpretation, model call or evaluation.
  const unbacked = findUnbackedVerifiedValues(incoming, trusted);
  if (unbacked.length > 0) {
    return rejectedTurn(turnId, incoming, unbacked.map((u) => ({ code: 'untrusted_provenance_in_scenario' as const, field: u.field, params: { source: u.source } })), declinedIn, 'untrusted_scenario', deferralMode ? deferredIn : null);
  }
  // 1b. F3: a Loonto assumption must be exactly the server's own catalogued node - never caller-minted.
  const forged = findForgedAssumptions(incoming);
  if (forged.length > 0) {
    return rejectedTurn(turnId, incoming, forged.map((f) => ({ code: 'untrusted_loonto_assumption' as const, field: f.field, params: { reason: f.reason } })), declinedIn, 'untrusted_scenario', deferralMode ? deferredIn : null);
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
  const current: NextQuestionSpec | null = selectNextQuestion({ scenario, evaluation: selectionEvaluation(scenario, before, deps.rates), declinedAssumptions: declinedIn, hoursClarification: clarificationIn, deferredFields: deferredIn });

  // 4. Interpretation: deterministic first; otherwise at most ONE model call; otherwise no change.
  let intent: TurnIntent = 'unclear';
  let agentStatus: AgentStatus = 'not_needed';
  let patch: ScenarioPatchV1 = EMPTY_PATCH;
  let usedModelOrFallback = false;
  let clarificationOut: HoursClarification | null = clarificationIn;
  let notApplied: AnswerNotAppliedReason | null = null;
  const declined = [...declinedIn];

  const knowledge = deps.documentKnowledge ?? null;
  let documentAnswer: DocumentAnswer | null = null;
  // R3-B.2: a plain question about the document is answered from its facts - no patch, no model call.
  const documentTopics = documentQuestionTopics(request.message);
  const deterministic = documentTopics.length > 0 ? null : interpretDeterministically(request.message, current);
  if (documentTopics.length > 0) {
    intent = 'document_question';
    documentAnswer = documentAnswerFor(knowledge, documentTopics);
  } else if (deterministic) {
    intent = deterministic.intent;
    patch = deterministic.patch;
    if (deterministic.declined && !declined.includes(deterministic.declined)) declined.push(deterministic.declined);
    if (deterministic.hoursClarification) clarificationOut = deterministic.hoursClarification;
    notApplied = deterministic.notApplied ?? null;
  } else if (deps.agent) {
    usedModelOrFallback = true;
    // M2: the request-carried total is NOT shown to the model - nothing it could copy into a patch.
    const outcome = await deps.agent.interpret({
      locale: request.locale,
      message: request.message,
      scenario: scenarioDigest(scenario),
      requestedConcepts: (scenario.requestedConcepts ?? []).map((c) => c.concept),
      currentQuestion: current ? { field: current.field, kind: current.kind, ...(current.suggestedAssumption ? { suggestedAssumption: current.suggestedAssumption } : {}) } : null,
      missing: missingDigest(before),
      ...(knowledge ? { documentFacts: agentDocumentDigest(knowledge) } : {}),
    });
    agentStatus = outcome.status;
    if (outcome.status === 'ok') {
      intent = outcome.output.intent;
      if (NO_MUTATION_INTENTS.has(intent) && outcome.output.patch.ops.length > 0) {
        // An off-topic / decline / clarification turn must not mutate. A model that says otherwise is not trusted.
        agentStatus = 'invalid_output';
        intent = 'unclear';
      } else {
        // M3 / M4 / m1: withhold every op the user's present message contradicts or does not support.
        const guarded = guardModelPatch(outcome.output.patch, request.message, current);
        patch = guarded.patch;
        notes.push(...guarded.notes);
        const modelStated = outcome.output.statedWeeklyHours;
        const composition = hoursCompositionEvidence(request.message, modelStated);
        if (outcome.output.hint === 'ambiguous_hours' || modelStated !== undefined || guarded.hoursValueWithheld || composition.statedTotal !== null) {
          // ONE composition clarification. A new number comes only from the present message; without one, the
          // number the question already showed is kept (display only - it is never written).
          const fresh = composition.statedTotal !== null;
          const total = fresh ? composition.statedTotal : clarificationIn?.statedWeeklyTotal;
          const weekdayOnlyFalse = composition.otherCategories || (!fresh && clarificationIn?.weekdayOnly === false);
          clarificationOut = { ...(typeof total === 'number' ? { statedWeeklyTotal: total } : {}), ...(weekdayOnlyFalse ? { weekdayOnly: false as const } : {}) };
        }
        if (intent === 'document_question') documentAnswer = documentAnswerFor(knowledge, outcome.output.documentTopics?.length ? outcome.output.documentTopics : ['summary']);
        if (intent === 'decline_assumption' && current?.kind === 'offer_assumption' && current.field !== 'work.hours' && !declined.includes(current.field)) declined.push(current.field);
      }
    }
  } else {
    usedModelOrFallback = true;
    agentStatus = 'not_configured';
  }

  // 5. Guard + atomic application + R1 validation. F4: the only acceptable assumption is the one offered now.
  const offeredAssumption = current?.kind === 'offer_assumption' && current.field !== 'work.hours' ? current.field : null;
  let status: TurnStatus = 'unchanged';
  let patchIssues: PatchIssue[] = [];
  let patchApplied: ConversationTurnResult['patchApplied'] = null;
  if (patch.ops.length > 0) {
    const result = applyScenarioPatch(scenario, patch, { offeredAssumption });
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
  const deferred = [...deferredIn];
  const selectable = selectionEvaluation(scenario, evaluation, deps.rates);
  let nextQuestion = selectNextQuestion({ scenario, evaluation: selectable, declinedAssumptions: declined, hoursClarification: clarificationOut, deferredFields: deferred });
  // R3-B: "nie wiem" must not loop - the field stays unknown (never zero) and is put aside; the next one is asked.
  if (deferralMode && current && repeatsAfterDontKnow(intent, current, nextQuestion) && !deferred.includes(current.field)) {
    deferred.push(current.field);
    nextQuestion = selectNextQuestion({ scenario, evaluation: selectable, declinedAssumptions: declined, hoursClarification: clarificationOut, deferredFields: deferred });
  }
  // The clarification is only carried while the opening hours question is still the one being asked.
  const carryClarification = nextQuestion?.field === 'work.hours' && clarificationOut ? clarificationOut : null;

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
    conversation: {
      ...(nextQuestion ? { pendingQuestion: { field: nextQuestion.field, kind: nextQuestion.kind } } : {}),
      declinedAssumptions: declined,
      ...(carryClarification ? { hoursClarification: carryClarification } : {}),
      ...(deferralMode ? { deferredFields: deferred } : {}),
    },
    responseHint: responseHintFor({ status, intent, agentStatus, usedModelOrFallback, evaluation, notApplied }),
    documentAnswer,
    answerSource: answerSourceOf(documentAnswer, evaluation, status),
  };
}

function answerSourceOf(documentAnswer: DocumentAnswer | null, evaluation: ScenarioEvaluationResult, status: TurnStatus): AnswerSource {
  if (documentAnswer) return 'document_facts';
  if (evaluation.status === 'computed') return 'deterministic_calculation';
  return status === 'updated' ? 'user_input' : 'none';
}
