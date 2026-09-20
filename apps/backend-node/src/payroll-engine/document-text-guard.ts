import { parsePrintedNumber, isAmountLike } from '../ocr-service/number-parser.js';
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
 * enumerates every field, so `verifyAmountsAgainstText` and `findUnusedPrintedAmounts` can never
 * silently drift apart on which fields they each consider.
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
  return out;
}

function parsedTextMagnitudes(textItems: DocumentTextItem[]): number[] {
  const values: number[] = [];
  for (const item of textItems) {
    const parsed = parsePrintedNumber(item.text);
    if (parsed !== null) values.push(Math.round(Math.abs(parsed) * 100) / 100);
  }
  return values;
}

/**
 * Stage 2g (§2g.3): "for every amount the model returns, require that its magnitude equals (to the
 * cent, after 2g.2 parsing) some number in the text list. A value that does not appear becomes
 * unreadable through the existing amount_unreadable path (2f.8), naming the field... Sign is not
 * compared (2f.5 owns sign). Applies only when a text list exists." The classic case this catches:
 * 699.75 (= 45 x 15.55, the model computed it) is not printed anywhere the document says 699.78.
 *
 * Returns field paths with no match - empty when every extracted amount is confirmed, or when
 * `textItems` is empty (the caller must not call this for an image-only upload; an empty result here
 * would otherwise be indistinguishable from "everything verified").
 */
export function verifyAmountsAgainstText(period: PayslipPeriod, textItems: DocumentTextItem[]): string[] {
  if (textItems.length === 0) return [];
  const textMagnitudes = parsedTextMagnitudes(textItems);
  const unverified: string[] = [];
  for (const { path, magnitude } of collectPeriodAmounts(period)) {
    const rounded = Math.round(magnitude * 100) / 100;
    const found = textMagnitudes.some((v) => Math.abs(v - rounded) <= CENT_EPSILON);
    if (!found) unverified.push(path);
  }
  return unverified;
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
  const usedMagnitudes = collectPeriodAmounts(period).map((a) => Math.round(a.magnitude * 100) / 100);
  const unused: number[] = [];
  for (const item of textItems) {
    if (!isAmountLike(item.text)) continue;
    const parsed = parsePrintedNumber(item.text);
    if (parsed === null) continue;
    const magnitude = Math.round(Math.abs(parsed) * 100) / 100;
    const isUsed = usedMagnitudes.some((v) => Math.abs(v - magnitude) <= CENT_EPSILON);
    if (!isUsed) unused.push(magnitude);
  }
  return unused;
}
