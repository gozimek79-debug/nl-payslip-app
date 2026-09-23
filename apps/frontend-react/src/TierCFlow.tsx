import { useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, HelpCircle, ShieldCheck, Upload } from 'lucide-react';
import { renderPageImages, extractTextItems } from './local-ocr.ts';
import { StepProgress } from './StepProgress.tsx';
import { translations, type Lang } from './translations.ts';

/**
 * Tier C - "PRO" (SPEC-loonto-architecture.md §5, audit "CONSOLIDATED ASSIGNMENT" round, Stage 2 -
 * "wire the engine, build the panel"). Replaces App.tsx's entire old PRO flow (upload / manual-OCR
 * review / arithmetic-only result / "full analysis" result) - all of it retired this round, along
 * with the /api/payslips/analyze-full route, full-payslip.ts, and PayslipUploader.tsx.
 *
 * This is the FIRST real consumer of payslip-model.ts's actual engine + discrepancy.ts's Stage 1
 * classifier for a live payslip upload. It is verification only - Tier C's forward-projection
 * promise (spec §5's "if I work 60 hours next week...") is Stage 3, not built here. What ships this
 * round: upload a real payslip, get the full computed chain (same shape Tier A renders), the
 * discrepancy list with Stage 1's three-band classification, and the confirm/correct interaction
 * that classification implies.
 */

type UploadState = 'idle' | 'uploading' | 'error';

interface Field<T> { provenance: string; value: T | null }
interface TierCHourLineResponse { description: string; hours: number | null; rate: number | null; percent: number | null; amount: number; category: string; tax_treatment: string }
interface TierCDeductionResponse { category: string; description: string; amount: Field<number>; base: number | null; percent: number | null }
interface TierCPostTaxResponse { category: string; description: string; amount: Field<number>; percent: number | null }
interface TierCNetLineResponse { category: string; description: string; amount: number }
interface TierCReservationResponse { type: string; opgebouwd_this_period: number; paid_out_this_period: number }
interface EmployerResponse { name: string | null; franchise_bearing: boolean | 'unknown' }

interface TierCPeriodResponse {
  period_label: string | null;
  period_type: 'week' | '4-weekly' | 'month';
  /** Stage 2h (audit v28, §2h.6): "add period_type_confirmed to the frontend TierCPeriodResponse and
   * grep every other consumer (§2.10a)." The backend has carried this since stage 2g (§2g.0b); this
   * local type mirror omitted it, which the reviewer flagged (T3a) - runtime was harmless only because
   * `/recompute`'s body is built by spreading the ENTIRE `period` object the server itself returned
   * (`{...basePeriod, [field]: value}`), so the real value survived as an untyped extra property
   * regardless. Declaring it here closes the type gap without changing that runtime behaviour. */
  period_type_confirmed: boolean;
  /** Stage 2i (audit v29, §2i.0e): "add the missing fields to the frontend period type." The
   * reviewer's own finding (T2/T9): this mirror omitted `period_end_date`, `is_correction`,
   * `version`, `contract_hours`, `payout_adjustments`, `bijzonder_tarief` and `et` - runtime was
   * already correct (the same full-object-spread reasoning as `period_type_confirmed` above), but a
   * hand-built partial period would type-check here without them and then be REJECTED by the
   * backend's `isValidPayslipPeriodShape` (2h.6) with no compile-time warning. Declared with the
   * same shape the backend's `PayslipPeriod` uses. */
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
  /** v17: these six existed on the backend's PayslipPeriod since the printed-label plumbing round,
   * and Discrepancy.printed_label already surfaces them for the discrepancy list - but this local
   * type mirror was never updated to declare them, so the unreliable-view correction form (this
   * round) couldn't read them at all. A real, pre-existing gap, closed here rather than left. */
  printed_table_tax_label: string | null;
  printed_bt_tax_label: string | null;
  printed_algemene_heffingskorting_label: string | null;
  printed_arbeidskorting_label: string | null;
  printed_net_label: string | null;
  printed_payout_label: string | null;
}

interface CompleteResult {
  gross_total: number; loon_voor_heffingen: number; taxable_base: number;
  table_tax_after_korting: number; bt_tax: number; total_tax: number;
  wage_net: number; net_additions_total: number; net_deductions_total: number;
  period_net: number; payout_amount: number;
}
type Outcome = { status: 'complete'; result: CompleteResult } | { status: 'incomplete'; missing_fields: string[]; tax_is_upper_bound: boolean; gross_total: number; taxable_base: number; table_tax_after_korting: number; bt_tax: number; total_tax: number };

type DiscrepancyCode = 'table_tax_mismatch' | 'bt_tax_mismatch' | 'algemene_heffingskorting_mismatch' | 'arbeidskorting_mismatch' | 'net_mismatch' | 'payout_mismatch' | 'minimum_wage_stale_on_document' | 'minimum_wage_violation';
/** Stage 2i (§2i.0e): `related_to` names the OTHER discrepancy code whose arithmetic explains this
 * one (e.g. a wrong table tax moving the final payout by exactly its own error) - `null` for a root
 * cause or an unrelated finding. See discrepancy.ts's own doc comment for how this is decided. */
interface Discrepancy { code: DiscrepancyCode; computed: number | null; printed: number; residual: number | null; tolerance: number; confirmation_upper: number; status: 'confirm' | 'finding'; printed_label: string | null; related_to: DiscrepancyCode | null }

/** Stage 2i (§2i.0b): "the dual net position is visible... say it on the panel in one plain line."
 * Mirrors extraction-consistency.ts's own `ExtractionTrace['net_position']` vocabulary exactly. */
// Stage 2n (§2n.2): 'before_post_tax' - a THIRD, earlier position (taxable base minus both taxes,
// nothing else) 'before'/'after' (both always post-tax) can never represent.
type NetPosition = 'before_post_tax' | 'before' | 'after' | 'both' | 'none';
type TextLayerStatus = 'ok' | 'mismatch' | 'too_large' | 'none';
/** Stage 2h (§2h.4): "numbers that let a real upload speak (no content)" - counts and a status code
 * only, never a text item, label or amount from the document. */
interface TechnicalDetails {
  text_items_sent: number;
  amounts_checked: number;
  amounts_not_found: number;
  text_layer_status: TextLayerStatus;
  request_size_kb: number;
  /** Stage 2i (§2i.0e): which of the two numbers request_size_kb actually is - the client-sent
   * Content-Length header (when it roughly agreed with an independent re-encode) or the measured
   * re-encode itself (when the header was absent or disagreed by more than a small margin). */
  request_size_source: 'content_length' | 'measured';
  /** Stage 2i (§2i.0d): "put the chosen step in the technical line" - which render setting this
   * upload's images actually used (client-reported; see local-ocr.ts's `renderPageImages`). */
  render_step: string;
}

interface OkResponse {
  status: 'ok';
  period: TierCPeriodResponse;
  outcome: Outcome;
  discrepancies: Discrepancy[];
  /** Stage 2h (§2h.3) / 2i (§2i.0b): which chain position (if any) the printed net actually
   * confirms - structured data (§2.6), the panel below decides the wording. */
  net_position: NetPosition;
  technicalDetails: TechnicalDetails;
  truncated: boolean;
  redactedFields: string[];
  taxRatesSource: 'database' | 'static';
}

/** Stage 2b (audit v12): the pre-comparison consistency gate's issue shape, mirroring
 * extraction-consistency.ts's discriminated union exactly - codes plus numeric params, never a
 * prebaked sentence (§2.6), so this file builds every issue's copy via translations.ts. */
// Stage 2f (§2f.9): every code below must have a case in issueMessage() - extraction-consistency.test.ts's
// "2f.9: every backend ConsistencyIssue code has a frontend case" test fails the backend suite if a
// code string here (or a new one added to the backend) has no matching literal in this file, since
// there is no shared-types package between the two projects to enforce this at compile time instead.
type ConsistencyIssue =
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
  | { code: 'period_type_unknown' }
  | { code: 'et_exchange_amount_unknown' }
  | { code: 'amount_unreadable'; field: string };

/** Stage 2d (§2d.1): "the blocking panel must show what it read" - mirrors
 * extraction-consistency.ts's ExtractionTrace exactly. */
// Stage 2l (§2l.2): "flagged" - true only when this line's own field path was named by
// amount_unreadable; the panel must show it as excluded from the sum above it, never silently drop it.
interface ExtractionTraceLine { label: string; category: string; amount: number | null; provenance: string; flagged: boolean }
// Stage 2j (§2j.1): 'confirmed_taxable_base' - a printed figure resolved by arithmetic to the third
// chain position (gross minus pre-tax minus the ET reduction), not gross or loon-voor-heffingen.
type SubtotalRole = 'both' | 'confirmed_gross' | 'confirmed_loon_voor_heffingen' | 'confirmed_taxable_base' | 'ambiguous_both_match' | 'unresolved' | 'none';
interface ExtractionTrace {
  hour_lines: ExtractionTraceLine[];
  gross_total: number;
  /** Stage 2f (§2f.2): "the panel must not label a subtotal 'gross' unless it reconciles as gross;
   * until then it shows 'printed subtotal'." */
  printed_subtotal_role: SubtotalRole;
  printed_gross_total: number | null;
  pre_tax_deductions: ExtractionTraceLine[];
  pre_tax_deductions_sum: number | null;
  loon_voor_heffingen: number | null;
  printed_loon_voor_heffingen: number | null;
  /** Stage 2l (§2l.1): the ET reduction as its own explicit step - null (never 0) when ET does not
   * apply to this document at all. */
  et_reduction: number | null;
  /** Stage 2l (§2l.1): the actual taxable-base position (loon_voor_heffingen minus et_reduction) -
   * available even on the amount_unreadable-blocked trace, unlike computed_taxable_base below. */
  taxable_base_position: number | null;
  printed_table_tax: number | null;
  printed_bt_tax: number | null;
  /** Stage 2f (§2f.4): null when the caller could not compute at all (an unread period_type or
   * et_exchange_amount blocks the whole computation, not just the tax step). */
  computed_taxable_base: number | null;
  computed_table_tax_after_korting: number | null;
  post_tax_social: ExtractionTraceLine[];
  post_tax_deductions_sum: number | null;
  implied_net: number | null;
  printed_net: number | null;
  net_additions: ExtractionTraceLine[];
  net_deductions: ExtractionTraceLine[];
  /** Stage 2n (§2n.1): ET reimbursement lines, shown for the first time - previously an empty list and
   * a genuinely-unread one looked identical (both silence). */
  et_reimbursements: ExtractionTraceLine[];
  implied_payout: number | null;
  printed_payout: number | null;
  /** Stage 2g (§2g.5): "the trace records reading_basis: text_layer_verified when 2g.3 ran, or
   * image_only when there was no text layer." */
  reading_basis: 'text_layer_verified' | 'image_only';
  /** Stage 2g (§2g.4): "printed amounts that were not used" - a stated gap, never a finding. */
  unused_printed_amounts: { count: number; sample: number[] };
  /** Stage 2h (§2h.4): numbers only, never document content - see TechnicalDetails above. */
  technical_details: TechnicalDetails;
  /** Stage 2i (§2i.0b): see NetPosition above. */
  net_position: NetPosition;
  /** Stage 2i (§2i.1): true only when a printed figure sitting in one anchor field was resolved by
   * arithmetic to actually be the OTHER role (OTTO's shape - see resolveAnchors's own doc comment). */
  anchor_reassigned: boolean;
  /** Stage 2i (§2i.1): a printed figure matching neither chain position - shown as a neutral list,
   * never as a block. */
  other_printed_figures: number[];
  /** Stage 2i (§2i.2): OTTO's own taxable-base split, when the document prints one. */
  printed_taxable_base_normal: number | null;
  printed_taxable_base_special: number | null;
}

interface UnreliableResponse {
  status: 'unreliable';
  issues: ConsistencyIssue[];
  trace: ExtractionTrace;
  period: TierCPeriodResponse;
  truncated: boolean;
  redactedFields: string[];
}

type AnalyzeResponse = OkResponse | UnreliableResponse;

/** Only issues with one clear printed_* numeric target get a correction input (reusing the same
 * /recompute mechanism Stage 1's discrepancy correction already uses) - the others (period shape,
 * category) have no single field a text box could safely edit, so they surface as diagnosis only;
 * either way, the gate above still blocks the discrepancy list from appearing at all.
 *
 * v17: zero_tax_nonzero_base is deliberately NOT here, even though it has a printed_table_tax field
 * that looks correctable. On the live Olympia run, printed_table_tax was already read correctly -
 * the zero came from the ENGINE's own computation (driven by a misread period), which a printed_
 * table_tax correction cannot touch. Offering that input implied a fix path that does nothing:
 * confirming/correcting the same already-correct number and recomputing would reproduce the exact
 * same zero and re-fail this same check, misleading the user that they'd done something. Diagnosis
 * only, like period/category issues, until the period itself is correctable. */
const CORRECTABLE_ISSUE_FIELD: Partial<Record<ConsistencyIssue['code'], keyof TierCPeriodResponse>> = {
  totals_do_not_reconcile_net: 'printed_net',
  totals_do_not_reconcile_payout: 'printed_payout',
};

/** The as-printed label field on TierCPeriodResponse that goes with each correctable issue's target
 * field - so the correction form can show the document's OWN term for the line, not just a generic
 * translated name (v17: "a user cannot correct a value they cannot see"). */
const CORRECTABLE_ISSUE_LABEL_FIELD: Partial<Record<ConsistencyIssue['code'], keyof TierCPeriodResponse>> = {
  totals_do_not_reconcile_net: 'printed_net_label',
  totals_do_not_reconcile_payout: 'printed_payout_label',
};

function correctableGenericLabel(t: TierCCopy, code: ConsistencyIssue['code']): string {
  switch (code) {
    case 'totals_do_not_reconcile_net': return t.codeNet;
    case 'totals_do_not_reconcile_payout': return t.codePayout;
    default: return '';
  }
}

/** The value the extraction actually read for the correctable field - what the correction input is
 * meant to replace. */
function correctableReadValue(issue: ConsistencyIssue): number | null {
  switch (issue.code) {
    case 'totals_do_not_reconcile_net': return issue.printed_net;
    case 'totals_do_not_reconcile_payout': return issue.printed_payout;
    default: return null;
  }
}

/** What the rest of the payslip's own figures imply this value should be - the arithmetic already
 * computed by extraction-consistency.ts, shown so the user can compare it against what they see
 * printed rather than guessing what number would satisfy the app. */
function correctableExpectedValue(issue: ConsistencyIssue): number | null {
  switch (issue.code) {
    case 'totals_do_not_reconcile_net': return issue.implied_net;
    case 'totals_do_not_reconcile_payout': return issue.implied_payout;
    default: return null;
  }
}

/** Stage 1's confirm/correct/unanswered state machine, tracked client-side per discrepancy code
 * (each code appears at most once in one period's discrepancy list). 'confirmed': the user verified
 * the printed figure was read correctly - the divergence is real, promoted to a finding on screen,
 * no backend call needed (nothing about the computation changed, only how it is DISPLAYED).
 * 'corrected': the user supplied a different printed value - this DOES call /recompute, since the
 * period's own printed_* field changes and the whole outcome/discrepancy list must be re-derived. */
type Disposition = { kind: 'unanswered' } | { kind: 'confirmed' } | { kind: 'corrected'; correctedTo: number };

type TierCCopy = (typeof translations)['pl']['tierC'];

function money(value: number): string {
  return `€${value.toFixed(2)}`;
}

/** The six aggregate discrepancy codes are whole-document reference figures (a payslip's own
 * "Loonheffing" / "Netto" summary lines). This generic, translated term is always shown; when the
 * extraction also captured this specific document's own label for the figure (Discrepancy.printed_
 * label, closed this round - previously a real, disclosed gap), the caller appends it via t.dutchTerm,
 * the same "translated (NL: as-printed)" pattern already used for hour_lines/deductions below. */
function discrepancyLabel(t: TierCCopy, code: DiscrepancyCode): string {
  return {
    table_tax_mismatch: t.codeTableTax,
    bt_tax_mismatch: t.codeBtTax,
    algemene_heffingskorting_mismatch: t.codeAlgemeneHeffingskorting,
    arbeidskorting_mismatch: t.codeArbeidskorting,
    net_mismatch: t.codeNet,
    payout_mismatch: t.codePayout,
    minimum_wage_stale_on_document: t.codeMinimumWage,
    minimum_wage_violation: t.codeMinimumWage,
  }[code];
}

/** Stage 2b: builds each consistency issue's sentence from its code + numeric params, per §2.6 -
 * the backend never sends prose, only the discriminated union extraction-consistency.ts defines. */
function issueMessage(t: TierCCopy, issue: ConsistencyIssue): string {
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
    case 'period_type_unknown':
      return t.issuePeriodTypeUnknown;
    case 'et_exchange_amount_unknown':
      return t.issueEtExchangeUnknown;
    case 'amount_unreadable':
      return t.issueAmountUnreadable(issue.field);
  }
}

function provenanceLabel(t: TierCCopy, provenance: string): string {
  if (provenance === 'payslip_extracted' || provenance === 'user_entered') return t.provenancePayslip;
  if (provenance === 'estimated') return t.provenanceEstimated;
  return provenance;
}

/** Stage 2h (§2h.4/§2h.2): one plain sentence for whichever of the four text-layer states this
 * upload landed in - never asserting the read is wrong, only saying what was and wasn't checked. */
function textLayerStatusNote(t: TierCCopy, status: TextLayerStatus): string {
  switch (status) {
    case 'ok': return t.textLayerStatusOk;
    case 'mismatch': return t.textLayerStatusMismatch;
    case 'too_large': return t.textLayerStatusTooLarge;
    case 'none': return t.textLayerStatusNone;
  }
}

/** Stage 2j (§2j.3): "an upload that falls back to image-only mid-request is stuck with the lower,
 * pre-chosen quality... that is the real gap... needs its own decision... or the fallback path is
 * accepted as lower-quality for this round and stated as such on the panel." The images were rendered
 * at the moderate `text-layer-present` setting (chosen client-side, before the server ever assessed the
 * text layer); when the server THEN decides that same text layer does not verify (`text_layer_status
 * === 'mismatch'`), the read falls back to image-only but the images already sent are the lower-quality
 * ones. Shown only in exactly that combination - never a general warning about the render step alone,
 * which is fine in the far more common case where the text layer verifies. */
function renderQualityStuckNote(t: TierCCopy, renderStep: string, textLayerStatus: TextLayerStatus): string | null {
  return renderStep === 'text-layer-present' && textLayerStatus === 'mismatch' ? t.renderQualityStuckNote : null;
}

/** Stage 2i (§2i.0b): "say it on the panel in one plain line" - which chain position (if any) the
 * printed net actually confirmed, never asserting a position the arithmetic didn't confirm. */
function netPositionNote(t: TierCCopy, position: NetPosition): string {
  switch (position) {
    case 'before_post_tax': return t.netPositionBeforePostTax;
    case 'before': return t.netPositionBefore;
    case 'after': return t.netPositionAfter;
    case 'both': return t.netPositionBoth;
    case 'none': return t.netPositionNone;
  }
}

export function TierCFlow({ lang, onNavigateToDictionary }: { lang: Lang; onNavigateToDictionary: () => void }) {
  const t = translations[lang].tierC;
  const progressLabels = translations[lang].progress;
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [isDragOver, setIsDragOver] = useState(false);
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState<AnalyzeResponse | null>(null);
  const [dispositions, setDispositions] = useState<Record<string, Disposition>>({});
  const [correctionInputs, setCorrectionInputs] = useState<Record<string, string>>({});
  const [recomputing, setRecomputing] = useState<string | null>(null);

  async function uploadFile(file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setUploadState('error'); setMessage(lang === 'pl' ? 'Plik jest większy niż 10 MB.' : 'The file is larger than 10 MB.'); return; }
    setUploadState('uploading'); setMessage(t.analyzing);
    try {
      // Stage 2g (§2g.1): the PDF's own text layer, when it has one, read on the SAME pages rendered
      // below - sent alongside the images, never instead of them. Empty for a plain image upload or a
      // scanned PDF with no usable text layer (extractTextItems' own threshold decides that).
      //
      // Stage 2h (§2h.5): "the upload cannot be broken by the new path." extractTextItems runs a PDF
      // worker (`getTextContent`) that can fail independently of the image render (a corrupt or
      // unusual PDF, a worker timeout) - wrapped in its OWN try so that failure degrades to an
      // image-only upload (documentText: []), never the upload's error state. The upload error state
      // stays reserved for the image path itself failing.
      //
      // Stage 2i (§2i.0d): text extraction now runs BEFORE rendering - the render step needs to know
      // whether a usable text layer exists (images are only a layout aid then) or not (images are the
      // only source, so the render adapts and measures itself against the request-size budget).
      let documentText: Awaited<ReturnType<typeof extractTextItems>> = [];
      try {
        documentText = await extractTextItems(file);
      } catch (textLayerError) {
        console.warn('Text-layer extraction failed - continuing image-only', textLayerError);
      }
      const { images, renderStep } = await renderPageImages(file, documentText.length > 0);
      const res = await fetch('/api/tier-c/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, documentText, renderStep }),
      });
      // Stage 2h (§2h.5): "show a clear message on a 413 instead of a generic error." A platform-level
      // rejection (Vercel's own request-body-size limit, before this ever reaches our Express handler)
      // does not necessarily return our own `{error_code}` JSON shape - checked and handled BEFORE
      // attempting to parse the body as JSON, which could otherwise throw on a platform error page.
      if (res.status === 413) {
        throw new Error(t.errorPayloadTooLarge);
      }
      const data = await res.json() as AnalyzeResponse & { error_code?: string };
      if (!res.ok) {
        const code = data.error_code;
        const translated = code === 'vision_unavailable' ? t.errorVisionUnavailable
          : code === 'invalid_input' ? t.errorInvalidInput
          : code === 'extraction_failed' ? t.errorExtractionFailed
          : code === 'rate_limit_unknown' ? t.errorRateLimitUnknown
          : code === 'rate_limit_exceeded' ? t.errorRateLimitExceeded
          : t.error;
        throw new Error(translated);
      }
      setResponse(data);
      setDispositions({});
      setUploadState('idle'); setMessage('');
    } catch (error) {
      setUploadState('error'); setMessage(error instanceof Error ? error.message : t.error);
    }
  }

  function confirmDiscrepancy(code: string) {
    setDispositions(current => ({ ...current, [code]: { kind: 'confirmed' } }));
  }

  async function recomputeWithCorrection(basePeriod: TierCPeriodResponse, field: keyof TierCPeriodResponse, value: number): Promise<{ period: TierCPeriodResponse } & ({ status: 'ok'; outcome: Outcome; discrepancies: Discrepancy[]; net_position: NetPosition; technicalDetails: TechnicalDetails; taxRatesSource: 'database' | 'static' } | { status: 'unreliable'; issues: ConsistencyIssue[]; trace: ExtractionTrace })> {
    const correctedPeriod = { ...basePeriod, [field]: value };
    const res = await fetch('/api/tier-c/recompute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period: correctedPeriod }),
    });
    const data = await res.json() as { status?: 'ok' | 'unreliable'; outcome?: Outcome; discrepancies?: Discrepancy[]; net_position?: NetPosition; technicalDetails?: TechnicalDetails; issues?: ConsistencyIssue[]; trace?: ExtractionTrace; taxRatesSource?: 'database' | 'static'; error_code?: string };
    if (!res.ok || !data.status) throw new Error(t.error);
    if (data.status === 'unreliable') {
      if (!data.issues || !data.trace) throw new Error(t.error);
      return { status: 'unreliable', period: correctedPeriod, issues: data.issues, trace: data.trace };
    }
    if (!data.outcome || !data.discrepancies || !data.taxRatesSource || !data.net_position || !data.technicalDetails) throw new Error(t.error);
    return { status: 'ok', period: correctedPeriod, outcome: data.outcome, discrepancies: data.discrepancies, net_position: data.net_position, technicalDetails: data.technicalDetails, taxRatesSource: data.taxRatesSource };
  }

  async function correctDiscrepancy(code: DiscrepancyCode) {
    if (!response || response.status !== 'ok') return; // this control only renders inside the 'ok' discrepancy list
    const raw = correctionInputs[code];
    const value = Number((raw ?? '').trim().replace(',', '.'));
    if (!Number.isFinite(value)) return;

    const fieldByCode: Record<DiscrepancyCode, keyof TierCPeriodResponse | null> = {
      table_tax_mismatch: 'printed_table_tax',
      bt_tax_mismatch: 'printed_bt_tax',
      algemene_heffingskorting_mismatch: 'printed_algemene_heffingskorting',
      arbeidskorting_mismatch: 'printed_arbeidskorting',
      net_mismatch: 'printed_net',
      payout_mismatch: 'printed_payout',
      minimum_wage_stale_on_document: 'wml_printed',
      minimum_wage_violation: null,
    };
    const field = fieldByCode[code];
    if (!field || !response.period) return;

    setRecomputing(code);
    try {
      const result = await recomputeWithCorrection(response.period, field, value);
      // A "corrected" discrepancy can turn out to still be unreliable (Stage 2b: the same gate
      // applies after a correction, not only before the first attempt) - fall through to the
      // unreliable view rather than pretending the discrepancy list is still the right thing to show.
      if (result.status === 'unreliable') {
        setResponse({ status: 'unreliable', period: result.period, issues: result.issues, trace: result.trace, truncated: false, redactedFields: [] });
        return;
      }
      setResponse({ status: 'ok', period: result.period, outcome: result.outcome, discrepancies: result.discrepancies, net_position: result.net_position, technicalDetails: result.technicalDetails, truncated: response.truncated, redactedFields: response.redactedFields, taxRatesSource: result.taxRatesSource });
      setDispositions(current => ({ ...current, [code]: { kind: 'corrected', correctedTo: value } }));
    } catch {
      setMessage(t.error);
    } finally {
      setRecomputing(null);
    }
  }

  async function correctIssue(issueCode: ConsistencyIssue['code']) {
    if (!response) return;
    const field = CORRECTABLE_ISSUE_FIELD[issueCode];
    const raw = correctionInputs[issueCode];
    const value = Number((raw ?? '').trim().replace(',', '.'));
    if (!field || !Number.isFinite(value)) return;

    setRecomputing(issueCode);
    try {
      const result = await recomputeWithCorrection(response.period, field, value);
      if (result.status === 'unreliable') {
        setResponse({ status: 'unreliable', period: result.period, issues: result.issues, trace: result.trace, truncated: false, redactedFields: [] });
        return;
      }
      // Stage 2i (§2i.0e): was hardcoded 'static' (the reviewer's own finding, T9b/T8b) - the server's
      // own reported source, exactly like correctDiscrepancy already does above.
      setResponse({ status: 'ok', period: result.period, outcome: result.outcome, discrepancies: result.discrepancies, net_position: result.net_position, technicalDetails: result.technicalDetails, truncated: false, redactedFields: [], taxRatesSource: result.taxRatesSource });
      setDispositions({});
    } catch {
      setMessage(t.error);
    } finally {
      setRecomputing(null);
    }
  }

  function startOver() {
    setResponse(null);
    setDispositions({});
    setCorrectionInputs({});
    setMessage('');
  }

  if (!response) {
    return (
      <section className="flow-page">
        <div className="flow-heading">
          <span className="step">Tier C</span>
          <h1>{t.title}</h1>
          <p>{t.lead}</p>
        </div>
        <div className="notice-card contract-privacy-card">
          <ShieldCheck/>
          <div><h3>{t.aboutTitle}</h3><p>{t.aboutBody}</p></div>
        </div>
        <div className="upload-card contract-upload-card">
          <StepProgress current={uploadState === 'uploading' ? 2 : 1} labels={[progressLabels.document, progressLabels.analysis]}/>
          <h2>{t.uploadTitle}</h2>
          <p>{t.uploadLead}</p>
          <input ref={inputRef} className="hidden" type="file" accept="application/pdf,image/jpeg,image/png" onChange={event => void uploadFile(event.target.files?.[0])} aria-label={t.choose}/>
          <button
            className={`drop ${uploadState} ${isDragOver ? 'drag-over' : ''}`}
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploadState === 'uploading'}
            onDragOver={event => { event.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={event => { event.preventDefault(); setIsDragOver(false); void uploadFile(event.dataTransfer.files?.[0]); }}
          >
            <span className="upload-icon"><Upload/></span>
            <strong>{uploadState === 'uploading' ? t.analyzing : isDragOver ? t.dropHere : t.dragTitle}</strong>
            {uploadState !== 'uploading' && <span className="drop-or">{t.dragOr} <u>{t.choose}</u></span>}
            <small>{t.types}</small>
          </button>
          {message && <div className={`status ${uploadState}`} role="status">{message}</div>}
        </div>
      </section>
    );
  }

  if (response.status === 'unreliable') {
    return (
      <section className="flow-page">
        <button className="back plain-button" onClick={startOver}><ArrowLeft size={17}/>{t.startOver}</button>
        <div className="flow-heading">
          <span className="step">Tier C</span>
          <h1>{t.unreliableTitle}</h1>
        </div>

        {response.redactedFields.length > 0 && <div className="status error"><AlertTriangle size={16}/> {t.redactedNotice}</div>}
        {response.truncated && <div className="status error"><AlertTriangle size={16}/> {t.truncatedNotice}</div>}

        <div className="notice-card">
          <AlertTriangle/>
          <div><p>{t.unreliableBody}</p></div>
        </div>

        {/* v19 (§2d.1): "the blocking panel must show what it read" - every extracted line and the
            gate's own gross-to-net chain, not just the totals and one flagged line. A step marked
            with traceStepFailed corresponds to an issue below that references it. */}
        {(() => {
          const trace = response.trace;
          const hasIssue = (code: ConsistencyIssue['code']) => response.issues.some((i) => i.code === code);
          // Stage 2g (§2g.0, owner's OWNER-RETEST-2f-olympia.md observation): when the subtotal role
          // is unresolved or the anchors are inverted, checkExtractionConsistency never runs the
          // pre-tax/net reconciliation stages at all - they are not "confirmed clean", they were never
          // checked. Before this, the net step showed no marker in exactly that case (628.89 against a
          // printed 686.09, no warning), which a reader could mistake for a passed check.
          const laterStepsUnchecked = hasIssue('printed_subtotal_role_unresolved') || hasIssue('anchors_inverted');
          const miscategorized = new Set(
            response.issues
              .filter((i): i is Extract<ConsistencyIssue, { code: 'deduction_miscategorized' }> => i.code === 'deduction_miscategorized')
              .map((i) => i.description),
          );
          const renderLines = (lines: ExtractionTraceLine[]) =>
            lines.length === 0 ? (
              <p className="form-note">{t.traceNoLines}</p>
            ) : (
              lines.map((l, i) => (
                <p key={i}>
                  {l.label} <span className="form-note nl-term">({l.category})</span>: <strong>{l.amount === null ? t.traceUnknown : money(l.amount)}</strong>
                  {miscategorized.has(l.label) && <span className="form-note"> {t.traceStepFailed}</span>}
                  {/* Stage 2l (§2l.2): "a flagged amount should not sit inside a sum shown as fact...
                      do not silently drop it either." The row stays, marked, and excluded from the
                      sum printed just above it. */}
                  {l.flagged && <span className="form-note"> {t.traceLineFlagged}</span>}
                </p>
              ))
            );
          const flaggedCount = (lines: ExtractionTraceLine[]) => lines.filter((l) => l.flagged).length;
          return (
            <div className="notice-card">
              <ShieldCheck/>
              <div>
                <h3>{t.traceTitle}</h3>
                <p><strong>{t.traceHourLines}</strong>{hasIssue('gross_lines_do_not_reconcile') && <span className="form-note"> {t.traceStepFailed}</span>}</p>
                {renderLines(trace.hour_lines)}
                <p>{t.traceGrossTotal}: <strong>{money(trace.gross_total)}</strong></p>
                {flaggedCount(trace.hour_lines) > 0 && <p className="form-note">{t.traceSumExcludesFlagged(flaggedCount(trace.hour_lines))}</p>}
                {/* Stage 2f (§2f.2): "the panel must not label a subtotal 'gross' unless it reconciles
                    as gross; until then it shows 'printed subtotal'." A value sitting in
                    printed_gross_total that resolveSubtotalRole did NOT confirm as the gross role
                    (the Olympia trap: extraction put 844.92 here, but it is actually loon voor
                    heffingen) is shown with the neutral label, never asserted as gross. */}
                {trace.printed_gross_total !== null && (
                  <p>
                    {trace.printed_subtotal_role === 'both' || trace.printed_subtotal_role === 'confirmed_gross' ? t.tracePrintedGrossTotal : t.tracePrintedSubtotalNeutral}:{' '}
                    <strong>{money(trace.printed_gross_total)}</strong>
                  </p>
                )}
                {hasIssue('printed_subtotal_role_unresolved') && <p className="form-note">{t.traceStepFailed}</p>}
                {hasIssue('anchors_inverted') && <p className="form-note">{t.traceStepFailed}</p>}

                <p>
                  <strong>{t.tracePreTaxDeductions}</strong>
                  {hasIssue('pre_tax_does_not_reconcile') && <span className="form-note"> {t.traceStepFailed}</span>}
                  {!hasIssue('pre_tax_does_not_reconcile') && laterStepsUnchecked && <span className="form-note"> {t.traceStepNotChecked}</span>}
                </p>
                {renderLines(trace.pre_tax_deductions)}
                <p>{t.tracePreTaxSum}: <strong>{trace.pre_tax_deductions_sum === null ? t.traceUnknown : money(trace.pre_tax_deductions_sum)}</strong></p>
                {flaggedCount(trace.pre_tax_deductions) > 0 && <p className="form-note">{t.traceSumExcludesFlagged(flaggedCount(trace.pre_tax_deductions))}</p>}
                <p>{t.traceLoonVoorHeffingen}: <strong>{trace.loon_voor_heffingen === null ? t.traceUnknown : money(trace.loon_voor_heffingen)}</strong></p>
                {trace.printed_loon_voor_heffingen !== null && (
                  <p>
                    {trace.printed_subtotal_role === 'both' || trace.printed_subtotal_role === 'confirmed_loon_voor_heffingen' ? t.tracePrintedLoonVoorHeffingen : t.tracePrintedSubtotalNeutral}:{' '}
                    <strong>{money(trace.printed_loon_voor_heffingen)}</strong>
                  </p>
                )}
                {trace.anchor_reassigned && <p className="form-note">{t.traceAnchorReassignedNote}</p>}
                {trace.other_printed_figures.length > 0 && (
                  <p className="form-note">{t.traceOtherPrintedFigures(trace.other_printed_figures.map((v) => money(v)).join(', '))}</p>
                )}
                {/* Stage 2l (§2l.1): "show the ET reduction as its own step between loon voor
                    heffingen and implied net" - previously invisible even though implied_net (since
                    2j.1) was already computed from the post-ET position below. */}
                {trace.et_reduction !== null && (
                  <p>{t.traceEtReduction}: <strong>{money(trace.et_reduction)}</strong></p>
                )}
                {trace.taxable_base_position !== null && trace.et_reduction !== null && (
                  <p>{t.traceTaxableBasePosition}: <strong>{money(trace.taxable_base_position)}</strong></p>
                )}

                <p><strong>{t.traceTaxTitle}</strong>{(hasIssue('zero_tax_nonzero_base') || hasIssue('printed_tax_unknown') || hasIssue('printed_tax_bases_do_not_reconcile')) && <span className="form-note"> {t.traceStepFailed}</span>}</p>
                <p>{t.traceTaxPrintedTable}: <strong>{trace.printed_table_tax === null ? t.traceUnknown : money(trace.printed_table_tax)}</strong></p>
                {trace.printed_bt_tax !== null && <p>{t.traceTaxPrintedBt}: <strong>{money(trace.printed_bt_tax)}</strong></p>}
                {trace.printed_taxable_base_normal !== null && <p>{t.traceTaxBaseNormal}: <strong>{money(trace.printed_taxable_base_normal)}</strong></p>}
                {trace.printed_taxable_base_special !== null && <p>{t.traceTaxBaseSpecial}: <strong>{money(trace.printed_taxable_base_special)}</strong></p>}
                <p>{t.traceTaxComputed}: <strong>{trace.computed_table_tax_after_korting === null ? t.traceUnknown : money(trace.computed_table_tax_after_korting)}</strong></p>

                <p><strong>{t.tracePostTaxSocial}</strong></p>
                {renderLines(trace.post_tax_social)}
                <p>{t.tracePostTaxSum}: <strong>{trace.post_tax_deductions_sum === null ? t.traceUnknown : money(trace.post_tax_deductions_sum)}</strong></p>

                <p>
                  <strong>{t.traceNetTitle}</strong>
                  {(hasIssue('totals_do_not_reconcile_net') || hasIssue('net_does_not_reconcile')) && <span className="form-note"> {t.traceStepFailed}</span>}
                  {!(hasIssue('totals_do_not_reconcile_net') || hasIssue('net_does_not_reconcile')) && laterStepsUnchecked && <span className="form-note"> {t.traceStepNotChecked}</span>}
                </p>
                <p>{t.traceNetImplied}: <strong>{trace.implied_net === null ? t.traceUnknown : money(trace.implied_net)}</strong></p>
                <p>{t.traceNetPrinted}: <strong>{trace.printed_net === null ? t.traceUnknown : money(trace.printed_net)}</strong></p>

                {(trace.net_additions.length > 0 || trace.net_deductions.length > 0) && (
                  <>
                    <p><strong>{t.traceNetAdditions}</strong></p>
                    {renderLines(trace.net_additions)}
                    <p><strong>{t.traceNetDeductions}</strong></p>
                    {renderLines(trace.net_deductions)}
                  </>
                )}
                {/* Stage 2n (§2n.1): "find out whether the reimbursement lines were read at all" -
                    shown whenever ET applies, even when empty, so an empty list (genuinely none
                    printed) and a genuinely-unread one are no longer visually identical. */}
                {trace.et_reduction !== null && (
                  <>
                    <p><strong>{t.traceEtReimbursements}</strong></p>
                    {renderLines(trace.et_reimbursements)}
                  </>
                )}

                <p><strong>{t.tracePayoutTitle}</strong>{hasIssue('totals_do_not_reconcile_payout') && <span className="form-note"> {t.traceStepFailed}</span>}</p>
                <p>{t.tracePayoutImplied}: <strong>{trace.implied_payout === null ? t.traceUnknown : money(trace.implied_payout)}</strong></p>
                <p>{t.tracePayoutPrinted}: <strong>{trace.printed_payout === null ? t.traceUnknown : money(trace.printed_payout)}</strong></p>

                {/* Stage 2g (§2g.5): "the panel says in one plain sentence that the digits were not
                    checked against the document's text" for an image-only read. */}
                <p className="form-note">{trace.reading_basis === 'text_layer_verified' ? t.readingBasisTextVerified : t.readingBasisImageOnly}</p>
                {/* Stage 2g (§2g.4): a stated gap, never a finding - "printed amounts that were not
                    used" (this is what catches a whole missing line, like Olympia's 58.31). */}
                {trace.unused_printed_amounts.count > 0 && (
                  <p className="form-note">
                    {t.traceUnusedAmounts(trace.unused_printed_amounts.count, trace.unused_printed_amounts.sample.map((v) => money(v)).join(', '))}
                  </p>
                )}
                {/* Stage 2h (§2h.4): "one small 'technical details' line... numbers only." This is
                    what the owner's real-PDF upload result is read from. */}
                <p className="form-note">{textLayerStatusNote(t, trace.technical_details.text_layer_status)}</p>
                <p className="form-note">
                  {t.technicalDetailsLine(trace.technical_details.text_items_sent, trace.technical_details.amounts_checked, trace.technical_details.amounts_not_found, trace.technical_details.request_size_kb, trace.technical_details.render_step)}
                </p>
                {/* Stage 2j (§2j.3): the images were chosen at the pre-chosen text-layer quality before
                    the server rejected that same text layer - visible, never silent. */}
                {renderQualityStuckNote(t, trace.technical_details.render_step, trace.technical_details.text_layer_status) && (
                  <p className="form-note">{renderQualityStuckNote(t, trace.technical_details.render_step, trace.technical_details.text_layer_status)}</p>
                )}
                {/* Stage 2i (§2i.0e): "show the measured size and say which" - only worth a line when
                    the trusted Content-Length header was NOT used (the interesting case). */}
                {trace.technical_details.request_size_source === 'measured' && <p className="form-note">{t.requestSizeMeasuredNote}</p>}
                {/* Stage 2i (§2i.0b): "the dual net position is visible" - one plain line, never
                    hiding that the gate's own arithmetic check can still be satisfied this way. */}
                <p className="form-note">{netPositionNote(t, trace.net_position)}</p>
              </div>
            </div>
          );
        })()}

        <div className="notice-card discrepancy-card">
          <AlertTriangle/>
          <div>
            {response.issues.map((issue, i) => {
              const field = CORRECTABLE_ISSUE_FIELD[issue.code];
              const labelField = CORRECTABLE_ISSUE_LABEL_FIELD[issue.code];
              const printedLabel = labelField ? response.period[labelField] : null;
              const readValue = correctableReadValue(issue);
              const expectedValue = correctableExpectedValue(issue);
              return (
                <div key={i} className="discrepancy-item finding">
                  <p>{issueMessage(t, issue)}</p>
                  {field && (
                    <>
                      {/* v17: "a user cannot correct a value they cannot see" - the line's own name,
                          the as-printed Dutch label if the document had one, what was actually read,
                          and what the rest of the payslip's own arithmetic implies it should be,
                          all shown together right above the input that changes it. */}
                      <p className="form-note">
                        <strong>{correctableGenericLabel(t, issue.code)}</strong>{' '}
                        {typeof printedLabel === 'string' && printedLabel && <span className="nl-term">({t.dutchTerm(printedLabel)})</span>}
                      </p>
                      {readValue !== null && <p className="form-note">{t.weRead(money(readValue))}</p>}
                      {expectedValue !== null && <p className="form-note">{t.expectedValue(money(expectedValue))}</p>}
                      <label>{t.correctionLabel}
                        <div className="money-input">
                          <span>€</span>
                          <input inputMode="decimal" value={correctionInputs[issue.code] ?? ''} onChange={event => setCorrectionInputs(c => ({ ...c, [issue.code]: event.target.value.replace(/[^0-9.,-]/g, '') }))}/>
                        </div>
                      </label>
                      <button type="button" className="secondary" disabled={recomputing === issue.code} onClick={() => void correctIssue(issue.code)}>
                        {recomputing === issue.code ? t.recomputing : t.correctSubmit}
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {message && <div className="status error" role="status">{message}</div>}
        <button className="secondary" onClick={startOver}>{t.startOver}</button>
      </section>
    );
  }

  const { period, outcome, discrepancies } = response;
  const employerNames = period.employers.map(e => e.name).filter((n): n is string => !!n).join(', ');
  const heldForLaterTotal = period.reservations.reduce((sum, r) => sum + r.opgebouwd_this_period, 0);

  // Stage 1's "never counted as a finding while unanswered" rule: effective status per code, so an
  // unanswered confirm-band item never contributes to a findings count or renders as an accusation.
  function effectiveStatus(d: Discrepancy): 'confirm' | 'finding' {
    const disposition = dispositions[d.code];
    if (disposition?.kind === 'confirmed') return 'finding';
    return d.status;
  }
  const uncorrectedDiscrepancies = discrepancies.filter(d => dispositions[d.code]?.kind !== 'corrected');
  // Stage 2i (§2i.0e): "group payout_mismatch under table_tax_mismatch when they have the same cause
  // (structured related_to, one row on the panel; the OTTO 12.28 case)." A discrepancy with
  // `related_to` set is shown as a short note under its ROOT's row, not as its own separate row.
  const linkedByRoot = new Map<DiscrepancyCode, Discrepancy[]>();
  for (const d of uncorrectedDiscrepancies) {
    if (d.related_to) linkedByRoot.set(d.related_to, [...(linkedByRoot.get(d.related_to) ?? []), d]);
  }
  const visibleDiscrepancies = uncorrectedDiscrepancies.filter(d => !d.related_to);
  const findingsCount = visibleDiscrepancies.filter(d => effectiveStatus(d) === 'finding').length;

  return (
    <section className="flow-page">
      <div className="flow-heading">
        <span className="step">Tier C</span>
        <h1>{t.resultTitle}</h1>
        {period.period_label && <p>{period.period_label}{employerNames ? ` · ${employerNames}` : ''}{period.hirer?.name ? ` · ${period.hirer.name}` : ''}</p>}
      </div>

      {response.redactedFields.length > 0 && <div className="status error"><AlertTriangle size={16}/> {t.redactedNotice}</div>}
      {response.truncated && <div className="status error"><AlertTriangle size={16}/> {t.truncatedNotice}</div>}

      <div className="result-grid">
        <article><span>{t.grossTotal}</span><strong>{money(period.hour_lines.reduce((s, l) => s + l.amount, 0))}</strong></article>
        <article><span>{t.taxTable}</span><strong>{money(outcome.status === 'complete' ? outcome.result.table_tax_after_korting : outcome.table_tax_after_korting)}</strong></article>
        {(outcome.status === 'complete' ? outcome.result.bt_tax : outcome.bt_tax) > 0 && (
          <article><span>{t.taxBt}</span><strong>{money(outcome.status === 'complete' ? outcome.result.bt_tax : outcome.bt_tax)}</strong></article>
        )}
      </div>

      {period.pre_tax_deductions.length > 0 && (
        <div className="notice-card">
          <ShieldCheck/>
          <div>
            <h3>{t.preTaxDeductions}</h3>
            {period.pre_tax_deductions.map((d, i) => (
              <p key={i}>
                {d.category} <span className="form-note nl-term">({t.dutchTerm(d.description)})</span>:{' '}
                <strong>{d.amount.value === null ? '—' : money(d.amount.value)}</strong>{' '}
                <span className="form-note">({provenanceLabel(t, d.amount.provenance)})</span>
              </p>
            ))}
          </div>
        </div>
      )}

      {outcome.status === 'incomplete' ? (
        <div className="notice-card">
          <AlertTriangle/>
          <div>
            <h3>{t.incompleteTitle}</h3>
            <p>{t.incompleteBody}</p>
            <ul>{outcome.missing_fields.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </div>
        </div>
      ) : (
        <div className="notice-card">
          <ShieldCheck/>
          <div>
            <h3>{t.wageNet}</h3>
            <p><strong>{money(outcome.result.wage_net)}</strong></p>
            {outcome.result.net_additions_total > 0 && <p>{t.netAdditions}: <strong>+{money(outcome.result.net_additions_total)}</strong></p>}
            <p>{t.payoutAmount}: <strong>{money(outcome.result.payout_amount)}</strong></p>
          </div>
        </div>
      )}

      {/* 3-group block (§6a), mention-only exactly as Tier A's - "gone for good" reuses the same
          gross-minus-wage_net derivation; no sector-premium range exists here since nothing is
          estimated in Tier C (§9's own promise: "deductions as printed -> net as a figure"). */}
      {outcome.status === 'complete' && (
        <div className="notice-card three-groups">
          <div>
            <h3>{t.threeGroupsTitle}</h3>
            <p><strong>{t.paidNowLabel}</strong>: {money(outcome.result.payout_amount)} <span className="form-note">({t.paidNowHint})</span></p>
            <p><strong>{t.goneForGoodLabel}</strong>: {money(period.hour_lines.reduce((s, l) => s + l.amount, 0) - outcome.result.wage_net)} <span className="form-note">({t.goneForGoodHint})</span></p>
            {heldForLaterTotal > 0 && (
              <>
                <p><strong>{t.heldForLaterLabel}</strong>: {money(heldForLaterTotal)} <span className="form-note">({t.heldForLaterHint})</span></p>
                <p className="form-note">{t.heldForLaterNote}</p>
                <button type="button" className="secondary" onClick={onNavigateToDictionary}>{t.heldForLaterLink}</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Stage 1's classifier, Stage 2's interaction: silent items never reached this list at all
          (comparePeriodToDocument already filtered them server-side). 'confirm' renders as a
          question; confirming promotes it to 'finding' on screen without a server round trip;
          correcting calls /recompute and the item then disappears from this list entirely (the next
          discrepancy computation may or may not still flag it). */}
      {visibleDiscrepancies.length > 0 && (
        <div className="notice-card discrepancy-card">
          <HelpCircle/>
          <div>
            <h3>{t.discrepanciesTitle}</h3>
            <p className="form-note">{t.discrepanciesFindingsCount(findingsCount)}</p>
            {/* Stage 2k (§2k.2): "say the two rate sources out loud" - every comparison below depends
                on the same rates database, not only table tax; one shared note rather than a per-row
                repeat. The static-fallback note is additional, shown only in that degraded case. */}
            <p className="form-note">{t.discrepanciesRatesSourceNote}</p>
            {response.taxRatesSource === 'static' && <p className="form-note">{t.discrepanciesRatesSourceStaticNote}</p>}
            {visibleDiscrepancies.map(d => {
              const status = effectiveStatus(d);
              const disposition = dispositions[d.code] ?? { kind: 'unanswered' as const };
              return (
                <div key={d.code} className={`discrepancy-item ${status}`}>
                  <p>
                    <strong>{discrepancyLabel(t, d.code)}</strong>{' '}
                    {d.printed_label && <span className="form-note nl-term">({t.dutchTerm(d.printed_label)})</span>}{' '}
                    <span className="form-note">({t.weRead(money(d.printed))})</span>
                  </p>
                  {status === 'confirm' && disposition.kind === 'unanswered' ? (
                    <>
                      <p>{t.confirmQuestion(money(d.printed))}</p>
                      <div className="calc-toggles">
                        <button type="button" className="secondary" onClick={() => confirmDiscrepancy(d.code)}>{t.confirmYes}</button>
                      </div>
                      <label>{t.correctionLabel}
                        <div className="money-input">
                          <span>€</span>
                          <input inputMode="decimal" value={correctionInputs[d.code] ?? ''} onChange={event => setCorrectionInputs(c => ({ ...c, [d.code]: event.target.value.replace(/[^0-9.,-]/g, '') }))}/>
                        </div>
                      </label>
                      <button type="button" className="secondary" disabled={recomputing === d.code} onClick={() => void correctDiscrepancy(d.code)}>
                        {recomputing === d.code ? t.recomputing : t.correctSubmit}
                      </button>
                    </>
                  ) : (
                    <p className="form-note">
                      {/* Stage 2e (§2e.5): d.computed is typed nullable (Discrepancy.computed) even
                          though today's construction paths always pass a real number - "?? 0" would
                          have silently printed "we computed €0.00" the day that stops being true. */}
                      {d.computed === null ? t.findingBodyUnknownComputed(money(d.printed)) : t.findingBody(money(d.computed), money(d.printed))}
                    </p>
                  )}
                  {/* Stage 2i (§2i.0e): the OTTO 12.28 case - a downstream discrepancy the SAME
                      arithmetic already explains, named rather than shown as a second, separate row. */}
                  {linkedByRoot.has(d.code) && (
                    <p className="form-note">
                      {t.relatedDiscrepanciesNote(linkedByRoot.get(d.code)!.map(linked => discrepancyLabel(t, linked.code)).join(', '))}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Stage 2h (§2h.4): shown on a successful read too, not only the unreliable trace panel - "the
          owner's real-PDF result will be read from" this line either way. */}
      <p className="form-note">{textLayerStatusNote(t, response.technicalDetails.text_layer_status)}</p>
      <p className="form-note">
        {t.technicalDetailsLine(response.technicalDetails.text_items_sent, response.technicalDetails.amounts_checked, response.technicalDetails.amounts_not_found, response.technicalDetails.request_size_kb, response.technicalDetails.render_step)}
      </p>
      {renderQualityStuckNote(t, response.technicalDetails.render_step, response.technicalDetails.text_layer_status) && (
        <p className="form-note">{renderQualityStuckNote(t, response.technicalDetails.render_step, response.technicalDetails.text_layer_status)}</p>
      )}
      {response.technicalDetails.request_size_source === 'measured' && <p className="form-note">{t.requestSizeMeasuredNote}</p>}
      <p className="form-note">{netPositionNote(t, response.net_position)}</p>

      <p className="form-note calc-reliability-note">{t.reliabilityNoteC}</p>
      <p className="form-note calc-reliability-note">{t.permanentLimitationNote}</p>
    </section>
  );
}
