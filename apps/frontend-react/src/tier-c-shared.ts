import { translations } from './translations.ts';

/**
 * Stage 2u (audit v53, §2u — auditor ruling on the in-round clarification): shared types and pure
 * correction logic for Tier C's `/analyze`/`/recompute` responses, used by BOTH `ProDocuments.tsx`
 * (the live, reachable PRO surface) and `TierCFlow.tsx` (kept for its own reusable logic and as
 * additional test coverage - confirmed unreachable from the running app: `App.tsx`'s own routing
 * mounts `ProDocuments` for the 'pro' tier and never imports `TierCFlow`, per that file's own doc
 * comment. Do not duplicate this logic in two places again - see the auditor's own ruling, quoted in
 * `RAPORT-wykonawca-2u.md`.
 */

export interface Field<T> { provenance: string; value: T | null }
export interface TierCHourLineResponse { description: string; hours: number | null; rate: number | null; percent: number | null; amount: number; category: string; tax_treatment: string; adds_hours: boolean }
export interface TierCDeductionResponse { category: string; description: string; amount: Field<number>; base: number | null; percent: number | null }
export interface TierCPostTaxResponse { category: string; description: string; amount: Field<number>; percent: number | null }
export interface TierCNetLineResponse { category: string; description: string; amount: number }
export interface TierCReservationResponse { type: string; opgebouwd_this_period: number; paid_out_this_period: number }
export interface EmployerResponse { name: string | null; franchise_bearing: boolean | 'unknown' }

export interface TierCPeriodResponse {
  period_label: string | null;
  period_type: 'week' | '4-weekly' | 'month';
  period_type_confirmed: boolean;
  period_end_date: string | null;
  is_correction: boolean;
  version: number;
  contract_hours: number | null;
  payout_adjustments: Array<{ description: string; amount: number }>;
  bijzonder_tarief: { jaarloon_bt: number | null; bt_state: 'known' | 'not_applicable' | 'unknown'; tarief_bt: { printed: number | null; computed: number | null } };
  et: { et_applicable: boolean; et_exchange_amount: number; et_reimbursements: Array<{ description: string; amount: number }>; adres_fiskalny: string | null } | null;
  employers: EmployerResponse[];
  hirer: { name: string | null } | null;
  hour_lines: TierCHourLineResponse[];
  pre_tax_deductions: TierCDeductionResponse[];
  post_tax_social: TierCPostTaxResponse[];
  net_additions: TierCNetLineResponse[];
  net_deductions: TierCNetLineResponse[];
  reservations: TierCReservationResponse[];
  wml_printed: number | null;
  wml_applicable: number | null;
  printed_table_tax: number | null;
  printed_bt_tax: number | null;
  printed_algemene_heffingskorting: number | null;
  printed_arbeidskorting: number | null;
  printed_net: number | null;
  printed_payout: number | null;
  printed_table_tax_label: string | null;
  printed_bt_tax_label: string | null;
  printed_algemene_heffingskorting_label: string | null;
  printed_arbeidskorting_label: string | null;
  printed_net_label: string | null;
  printed_payout_label: string | null;
}

export interface CompleteResult {
  gross_total: number; loon_voor_heffingen: number; taxable_base: number;
  table_tax_after_korting: number; bt_tax: number; total_tax: number;
  wage_net: number; net_additions_total: number; net_deductions_total: number;
  period_net: number; payout_amount: number;
}
export type Outcome = { status: 'complete'; result: CompleteResult } | { status: 'incomplete'; missing_fields: string[]; tax_is_upper_bound: boolean; gross_total: number; taxable_base: number; table_tax_after_korting: number; bt_tax: number; total_tax: number };

export type DiscrepancyCode = 'table_tax_mismatch' | 'bt_tax_mismatch' | 'algemene_heffingskorting_mismatch' | 'arbeidskorting_mismatch' | 'net_mismatch' | 'payout_mismatch' | 'minimum_wage_stale_on_document' | 'minimum_wage_violation';
export interface Discrepancy { code: DiscrepancyCode; computed: number | null; printed: number; residual: number | null; tolerance: number; confirmation_upper: number; status: 'confirm' | 'finding'; printed_label: string | null; related_to: DiscrepancyCode | null }

export type NetPosition = 'before_post_tax' | 'before' | 'after' | 'both' | 'none';
export type TextLayerStatus = 'ok' | 'too_large' | 'none';
export interface TechnicalDetails {
  text_items_sent: number;
  text_layer_status: TextLayerStatus;
  text_layer_source: 'client' | 'none';
  request_size_kb: number;
  request_size_source: 'content_length' | 'measured';
  render_step: string;
}

/** Stage 2b (audit v12): the pre-comparison consistency gate's issue shape, mirroring
 * extraction-consistency.ts's discriminated union exactly - codes plus numeric params, never a
 * prebaked sentence (§2.6). Every code below must have a case in `issueMessage` - the backend's own
 * "2f.9" test fails the backend suite if a code lacks a matching literal in `TierCFlow.tsx`'s source
 * (grepped directly, since there is no shared-types package between the two projects) - importing
 * this union from here rather than redeclaring it keeps that single source of truth. */
export type ConsistencyIssue =
  | { code: 'zero_tax_nonzero_base'; taxable_base: number; printed_table_tax: number }
  | { code: 'period_year_mismatch'; period_end_date: string; payment_date: string }
  | { code: 'period_length_mismatch'; period_type: 'week' | '4-weekly' | 'month'; implied_days: number; expected_min_days: number; expected_max_days: number }
  | { code: 'period_week_mismatch'; label_week: number; label_year: number; end_date_week: number; end_date_year: number }
  | { code: 'deduction_miscategorized'; placement: 'pre_tax' | 'post_tax'; description: string; suggested_category: string }
  | { code: 'gross_lines_do_not_reconcile'; summed_gross: number; printed_gross_total: number; residual: number }
  | { code: 'pre_tax_does_not_reconcile'; implied_loon_voor_heffingen: number; printed_loon_voor_heffingen: number; residual: number }
  | { code: 'net_does_not_reconcile'; implied_net: number; printed_net: number; residual: number }
  | { code: 'printed_tax_unknown' }
  | { code: 'printed_subtotal_role_unresolved'; printed_subtotal: number; gross_hypothesis: number; loon_voor_heffingen_hypothesis: number | null }
  | { code: 'anchors_inverted'; printed_gross_total: number; printed_loon_voor_heffingen: number }
  | { code: 'totals_do_not_reconcile_net'; implied_net: number; printed_net: number; residual: number }
  | { code: 'totals_do_not_reconcile_payout'; implied_payout: number; printed_payout: number; residual: number }
  | { code: 'printed_tax_bases_do_not_reconcile'; implied_total: number; printed_total: number; residual: number }
  | { code: 'et_reduction_reimbursement_mismatch'; et_exchange_amount: number; reimbursements_sum: number; residual: number }
  | { code: 'net_position_unconfirmed'; printed_net: number; post_tax_sum: number }
  | { code: 'pre_tax_unknown' }
  | { code: 'pre_tax_not_confirmed' }
  | { code: 'period_type_unknown' }
  | { code: 'et_exchange_amount_unknown' }
  | { code: 'amount_unreadable'; field: string };

export type TierCCopy = (typeof translations)['pl']['tierC'];

export function money(value: number): string {
  return `€${value.toFixed(2)}`;
}

export function provenanceLabel(t: TierCCopy, provenance: string): string {
  if (provenance === 'payslip_extracted' || provenance === 'user_entered') return t.provenancePayslip;
  if (provenance === 'estimated') return t.provenanceEstimated;
  return provenance;
}

/** Stage 2b: builds each consistency issue's sentence from its code + numeric params, per §2.6 -
 * the backend never sends prose, only the discriminated union extraction-consistency.ts defines. */
export function issueMessage(t: TierCCopy, issue: ConsistencyIssue): string {
  switch (issue.code) {
    case 'zero_tax_nonzero_base':
      return t.issueZeroTax(money(issue.taxable_base), money(issue.printed_table_tax));
    case 'period_year_mismatch':
      return t.issuePeriodYear(issue.period_end_date, issue.payment_date);
    case 'period_length_mismatch':
      return t.issuePeriodLength(issue.implied_days, issue.expected_min_days, issue.expected_max_days);
    case 'period_week_mismatch':
      return t.issuePeriodWeek(issue.label_week, issue.label_year, issue.end_date_week, issue.end_date_year);
    case 'deduction_miscategorized':
      return t.issueDeductionMiscategorized(issue.description, issue.suggested_category);
    case 'gross_lines_do_not_reconcile':
      return t.issueGrossReconcile(money(issue.summed_gross), money(issue.printed_gross_total), money(issue.residual));
    case 'pre_tax_does_not_reconcile':
      return t.issuePreTaxReconcile(money(issue.implied_loon_voor_heffingen), money(issue.printed_loon_voor_heffingen), money(issue.residual));
    case 'net_does_not_reconcile':
      return t.issueNetReconcile(money(issue.implied_net), money(issue.printed_net), money(issue.residual));
    case 'printed_tax_unknown':
      return t.issuePrintedTaxUnknown;
    case 'printed_subtotal_role_unresolved':
      return t.issueSubtotalRoleUnresolved(money(issue.printed_subtotal), money(issue.gross_hypothesis), issue.loon_voor_heffingen_hypothesis === null ? t.traceUnknown : money(issue.loon_voor_heffingen_hypothesis));
    case 'anchors_inverted':
      return t.issueAnchorsInverted(money(issue.printed_gross_total), money(issue.printed_loon_voor_heffingen));
    case 'totals_do_not_reconcile_net':
      return t.issueTotalsNet(money(issue.implied_net), money(issue.printed_net), money(issue.residual));
    case 'totals_do_not_reconcile_payout':
      return t.issueTotalsPayout(money(issue.implied_payout), money(issue.printed_payout), money(issue.residual));
    case 'printed_tax_bases_do_not_reconcile':
      return t.issueTaxBasesReconcile(money(issue.implied_total), money(issue.printed_total), money(issue.residual));
    case 'et_reduction_reimbursement_mismatch':
      return t.issueEtReductionMismatch(money(issue.et_exchange_amount), money(issue.reimbursements_sum), money(issue.residual));
    case 'net_position_unconfirmed':
      return t.issueNetPositionUnconfirmed(money(issue.printed_net), money(issue.post_tax_sum));
    case 'pre_tax_unknown':
      return t.issuePreTaxUnknown;
    case 'pre_tax_not_confirmed':
      return t.issuePreTaxNotConfirmed;
    case 'period_type_unknown':
      return t.issuePeriodTypeUnknown;
    case 'et_exchange_amount_unknown':
      return t.issueEtExchangeUnknown;
    case 'amount_unreadable':
      return t.issueAmountUnreadable(issue.field);
  }
}

/**
 * Stage 2u (§2u.2): generalized from a per-CODE static map to a per-ISSUE field PATH, since
 * `amount_unreadable` names a different line on every occurrence (several can coexist in one
 * `needsConfirmation` list) - the path itself already identifies the exact line to correct, on the
 * SAME `PayslipPeriod` shape `/recompute` takes (the backend remaps a raw-extraction path to this one
 * before it ever reaches here - see `tier-c.ts`'s own `remapUnreadableFieldToPeriodPath`).
 *
 * v17: zero_tax_nonzero_base and every other diagnosis-only code (period shape, category) are
 * deliberately NOT here, unchanged reasoning from before this stage: on the live Olympia run,
 * printed_table_tax was already read correctly - the zero came from the ENGINE's own computation
 * (driven by a misread period), which a printed_table_tax correction cannot touch. Offering that
 * input implied a fix path that does nothing. Diagnosis only, until the period itself grows a
 * correctable field for it.
 */
export function correctableFieldPath(issue: ConsistencyIssue): string | null {
  switch (issue.code) {
    case 'totals_do_not_reconcile_net': return 'printed_net';
    case 'totals_do_not_reconcile_payout': return 'printed_payout';
    case 'et_exchange_amount_unknown': return 'et.et_exchange_amount';
    case 'amount_unreadable': return issue.field;
    default: return null;
  }
}

const HOUR_LINE_AMOUNT_PATH = /^hour_lines\[(\d+)\]\.amount$/;
const NET_ADDITION_AMOUNT_PATH = /^net_additions\[(\d+)\]\.amount$/;
const NET_DEDUCTION_AMOUNT_PATH = /^net_deductions\[(\d+)\]\.amount$/;
const PAYOUT_ADJUSTMENT_AMOUNT_PATH = /^payout_adjustments\[(\d+)\]\.amount$/;
const RESERVATION_ACCRUED_PATH = /^reservations\[(\d+)\]\.opgebouwd_this_period$/;
const RESERVATION_PAID_OUT_PATH = /^reservations\[(\d+)\]\.paid_out_this_period$/;

/** The line's own printed description/type, read off the period by the SAME path vocabulary
 * `getPeriodFieldByPath`/`setPeriodFieldByPath` below use - `null` when the path names something with
 * no separate label of its own (`et.et_exchange_amount`, the two top-level printed_* fields). */
export function describePeriodFieldPath(period: TierCPeriodResponse, path: string): string | null {
  let m: RegExpExecArray | null;
  if ((m = HOUR_LINE_AMOUNT_PATH.exec(path))) return period.hour_lines[Number(m[1])]?.description || null;
  if ((m = NET_ADDITION_AMOUNT_PATH.exec(path))) return period.net_additions[Number(m[1])]?.description || null;
  if ((m = NET_DEDUCTION_AMOUNT_PATH.exec(path))) return period.net_deductions[Number(m[1])]?.description || null;
  if ((m = PAYOUT_ADJUSTMENT_AMOUNT_PATH.exec(path))) return period.payout_adjustments[Number(m[1])]?.description || null;
  if ((m = RESERVATION_ACCRUED_PATH.exec(path))) return period.reservations[Number(m[1])]?.type || null;
  if ((m = RESERVATION_PAID_OUT_PATH.exec(path))) return period.reservations[Number(m[1])]?.type || null;
  return null;
}

/** The line's own name, as printed where available (v17: "a user cannot correct a value they cannot
 * see") - generalized to read off the PERIOD itself by path, since `amount_unreadable` names a
 * different line every time. */
export function correctableLineLabel(t: TierCCopy, period: TierCPeriodResponse, issue: ConsistencyIssue): string {
  if (issue.code === 'totals_do_not_reconcile_net') return t.codeNet;
  if (issue.code === 'totals_do_not_reconcile_payout') return t.codePayout;
  if (issue.code === 'et_exchange_amount_unknown') return t.fieldEtExchangeAmount;
  if (issue.code === 'amount_unreadable') return describePeriodFieldPath(period, issue.field) ?? t.codeAmountGeneric;
  return '';
}

/** As-printed Dutch label, when the document had one - only meaningful for the two printed_*
 * reconciliation issues (an arbitrary line has no separate "as-printed label" field to read). */
export function correctablePrintedLabel(period: TierCPeriodResponse, issue: ConsistencyIssue): string | null {
  if (issue.code === 'totals_do_not_reconcile_net') return period.printed_net_label;
  if (issue.code === 'totals_do_not_reconcile_payout') return period.printed_payout_label;
  return null;
}

/** The value the extraction actually read for the correctable field - what the correction input is
 * meant to replace. `null` for `et_exchange_amount_unknown`/`amount_unreadable`: §2.3, nothing was
 * genuinely read for either, so there is no read value to show or to Confirm as correct - only
 * Correct (a numeric input) ever applies to these two. */
export function correctableReadValue(issue: ConsistencyIssue): number | null {
  switch (issue.code) {
    case 'totals_do_not_reconcile_net': return issue.printed_net;
    case 'totals_do_not_reconcile_payout': return issue.printed_payout;
    default: return null;
  }
}

/** What the rest of the payslip's own figures imply this value should be - the arithmetic already
 * computed by extraction-consistency.ts, shown so the user can compare it against what they see
 * printed rather than guessing what number would satisfy the app. */
export function correctableExpectedValue(issue: ConsistencyIssue): number | null {
  switch (issue.code) {
    case 'totals_do_not_reconcile_net': return issue.implied_net;
    case 'totals_do_not_reconcile_payout': return issue.implied_payout;
    default: return null;
  }
}

/** Stage 2u (§2u.2): the generic period-field reader every correction (needsConfirmation OR a Stage-1
 * discrepancy) now goes through, by PATH rather than a single static `keyof TierCPeriodResponse` - the
 * vocabulary matches exactly what `tier-c.ts`'s own `remapUnreadableFieldToPeriodPath` produces
 * server-side, so a path received from the backend always resolves here without a separate
 * translation step. */
export function getPeriodFieldByPath(period: TierCPeriodResponse, path: string): number | null {
  let m: RegExpExecArray | null;
  if ((m = HOUR_LINE_AMOUNT_PATH.exec(path))) return period.hour_lines[Number(m[1])]?.amount ?? null;
  if ((m = NET_ADDITION_AMOUNT_PATH.exec(path))) return period.net_additions[Number(m[1])]?.amount ?? null;
  if ((m = NET_DEDUCTION_AMOUNT_PATH.exec(path))) return period.net_deductions[Number(m[1])]?.amount ?? null;
  if ((m = PAYOUT_ADJUSTMENT_AMOUNT_PATH.exec(path))) return period.payout_adjustments[Number(m[1])]?.amount ?? null;
  if ((m = RESERVATION_ACCRUED_PATH.exec(path))) return period.reservations[Number(m[1])]?.opgebouwd_this_period ?? null;
  if ((m = RESERVATION_PAID_OUT_PATH.exec(path))) return period.reservations[Number(m[1])]?.paid_out_this_period ?? null;
  if (path === 'et.et_exchange_amount') return period.et?.et_exchange_amount ?? null;
  if (path === 'printed_net') return period.printed_net;
  if (path === 'printed_payout') return period.printed_payout;
  return null;
}

export function setPeriodFieldByPath(period: TierCPeriodResponse, path: string, value: number): TierCPeriodResponse {
  let m: RegExpExecArray | null;
  if ((m = HOUR_LINE_AMOUNT_PATH.exec(path))) {
    const i = Number(m[1]);
    return { ...period, hour_lines: period.hour_lines.map((l, idx) => (idx === i ? { ...l, amount: value } : l)) };
  }
  if ((m = NET_ADDITION_AMOUNT_PATH.exec(path))) {
    const i = Number(m[1]);
    return { ...period, net_additions: period.net_additions.map((l, idx) => (idx === i ? { ...l, amount: value } : l)) };
  }
  if ((m = NET_DEDUCTION_AMOUNT_PATH.exec(path))) {
    const i = Number(m[1]);
    return { ...period, net_deductions: period.net_deductions.map((l, idx) => (idx === i ? { ...l, amount: value } : l)) };
  }
  if ((m = PAYOUT_ADJUSTMENT_AMOUNT_PATH.exec(path))) {
    const i = Number(m[1]);
    return { ...period, payout_adjustments: period.payout_adjustments.map((l, idx) => (idx === i ? { ...l, amount: value } : l)) };
  }
  if ((m = RESERVATION_ACCRUED_PATH.exec(path))) {
    const i = Number(m[1]);
    return { ...period, reservations: period.reservations.map((r, idx) => (idx === i ? { ...r, opgebouwd_this_period: value } : r)) };
  }
  if ((m = RESERVATION_PAID_OUT_PATH.exec(path))) {
    const i = Number(m[1]);
    return { ...period, reservations: period.reservations.map((r, idx) => (idx === i ? { ...r, paid_out_this_period: value } : r)) };
  }
  if (path === 'et.et_exchange_amount' && period.et) {
    return { ...period, et: { ...period.et, et_exchange_amount: value } };
  }
  if (path === 'printed_net' || path === 'printed_payout') {
    return { ...period, [path]: value };
  }
  return period; // unrecognised path - should not happen given correctableFieldPath's own vocabulary
}

/** Stable per-issue key: `amount_unreadable` can appear several times in one `needsConfirmation` list
 * (one per unread field), so `code` alone is not unique - every other code appears at most once. */
export function issueKey(issue: ConsistencyIssue): string {
  return issue.code === 'amount_unreadable' ? `amount_unreadable:${issue.field}` : issue.code;
}

/** Stage 2u (audit v53, §2u.1/§2u.3): the issues still OPEN for a payslip - the raw `needsConfirmation`
 * list minus whatever the user has already client-side Confirmed (`confirmedIssueKeys`, keyed by
 * `issueKey`). Drives both the provisional/compact-status wording and `isPayslipFullyReproduced`
 * below - the two must never compute this differently, since a payslip should never be shown as
 * provisional in one place and eligible for the PRO projection in another. */
export function openNeedsConfirmation(needsConfirmation: ConsistencyIssue[], confirmedIssueKeys: ReadonlySet<string>): ConsistencyIssue[] {
  return needsConfirmation.filter((issue) => !confirmedIssueKeys.has(issueKey(issue)));
}

/** Spec §5's own exact rule, operationalised: "a payslip that failed verification is never used as a
 * parameter source, however recent." The consistency gate passed (there IS a computed `outcome` at
 * all - callers only reach this once that is true) AND every discrepancy AND every needsConfirmation
 * item is resolved (raised, then confirmed or corrected away) - not merely a clean-looking read that
 * still has an open question. */
export function isPayslipFullyReproduced(discrepancyCount: number, needsConfirmation: ConsistencyIssue[], confirmedIssueKeys: ReadonlySet<string>): boolean {
  return discrepancyCount === 0 && openNeedsConfirmation(needsConfirmation, confirmedIssueKeys).length === 0;
}

/** Every OTHER `amount_unreadable` field still outstanding in a `needsConfirmation` list - the
 * `flaggedFieldPaths` a correction must still name so /recompute keeps refusing to silently trust
 * them, per 2m.1/2p.5 (carried forward unchanged - §2u.2). `except` excludes the one path being
 * resolved by the current call, if any. */
export function outstandingAmountUnreadablePaths(needsConfirmation: ConsistencyIssue[], except?: string): string[] {
  return needsConfirmation
    .filter((i): i is Extract<ConsistencyIssue, { code: 'amount_unreadable' }> => i.code === 'amount_unreadable' && i.field !== except)
    .map((i) => i.field);
}

export interface RecomputeOkResult {
  status: 'ok';
  period: TierCPeriodResponse;
  outcome: Outcome;
  discrepancies: Discrepancy[];
  net_position: NetPosition;
  technicalDetails: TechnicalDetails;
  needsConfirmation: ConsistencyIssue[];
  taxRatesSource: 'database' | 'static';
}
export interface RecomputeBlockedResult {
  status: 'unreliable';
  period: TierCPeriodResponse;
  issues: ConsistencyIssue[];
}

/**
 * Stage 2u (§2u.2): the one function every correction path (a Stage-1 discrepancy correction, or a
 * `needsConfirmation` confirm/correct) goes through to call `/recompute` - shared so the two surfaces
 * (`ProDocuments.tsx`, `TierCFlow.tsx`) and the two correction kinds within each can never drift into
 * two different request shapes or error-handling paths.
 */
export async function recomputeWithPathCorrection(period: TierCPeriodResponse, path: string, value: number, flaggedFieldPaths: string[]): Promise<RecomputeOkResult | RecomputeBlockedResult> {
  const correctedPeriod = setPeriodFieldByPath(period, path, value);
  const res = await fetch('/api/tier-c/recompute', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: correctedPeriod, flaggedFieldPaths }),
  });
  const data = await res.json() as { status?: 'ok' | 'unreliable'; outcome?: Outcome; discrepancies?: Discrepancy[]; net_position?: NetPosition; technicalDetails?: TechnicalDetails; needsConfirmation?: ConsistencyIssue[]; issues?: ConsistencyIssue[]; taxRatesSource?: 'database' | 'static' };
  if (!res.ok || !data.status) throw new Error('recompute_failed');
  if (data.status === 'unreliable') {
    if (!data.issues) throw new Error('recompute_failed');
    return { status: 'unreliable', period: correctedPeriod, issues: data.issues };
  }
  if (!data.outcome || !data.discrepancies || !data.taxRatesSource || !data.net_position || !data.technicalDetails) throw new Error('recompute_failed');
  return { status: 'ok', period: correctedPeriod, outcome: data.outcome, discrepancies: data.discrepancies, net_position: data.net_position, technicalDetails: data.technicalDetails, needsConfirmation: data.needsConfirmation ?? [], taxRatesSource: data.taxRatesSource };
}
