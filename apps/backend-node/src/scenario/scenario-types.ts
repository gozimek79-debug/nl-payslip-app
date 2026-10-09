/**
 * Scenario V1 - the canonical, user-intent-oriented description of ONE weekly payroll question
 * (LOONTO-ARCHITECTURE-UX-LOCK-v1.1 §7, §15; ZADANIE-LOONTO-R1-SCENARIO-CORE).
 *
 * Authority chain (hard rule, §3 of the task): Scenario V1 -> validateScenario -> mapScenarioToEngine
 * -> the EXISTING Tier A engine (computeTierAResult) -> ScenarioEvaluationResult. Nothing in this
 * directory calculates gross, net, tax or any payroll money: it normalises, validates, maps, selects
 * deterministic variants and aggregates engine outputs. Unknown material inputs are never defaulted -
 * they are `unknown` / absent and the evaluation is `blocked`.
 *
 * Everything here is data: stable codes and parameters, never user-facing prose (CONVENTIONS.md).
 */

export const SCENARIO_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------------------------
// Provenance (§4.4) - a contract that is compatible with the future CAO Intelligence and Payroll
// Intelligence Memory, without implementing either.
// ---------------------------------------------------------------------------------------------

export const SCENARIO_VALUE_SOURCES = ['document', 'user', 'cao_rule', 'official_rule', 'intelligence_memory', 'loonto_assumption'] as const;
export type ScenarioValueSource = (typeof SCENARIO_VALUE_SOURCES)[number];

/** Where a value came from. `ref` is an OPAQUE identifier (a document id, a rule id) - never a file
 * name, person name or other personal data (Lock §40). A `loonto_assumption` is never a verified fact. */
export interface ScenarioValueOrigin {
  source: ScenarioValueSource;
  ref?: string;
}

// ---------------------------------------------------------------------------------------------
// Values (§4.5): exact, explicit assumption (source === 'loonto_assumption'), bounded range /
// alternatives, unresolved conflict, or unknown. Never an invented certainty.
// ---------------------------------------------------------------------------------------------

export interface KnownValue<T> extends ScenarioValueOrigin {
  state: 'known';
  value: T;
}
/** A bounded numeric uncertainty. Evaluated by separate deterministic engine runs (scenario-evaluate). */
export interface RangeValue extends ScenarioValueOrigin {
  state: 'range';
  low: number;
  high: number;
}
/** Two or more discrete candidates for a choice, each evaluated by its own engine run. The FIRST
 * option is the producer's preferred one and is the representative when the swing is not material. */
export interface AlternativesValue<T> extends ScenarioValueOrigin {
  state: 'alternatives';
  options: T[];
}
/** Competing values that reached the Scenario unresolved - Scenario Core never picks a winner (§7). */
export interface ConflictValue<T> {
  state: 'conflict';
  candidates: Array<{ value: T } & ScenarioValueOrigin>;
}
export interface UnknownValue {
  state: 'unknown';
}

export type NumberValue = KnownValue<number> | RangeValue | ConflictValue<number> | UnknownValue;
export type ChoiceValue<T> = KnownValue<T> | AlternativesValue<T> | ConflictValue<T> | UnknownValue;

// ---------------------------------------------------------------------------------------------
// The Scenario
// ---------------------------------------------------------------------------------------------

export type WeekdayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri';
export const WEEKDAY_KEYS: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri'];

/** How the weekday OVERTIME hours fall across the working week. Only overtime needs this: the engine
 * tiers overtime per DAY (hour-grid.ts), whereas regular hours are flat and their distribution cannot
 * change any amount. Visible, editable provenance, never a hidden default (Lock §34). */
export type OvertimeDistribution =
  | { kind: 'even'; days: 1 | 2 | 3 | 4 | 5 }
  | { kind: 'explicit'; byDay: Record<WeekdayKey, number> };

export interface ScenarioWork {
  /** Regular Monday-Friday hours (paid at the base rate). Absent = this category is not part of the scenario. */
  regularWeekdayHours?: NumberValue;
  /** Weekday overtime hours, tiered per day by the engine. Weekend/holiday hours are NEVER overtime here. */
  overtimeHours?: NumberValue;
  overtimeDistribution?: ChoiceValue<OvertimeDistribution>;
  /** Hours worked on a Saturday - listed ONCE here, never also inside regularWeekdayHours (no double count). */
  saturdayHours?: NumberValue;
  sundayHours?: NumberValue;
  /** Hours worked on a public holiday - a separate bucket, never also counted as weekday/Saturday/Sunday. */
  publicHolidayHours?: NumberValue;
}

export interface ScenarioPay {
  /** Gross base hourly rate in EUR. */
  hourlyRate?: NumberValue;
  /** Premium ABOVE base, in percent (50 = base x 1.5) - the unit Tier A and the Payroll Profile use. */
  saturdayPremiumPercent?: NumberValue;
  sundayPremiumPercent?: NumberValue;
  publicHolidayPremiumPercent?: NumberValue;
  overtime?: {
    /** Overtime hours per day before the second tier's rate applies. */
    thresholdHoursPerDay?: NumberValue;
    tier1Percent?: NumberValue;
    tier2Percent?: NumberValue;
  };
}

export type TaxCreditState = 'applied' | 'not_applied';

export interface ScenarioTax {
  /** Loonheffingskorting. High-impact: never silently assumed (Lock §33) - unknown blocks, alternatives run as variants. */
  loonheffingskorting?: ChoiceValue<TaxCreditState>;
}

export type DeductionsMode = 'enter' | 'estimate';

export interface ScenarioDeductions {
  /** `enter`: EUR amounts for this week (all three pre-tax amounts required, 0 allowed explicitly).
   * `estimate`: the engine's own sourced population-level estimate path - an explicit, visible
   * assumption, never a hidden default. */
  mode?: ChoiceValue<DeductionsMode>;
  entered?: {
    pension?: NumberValue;
    paww?: NumberValue;
    sectorPremium?: NumberValue;
    /** Optional (engine: never estimated, never blocks): absent = no such deduction in this scenario. */
    postTaxOther?: NumberValue;
  };
}

export type VakantiegeldMode = 'none' | 'accruing';

export interface ScenarioExtras {
  /** EUR for this week, outside tax. Absent = none in this scenario. */
  travelAllowance?: NumberValue;
  /** Vakantiegeld that is ACCRUING (outside gross and net - money-neutral). Absent = not modelled. Paid-out
   * vakantiegeld is an unsupported concept (see ScenarioRequestedConcept). */
  vakantiegeld?: { mode?: ChoiceValue<VakantiegeldMode>; percent?: NumberValue };
}

/** Concepts a producer may ASK for that the current Tier A engine cannot represent. They are carried in
 * the Scenario precisely so the evaluation can say so explicitly (status `unsupported`) instead of
 * silently omitting them (§6, §8, §12). Closed list - each entry is a documented engine gap. */
export const UNSUPPORTED_CONCEPTS = [
  'night_premium',
  'evening_premium',
  'shift_premium',
  'surcharge_on_counted_hours',
  'percent_based_deduction',
  'recurring_net_deduction',
  'recurring_net_addition',
  'vakantiegeld_paid_now',
  'et_exchange',
  'monthly_salary',
  'guaranteed_hours',
  'non_weekly_period',
] as const;
export type UnsupportedConcept = (typeof UNSUPPORTED_CONCEPTS)[number];

export interface ScenarioRequestedConcept extends ScenarioValueOrigin {
  concept: UnsupportedConcept;
}

export interface ScenarioV1 {
  schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  scenarioId: string;
  /** Optional human-readable label. No persistence exists in R1. */
  label?: string;
  /** Weekly only in R1; anything else is `invalid` (unsupported_period_type). */
  periodType: 'week';
  work: ScenarioWork;
  pay: ScenarioPay;
  tax: ScenarioTax;
  deductions?: ScenarioDeductions;
  extras?: ScenarioExtras;
  requestedConcepts?: ScenarioRequestedConcept[];
}

// ---------------------------------------------------------------------------------------------
// Field table - the single description of every value path: kind, unit, bounds and whether an
// explicit Loonto assumption may ever resolve it. The validator, the mapper and the evaluator are all
// driven by it, so a field cannot be handled in one place and forgotten in another.
// ---------------------------------------------------------------------------------------------

export type ScenarioUnit = 'hours' | 'hours_per_day' | 'eur_per_hour' | 'premium_percent' | 'percent' | 'eur_per_week';

export interface NumberFieldSpec {
  kind: 'number';
  unit: ScenarioUnit;
  min: number;
  max: number;
  /** When true a value of exactly `min` is NOT allowed (e.g. an hourly rate of 0). */
  exclusiveMin?: boolean;
  /** Whether Loonto may propose an explicit, visible, editable assumption for this field (Lock §9.1).
   * R1 NEVER inserts one - this is metadata for the requirement the evaluation returns. */
  assumption: 'orientation_allowed' | 'not_allowed';
}
export interface ChoiceFieldSpec {
  kind: 'choice';
  allowed?: readonly string[];
  assumption: 'orientation_allowed' | 'not_allowed';
}
export type ScenarioFieldSpec = NumberFieldSpec | ChoiceFieldSpec;

export const SCENARIO_FIELDS = {
  'work.regularWeekdayHours': { kind: 'number', unit: 'hours', min: 0, max: 120, assumption: 'not_allowed' },
  'work.overtimeHours': { kind: 'number', unit: 'hours', min: 0, max: 120, assumption: 'not_allowed' },
  'work.overtimeDistribution': { kind: 'choice', assumption: 'not_allowed' },
  'work.saturdayHours': { kind: 'number', unit: 'hours', min: 0, max: 24, assumption: 'not_allowed' },
  'work.sundayHours': { kind: 'number', unit: 'hours', min: 0, max: 24, assumption: 'not_allowed' },
  'work.publicHolidayHours': { kind: 'number', unit: 'hours', min: 0, max: 168, assumption: 'not_allowed' },
  'pay.hourlyRate': { kind: 'number', unit: 'eur_per_hour', min: 0, max: 1000, exclusiveMin: true, assumption: 'not_allowed' },
  'pay.saturdayPremiumPercent': { kind: 'number', unit: 'premium_percent', min: 0, max: 500, assumption: 'orientation_allowed' },
  'pay.sundayPremiumPercent': { kind: 'number', unit: 'premium_percent', min: 0, max: 500, assumption: 'orientation_allowed' },
  'pay.publicHolidayPremiumPercent': { kind: 'number', unit: 'premium_percent', min: 0, max: 500, assumption: 'orientation_allowed' },
  'pay.overtime.thresholdHoursPerDay': { kind: 'number', unit: 'hours_per_day', min: 0, max: 24, assumption: 'not_allowed' },
  'pay.overtime.tier1Percent': { kind: 'number', unit: 'premium_percent', min: 0, max: 500, assumption: 'not_allowed' },
  'pay.overtime.tier2Percent': { kind: 'number', unit: 'premium_percent', min: 0, max: 500, assumption: 'not_allowed' },
  'tax.loonheffingskorting': { kind: 'choice', allowed: ['applied', 'not_applied'], assumption: 'not_allowed' },
  'deductions.mode': { kind: 'choice', allowed: ['enter', 'estimate'], assumption: 'orientation_allowed' },
  'deductions.entered.pension': { kind: 'number', unit: 'eur_per_week', min: 0, max: 100000, assumption: 'not_allowed' },
  'deductions.entered.paww': { kind: 'number', unit: 'eur_per_week', min: 0, max: 100000, assumption: 'not_allowed' },
  'deductions.entered.sectorPremium': { kind: 'number', unit: 'eur_per_week', min: 0, max: 100000, assumption: 'not_allowed' },
  'deductions.entered.postTaxOther': { kind: 'number', unit: 'eur_per_week', min: 0, max: 100000, assumption: 'not_allowed' },
  'extras.travelAllowance': { kind: 'number', unit: 'eur_per_week', min: 0, max: 100000, assumption: 'not_allowed' },
  'extras.vakantiegeld.mode': { kind: 'choice', allowed: ['none', 'accruing'], assumption: 'not_allowed' },
  'extras.vakantiegeld.percent': { kind: 'number', unit: 'percent', min: 0, max: 50, assumption: 'not_allowed' },
} as const satisfies Record<string, ScenarioFieldSpec>;

export type ScenarioFieldPath = keyof typeof SCENARIO_FIELDS;
export const SCENARIO_FIELD_PATHS = Object.keys(SCENARIO_FIELDS) as ScenarioFieldPath[];

// ---------------------------------------------------------------------------------------------
// Validation vocabulary (§5) - invalid / blocked / ready, stable codes only
// ---------------------------------------------------------------------------------------------

export type ScenarioLifecycle = 'invalid' | 'blocked' | 'ready';

export const SCENARIO_ISSUE_CODES = [
  'unsupported_schema_version',
  'unsupported_period_type',
  'malformed_scenario',
  'malformed_value',
  'malformed_source',
  'value_not_finite',
  'negative_hours',
  'hours_out_of_range',
  'hours_exceed_week',
  'day_hours_exceed_24',
  'percent_out_of_range',
  'amount_out_of_range',
  'hourly_rate_out_of_range',
  'range_inverted',
  'alternatives_too_few',
  'conflict_too_few',
  'invalid_tax_credit_state',
  'invalid_choice_value',
  'invalid_overtime_distribution',
  'overtime_distribution_mismatch',
  'unknown_requested_concept',
] as const;
export type ScenarioIssueCode = (typeof SCENARIO_ISSUE_CODES)[number];

export interface ScenarioIssue {
  code: ScenarioIssueCode;
  /** A ScenarioFieldPath, or a structural path such as `periodType`. */
  path: string;
  /** Machine parameters for the sentence the UI builds (CONVENTIONS.md) - never prose. */
  params?: Record<string, number | string>;
}

export const SCENARIO_WARNING_CODES = [
  'irrelevant_value_ignored',
  'assumption_in_use',
  'sector_premium_estimated',
  /** The engine's own sanity check (checkTierASanity) fired - forwarded, not re-derived. */
  'engine_sanity_net_exceeds_gross',
  'engine_sanity_effective_rate_exceeds_gross_rate',
] as const;
export type ScenarioWarningCode = (typeof SCENARIO_WARNING_CODES)[number];
export interface ScenarioWarning {
  code: ScenarioWarningCode;
  path?: string;
  params?: Record<string, number | string>;
}

export type ScenarioRequirementReason =
  | 'missing'
  | 'unknown'
  | 'conflict'
  /** The existing engine itself refused to compute without it (hour-grid / Tier A blocked result). */
  | 'engine_requires';

export interface ScenarioRequirement {
  field: ScenarioFieldPath | 'work.hours';
  reason: ScenarioRequirementReason;
  /** Whether a user answer could resolve it / whether an EXPLICIT, visible assumption could resolve it /
   * whether running deterministic variants (alternatives) could resolve it (§8). */
  resolvableBy: { userAnswer: boolean; explicitAssumption: boolean; deterministicVariants: boolean };
}

/** Something the evaluation explicitly cannot do - returned instead of silently omitting it (§8). */
export interface ConceptUnsupportedReason {
  kind: 'concept';
  concept: UnsupportedConcept;
  reason: 'engine_cannot_represent';
  /** Which existing Tier A structure is the gap (stable code). */
  gap: string;
  requestedBy: ScenarioValueSource;
}
export interface CapabilityUnsupportedReason {
  kind: 'capability';
  capability: 'too_many_variants';
  params: { runs: number; max: number };
}
export type UnsupportedReason = ConceptUnsupportedReason | CapabilityUnsupportedReason;

export interface ScenarioValidation {
  status: ScenarioLifecycle;
  issues: ScenarioIssue[];
  requirements: ScenarioRequirement[];
  warnings: ScenarioWarning[];
}

/** The Scenario as the evaluation saw it: canonical key order, trimmed label, plus the derived lifecycle
 * status. Derived by CODE (the validator), never declared by the producer or an LLM (§5). */
export type NormalizedScenario = ScenarioV1 & { status: ScenarioLifecycle };
