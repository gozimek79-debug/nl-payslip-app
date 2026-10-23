import { z } from 'zod';
import { answerFacts, DOCUMENT_TOPICS, type DocumentKnowledge, type KnowledgeFact } from '../document-context/knowledge.js';
import { scenarioPatchSchema, type ScenarioPatchV1 } from '../conversation/scenario-patch.js';
import { guardModelPatch } from '../conversation/support-guard.js';
import { applyScenarioPatch } from '../conversation/patch-authority.js';
import { evaluateScenario, type ScenarioEvaluationResult } from '../scenario/scenario-evaluate.js';
import { SCENARIO_FIELD_PATHS, SCENARIO_FIELDS, type ScenarioFieldPath, type ScenarioV1 } from '../scenario/scenario-types.js';
import { getAt, isRecord } from '../scenario/scenario-util.js';
import type { PayslipComputationRates } from '../payroll-engine/payslip-model.js';
import { capabilitiesForModel, moduleByTarget, NAVIGATION_TARGETS, type ModuleStatus, type NavigationTarget } from './capabilities.js';
import { baseWageOrientation, MAX_HOURS_PER_DAY, type OrientationResult } from './base-wage-orientation.js';
import { orientationToolEnabled } from './advisor-config.js';
import { numbersInValue } from './grounding.js';
import { scheduleBuckets, statedInDialogue, type DialogueTurn } from './hours-statements.js';
import type { ClaimSource } from './claim-check.js';
import { CONSENT, choiceSupported, evaluatePayrollForAdvisor, type CalculationCard } from './payroll-evaluation.js';
import type { ToolSpec } from './advisor-model.js';

/**
 * AI-001 typed tool registry. The model may only reach Loonto through these tools; every argument is validated here
 * (zod, closed enums, bounds), every result is built by the server from server-held state. A tool never takes a value
 * from the model on trust: document facts come only from the session's server-held context, scenario edits go through
 * the R2 support guard + patch authority + R1 validator, and the orientation tool takes its hourly rate from the
 * trusted scenario and its hours and days only as the user stated them (P0-1: hours-statements.ts).
 */

export interface ToolContext {
  /** The conversation so far, the current user message last (provenance of stated hours and days, confirmations). */
  dialogue: DialogueTurn[];
  currentMessage: string;
  knowledge: DocumentKnowledge | null;
  documentStatus: 'none' | 'available' | 'expired';
  /** User values + the trusted document values merged in for this turn; changed only by update_scenario. */
  scenario: ScenarioV1;
  rates: PayslipComputationRates | null;
  /** FIN-03: where the trusted rates came from (`fetchRates`), and the date they apply to. */
  ratesSource?: 'database' | 'static' | null;
  today?: string;
  /** FIN-03: Loonto assumptions offered in an EARLIER turn of this conversation (server-held) - the only ones the user
   * can accept, and only with their own "yes" in the current message. */
  offeredAssumptions?: readonly string[];
  /** Filled by the tools during the turn. */
  orientation: (OrientationResult & { hoursBasis: string; rateSource: string }) | null;
  navigation: Array<{ target: NavigationTarget; status: ModuleStatus }>;
  /** FIN-03: the last engine evaluation of this turn (the interface's result card), and the assumptions it offered. */
  calculation?: CalculationCard | null;
  newlyOffered?: string[];
  acceptedAssumptions?: string[];
}

export const ADVISOR_TOOL_NAMES = ['get_app_capabilities', 'get_document_facts', 'get_scenario_state', 'update_scenario', 'evaluate_payroll_scenario', 'calculate_base_wage_orientation', 'offer_navigation'] as const;
export type AdvisorToolName = (typeof ADVISOR_TOOL_NAMES)[number];

export const ADVISOR_TOOLS: ToolSpec[] = [
  {
    name: 'get_app_capabilities',
    description: 'Loonto\'s customer-facing modules (free calculator, Calculator PRO, contract analysis, payslip analysis, glossary, account) with their REAL status (available / alpha / coming_soon), purpose, limits and navigation target; plus what this advisor can and cannot calculate.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_document_facts',
    description: 'Facts printed on the document(s) the user uploaded in this session (readings, not verified): hourly rate (or a conflict between printed rates), paid hours, period, gross, net, payout, reimbursements, deductions, wage lines with their component (regular_wage, night_premium, adv, shift_premium, ...). Optional topics narrow the answer.',
    parameters: { type: 'object', properties: { topics: { type: 'array', items: { type: 'string', enum: [...DOCUMENT_TOPICS] }, maxItems: DOCUMENT_TOPICS.length } }, additionalProperties: false },
  },
  {
    name: 'get_scenario_state',
    description: 'The current weekly scenario: values the user stated, document values Loonto trusts, conflicts, and what a calculation still needs (requirements decided by Loonto\'s code).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_scenario',
    description: 'Record values the user stated in THIS message (e.g. weekday hours, Saturday hours, hourly rate, a premium percentage, whether the loonheffingskorting tax credit is applied, deduction amounts). Loonto accepts only values the user actually wrote; derived, inferred or assumed values and any source claims are rejected. A correction replaces the earlier value (set the field again). Fields: work.regularWeekdayHours (Mon-Fri hours), work.saturdayHours, work.sundayHours, work.publicHolidayHours, work.overtimeHours, pay.hourlyRate, pay.saturdayPremiumPercent, pay.sundayPremiumPercent, pay.publicHolidayPremiumPercent (premium ABOVE base: 50 = x1.5), pay.overtime.tier1Percent, tax.loonheffingskorting (applied|not_applied), deductions.mode (enter), deductions.entered.pension, deductions.entered.paww, deductions.entered.sectorPremium, extras.travelAllowance. accept_assumption {field}: ONLY for a field listed in offerable_assumptions of an evaluation in an EARLIER turn, and only when the user agreed in THIS message.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['ops'],
      properties: {
        ops: {
          type: 'array', maxItems: 12,
          items: {
            type: 'object', required: ['op'],
            properties: {
              op: { type: 'string', enum: ['set', 'set_unknown', 'remove', 'request_concept', 'accept_assumption'] },
              field: { type: 'string' },
              value: { type: ['number', 'string'] },
              concept: { type: 'string', description: 'for request_concept: night_premium, shift_premium, ...' },
            },
          },
        },
      },
    },
  },
  {
    name: 'evaluate_payroll_scenario',
    description: 'Run Loonto\'s trusted payroll engine (Dutch weekly pay: gross, wage tax, net wage, payout) on the scenario Loonto holds for this conversation - the values recorded with update_scenario and the trusted document context. Takes no values: record the user\'s values first. Returns status computed (figures + every input with its source + assumptions used + range), blocked (exactly which inputs are missing; offerable Loonto assumptions), unsupported or invalid. The ONLY source of gross / tax / net / payout figures - always an ESTIMATE from the stated inputs, never the employer\'s verified payout.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'calculate_base_wage_orientation',
    description: 'ORIENTATION only: hours x the base hourly rate Loonto holds (from the document or stated by the user). Give EITHER hours_total (a weekly total the user stated, e.g. "56 hours") OR per_day_hours with days - only when the user stated BOTH the hours per day AND the number of days (e.g. "Monday to Sunday, 8 h a day"). Never derive per-day hours from a total or infer the number of days; if they were not stated, ask. Returns the amount plus what it excludes (premiums, holiday pay, tax, deductions - not gross or net pay). Refuses when the rate is unknown or the document rates conflict.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        hours_total: { type: 'number', description: 'total hours the user stated for the week' },
        per_day_hours: { type: 'number', description: 'hours per day the user stated' },
        days: { type: 'integer', minimum: 1, maximum: 7, description: 'number of working days the user stated (Monday to Sunday = 7)' },
      },
    },
  },
  {
    name: 'offer_navigation',
    description: 'Show the user a button to a Loonto module. Only available modules get a working button; coming_soon modules are shown as "in preparation".',
    parameters: { type: 'object', additionalProperties: false, required: ['targets'], properties: { targets: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', enum: [...NAVIGATION_TARGETS] } } } },
  },
];

// ---------------------------------------------------------------------------------------------
// Argument schemas (the model's JSON is parsed, then validated - never trusted)
// ---------------------------------------------------------------------------------------------

const empty = z.strictObject({});
const documentFactsArgs = z.strictObject({ topics: z.array(z.enum(DOCUMENT_TOPICS)).max(DOCUMENT_TOPICS.length).optional() });
const orientationArgs = z.strictObject({
  hours_total: z.number().positive().max(112).optional(),
  per_day_hours: z.number().positive().max(MAX_HOURS_PER_DAY).optional(),
  days: z.number().int().min(1).max(7).optional(),
});
const navigationArgs = z.strictObject({ targets: z.array(z.enum(NAVIGATION_TARGETS)).min(1).max(3) });
const updateArgs = z.strictObject({ ops: z.array(z.record(z.string(), z.unknown())).max(12) });

// ---------------------------------------------------------------------------------------------
// Document facts - typed, no printed text
// ---------------------------------------------------------------------------------------------

const COMPONENTS: Array<[string, RegExp]> = [
  ['night_premium', /nacht|night|nocn/i],
  ['saturday_premium', /zaterdag|saturday|sobot/i],
  ['sunday_premium', /zondag|sunday|niedziel/i],
  ['public_holiday_premium', /feestdag|public holiday|świąt|swiat/i],
  ['overtime', /overwerk|overuren|overtime|nadgodz/i],
  ['adv', /\badv\b|arbeidsduurverkort/i],
  ['shift_premium', /ploeg|shift|onregelmatig|\bort\b/i],
  ['regular_wage', /normaal|normale|gewerkt|regular|basis/i],
  ['travel_reimbursement', /reis|travel|dojazd|kilometer/i],
  ['pension', /pensioen|pension|stipp/i],
  ['sector_premium', /ziektewet|zw\b|paww|wga/i],
  ['tax', /loonheffing|\btax\b|podat/i],
];
const COMPONENT_KEYS = new Set(['wage_line_amount', 'surcharge_percent', 'deduction', 'net_deduction', 'reimbursement', 'regular_hours', 'overtime_hours']);

/** A wage line's printed label mapped onto a closed vocabulary - the model never sees the printed text itself. */
export function componentOf(label: string | null): string | null {
  if (!label) return null;
  for (const [component, pattern] of COMPONENTS) if (pattern.test(label)) return component;
  return 'other';
}

/** A period label is passed on only when it is a plain period ("week 41/2026", "oktober 2026"), never free text. */
function safePeriod(label: string | null): string | null {
  return label && /^[\p{L}\d\s/.\-]{1,30}$/u.test(label) ? label.trim() : null;
}

export function documentFactsForModel(knowledge: DocumentKnowledge, topics?: readonly string[]) {
  const facts: KnowledgeFact[] = topics && topics.length > 0 ? answerFacts(knowledge, topics as never) : knowledge.facts;
  return facts.slice(0, 40).map((f) => ({
    topic: f.topic, key: f.key, value: f.value, unit: f.unit, status: f.status,
    ...(COMPONENT_KEYS.has(f.key) ? { component: componentOf(f.label) } : {}),
    document: `${f.role === 'payslip' ? 'payslip' : 'contract'} ${f.documentIndex + 1}`,
    ...(safePeriod(f.periodLabel) ? { period: safePeriod(f.periodLabel) } : {}),
  }));
}

// ---------------------------------------------------------------------------------------------
// Scenario state
// ---------------------------------------------------------------------------------------------

export function scenarioStateForModel(scenario: ScenarioV1, evaluation: ScenarioEvaluationResult | null, documentStatus: ToolContext['documentStatus']) {
  const stated: Array<Record<string, unknown>> = [];
  for (const field of SCENARIO_FIELD_PATHS) {
    const node = getAt(scenario, field);
    if (!isRecord(node)) continue;
    const entry: Record<string, unknown> = { field, state: node.state };
    if ('value' in node) entry.value = node.value;
    if (typeof node.source === 'string') entry.source = node.source === 'document' ? 'document_reading' : node.source;
    if (Array.isArray(node.candidates)) entry.candidates = node.candidates.filter(isRecord).map((c) => ({ value: c.value, source: c.source === 'document' ? 'document_reading' : c.source }));
    stated.push(entry);
  }
  const requirements = evaluation?.status === 'blocked' ? evaluation.requirements.slice(0, 10).map((r) => ({ field: r.field, reason: r.reason }))
    : evaluation?.status === 'invalid' ? evaluation.issues.slice(0, 10).map((i) => ({ field: i.path, reason: i.code })) : [];
  return {
    stated,
    requirements,
    // Never an amount: a full calculation is not offered through the advisor in AI-001.
    calculation_status: evaluation === null ? 'unknown' : evaluation.status === 'computed' ? 'ready - call evaluate_payroll_scenario for the figures' : evaluation.status,
    unsupported_concepts: (scenario.requestedConcepts ?? []).map((c) => c.concept),
    document_context: documentStatus,
  };
}

// ---------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------

const statedIn = (values: readonly number[], value: number) => values.some((v) => Math.abs(v - value) < 0.005);
const isScenarioField = (field: string): field is ScenarioFieldPath => Object.prototype.hasOwnProperty.call(SCENARIO_FIELDS, field);
const SCHEDULE_FIELDS: Record<string, 'regularWeekdayHours' | 'saturdayHours' | 'sundayHours' | undefined> = {
  'work.regularWeekdayHours': 'regularWeekdayHours', 'work.saturdayHours': 'saturdayHours', 'work.sundayHours': 'sundayHours',
};
/** An op that claims a source other than the user - the authority guard rejects it; never treated as derived. */
const claimsSource = (op: object) => 'source' in op && (op as { source?: unknown }).source !== undefined && (op as { source?: unknown }).source !== 'user';

function rateFromScenario(scenario: ScenarioV1): { ok: true; rate: number; source: string } | { ok: false; reason: 'rate_conflict' | 'rate_unknown'; candidates?: number[] } {
  const node = getAt(scenario, 'pay.hourlyRate');
  if (isRecord(node) && node.state === 'known' && typeof node.value === 'number') return { ok: true, rate: node.value, source: node.source === 'document' ? 'document_reading' : String(node.source) };
  if (isRecord(node) && node.state === 'conflict' && Array.isArray(node.candidates)) {
    return { ok: false, reason: 'rate_conflict', candidates: node.candidates.filter(isRecord).map((c) => c.value).filter((v): v is number => typeof v === 'number') };
  }
  return { ok: false, reason: 'rate_unknown' };
}

export interface ToolExecution {
  status: 'ok' | 'refused' | 'invalid_arguments';
  result: unknown;
}

export function executeTool(name: string, rawArguments: string, ctx: ToolContext): ToolExecution {
  let args: unknown;
  try {
    args = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
  } catch {
    return { status: 'invalid_arguments', result: { error: 'arguments_not_json' } };
  }
  switch (name) {
    case 'get_app_capabilities': {
      if (!empty.safeParse(args).success) return { status: 'invalid_arguments', result: { error: 'no_arguments_expected' } };
      return { status: 'ok', result: capabilitiesForModel() };
    }
    case 'get_document_facts': {
      const parsed = documentFactsArgs.safeParse(args);
      if (!parsed.success) return { status: 'invalid_arguments', result: { error: 'invalid_topics' } };
      if (ctx.documentStatus !== 'available' || !ctx.knowledge) return { status: 'ok', result: { available: false, reason: ctx.documentStatus === 'expired' ? 'document_context_expired' : 'no_document_uploaded' } };
      return { status: 'ok', result: { available: true, note: 'printed readings of the user\'s document - not verified; status "conflict" = the document prints different values', facts: documentFactsForModel(ctx.knowledge, parsed.data.topics) } };
    }
    case 'get_scenario_state': {
      if (!empty.safeParse(args).success) return { status: 'invalid_arguments', result: { error: 'no_arguments_expected' } };
      const evaluation = ctx.rates ? evaluateScenario(ctx.scenario, ctx.rates) : null;
      return { status: 'ok', result: scenarioStateForModel(ctx.scenario, evaluation, ctx.documentStatus) };
    }
    case 'update_scenario': {
      const parsed = updateArgs.safeParse(args);
      if (!parsed.success) return { status: 'invalid_arguments', result: { error: 'invalid_ops' } };
      const patchParse = scenarioPatchSchema.safeParse({ version: 1, ops: parsed.data.ops });
      if (!patchParse.success) return { status: 'invalid_arguments', result: { error: 'ops_not_in_scenario_patch_schema' } };
      const patch: ScenarioPatchV1 = patchParse.data;
      const withheld: Array<{ field: string | null; reason: string }> = [];
      const recorded: Array<Record<string, unknown>> = [];
      // FIN-03: a Loonto assumption is accepted only if Loonto offered it in an EARLIER turn and the user agrees NOW.
      const accepts = patch.ops.filter((op): op is Extract<typeof op, { op: 'accept_assumption' }> => op.op === 'accept_assumption');
      for (const op of accepts) {
        if (!(ctx.offeredAssumptions ?? []).includes(op.field)) { withheld.push({ field: op.field, reason: 'assumption_not_offered_earlier' }); continue; }
        if (!CONSENT.test(ctx.currentMessage)) { withheld.push({ field: op.field, reason: 'no_user_consent_in_this_message' }); continue; }
        const accepted = applyScenarioPatch(ctx.scenario, { version: 1, ops: [op] }, { offeredAssumption: op.field as ScenarioFieldPath });
        if (accepted.status === 'applied') {
          ctx.scenario = accepted.scenario;
          recorded.push({ op: 'accept_assumption', field: op.field, source: 'loonto_assumption' });
          (ctx.acceptedAssumptions ??= []).push(op.field);
        } else withheld.push({ field: op.field, reason: accepted.status === 'rejected' ? accepted.issues[0]?.code ?? 'rejected' : 'not_applied' });
      }
      // FIN-03: a closed-choice value (tax credit, deductions mode, vakantiegeld) only when the user talked about it.
      const ops = patch.ops.filter((op) => {
        if (op.op === 'accept_assumption') return false;
        if (op.op === 'set' && 'field' in op && isScenarioField(op.field) && SCENARIO_FIELDS[op.field].kind === 'choice' && !choiceSupported(op.field, op.value, ctx.currentMessage)) {
          withheld.push({ field: op.field, reason: 'choice_not_stated_by_user' });
          return false;
        }
        return true;
      });
      // FIN-03: hours buckets a STATED schedule determines (one per-day figure x one explicit day span) - the model's value
      // must equal the derivation exactly; anything else goes to the R2 guard as before (a total is never split).
      const stated = statedInDialogue(ctx.dialogue);
      const schedule = scheduleBuckets(stated);
      const derived = ops.filter((op) => {
        if (op.op !== 'set' || !('field' in op) || claimsSource(op)) return false;
        // A base hourly rate the user stated as such ("po 16 €", "16 € za godzinę") - see hours-statements.ts ratesIn.
        if (op.field === 'pay.hourlyRate') return typeof op.value === 'number' && stated.rates.some((r) => Math.abs(r - (op.value as number)) < 0.005);
        if (!schedule) return false;
        const key = SCHEDULE_FIELDS[op.field];
        const expected = key ? schedule[key] : undefined;
        return typeof expected === 'number' && typeof op.value === 'number' && Math.abs(op.value - expected) < 0.005;
      });
      // The R2 support guard: only values the user wrote in THIS message survive.
      const guarded = guardModelPatch({ version: 1, ops: ops.filter((op) => !derived.includes(op)) }, ctx.currentMessage, null);
      withheld.push(...guarded.notes.map((n) => ({ field: n.field, reason: n.code })));
      const outcome = applyScenarioPatch(ctx.scenario, { version: 1, ops: [...guarded.patch.ops, ...derived] }, { offeredAssumption: null });
      if (outcome.status === 'rejected') return { status: 'refused', result: { recorded, withheld, rejected: outcome.issues.map((i) => ({ field: i.field ?? null, reason: i.code })) } };
      if (outcome.status === 'applied') ctx.scenario = outcome.scenario;
      if (outcome.status === 'applied') recorded.push(...outcome.applied.map((op) => ({ op: op.op, ...('field' in op ? { field: op.field } : {}), ...('concept' in op ? { concept: op.concept } : {}) })));
      return { status: 'ok', result: { recorded, withheld } };
    }
    case 'evaluate_payroll_scenario': {
      if (!empty.safeParse(args).success) return { status: 'invalid_arguments', result: { error: 'no_arguments_expected - record values with update_scenario first' } };
      const evaluation = evaluatePayrollForAdvisor(ctx.scenario, ctx.rates, ctx.ratesSource ?? null, ctx.today ?? new Date().toISOString().slice(0, 10));
      ctx.calculation = evaluation.card;
      ctx.newlyOffered = evaluation.offered;
      return { status: 'ok', result: evaluation.result };
    }
    case 'calculate_base_wage_orientation': {
      if (!orientationToolEnabled()) return { status: 'refused', result: { ok: false, reason: 'tool_disabled' } };
      const parsed = orientationArgs.safeParse(args);
      if (!parsed.success) return { status: 'invalid_arguments', result: { ok: false, reason: 'invalid_arguments' } };
      const { hours_total: total, per_day_hours: perDay, days } = parsed.data;
      // P0-1: every number of hours and of days must be one the user stated (or explicitly confirmed) - see hours-statements.ts.
      const stated = statedInDialogue(ctx.dialogue);
      let hours: number;
      let hoursBasis: string;
      if (total !== undefined && perDay === undefined && days === undefined) {
        if (!statedIn(stated.totals, total)) return { status: 'refused', result: { ok: false, reason: 'hours_total_not_stated_by_user', hint: 'use only a weekly total of hours the user stated, or ask for it' } };
        hours = total;
        hoursBasis = 'total_stated_by_user';
      } else if (total === undefined && perDay !== undefined && days !== undefined) {
        if (!statedIn(stated.perDay, perDay)) return { status: 'refused', result: { ok: false, reason: 'per_day_hours_not_stated_by_user', hint: 'a weekly total is not a per-day schedule; use hours_total, or ask how many hours a day' } };
        if (!stated.days.includes(days)) return { status: 'refused', result: { ok: false, reason: 'days_not_stated_by_user', hint: 'ask how many days a week the user works (Monday to Sunday = 7); do not assume it' } };
        hours = Math.round(perDay * 100 * days) / 100;
        hoursBasis = `per_day_${perDay}_x_${days}_days`;
      } else {
        return { status: 'invalid_arguments', result: { ok: false, reason: 'give_hours_total_or_per_day_hours_with_days' } };
      }
      const rate = rateFromScenario(ctx.scenario);
      if (!rate.ok) return { status: 'refused', result: { ok: false, reason: rate.reason, ...(rate.candidates ? { candidates: rate.candidates } : {}) } };
      const calc = baseWageOrientation(hours, rate.rate);
      if (!calc.ok) return { status: 'refused', result: { ok: false, reason: calc.reason } };
      ctx.orientation = { ...calc.result, hoursBasis, rateSource: rate.source };
      return {
        status: 'ok',
        result: {
          ok: true, result_type: calc.result.resultType, formula: 'hours x base hourly rate', hours: calc.result.hours, hours_basis: hoursBasis,
          hourly_rate: calc.result.hourlyRate, rate_source: rate.source, amount: calc.result.amount, currency: 'EUR', excludes: calc.result.excludes,
          note: 'orientation only - not gross pay, not net pay, not a legal entitlement',
        },
      };
    }
    case 'offer_navigation': {
      const parsed = navigationArgs.safeParse(args);
      if (!parsed.success) return { status: 'invalid_arguments', result: { error: 'unknown_target' } };
      const offered = [...new Set(parsed.data.targets)].map((target) => ({ target, status: moduleByTarget(target)?.status ?? 'coming_soon' as ModuleStatus }));
      for (const item of offered) if (!ctx.navigation.some((n) => n.target === item.target)) ctx.navigation.push(item);
      return { status: 'ok', result: { offered } };
    }
    default:
      return { status: 'invalid_arguments', result: { error: 'unknown_tool' } };
  }
}

// ---------------------------------------------------------------------------------------------
// P0-2: the claims behind every number a tool or a document supplies (claim-check.ts)
// ---------------------------------------------------------------------------------------------

/** The document's printed figures, each with what it is (topic, key, component, period). */
export function claimSourcesFromKnowledge(knowledge: DocumentKnowledge | null): ClaimSource[] {
  if (!knowledge) return [];
  return knowledge.facts.flatMap((f) => (typeof f.value === 'number' ? [{
    value: f.value, kind: 'document_reading' as const, topic: f.topic, key: f.key,
    component: COMPONENT_KEYS.has(f.key) ? componentOf(f.label) : null, period: safePeriod(f.periodLabel),
  }] : []));
}

const sourceKind = (rateSource: unknown): ClaimSource['kind'] => (rateSource === 'document_reading' ? 'document_reading' : rateSource === 'user' || rateSource === 'correction' ? 'user_stated' : 'tool_value');

/** What a tool result's numbers ARE: the orientation amount is indicative only; document facts stay document readings. */
export function claimSourcesFromTool(name: string, result: unknown): ClaimSource[] {
  if (!isRecord(result)) return [];
  if (name === 'calculate_base_wage_orientation' && result.ok === true && typeof result.amount === 'number') {
    const out: ClaimSource[] = [{ value: result.amount, kind: 'indicative_base_wage_only' }];
    if (typeof result.hourly_rate === 'number') out.push({ value: result.hourly_rate, kind: sourceKind(result.rate_source), topic: 'hourly_rate', key: 'hourly_rate' });
    if (typeof result.hours === 'number') out.push({ value: result.hours, kind: 'tool_value' });
    return out;
  }
  if (name === 'evaluate_payroll_scenario') {
    const out: ClaimSource[] = [];
    const figures = isRecord(result.figures) ? result.figures : null;
    const keys: Array<[string, string]> = [['gross_total', 'gross'], ['total_tax', 'tax'], ['wage_net', 'net'], ['payout_amount', 'payout']];
    if (figures) for (const [key, topic] of keys) if (typeof figures[key] === 'number') out.push({ value: figures[key] as number, kind: 'calculated_engine_estimate', topic, key });
    if (figures && typeof figures.hours_worked === 'number') out.push({ value: figures.hours_worked, kind: 'tool_value' });
    const range = isRecord(result.payout_range) ? result.payout_range : null;
    if (range) for (const v of [range.low, range.high]) if (typeof v === 'number') out.push({ value: v, kind: 'calculated_engine_estimate', topic: 'payout', key: 'payout_range' });
    const inputs = Array.isArray(result.inputs) ? result.inputs.filter(isRecord) : [];
    for (const i of inputs) {
      if (typeof i.value !== 'number') continue;
      out.push(i.source === 'document_reading' ? { value: i.value, kind: 'document_reading', topic: i.field === 'pay.hourlyRate' ? 'hourly_rate' : null, key: String(i.field) } : { value: i.value, kind: i.source === 'user_stated' ? 'user_stated' : 'tool_value' });
    }
    return out;
  }
  if (name === 'get_document_facts' && Array.isArray(result.facts)) {
    return result.facts.filter(isRecord).flatMap((f) => (typeof f.value === 'number' ? [{
      value: f.value, kind: 'document_reading' as const, topic: typeof f.topic === 'string' ? f.topic : null, key: typeof f.key === 'string' ? f.key : null,
      component: typeof f.component === 'string' ? f.component : null, period: typeof f.period === 'string' ? f.period : null,
    }] : []));
  }
  return numbersInValue(result).map((value) => ({ value, kind: 'tool_value' as const }));
}
