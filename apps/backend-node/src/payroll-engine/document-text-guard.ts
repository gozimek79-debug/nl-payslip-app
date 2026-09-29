import { extractPrintedNumbers, looksLikeSplitThousandsPair, type ExtractedNumber } from '../ocr-service/number-parser.js';
import type { PayslipPeriod } from './payslip-model.js';

/**
 * Stage 2g (audit v27, §2g.1): one text item from the document's own text layer, read by the browser
 * (`local-ocr.ts`'s `extractTextItems`) on the same pages rasterised for the vision call. Untrusted
 * input at the server boundary - see `sanitizeDocumentText` in `tier-c.controller.ts`.
 */
export interface DocumentTextItem {
  page: number;
  text: string;
  x: number;
  y: number;
}

/** Cent-level tolerance for comparing a parsed printed number against an extracted amount - both
 * sides are already rounded to the cent, so this only absorbs floating-point representation noise,
 * never a real rounding difference (that would be a genuine mismatch, not slop to hide). */
const CENT_EPSILON = 0.005;

/**
 * Stage 2g (§2g.3/§2g.4): every amount-bearing field on a `PayslipPeriod`, as a magnitude (sign is
 * 2f.5's concern, never this one's) with a human-readable path for issue reporting. One place
 * enumerates every field, so `findUnusedPrintedAmounts` below can draw on a single canonical list.
 */
export function collectPeriodAmounts(period: PayslipPeriod): Array<{ path: string; magnitude: number }> {
  const out: Array<{ path: string; magnitude: number }> = [];
  period.hour_lines.forEach((l, i) => out.push({ path: `hour_lines[${i}].amount`, magnitude: Math.abs(l.amount) }));
  period.pre_tax_deductions.forEach((d, i) => {
    if (d.amount.value !== null) out.push({ path: `pre_tax_deductions[${i}].amount`, magnitude: Math.abs(d.amount.value) });
  });
  period.post_tax_social.forEach((d, i) => {
    if (d.amount.value !== null) out.push({ path: `post_tax_social[${i}].amount`, magnitude: Math.abs(d.amount.value) });
  });
  period.net_additions.forEach((l, i) => out.push({ path: `net_additions[${i}].amount`, magnitude: Math.abs(l.amount) }));
  period.net_deductions.forEach((l, i) => out.push({ path: `net_deductions[${i}].amount`, magnitude: Math.abs(l.amount) }));
  period.payout_adjustments.forEach((l, i) => out.push({ path: `payout_adjustments[${i}].amount`, magnitude: Math.abs(l.amount) }));
  period.reservations.forEach((r, i) => {
    out.push({ path: `reservations[${i}].opgebouwd_this_period`, magnitude: Math.abs(r.opgebouwd_this_period) });
    out.push({ path: `reservations[${i}].paid_out_this_period`, magnitude: Math.abs(r.paid_out_this_period) });
  });
  if (period.et) {
    out.push({ path: 'et.et_exchange_amount', magnitude: Math.abs(period.et.et_exchange_amount) });
    period.et.et_reimbursements.forEach((r, i) => out.push({ path: `et.et_reimbursements[${i}].amount`, magnitude: Math.abs(r.amount) }));
  }
  if (period.printed_table_tax !== null) out.push({ path: 'printed_table_tax', magnitude: Math.abs(period.printed_table_tax) });
  if (period.printed_bt_tax !== null) out.push({ path: 'printed_bt_tax', magnitude: Math.abs(period.printed_bt_tax) });
  if (period.printed_gross_total !== null) out.push({ path: 'printed_gross_total', magnitude: Math.abs(period.printed_gross_total) });
  if (period.printed_loon_voor_heffingen !== null) out.push({ path: 'printed_loon_voor_heffingen', magnitude: Math.abs(period.printed_loon_voor_heffingen) });
  if (period.printed_net !== null) out.push({ path: 'printed_net', magnitude: Math.abs(period.printed_net) });
  if (period.printed_payout !== null) out.push({ path: 'printed_payout', magnitude: Math.abs(period.printed_payout) });
  // Stage 2h (audit v28, §2h.2): "include printed_algemene_heffingskorting and printed_arbeidskorting
  // in collectPeriodAmounts" - the reviewer's T1(b) found these two absent from both the guard and the
  // unused-amounts accounting, even though they are ordinary printed EUR figures like any other anchor.
  if (period.printed_algemene_heffingskorting !== null) out.push({ path: 'printed_algemene_heffingskorting', magnitude: Math.abs(period.printed_algemene_heffingskorting) });
  if (period.printed_arbeidskorting !== null) out.push({ path: 'printed_arbeidskorting', magnitude: Math.abs(period.printed_arbeidskorting) });
  // Stage 2i (audit v29, §2i.2): OTTO's two printed taxable-base components - ordinary EUR figures
  // like every other anchor above, so the guard/unused-list accounting must see them too.
  if (period.printed_taxable_base_normal !== null) out.push({ path: 'printed_taxable_base_normal', magnitude: Math.abs(period.printed_taxable_base_normal) });
  if (period.printed_taxable_base_special !== null) out.push({ path: 'printed_taxable_base_special', magnitude: Math.abs(period.printed_taxable_base_special) });
  return out;
}

/**
 * Stage 2i (audit v29, §2i.5): "hours, rates, percentages, BT rate, minimum wage, annual wage returned
 * as fields count as explained numbers for the unused list (not for the guard)." OWNER-RETEST-2h-otto.md
 * measured 27 "unused" items on a real upload that were mostly these - numbers the model DID read, into
 * a field, just not one of the EUR-amount fields `collectPeriodAmounts` above enumerates. Kept as a
 * SEPARATE list, deliberately not merged into `collectPeriodAmounts` - an hours/rate/percent figure is
 * a different kind of claim from a EUR amount. Stage 2t (audit v52, §2t.3) retired the bag-of-numbers
 * amount-verification guard this list's own doc comment used to describe alongside
 * `findUnusedPrintedAmounts` - only the unused-amounts list (informational, never blocking - §2g.4)
 * remains; this function's own list is still scoped to it only. Only `findUnusedPrintedAmounts` reads
 * this.
 */
export function collectExplainedNonAmountMagnitudes(period: PayslipPeriod): Array<{ path: string; magnitude: number }> {
  const out: Array<{ path: string; magnitude: number }> = [];
  period.hour_lines.forEach((l, i) => {
    if (l.hours !== null) out.push({ path: `hour_lines[${i}].hours`, magnitude: Math.abs(l.hours) });
    if (l.rate !== null) out.push({ path: `hour_lines[${i}].rate`, magnitude: Math.abs(l.rate) });
    if (l.percent !== null) out.push({ path: `hour_lines[${i}].percent`, magnitude: Math.abs(l.percent) });
  });
  if (period.bijzonder_tarief.tarief_bt.printed !== null) out.push({ path: 'bijzonder_tarief.tarief_bt.printed', magnitude: Math.abs(period.bijzonder_tarief.tarief_bt.printed) });
  if (period.wml_printed !== null) out.push({ path: 'wml_printed', magnitude: Math.abs(period.wml_printed) });
  if (period.bijzonder_tarief.jaarloon_bt !== null) out.push({ path: 'bijzonder_tarief.jaarloon_bt', magnitude: Math.abs(period.bijzonder_tarief.jaarloon_bt) });
  return out;
}

/**
 * Stage 2h (§2h.1), carried into 2t as `findUnusedPrintedAmounts`'s own tokeniser (its one caller,
 * since the amount-verification guard this once also fed was retired in stage 2t - §2t.3): one pass
 * over the item list builds the single shared candidate list; every number `extractPrintedNumbers`
 * finds inside each item on its own, PLUS every number found by joining two consecutive items that
 * share a page and a rounded y AND look like the precise two halves of one split-thousands number
 * (`looksLikeSplitThousandsPair` - number-parser.ts's own doc comment explains why this must be exact,
 * not "both look numeric": an hours cell next to a rate cell on the same row - e.g. "45,00" then
 * "15,55" - both independently look like bare numbers, but joining THOSE would fabricate a bogus third
 * candidate, duplicating both real ones and silently inflating 2g.4's "unused" count). Consecutive
 * means adjacent in the array as received - `local-ocr.ts` already delivers items in pdf.js's own
 * per-page reading order, never re-sorted here.
 */
function extractedNumbers(textItems: DocumentTextItem[]): ExtractedNumber[] {
  const found: ExtractedNumber[] = [];
  for (const item of textItems) {
    found.push(...extractPrintedNumbers(item.text));
  }
  for (let i = 0; i < textItems.length - 1; i += 1) {
    const a = textItems[i];
    const b = textItems[i + 1];
    if (a === undefined || b === undefined) continue;
    if (a.page === b.page && Math.round(a.y) === Math.round(b.y) && looksLikeSplitThousandsPair(a.text.trim(), b.text.trim())) {
      found.push(...extractPrintedNumbers(`${a.text} ${b.text}`));
    }
  }
  return found;
}

/**
 * Stage 2g (§2g.4): "after the model has filled its fields, list the amount-like items in the text
 * layer that no returned field used... Amount-like means the 2g.2 parser accepts it and it has two
 * decimals." This is what catches a whole missing line (Olympia's 58.31) - a line the model never
 * emitted has no field to check against ANYTHING, but the printed number is still sitting, unused, in
 * the text layer. Not a block (§2g.4: "do not block on it") - a stated gap for the trace panel.
 */
export function findUnusedPrintedAmounts(period: PayslipPeriod, textItems: DocumentTextItem[]): number[] {
  if (textItems.length === 0) return [];
  // Stage 2i (§2i.5): widened with collectExplainedNonAmountMagnitudes - see that function's own
  // comment for why this list is wider here than the guard's own collectPeriodAmounts-only check.
  const usedMagnitudes = [...collectPeriodAmounts(period), ...collectExplainedNonAmountMagnitudes(period)].map((a) => Math.round(a.magnitude * 100) / 100);
  const unused: number[] = [];
  for (const n of extractedNumbers(textItems)) {
    if (n.shape !== 'money') continue;
    const magnitude = Math.round(Math.abs(n.value) * 100) / 100;
    const isUsed = usedMagnitudes.some((v) => Math.abs(v - magnitude) <= CENT_EPSILON);
    if (!isUsed) unused.push(magnitude);
  }
  return unused;
}
