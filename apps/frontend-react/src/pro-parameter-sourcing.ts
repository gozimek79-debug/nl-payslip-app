/**
 * Stage 3.0a (audit v42): parameter-sourcing logic pulled out of `ProDocuments.tsx` the same way
 * `pro-documents-policy.ts` and `render-step-policy.ts` were - pure, DOM-free, testable with this
 * project's existing `node --test` runner.
 *
 * Survey findings this file is built on (3.0a.1, checked directly, not assumed):
 * - `hour-grid.ts`'s `resolveOvertimeTierThreshold` is the ONLY existing dual-source (contract vs
 *   payslip) resolver in this space, and its own real (non-test) caller (`tier-a.ts:276`) hardcodes
 *   `payslip_reproduced_evidence: null` - nothing anywhere reproduces the threshold from a payslip
 *   today. Reproducing it would need knowing how many DAYS a period's total overtime was spread
 *   across (a payslip prints period totals per tier, never a per-day breakdown) - not derivable
 *   without guessing a day distribution, so this file does NOT attempt it (§2.3). The threshold
 *   stays sourced from the contract timeline alone this round; `resolveOvertimeTierThreshold` itself
 *   is reused unchanged for whenever payslip evidence becomes available.
 * - `FIXTURES-paski-referencyjne.md` (checked directly): none of the four reference documents label
 *   an hour line by weekday - Olympia's own is "onregelm. 100%/50%", a generic tier, never
 *   "Saturday"/"Sunday". Saturday/Sunday/holiday percentages therefore have no evidence to be
 *   sourced from at all this round - they stay unknown, always, never guessed from tier percentages.
 * - `ContractExtraction` has no percentage fields (confirmed in contract.ts's own doc comment) - the
 *   overtime tier percentages below are payslip-sourced only; no contract-vs-payslip disagreement is
 *   possible for them, only for the threshold (see above).
 */

export interface ParameterSource {
  kind: 'contract' | 'payslip';
  /** The document's own label (contract-timeline.ts's `EffectiveFieldSource.label`, or the payslip
   * entry's filename) - never a generic "contract"/"payslip" alone, per §2.1's provenance discipline. */
  label: string;
  /** Only set for a payslip source - the period it covers, shown so a reader can judge how current
   * the sourced parameter is. */
  period?: string | null;
}

/** A minimal, DOM-free mirror of a payslip's own hour line - only what this file's own derivation
 * needs (category and the per-line percent), never the full `TierCPeriodResponse` shape. */
export interface PayslipHourLineLike {
  category: string;
  percent: number | null;
}

export interface DerivedOvertimePercents {
  tier1: number | null;
  tier2: number | null;
}

/**
 * Turns a reproduced payslip's own hour lines into "this employer's own overtime tier 1 %, tier 2
 * %". The ordering (the LOWER of two distinct percentages is tier 1, the higher is tier 2) is a
 * genuine arithmetic fact - tier 2 pays MORE than tier 1 by construction, that is what "tier 2"
 * means - never a guessed mapping from percentage to tier number. A single distinct percentage means
 * the document shows no evidence the worker ever crossed into a second tier that period - tier 1 is
 * known, tier 2 stays unknown (never assumed equal, never assumed absent).
 */
export function derivePayslipOvertimePercents(hourLines: PayslipHourLineLike[]): DerivedOvertimePercents {
  const distinctPercents = Array.from(
    new Set(
      hourLines
        .filter((line) => (line.category === 'overtime' || line.category === 'irregular_surcharge') && line.percent !== null)
        .map((line) => line.percent as number),
    ),
  ).sort((a, b) => a - b);
  return {
    tier1: distinctPercents[0] ?? null,
    tier2: distinctPercents.length > 1 ? distinctPercents[distinctPercents.length - 1] ?? null : null,
  };
}

export interface ReproducedPayslipCandidate {
  label: string;
  /** The document's own printed period label, for display - never used for "most recent" ordering
   * (a printed label's format is not comparable across documents; the ISO end date is). */
  periodLabel: string | null;
  /** ISO date string, or null when the period's own end date could not be read - such a candidate is
   * still eligible (§2.1: a missing date is not the same as a failed read), it is simply never
   * preferred over one whose recency IS known. */
  periodEndDate: string | null;
  /** Spec's own exact rule: "a payslip that failed verification is never used as a parameter source,
   * however recent." Operationalised here as the Tier C consistency gate having passed (`status ===
   * 'ok'`) AND the discrepancy list being genuinely empty - not merely every entry being a
   * 'confirm'-band question, since an unconfirmed question is not yet a verified fact (stage 1's own
   * three-band model: silent / a question / a finding - only silence, i.e. no discrepancy raised at
   * all, is a document nothing at all was found wrong with). */
  fullyReproduced: boolean;
  hourLines: PayslipHourLineLike[];
}

/**
 * Spec §5's own rule, applied literally: among payslips the engine could FULLY reproduce (never one
 * that failed verification, however recent that one is), the most recent by its own period end date
 * wins. A reproduced candidate with no readable end date is still eligible - just never preferred
 * over one whose recency is actually known - so it is only ever chosen when it is the sole reproduced
 * candidate.
 */
export function selectMostRecentReproducedPayslip(candidates: ReproducedPayslipCandidate[]): ReproducedPayslipCandidate | null {
  const reproduced = candidates.filter((c) => c.fullyReproduced);
  if (reproduced.length === 0) return null;
  const dated = reproduced.filter((c) => c.periodEndDate !== null);
  if (dated.length === 0) return reproduced[0] ?? null;
  return dated.reduce((latest, c) => ((c.periodEndDate as string) > (latest.periodEndDate as string) ? c : latest));
}

export type OvertimeThresholdProvenance = 'user_entered' | 'contract_stated' | 'payslip_reproduced_evidence' | 'unknown';

export interface ThresholdDisagreement {
  contract_value: number;
  payslip_reproduced_value: number;
}

export interface OvertimeTierThreshold {
  hours_before_step_up: number | null;
  provenance: OvertimeThresholdProvenance;
  disagreement: ThresholdDisagreement | null;
}

/**
 * A frontend mirror of `hour-grid.ts`'s own `resolveOvertimeTierThreshold` - there is no
 * shared-types package between the two projects (the same reason `TierCFlow.tsx` mirrors
 * `extraction-consistency.ts`'s own types instead of importing them), so this is copied logic, not
 * shared logic. Kept identical on purpose: `contract_stated` wins over `payslip_reproduced_evidence`
 * when both are known (CH1's own established rule - "a contract's own stated term is not inference
 * and wins over it" - deliberately NOT the "payslip wins" rule this stage's own parameter-sourcing
 * uses for the tier PERCENTAGES, which have no contract-side counterpart at all and so never reach
 * this disagreement question in the first place). `payslip_reproduced_evidence` is always `null` in
 * this round's own real call site (`ProDocuments.tsx`) - see this file's own top doc comment for why
 * reproducing it from a payslip is not attempted this round; this function is reused UNCHANGED so
 * that the moment reproduction is ever built, both layers already agree on how to resolve it.
 */
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

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface ScenarioDayHours {
  regular_hours: number;
  overtime_hours: number;
  is_public_holiday: boolean;
}
export type ScenarioWeekGrid = Record<DayOfWeek, ScenarioDayHours>;

/**
 * Stage 3.0a.3: "scenario comparison - at minimum 40 vs. 50 vs. 60 hours... the marginal question:
 * what the fiftieth hour is worth after tax." Builds ONE week's grid for a given total weekly hour
 * count - a stated, explicit distribution rule (§2.4: a design choice recorded as one, never a
 * hidden guess): up to 40 hours spread evenly as REGULAR hours across the five weekdays (8h/day),
 * anything beyond 40 spread evenly across the same five weekdays as OVERTIME. Never Saturday/Sunday
 * (this round has no evidence-based weekend split to offer - see this file's own doc comment), never
 * a public holiday flag (a hypothetical "what if I work N hours" question has no specific calendar
 * date attached to it at all).
 */
export function buildScenarioWeekGrid(totalHours: number): ScenarioWeekGrid {
  const regularPerDay = Math.round((Math.min(totalHours, 40) / 5) * 100) / 100;
  const overtimePerDay = Math.round((Math.max(totalHours - 40, 0) / 5) * 100) / 100;
  const weekday: ScenarioDayHours = { regular_hours: regularPerDay, overtime_hours: overtimePerDay, is_public_holiday: false };
  const weekend: ScenarioDayHours = { regular_hours: 0, overtime_hours: 0, is_public_holiday: false };
  return { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: weekend, sun: weekend };
}

/** The three fixed reference points spec §5's own "Scenario comparison" section names verbatim. */
export const SCENARIO_TOTAL_HOURS = [40, 50, 60] as const;
