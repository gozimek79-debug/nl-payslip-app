import type { ScenarioEvaluationResult } from '../scenario/scenario-evaluate.js';
import { SCENARIO_FIELDS, type ScenarioFieldPath, type ScenarioIssue, type ScenarioRequirement, type ScenarioV1 } from '../scenario/scenario-types.js';
import { getAt, isRecord } from '../scenario/scenario-util.js';
import { assumptionFor } from './assumption-catalog.js';
import type { AnswerMode, FallbackOption, HoursClarification, NextQuestionSpec } from './conversation-types.js';

/**
 * The deterministic next-question selector (R2 §12, Lock §5.1-§5.3, §16).
 *
 * WHAT to ask is decided here, by code, from R1's own result - never by the LLM:
 *   - computed -> nothing to ask;
 *   - unsupported -> nothing to ask (no fake missing-field question);
 *   - invalid -> one correction question for the highest-priority actionable issue;
 *   - blocked -> one question for the highest-priority requirement: conflicts first, then the canonical
 *     field order below. R1's requirements are already relevance-driven (no Sunday hours -> no Sunday
 *     premium requirement) and a value already established - by a trusted document or by the user - never
 *     produces a requirement, so it is never asked again.
 * At most ONE question is returned.
 */

export const FIELD_PRIORITY: ReadonlyArray<ScenarioFieldPath | 'work.hours'> = [
  'work.hours',
  'work.regularWeekdayHours',
  'work.overtimeHours',
  'work.saturdayHours',
  'work.sundayHours',
  'work.publicHolidayHours',
  'pay.hourlyRate',
  'work.overtimeDistribution',
  'pay.overtime.thresholdHoursPerDay',
  'pay.overtime.tier1Percent',
  'pay.overtime.tier2Percent',
  'pay.saturdayPremiumPercent',
  'pay.sundayPremiumPercent',
  'pay.publicHolidayPremiumPercent',
  'tax.loonheffingskorting',
  'deductions.mode',
  'deductions.entered.pension',
  'deductions.entered.paww',
  'deductions.entered.sectorPremium',
  'deductions.entered.postTaxOther',
  'extras.travelAllowance',
  'extras.vakantiegeld.mode',
  'extras.vakantiegeld.percent',
];

/** Fields a payslip / contract usually states - "upload a document" is a real way forward for them. */
const DOCUMENT_DERIVABLE: ReadonlySet<string> = new Set([
  'pay.hourlyRate', 'pay.saturdayPremiumPercent', 'pay.sundayPremiumPercent', 'pay.publicHolidayPremiumPercent',
  'pay.overtime.thresholdHoursPerDay', 'pay.overtime.tier1Percent', 'pay.overtime.tier2Percent', 'tax.loonheffingskorting',
]);

const BAND = { correct_value: 0, resolve_conflict: 100, offer_assumption: 200, provide_value: 200, clarify_hours_composition: 200 } as const;

function fieldRank(field: string): number {
  const index = FIELD_PRIORITY.indexOf(field as ScenarioFieldPath);
  return index === -1 ? FIELD_PRIORITY.length : index;
}

function answerModeFor(field: ScenarioFieldPath | 'work.hours'): { answerMode: AnswerMode; unit?: NextQuestionSpec['unit']; options?: unknown[] } {
  if (field === 'work.hours') return { answerMode: 'hours_by_category' };
  if (field === 'work.overtimeDistribution') return { answerMode: 'overtime_distribution' };
  const spec = SCENARIO_FIELDS[field];
  if (spec.kind === 'number') return { answerMode: 'number', unit: spec.unit };
  return { answerMode: 'choice', ...(spec.allowed ? { options: [...spec.allowed] } : {}) };
}

function fallbackFor(field: ScenarioFieldPath | 'work.hours', assumptionAvailable: boolean): FallbackOption[] {
  // F5: an hours question always has a way forward - split the hours by kind, or give a range.
  if (field === 'work.hours') return ['split_hours', 'give_range'];
  const out: FallbackOption[] = [];
  if (DOCUMENT_DERIVABLE.has(field)) out.push('upload_document');
  const entry = assumptionFor(field);
  if (entry?.kind === 'alternatives') out.push('compute_both_variants');
  if (field === 'deductions.mode' && assumptionAvailable) out.push('use_estimate');
  if (SCENARIO_FIELDS[field].kind === 'number') out.push('give_range');
  if (field.startsWith('work.') && SCENARIO_FIELDS[field].kind === 'number') out.push('split_hours');
  return out;
}

/** Params every question carries; weekday hours always say they mean Monday-Friday REGULAR hours (F1/F5). */
function baseParams(field: ScenarioFieldPath | 'work.hours'): Record<string, string | number> {
  return field === 'work.regularWeekdayHours' ? { field, hoursScope: 'weekday_regular_only' } : { field };
}

/**
 * F1: the user stated a weekly total without saying the hours are Monday-Friday regular hours. ONE question
 * about its composition - the total itself is never written to the Scenario until the user says what it is.
 * After a "no" (`weekdayOnly: false`) the user is asked to split the hours by kind instead.
 */
function hoursCompositionQuestion(clarification: HoursClarification): NextQuestionSpec {
  const total = clarification.statedWeeklyTotal;
  const params: Record<string, string | number> = { field: 'work.hours', ...(typeof total === 'number' ? { statedWeeklyTotal: total } : {}) };
  if (clarification.weekdayOnly === false) {
    return {
      kind: 'provide_value',
      field: 'work.hours',
      reasonCode: 'hours_include_other_categories',
      answerMode: 'hours_by_category',
      canUseAssumption: false,
      fallbackOptions: ['split_hours', 'give_range'],
      priority: BAND.provide_value + fieldRank('work.hours'),
      prompt: { key: 'question.split_hours', params },
    };
  }
  return {
    kind: 'clarify_hours_composition',
    field: 'work.hours',
    reasonCode: 'ambiguous_hours',
    answerMode: 'choice',
    options: ['weekday_regular_only', 'includes_other_categories'],
    canUseAssumption: false,
    fallbackOptions: ['split_hours', 'give_range'],
    priority: BAND.clarify_hours_composition + fieldRank('work.hours'),
    prompt: { key: 'question.clarify_hours_composition', params },
  };
}

function questionForRequirement(requirement: ScenarioRequirement, scenario: ScenarioV1, declined: ReadonlySet<string>, clarification: HoursClarification | null): NextQuestionSpec {
  const field = requirement.field;
  if (field === 'work.hours' && clarification) return hoursCompositionQuestion(clarification);
  if (requirement.reason === 'conflict' && field !== 'work.hours') {
    const node = getAt(scenario, field);
    const candidates = isRecord(node) && Array.isArray(node.candidates)
      ? node.candidates.filter(isRecord).map((c) => ({ value: c.value, source: c.source as NonNullable<NextQuestionSpec['candidates']>[number]['source'] }))
      : [];
    return {
      kind: 'resolve_conflict',
      field,
      reasonCode: 'conflict',
      answerMode: 'pick_candidate',
      candidates,
      canUseAssumption: false,
      fallbackOptions: [],
      priority: BAND.resolve_conflict + fieldRank(field),
      prompt: { key: 'question.resolve_conflict', params: { field, candidates: candidates.length } },
    };
  }

  const entry = field === 'work.hours' ? undefined : assumptionFor(field);
  const assumptionAvailable = Boolean(entry) && !declined.has(field);
  const mode = answerModeFor(field);

  if (requirement.reason === 'unknown' && entry && assumptionAvailable) {
    return {
      kind: 'offer_assumption',
      field,
      reasonCode: 'user_does_not_know',
      answerMode: 'yes_no',
      ...(mode.unit ? { unit: mode.unit } : {}),
      canUseAssumption: true,
      suggestedAssumption: entry.kind === 'value' ? { value: entry.value, source: 'loonto_assumption' } : { options: [...entry.options], source: 'loonto_assumption' },
      fallbackOptions: fallbackFor(field, true).filter((f) => f !== 'use_estimate'),
      priority: BAND.offer_assumption + fieldRank(field),
      prompt: { key: 'question.offer_assumption', params: { ...baseParams(field), ...(entry.kind === 'value' ? { assumptionValue: entry.value } : { assumptionOptions: entry.options.length }) } },
    };
  }

  return {
    kind: 'provide_value',
    field,
    reasonCode: requirement.reason === 'unknown' ? 'user_does_not_know' : requirement.reason,
    ...mode,
    canUseAssumption: assumptionAvailable,
    fallbackOptions: fallbackFor(field, assumptionAvailable),
    priority: BAND.provide_value + fieldRank(field),
    prompt: { key: 'question.provide_value', params: baseParams(field) },
  };
}

/** Maps an R1 validation issue to the Scenario field the user can correct, or null if not user-actionable. */
function actionableField(issue: ScenarioIssue, scenario: ScenarioV1): ScenarioFieldPath | null {
  if (Object.prototype.hasOwnProperty.call(SCENARIO_FIELDS, issue.path)) return issue.path as ScenarioFieldPath;
  if (issue.path === 'work') {
    if (issue.code === 'day_hours_exceed_24' && getAt(scenario, 'work.overtimeHours') !== undefined) return 'work.overtimeDistribution';
    return 'work.regularWeekdayHours';
  }
  return null; // schemaVersion, periodType, scenarioId, requestedConcepts.N - structural, not a question
}

function correctionQuestion(issues: ScenarioIssue[], scenario: ScenarioV1): NextQuestionSpec | null {
  const actionable = issues
    .map((issue, order) => ({ issue, order, field: actionableField(issue, scenario) }))
    .filter((x): x is { issue: ScenarioIssue; order: number; field: ScenarioFieldPath } => x.field !== null)
    .sort((a, b) => fieldRank(a.field) - fieldRank(b.field) || a.order - b.order);
  const first = actionable[0];
  if (!first) return null;
  const mode = answerModeFor(first.field);
  const params: Record<string, string | number> = { field: first.field, issue: first.issue.code };
  for (const [k, v] of Object.entries(first.issue.params ?? {})) if (!(k in params)) params[k] = v;
  return {
    kind: 'correct_value',
    field: first.field,
    reasonCode: first.issue.code,
    ...mode,
    canUseAssumption: false,
    fallbackOptions: [],
    priority: BAND.correct_value + fieldRank(first.field),
    prompt: { key: 'question.correct_value', params },
  };
}

export function selectNextQuestion(input: { scenario: ScenarioV1; evaluation: ScenarioEvaluationResult; declinedAssumptions?: readonly string[]; hoursClarification?: HoursClarification | null }): NextQuestionSpec | null {
  const { scenario, evaluation } = input;
  const clarification = input.hoursClarification ?? null;
  const declined = new Set(input.declinedAssumptions ?? []);
  switch (evaluation.status) {
    case 'computed':
    case 'unsupported':
      return null;
    case 'invalid':
      return correctionQuestion(evaluation.issues, scenario);
    case 'blocked': {
      const ordered = [...evaluation.requirements].sort((a, b) => {
        const conflictA = a.reason === 'conflict' ? 0 : 1;
        const conflictB = b.reason === 'conflict' ? 0 : 1;
        return conflictA - conflictB || fieldRank(a.field) - fieldRank(b.field);
      });
      const first = ordered[0];
      return first ? questionForRequirement(first, scenario, declined, clarification) : null;
    }
  }
}
