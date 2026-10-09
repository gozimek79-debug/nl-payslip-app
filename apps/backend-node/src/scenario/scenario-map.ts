import type { TierAInput, VakantiegeldTreatment } from '../payroll-engine/tier-a.js';
import { emptyHourGrid, type DayOfWeek, type HourGridInput } from '../payroll-engine/hour-grid.js';
import {
  SCENARIO_FIELD_PATHS,
  WEEKDAY_KEYS,
  type ConceptUnsupportedReason,
  type OvertimeDistribution,
  type ScenarioFieldPath,
  type ScenarioRequirement,
  type ScenarioV1,
  type ScenarioValueSource,
  type UnsupportedConcept,
} from './scenario-types.js';
import { expandWeekdayHours, getAt, holidayDayCells, isRecord, valueStatus } from './scenario-util.js';

/**
 * The ONE Scenario -> existing Tier A engine mapping path (§6). Pure and deterministic: identical input
 * gives an identical TierAInput. It does not calculate payroll money, does not reproduce an engine
 * formula, does not read UI state, does not touch the Payroll Profile and infers no hidden default: a
 * value the engine needs that is not a single KNOWN value makes the mapping `blocked`.
 *
 * The only thing it does beyond field-copying is hour ALLOCATION - turning "40 h weekdays, 8 h Saturday,
 * 6 h Sunday, 8 h on a public holiday" into the engine's per-day cells. Allocation moves hours; the
 * engine prices them (tier-a.ts / hour-grid.ts).
 */

export type FieldConsumptionStatus = 'consumed' | 'ignored_irrelevant' | 'unsupported';

export interface FieldConsumption {
  path: string;
  status: FieldConsumptionStatus;
  /** The TierAInput field(s) that read it (absent for ignored / unsupported). */
  engineField?: string;
  source?: ScenarioValueSource;
}

/** Scenario path -> the TierAInput field that consumes it. This is the mapping table of the report. */
export const ENGINE_FIELD_FOR: Record<ScenarioFieldPath, string> = {
  'work.regularWeekdayHours': 'week_grids[].{mon..fri}.regular_hours',
  'work.overtimeHours': 'week_grids[].{mon..fri}.overtime_hours',
  'work.overtimeDistribution': 'week_grids[].{mon..fri}.overtime_hours (allocation only)',
  'work.saturdayHours': 'week_grids[].sat.regular_hours',
  'work.sundayHours': 'week_grids[].sun.regular_hours',
  'work.publicHolidayHours': 'week_grids[].<day>.regular_hours + is_public_holiday=true',
  'pay.hourlyRate': 'hourly_rate',
  'pay.saturdayPremiumPercent': 'saturday_percent',
  'pay.sundayPremiumPercent': 'sunday_percent',
  'pay.publicHolidayPremiumPercent': 'holiday_percent',
  'pay.overtime.thresholdHoursPerDay': 'overtime_tier_threshold_hours',
  'pay.overtime.tier1Percent': 'overtime_tier_1_percent',
  'pay.overtime.tier2Percent': 'overtime_tier_2_percent',
  'tax.loonheffingskorting': 'apply_loonheffingskorting',
  'deductions.mode': 'deductions.mode',
  'deductions.entered.pension': 'deductions.entered.pension',
  'deductions.entered.paww': 'deductions.entered.paww',
  'deductions.entered.sectorPremium': 'deductions.entered.sector_premium',
  'deductions.entered.postTaxOther': 'deductions.entered.post_tax_other',
  'extras.travelAllowance': 'travel_allowance',
  'extras.vakantiegeld.mode': 'vakantiegeld.mode',
  'extras.vakantiegeld.percent': 'vakantiegeld.percent',
};

// ---------------------------------------------------------------------------------------------
// Capability: concepts the existing engine cannot represent (§6, §8 `unsupported`, §12)
// ---------------------------------------------------------------------------------------------

/** Why each concept is unsupported - verified against tier-a.ts / payslip-model.ts (see the R1 report). */
export const UNSUPPORTED_CONCEPT_GAPS: Record<UnsupportedConcept, string> = {
  night_premium: 'tier_a_hour_grid_has_only_weekday_saturday_sunday_holiday_overtime_categories',
  evening_premium: 'tier_a_hour_grid_has_only_weekday_saturday_sunday_holiday_overtime_categories',
  shift_premium: 'tier_a_hour_grid_has_only_weekday_saturday_sunday_holiday_overtime_categories',
  surcharge_on_counted_hours: 'tier_a_surcharge_lines_need_hours_and_percent_profile_has_percent_only',
  percent_based_deduction: 'tier_a_enter_mode_takes_eur_amounts_only_estimate_mode_is_population_defaults',
  recurring_net_deduction: 'tier_a_period_builder_sets_net_deductions_empty',
  recurring_net_addition: 'tier_a_supports_a_single_travel_allowance_only',
  vakantiegeld_paid_now: 'bijzonder_tarief_rate_unknown_in_tier_a_engine_blocks',
  et_exchange: 'tier_a_period_builder_sets_et_null',
  monthly_salary: 'tier_a_is_hourly_rate_based',
  guaranteed_hours: 'tier_a_has_no_guaranteed_hours_concept',
  non_weekly_period: 'scenario_v1_is_weekly_only',
};

export function findUnsupported(scenario: ScenarioV1): ConceptUnsupportedReason[] {
  return (scenario.requestedConcepts ?? []).map((entry) => ({
    kind: 'concept' as const,
    concept: entry.concept,
    reason: 'engine_cannot_represent' as const,
    gap: UNSUPPORTED_CONCEPT_GAPS[entry.concept],
    requestedBy: entry.source,
  }));
}

// ---------------------------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------------------------

export interface EngineMapping {
  input: TierAInput;
  consumption: FieldConsumption[];
}

export type MapResult = { status: 'mapped'; mapping: EngineMapping } | { status: 'blocked'; requirements: ScenarioRequirement[] };

const DAYS: readonly DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function requirementFor(field: ScenarioFieldPath, reason: ScenarioRequirement['reason']): ScenarioRequirement {
  return {
    field,
    reason,
    resolvableBy: { userAnswer: true, explicitAssumption: false, deterministicVariants: false },
  };
}

type Read<T> = { kind: 'value'; value: T } | { kind: 'absent' } | { kind: 'unresolved' };

export function mapScenarioToEngine(scenario: ScenarioV1): MapResult {
  const requirements: ScenarioRequirement[] = [];
  const consumption: FieldConsumption[] = [];

  /** Reads a path that must be a single KNOWN value. A range / alternatives / conflict / unknown that
   * reaches the mapper unresolved blocks - the mapper never picks a value (§7). */
  function read<T>(path: ScenarioFieldPath): Read<T> {
    const node = getAt(scenario, path);
    const status = valueStatus(node);
    if (status === 'missing') return { kind: 'absent' };
    if (isRecord(node) && node.state === 'known') return { kind: 'value', value: node.value as T };
    requirements.push(requirementFor(path, status === 'conflict' ? 'conflict' : 'unknown'));
    return { kind: 'unresolved' };
  }
  function need<T>(path: ScenarioFieldPath): T | undefined {
    const r = read<T>(path);
    if (r.kind === 'value') return r.value;
    if (r.kind === 'absent') requirements.push(requirementFor(path, 'missing'));
    return undefined;
  }
  function record(path: ScenarioFieldPath, status: FieldConsumptionStatus): void {
    const node = getAt(scenario, path);
    if (node === undefined) return;
    const source = isRecord(node) && typeof node.source === 'string' ? (node.source as ScenarioValueSource) : undefined;
    consumption.push({ path, status, ...(status === 'consumed' ? { engineField: ENGINE_FIELD_FOR[path] } : {}), ...(source ? { source } : {}) });
  }

  // Hours: an absent category is simply not part of this scenario (zero) - scope, not a payroll default.
  const hours = (path: ScenarioFieldPath): number => {
    const r = read<number>(path);
    return r.kind === 'value' ? r.value : 0;
  };
  const regular = hours('work.regularWeekdayHours');
  const overtime = hours('work.overtimeHours');
  const saturday = hours('work.saturdayHours');
  const sunday = hours('work.sundayHours');
  const holiday = hours('work.publicHolidayHours');

  const hourlyRate = need<number>('pay.hourlyRate');

  const premium = (hoursValue: number, path: ScenarioFieldPath): number | null => {
    if (hoursValue <= 0) {
      record(path, 'ignored_irrelevant');
      return null;
    }
    return need<number>(path) ?? null;
  };
  const saturdayPercent = premium(saturday, 'pay.saturdayPremiumPercent');
  const sundayPercent = premium(sunday, 'pay.sundayPremiumPercent');
  const holidayPercent = premium(holiday, 'pay.publicHolidayPremiumPercent');

  let threshold: number | null = null;
  let tier1: number | null = null;
  let tier2: number | null = null;
  let distribution: OvertimeDistribution | null = null;
  if (overtime > 0) {
    threshold = need<number>('pay.overtime.thresholdHoursPerDay') ?? null;
    tier1 = need<number>('pay.overtime.tier1Percent') ?? null;
    // tier-2 is read only if present: the engine itself decides whether any tier-2 hours exist and asks for it.
    const t2 = read<number>('pay.overtime.tier2Percent');
    tier2 = t2.kind === 'value' ? t2.value : null;
    distribution = need<OvertimeDistribution>('work.overtimeDistribution') ?? null;
  } else {
    for (const path of ['pay.overtime.thresholdHoursPerDay', 'pay.overtime.tier1Percent', 'pay.overtime.tier2Percent', 'work.overtimeDistribution'] as const) record(path, 'ignored_irrelevant');
  }

  const taxCredit = need<'applied' | 'not_applied'>('tax.loonheffingskorting');

  const deductionsMode = need<'enter' | 'estimate'>('deductions.mode');
  let entered: NonNullable<TierAInput['deductions']['entered']> | undefined;
  if (deductionsMode === 'enter') {
    const pension = need<number>('deductions.entered.pension');
    const paww = need<number>('deductions.entered.paww');
    const sectorPremium = need<number>('deductions.entered.sectorPremium');
    const postTaxOther = read<number>('deductions.entered.postTaxOther');
    if (pension !== undefined && paww !== undefined && sectorPremium !== undefined) {
      entered = { pension, paww, sector_premium: sectorPremium, ...(postTaxOther.kind === 'value' ? { post_tax_other: postTaxOther.value } : {}) };
    }
  } else if (deductionsMode === 'estimate') {
    for (const path of ['deductions.entered.pension', 'deductions.entered.paww', 'deductions.entered.sectorPremium', 'deductions.entered.postTaxOther'] as const) record(path, 'ignored_irrelevant');
  }

  const travel = read<number>('extras.travelAllowance');

  let vakantiegeld: VakantiegeldTreatment = { mode: 'none' };
  if (isRecord(getAt(scenario, 'extras.vakantiegeld'))) {
    const vMode = need<'none' | 'accruing'>('extras.vakantiegeld.mode');
    if (vMode === 'accruing') {
      const percent = need<number>('extras.vakantiegeld.percent');
      if (percent !== undefined) vakantiegeld = { mode: 'accruing', percent };
    } else {
      record('extras.vakantiegeld.percent', 'ignored_irrelevant');
    }
  }

  if (requirements.length > 0) return { status: 'blocked', requirements };

  // ---- allocation of hours to the engine's day cells ----
  const weekGrids: HourGridInput[] = [];
  const main = emptyHourGrid();
  const weekdayCells = expandWeekdayHours(regular, overtime, distribution);
  for (const day of WEEKDAY_KEYS) main[day] = { regular_hours: weekdayCells[day].regular, overtime_hours: weekdayCells[day].overtime, is_public_holiday: false };
  main.sat = { regular_hours: saturday, overtime_hours: 0, is_public_holiday: false };
  main.sun = { regular_hours: sunday, overtime_hours: 0, is_public_holiday: false };
  weekGrids.push(main);
  if (holiday > 0) {
    // Holiday hours are their own bucket (a second grid, summed by category inside the engine), so they can
    // never be counted again as weekday/Saturday/Sunday hours.
    const holidayGrid = emptyHourGrid();
    holidayDayCells(holiday).forEach((cell, index) => {
      holidayGrid[DAYS[index] as DayOfWeek] = { regular_hours: cell, overtime_hours: 0, is_public_holiday: true };
    });
    weekGrids.push(holidayGrid);
  }

  const input: TierAInput = {
    period_type: 'week',
    hourly_rate: hourlyRate as number,
    week_grids: weekGrids,
    overtime_tier_threshold_hours: threshold,
    overtime_tier_1_percent: tier1,
    overtime_tier_2_percent: tier2,
    saturday_percent: saturdayPercent,
    sunday_percent: sundayPercent,
    holiday_percent: holidayPercent,
    surcharge_lines: [],
    apply_loonheffingskorting: taxCredit === 'applied',
    travel_allowance: travel.kind === 'value' ? travel.value : 0,
    vakantiegeld,
    deductions: { mode: deductionsMode as 'enter' | 'estimate', ...(entered ? { entered } : {}) },
  };

  for (const path of SCENARIO_FIELD_PATHS) {
    if (consumption.some((c) => c.path === path)) continue;
    record(path, 'consumed');
  }
  for (const entry of scenario.requestedConcepts ?? []) {
    consumption.push({ path: `requestedConcepts.${entry.concept}`, status: 'unsupported', source: entry.source });
  }
  consumption.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { status: 'mapped', mapping: { input, consumption } };
}
