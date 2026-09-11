/**
 * Data model for a fully-reconstructed payslip period, per the fixtures document's "Wnioski dla
 * modelu danych" (audit round 8, AK2). Field names follow that document's own snake_case naming
 * where it names a field explicitly - this is the specification, not a style choice to override.
 *
 * This does NOT replace CalculatorInput/CalculatorResult (calculator.ts) - that engine answers
 * "given hours and a rate, what should net pay be" for a user filling in a form. This model answers
 * "given everything printed on a real payslip, does the math on the payslip itself check out" -
 * multiple employers, mixed tax treatment per line, ET arrangements, reservations, and a payout that
 * can differ from the period's own net wage. E5 (payslip-to-engine integration, not started here)
 * is what will eventually populate this model from AI extraction; today it's populated by hand in
 * the golden tests below, from the fixtures document's own worked figures.
 */

/**
 * Governing rule (SPEC-loonto-architecture.md §1, architecture round): every value that can
 * legitimately come from different sources carries its provenance, and 'unknown' is an explicit
 * state a computation must check for - never silently treated as zero. This is what makes the
 * live 8% net-pay overstatement (744.34 vs a true 686.09 on Olympia - the calculator taxed the full
 * gross because it has no concept of pension/PAWW/sector-premium deductions at all) structurally
 * impossible going forward: a missing deduction stops the computation instead of vanishing into it.
 */
export type Provenance = 'user_entered' | 'contract_extracted' | 'payslip_extracted' | 'estimated' | 'rules_database' | 'unknown';

/** Discriminated so 'unknown' can never carry a fabricated value - TypeScript enforces value:null
 * whenever provenance is 'unknown', so a caller cannot accidentally treat a missing field as 0. */
export type Field<T> =
  | { provenance: Exclude<Provenance, 'unknown'>; value: T }
  | { provenance: 'unknown'; value: null };

export function known<T>(value: T, provenance: Exclude<Provenance, 'unknown'>): Field<T> {
  return { provenance, value };
}
export function unknownField<T>(): Field<T> {
  return { provenance: 'unknown', value: null } as Field<T>;
}
export function isKnownField<T>(field: Field<T>): field is { provenance: Exclude<Provenance, 'unknown'>; value: T } {
  return field.provenance !== 'unknown';
}

export type HourLineCategory = 'regular' | 'irregular_surcharge' | 'overtime' | 'adv_compensation' | 'other';
export type TaxTreatment = 'table' | 'bt' | 'unknown';

export interface Employer {
  name: string | null;
  /** AJ2: explicit, three-state - never inferred from array position. Exactly one employer should
   * be `true` when pension applies; `'unknown'` is a real, distinct state from `false`. */
  franchise_bearing: boolean | 'unknown';
}

export interface Hirer {
  name: string | null;
}

export interface HourLine {
  employer_index: number;
  description: string;
  /** null when this line is a surcharge on hours already counted by another line (e.g. Olympia's
   * "onregelm. uren 100%" surcharging a subset of the same 45 hours already in the regular line) -
   * distinguishing this from a line that adds genuinely new hours (true overtime) is what
   * `adds_hours` is for; `hours` here is still the quantity the surcharge rate multiplies by. */
  hours: number | null;
  rate: number | null;
  /** Surcharge percentage for lines quantified that way (e.g. 30%, 100%, 50%) - null for a plain
   * regular-hours line paid at a flat rate with no percentage multiplier. */
  percent: number | null;
  amount: number;
  category: HourLineCategory;
  /** Read from the document, never inferred from `category` (audit AK2) - Olympia's own irregular-
   * hours surcharges went through the white table, not bijzonder tarief, disproving the assumption
   * that overtime/surcharges always route through BT. */
  tax_treatment: TaxTreatment;
  /** True if these hours are genuinely additional (real overtime, e.g. Randstad/OTTO); false if
   * they're a surcharge multiplier on hours already counted elsewhere (Olympia, DHL's onregelm.
   * lines) - determines what counts toward `hours_worked` and toward a StiPP franchise calculation. */
  adds_hours: boolean;
}

export type PreTaxDeductionCategory = 'pension' | 'paww' | 'ziektewet' | 'wga_gat' | 'other';

export interface PreTaxDeduction {
  category: PreTaxDeductionCategory;
  description: string;
  /** The value this line concerns AND its provenance are inseparable (spec §1) - a Tier A user who
   * chose "skip" still has a row here (category + description), it just carries
   * `{provenance:'unknown', value:null}` so the UI can say "sector premium: not provided" pointing
   * at where to find it, rather than omitting the category or defaulting it to 0. */
  amount: Field<number>;
  /** The base this was computed from, when known (e.g. PKF's pension base is post-franchise,
   * 1601.58, not the full 3515.56) - kept explicit rather than re-derived, since the franchise is a
   * pension-fund parameter, not a tax one (per the fixtures document's own note on this). */
  base: number | null;
  percent: number | null;
}

export type PostTaxSocialCategory = 'wga' | 'gediff_wga' | 'whk' | 'other';

export interface PostTaxSocialDeduction {
  category: PostTaxSocialCategory;
  description: string;
  amount: Field<number>;
  percent: number | null;
}

export type BtState = 'known' | 'not_applicable' | 'unknown';

export interface BijzonderTariefContext {
  jaarloon_bt: number | null;
  /** Explicit state, never a default (audit AK2 / "Dodane po Fixture 4"): 'not_applicable' for a
   * genuinely new employment with no prior-year jaarloon to base BT on (Olympia); 'unknown' only
   * when the document should have one but it couldn't be read; 'known' when jaarloon_bt is set. */
  bt_state: BtState;
  /** `printed` wins when the document states its own BT percentage outright (PKF: 40.20%, Randstad:
   * 50.47%, OTTO: a document-specific "Taryfa specjalna" 38.45% that doesn't come from the NL
   * bijzonder-tarief bracket table at all - a different regime). `computed` is this engine's own
   * jaarloon-bracket lookup, used only when nothing is printed. */
  tarief_bt: { printed: number | null; computed: number | null };
}

export interface ExtraterritorialArrangement {
  et_applicable: boolean;
  /** Reduces the taxable base (loon_voor_heffingen) - e.g. OTTO's -177.00 "Nieopodatkowana część
   * wynagrodzenia (ET)". Positive number representing the amount of the reduction. */
  et_exchange_amount: number;
  /** Added back as NET reimbursements, after tax - e.g. OTTO's ET verblijfskosten (33.00) and
   * huisvesting (144.00) reimbursements. */
  et_reimbursements: Array<{ description: string; amount: number }>;
  adres_fiskalny: string | null;
}

export type NetDeductionCategory = 'loan' | 'housing' | 'transport' | 'health_insurance' | 'union' | 'other';

export interface NetLineItem {
  category: NetDeductionCategory | 'reimbursement';
  description: string;
  amount: number;
}

export type ReservationType = 'vakantiegeld' | 'vakantiedagen' | 'vakantiedagen_bovenwettelijk' | 'verlofuren' | 'other';

export interface ReservationBalance {
  type: ReservationType;
  /** Accrued this period - NOT part of gross. Only a PAID-OUT reservation enters gross (and then
   * through BT) - audit finding from Fixture 4 ("Rezerwacje naliczone, ale niewypłacone"). */
  opgebouwd_this_period: number;
  paid_out_this_period: number;
  saldo_after: number | null;
}

export interface PayslipPeriod {
  period_label: string | null;
  period_type: 'week' | '4-weekly' | 'month';
  period_end_date: string | null;
  is_correction: boolean;
  version: number;

  employers: Employer[];
  hirer: Hirer | null;
  contract_hours: number | null;
  hour_lines: HourLine[];

  pre_tax_deductions: PreTaxDeduction[];
  bijzonder_tarief: BijzonderTariefContext;
  et: ExtraterritorialArrangement | null;
  post_tax_social: PostTaxSocialDeduction[];

  net_additions: NetLineItem[];
  net_deductions: NetLineItem[];
  payout_adjustments: Array<{ description: string; amount: number }>;

  reservations: ReservationBalance[];

  wml_printed: number | null;
  wml_applicable: number | null;

  /** Printed reference points used only to VERIFY this engine's own tax computation against the
   * document, never to derive the result - "WERYFIKACJA TABELI" markers in the fixtures document. */
  printed_table_tax: number | null;
  printed_bt_tax: number | null;
  printed_algemene_heffingskorting: number | null;
  printed_arbeidskorting: number | null;
}

export interface TaxBracket {
  min: number;
  max: number;
  rate: number;
}

export interface HeffingskortingenRates {
  algemene_heffingskorting: { max_amount: number; phaseout_start: number; phaseout_rate: number };
  arbeidskorting: { max_amount: number; phaseout_start: number; phaseout_rate: number; buildup_tiers: Array<{ max: number; rate: number }> };
}

export interface PayslipComputationRates {
  loonheffing_brackets: TaxBracket[];
  heffingskortingen: HeffingskortingenRates;
  period_multiplier: number;
}

export interface HourLinesTotal {
  gross: number;
  hours_worked: number;
  table_gross: number;
  bt_gross: number;
  unknown_treatment_gross: number;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

/** Sums hour_lines, splitting by tax_treatment (audit AK2 - read per line, never inferred) and by
 * adds_hours for the hours_worked total (contract_hours is never checked against this - audit AK2). */
export function summariseHourLines(lines: HourLine[]): HourLinesTotal {
  let gross = 0;
  let hoursWorked = 0;
  let tableGross = 0;
  let btGross = 0;
  let unknownGross = 0;
  for (const line of lines) {
    gross += line.amount;
    if (line.adds_hours && line.hours !== null) hoursWorked += line.hours;
    if (line.tax_treatment === 'table') tableGross += line.amount;
    else if (line.tax_treatment === 'bt') btGross += line.amount;
    else unknownGross += line.amount;
  }
  return { gross: round(gross), hours_worked: hoursWorked, table_gross: round(tableGross), bt_gross: round(btGross), unknown_treatment_gross: round(unknownGross) };
}

function progressiveTax(annualAmount: number, brackets: TaxBracket[]): number {
  let tax = 0;
  for (const bracket of brackets) {
    if (annualAmount <= bracket.min) continue;
    const upper = Math.min(annualAmount, bracket.max);
    tax += (upper - bracket.min) * bracket.rate;
  }
  return tax;
}

function arbeidskortingBuildup(income: number, tiers: Array<{ max: number; rate: number }>): number {
  let amount = 0;
  let previousMax = 0;
  for (const tier of tiers) {
    if (income <= previousMax) break;
    const upper = Math.min(income, tier.max);
    amount += (upper - previousMax) * tier.rate;
    previousMax = tier.max;
  }
  return amount;
}

function heffingskortingen(rates: HeffingskortingenRates, annualizedTaxable: number): { algemene: number; arbeids: number } {
  const { algemene_heffingskorting: ahk, arbeidskorting: ak } = rates;
  let algemene = ahk.max_amount;
  if (annualizedTaxable > ahk.phaseout_start) {
    algemene = Math.max(0, algemene - (annualizedTaxable - ahk.phaseout_start) * ahk.phaseout_rate);
  }
  let arbeids: number;
  if (annualizedTaxable <= ak.phaseout_start) {
    arbeids = arbeidskortingBuildup(annualizedTaxable, ak.buildup_tiers);
  } else {
    arbeids = Math.max(0, ak.max_amount - (annualizedTaxable - ak.phaseout_start) * ak.phaseout_rate);
  }
  return { algemene, arbeids };
}

export interface PayslipComputationResult {
  gross_total: number;
  hours_worked: number;
  pre_tax_deductions_total: number;
  loon_voor_heffingen: number;
  taxable_base: number;
  /** BEFORE heffingskortingen - this is the raw progressive-bracket result. The document's own
   * printed "loonheffing tabel" figure is the value AFTER credits (`table_tax_after_korting`) - the
   * two are easy to conflate and this engine's own golden tests did, once, before being fixed. */
  table_tax: number;
  table_tax_after_korting: number;
  bt_tax: number;
  algemene_heffingskorting: number;
  arbeidskorting: number;
  total_tax: number;
  post_tax_social_total: number;
  wage_net: number;
  net_additions_total: number;
  net_deductions_total: number;
  period_net: number;
  payout_adjustments_total: number;
  payout_amount: number;
}

/**
 * Result of a computation that could not reach a final net figure because a pre-tax or post-tax
 * deduction field was `unknown` (spec §1 - "a computation that requires an unknown field does not
 * produce a number, it produces a stated gap"). `tax_is_upper_bound` distinguishes two genuinely
 * different situations, since only one of them lets the tax figures be trusted at all:
 *   - pre-tax deductions unknown: taxable_base/table_tax/total_tax below are computed AS IF there
 *     were no pre-tax deductions - an upper bound only (real, unknown deductions would only reduce
 *     them further), never to be shown as "your tax" without that caveat.
 *   - only post-tax deductions unknown: pre-tax was fully known, so taxable_base/table_tax/total_tax
 *     below ARE the real, correct figures - only the net-and-below chain is missing.
 * Neither branch computes wage_net/period_net/payout_amount at all - those keys are simply absent
 * from this shape, not zero and not null, so a consumer cannot render "net: 0" by accident.
 */
export interface IncompletePayslipComputation {
  status: 'incomplete';
  missing_fields: string[];
  tax_is_upper_bound: boolean;
  gross_total: number;
  taxable_base: number;
  table_tax_after_korting: number;
  bt_tax: number;
  total_tax: number;
}

export type PayslipComputationOutcome = { status: 'complete'; result: PayslipComputationResult } | IncompletePayslipComputation;

/**
 * Computes a full period from a populated PayslipPeriod. Deliberately does NOT re-derive
 * tarief_bt.computed unless nothing is printed - a document's own stated BT percentage (PKF,
 * Randstad, OTTO's non-NL-standard "Taryfa specjalna") is authoritative over this engine's bracket
 * lookup, which only covers the standard NL bijzonder-tarief regime.
 *
 * heffingskortingen are subtracted ONLY from the table portion of tax, never the BT portion - this
 * matches how the real "met loonheffingskorting" BT addon table already nets the credits into its
 * own percentage (see calculator.ts's bijzonderTariefRate and the G1 decomposition), so subtracting
 * them again here would double-count exactly the error class already fixed there.
 *
 * Returns a discriminated PayslipComputationOutcome, not a bare PayslipComputationResult (spec §1) -
 * see IncompletePayslipComputation above for what happens when a deduction field is unknown.
 */
export function computePayslipPeriod(period: PayslipPeriod, rates: PayslipComputationRates, applyLoonheffingskorting: boolean): PayslipComputationOutcome {
  const hourLinesTotal = summariseHourLines(period.hour_lines);
  const unknownPreTax = period.pre_tax_deductions.filter((d) => d.amount.provenance === 'unknown');
  const unknownPostTax = period.post_tax_social.filter((d) => d.amount.provenance === 'unknown');
  const preTaxKnown = unknownPreTax.length === 0;

  const etReduction = period.et?.et_applicable ? period.et.et_exchange_amount : 0;
  // When a pre-tax deduction is unknown, preTaxTotal is treated as 0 for this computation ONLY to
  // produce the explicitly-labelled upper bound below - never returned as `loon_voor_heffingen` or
  // any figure implying it is the real, deduction-inclusive total (spec §1: unknown != 0).
  const preTaxTotal = preTaxKnown ? round(period.pre_tax_deductions.reduce((sum, d) => sum + (d.amount.value as number), 0)) : 0;

  // Pre-tax deductions and the ET reduction apply ONLY to the table-taxed portion; the BT-taxed
  // portion is the RAW, unreduced BT-tagged gross - this is not a proportional split, it's the
  // methodology both PKF and Randstad's own fixtures state explicitly ("potrącenia przedpodatkowe
  // obciążają wyłącznie część tabelaryczną. Podstawa BT to pełne brutto [nadgodzin]") and both
  // reproduce their own printed table/BT base split exactly under this rule. An earlier version of
  // this engine split proportionally by gross share instead, which does not match either document.
  const taxableBt = round(hourLinesTotal.bt_gross);
  const taxableTable = round(hourLinesTotal.table_gross + hourLinesTotal.unknown_treatment_gross - preTaxTotal - etReduction);
  const taxableBase = round(taxableTable + taxableBt);

  const multiplier = rates.period_multiplier;
  const annualizedTable = taxableTable * multiplier;
  const tableTaxAnnual = progressiveTax(annualizedTable, rates.loonheffing_brackets);
  const tableTax = round(tableTaxAnnual / multiplier);

  // A nonzero BT-tagged gross with no known BT percentage is its OWN unknown - not something to
  // silently zero out. Before this check, computePayslipPeriod would have quietly set btTax=0 for
  // any bt_state other than 'known' (including 'unknown'), which is exactly the class of bug this
  // whole model exists to prevent: a genuinely-BT-taxed amount rendered as if it owed no tax at all,
  // rather than a stated gap. 'not_applicable' is not this - it means the document genuinely has no
  // BT-taxed gross, which is consistent with taxableBt being 0 in that case.
  const btRateUnknown = taxableBt > 0 && period.bijzonder_tarief.bt_state === 'unknown';

  let btTax = 0;
  if (period.bijzonder_tarief.bt_state === 'known' && taxableBt > 0) {
    const percent = period.bijzonder_tarief.tarief_bt.printed ?? period.bijzonder_tarief.tarief_bt.computed ?? 0;
    btTax = round(taxableBt * (percent / 100));
  }

  let algemeneHeffingskorting = 0;
  let arbeidskorting = 0;
  if (applyLoonheffingskorting) {
    const k = heffingskortingen(rates.heffingskortingen, annualizedTable);
    algemeneHeffingskorting = round(k.algemene / multiplier);
    arbeidskorting = round(k.arbeids / multiplier);
  }
  const tableTaxAfterKorting = Math.max(0, round(tableTax - algemeneHeffingskorting - arbeidskorting));
  const totalTax = round(tableTaxAfterKorting + btTax);

  if (!preTaxKnown || btRateUnknown) {
    const missing = [...unknownPreTax.map((d) => d.category), ...(btRateUnknown ? ['bijzonder_tarief_percentage'] : [])];
    return {
      status: 'incomplete',
      missing_fields: missing,
      tax_is_upper_bound: true,
      gross_total: hourLinesTotal.gross,
      taxable_base: taxableBase,
      table_tax_after_korting: tableTaxAfterKorting,
      bt_tax: btTax,
      total_tax: totalTax,
    };
  }
  if (unknownPostTax.length > 0) {
    return {
      status: 'incomplete',
      missing_fields: unknownPostTax.map((d) => d.category),
      tax_is_upper_bound: false,
      gross_total: hourLinesTotal.gross,
      taxable_base: taxableBase,
      table_tax_after_korting: tableTaxAfterKorting,
      bt_tax: btTax,
      total_tax: totalTax,
    };
  }

  const postTaxTotal = round(period.post_tax_social.reduce((sum, d) => sum + (d.amount.value as number), 0));
  // Uses taxableBase (loon_voor_heffingen minus the ET reduction), not loon_voor_heffingen itself -
  // OTTO's "Podsuma wynagrodzenia" (607.78) is explicitly RAZEM PODSTAWA (725.38, already
  // ET-reduced) minus tax, not loon_voor_heffingen (902.38) minus tax. Without an ET arrangement
  // taxableBase === loon_voor_heffingen (etReduction is 0), so this doesn't change Olympia/PKF/
  // Randstad, all of which have no ET.
  const wageNet = round(taxableBase - totalTax - postTaxTotal);

  const etReimbursements = period.et?.et_reimbursements.reduce((sum, r) => sum + r.amount, 0) ?? 0;
  const netAdditionsTotal = round(period.net_additions.reduce((sum, a) => sum + a.amount, 0) + etReimbursements);
  const netDeductionsTotal = round(period.net_deductions.reduce((sum, d) => sum + d.amount, 0));
  const periodNet = round(wageNet + netAdditionsTotal - netDeductionsTotal);

  const payoutAdjustmentsTotal = round(period.payout_adjustments.reduce((sum, a) => sum + a.amount, 0));
  const payoutAmount = round(periodNet + payoutAdjustmentsTotal);

  return {
    status: 'complete',
    result: {
      gross_total: hourLinesTotal.gross,
      hours_worked: hourLinesTotal.hours_worked,
      pre_tax_deductions_total: preTaxTotal,
      loon_voor_heffingen: round(hourLinesTotal.gross - preTaxTotal),
      taxable_base: taxableBase,
      table_tax: tableTax,
      table_tax_after_korting: tableTaxAfterKorting,
      bt_tax: btTax,
      algemene_heffingskorting: algemeneHeffingskorting,
      arbeidskorting,
      total_tax: totalTax,
      post_tax_social_total: postTaxTotal,
      wage_net: wageNet,
      net_additions_total: netAdditionsTotal,
      net_deductions_total: netDeductionsTotal,
      period_net: periodNet,
      payout_adjustments_total: payoutAdjustmentsTotal,
      payout_amount: payoutAmount,
    },
  };
}
