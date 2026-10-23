import { evaluateScenario, type ScenarioEvaluationResult } from '../scenario/scenario-evaluate.js';
import { toPublicEvaluation } from '../scenario/scenario-public.js';
import { SCENARIO_FIELDS, SCENARIO_SCHEMA_VERSION, type ScenarioFieldPath, type ScenarioV1 } from '../scenario/scenario-types.js';
import { getAt, isRecord } from '../scenario/scenario-util.js';
import type { PayslipComputationRates } from '../payroll-engine/payslip-model.js';
import type { ClaimSource } from './claim-check.js';

/**
 * FIN-03: the advisor's bridge to Loonto's TRUSTED payroll calculation. The model asks for a calculation; it supplies no
 * number. The scenario is the one the server already holds for this conversation (values the user stated, accepted
 * through the R2 support guard + patch authority, plus the session's trusted document context); the arithmetic is the
 * canonical `evaluateScenario` (Scenario V1 -> validator -> mapper -> the existing Tier A engine) with the trusted
 * weekly rates (`fetchRates('week')`). Nothing here computes pay: every figure is copied from the engine's result.
 *
 * What the advisor may NOT do: inject a rate, hours, days, a premium, a tax setting or a net amount (the tool has no
 * such arguments); turn an unknown into 0 (the engine blocks on it and the result names the field); invent a Loonto
 * assumption (only catalogued ones, and only after the user agreed in a later message - advisor-tools.ts).
 */

/** Loonto assumptions the advisor may OFFER (catalogue: conversation/assumption-catalog.ts). The catalogue's orientation
 * premiums (Saturday +50% ...) are deliberately not offerable here: a premium percentage must come from the user, the
 * contract or the CAO (FIN-03 case G). */
export const ADVISOR_OFFERABLE_ASSUMPTIONS = ['deductions.mode', 'tax.loonheffingskorting'] as const satisfies readonly ScenarioFieldPath[];
export type OfferableAssumption = (typeof ADVISOR_OFFERABLE_ASSUMPTIONS)[number];

export const OFFERABLE_ASSUMPTION_MEANING: Record<OfferableAssumption, string> = {
  'deductions.mode': 'use the engine\'s own population-level ESTIMATE for pension, PAWW and sector premium (shown as an estimate with a range), instead of the user\'s exact amounts',
  'tax.loonheffingskorting': 'calculate BOTH variants - with and without the loonheffingskorting tax credit - and show the result as a range',
};

/** What the engine does not model unless the user states it - always said, never silently zero. */
const NOT_MODELLED = [
  'premiums, overtime or allowances the user did not state (night, evening, shift and other unsupported premiums are never included)',
  'CAO-specific rules and the employer\'s own payroll settings',
  'vakantiegeld paid out now, reservations, advances or other net items not stated',
  'any period other than one week',
];

export type CalculationSource = 'user_stated' | 'document_reading' | 'loonto_assumption' | 'other';

const sourceOf = (source: unknown): CalculationSource => (source === 'user' ? 'user_stated' : source === 'document' ? 'document_reading' : source === 'loonto_assumption' ? 'loonto_assumption' : 'other');

export interface CalculationCard {
  status: ScenarioEvaluationResult['status'] | 'rates_unavailable';
  resultType: 'calculated_engine_estimate';
  period: 'week';
  currency: 'EUR';
  ratesSource: 'database' | 'static' | null;
  ratesAsOf: string;
  figures: { grossTotal: number; totalTax: number; wageNet: number; payoutAmount: number; hoursWorked: number } | null;
  payoutRange: { low: number; high: number } | null;
  inputs: Array<{ field: string; source: CalculationSource; value?: unknown; options?: unknown[]; usedByEngine: boolean }>;
  assumptionsUsed: string[];
  warnings: string[];
  missing: Array<{ field: string; reason: string; canOfferAssumption: boolean }>;
  unsupported: string[];
  invalid: string[];
}

export interface PayrollEvaluation {
  /** What the MODEL receives (snake_case, plain data, no prose to copy). */
  result: Record<string, unknown>;
  /** What the interface renders (the structured engine-result card). */
  card: CalculationCard;
  /** Assumptions this evaluation offered - the user may accept them in a LATER message. */
  offered: OfferableAssumption[];
  /** The claims behind every figure (claim-check.ts kind `calculated_engine_estimate`). */
  claims: ClaimSource[];
}

function inputsOf(scenario: ScenarioV1, consumed: ReadonlySet<string>): CalculationCard['inputs'] {
  const out: CalculationCard['inputs'] = [];
  for (const field of Object.keys(SCENARIO_FIELDS) as ScenarioFieldPath[]) {
    const node = getAt(scenario, field);
    if (!isRecord(node) || node.state === 'unknown') continue;
    if (node.state === 'known') out.push({ field, source: sourceOf(node.source), value: node.value, usedByEngine: consumed.has(field) });
    else if (node.state === 'alternatives' && Array.isArray(node.options)) out.push({ field, source: sourceOf(node.source), options: [...node.options], usedByEngine: consumed.has(field) });
    else if (node.state === 'range') out.push({ field, source: sourceOf(node.source), value: { low: node.low, high: node.high }, usedByEngine: consumed.has(field) });
    else if (node.state === 'conflict') out.push({ field, source: 'other', value: 'conflict', usedByEngine: false });
  }
  return out;
}

const isOfferable = (field: string): field is OfferableAssumption => (ADVISOR_OFFERABLE_ASSUMPTIONS as readonly string[]).includes(field);

export function evaluatePayrollForAdvisor(
  scenario: ScenarioV1,
  rates: PayslipComputationRates | null,
  ratesSource: 'database' | 'static' | null,
  today: string,
): PayrollEvaluation {
  const base = { resultType: 'calculated_engine_estimate' as const, period: 'week' as const, currency: 'EUR' as const, ratesSource, ratesAsOf: today };
  if (!rates) {
    const card: CalculationCard = { ...base, status: 'rates_unavailable', figures: null, payoutRange: null, inputs: inputsOf(scenario, new Set()), assumptionsUsed: [], warnings: [], missing: [], unsupported: [], invalid: [] };
    return { card, offered: [], claims: [], result: { status: 'blocked', reason: 'tax_rates_unavailable', note: 'Loonto has no tax tables valid for today, so nothing can be calculated - say so; do not estimate.' } };
  }
  const evaluation = evaluateScenario(scenario, rates);
  const pub = toPublicEvaluation(evaluation);
  const consumed = new Set(evaluation.status === 'computed' ? evaluation.provenance.filter((p) => p.consumedByEngine).map((p) => p.path) : []);
  const inputs = inputsOf(scenario, consumed);
  const missing = evaluation.status === 'blocked'
    ? evaluation.requirements.map((r) => ({ field: r.field, reason: r.reason, canOfferAssumption: isOfferable(r.field) && (r.resolvableBy.explicitAssumption || r.resolvableBy.deterministicVariants) }))
    : [];
  const offered = missing.filter((m) => m.canOfferAssumption).map((m) => m.field as OfferableAssumption);
  const unsupported = evaluation.status === 'unsupported' ? evaluation.unsupported.map((u) => ('concept' in u ? String(u.concept) : 'capability' in u ? String(u.capability) : 'unsupported')) : [];
  const invalid = evaluation.status === 'invalid' ? evaluation.issues.map((i) => `${i.path}:${i.code}`) : [];
  const figures = evaluation.status === 'computed' ? { ...evaluation.figures } : null;
  const payoutRange = evaluation.status === 'computed' && evaluation.range ? { low: evaluation.range.low, high: evaluation.range.high } : null;
  const warnings = 'warnings' in pub && Array.isArray(pub.warnings) ? pub.warnings.map((w) => String((w as { code?: unknown }).code ?? 'warning')) : [];
  const assumptionsUsed = evaluation.status === 'computed' ? evaluation.assumptionsUsed.map((a) => a.path) : [];

  const card: CalculationCard = { ...base, status: evaluation.status, figures, payoutRange, inputs, assumptionsUsed, warnings, missing, unsupported, invalid };
  const claims: ClaimSource[] = [];
  if (figures) {
    claims.push(
      { value: figures.grossTotal, kind: 'calculated_engine_estimate', topic: 'gross', key: 'gross_total' },
      { value: figures.totalTax, kind: 'calculated_engine_estimate', topic: 'tax', key: 'total_tax' },
      { value: figures.wageNet, kind: 'calculated_engine_estimate', topic: 'net', key: 'wage_net' },
      { value: figures.payoutAmount, kind: 'calculated_engine_estimate', topic: 'payout', key: 'payout_amount' },
      { value: figures.hoursWorked, kind: 'tool_value' },
    );
  }
  if (payoutRange) claims.push({ value: payoutRange.low, kind: 'calculated_engine_estimate', topic: 'payout', key: 'payout_range' }, { value: payoutRange.high, kind: 'calculated_engine_estimate', topic: 'payout', key: 'payout_range' });
  for (const input of inputs) {
    if (typeof input.value !== 'number') continue;
    claims.push(input.source === 'document_reading' ? { value: input.value, kind: 'document_reading', topic: input.field === 'pay.hourlyRate' ? 'hourly_rate' : null, key: input.field } : { value: input.value, kind: input.source === 'user_stated' ? 'user_stated' : 'tool_value' });
  }

  const result: Record<string, unknown> = {
    status: evaluation.status,
    result_type: 'calculated_engine_estimate',
    period: 'week',
    currency: 'EUR',
    calculation: { engine: `scenario_v${SCENARIO_SCHEMA_VERSION}_tier_a`, rates_source: ratesSource, rates_as_of: today },
    ...(figures ? { figures: { gross_total: figures.grossTotal, total_tax: figures.totalTax, wage_net: figures.wageNet, payout_amount: figures.payoutAmount, hours_worked: figures.hoursWorked } } : {}),
    ...(payoutRange ? { payout_range: { low: payoutRange.low, high: payoutRange.high, why: 'some inputs have alternatives or an engine estimate - the true figure can lie anywhere in this range' } } : {}),
    inputs: inputs.map((i) => ({ field: i.field, source: i.source, ...(i.value !== undefined ? { value: i.value } : {}), ...(i.options ? { options: i.options } : {}), used_by_engine: i.usedByEngine })),
    ...(assumptionsUsed.length > 0 ? { assumptions_used: assumptionsUsed } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(missing.length > 0 ? { missing: missing.map((m) => ({ field: m.field, reason: m.reason, ask_user: true, loonto_assumption_possible: m.canOfferAssumption })) } : {}),
    ...(offered.length > 0 ? { offerable_assumptions: offered.map((f) => ({ field: f, meaning: OFFERABLE_ASSUMPTION_MEANING[f] })) } : {}),
    ...(unsupported.length > 0 ? { unsupported } : {}),
    ...(invalid.length > 0 ? { invalid } : {}),
    not_modelled: NOT_MODELLED,
    note: figures
      ? 'Loonto engine ESTIMATE for one week from exactly the inputs listed (sources given) - not the employer\'s verified payout, not a legal entitlement, not a guarantee. Name the assumptions; wage_net and payout_amount are different concepts.'
      : 'No calculation: name only the missing / unsupported items listed and why they matter; never estimate them yourself.',
  };
  return { result, card, offered, claims };
}

// ---------------------------------------------------------------------------------------------
// Choice values and consent - what update_scenario may write for the closed-choice fields
// ---------------------------------------------------------------------------------------------

const MENTIONS: Partial<Record<ScenarioFieldPath, RegExp>> = {
  'tax.loonheffingskorting': /loonheffingskorting|heffingskorting|korting|ulg[aęiąo]\w*\s*podatkow|ulgę|ulgi|ulga|tax credit|tax relief/iu,
  'deductions.mode': /emerytal|emerytur|pension|pensioen|paww|sektorow|sector|potrąc|potrac|deduction|inhouding|składk/iu,
  'extras.vakantiegeld.mode': /vakantiegeld|urlopow|holiday allowance|holiday pay/iu,
};
const NEGATED = /(?<![\p{L}])(?:nie|bez|brak|not|no|without|geen|zonder|don't|do not)(?![\p{L}])/iu;
const NEGATION_WINDOW = 28;

/**
 * A closed-choice value (tax credit, deductions mode, vakantiegeld mode) is written only when the user's present message
 * talks about that subject, with a negation for the negative value - the model cannot choose a tax setting the user
 * never mentioned. `deductions.mode = estimate` is never a user write: it is a Loonto assumption (accept_assumption).
 */
export function choiceSupported(field: string, value: unknown, message: string): boolean {
  const mention = MENTIONS[field as ScenarioFieldPath];
  if (!mention) return true;
  const found = mention.exec(message);
  if (!found) return false;
  if (field === 'deductions.mode') return value === 'enter';
  const negative = value === 'not_applied' || value === 'none';
  // The negation must belong to THIS subject: the same clause, just before or right after the mention
  // ("nie mam loonheffingskorting", "loonheffingskorting: nie") - not a "bez dodatków" elsewhere in the sentence.
  const start = found.index;
  const before = message.slice(Math.max(0, start - NEGATION_WINDOW), start).split(/[;,.!?\n]/u).pop() ?? '';
  const after = message.slice(start + found[0].length, start + found[0].length + 12).split(/[;,.!?\n]/u)[0] ?? '';
  const negated = NEGATED.test(before) || /^\s*[:-]?\s*(?:nie|no|not|geen)(?![\p{L}])/iu.test(after);
  return negative ? negated : !negated;
}

/** The user agreeing to an offered Loonto assumption, in this message. */
export const CONSENT = /(?<![\p{L}])(?:tak|ok|okej|okay|dobrze|zgoda|zgadzam|przyjmij|przyjmuję|oszacuj|szacuj|szacunek|szacunkowo|niech będzie|yes|yep|sure|go ahead|estimate|accept|agreed|fine)(?![\p{L}])/iu;
