import { known, isKnownField, type PayslipPeriod } from './payslip-model.js';

/**
 * Stage 2f (audit v26, §2f.5): ONE sign policy, in one place, applied by both `mapExtractionToPeriod`
 * (a fresh AI extraction) and `/recompute` (a client-supplied `PayslipPeriod`, before this round
 * passed straight into the engine with no sign handling at all).
 *
 * Stage 2g (audit v27, §2g.0e): the reviewer found the stage 2f table (a comment) silently omitted
 * `reservations`, `printed_algemene_heffingskorting`, `printed_arbeidskorting` and the two `wml_*`
 * rate fields - a comment cannot be checked, only read, and reading missed three fields across two
 * rounds. `PAYSLIP_PERIOD_SIGN_POLICY` below is that same table made a real value, `satisfies
 * Record<keyof PayslipPeriod, SignFieldPolicy>` - TypeScript refuses to compile if a field is added to
 * `PayslipPeriod` without a corresponding entry here (a MISSING key), and refuses if an entry names a
 * policy outside the three allowed values (a TYPO'D value). It cannot catch a WRONG-but-valid choice
 * (marking a field 'keep' that should be 'magnitude') - that is still a judgement call, recorded here
 * with its reasoning, not something a type system can verify for you.
 */
export type SignFieldPolicy = 'keep' | 'magnitude' | 'not_an_amount';

/**
 * One entry per `PayslipPeriod` field. For a field holding a list of lines (e.g. `pre_tax_deductions`),
 * the policy describes what happens to the `amount` INSIDE each line, not the array itself - there is
 * no per-array-element type-level check for that nuance, so `normalizePeriodSigns` below is the
 * executable form of this table and the two must be read together.
 */
export const PAYSLIP_PERIOD_SIGN_POLICY = {
  period_label: 'not_an_amount',
  period_type: 'not_an_amount',
  period_type_confirmed: 'not_an_amount',
  period_end_date: 'not_an_amount',
  is_correction: 'not_an_amount',
  version: 'not_an_amount',
  employers: 'not_an_amount',
  hirer: 'not_an_amount',
  contract_hours: 'not_an_amount', // a quantity of hours, not a currency amount
  hour_lines: 'keep', // a correction can reverse a gross line - sign is the direction
  pre_tax_deductions: 'magnitude', // CREDIT EXCEPTION - see normalizeDeductionAmount below
  bijzonder_tarief: 'not_an_amount', // percentages/jaarloon, not signed payslip amounts in this sense
  et: 'magnitude', // et_exchange_amount and et.et_reimbursements[].amount, both magnitudes
  post_tax_social: 'magnitude', // CREDIT EXCEPTION - see normalizeDeductionAmount below
  net_additions: 'magnitude', // list membership (addition vs deduction) carries the direction
  net_deductions: 'magnitude',
  payout_adjustments: 'keep', // the prompt allows a negative correction (a debt); forcing positive would flip its meaning
  // Stage 2g (§2g.0e): NEW - a reservation accrual/payout is never printed as a negative figure on
  // any of the four reference documents; magnitude, same reasoning as net lines.
  reservations: 'magnitude',
  wml_printed: 'not_an_amount', // an hourly rate, not a chain amount
  wml_applicable: 'not_an_amount', // a rules-database rate, never extracted with a sign to normalise
  printed_table_tax: 'magnitude',
  printed_bt_tax: 'magnitude',
  // Stage 2g (§2g.0e): NEW - printed credits (algemene heffingskorting, arbeidskorting) are added
  // back, never subtracted, and none of the four reference documents print either with a minus sign.
  // 'keep' here is a decision, not an oversight: there is no confirmed case of either printing
  // negative, so there is nothing to correct - if one ever does, this is the line to revisit.
  printed_algemene_heffingskorting: 'keep',
  printed_arbeidskorting: 'keep',
  printed_net: 'keep', // Randstad's real printed payout is -53.89, an amount owed
  printed_payout: 'keep',
  printed_gross_total: 'magnitude',
  printed_loon_voor_heffingen: 'magnitude',
  // Stage 2i (§2i.2): NEW - a taxable base is never printed negative on any confirmed document
  // (OTTO's are the only real-document instance seen so far), same reasoning as printed_gross_total.
  printed_taxable_base_normal: 'magnitude',
  printed_taxable_base_special: 'magnitude',
  printed_table_tax_label: 'not_an_amount',
  printed_bt_tax_label: 'not_an_amount',
  printed_algemene_heffingskorting_label: 'not_an_amount',
  printed_arbeidskorting_label: 'not_an_amount',
  printed_net_label: 'not_an_amount',
  printed_payout_label: 'not_an_amount',
} as const satisfies Record<keyof PayslipPeriod, SignFieldPolicy>;

/**
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
// Stage 2p (audit v38, §2p, F4 - low priority): Red Team's own finding, confirmed by Cursor's T4: the
// bare substring pattern has no word boundary at all - a hypothetical compound word merely CONTAINING
// "rekompensata" (never seen on a real document, but not ruled out either) would match. `\b` on both
// sides is safe here (unlike isEtExchangeLabel below) because "Rekompensata" is used as a standalone
// word on both real confirmed labels ("PAWW Rekompensata", "REKOMPENSATA PAWW") - never a shared prefix
// of some other word the way "nieopod" deliberately is. No behaviour change on Cursor's own confirmed
// matrix (Rekompensata/REKOMPENSATA PAWW still match; Rekompensaty/rekompensaty PAWW still don't - they
// differ in the letters themselves, not merely in word boundaries).
const CREDIT_LABEL_PATTERN = /\brekompensata\b/i;

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
    reservations: period.reservations.map((r) => ({
      ...r,
      opgebouwd_this_period: magnitude(r.opgebouwd_this_period),
      paid_out_this_period: magnitude(r.paid_out_this_period),
    })),
    printed_table_tax: magnitudeOrNull(period.printed_table_tax),
    printed_bt_tax: magnitudeOrNull(period.printed_bt_tax),
    printed_gross_total: magnitudeOrNull(period.printed_gross_total),
    printed_loon_voor_heffingen: magnitudeOrNull(period.printed_loon_voor_heffingen),
    printed_taxable_base_normal: magnitudeOrNull(period.printed_taxable_base_normal),
    printed_taxable_base_special: magnitudeOrNull(period.printed_taxable_base_special),
    // hour_lines, payout_adjustments, printed_net, printed_payout, printed_algemene_heffingskorting,
    // printed_arbeidskorting: 'keep' per the table above - sign is the direction, untouched.
  };
}
