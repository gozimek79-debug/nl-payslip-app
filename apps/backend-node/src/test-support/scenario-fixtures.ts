import type { PayslipComputationRates } from '../payroll-engine/payslip-model.js';
import { computeTierAResult, type TierAInput } from '../payroll-engine/tier-a.js';
import { emptyHourGrid, type HourGridInput } from '../payroll-engine/hour-grid.js';
import type {
  ChoiceValue,
  DeductionsMode,
  NumberValue,
  ScenarioV1,
  ScenarioValueSource,
  TaxCreditState,
} from '../scenario/scenario-types.js';

/** The same 2026 weekly rates tier-a.test.ts uses - the engine is the oracle, not a copy of its maths. */
export const RATES_2026: PayslipComputationRates = {
  loonheffing_brackets: [
    { min: 0, max: 38883, rate: 0.3575 },
    { min: 38883, max: 78426, rate: 0.3756 },
    { min: 78426, max: 999999999, rate: 0.495 },
  ],
  heffingskortingen: {
    algemene_heffingskorting: { max_amount: 3115, phaseout_start: 29736, phaseout_rate: 0.06398 },
    arbeidskorting: {
      max_amount: 5685,
      phaseout_start: 45592,
      phaseout_rate: 0.0651,
      buildup_tiers: [
        { max: 11965, rate: 0.08324 },
        { max: 25845, rate: 0.31009 },
        { max: 45592, rate: 0.0195 },
      ],
    },
  },
  period_multiplier: 52,
};

// ---- value builders -------------------------------------------------------------------------

export const num = (value: number, source: ScenarioValueSource = 'user', ref?: string): NumberValue => ({ state: 'known', value, source, ...(ref ? { ref } : {}) });
export const range = (low: number, high: number, source: ScenarioValueSource = 'user'): NumberValue => ({ state: 'range', low, high, source });
export const choice = <T>(value: T, source: ScenarioValueSource = 'user'): ChoiceValue<T> => ({ state: 'known', value, source });
export const alternatives = <T>(options: T[], source: ScenarioValueSource = 'user'): ChoiceValue<T> => ({ state: 'alternatives', options, source });
export const unknown = { state: 'unknown' } as const;

/** A complete, ready 40 h weekday scenario: rate from a document, tax credit applied, deductions ENTERED
 * (so the engine's population-estimate path - and its disclosed range - is not involved). */
export function weekdayScenario(overrides: Partial<ScenarioV1> = {}): ScenarioV1 {
  return {
    schemaVersion: 1,
    scenarioId: 'test-scenario',
    periodType: 'week',
    work: { regularWeekdayHours: num(40) },
    pay: { hourlyRate: num(16.8, 'document', 'doc-1') },
    tax: { loonheffingskorting: choice<TaxCreditState>('applied') },
    deductions: {
      mode: choice<DeductionsMode>('enter'),
      entered: { pension: num(30), paww: num(0.7), sectorPremium: num(2.5) },
    },
    ...overrides,
  };
}

// ---- the oracle: the existing engine, driven the way Tier A's own UI drives it ---------------

export function dayGrid(partial: Partial<Record<keyof HourGridInput, { regular?: number; overtime?: number; holiday?: boolean }>>): HourGridInput {
  const grid = emptyHourGrid();
  for (const [day, cell] of Object.entries(partial) as Array<[keyof HourGridInput, { regular?: number; overtime?: number; holiday?: boolean }]>) {
    grid[day] = { regular_hours: cell.regular ?? 0, overtime_hours: cell.overtime ?? 0, is_public_holiday: cell.holiday ?? false };
  }
  return grid;
}

/** A TierAInput written by hand (one grid, hours on named days) for the same user intent as a Scenario. */
export function oracleInput(overrides: Partial<TierAInput> = {}): TierAInput {
  return {
    period_type: 'week',
    hourly_rate: 16.8,
    week_grids: [dayGrid({ mon: { regular: 8 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 } })],
    overtime_tier_threshold_hours: null,
    overtime_tier_1_percent: null,
    overtime_tier_2_percent: null,
    saturday_percent: null,
    sunday_percent: null,
    holiday_percent: null,
    surcharge_lines: [],
    apply_loonheffingskorting: true,
    travel_allowance: 0,
    vakantiegeld: { mode: 'none' },
    deductions: { mode: 'enter', entered: { pension: 30, paww: 0.7, sector_premium: 2.5 } },
    ...overrides,
  };
}

/** The engine's own complete result for a hand-written input - the number a Scenario evaluation must equal. */
export function oracleResult(input: TierAInput) {
  const computed = computeTierAResult(input, RATES_2026);
  if (computed.status !== 'computed' || computed.outcome.status !== 'complete') throw new Error('oracle input did not compute');
  return { result: computed.outcome.result, computed };
}
