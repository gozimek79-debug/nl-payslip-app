import { tableTaxToleranceFor, type PayslipPeriod, type PayslipComputationOutcome, type PreTaxDeductionCategory, type PostTaxSocialCategory } from './payslip-model.js';
import { findUnusedPrintedAmounts, type DocumentTextItem } from './document-text-guard.js';
import { resolveNetReconciliationBasis } from './discrepancy.js';

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
  // Stage 2f (§2f.2/§2f.3)
  | { code: 'printed_subtotal_role_unresolved'; printed_subtotal: number; gross_hypothesis: number; loon_voor_heffingen_hypothesis: number | null }
  | { code: 'anchors_inverted'; printed_gross_total: number; printed_loon_voor_heffingen: number }
  | { code: 'totals_do_not_reconcile_net'; implied_net: number; printed_net: number; residual: number }
  | { code: 'totals_do_not_reconcile_payout'; implied_payout: number; printed_payout: number; residual: number }
  // Stage 2i (§2i.2): "check normal+special=total to the cent" - a pure identity between three
  // printed figures (OTTO: 621.14 + 104.24 = 725.38), exactly like gross_lines_do_not_reconcile above,
  // never a comparison against anything the engine computed.
  | { code: 'printed_tax_bases_do_not_reconcile'; implied_total: number; printed_total: number; residual: number }
  // Stage 2i (§2i.3): "when base reduction equals sum of reimbursements gate can confirm reading
  // (arithmetic, §2.13)." A genuine domain identity, not a guessed rule: an ET/extraterritorial salary
  // exchange arrangement swaps an equal amount of taxed wage for tax-free reimbursement, so the base
  // reduction and the reimbursement total are the SAME euro figure by construction - confirmed on the
  // one real document seen so far (OTTO: 33.00 + 144.00 = 177.00, exact). Fires only the OTHER way -
  // when both sides are present and do NOT match - a genuine internal inconsistency in the reading
  // (an incomplete reimbursement list, or a base reduction read from the wrong line). A match raises
  // nothing; silence is the confirmation, same idiom as every other reconciliation stage in this file.
  | { code: 'et_reduction_reimbursement_mismatch'; et_exchange_amount: number; reimbursements_sum: number; residual: number }
  // Stage 2e (§2e.5): tier-c.ts previously defaulted an unread period_type to 'week' and an unread
  // et_exchange_amount to 0 - both silent, both consequential (a monthly slip taxed as weekly; an ET
  // base reduction silently dropped). Raised by the controller (it alone has the raw TierCExtraction
  // needed to tell "genuinely absent" from "read as zero/week") as a blocking gap, never a default.
  | { code: 'period_type_unknown' }
  | { code: 'et_exchange_amount_unknown' }
  // Stage 2f (§2f.8): a non-finite hour/net/ET-reimbursement/payout/reservation amount is stored as 0
  // in the field itself (no shared type changed for this) but raised here, from the raw extraction's
  // `unreadable_amount_fields`, as a blocking gap - never presented as a comparison against a zero
  // that was never actually read.
  | { code: 'amount_unreadable'; field: string };

/**
 * Stage 2f (audit v26, §2f.9): "the interface must know every code (2.10a)... make it structural."
 * There is no shared-types package between the frontend and backend projects, so `ConsistencyIssue`'s
 * discriminants cannot be imported by TierCFlow.tsx or derived from one definition without a larger
 * restructuring than this round's scope. This runtime list is the practical alternative: it must be
 * kept in sync with the type above by hand (a new discriminant added there without adding it here is
 * itself a bug this list exists to catch less directly), and a backend test
 * (extraction-consistency.test.ts, "2f.9") reads TierCFlow.tsx's own source and fails if any code
 * below is missing from it - the exact failure mode `period_week_mismatch` had in stage 2e (added to
 * the backend, never added to the frontend's switch, and nothing failed because the frontend's own
 * union was just narrower, not wrong by its own compiler's lights).
 */
export const ALL_CONSISTENCY_ISSUE_CODES = [
  'zero_tax_nonzero_base',
  'period_year_mismatch',
  'period_length_mismatch',
  'period_week_mismatch',
  'deduction_miscategorized',
  'gross_lines_do_not_reconcile',
  'pre_tax_does_not_reconcile',
  'net_does_not_reconcile',
  'printed_tax_unknown',
  'printed_subtotal_role_unresolved',
  'anchors_inverted',
  'totals_do_not_reconcile_net',
  'totals_do_not_reconcile_payout',
  'printed_tax_bases_do_not_reconcile',
  'et_reduction_reimbursement_mismatch',
  'period_type_unknown',
  'et_exchange_amount_unknown',
  'amount_unreadable',
] as const satisfies readonly ConsistencyIssue['code'][];

// Compile-time half of the check: a code added to ConsistencyIssue but not to the list above fails
// the build here (the `satisfies` above only catches the OPPOSITE mistake - a stale/misspelled entry).
type _AssertNoMissingCode = ConsistencyIssue['code'] extends (typeof ALL_CONSISTENCY_ISSUE_CODES)[number] ? true : ['ConsistencyIssue code missing from ALL_CONSISTENCY_ISSUE_CODES', Exclude<ConsistencyIssue['code'], (typeof ALL_CONSISTENCY_ISSUE_CODES)[number]>];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _assertNoMissingCode: _AssertNoMissingCode = true;

/**
 * Stage 2f (§2f.12): derived, not asserted. Straight subtraction of printed/extracted figures, never
 * the engine's own tax computation (unlike discrepancy.ts's tolerances, which absorb stepwise
 * TABLE-rounding noise that has no place in a pure arithmetic identity between numbers the document
 * itself printed). Every figure that enters one of these identities - each hour line, each deduction
 * line, each printed subtotal - is itself a number printed to the cent, so it can carry up to half a
 * cent (0.005) of independent rounding. A check combining n such printed figures can therefore differ
 * by as much as n x 0.005 and still be arithmetically consistent; anything past that is a real gap,
 * not printing noise. Never widened beyond this bound to make a fixture pass - a fixture just outside
 * it gets an explanation, per §2.5, not a bigger constant.
 */
function reconciliationTolerance(termCount: number): number {
  return Math.round(termCount * 0.005 * 1000) / 1000;
}

/** Stage 2f (§2f.12): CHOSEN, not derived - a floor to skip degenerate near-zero taxable bases, set
 * far below even a single week's statutory minimum wage (~599 EUR at 14.99/h x 40h) so it can never
 * mistake a real low-earner period for the degenerate case. No formula produces this number; it is a
 * judgment call, recorded as one. */
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
  // Stage 2f (§2f.7): \bwga\b also matches inside "wga-gat" (the hyphen is a non-word character, so
  // both word boundaries are satisfied) - WGA-Gat is the PRE-TAX family (see PRE_TAX_KEYWORDS above);
  // filing it here would relabel it as plain post-tax 'wga', which is wrong on both the label and the
  // side of the tax line. The negative lookahead excludes "wga-gat"/"wgagat" specifically, so a line
  // on the wrong side of the tax line stays unmatched -> 'other' (a finding), never silently relabelled.
  { category: 'wga', pattern: /\bwga\b(?!-?gat)/ },
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

/**
 * Stage 2i (audit v29, §2i.3): "the 177.00 'Nieopod. część wyn. 100%' is the ET exchange reduction...
 * fix prompt and mapper so a line reducing taxable base by the ET reimbursement amount is read into
 * et_exchange_amount." Confirmed against a real document (OWNER-RETEST-2h-otto.md): the model read the
 * AMOUNT correctly (177.00, exact) but filed it in pre_tax_deduction_lines under category 'other' -
 * none of PRE_TAX_KEYWORDS above recognises it, and it is not a pension/PAWW/Ziektewet/WGA-Gat line at
 * all, so it stayed 'other' rather than being pulled out. Same "label decides" pattern as
 * classifyPreTaxDeductionLabel (§2e.4), used by tier-c.ts as a MAPPER-SIDE backstop: it reclassifies a
 * mislabelled pre-tax line into et_exchange_amount only when the model did not already report that
 * field directly (never overwrites an explicit reading, never double-counts by leaving the line in
 * both places - see mapExtractionToPeriod's own comment).
 *
 * Stage 2j (audit v30, §2j.2): "tighten isEtExchangeLabel so a reimbursement label ('Zwrot ...') never
 * matches, only a genuine base-reduction label does." The reviewer found the original `\bet\b`
 * alternative - added on the strength of the prompt's own "ET" search term, never confirmed against a
 * real base-reduction label that NEEDED it - also matches OTTO's own REIMBURSEMENT labels ("Zwrot
 * kosztów utrzymania ET", "Zwrot za zakwaterowanie ET", both ending in a standalone "ET" token).
 * Reclassifying a reimbursement line as the base reduction would inflate/replace et_exchange_amount and
 * silently drop the reimbursement. Dropped entirely, per §2.2/§2.3: the only real base-reduction label
 * confirmed so far ("Nieopod.") already matches via `nieopod` alone; nothing currently needs `\bet\b`,
 * and its cost (a confirmed false-positive surface) outweighs a benefit that was never evidenced.
 */
const ET_EXCHANGE_LABEL_PATTERN = /nieopod|extraterritorial/;

export function isEtExchangeLabel(description: string): boolean {
  return ET_EXCHANGE_LABEL_PATTERN.test(stripDiacritics(description));
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
 * Stage 2j (audit v30, §2j.1): "the chain has three positions on a document with ET, not two: gross
 * lines, gross minus pre-tax deductions ('loon voor heffingen'), and that minus the ET reduction (the
 * actual taxable base)." A pure arithmetic HYPOTHESIS, exactly like the loon-voor-heffingen hypothesis
 * next to it (`grossTotal - preTaxSum`) - never gated on any printed anchor confirming it, available
 * whenever pre-tax is known. The ONE place this is computed: `resolveAnchors` below calls it to test a
 * printed anchor against this third position, and `checkExtractionConsistency`'s own
 * `printed_tax_bases_do_not_reconcile` stage calls it directly to compare the printed base split
 * against it - no anchor confirmation required for that comparison either, exactly parallel to how
 * `gross_lines_do_not_reconcile` compares SUMMED gross lines against `printed_gross_total`, never "the
 * confirmed gross anchor." The two call sites can therefore never compute this differently again (the
 * defect RAPORT-cursor-2i.md's two MAJOR findings both trace back to: the 2i.2 check re-derived this
 * inline, disagreeing with what 2i.1's resolver would have said once a real ET-bearing document broke
 * the two-position assumption both were built on).
 */
export function resolveTaxableBasePosition(period: PayslipPeriod, grossTotal: number, preTaxSum: number | null): number | null {
  if (preTaxSum === null) return null;
  const etReduction = period.et?.et_applicable ? period.et.et_exchange_amount : 0;
  return Math.round((grossTotal - preTaxSum - etReduction) * 100) / 100;
}

/**
 * Stage 2f (§2f.2): "each stage runs when its own printed figure exists; it does not need the other
 * anchor. If exactly one subtotal was read, check it against both hypotheses... If it matches neither,
 * raise a finding that names both gaps." The Olympia trap (RAPORT-cursor-2e.md / OWNER-RETEST):
 * extraction read ONE number (844.92) and the prompt's own gross example put it in
 * printed_gross_total, when on this document it is actually loon_voor_heffingen - stage 2e's gate
 * required BOTH anchors to check anything, so it never noticed a single wrongly-labelled one. This
 * resolves which role a single printed subtotal actually plays, from the figures alone, never from
 * which field extraction happened to put it in.
 */
// Stage 2g (§2g.0d): the reviewer's T3 found a fifth case the four-value enum didn't distinguish - a
// document with no pre-tax deductions (or any pre-tax sum small enough that the two hypotheses land
// within tolerance of each other) makes `printedSubtotal` match BOTH the gross and loon-voor-heffingen
// hypotheses at once. The old code returned `confirmed_loon_voor_heffingen` for this (the `matchesLvh`
// check ran second and didn't check whether `matchesGross` had also been true) - asserting a role the
// arithmetic did not uniquely pick. `ambiguous_both_match` names this honestly: the number could be
// either, and the panel shows the neutral wording for it exactly like `unresolved`.
// Stage 2j (§2j.1): NEW - 'confirmed_taxable_base' names the OTTO shape: a printed anchor matches
// neither the gross nor the loon-voor-heffingen position, but does match the THIRD position (gross
// minus pre-tax minus the ET reduction) - the document prints its actual taxable base, mislabelled as
// gross or loon-voor-heffingen by the model, never a role any printed label decided (§2.13).
export type SubtotalRole = 'both' | 'confirmed_gross' | 'confirmed_loon_voor_heffingen' | 'confirmed_taxable_base' | 'ambiguous_both_match' | 'unresolved' | 'none';

export function resolveSubtotalRole(period: PayslipPeriod, grossTotal: number, preTaxSum: number | null): SubtotalRole {
  const hasGross = period.printed_gross_total !== null;
  const hasLvh = period.printed_loon_voor_heffingen !== null;
  if (hasGross && hasLvh) return 'both';
  if (!hasGross && !hasLvh) return 'none';
  const printedSubtotal = (hasGross ? period.printed_gross_total : period.printed_loon_voor_heffingen) as number;
  const lvhHypothesis = preTaxSum !== null ? grossTotal - preTaxSum : null;
  // n = the printed subtotal itself, plus every printed figure summed on each side of the hypothesis.
  const matchesGross = Math.abs(printedSubtotal - grossTotal) <= reconciliationTolerance(1 + period.hour_lines.length);
  const matchesLvh =
    lvhHypothesis !== null &&
    Math.abs(printedSubtotal - lvhHypothesis) <= reconciliationTolerance(1 + period.hour_lines.length + period.pre_tax_deductions.length);
  if (matchesGross && matchesLvh) return 'ambiguous_both_match';
  if (matchesGross) return 'confirmed_gross';
  if (matchesLvh) return 'confirmed_loon_voor_heffingen';
  return 'unresolved';
}

/**
 * Stage 2i (audit v29, §2i.1): "today the single-subtotal resolver runs only when one anchor is
 * present. Make it general. For each printed anchor, test its value against the two chain positions
 * ... to the derived tolerance." `resolveSubtotalRole`'s own early `if (hasGross && hasLvh) return
 * 'both'` never checked the arithmetic at all when both anchors exist - OTTO prints one number
 * (725.38) that reproduces the loon-voor-heffingen position exactly, sitting in `printed_gross_total`
 * (the document has no distinct gross total at all), while its OTHER anchor (621.14, the "normal"
 * taxable base) reproduces neither position - a role no printed label decided (§2.13).
 *
 * Kept as a SEPARATE function from `resolveSubtotalRole` (not a signature change to it): that
 * function is directly tested against a plain `SubtotalRole` string return value (2g.0d's T3 table),
 * and every one of its existing single-anchor/no-anchor cases is delegated to unchanged below - only
 * the two-anchor case gains new arithmetic it never had.
 */
export interface AnchorResolution {
  role: SubtotalRole;
  /** The one printed figure to use as "the" anchor downstream (for `resolvedLoonVoorHeffingen` in the
   * caller) - `null` only for `'both'` (both stay independently anchored, handled separately) and
   * `'none'` (nothing to resolve). */
  resolvedSubtotal: number | null;
  /** Stage 2i (§2i.1): "record anchor_reassigned in the trace" - true only when a printed figure that
   * looked like one role (by the field the model put it in) was resolved to the OTHER role by
   * arithmetic instead. */
  anchorReassigned: boolean;
  /** Stage 2i (§2i.1): "a printed figure that matches neither position is not a block - it moves to a
   * neutral list other_printed_figures." Populated only in the two-anchor reassignment case; the
   * single-anchor 'unresolved' case already has its own reporting path (printed_subtotal_role_unresolved). */
  otherPrintedFigures: number[];
}

/**
 * Stage 2k (audit v31, §2k.1): "treat et_exchange_amount === 0 (or absent) the same as no ET for the
 * purpose of widening the tolerance - the extra term is for the uncertainty of a real reduction
 * amount, not a reason to loosen a check that has nothing to reduce." The reviewer's finding
 * (RAPORT-cursor-2j.md): every site below widened its own tolerance by one term whenever
 * `et.et_applicable` was true, even when `et_exchange_amount` was exactly 0 - a printed figure could
 * then reassign to `confirmed_taxable_base` in `resolveAnchors` purely from the extra slack, not
 * because it actually reproduces a position distinct from loon-voor-heffingen (the two positions are
 * numerically IDENTICAL when the reduction is 0). One shared predicate, used everywhere a tolerance
 * widens for "the ET reduction is itself an extracted figure carrying its own uncertainty" - never for
 * the mere presence of an inapplicable-in-practice or zero-amount `et` field.
 */
function etReductionAddsUncertainty(period: PayslipPeriod): boolean {
  return period.et?.et_applicable === true && period.et.et_exchange_amount !== 0;
}

/**
 * Stage 2n (audit v35, §2n.1/§2n.2): "give the trace chain its missing stage: 'Totaal netto' = taxable
 * base minus both taxes, nothing else; 'Totaal' = that minus post-tax deductions plus reimbursements.
 * Two implied positions, not one compared against both." OWNER-RETEST-2n-otto.md, confirmed against
 * FIXTURES-paski-referencyjne.md's own "Podsuma wynagrodzenia" line (Krok 4: 725.38 − 77.52 − 40.08 =
 * 607.78, the document's own "Totaal netto"): OTTO's printed net sits at a THIRD, EARLIER position
 * than either `wage_net` or `period_net` can represent - before post-tax social deductions are ever
 * subtracted at all, not merely before net-lines (the ONLY axis the pre-2n code tested). The formula
 * RAPORT-cursor-2l.md's own T1a quoted verbatim (`resolveTaxableBasePosition − table_tax − bt_tax −
 * post_tax_sum`) had no term for this position, and no term for reimbursement lines anywhere either.
 *
 * Three candidate positions, all built from PRINTED/extracted figures (never engine-computed ones -
 * `discrepancy.ts`'s `resolveNetReconciliationBasis` is the parallel, engine-based version of this
 * same three-position idea, used for the discrepancy layer once the gate has already passed):
 * - `taxableBaseNet`: taxable base minus both taxes - nothing else subtracted or added yet.
 * - `beforeNetLines`: that minus post-tax social deductions (the pre-2n code's ONLY position).
 * - `afterNetLines`: that plus net additions, minus net deductions, plus ET reimbursement lines (the
 *   pre-2n code's "after" position never added ET reimbursements at all - the SAME missing term, since
 *   `payslip-model.ts`'s own engine already folds `et_reimbursements` into `net_additions_total`, the
 *   printed-figure identity here must match that same inclusion to stay consistent with the engine).
 *
 * One function, two callers (`checkNetStage` for the gate, `buildExtractionTrace` for the panel's own
 * `implied_net` display) - so the two can never show or block on a different position than the other.
 */
interface NetChainPositions {
  taxableBaseNet: number;
  beforeNetLines: number;
  afterNetLines: number;
}

function resolveNetChainPositions(taxableBasePos: number, tableTax: number, btTax: number, postTaxSum: number, period: PayslipPeriod): NetChainPositions {
  const taxableBaseNet = Math.round((taxableBasePos - tableTax - btTax) * 100) / 100;
  const beforeNetLines = Math.round((taxableBaseNet - postTaxSum) * 100) / 100;
  const netAdditionsSum = period.net_additions.reduce((sum, l) => sum + l.amount, 0);
  const netDeductionsSum = period.net_deductions.reduce((sum, l) => sum + l.amount, 0);
  const etReimbursementsSum = period.et?.et_applicable ? period.et.et_reimbursements.reduce((sum, r) => sum + r.amount, 0) : 0;
  const afterNetLines = Math.round((beforeNetLines + netAdditionsSum - netDeductionsSum + etReimbursementsSum) * 100) / 100;
  return { taxableBaseNet, beforeNetLines, afterNetLines };
}

type NetStageMatch = 'taxable_base_net' | 'before' | 'after';

interface NetStageResolution {
  /** null when printed_net matched none of the three positions to tolerance. */
  matchedPosition: NetStageMatch | null;
  /** The position to SHOW as `implied_net` - the matched one, or (when none matched) whichever is
   * numerically closest, so a genuine gap is reported against the true nearest figure. */
  displayValue: number;
  residual: number;
}

function resolveNetStageMatch(positions: NetChainPositions, printedNet: number, period: PayslipPeriod): NetStageResolution {
  // n: taxableBasePos + tableTax + btTax + printedNet, each a printed/extracted figure in its own right.
  const nTaxableBaseNet = 4;
  const nBeforeNetLines = nTaxableBaseNet + period.post_tax_social.length;
  const nAfterNetLines = nBeforeNetLines + period.net_additions.length + period.net_deductions.length + (period.et?.et_applicable ? period.et.et_reimbursements.length : 0);
  const candidates: Array<{ pos: NetStageMatch; value: number; n: number }> = [
    { pos: 'taxable_base_net', value: positions.taxableBaseNet, n: nTaxableBaseNet },
    { pos: 'before', value: positions.beforeNetLines, n: nBeforeNetLines },
    { pos: 'after', value: positions.afterNetLines, n: nAfterNetLines },
  ];
  const withResiduals = candidates.map((c) => ({ ...c, residual: Math.round((c.value - printedNet) * 100) / 100 }));
  const matched = withResiduals.find((c) => Math.abs(c.residual) <= reconciliationTolerance(c.n));
  if (matched) return { matchedPosition: matched.pos, displayValue: matched.value, residual: matched.residual };
  const closest = withResiduals.reduce((best, c) => (Math.abs(c.residual) < Math.abs(best.residual) ? c : best));
  return { matchedPosition: null, displayValue: closest.value, residual: closest.residual };
}

// Stage 2j (§2j.1): n for the taxable-base position - the printed subtotal itself, plus every printed
// figure summed to reach it (each hour line, each pre-tax line), plus one more for the ET reduction
// itself when it participates (one more extracted figure in the chain, same reasoning as every other
// term in reconciliationTolerance's own doc comment).
function taxableBaseTolerance(period: PayslipPeriod, preTaxCount: number): number {
  return reconciliationTolerance(1 + period.hour_lines.length + preTaxCount + (etReductionAddsUncertainty(period) ? 1 : 0));
}

export function resolveAnchors(period: PayslipPeriod, grossTotal: number, preTaxSum: number | null): AnchorResolution {
  const taxableBasePosition = resolveTaxableBasePosition(period, grossTotal, preTaxSum);
  const taxableBaseTolerance_ = taxableBaseTolerance(period, period.pre_tax_deductions.length);

  const baseRole = resolveSubtotalRole(period, grossTotal, preTaxSum);
  if (baseRole !== 'both') {
    const printedSubtotal = period.printed_gross_total ?? period.printed_loon_voor_heffingen;
    // Stage 2j (§2j.1): "every place... must test against the position appropriate to what ET does to
    // the chain" - a single printed anchor that resolveSubtotalRole found matches NEITHER of its two
    // positions gets one more chance against the third before falling back to 'unresolved'. Only ET
    // documents can reach this (taxableBasePosition collapses onto the lvh position otherwise, already
    // tested by resolveSubtotalRole), so this never changes behaviour for a non-ET document.
    if (baseRole === 'unresolved' && printedSubtotal !== null && taxableBasePosition !== null && Math.abs(printedSubtotal - taxableBasePosition) <= taxableBaseTolerance_) {
      return { role: 'confirmed_taxable_base', resolvedSubtotal: taxableBasePosition, anchorReassigned: true, otherPrintedFigures: [] };
    }
    // Single-anchor or no-anchor case: otherwise unchanged behaviour, delegated entirely.
    return { role: baseRole, resolvedSubtotal: printedSubtotal, anchorReassigned: false, otherPrintedFigures: [] };
  }

  const gross = period.printed_gross_total as number;
  const lvh = period.printed_loon_voor_heffingen as number;
  const lvhHypothesis = preTaxSum !== null ? grossTotal - preTaxSum : null;
  const grossTolerance = reconciliationTolerance(1 + period.hour_lines.length);
  const lvhTolerance = reconciliationTolerance(1 + period.hour_lines.length + period.pre_tax_deductions.length);
  const grossMatchesGrossPos = Math.abs(gross - grossTotal) <= grossTolerance;
  const grossMatchesLvhPos = lvhHypothesis !== null && Math.abs(gross - lvhHypothesis) <= lvhTolerance;
  const grossMatchesTaxableBasePos = taxableBasePosition !== null && Math.abs(gross - taxableBasePosition) <= taxableBaseTolerance_;
  const lvhMatchesLvhPos = lvhHypothesis !== null && Math.abs(lvh - lvhHypothesis) <= lvhTolerance;
  const lvhMatchesGrossPos = Math.abs(lvh - grossTotal) <= grossTolerance;
  const lvhMatchesTaxableBasePos = taxableBasePosition !== null && Math.abs(lvh - taxableBasePosition) <= taxableBaseTolerance_;

  // Normal case: each anchor confirms its OWN expected position - nothing changes.
  if (grossMatchesGrossPos && lvhMatchesLvhPos) {
    return { role: 'both', resolvedSubtotal: null, anchorReassigned: false, otherPrintedFigures: [] };
  }
  // Stage 2j (§2j.1): OTTO's REAL shape (post-2i.3, ET correctly pulled out of pre-tax) - printed_gross_total
  // (725.38) matches NEITHER the gross position (924.03) NOR the pre-ET lvh position (902.38), but does
  // match the THIRD, ET-reduced taxable-base position exactly; printed_loon_voor_heffingen (621.14, the
  // "normal" base component of the split) matches none of the three at all. This is the case 2i.1's
  // original two-position resolver could never reach - both of its own reassignment branches below
  // required the OTHER anchor to still confirm the LVH or GROSS position, which never happens here.
  if (!grossMatchesGrossPos && !grossMatchesLvhPos && grossMatchesTaxableBasePos && !lvhMatchesLvhPos && !lvhMatchesGrossPos && !lvhMatchesTaxableBasePos) {
    return { role: 'confirmed_taxable_base', resolvedSubtotal: gross, anchorReassigned: true, otherPrintedFigures: [lvh] };
  }
  // The symmetric shape: printed_loon_voor_heffingen is actually the taxable-base figure.
  if (!lvhMatchesLvhPos && !lvhMatchesGrossPos && lvhMatchesTaxableBasePos && !grossMatchesGrossPos && !grossMatchesLvhPos && !grossMatchesTaxableBasePos) {
    return { role: 'confirmed_taxable_base', resolvedSubtotal: lvh, anchorReassigned: true, otherPrintedFigures: [gross] };
  }
  // 2i.1's original shape (no ET, or ET present but this pair still cleanly swaps gross<->lvh):
  // printed_gross_total is actually the loon-voor-heffingen figure; printed_loon_voor_heffingen matches
  // neither position at all (and, now, does not coincidentally match the taxable-base position either).
  if (!grossMatchesGrossPos && grossMatchesLvhPos && !lvhMatchesLvhPos && !lvhMatchesGrossPos && !lvhMatchesTaxableBasePos) {
    return { role: 'confirmed_loon_voor_heffingen', resolvedSubtotal: gross, anchorReassigned: true, otherPrintedFigures: [lvh] };
  }
  // The symmetric shape: printed_loon_voor_heffingen is actually the gross figure; printed_gross_total
  // matches neither position (and not the taxable-base position either).
  if (!lvhMatchesLvhPos && lvhMatchesGrossPos && !grossMatchesGrossPos && !grossMatchesLvhPos && !grossMatchesTaxableBasePos) {
    return { role: 'confirmed_gross', resolvedSubtotal: lvh, anchorReassigned: true, otherPrintedFigures: [gross] };
  }
  // Any other combination (both ambiguous, both fail, or an overlap not covered above) - the
  // arithmetic did not uniquely pick a reassignment, so trust the model's own field labels as before;
  // the unchanged stage-1/2/3 checks below still catch a genuine inconsistency on their own.
  return { role: 'both', resolvedSubtotal: null, anchorReassigned: false, otherPrintedFigures: [] };
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
  /** Stage 2l (audit v32, §2l.2): "a flagged amount should not sit inside a sum shown as fact." True
   * only when this line's own field path was named in `amount_unreadable` (the guard's text-layer
   * verification, or a non-finite raw value) - the panel must show it as excluded from the sum above,
   * never silently drop the row itself (§2.2: the gap between "what's summed" and "what's printed"
   * stays visible). Always false when the caller passed no flagged paths at all (every existing
   * `buildExtractionTrace` call site, and the clean/'ok' path, which never has any). */
  flagged: boolean;
}

export interface ExtractionTrace {
  hour_lines: ExtractionTraceLine[];
  gross_total: number;
  /** Stage 2f (§2f.2): "the panel must not label a subtotal 'gross' unless it reconciles as gross;
   * until then it shows 'printed subtotal'." 'both' means both anchors were read (labels trusted as
   * given); 'confirmed_gross'/'confirmed_loon_voor_heffingen' means exactly one was read and the
   * arithmetic confirmed which role it plays; 'unresolved' means it matched neither (the interface
   * must show the neutral "printed subtotal" wording, never assert a role); 'none' means neither
   * anchor was read at all. */
  printed_subtotal_role: SubtotalRole;
  printed_gross_total: number | null;
  pre_tax_deductions: ExtractionTraceLine[];
  pre_tax_deductions_sum: number | null;
  loon_voor_heffingen: number | null;
  printed_loon_voor_heffingen: number | null;
  /** Stage 2l (audit v32, §2l.1): "show the ET reduction as its own step between loon voor heffingen
   * and implied net, so the implied line is the sum of the rows the panel just printed" - the reviewer's
   * own finding (RAPORT-cursor-2k.md): `implied_net` was already computed from the post-ET taxable base
   * (since 2j.1's fix), but the panel jumped straight from the pre-ET `loon_voor_heffingen` line to
   * `implied_net` with no visible step for the 177.00 EUR in between. null when ET is not applicable to
   * this document at all - never 0 for "not applicable" (that would look like a real, printed zero
   * reduction rather than an absent one). */
  et_reduction: number | null;
  /** Stage 2l (§2l.1): the actual taxable-base position (loon_voor_heffingen minus et_reduction) - the
   * SAME value `resolveTaxableBasePosition` computes for the gate and for `implied_net` below, exposed
   * here so the panel can show the full chain even on the `amount_unreadable`-blocked trace (which has
   * no `outcome`, so `computed_taxable_base` below is null there) - computed from the period alone,
   * never gated on the engine having run. */
  taxable_base_position: number | null;
  printed_table_tax: number | null;
  printed_bt_tax: number | null;
  /** Stage 2f (§2f.4): null when the caller could not compute AT ALL (an unread period_type or
   * et_exchange_amount blocks the whole computation, not just the tax step) - never a figure computed
   * from a guessed multiplier or a silently-zeroed base and shown as if it meant something. */
  computed_taxable_base: number | null;
  computed_table_tax_after_korting: number | null;
  post_tax_social: ExtractionTraceLine[];
  post_tax_deductions_sum: number | null;
  implied_net: number | null;
  printed_net: number | null;
  net_additions: ExtractionTraceLine[];
  net_deductions: ExtractionTraceLine[];
  /** Stage 2n (audit v35, §2n.1): "find out whether the reimbursement lines were read at all this
   * round." Before this, `period.et.et_reimbursements` was used internally (the 2i.3 arithmetic
   * confirmation, the 2n.2 payout formula) but never shown anywhere on the panel - an empty list and a
   * genuinely-unread one were visually identical (both silence), so a real gap in what the model read
   * could not be told apart from "this document has no ET reimbursements" just by looking. Always an
   * array (never null) - empty when et is not applicable, or when the extraction genuinely found none. */
  et_reimbursements: ExtractionTraceLine[];
  implied_payout: number | null;
  printed_payout: number | null;
  /** Stage 2g (§2g.5): "the trace records reading_basis: text_layer_verified when 2g.3 ran, or
   * image_only when there was no text layer." Defaults to 'image_only' for every existing caller
   * (unit tests, and any path with no text layer) - only the controller, holding the real
   * `documentText` from the request, can say `'text_layer_verified'`. */
  reading_basis: 'text_layer_verified' | 'image_only';
  /** Stage 2g (§2g.4): "printed amounts that were not used" - a stated gap, never a finding on its
   * own (a rate, a percentage base, or a reservation balance also prints two-decimal numbers that are
   * not payment amounts, so an unused item is a possibility, not proof of a missing line). */
  unused_printed_amounts: { count: number; sample: number[] };
  /** Stage 2h (audit v28, §2h.4): "numbers that let a real upload speak (no content)." Every field
   * here is a count or a status code, never a text item, a label or an amount from the document
   * itself (grepped for at every call site that logs or forwards this object - see the report). This
   * is what the owner's one real-PDF upload result is read from, per the stage's own "why". */
  technical_details: {
    text_items_sent: number;
    amounts_checked: number;
    amounts_not_found: number;
    text_layer_status: 'ok' | 'mismatch' | 'too_large' | 'none';
    request_size_kb: number;
    /** Stage 2i (§2i.0e): "when Content-Length is absent or disagrees with the re-encoded size by
     * more than a margin, show the measured size and say which." Which of the two numbers
     * `request_size_kb` actually is. */
    request_size_source: 'content_length' | 'measured';
    /** Stage 2i (§2i.0d): "put the chosen step in the technical line." */
    render_step: string;
  };
  /** Stage 2i (audit v29, §2i.0b): "the dual net position is visible, and the layers still catch it."
   * `'before'`/`'after'` name which chain position the printed net actually confirmed (Olympia/
   * Randstad print theirs before net additions/deductions, PKF's is after); `'both'` when the two
   * positions coincide (no net lines, or they cancel out); `'none'` when nothing was printed there,
   * the computation never ran, or the printed figure matches neither position (a genuine gap, still
   * reported separately as `net_does_not_reconcile`/`net_mismatch` - this field never hides that).
   * Stage 2n (§2n.2): NEW - `'before_post_tax'` names OTTO's own "Totaal netto" position (taxable base
   * minus both taxes, nothing else) - a THIRD, earlier position `'before'`/`'after'` (both always
   * post-tax) can never represent. */
  net_position: 'before_post_tax' | 'before' | 'after' | 'both' | 'none';
  /** Stage 2i (audit v29, §2i.1): "record anchor_reassigned in the trace." True only when a printed
   * figure that sat in one anchor field (e.g. `printed_gross_total`) was resolved by arithmetic to
   * actually be the OTHER role (OTTO: 725.38 sits in `printed_gross_total` but reproduces the
   * loon-voor-heffingen position, not the gross-lines-sum one - the document prints no gross total
   * at all). Never true for the ordinary single-anchor case, only the two-anchor reassignment. */
  anchor_reassigned: boolean;
  /** Stage 2i (§2i.1): "a printed figure that matches neither position... moves to a neutral list
   * other_printed_figures, and is shown as such." OTTO's 621.14 (the "normal" taxable base, a real
   * printed number that is simply not either chain-position anchor) lands here instead of blocking. */
  other_printed_figures: number[];
  /** Stage 2i (audit v29, §2i.2): OTTO's own taxable-base split, shown whenever the document printed
   * one - null/null on every document that prints a single, undivided base (the common case). Never
   * asserted from the resolved anchor above; these are only what the document itself printed. */
  printed_taxable_base_normal: number | null;
  printed_taxable_base_special: number | null;
}

/** Everything about a request's text-layer handling that only the controller (holding the raw HTTP
 * request and the pre-fallback verification counts) can know - see `tier-c.controller.ts`'s
 * `assessTextLayer`. Every field defaults so existing unit-test call sites (no text layer at all)
 * need no changes. */
export interface ExtractionTraceMeta {
  textLayerStatus: 'ok' | 'mismatch' | 'too_large' | 'none';
  requestSizeKb: number;
  requestSizeSource: 'content_length' | 'measured';
  renderStep: string;
  textItemsSent: number;
  amountsChecked: number;
  amountsNotFound: number;
  /** Stage 2l (§2l.2): the exact `amount_unreadable` field paths (e.g. "hour_lines[7].amount",
   * "pre_tax_deductions[0].amount") the controller already raised as gaps - only the controller,
   * holding the raw extraction's `unreadable_amount_fields` and the guard's own `unverifiedFields`,
   * knows this. Defaults to empty for every existing caller (the 'ok' path never has any at this
   * point - see mapExtractionToPeriod's own callers). */
  flaggedFieldPaths: string[];
}

function traceLine(description: string, category: string, amount: number | null, provenance = 'payslip_extracted', flagged = false): ExtractionTraceLine {
  return { label: description, category, amount, provenance, flagged };
}

// Stage 2l (§2l.2): matches an `amount_unreadable` field path (e.g. "hour_lines[7].amount") to the
// hour_lines/pre_tax_deductions index it names - the only two lists this stage's fix scopes to (the
// ones feeding gross_total/pre_tax_deductions_sum, the two sums the owner's report showed a flagged
// guess silently sitting inside).
const HOUR_LINE_AMOUNT_PATH = /^hour_lines\[(\d+)\]\.amount$/;
const PRE_TAX_AMOUNT_PATH = /^pre_tax_deductions\[(\d+)\]\.amount$/;

function flaggedIndices(paths: string[], pattern: RegExp): Set<number> {
  const out = new Set<number>();
  for (const path of paths) {
    const match = pattern.exec(path);
    if (match) out.add(Number(match[1]));
  }
  return out;
}

/** Stage 2i (§2i.0b): translates `resolveNetReconciliationBasis`'s own vocabulary (shared with
 * `discrepancy.ts`'s `net_mismatch`, so the two can never disagree) into the trace's plain-language
 * one - 'wage_net'/'period_net' are engine field names, not something the panel should ever show.
 * Exported so the controller can attach the identical value to a successful `'ok'` response too -
 * the assignment's own "say it on the panel" is not limited to the unreliable trace view. */
export function resolveNetPosition(period: PayslipPeriod, outcome: PayslipComputationOutcome | null): ExtractionTrace['net_position'] {
  if (outcome === null) return 'none';
  const basis = resolveNetReconciliationBasis(outcome, period.printed_net, tableTaxToleranceFor(period.period_type));
  if (basis === 'taxable_base_net') return 'before_post_tax';
  if (basis === 'wage_net') return 'before';
  if (basis === 'period_net') return 'after';
  if (basis === 'both') return 'both';
  return 'none'; // 'neither' or 'not_applicable' - no confirmed position to show
}

export function buildExtractionTrace(
  period: PayslipPeriod,
  outcome: PayslipComputationOutcome | null,
  textItems: DocumentTextItem[] = [],
  meta: Partial<ExtractionTraceMeta> = {},
): ExtractionTrace {
  // Stage 2l (§2l.2): "a flagged amount should not sit inside a sum shown as fact." A field named in
  // `amount_unreadable` is excluded from the sum it would otherwise feed - never silently dropped from
  // the trace entirely, which is why the line itself is still built below, just marked `flagged: true`.
  const flaggedFieldPaths = meta.flaggedFieldPaths ?? [];
  const flaggedHourLineIndices = flaggedIndices(flaggedFieldPaths, HOUR_LINE_AMOUNT_PATH);
  const flaggedPreTaxIndices = flaggedIndices(flaggedFieldPaths, PRE_TAX_AMOUNT_PATH);
  const grossTotal = period.hour_lines.reduce((sum, line, i) => (flaggedHourLineIndices.has(i) ? sum : sum + line.amount), 0);
  const preTaxLines = period.pre_tax_deductions.map((d, i) => traceLine(d.description, d.category, d.amount.value, d.amount.provenance, flaggedPreTaxIndices.has(i)));
  const preTaxSum = sumKnownAmounts(period.pre_tax_deductions.filter((_, i) => !flaggedPreTaxIndices.has(i)).map((d) => d.amount));
  const postTaxLines = period.post_tax_social.map((d) => traceLine(d.description, d.category, d.amount.value, d.amount.provenance));
  const postTaxSum = sumKnownAmounts(period.post_tax_social.map((d) => d.amount));
  const loonVoorHeffingen = preTaxSum !== null ? Math.round((grossTotal - preTaxSum) * 100) / 100 : null;
  const tableTax = period.printed_table_tax; // never defaulted - see resolveBtTaxComponent's doc comment
  const btTax = resolveBtTaxComponent(period);
  // Stage 2j (§2j.1): the taxable-base position (loon voor heffingen minus the ET reduction, via the
  // SAME shared resolver the gate uses), not raw loon-voor-heffingen - this panel figure used to omit
  // the ET reduction entirely, overstating implied_net by exactly the ET amount on any ET-bearing
  // document (the same bug class as checkNetStage's own pre-2j formula). `loon_voor_heffingen` above
  // keeps its own, distinct meaning (the pre-ET position) unchanged - only this summary figure moves.
  const taxableBasePosition = resolveTaxableBasePosition(period, grossTotal, preTaxSum);
  // Stage 2l (§2l.1): the ET reduction itself, as its own explicit step - null (never 0) when ET is not
  // applicable to this document, exactly the same "absent vs. genuinely zero" distinction every other
  // printed/extracted figure in this trace already makes.
  const etReduction = period.et?.et_applicable ? period.et.et_exchange_amount : null;
  // Stage 2n (§2n.2): "give the trace chain its missing stage... two implied positions, not one
  // compared against both." The SAME resolveNetChainPositions/resolveNetStageMatch checkNetStage uses -
  // so the panel's own implied_net can never show a different figure than what the gate actually
  // validated (or blocked on). When printed_net matches one of the three positions, that position is
  // shown; when it matches none (or is absent), the pre-tax-social position ('before', the historical
  // default) is shown, unchanged from pre-2n behaviour for that case.
  const netChainPositions =
    taxableBasePosition !== null && postTaxSum !== null && tableTax !== null && btTax !== null
      ? resolveNetChainPositions(taxableBasePosition, tableTax, btTax, postTaxSum, period)
      : null;
  const netStageMatch = netChainPositions !== null && period.printed_net !== null ? resolveNetStageMatch(netChainPositions, period.printed_net, period) : null;
  const impliedNet = netChainPositions === null ? null : (netStageMatch?.displayValue ?? netChainPositions.beforeNetLines);
  // Stage 2n (§2n.2): the SAME position-aware, printed_net-derived formula section 4b's own gate check
  // uses (see that section's own comment) - never a chain-derived formula independent of printed_net,
  // which would need tax figures this panel display should not require just to show a number.
  const netAdditionsSum = period.net_additions.reduce((sum, l) => sum + l.amount, 0);
  const netDeductionsSum = period.net_deductions.reduce((sum, l) => sum + l.amount, 0);
  const etReimbursementsSum = period.et?.et_applicable ? period.et.et_reimbursements.reduce((sum, r) => sum + r.amount, 0) : 0;
  const payoutAdjustmentsSum = period.payout_adjustments.reduce((sum, l) => sum + l.amount, 0);
  const impliedPayout =
    period.printed_net === null
      ? null
      : Math.round(
          (netStageMatch?.matchedPosition === 'after'
            ? period.printed_net + payoutAdjustmentsSum
            : netStageMatch?.matchedPosition === 'taxable_base_net' && postTaxSum !== null
              ? period.printed_net - postTaxSum + netAdditionsSum - netDeductionsSum + etReimbursementsSum + payoutAdjustmentsSum
              : period.printed_net + netAdditionsSum - netDeductionsSum + etReimbursementsSum + payoutAdjustmentsSum) * 100,
        ) / 100;
  const taxFields = outcome === null ? null : outcome.status === 'complete' ? outcome.result : outcome;
  // Stage 2i (§2i.1): the SAME resolver the gate uses, so the trace's own printed_subtotal_role,
  // anchor_reassigned and other_printed_figures can never disagree with what actually blocked (or
  // didn't) - `checkExtractionConsistency` and `buildExtractionTrace` stay independent, side-effect-
  // free functions, but both read the SAME piece of arithmetic here rather than each deciding alone.
  const anchorResolution = resolveAnchors(period, grossTotal, preTaxSum);

  return {
    hour_lines: period.hour_lines.map((l, i) => traceLine(l.description, l.category, l.amount, undefined, flaggedHourLineIndices.has(i))),
    gross_total: Math.round(grossTotal * 100) / 100,
    printed_subtotal_role: anchorResolution.role,
    printed_gross_total: period.printed_gross_total,
    pre_tax_deductions: preTaxLines,
    pre_tax_deductions_sum: preTaxSum,
    loon_voor_heffingen: loonVoorHeffingen,
    printed_loon_voor_heffingen: period.printed_loon_voor_heffingen,
    et_reduction: etReduction,
    taxable_base_position: taxableBasePosition,
    printed_table_tax: period.printed_table_tax,
    printed_bt_tax: period.printed_bt_tax,
    computed_taxable_base: taxFields === null ? null : taxFields.taxable_base,
    computed_table_tax_after_korting: taxFields === null ? null : taxFields.table_tax_after_korting,
    post_tax_social: postTaxLines,
    post_tax_deductions_sum: postTaxSum,
    implied_net: impliedNet,
    printed_net: period.printed_net,
    net_additions: period.net_additions.map((l) => traceLine(l.description, l.category, l.amount)),
    net_deductions: period.net_deductions.map((l) => traceLine(l.description, l.category, l.amount)),
    et_reimbursements: period.et?.et_applicable ? period.et.et_reimbursements.map((r) => traceLine(r.description, 'et_reimbursement', r.amount)) : [],
    implied_payout: impliedPayout,
    printed_payout: period.printed_payout,
    reading_basis: textItems.length > 0 ? 'text_layer_verified' : 'image_only',
    unused_printed_amounts: (() => {
      const unused = findUnusedPrintedAmounts(period, textItems);
      return { count: unused.length, sample: unused.slice(0, 5) };
    })(),
    technical_details: {
      text_items_sent: meta.textItemsSent ?? textItems.length,
      amounts_checked: meta.amountsChecked ?? 0,
      amounts_not_found: meta.amountsNotFound ?? 0,
      text_layer_status: meta.textLayerStatus ?? (textItems.length > 0 ? 'ok' : 'none'),
      request_size_kb: meta.requestSizeKb ?? 0,
      request_size_source: meta.requestSizeSource ?? 'measured',
      render_step: meta.renderStep ?? 'unknown',
    },
    net_position: resolveNetPosition(period, outcome),
    anchor_reassigned: anchorResolution.anchorReassigned,
    other_printed_figures: anchorResolution.otherPrintedFigures,
    printed_taxable_base_normal: period.printed_taxable_base_normal,
    printed_taxable_base_special: period.printed_taxable_base_special,
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

  // Stage 2i (§2i.4): "make an absent [printed table/BT tax] a stated gap, never zero" -
  // unconditionally, not only when a net-reconciliation stage below happens to run (both of those
  // require a printed_net to compare against, which OTTO's own document never prints at all -
  // printed_table_tax being genuinely unread on that kind of document previously produced total
  // silence, not a reported gap, per OWNER-RETEST-2h-otto.md: "printed table tax | unknown | ... |
  // not read"). Only fires here when printed_net is ABSENT; when it is present, checkNetStage/the
  // 'none' branch below already raise this exact same code from the identical condition - pushing it
  // again here would duplicate the same issue in the list for no new information.
  if (period.printed_net === null && period.hour_lines.length > 0 && (period.printed_table_tax === null || resolveBtTaxComponent(period) === null)) {
    issues.push({ code: 'printed_tax_unknown' });
  }

  // Stage 2n (§2n.2): "give the trace chain its missing stage... two implied positions, not one
  // compared against both." Which of the three chain-stage/checkNetStage below actually matched
  // `printed_net` - section 4b's own payout formula reads this (never re-deriving it independently)
  // so the two stay consistent about which position printed_net occupies. `null` means either
  // checkNetStage never ran (tax unknown, or no printed_net at all) or ran and matched nothing -
  // section 4b falls back to the historical 'before' assumption in both cases, exactly like the
  // pre-2n code always did regardless of whether the net stage itself had anything to say.
  let netStageMatchedPosition: NetStageMatch | null = null;

  function checkNetStage(taxableBasePos: number): void {
    if (period.printed_net === null || postTaxSumForReconciliation === null) return;
    const tableTax = period.printed_table_tax;
    const btTax = resolveBtTaxComponent(period);
    if (tableTax === null || btTax === null) {
      issues.push({ code: 'printed_tax_unknown' });
      return;
    }
    // Stage 2n (§2n.2): three positions, not two - see resolveNetChainPositions/resolveNetStageMatch's
    // own doc comment for OTTO's "Totaal netto" shape this now catches (taxable base minus both taxes,
    // nothing else - the position the pre-2n code never tested at all).
    const positions = resolveNetChainPositions(taxableBasePos, tableTax, btTax, postTaxSumForReconciliation, period);
    const match = resolveNetStageMatch(positions, period.printed_net, period);
    if (match.matchedPosition !== null) {
      netStageMatchedPosition = match.matchedPosition;
      return;
    }
    issues.push({ code: 'net_does_not_reconcile', implied_net: match.displayValue, printed_net: period.printed_net, residual: match.residual });
  }

  // Stage 2i (§2i.1): resolves BOTH anchors by arithmetic (not just the single-anchor case) - see
  // resolveAnchors's own doc comment for the OTTO shape this exists to catch.
  const anchorResolution = resolveAnchors(period, grossTotal, preTaxSumForReconciliation);
  const subtotalRole = anchorResolution.role;

  // Stage 2j (§2j.1): "delete the inline ET-subtraction in printed_tax_bases_do_not_reconcile and call
  // the shared resolver instead." The 2i.2 version of this check re-derived "the loon-voor-heffingen
  // position" from `anchorResolution` (only defined when an ANCHOR happened to confirm a position) and
  // then subtracted ET from THAT - on OTTO's real, mislabelled anchors (subtotalRole 'both' before this
  // stage's own fix, now 'confirmed_taxable_base'), `period.printed_loon_voor_heffingen` held 621.14
  // (the NORMAL base component of the split, not a whole-chain position at all) - 621.14 minus 177 ET
  // gave a false 444.14 "total" (RAPORT-cursor-2i.md's second MAJOR finding). `resolveTaxableBasePosition`
  // is a pure arithmetic hypothesis from gross/pre-tax/ET alone - it needs no anchor to have confirmed
  // anything, exactly parallel to how gross_lines_do_not_reconcile compares SUMMED gross against
  // printed_gross_total, never "the confirmed gross anchor". The SAME function resolveAnchors calls
  // above to test the third chain position - the two can never disagree again.
  const resolvedTaxableBaseForBasesCheck = resolveTaxableBasePosition(period, grossTotal, preTaxSumForReconciliation);
  if (period.printed_taxable_base_normal !== null && period.printed_taxable_base_special !== null && resolvedTaxableBaseForBasesCheck !== null) {
    const impliedTotal = Math.round((period.printed_taxable_base_normal + period.printed_taxable_base_special) * 100) / 100;
    const residual = Math.round((impliedTotal - resolvedTaxableBaseForBasesCheck) * 100) / 100;
    // n: normal base, special base, the resolved total itself, plus the ET reduction when it actually
    // adds uncertainty (§2k.1: not merely when et_applicable is true with a zero amount).
    if (Math.abs(residual) > reconciliationTolerance(etReductionAddsUncertainty(period) ? 4 : 3)) {
      issues.push({ code: 'printed_tax_bases_do_not_reconcile', implied_total: impliedTotal, printed_total: resolvedTaxableBaseForBasesCheck, residual });
    }
  }

  if (subtotalRole === 'both') {
    // Stage 2f (§2f.3): a document where the printed gross is smaller than the printed loon voor
    // heffingen cannot be real - loon voor heffingen is gross minus (nonnegative) deductions. Block
    // before running the three stages, which would otherwise report confusing negative residuals.
    if ((period.printed_gross_total as number) < (period.printed_loon_voor_heffingen as number)) {
      issues.push({ code: 'anchors_inverted', printed_gross_total: period.printed_gross_total as number, printed_loon_voor_heffingen: period.printed_loon_voor_heffingen as number });
    } else {
      // Stage 1: sum(gross lines) vs the document's own printed gross total.
      const grossResidual = Math.round((grossTotal - (period.printed_gross_total as number)) * 100) / 100;
      // n: each gross line, plus the printed gross total itself.
      if (Math.abs(grossResidual) > reconciliationTolerance(1 + period.hour_lines.length)) {
        issues.push({ code: 'gross_lines_do_not_reconcile', summed_gross: Math.round(grossTotal * 100) / 100, printed_gross_total: period.printed_gross_total as number, residual: grossResidual });
      }

      // Stage 2: printed gross total minus pre-tax deductions vs the document's own printed loon voor
      // heffingen. Uses the PRINTED gross (not the possibly-wrong summed gross) as the stage-2 base, so
      // a stage-1 failure does not also mask or distort stage 2 - each stage checks its own link only.
      if (preTaxSumForReconciliation !== null) {
        const impliedLoonVoorHeffingen = (period.printed_gross_total as number) - preTaxSumForReconciliation;
        const preTaxResidual = Math.round((impliedLoonVoorHeffingen - (period.printed_loon_voor_heffingen as number)) * 100) / 100;
        // n: printed gross total, printed loon voor heffingen, each pre-tax deduction line.
        if (Math.abs(preTaxResidual) > reconciliationTolerance(2 + period.pre_tax_deductions.length)) {
          issues.push({ code: 'pre_tax_does_not_reconcile', implied_loon_voor_heffingen: Math.round(impliedLoonVoorHeffingen * 100) / 100, printed_loon_voor_heffingen: period.printed_loon_voor_heffingen as number, residual: preTaxResidual });
        }
      }

      // Stage 3: the document's actual taxable-base position (gross voor heffingen, minus the ET
      // reduction when applicable - Stage 2j §2j.1: "every place that currently tests a printed anchor
      // against 'the loon-voor-heffingen position' must test against the position appropriate to what
      // ET does to the chain") minus tax minus post-tax vs the document's own printed net.
      checkNetStage(resolveTaxableBasePosition(period, grossTotal, preTaxSumForReconciliation) as number);
    }
  } else if (
    subtotalRole === 'confirmed_gross' ||
    subtotalRole === 'confirmed_loon_voor_heffingen' ||
    subtotalRole === 'confirmed_taxable_base' ||
    subtotalRole === 'ambiguous_both_match' ||
    subtotalRole === 'unresolved'
  ) {
    // Stage 2f (§2f.2): exactly one printed subtotal was read. Test it against both hypotheses rather
    // than trusting whichever field extraction happened to put it in (the Olympia trap: one number,
    // read into printed_gross_total, that is actually loon_voor_heffingen).
    //
    // Stage 2i (§2i.1): `resolvedSubtotal` (not a plain `??` fallback) - when this branch was reached
    // via a TWO-anchor reassignment (OTTO's shape), the "confirmed" figure could be EITHER printed
    // field depending on which one the arithmetic actually matched, not always printed_gross_total.
    const printedSubtotal = anchorResolution.resolvedSubtotal as number;
    if (subtotalRole === 'unresolved') {
      const lvhHypothesis = preTaxSumForReconciliation !== null ? grossTotal - preTaxSumForReconciliation : null;
      issues.push({
        code: 'printed_subtotal_role_unresolved',
        printed_subtotal: printedSubtotal,
        gross_hypothesis: Math.round(grossTotal * 100) / 100,
        loon_voor_heffingen_hypothesis: lvhHypothesis !== null ? Math.round(lvhHypothesis * 100) / 100 : null,
      });
    } else {
      // Stage 2g (§2g.0d): confirmed as one role, or `ambiguous_both_match` (both hypotheses coincide,
      // typically because pre-tax deductions are ~0) - either way `printedSubtotal` IS the number to
      // use for stage 3, converted to the taxable-base position appropriate to its OWN confirmed role
      // (Stage 2j §2j.1): `confirmed_gross` still needs pre-tax AND the ET reduction subtracted;
      // `confirmed_loon_voor_heffingen`/`ambiguous_both_match` (both already post-pre-tax) still need
      // just the ET reduction subtracted; `confirmed_taxable_base` (NEW) is already the taxable base -
      // no further subtraction, subtracting again would double-apply the ET reduction. The confirmed/
      // ambiguous anchor is real information even though only one number was printed - stage 3 still
      // runs; only the PANEL'S LABEL stays neutral for `ambiguous_both_match`, never asserting which
      // role the figure plays.
      const etReductionForStage3 = period.et?.et_applicable ? period.et.et_exchange_amount : 0;
      const resolvedTaxableBase =
        subtotalRole === 'confirmed_gross'
          ? preTaxSumForReconciliation !== null
            ? Math.round((printedSubtotal - preTaxSumForReconciliation - etReductionForStage3) * 100) / 100
            : null
          : subtotalRole === 'confirmed_taxable_base'
            ? printedSubtotal
            : Math.round((printedSubtotal - etReductionForStage3) * 100) / 100; // confirmed_loon_voor_heffingen / ambiguous_both_match
      if (resolvedTaxableBase !== null) checkNetStage(resolvedTaxableBase);
    }
  } else if (period.printed_net !== null && preTaxSumForReconciliation !== null && postTaxSumForReconciliation !== null) {
    // subtotalRole === 'none': the old combined identity, using the summed (not printed) gross - the
    // only path left with no printed subtotal to anchor a staged check against at all.
    const tableTax = period.printed_table_tax;
    const btTax = resolveBtTaxComponent(period);
    if (tableTax === null || btTax === null) {
      issues.push({ code: 'printed_tax_unknown' });
    } else {
      // Stage 2j (§2j.1): the shared resolver, not a fifth re-derivation of "gross minus pre-tax minus
      // ET" - this branch previously omitted the ET reduction entirely (an ET-bearing document with no
      // printed subtotal at all would have had its implied net overstated by exactly the ET amount).
      const impliedTaxableBase = resolveTaxableBasePosition(period, grossTotal, preTaxSumForReconciliation) as number;
      const impliedNet = impliedTaxableBase - tableTax - btTax - postTaxSumForReconciliation;
      const residual = Math.round((impliedNet - period.printed_net) * 100) / 100;
      // n: each gross/pre-tax/post-tax line, table tax, BT tax, printed net, plus the ET reduction
      // itself when it actually adds uncertainty (§2k.1).
      const n = 3 + period.hour_lines.length + period.pre_tax_deductions.length + period.post_tax_social.length + (etReductionAddsUncertainty(period) ? 1 : 0);
      if (Math.abs(residual) > reconciliationTolerance(n)) {
        issues.push({ code: 'totals_do_not_reconcile_net', implied_net: Math.round(impliedNet * 100) / 100, printed_net: period.printed_net, residual });
      }
    }
  }

  // 4b. Totaal netto -> Totaal (§2n.2): "'Totaal' = [taxable base minus both taxes] minus post-tax
  // deductions plus reimbursements." Built FROM `printed_net`, adjusted by whatever comes AFTER
  // whichever position it actually occupies (`netStageMatchedPosition`, resolved once by checkNetStage
  // above - the two can never disagree about which position printed_net is at). Falls back to the
  // historical 'before' assumption (post-tax already applied, pre-net-lines) whenever that position is
  // unknown - tax unread, no printed_net at all, or printed_net matched none of the three positions -
  // exactly the pre-2n code's own unconditional assumption, so a document where tax was never read
  // (this check's only real precondition before 2n) is UNCHANGED, not newly blocked. The ONE thing
  // that changes even in the fallback case: et_reimbursement lines are now always added - the term
  // RAPORT-cursor-2l.md's T1a found missing entirely, independent of which position printed_net sits
  // at (post-tax and net-lines are the only axes affected by that ambiguity; ET reimbursements are not).
  if (period.printed_net !== null && period.printed_payout !== null) {
    const additions = period.net_additions.reduce((sum, line) => sum + line.amount, 0);
    const deductions = period.net_deductions.reduce((sum, line) => sum + line.amount, 0);
    const etReimbursementsForPayout = period.et?.et_applicable ? period.et.et_reimbursements.reduce((sum, r) => sum + r.amount, 0) : 0;
    const payoutAdjustments = period.payout_adjustments.reduce((sum, line) => sum + line.amount, 0);
    const etReimbursementCount = period.et?.et_applicable ? period.et.et_reimbursements.length : 0;
    let impliedPayout: number;
    let n: number;
    if (netStageMatchedPosition === 'after') {
      // Already fully applied (post-tax, net-lines, and ET reimbursements all folded in) - adding any
      // of them again would double-apply.
      impliedPayout = period.printed_net + payoutAdjustments;
      n = 2 + period.payout_adjustments.length;
    } else if (netStageMatchedPosition === 'taxable_base_net' && postTaxSumForReconciliation !== null) {
      // OTTO's shape: printed_net is BEFORE post-tax deductions too - apply them, then net-lines, then
      // ET reimbursements.
      impliedPayout = period.printed_net - postTaxSumForReconciliation + additions - deductions + etReimbursementsForPayout + payoutAdjustments;
      n = 2 + period.post_tax_social.length + period.net_additions.length + period.net_deductions.length + etReimbursementCount + period.payout_adjustments.length;
    } else {
      // Fallback (matched 'before', or unknown/unmatched): historical assumption - post-tax already
      // applied, apply net-lines and ET reimbursements.
      impliedPayout = period.printed_net + additions - deductions + etReimbursementsForPayout + payoutAdjustments;
      n = 2 + period.net_additions.length + period.net_deductions.length + etReimbursementCount + period.payout_adjustments.length;
    }
    impliedPayout = Math.round(impliedPayout * 100) / 100;
    const residual = Math.round((impliedPayout - period.printed_payout) * 100) / 100;
    if (Math.abs(residual) > reconciliationTolerance(n)) {
      issues.push({ code: 'totals_do_not_reconcile_payout', implied_payout: impliedPayout, printed_payout: period.printed_payout, residual });
    }
  }

  // 5. Stage 2i (§2i.3): "when base reduction equals sum of reimbursements gate can confirm reading" -
  // see the ConsistencyIssue variant's own doc comment for why this identity holds by construction for
  // a genuine ET/extraterritorial salary exchange. Only runs when both sides exist; a document with
  // one but not the other has its own gap already reported elsewhere (the controller's
  // et_exchange_amount_unknown, or simply an et_reimbursement_lines-less reduction, which is not itself
  // implausible - not every ET arrangement need be a pure exchange).
  if (period.et?.et_applicable && period.et.et_reimbursements.length > 0) {
    const reimbursementsSum = Math.round(period.et.et_reimbursements.reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
    const residual = Math.round((reimbursementsSum - period.et.et_exchange_amount) * 100) / 100;
    // n: the exchange amount, plus each reimbursement line.
    if (Math.abs(residual) > reconciliationTolerance(1 + period.et.et_reimbursements.length)) {
      issues.push({ code: 'et_reduction_reimbursement_mismatch', et_exchange_amount: period.et.et_exchange_amount, reimbursements_sum: reimbursementsSum, residual });
    }
  }

  return issues;
}
