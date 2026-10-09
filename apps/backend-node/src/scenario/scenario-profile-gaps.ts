import { EMPLOYMENT_FIELD_KEYS, PAYROLL_FIELD_KEYS } from '../payroll-engine/payroll-profile.js';
import type { ScenarioFieldPath } from './scenario-types.js';

/**
 * Where the existing Payroll Profile meets the existing Tier A engine (§12 of the R1 task): which
 * profile facts a Scenario can actually carry INTO the engine, and which facts the profile holds that no
 * Tier A input can consume. Reported, not papered over - the Scenario never claims support for a
 * concept the engine does not read. A drift-guard test fails if a profile field is added without being
 * classified here.
 *
 *   consumed          - becomes a Scenario field and is read by the engine
 *   scenario_hint     - informs a Scenario value (e.g. hours) but is not itself an engine input
 *   gap               - held by the profile, NOT consumable by the Tier A engine (the mapping gap)
 *   not_calculation   - identity / descriptive; no calculation role
 */
export type ProfileEngineStatus = 'consumed' | 'scenario_hint' | 'gap' | 'not_calculation';

export interface ProfileFieldClassification {
  status: ProfileEngineStatus;
  scenarioField?: ScenarioFieldPath;
  /** Stable code naming the gap (only for `gap`). */
  gap?: string;
}

export const EMPLOYMENT_FIELD_ENGINE: Record<(typeof EMPLOYMENT_FIELD_KEYS)[number], ProfileFieldClassification> = {
  employerName: { status: 'not_calculation' },
  payslipEmployerName: { status: 'not_calculation' },
  hirerName: { status: 'not_calculation' },
  contractHirerName: { status: 'not_calculation' },
  hourlyRate: { status: 'consumed', scenarioField: 'pay.hourlyRate' },
  hoursPerWeek: { status: 'scenario_hint' },
  guaranteedHours: { status: 'gap', gap: 'tier_a_has_no_guaranteed_hours_concept' },
  guaranteedHoursPeriodWeeks: { status: 'gap', gap: 'tier_a_has_no_guaranteed_hours_concept' },
  overtimeThresholdHours: { status: 'consumed', scenarioField: 'pay.overtime.thresholdHoursPerDay' },
  caoName: { status: 'not_calculation' },
  phase: { status: 'not_calculation' },
  contractType: { status: 'not_calculation' },
  functionTitle: { status: 'not_calculation' },
  contractStartDate: { status: 'not_calculation' },
  contractEndDate: { status: 'not_calculation' },
  monthlySalary: { status: 'gap', gap: 'tier_a_is_hourly_rate_based' },
  pensionFundName: { status: 'not_calculation' },
};

export const PAYROLL_FIELD_ENGINE: Record<(typeof PAYROLL_FIELD_KEYS)[number], ProfileFieldClassification> = {
  periodType: { status: 'scenario_hint' },
  overtimeTier1Premium: { status: 'consumed', scenarioField: 'pay.overtime.tier1Percent' },
  overtimeTier2Premium: { status: 'consumed', scenarioField: 'pay.overtime.tier2Percent' },
  saturdayPremium: { status: 'consumed', scenarioField: 'pay.saturdayPremiumPercent' },
  sundayPremium: { status: 'consumed', scenarioField: 'pay.sundayPremiumPercent' },
  publicHolidayPremium: { status: 'consumed', scenarioField: 'pay.publicHolidayPremiumPercent' },
  loonheffingskorting: { status: 'consumed', scenarioField: 'tax.loonheffingskorting' },
  pensionEmployeePercent: { status: 'gap', gap: 'tier_a_enter_mode_takes_eur_amounts_only_estimate_mode_is_population_defaults' },
  pawwEmployeePercent: { status: 'gap', gap: 'tier_a_enter_mode_takes_eur_amounts_only_estimate_mode_is_population_defaults' },
  sectorPremiumPercent: { status: 'gap', gap: 'tier_a_enter_mode_takes_eur_amounts_only_estimate_mode_is_population_defaults' },
  wgaGatEmployeePercent: { status: 'gap', gap: 'tier_a_has_no_wga_gat_pre_tax_line' },
  wgaEmployeePercent: { status: 'gap', gap: 'tier_a_post_tax_social_is_a_single_eur_amount' },
  gediffWgaEmployeePercent: { status: 'gap', gap: 'tier_a_post_tax_social_is_a_single_eur_amount' },
  whkEmployeePercent: { status: 'gap', gap: 'tier_a_post_tax_social_is_a_single_eur_amount' },
  vakantiegeldAccrualPercent: { status: 'consumed', scenarioField: 'extras.vakantiegeld.percent' },
  bijzonderTariefPrintedPercent: { status: 'gap', gap: 'bijzonder_tarief_rate_unknown_in_tier_a_engine_blocks' },
  jaarloonBt: { status: 'gap', gap: 'bijzonder_tarief_rate_unknown_in_tier_a_engine_blocks' },
  etExchangeAmount: { status: 'gap', gap: 'tier_a_period_builder_sets_et_null' },
};

/** The profile's recurring-item families (RecurringItems in payroll-profile.ts). */
export const RECURRING_ITEM_ENGINE: Record<string, ProfileFieldClassification> = {
  surcharges: { status: 'gap', gap: 'tier_a_surcharge_lines_need_hours_and_percent_profile_has_percent_only' },
  otherPreTaxDeductions: { status: 'gap', gap: 'tier_a_enter_mode_takes_eur_amounts_only_estimate_mode_is_population_defaults' },
  otherPostTaxDeductions: { status: 'gap', gap: 'tier_a_post_tax_social_is_a_single_eur_amount' },
  netAdditions: { status: 'gap', gap: 'tier_a_supports_a_single_travel_allowance_only' },
  netDeductions: { status: 'gap', gap: 'tier_a_period_builder_sets_net_deductions_empty' },
};
