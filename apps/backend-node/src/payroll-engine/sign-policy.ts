import { known, isKnownField, type PayslipPeriod } from './payslip-model.js';

/**
 * Stage 2f (audit v26, §2f.5): ONE sign policy, in one place, applied by both `mapExtractionToPeriod`
 * (a fresh AI extraction) and `/recompute` (a client-supplied `PayslipPeriod`, today passed straight
 * into the engine with no sign handling at all). Stage 2e's `magnitude`/`magnitudeOrNull` in
 * `tier-c.ts` covered some fields and missed others - the review's own field-by-field table
 * (`RAPORT-cursor-2e.md`, "T1") is reproduced here as the single source of truth, so the two call
 * sites can never drift again.
 *
 * Per field, what `normalizePeriodSigns` below does to a `PayslipPeriod`:
 *
 * | field                                                          | policy                                    |
 * |-----------------------------------------------------------------|--------------------------------------------|
 * | `hour_lines[].amount`                                            | keep sign - a correction can reverse a gross line |
 * | `pre_tax_deductions[].amount`, `post_tax_social[].amount`        | magnitude, CREDIT EXCEPTION (see below)   |
 * | `net_additions[].amount`, `net_deductions[].amount`              | magnitude - list membership carries direction |
 * | `et.et_reimbursements[].amount`                                  | magnitude |
 * | `et.et_exchange_amount`                                          | magnitude |
 * | `payout_adjustments[].amount`                                    | keep sign - the prompt already allows a negative correction (a debt), and forcing it positive would flip its meaning |
 * | `printed_table_tax`, `printed_bt_tax`                            | magnitude |
 * | `printed_gross_total`, `printed_loon_voor_heffingen`             | magnitude |
 * | `printed_net`, `printed_payout`                                  | keep sign - Randstad's real printed payout is -53.89, an amount owed |
 *
 * Credit exception: a pre-tax or post-tax deduction line whose description names a known CREDIT term
 * is stored as a NEGATIVE value, so summing it into the (normally-subtracted) deduction total nets it
 * back in as an addition, without a new field or a new arithmetic branch. The only credit label
 * confirmed against a real document is "Rekompensata" (OTTO's "PAWW Rekompensata", printed +0.51 -
 * FIXTURES fixture 2, Krok 2/3). This is deliberately narrow: only labels actually seen in the
 * fixtures, never a guessed general rule for "any positive deduction is a credit" (a positive line
 * could just as easily be an OCR sign-loss on an ordinary deduction).
 *
 * The credit check is on the LABEL ALONE, never on the amount's current sign - `normalizeDeductionAmount`
 * has to give the same answer whether it is applied to a raw, freshly-extracted amount (still carrying
 * its printed sign) or to an already-normalised Field value from a prior `/analyze` call (already
 * negative for a credit). A sign-dependent check ("credit only if currently positive") would flip an
 * already-correct credit back into a deduction the second time it ran - exactly the bug this shared
 * function exists to make impossible, since `/recompute` may see output this same function already
 * produced.
 */
const CREDIT_LABEL_PATTERN = /rekompensata/i;

export function isCreditLabel(description: string): boolean {
  return CREDIT_LABEL_PATTERN.test(description);
}

export function magnitude(value: number): number {
  return Math.abs(value);
}

export function magnitudeOrNull(value: number | null): number | null {
  return value === null ? null : Math.abs(value);
}

/** For `pre_tax_deductions[]`/`post_tax_social[]` amounts only - see the table above. */
export function normalizeDeductionAmount(description: string, rawAmount: number): number {
  const abs = Math.abs(rawAmount);
  return isCreditLabel(description) ? -abs : abs;
}

/**
 * Applies the full table above to an already-built `PayslipPeriod`. Idempotent by construction (every
 * rule reduces to a function of the CURRENT value and, for deductions, the description alone) - safe
 * to call on a period this same function already normalised, which is exactly what happens when
 * `/recompute` receives back a period `mapExtractionToPeriod` produced a moment earlier.
 */
export function normalizePeriodSigns(period: PayslipPeriod): PayslipPeriod {
  return {
    ...period,
    pre_tax_deductions: period.pre_tax_deductions.map((d) =>
      isKnownField(d.amount) ? { ...d, amount: known(normalizeDeductionAmount(d.description, d.amount.value), d.amount.provenance) } : d,
    ),
    post_tax_social: period.post_tax_social.map((d) =>
      isKnownField(d.amount) ? { ...d, amount: known(normalizeDeductionAmount(d.description, d.amount.value), d.amount.provenance) } : d,
    ),
    net_additions: period.net_additions.map((l) => ({ ...l, amount: magnitude(l.amount) })),
    net_deductions: period.net_deductions.map((l) => ({ ...l, amount: magnitude(l.amount) })),
    et: period.et
      ? {
          ...period.et,
          et_exchange_amount: magnitude(period.et.et_exchange_amount),
          et_reimbursements: period.et.et_reimbursements.map((r) => ({ ...r, amount: magnitude(r.amount) })),
        }
      : null,
    printed_table_tax: magnitudeOrNull(period.printed_table_tax),
    printed_bt_tax: magnitudeOrNull(period.printed_bt_tax),
    printed_gross_total: magnitudeOrNull(period.printed_gross_total),
    printed_loon_voor_heffingen: magnitudeOrNull(period.printed_loon_voor_heffingen),
    // hour_lines, payout_adjustments, printed_net, printed_payout: sign is the direction, untouched.
  };
}
