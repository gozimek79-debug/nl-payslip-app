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
  | { code: 'period_week_mismatch'; label_week: number; label_year: number; end_date_week: number; end_date_year: number }
  | { code: 'deduction_miscategorized'; placement: 'pre_tax' | 'post_tax'; description: string; suggested_category: PreTaxDeductionCategory | PostTaxSocialCategory }
  // Stage 2e (audit v24, §2e.3): the two-step "document's own arithmetic" check the original stage
  // 2b spec asked for, restored - the review found it had collapsed into one combined identity
  // (totals_do_not_reconcile_net below, kept for the payout-adjustment shape only). Each stage
  // compares two numbers the document itself printed, nothing the engine computed, and names which
  // specific stage broke rather than reporting one combined residual across the whole chain.
  | { code: 'gross_lines_do_not_reconcile'; summed_gross: number; printed_gross_total: number; residual: number }
  | { code: 'pre_tax_does_not_reconcile'; implied_loon_voor_heffingen: number; printed_loon_voor_heffingen: number; residual: number }
  | { code: 'net_does_not_reconcile'; implied_net: number; printed_net: number; residual: number }
  // §2.1: a reconciliation stage that needs a printed tax figure the document should have but the
  // extraction did not capture - never silently treated as a 0 tax charge (which would make an
  // under-read look like it reconciles). Distinct from zero_tax_nonzero_base, which fires when tax
  // WAS read as a literal 0 against a nonzero base; this fires when tax was not read at all.
  | { code: 'printed_tax_unknown' }
  | { code: 'totals_do_not_reconcile_net'; implied_net: number; printed_net: number; residual: number }
  | { code: 'totals_do_not_reconcile_payout'; implied_payout: number; printed_payout: number; residual: number }
  // Stage 2e (§2e.5): tier-c.ts previously defaulted an unread period_type to 'week' and an unread
  // et_exchange_amount to 0 - both silent, both consequential (a monthly slip taxed as weekly; an ET
  // base reduction silently dropped). Raised by the controller (it alone has the raw TierCExtraction
  // needed to tell "genuinely absent" from "read as zero/week") as a blocking gap, never a default.
  | { code: 'period_type_unknown' }
  | { code: 'et_exchange_amount_unknown' };

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
  // "gediff." is the common printed abbreviation of "gedifferentieerde" (PKF's real document) - the
  // original pattern only matched the unabbreviated word and would have silently fallen through to
  // the plain \bwga\b pattern below, misclassifying it as 'wga'. Found while wiring 2e.4's
  // deterministic override, which made this list authoritative rather than a backstop.
  { category: 'gediff_wga', pattern: /gediff\.?\w*\s*wga/ },
  { category: 'wga', pattern: /\bwga\b/ },
];

/**
 * Stage 2e (audit v24, §2e.4): "the label decides for known families... the model's category is
 * advisory." These are now the SOLE source of truth for the four known deduction families - called
 * from tier-c.ts's mapping layer to OVERRIDE whatever category the extraction itself proposed, not
 * merely to flag a mismatch afterward (which is all the check below ever did). A label matching no
 * keyword returns null; the caller falls back to 'other' - never a guess, never the model's own
 * unverified category for a label these keywords don't recognise.
 */
export function classifyPreTaxDeductionLabel(description: string): PreTaxDeductionCategory | null {
  const normalized = stripDiacritics(description);
  return PRE_TAX_KEYWORDS.find((k) => k.pattern.test(normalized))?.category ?? null;
}
export function classifyPostTaxDeductionLabel(description: string): PostTaxSocialCategory | null {
  const normalized = stripDiacritics(description);
  return POST_TAX_KEYWORDS.find((k) => k.pattern.test(normalized))?.category ?? null;
}

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

/**
 * Stage 2e (audit v24, §2e.6): "a label such as `week 36/2026` is compared with the date span; today
 * it is explicitly not flagged." parseDateRangeDays above only handles an explicit two-date range
 * (Olympia's original bug); it never looks at a bare week-number label at all. This is the missing
 * comparison: only matches the unambiguous "small number / four-digit year" shape (week then year,
 * confirmed against both Olympia "week 36/2026" -> period_end_date 2026-09-06, and OTTO "33/2025" ->
 * 2025-08-17 - both land inside the computed ISO week exactly). Randstad's real label ("week 2026-11",
 * year-first) deliberately does NOT match this pattern - its actual semantics were not confirmed
 * against the source document this round (§2.2: check, don't guess), so it stays unparsed and
 * unflagged rather than risk a wrong comparison on an assumed order.
 */
function isoWeekOf(date: Date): { week: number; year: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { week, year: d.getUTCFullYear() };
}

function parseWeekLabel(label: string | null): { week: number; year: number } | null {
  if (!label) return null;
  const match = label.match(/\b(\d{1,2})\s*\/\s*(\d{4})\b/);
  if (!match) return null;
  const week = Number(match[1]);
  const year = Number(match[2]);
  if (week < 1 || week > 53) return null;
  return { week, year };
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

/**
 * §2.1/2e.5: printed_table_tax is never legitimately absent from a real payslip (every document with
 * a table-taxed wage prints a loonheffing figure, even 0.00 for a genuine zero-tax case) - a null
 * here is always a genuine extraction gap, never treated as 0. printed_bt_tax is different: it is
 * legitimately absent whenever no BT-taxed line exists at all (bt_state 'not_applicable'), in which
 * case 0 is the correct, non-guessed value - only 'known'/'unknown' bt_state paired with a null
 * printed_bt_tax is a genuine gap.
 */
function resolveBtTaxComponent(period: PayslipPeriod): number | null {
  if (period.bijzonder_tarief.bt_state === 'not_applicable') return 0;
  return period.printed_bt_tax;
}

/**
 * Stage 2d (audit v19, §2d.1): "the blocking panel must show what it read." Until now, a gate firing
 * told the user (and the owner, debugging live) only that something didn't add up - not which lines
 * were read, what they were categorized as, or where in the gross-to-net chain the arithmetic broke.
 * This is that trace: the SAME figures checkExtractionConsistency already computes internally,
 * returned regardless of which specific check fired, so the panel can show the full chain every time,
 * not just the one step that happened to trip a threshold. Pure and side-effect-free, like the check
 * function itself - the interface builds sentences from this, per §2.6, this file only supplies codes
 * and numbers.
 */
export interface ExtractionTraceLine {
  label: string;
  category: string;
  amount: number | null;
  provenance: string;
}

export interface ExtractionTrace {
  hour_lines: ExtractionTraceLine[];
  gross_total: number;
  printed_gross_total: number | null;
  pre_tax_deductions: ExtractionTraceLine[];
  pre_tax_deductions_sum: number | null;
  loon_voor_heffingen: number | null;
  printed_loon_voor_heffingen: number | null;
  printed_table_tax: number | null;
  printed_bt_tax: number | null;
  computed_taxable_base: number;
  computed_table_tax_after_korting: number;
  post_tax_social: ExtractionTraceLine[];
  post_tax_deductions_sum: number | null;
  implied_net: number | null;
  printed_net: number | null;
  net_additions: ExtractionTraceLine[];
  net_deductions: ExtractionTraceLine[];
  implied_payout: number | null;
  printed_payout: number | null;
}

function traceLine(description: string, category: string, amount: number | null, provenance = 'payslip_extracted'): ExtractionTraceLine {
  return { label: description, category, amount, provenance };
}

export function buildExtractionTrace(period: PayslipPeriod, outcome: PayslipComputationOutcome): ExtractionTrace {
  const grossTotal = period.hour_lines.reduce((sum, line) => sum + line.amount, 0);
  const preTaxLines = period.pre_tax_deductions.map((d) => traceLine(d.description, d.category, d.amount.value, d.amount.provenance));
  const preTaxSum = sumKnownAmounts(period.pre_tax_deductions.map((d) => d.amount));
  const postTaxLines = period.post_tax_social.map((d) => traceLine(d.description, d.category, d.amount.value, d.amount.provenance));
  const postTaxSum = sumKnownAmounts(period.post_tax_social.map((d) => d.amount));
  const loonVoorHeffingen = preTaxSum !== null ? Math.round((grossTotal - preTaxSum) * 100) / 100 : null;
  const tableTax = period.printed_table_tax; // never defaulted - see resolveBtTaxComponent's doc comment
  const btTax = resolveBtTaxComponent(period);
  const impliedNet =
    preTaxSum !== null && postTaxSum !== null && tableTax !== null && btTax !== null
      ? Math.round((grossTotal - preTaxSum - tableTax - btTax - postTaxSum) * 100) / 100
      : null;
  const netAdditionsSum = period.net_additions.reduce((sum, l) => sum + l.amount, 0);
  const netDeductionsSum = period.net_deductions.reduce((sum, l) => sum + l.amount, 0);
  const payoutAdjustmentsSum = period.payout_adjustments.reduce((sum, l) => sum + l.amount, 0);
  const impliedPayout = period.printed_net !== null ? Math.round((period.printed_net + netAdditionsSum - netDeductionsSum + payoutAdjustmentsSum) * 100) / 100 : null;
  const taxFields = outcome.status === 'complete' ? outcome.result : outcome;

  return {
    hour_lines: period.hour_lines.map((l) => traceLine(l.description, l.category, l.amount)),
    gross_total: Math.round(grossTotal * 100) / 100,
    printed_gross_total: period.printed_gross_total,
    pre_tax_deductions: preTaxLines,
    pre_tax_deductions_sum: preTaxSum,
    loon_voor_heffingen: loonVoorHeffingen,
    printed_loon_voor_heffingen: period.printed_loon_voor_heffingen,
    printed_table_tax: period.printed_table_tax,
    printed_bt_tax: period.printed_bt_tax,
    computed_taxable_base: taxFields.taxable_base,
    computed_table_tax_after_korting: taxFields.table_tax_after_korting,
    post_tax_social: postTaxLines,
    post_tax_deductions_sum: postTaxSum,
    implied_net: impliedNet,
    printed_net: period.printed_net,
    net_additions: period.net_additions.map((l) => traceLine(l.description, l.category, l.amount)),
    net_deductions: period.net_deductions.map((l) => traceLine(l.description, l.category, l.amount)),
    implied_payout: impliedPayout,
    printed_payout: period.printed_payout,
  };
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

  // 2c. Stage 2e (§2e.6): a bare week-number label ("week 36/2026") checked against the period's own
  // end date, via ISO week number - the comparison 2b's date-range check could never make since it
  // only fires on an explicit two-date range.
  const labelWeek = parseWeekLabel(period.period_label);
  if (labelWeek !== null && period.period_end_date) {
    const endDate = new Date(period.period_end_date);
    if (!Number.isNaN(endDate.getTime())) {
      const actual = isoWeekOf(endDate);
      if (actual.week !== labelWeek.week || actual.year !== labelWeek.year) {
        issues.push({ code: 'period_week_mismatch', label_week: labelWeek.week, label_year: labelWeek.year, end_date_week: actual.week, end_date_year: actual.year });
      }
    }
  }

  // 3. A pre-tax/post-tax deduction landing in 'other' when its own printed description matches a
  // known category keyword. Stage 2e (§2e.4) made classifyPreTaxDeductionLabel/
  // classifyPostTaxDeductionLabel the AUTHORITATIVE classifier at tier-c.ts's mapping layer (the
  // model's own category is now advisory only, overridden there) - for Tier C's own pipeline this
  // check is now normally dormant, since a line reaching this function already carries the
  // deterministic category. Left in place as a backstop for any OTHER caller that builds a
  // PayslipPeriod directly without going through that mapping (a future integration, a hand-built
  // period) - the same "structural bound catching a failure mode the primary path can't reach" shape
  // as 2.0b's contract plausibility bounds.
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

  // 4. The document's own totals must reconcile - needing nothing but the extracted figures
  // themselves: no engine tax computation, no comparison to what we computed. Stage 2e (§2e.3):
  // restored to the two-step, stage-named check the original spec asked for, using the document's OWN
  // printed subtotals (printed_gross_total, printed_loon_voor_heffingen) as anchors when the
  // extraction captured them - this localises exactly which link in the chain broke, rather than one
  // combined residual across the whole thing. Falls back to the older single-identity check (deriving
  // gross from hour_lines directly) only when those two anchors were not captured - the two paths
  // never fire for the same period.
  const grossTotal = period.hour_lines.reduce((sum, line) => sum + line.amount, 0);
  const preTaxSumForReconciliation = sumKnownAmounts(period.pre_tax_deductions.map((d) => d.amount));
  const postTaxSumForReconciliation = sumKnownAmounts(period.post_tax_social.map((d) => d.amount));

  if (period.printed_gross_total !== null && period.printed_loon_voor_heffingen !== null) {
    // Stage 1: sum(gross lines) vs the document's own printed gross total.
    const grossResidual = Math.round((grossTotal - period.printed_gross_total) * 100) / 100;
    if (Math.abs(grossResidual) > RECONCILIATION_TOLERANCE) {
      issues.push({ code: 'gross_lines_do_not_reconcile', summed_gross: Math.round(grossTotal * 100) / 100, printed_gross_total: period.printed_gross_total, residual: grossResidual });
    }

    // Stage 2: printed gross total minus pre-tax deductions vs the document's own printed loon voor
    // heffingen. Uses the PRINTED gross (not the possibly-wrong summed gross) as the stage-2 base, so
    // a stage-1 failure does not also mask or distort stage 2 - each stage checks its own link only.
    if (preTaxSumForReconciliation !== null) {
      const impliedLoonVoorHeffingen = period.printed_gross_total - preTaxSumForReconciliation;
      const preTaxResidual = Math.round((impliedLoonVoorHeffingen - period.printed_loon_voor_heffingen) * 100) / 100;
      if (Math.abs(preTaxResidual) > RECONCILIATION_TOLERANCE) {
        issues.push({ code: 'pre_tax_does_not_reconcile', implied_loon_voor_heffingen: Math.round(impliedLoonVoorHeffingen * 100) / 100, printed_loon_voor_heffingen: period.printed_loon_voor_heffingen, residual: preTaxResidual });
      }
    }

    // Stage 3: printed loon voor heffingen minus tax minus post-tax vs the document's own printed net.
    if (period.printed_net !== null && postTaxSumForReconciliation !== null) {
      const tableTax = period.printed_table_tax;
      const btTax = resolveBtTaxComponent(period);
      if (tableTax === null || btTax === null) {
        issues.push({ code: 'printed_tax_unknown' });
      } else {
        const impliedNet = period.printed_loon_voor_heffingen - tableTax - btTax - postTaxSumForReconciliation;
        const netResidual = Math.round((impliedNet - period.printed_net) * 100) / 100;
        if (Math.abs(netResidual) > RECONCILIATION_TOLERANCE) {
          issues.push({ code: 'net_does_not_reconcile', implied_net: Math.round(impliedNet * 100) / 100, printed_net: period.printed_net, residual: netResidual });
        }
      }
    }
  } else if (period.printed_net !== null && preTaxSumForReconciliation !== null && postTaxSumForReconciliation !== null) {
    const tableTax = period.printed_table_tax;
    const btTax = resolveBtTaxComponent(period);
    if (tableTax === null || btTax === null) {
      issues.push({ code: 'printed_tax_unknown' });
    } else {
      const impliedNet = grossTotal - preTaxSumForReconciliation - tableTax - btTax - postTaxSumForReconciliation;
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
