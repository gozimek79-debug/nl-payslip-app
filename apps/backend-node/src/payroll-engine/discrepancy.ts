import { tableTaxToleranceFor, type PayslipComputationOutcome, type PayslipPeriod } from './payslip-model.js';

/**
 * Tier C's core promise (spec §5 - "Verification. Compute independently, then compare line by line
 * against the payslip's own printed figures. Surface a discrepancy list. This is the product's core
 * promise and it is not implemented today"). Lives beside payslip-model.ts, not inside tier-c.ts,
 * because comparing a PayslipPeriod's own `printed_*` fields against its own computed outcome is
 * generic to ANY correctly-populated period, not something specific to how Tier C's extraction
 * populates one (spec §2's "one engine, one model" - Tier B would want the identical comparator).
 *
 * Structured per audit BN3/CONVENTIONS.md: a `code` plus numeric parameters, never a prebaked
 * sentence - this is Tier C's own new code, so it follows the house pattern from the start rather
 * than being retrofitted the way Tier A's was.
 */
export interface Discrepancy {
  code:
    | 'table_tax_mismatch'
    | 'bt_tax_mismatch'
    | 'algemene_heffingskorting_mismatch'
    | 'arbeidskorting_mismatch'
    | 'net_mismatch'
    | 'payout_mismatch'
    | 'minimum_wage_stale_on_document'
    | 'minimum_wage_violation';
  computed: number | null;
  printed: number;
  residual: number | null;
  tolerance: number | null;
}

const EXACT_TOLERANCE = 0.01;
/** algemene_heffingskorting/arbeidskorting are annual-formula outputs divided by the period
 * multiplier, same stepwise-rounding source as table_tax - reuse the same period-scaled tolerance
 * rather than inventing a second one (spec §2 - one set of tolerances, not two that could drift). */
function korTolerance(period: PayslipPeriod): number {
  return tableTaxToleranceFor(period.period_type);
}

/**
 * BP4's shipping condition, restated as the actual acceptance test this function exists to satisfy:
 * "the discrepancy list correctly reports a correct payslip as correct." A verifier that flags a
 * valid payslip is worse than no verifier (the original audit's first finding) - so every comparison
 * below only fires when the residual exceeds the SAME tolerance the golden tests already established
 * as real table-rounding noise, never a tighter one invented for this function specifically.
 */
export function comparePeriodToDocument(period: PayslipPeriod, outcome: PayslipComputationOutcome): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const tableTolerance = tableTaxToleranceFor(period.period_type);
  const heffingskortingTolerance = korTolerance(period);

  const pushIfBeyondTolerance = (
    code: Discrepancy['code'],
    computed: number,
    printed: number | null,
    tolerance: number,
  ): void => {
    if (printed === null) return; // nothing printed to check against - not a discrepancy, an absence
    const residual = Math.round((computed - printed) * 100) / 100;
    if (Math.abs(residual) > tolerance) {
      discrepancies.push({ code, computed, printed, residual, tolerance });
    }
  };

  if (outcome.status === 'complete') {
    const { result } = outcome;
    pushIfBeyondTolerance('table_tax_mismatch', result.table_tax_after_korting, period.printed_table_tax, tableTolerance);
    pushIfBeyondTolerance('bt_tax_mismatch', result.bt_tax, period.printed_bt_tax, EXACT_TOLERANCE);
    pushIfBeyondTolerance('algemene_heffingskorting_mismatch', result.algemene_heffingskorting, period.printed_algemene_heffingskorting, heffingskortingTolerance);
    pushIfBeyondTolerance('arbeidskorting_mismatch', result.arbeidskorting, period.printed_arbeidskorting, heffingskortingTolerance);
  } else {
    // Incomplete: table_tax/bt_tax are still present (as an upper bound, or fully correct if only
    // post-tax was unknown - see IncompletePayslipComputation's own doc comment), net/payout are not.
    pushIfBeyondTolerance('table_tax_mismatch', outcome.table_tax_after_korting, period.printed_table_tax, tableTolerance);
    pushIfBeyondTolerance('bt_tax_mismatch', outcome.bt_tax, period.printed_bt_tax, EXACT_TOLERANCE);
  }

  // Minimum wage: audit N4/BP1 point 4 - `wml_applicable` must already be resolved from the rules
  // DB by the caller (getRuleAt('loonheffing_nl', period_end), via getMinimumWageAt) before this
  // function runs; this only reports the printed-vs-applicable comparison, it does not resolve it.
  if (period.wml_printed !== null && period.wml_applicable !== null && Math.abs(period.wml_printed - period.wml_applicable) > 0.005) {
    discrepancies.push({
      code: 'minimum_wage_stale_on_document',
      computed: period.wml_applicable,
      printed: period.wml_printed,
      residual: Math.round((period.wml_applicable - period.wml_printed) * 100) / 100,
      tolerance: 0,
    });
  }

  return discrepancies;
}
