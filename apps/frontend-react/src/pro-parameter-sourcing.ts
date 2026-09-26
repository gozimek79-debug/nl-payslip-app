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
 * needs (category, the per-line percent, and `adds_hours` - see `derivePayslipOvertimePercents`'s
 * own doc comment for why the last one is load-bearing, not incidental), never the full
 * `TierCPeriodResponse` shape. */
export interface PayslipHourLineLike {
  category: string;
  percent: number | null;
  adds_hours: boolean;
}

export interface DerivedOvertimePercents {
  tier1: number | null;
  tier2: number | null;
  /** Stage 3.0a.5 (§Fix 3): any further distinct eligible percentage beyond the two the grid's own
   * two tiers can hold - the grid has no third slot, so one has to go, but it must be visible, not
   * silently dropped (§2.1/§2.3). Raw, as printed on the payslip (before the tier1/tier2 -100
   * conversion below), so a reader can check it directly against the document. Empty when at most
   * two distinct eligible percentages were found. */
  excludedPercents: number[];
}

/**
 * Turns a reproduced payslip's own hour lines into "this employer's own overtime tier 1 %, tier 2
 * %" - the PREMIUM-above-base percentages `TierACalculator`'s own grid formula
 * (`hours * rate * (1 + percent / 100)`, `tier-a.ts`) expects.
 *
 * Stage 3.0a.5 (§Fix 1, a MAJOR pricing bug in 3.0a's own first version): only an `adds_hours: true`
 * line (`category: 'overtime'`) belongs here at all, and its own printed percent is the FULL paid
 * multiplier (e.g. "125%" means paid at 125% of the base rate) - it needs `percent - 100` to become
 * the premium the grid's formula wants (25). Confirmed against PKF's own real fixture
 * (`tier-c.test.ts`): "Overwerk uren 125%" (4.0h) and "Overwerk uren 150%" (18.25h) at a 17.09 base
 * rate reproduce the fixture's own printed amounts (85.45 and 467.84) to the cent ONLY with this
 * conversion - feeding 125/150 straight into the grid (3.0a's own original bug) prices the same
 * hours at 225%/250% instead, exactly the live-confirmed defect (a reproduced 150 priced 10 hours
 * at 405.00 instead of the correct 243.00).
 *
 * An `adds_hours: false` line (`category: 'irregular_surcharge'`, Olympia's own "onregelm."
 * surcharges) is a DIFFERENT concept entirely - a bonus on hours ALREADY counted elsewhere (a
 * REGULAR line), never additional hours worked - and it already has its own, correctly-working home
 * in Tier A's existing free-form surcharge lines (`tier-a.ts`'s `surcharge_lines`, untouched by this
 * round: `amount = hours * rate * percent / 100`, no conversion, matching Olympia's own real numbers
 * exactly as printed already). Routing such a line into the day-grid's overtime tiers instead would
 * be wrong twice over - the wrong formula, applied to hours that were never actually additional -
 * so it is excluded here entirely, not converted and not counted as a "dropped" third value (§Fix 3
 * is about a genuine THIRD eligible overtime tier, not an ineligible surcharge line).
 */
export function derivePayslipOvertimePercents(hourLines: PayslipHourLineLike[]): DerivedOvertimePercents {
  const rawPercents = Array.from(
    new Set(
      hourLines
        .filter((line) => line.category === 'overtime' && line.adds_hours && line.percent !== null)
        .map((line) => line.percent as number),
    ),
  ).sort((a, b) => a - b);
  const tier1Raw = rawPercents[0] ?? null;
  const tier2Raw = rawPercents.length > 1 ? (rawPercents[rawPercents.length - 1] ?? null) : null;
  const excludedPercents = rawPercents.length > 2 ? rawPercents.slice(1, -1) : [];
  return {
    tier1: tier1Raw !== null ? tier1Raw - 100 : null,
    tier2: tier2Raw !== null ? tier2Raw - 100 : null,
    excludedPercents,
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
 * shared logic. Kept identical on purpose, including its own established rule: `contract_stated`
 * wins over `payslip_reproduced_evidence` when both are known (CH1 - "a contract's own stated term
 * is not inference and wins over it", predates this stage and stands unchanged; 3.0a's own report
 * wording about "the payslip's" figures winning was imprecise and was about the tier PERCENTAGES,
 * which have no contract-side field to ever disagree with at all - never about this threshold).
 *
 * Stage 3.0a.5 (Clarification, audit v43): honestly, as of this round, THIS FUNCTION IS NOT CALLED
 * BY ANY REAL (non-test) CODE. `ProDocuments.tsx` reads the threshold directly off
 * `effectiveContract.overtimeTierThresholdHours` (contract-timeline.ts's own resolver, which already
 * IS "contract wins" by simply being the only source ever considered) - `/api/tier-a/calculate`
 * itself receives whatever the calculator's own form field holds as a plain value, with no
 * provenance distinction at that boundary at all. This mirror was written for the payslip-side
 * reproduction case 3.0a.1 found nothing already builds and did not build either (see the top of
 * this file) - kept, tested, and correct, but genuinely unused until that reproduction exists to
 * feed it a real `payslip_reproduced_evidence` value. Stated here plainly rather than left implying
 * a live capability that isn't.
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

/**
 * Stage 3.0a.5 (§Fix 4, a product-judgment finding): "an unsupplied rate must render as empty/
 * unknown, never a silently reused free-calculator default." Pulled out of `TierACalculator.tsx`'s
 * own `useState` initializer into its own pure function - the same reason every other decision in
 * this file already is one - specifically because this project has no DOM-testing setup to verify a
 * component's internal state directly, and this exact decision is one of 3.0a.5's own required exit
 * tests. Tier A's own '15.58' placeholder is a reasonable starting point for a FREE calculator the
 * user fills in themselves (spec §3); in PRO mode, since a rate CAN be genuinely sourced, an
 * unsourced one must stay visibly blank rather than silently reusing that placeholder - otherwise a
 * real, sourced 15.58 and an absent one are indistinguishable on screen, which is exactly the
 * failure this whole engagement exists to prevent.
 */
export function resolveInitialHourlyRateInput(prefillRate: number | undefined, tierMode: 'A' | 'B' | 'PRO'): string {
  if (prefillRate !== undefined) return String(prefillRate);
  return tierMode === 'PRO' ? '' : '15.58';
}
