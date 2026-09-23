import { tableTaxToleranceFor, type PayslipComputationOutcome, type PayslipPeriod } from './payslip-model.js';

/**
 * Tier C's core promise (spec §5 - "Verification. Compute independently, then compare line by line
 * against the payslip's own printed figures. Surface a discrepancy list. This is the product's core
 * promise and it is not implemented today"). Lives beside payslip-model.ts, not inside tier-c.ts,
 * because comparing a PayslipPeriod's own `printed_*` fields against its own computed outcome is
 * generic to ANY correctly-populated period, not something specific to how Tier C's extraction
 * populates one (spec §2's "one engine, one model" - Tier B would want the identical comparator).
 *
 * ============================================================================================
 * STAGE 1 - THE CONFIRMATION STEP (audit "CONSOLIDATED ASSIGNMENT" round, Tier C §3, "gates
 * everything else"). Three bands, not two:
 *
 *   within `tolerance`                    silent - no discrepancy at all (unchanged from before)
 *   beyond `tolerance`, within `confirmation_upper`   status 'confirm' - a question, never an
 *                                                       accusation ("we read X - is that right?")
 *   beyond `confirmation_upper`           status 'finding' - stated plainly
 *
 * This module produces the CLASSIFICATION only - `status` plus the two band edges, so a consumer
 * (Stage 2's result panel) can render the actual confirm/correct/recompute interaction. Building
 * that interaction here would be running two stages in parallel, which this round's own instruction
 * forbids.
 * ============================================================================================
 *
 * Structured per audit BN3/CONVENTIONS.md: a `code` plus numeric parameters, never a prebaked
 * sentence - this is Tier C's own new code, so it follows the house pattern from the start rather
 * than being retrofitted the way Tier A's was.
 */
export type DiscrepancyStatus = 'confirm' | 'finding';

export type DiscrepancyCode =
  | 'table_tax_mismatch'
  | 'bt_tax_mismatch'
  | 'algemene_heffingskorting_mismatch'
  | 'arbeidskorting_mismatch'
  | 'net_mismatch'
  | 'payout_mismatch'
  | 'minimum_wage_stale_on_document'
  | 'minimum_wage_violation';

export interface Discrepancy {
  code: DiscrepancyCode;
  computed: number | null;
  printed: number;
  residual: number | null;
  /** The silent-band upper edge - unchanged name and meaning from before this round. */
  tolerance: number;
  /** NEW this round: beyond `tolerance` but within this, `status` is 'confirm'. */
  confirmation_upper: number;
  status: DiscrepancyStatus;
  /** Stage 2 body ("Dutch terms as printed... not canonical"): the label PayslipPeriod carries for
   * this figure, exactly as printed on the source document - null when the document has no distinct
   * label for it (never a canonical stand-in; the consumer falls back to a generic translated term
   * in that case, per CONVENTIONS.md - the sentence-building stays in the interface, not here). */
  printed_label: string | null;
  /** Stage 2i (audit v29, §2i.0e): "group payout_mismatch under table_tax_mismatch when they have the
   * same cause (structured related_to, one row on the panel; the OTTO 12.28 case)." Set when this
   * discrepancy's own residual is the near-exact mirror (equal magnitude, opposite sign - a wrong tax
   * figure moves net/payout by exactly its own error, one-for-one) of a table_tax_mismatch or
   * bt_tax_mismatch discrepancy ALSO present in the same list - never asserted from the code alone,
   * only from the arithmetic actually cancelling out (`linkRelatedDiscrepancies` below). `null` when
   * this discrepancy has no such match, including every case where it is the root cause itself. */
  related_to: DiscrepancyCode | null;
}

/**
 * CJ (audit "SEVERAL EMPLOYERS AT ONCE" round): retuned from 0.01. BT tax's COMPUTATION has no
 * rounding ambiguity (flat percentage, not a table lookup) - but the PRINTED reference figure it's
 * checked against is still read by OCR, and BW3 (tier-c.test.ts) measured a real false positive from
 * a plausible single-digit OCR slip on that printed figure under the old 0.01 tolerance. 0.10 gives
 * room for that class of noise while staying far below the multi-euro residual a genuine rate or
 * base error produces (see BW2, which correctly still fires at this tolerance).
 */
const BT_TAX_TOLERANCE = 0.1;
/** algemene_heffingskorting/arbeidskorting are annual-formula outputs divided by the period
 * multiplier, same stepwise-rounding source as table_tax - reuse the same period-scaled tolerance
 * rather than inventing a second one (spec §2 - one set of tolerances, not two that could drift). */
function korTolerance(period: PayslipPeriod): number {
  return tableTaxToleranceFor(period.period_type);
}

/**
 * Stage 1's confirmation-band derivation, per code family, each reasoned from the SAME measured
 * evidence BT_TAX_TOLERANCE itself came from (BW1-BW4, BW2, CL - tier-c.test.ts), per the explicit
 * instruction to derive these "the way you derived BT_TAX_TOLERANCE", not invent them.
 *
 * table_tax_mismatch / algemene_heffingskorting_mismatch / arbeidskorting_mismatch / net_mismatch /
 * payout_mismatch all share the SAME base tolerance (tableTaxToleranceFor) - they are all downstream
 * of the same stepwise-table-rounding reconstruction, or (net/payout, per CL) inherit that residual
 * one-for-one. Confirmation multiplier: 3x that base. Derivation: BW2 measured a real, single-line
 * category misclassification (one small ambiguous line moved table->bt) producing a
 * table_tax_mismatch residual of -0.60 - about 1.2x the weekly tolerance (0.50). A single plausible
 * AI misjudgment on one line is exactly the class of thing a confirmation question should catch, not
 * silently escalate to a finding - 3x gives room for that measured case plus some compounding margin
 * (two such lines), landing at 1.50/3.00/4.50 EUR for week/4-weekly/month. OTTO's real, documented
 * 12.28 EUR gap (24x the weekly tolerance) stays far above this at every period length, so it
 * correctly remains a 'finding', never merely a question.
 */
const TABLE_TOLERANCE_CONFIRMATION_MULTIPLIER = 3;

/**
 * bt_tax_mismatch gets its OWN confirmation edge, not a multiple of BT_TAX_TOLERANCE - that base
 * tolerance is deliberately tight (0.10) because BT's computation itself has no rounding ambiguity;
 * a flat multiplier of it would be too small to cover BW2's measured single-line-misclassification
 * effect on bt_tax specifically (+1.01), which is exactly the "did we get one line wrong" case a
 * confirmation question exists for. Set directly from that measurement plus margin.
 */
const BT_TAX_CONFIRMATION_UPPER = 1.5;

/**
 * Minimum-wage staleness is a different kind of comparison from the five above: printed-vs-
 * authoritative-rate (the rules database), not computed-vs-printed. The ambiguity a confirmation
 * question can usefully resolve here is narrower - "did we read the printed minimum wage correctly"
 * - not "did the employer apply the right rate" (that is a fact, not extraction noise). Kept
 * deliberately tight: Olympia's own real, confirmed staleness case (14.71 printed vs 14.99
 * applicable, a genuine 0.28 EUR gap from an out-of-date printed rate) must stay a 'finding', not sit
 * as an indefinitely-open question - 0.10 covers only a trivial single-cent-range OCR misread.
 */
const MINIMUM_WAGE_CONFIRMATION_UPPER = 0.1;

/**
 * Stage 2h (audit v28, §2h.3): "compare printed_net with BOTH wage_net and period_net. It is a
 * mismatch only when it matches neither... when it matches one, record which (in the trace, not as
 * prose)." A single pure function decides this, so the net_mismatch discrepancy below and whatever
 * the controller attaches to a clean 'ok' response as the recorded basis can never disagree about
 * what passed and why - the same "one place decides, everyone reads from it" shape as
 * `resolveSubtotalRole` and the text-layer guard elsewhere in this codebase.
 */
// Stage 2n (audit v35, §2n.2): NEW - 'taxable_base_net' names OTTO's own "Podsuma wynagrodzenia"/
// "Totaal netto" position (725.38 − 77.52 − 40.08 = 607.78, confirmed against FIXTURES-paski-
// referencyjne.md's own Krok 4 AND the owner's live panel, OWNER-RETEST-2n-otto.md): taxable base
// minus BOTH taxes, nothing else - printed BEFORE post-tax social deductions are ever subtracted,
// a position `wage_net`/`period_net` (both always post-tax) can never represent. Without this, a
// gate that now correctly accepts this position (checkNetStage, §2n.2) would still have the
// DISCREPANCY layer immediately re-block it as a false net_mismatch - the exact bug moved one layer
// down, not fixed.
export type NetReconciliationBasis = 'taxable_base_net' | 'wage_net' | 'period_net' | 'both' | 'neither' | 'not_applicable';

export function resolveNetReconciliationBasis(outcome: PayslipComputationOutcome, printedNet: number | null, tolerance: number): NetReconciliationBasis {
  if (printedNet === null || outcome.status !== 'complete') return 'not_applicable';
  const { wage_net: wageNet, period_net: periodNet, taxable_base: taxableBase, total_tax: totalTax } = outcome.result;
  // taxableBase - totalTax algebraically equals wageNet + post_tax_social_total (wageNet is already
  // taxableBase - totalTax - postTaxSocialTotal) - derived from existing engine outputs, no new field.
  const taxableBaseNet = Math.round((taxableBase - totalTax) * 100) / 100;
  const taxableBaseMatches = Math.abs(taxableBaseNet - printedNet) <= tolerance;
  const wageMatches = Math.abs(wageNet - printedNet) <= tolerance;
  const periodMatches = Math.abs(periodNet - printedNet) <= tolerance;
  const matchCount = [taxableBaseMatches, wageMatches, periodMatches].filter(Boolean).length;
  if (matchCount > 1) return 'both';
  if (taxableBaseMatches) return 'taxable_base_net';
  if (wageMatches) return 'wage_net';
  if (periodMatches) return 'period_net';
  return 'neither';
}

const pushable = (
  code: Discrepancy['code'],
  computed: number,
  printed: number | null,
  tolerance: number,
  confirmationUpper: number,
  printedLabel: string | null = null,
): Discrepancy | null => {
  if (printed === null) return null; // nothing printed to check against - not a discrepancy, an absence
  const residual = Math.round((computed - printed) * 100) / 100;
  const magnitude = Math.abs(residual);
  if (magnitude <= tolerance) return null; // silent - the original BP4 guarantee, unchanged
  const status: DiscrepancyStatus = magnitude <= confirmationUpper ? 'confirm' : 'finding';
  return { code, computed, printed, residual, tolerance, confirmation_upper: confirmationUpper, status, printed_label: printedLabel, related_to: null };
};

/**
 * Stage 2i (audit v29, §2i.0e): "group payout_mismatch under table_tax_mismatch when they have the
 * same cause... the OTTO 12.28 case." A wrong table (or BT) tax figure moves `wage_net`/`period_net`/
 * `payout_amount` by exactly its own error, one for one - so a downstream discrepancy caused SOLELY by
 * that tax error has a residual that is the near-exact mirror (equal magnitude, opposite sign) of the
 * tax discrepancy's own. Only linked when the arithmetic actually cancels this closely - never merely
 * because both codes happened to fire in the same read (a genuinely SEPARATE net/payout error would
 * not cancel this precisely against an unrelated tax error).
 */
const RELATED_DISCREPANCY_EPSILON = 0.05;

function linkRelatedDiscrepancies(discrepancies: Discrepancy[]): Discrepancy[] {
  const taxRoot = discrepancies.find((d) => d.code === 'table_tax_mismatch') ?? discrepancies.find((d) => d.code === 'bt_tax_mismatch');
  if (!taxRoot || taxRoot.residual === null) return discrepancies;
  return discrepancies.map((d) => {
    if ((d.code === 'net_mismatch' || d.code === 'payout_mismatch') && d.residual !== null && Math.abs(d.residual + taxRoot.residual!) < RELATED_DISCREPANCY_EPSILON) {
      return { ...d, related_to: taxRoot.code };
    }
    return d;
  });
}

/**
 * BP4's shipping condition, restated as the actual acceptance test this function exists to satisfy:
 * "the discrepancy list correctly reports a correct payslip as correct." A verifier that flags a
 * valid payslip is worse than no verifier (the original audit's first finding) - so every comparison
 * below only fires when the residual exceeds the SAME tolerance the golden tests already established
 * as real table-rounding noise, never a tighter one invented for this function specifically. Stage 1
 * adds a status to what DOES fire, it does not change what counts as silent.
 */
export function comparePeriodToDocument(period: PayslipPeriod, outcome: PayslipComputationOutcome): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const tableTolerance = tableTaxToleranceFor(period.period_type);
  const heffingskortingTolerance = korTolerance(period);
  const tableConfirmationUpper = tableTolerance * TABLE_TOLERANCE_CONFIRMATION_MULTIPLIER;
  const heffingskortingConfirmationUpper = heffingskortingTolerance * TABLE_TOLERANCE_CONFIRMATION_MULTIPLIER;

  const push = (result: Discrepancy | null): void => {
    if (result) discrepancies.push(result);
  };

  if (outcome.status === 'complete') {
    const { result } = outcome;
    push(pushable('table_tax_mismatch', result.table_tax_after_korting, period.printed_table_tax, tableTolerance, tableConfirmationUpper, period.printed_table_tax_label));
    push(pushable('bt_tax_mismatch', result.bt_tax, period.printed_bt_tax, BT_TAX_TOLERANCE, BT_TAX_CONFIRMATION_UPPER, period.printed_bt_tax_label));
    push(pushable('algemene_heffingskorting_mismatch', result.algemene_heffingskorting, period.printed_algemene_heffingskorting, heffingskortingTolerance, heffingskortingConfirmationUpper, period.printed_algemene_heffingskorting_label));
    push(pushable('arbeidskorting_mismatch', result.arbeidskorting, period.printed_arbeidskorting, heffingskortingTolerance, heffingskortingConfirmationUpper, period.printed_arbeidskorting_label));
    // CL: net_mismatch/payout_mismatch were declared for two rounds with nothing pushing them - a
    // net_lines misclassification (a reimbursement read as a deduction) would silently pass "no
    // discrepancy" with only the four checks above. Reuses tableTolerance (not a fresh number): both
    // figures are downstream of table_tax_after_korting, so they inherit its own rounding residual
    // one-for-one and cannot be held to a tighter band than the figure they're built from. Same
    // reasoning extends to the confirmation edge.
    //
    // Stage 2g (§2g.0a) fixed this to compare `result.wage_net` instead of `result.period_net` - right
    // for Olympia/Randstad (their one printed "net" sits BEFORE net additions/deductions) but wrong
    // for PKF, whose own printed net is AFTER them (a real 91.25 travel reimbursement and a real
    // 1100.00 loan deduction move the two figures apart by over a thousand euros - the reviewer
    // measured a spurious ~1012 EUR residual reproducing this). Stage 2h (§2h.3): compare against
    // BOTH; a mismatch fires only when NEITHER matches. `resolveNetReconciliationBasis` decides this
    // once, so this push and whatever the controller records as the confirmed basis on a clean 'ok'
    // response can never disagree.
    {
      const netBasis = resolveNetReconciliationBasis(outcome, period.printed_net, tableTolerance);
      if (netBasis === 'neither' && period.printed_net !== null) {
        // Stage 2n (§2n.2): none of the three positions matches - report against whichever is
        // numerically closest, so the shown residual is the true nearest gap, not an arbitrary pick
        // among three comparably-wrong figures.
        const taxableBaseNet = Math.round((result.taxable_base - result.total_tax) * 100) / 100;
        const candidates: Array<{ value: number; residual: number }> = [
          { value: taxableBaseNet, residual: Math.abs(taxableBaseNet - period.printed_net) },
          { value: result.wage_net, residual: Math.abs(result.wage_net - period.printed_net) },
          { value: result.period_net, residual: Math.abs(result.period_net - period.printed_net) },
        ];
        const closest = candidates.reduce((best, c) => (c.residual < best.residual ? c : best));
        push(pushable('net_mismatch', closest.value, period.printed_net, tableTolerance, tableConfirmationUpper, period.printed_net_label));
      }
    }
    push(pushable('payout_mismatch', result.payout_amount, period.printed_payout, tableTolerance, tableConfirmationUpper, period.printed_payout_label));
  } else {
    // Incomplete: table_tax/bt_tax are still present (as an upper bound, or fully correct if only
    // post-tax was unknown - see IncompletePayslipComputation's own doc comment), net/payout are not.
    push(pushable('table_tax_mismatch', outcome.table_tax_after_korting, period.printed_table_tax, tableTolerance, tableConfirmationUpper, period.printed_table_tax_label));
    push(pushable('bt_tax_mismatch', outcome.bt_tax, period.printed_bt_tax, BT_TAX_TOLERANCE, BT_TAX_CONFIRMATION_UPPER, period.printed_bt_tax_label));
  }

  // Minimum wage: audit N4/BP1 point 4 - `wml_applicable` must already be resolved from the rules
  // DB by the caller (getRuleAt('loonheffing_nl', period_end), via getMinimumWageAt) before this
  // function runs; this only reports the printed-vs-applicable comparison, it does not resolve it.
  // Tolerance stays 0.005 (unchanged from before this round - a rounding guard, not a real band) -
  // Stage 1 only adds which of the two remaining bands a genuine difference falls into.
  if (period.wml_applicable !== null) {
    push(pushable('minimum_wage_stale_on_document', period.wml_applicable, period.wml_printed, 0.005, MINIMUM_WAGE_CONFIRMATION_UPPER));
  }

  return linkRelatedDiscrepancies(discrepancies);
}
