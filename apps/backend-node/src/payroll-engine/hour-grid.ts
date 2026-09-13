/**
 * The hour grid (SPEC-loonto-architecture v4 §5b, audit round "TIER DEFINITIONS, FINAL", order item
 * 2 - "CD"). A single "hours" field cannot express a Dutch agency worker's pay, because pay depends
 * on WHICH DAY an hour falls on (Saturday/Sunday/public holiday carry their own percentages) and HOW
 * MANY HOURS INTO THAT DAY it is (overtime within a day is tiered - the first overtime hours pay one
 * rate, later ones pay more). This module is the INPUT SURFACE only: it turns a per-day hour grid
 * into per-day hours-by-category. It does not compute money. Per §5b's own "what the engine
 * receives" section, a later stage (Tier A/B/C, once rates/percentages are known) turns these
 * categorized hour buckets into `HourLine[]` with amount/rate/tax_treatment - that stage is BY/BZ's
 * forward-projection engine, not this one. The model in payslip-model.ts does not change.
 */

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const WEEK_DAYS: readonly DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * One day's grid row. `overtime_hours` is the day's TOTAL overtime (tiering into 125%/150%-shaped
 * buckets happens inside convertHourGridToLines, driven by the threshold - the user/extraction does
 * not pre-split it, exactly as real payslips print one tier-125 total and one tier-150 total per
 * PERIOD, never per identified overtime hour). `is_public_holiday` should be set from date-driven
 * detection where the period's dates are known (spec §5b) - a manual flag is the fallback, not the
 * default path.
 */
export interface DayHoursInput {
  regular_hours: number;
  overtime_hours: number;
  is_public_holiday: boolean;
}

export type HourGridInput = Record<DayOfWeek, DayHoursInput>;

export function emptyHourGrid(): HourGridInput {
  const grid = {} as HourGridInput;
  for (const day of WEEK_DAYS) {
    grid[day] = { regular_hours: 0, overtime_hours: 0, is_public_holiday: false };
  }
  return grid;
}

/**
 * The overtime tier threshold - "after how many overtime hours in a day does the rate step up from
 * the first tier to the second" - as an explicit unknown (spec §1, §5b: "do not ship a default").
 *
 * CH1's rule for resolving competing sources: reproduction (inferring the threshold from a payslip's
 * own tier totals, offered to the user for confirmation, never assumed) is EVIDENCE; a contract's own
 * stated term is not inference and wins over it. Where both exist and disagree, both are kept in
 * `disagreement` and shown - that is a real finding about the employer, not a data problem to resolve
 * silently. A user's own correction (`user_entered`) outranks both, the same way any extracted field
 * flips to `user_entered` when corrected elsewhere in this model (spec §1).
 */
export type OvertimeThresholdProvenance = 'user_entered' | 'contract_stated' | 'payslip_reproduced_evidence' | 'unknown';

export interface ThresholdDisagreement {
  contract_value: number;
  payslip_reproduced_value: number;
}

export interface OvertimeTierThreshold {
  /** Hours of overtime per day before the second tier's rate applies. Null only when provenance is 'unknown'. */
  hours_before_step_up: number | null;
  provenance: OvertimeThresholdProvenance;
  /** Non-null only when a contract value and a payslip-reproduced value both exist and differ. */
  disagreement: ThresholdDisagreement | null;
}

export function resolveOvertimeTierThreshold(inputs: {
  contract_stated: number | null;
  payslip_reproduced_evidence: number | null;
  user_entered: number | null;
}): OvertimeTierThreshold {
  const { contract_stated, payslip_reproduced_evidence, user_entered } = inputs;

  if (user_entered !== null) {
    return { hours_before_step_up: user_entered, provenance: 'user_entered', disagreement: null };
  }
  if (contract_stated !== null) {
    const disagreement =
      payslip_reproduced_evidence !== null && payslip_reproduced_evidence !== contract_stated
        ? { contract_value: contract_stated, payslip_reproduced_value: payslip_reproduced_evidence }
        : null;
    return { hours_before_step_up: contract_stated, provenance: 'contract_stated', disagreement };
  }
  if (payslip_reproduced_evidence !== null) {
    return { hours_before_step_up: payslip_reproduced_evidence, provenance: 'payslip_reproduced_evidence', disagreement: null };
  }
  return { hours_before_step_up: null, provenance: 'unknown', disagreement: null };
}

export type HourGridLineCategory = 'regular' | 'overtime_tier_1' | 'overtime_tier_2' | 'saturday' | 'sunday' | 'holiday';

export interface HourGridLine {
  day: DayOfWeek;
  category: HourGridLineCategory;
  hours: number;
}

export type HourGridConversionResult =
  | { status: 'blocked'; reason: 'overtime_threshold_unknown'; days_affected: DayOfWeek[] }
  | { status: 'complete'; lines: HourGridLine[] };

/**
 * Precedence per day, matching spec §5b: a public holiday overrides weekend treatment (a holiday
 * falling on a Saturday is still paid at the holiday rate, not stacked or double-counted), and
 * Saturday/Sunday hours are paid at their own flat percentage regardless of how many hours they are -
 * the overtime threshold only tiers hours on an ordinary Monday-Friday working day. Blocks (returns
 * 'blocked', never a guessed split) only when a weekday actually has overtime hours to tier and the
 * threshold is unknown - a day with zero overtime hours converts cleanly even with no threshold at
 * all, since there is nothing on it to split.
 */
export function convertHourGridToLines(grid: HourGridInput, threshold: OvertimeTierThreshold): HourGridConversionResult {
  const lines: HourGridLine[] = [];
  const daysNeedingThreshold: DayOfWeek[] = [];

  for (const day of WEEK_DAYS) {
    const { regular_hours, overtime_hours, is_public_holiday } = grid[day];
    const totalHours = regular_hours + overtime_hours;
    if (totalHours <= 0) continue;

    if (is_public_holiday) {
      lines.push({ day, category: 'holiday', hours: totalHours });
      continue;
    }
    if (day === 'sat') {
      lines.push({ day, category: 'saturday', hours: totalHours });
      continue;
    }
    if (day === 'sun') {
      lines.push({ day, category: 'sunday', hours: totalHours });
      continue;
    }

    if (regular_hours > 0) lines.push({ day, category: 'regular', hours: regular_hours });

    if (overtime_hours > 0) {
      if (threshold.hours_before_step_up === null) {
        daysNeedingThreshold.push(day);
        continue;
      }
      const tier1 = Math.min(overtime_hours, threshold.hours_before_step_up);
      const tier2 = Math.max(0, overtime_hours - threshold.hours_before_step_up);
      if (tier1 > 0) lines.push({ day, category: 'overtime_tier_1', hours: tier1 });
      if (tier2 > 0) lines.push({ day, category: 'overtime_tier_2', hours: tier2 });
    }
  }

  if (daysNeedingThreshold.length > 0) {
    return { status: 'blocked', reason: 'overtime_threshold_unknown', days_affected: daysNeedingThreshold };
  }
  return { status: 'complete', lines };
}

/**
 * §5c / CD+CR (audit "SEVERAL EMPLOYERS AT ONCE" round) - the grid gains a dimension: day x employer
 * x category. This is NOT the OTTO case (one employer, two hirers, one payroll) - it is genuinely
 * separate employers, each with their own contract, their own overtime threshold, their own payroll.
 * We hold no reference document for this case (CN1) - everything here is reasoning from the rules,
 * built to be verified against a real document later, not to be trusted as calibrated today.
 *
 * CO1 (never pool hours) is enforced structurally: this function calls convertHourGridToLines() once
 * per employer, on that employer's own grid and own threshold, and never merges the inputs before
 * conversion. What IS combined afterwards is a display-only hours-by-category rollup (CR2's "combined
 * summary") - never fed back into any computation. Each employer's own `per_employer[id].lines` is
 * what feeds that employer's own, separate PayslipPeriod/hour_lines (CO1's "one PayslipPeriod per
 * employer") - this function does not build PayslipPeriod itself, that remains the caller's job
 * (tier-c.ts / tier-a.ts), same separation §5b already established for the single-employer case.
 */
export type EmployerId = string;

export interface MultiEmployerHourGridResult {
  per_employer: Record<EmployerId, HourGridConversionResult>;
  /** Display-only, for CR2's combined summary view below the per-employer tabs - NEVER an input to
   * any tax computation. Only includes employers whose own conversion succeeded; an employer still
   * blocked on an unknown threshold is omitted here (its own tab shows the gap, not a wrong total). */
  combined_hours_by_category: Record<HourGridLineCategory, number>;
}

const ZERO_CATEGORY_TOTALS: Record<HourGridLineCategory, number> = {
  regular: 0,
  overtime_tier_1: 0,
  overtime_tier_2: 0,
  saturday: 0,
  sunday: 0,
  holiday: 0,
};

export function convertMultiEmployerHourGrid(
  grids: Record<EmployerId, HourGridInput>,
  thresholds: Record<EmployerId, OvertimeTierThreshold>,
): MultiEmployerHourGridResult {
  const perEmployer: Record<EmployerId, HourGridConversionResult> = {};
  const combined: Record<HourGridLineCategory, number> = { ...ZERO_CATEGORY_TOTALS };

  for (const [employerId, grid] of Object.entries(grids)) {
    const threshold = thresholds[employerId];
    if (!threshold) continue; // no threshold supplied for this employer - caller error, nothing to convert
    const result = convertHourGridToLines(grid, threshold);
    perEmployer[employerId] = result;
    if (result.status === 'complete') {
      for (const line of result.lines) combined[line.category] += line.hours;
    }
  }

  return { per_employer: perEmployer, combined_hours_by_category: combined };
}
