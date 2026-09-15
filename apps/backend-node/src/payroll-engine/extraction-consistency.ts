import type { PayslipPeriod, PayslipComputationOutcome, PreTaxDeductionCategory, PostTaxSocialCategory } from './payslip-model.js';

/**
 * Stage 2b (audit "CONSOLIDATED ASSIGNMENT" v12, §Stage 2b): a gate that runs BEFORE
 * comparePeriodToDocument(), on the extracted/computed period itself - never comparing the engine's
 * verdict against the document's verdict (that is discrepancy.ts's job), only asking whether the
 * EXTRACTION is internally coherent enough to compare at all.
 *
 * Design finding this stage exists to fix (§Stage 2a, the Olympia live-extraction test): three
 * "discrepancies" shown to the owner were entirely OUR extraction's own errors (a misread six-week
 * 2025 span, two missing deductions, a wrong-row net figure), presented exactly as a real employer
 * violation would be. The three-band magnitude classifier (discrepancy.ts) separates noise from
 * findings BY MAGNITUDE - a systematic extraction failure also produces large residuals, and
 * magnitude alone cannot tell "we misread this badly" from "the employer is wrong". When any check
 * below fires, the caller must NOT show a discrepancy list at all - it shows this list of issues and
 * a correction path instead.
 */
export type ConsistencyIssue =
  | { code: 'zero_tax_nonzero_base'; taxable_base: number; printed_table_tax: number }
  | { code: 'period_year_mismatch'; period_end_date: string; payment_date: string }
  | { code: 'period_length_mismatch'; period_type: PayslipPeriod['period_type']; implied_days: number; expected_min_days: number; expected_max_days: number }
  | { code: 'deduction_miscategorized'; placement: 'pre_tax' | 'post_tax'; description: string; suggested_category: PreTaxDeductionCategory | PostTaxSocialCategory }
  | { code: 'totals_do_not_reconcile_net'; implied_net: number; printed_net: number; residual: number }
  | { code: 'totals_do_not_reconcile_payout'; implied_payout: number; printed_payout: number; residual: number };

/** Straight subtraction of printed/extracted figures, never the engine's own tax computation - a
 * tight tolerance is correct here (cent rounding across a handful of additions only), unlike
 * discrepancy.ts's tolerances, which exist to absorb stepwise TABLE-rounding noise that has no place
 * in a pure arithmetic identity between numbers the document itself printed. */
const RECONCILIATION_TOLERANCE = 0.05;

/** Far below even a single week's statutory minimum wage (~599 EUR at 14.99/h x 40h) - not a
 * legitimate low-earner zero, just a floor to skip degenerate near-zero taxable bases. */
const MEANINGFUL_TAXABLE_BASE = 10;

function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const PRE_TAX_KEYWORDS: Array<{ category: PreTaxDeductionCategory; pattern: RegExp }> = [
  { category: 'pension', pattern: /stipp|pensioen/ },
  { category: 'paww', pattern: /\bpaww\b/ },
  { category: 'ziektewet', pattern: /ziektewet|\bazw\b/ },
  { category: 'wga_gat', pattern: /wga-?gat/ },
];
const POST_TAX_KEYWORDS: Array<{ category: PostTaxSocialCategory; pattern: RegExp }> = [
  { category: 'whk', pattern: /\bwhk\b/ },
  { category: 'gediff_wga', pattern: /gedifferentieerde?\s*wga/ },
  { category: 'wga', pattern: /\bwga\b/ },
];

/** Best-effort: only fires when the document's own label prints an explicit two-date range (as
 * Olympia's did - "26-07-2025 t/m 08-09-2025"), never invented when the label is a plain "week
 * 36/2026"-style tag with no range to check. */
function parseDateRangeDays(label: string | null): number | null {
  if (!label) return null;
  const match = label.match(/(\d{1,2})-(\d{1,2})-(\d{4}).{0,15}?(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (!match) return null;
  const [, d1, m1, y1, d2, m2, y2] = match;
  const start = new Date(Number(y1), Number(m1) - 1, Number(d1));
  const end = new Date(Number(y2), Number(m2) - 1, Number(d2));
  const diffDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  return diffDays > 0 ? diffDays : null;
}

const PERIOD_LENGTH_BOUNDS: Record<PayslipPeriod['period_type'], { min: number; max: number }> = {
  week: { min: 5, max: 9 },
  '4-weekly': { min: 25, max: 31 },
  month: { min: 27, max: 32 },
};

function sumKnownAmounts(fields: Array<{ value: number | null }>): number | null {
  let total = 0;
  for (const field of fields) {
    if (field.value === null) return null; // an unknown deduction amount - cannot reconcile, never assumed zero
    total += field.value;
  }
  return total;
}

export function checkExtractionConsistency(
  paymentDate: string | null,
  period: PayslipPeriod,
  outcome: PayslipComputationOutcome,
): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  // 1. Zero tax on a non-zero taxable base (§Stage 2a: 844.92 taxable, printed 152.37, engine
  // computed 0.00 - the root symptom of the period misread, a check that needs no comparison to
  // discover it looks implausible on its own).
  const taxFields = outcome.status === 'complete' ? outcome.result : outcome;
  if (
    taxFields.taxable_base > MEANINGFUL_TAXABLE_BASE &&
    taxFields.table_tax_after_korting === 0 &&
    period.printed_table_tax !== null &&
    period.printed_table_tax > 0
  ) {
    issues.push({ code: 'zero_tax_nonzero_base', taxable_base: taxFields.taxable_base, printed_table_tax: period.printed_table_tax });
  }

  // 2a. Period year sanity: the payment date and the period's own end date must agree on the year -
  // Olympia printed a payment date of 08-09-2026 while the period was extracted with a 2025 end date.
  if (paymentDate && period.period_end_date) {
    const paymentYear = new Date(paymentDate).getFullYear();
    const periodYear = new Date(period.period_end_date).getFullYear();
    if (Number.isFinite(paymentYear) && Number.isFinite(periodYear) && paymentYear !== periodYear) {
      issues.push({ code: 'period_year_mismatch', period_end_date: period.period_end_date, payment_date: paymentDate });
    }
  }

  // 2b. Period length sanity: when the label prints an explicit date range, its span must be
  // plausible for the stated period_type - a week labelled as a 45-day span is exactly the failure
  // that annualised 885.50 into roughly 7000 and zeroed the computed tax.
  const impliedDays = parseDateRangeDays(period.period_label);
  if (impliedDays !== null) {
    const bounds = PERIOD_LENGTH_BOUNDS[period.period_type];
    if (impliedDays < bounds.min || impliedDays > bounds.max) {
      issues.push({ code: 'period_length_mismatch', period_type: period.period_type, implied_days: impliedDays, expected_min_days: bounds.min, expected_max_days: bounds.max });
    }
  }

  // 3. A pre-tax/post-tax deduction landing in 'other' when its own printed description matches a
  // known category keyword. Not a re-classifier - tier-c.ts's own mapping-gap note explains why
  // backend keyword-matching is deliberately NOT the primary classification path (diacritic drift
  // breaks naive string matching as a primary mechanism). This is only a backstop catching an obvious
  // miss, the same "structural bound catching a failure mode the primary path can't reach" shape as
  // 2.0b's contract plausibility bounds.
  for (const line of period.pre_tax_deductions) {
    if (line.category !== 'other') continue;
    const normalized = stripDiacritics(line.description);
    const match = PRE_TAX_KEYWORDS.find((k) => k.pattern.test(normalized));
    if (match) issues.push({ code: 'deduction_miscategorized', placement: 'pre_tax', description: line.description, suggested_category: match.category });
  }
  for (const line of period.post_tax_social) {
    if (line.category !== 'other') continue;
    const normalized = stripDiacritics(line.description);
    const match = POST_TAX_KEYWORDS.find((k) => k.pattern.test(normalized));
    if (match) issues.push({ code: 'deduction_miscategorized', placement: 'post_tax', description: line.description, suggested_category: match.category });
  }

  // 4a. The document's own totals must reconcile - the strongest check, needing nothing but the
  // extracted figures themselves: no engine tax computation, no comparison to what we computed.
  // gross (raw sum of hour_lines, no engine judgment) minus pre-tax deductions minus printed tax
  // minus post-tax deductions should equal the document's own printed net (Totaal netto, BEFORE net
  // additions/deductions/payout adjustments). This is exactly the arithmetic that would have caught
  // §Stage 2a's run alone: 885.50 - 39.69 (only 2 of 4 real deductions captured) - 152.37 - 0 =
  // 693.44, against a (also wrongly extracted) printed net of 776.09 - an ~83 EUR gap no rounding
  // tolerance could ever absorb.
  if (period.printed_net !== null) {
    const preTaxSum = sumKnownAmounts(period.pre_tax_deductions.map((d) => d.amount));
    const postTaxSum = sumKnownAmounts(period.post_tax_social.map((d) => d.amount));
    if (preTaxSum !== null && postTaxSum !== null) {
      const grossTotal = period.hour_lines.reduce((sum, line) => sum + line.amount, 0);
      const impliedNet = grossTotal - preTaxSum - (period.printed_table_tax ?? 0) - (period.printed_bt_tax ?? 0) - postTaxSum;
      const residual = Math.round((impliedNet - period.printed_net) * 100) / 100;
      if (Math.abs(residual) > RECONCILIATION_TOLERANCE) {
        issues.push({ code: 'totals_do_not_reconcile_net', implied_net: Math.round(impliedNet * 100) / 100, printed_net: period.printed_net, residual });
      }
    }
  }

  // 4b. Totaal netto -> Totaal: printed net plus net additions minus net deductions plus payout
  // adjustments should equal the final printed payout - exactly the distinction §Stage 2a's run
  // collapsed (both the net and payout figures came back identical, with the 90.00 travel
  // reimbursement that separates them missing from the extraction entirely).
  if (period.printed_net !== null && period.printed_payout !== null) {
    const additions = period.net_additions.reduce((sum, line) => sum + line.amount, 0);
    const deductions = period.net_deductions.reduce((sum, line) => sum + line.amount, 0);
    const payoutAdjustments = period.payout_adjustments.reduce((sum, line) => sum + line.amount, 0);
    const impliedPayout = period.printed_net + additions - deductions + payoutAdjustments;
    const residual = Math.round((impliedPayout - period.printed_payout) * 100) / 100;
    if (Math.abs(residual) > RECONCILIATION_TOLERANCE) {
      issues.push({ code: 'totals_do_not_reconcile_payout', implied_payout: Math.round(impliedPayout * 100) / 100, printed_payout: period.printed_payout, residual });
    }
  }

  return issues;
}
