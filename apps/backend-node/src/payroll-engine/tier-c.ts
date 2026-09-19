import {
  known, unknownField,
  type PayslipPeriod, type Employer, type Hirer, type HourLine, type HourLineCategory, type TaxTreatment,
  type PreTaxDeduction, type PreTaxDeductionCategory, type PostTaxSocialDeduction, type PostTaxSocialCategory,
  type NetLineItem, type NetDeductionCategory, type ReservationBalance, type ReservationType,
  type ExtraterritorialArrangement,
} from './payslip-model.js';
import { classifyPreTaxDeductionLabel, classifyPostTaxDeductionLabel } from './extraction-consistency.js';

/** Stage 2e (audit v24, §2e.1): "amounts on deduction, tax, post-tax and net lines are magnitudes;
 * the category carries the direction. Normalise where the amount enters the model and nowhere else."
 * The live Olympia read reproduced this exactly: deduction lines came back negative (-0.89, -1.23,
 * -34.79, as printed) and payslip-model.ts's computePayslipPeriod SUBTRACTS them expecting a positive
 * magnitude (gross - preTaxTotal) - a negative preTaxTotal flips that subtraction into an addition
 * (864.07 = 827.16 + 36.91, to the cent). This is the ONE place that normalisation happens - every
 * other file (payslip-model.ts, extraction-consistency.ts, discrepancy.ts) already assumes a positive
 * magnitude and always did; only the AI-extraction boundary could ever hand it a signed one. */
function magnitude(value: number): number {
  return Math.abs(value);
}
function magnitudeOrNull(value: number | null): number | null {
  return value === null ? null : Math.abs(value);
}

/**
 * Tier C - "Pro" (SPEC-loonto-architecture.md §5, build order item 2 per spec §9/BH1). Maps an AI
 * extraction of a real payslip onto the SAME PayslipPeriod model Tier A populates from typed input
 * (spec §2 - "one engine, one model. Do not fork per tier."). This file is the mapping layer only;
 * computation is computePayslipPeriod() (payslip-model.ts) and verification is
 * comparePeriodToDocument() (discrepancy.ts), unchanged, shared with every tier.
 *
 * ============================================================================================
 * MAPPING GAPS (audit BP1 point 2 - reported before any code, kept here as the living record of
 * what this mapping can and cannot determine, per field). "Do not reshape either side to fit" means:
 * PayslipPeriod is not simplified to match a shallow extraction, and the extraction schema is not
 * asked to invent data a real Dutch payslip usually does not print.
 * ============================================================================================
 *
 * RELIABLY MAPPABLE (the extraction schema below was widened to capture these; a real AI vision
 * read of the document should populate them with reasonable confidence):
 *   - period_label, period_end_date: direct read (unchanged from the pre-existing extraction).
 *   - period_type: NEW - previously inferred from a free-text label by nothing (never parsed); now
 *     asked for directly as an enum.
 *   - is_correction / version: NEW - previously not captured at all. Detectable when the document
 *     itself prints a correction marker ("KOREKTA", "herziening", a version number) - defaults to
 *     false/1 when no such marker is visible, which is the correct default, not a guess.
 *   - employer name, hirer name: NEW - both are printed on some documents (Olympia and Randstad both
 *     print a hirer distinct from the formal employer - the client company/inlener) and absent on
 *     others. Left null when not printed, never invented.
 *   - hour_lines: category/tax_treatment/adds_hours per line - NEW. The pre-existing schema had no
 *     concept of any of these; they are exactly why the old flat lineItems list could not populate
 *     HourLine's contract. tax_treatment defaults to 'unknown' (never 'table') when the document
 *     gives no signal, per the model's own rule that assuming 'table' is exactly the same class of
 *     guess as assuming 'bt' would be (payslip-model.ts's own HourLine doc comment).
 *   - printed bijzonder-tarief percentage AND jaarloon: NEW - corrected this round (audit BQ) after
 *     testing against the actual real documents, not just the curated fixture summary. All three
 *     documents that use BT print it directly: Randstad "Jaarloon bijz. beloning 46074" / "% tabel
 *     bijz. beloning 50,47%" (one combined number); PKF "Jaarloon BT: 38.000,00" / "Tarief BT: 35,75 +
 *     4,45%" (printed as TWO components - base rate + addon - that must be SUMMED, not read as one
 *     figure or picked apart); OTTO shows a jaarloon-shaped figure under an unlabelled "TSP" column
 *     next to its own printed 38,45% rate, not yet confirmed to mean the same thing. The prompt below
 *     asks for both components and sums them, rather than assuming one printed-rate format.
 *   - pre-tax/post-tax deduction category + placement: NEW, via the AI's own reading of the line
 *     (never a backend keyword-match against the printed text - real documents drop Polish diacritics
 *     inconsistently, e.g. "Jednorazowa zaplata" not "zapłata" on OTTO's actual document, which would
 *     break a naive string-match classifier; asking the model to classify directly avoids that).
 *     Falls back to category 'other' / placement 'pre_tax' when the model itself cannot classify - a
 *     conservative default that shows up as an unclassified line, not a silently-dropped one.
 *   - printed table/BT tax, algemene heffingskorting, arbeidskorting: NEW - needed for
 *     comparePeriodToDocument() to have anything to compare against; confirmed exactly correct on all
 *     four real documents this round (audit BQ) against the reference figures already used in
 *     tier-c.test.ts.
 *   - minimum wage (wml_printed) and its rules-DB counterpart (wml_applicable, via getRuleAt at the
 *     controller layer): NOT a new gap - already correctly implemented pre-Tier-C
 *     (rules-repository.ts's getMinimumWageAt, wired in payslip.controller.ts's
 *     resolvePayslipReferenceDate) and reused here unchanged.
 *
 * GENUINELY NOT RELIABLY MAPPABLE - stay unknown/null/a stated default, not fabricated:
 *   - employers[].franchise_bearing: with exactly one employer this is trivially `true` (nothing
 *     else it could be); with more than one (OTTO's DHL+KF case), which employer carries the StiPP
 *     franchise is NOT printed anywhere - it took manual reasoning across two rounds of this audit
 *     (T3/round 7-8) to work out for OTTO specifically, by testing which hypothesis reproduced the
 *     printed StiPP figure. An extraction cannot do that reasoning from one document. Stays
 *     `'unknown'` whenever more than one employer is detected - reported, not guessed. Confirmed
 *     against OTTO's real document (audit BQ): nothing on it identifies which employer is
 *     franchise-bearing any more clearly than the fixture summary did.
 *   - contract_hours: the model's own design (spec, "Wnioski dla modelu danych") already says this
 *     is independent of hours_worked with no cross-check - a payslip's `hoursPerWeek` field (kept,
 *     unchanged from the pre-existing extraction) is the closest available signal, not converted
 *     into a per-period contract_hours figure, since that conversion would itself be a guess about
 *     which weeks are covered.
 *   - et (ExtraterritorialArrangement): detected via keyword match ("ET", "extraterritoriale",
 *     "onbelaste vergoeding") against line descriptions - a real, working heuristic for OTTO's
 *     specific wording, but a heuristic, not a guaranteed general detector. Reported as best-effort.
 *   - reservations (vakantiegeld/vakantiedagen accrued-vs-paid): detected via keyword match on the
 *     line description ("vakantiegeld", "vakantiedagen", "reserve") plus a payment-sign heuristic
 *     (a reserve accrual is typically a running total shown without also appearing in the payment
 *     column; a payout appears as a genuine payment). Best-effort, same caveat as ET above.
 *   - employer_index per hour_line (which of several employers a specific line belongs to): defaults
 *     to 0 (the first/only employer) unless the extraction explicitly tags a line otherwise - most
 *     documents have exactly one employer, so this only matters for OTTO-shaped multi-employer cases,
 *     where it is a real, currently-unclosed gap (flagged, not silently assigned).
 */

export type TierCPeriodType = 'week' | '4-weekly' | 'month';

export interface TierCHourLine {
  employer_index: number;
  description: string;
  hours: number | null;
  rate: number | null;
  percent: number | null;
  amount: number;
  category: HourLineCategory;
  tax_treatment: TaxTreatment;
  adds_hours: boolean;
}

export interface TierCDeductionLine {
  description: string;
  /** Stage 2e (§2e.5): null when the model genuinely could not read the printed amount - never
   * silently 0 (which would understate the taxable base or net without saying so). */
  amount: number | null;
  category: PreTaxDeductionCategory | PostTaxSocialCategory;
  placement: 'pre_tax' | 'post_tax';
  base: number | null;
  percent: number | null;
}

export interface TierCNetLine {
  description: string;
  amount: number;
  category: NetDeductionCategory | 'reimbursement';
}

export interface TierCReservationLine {
  type: ReservationType;
  opgebouwd: number;
  paid_out: number;
}

export interface TierCExtraction {
  period_label: string | null;
  period_end_date: string | null;
  /** Stage 2b (audit v12): the date the payslip states it was PAID, distinct from period_end_date -
   * a real document (Olympia) can print a period-end date whose YEAR was misread while a separately-
   * printed payment date is correct (or vice versa); comparing the two is one of extraction-
   * consistency.ts's checks. null when the document prints no separate payment date. */
  payment_date: string | null;
  period_type: TierCPeriodType | null;
  is_correction: boolean;
  version: number;
  /** One entry per distinct employer detected on the document - length 1 for the common case,
   * length 2 for a two-employer document like OTTO. Empty when no employer name is printed at all. */
  employer_names: string[];
  hirer_name: string | null;
  hours_per_week: number | null;
  minimum_wage_printed: number | null;
  hour_lines: TierCHourLine[];
  pre_tax_deduction_lines: TierCDeductionLine[];
  post_tax_deduction_lines: TierCDeductionLine[];
  bijzonder_tarief_printed_percent: number | null;
  /** The prior year's jaarloon used to look up the BT rate - confirmed THIS round (audit BQ) to be
   * printed directly on real documents more often than the earlier gap analysis assumed (Randstad
   * "Jaarloon bijz. beloning", PKF "Jaarloon BT"). Kept for informational/verification purposes; the
   * computation itself is driven by `bijzonder_tarief_printed_percent`, not re-derived from this. */
  bijzonder_tarief_jaarloon: number | null;
  et_exchange_amount: number | null;
  et_reimbursement_lines: TierCNetLine[];
  net_lines: TierCNetLine[];
  payout_adjustment_lines: Array<{ description: string; amount: number }>;
  reservation_lines: TierCReservationLine[];
  printed_table_tax: number | null;
  printed_bt_tax: number | null;
  printed_algemene_heffingskorting: number | null;
  printed_arbeidskorting: number | null;
  reported_total_net: number | null;
  reported_net_paid: number | null;
  /** Stage 2e (§2e.3): the document's own printed subtotals, read by POSITION in the gross-to-net
   * chain (the figure right after the gross lines; the figure right after the pre-tax deductions),
   * never by matching a specific label string - the label varies by employer (Olympia "TOTAAL BRUTO",
   * Randstad "LOON VOOR HEFFINGEN", PKF "PODSTAWA"). null when the document prints no distinct
   * subtotal at that position. */
  printed_gross_total: number | null;
  printed_loon_voor_heffingen: number | null;
  /** Stage 2 body ("Dutch terms as printed... not canonical"): the as-printed label next to each of
   * the six reference figures above, captured verbatim exactly like hour_lines[].description already
   * is - null (never a guessed canonical term) when the document has no distinct label for that
   * figure. See discrepancy.ts's Discrepancy.printed_label for where this surfaces to the user. */
  printed_table_tax_label: string | null;
  printed_bt_tax_label: string | null;
  printed_algemene_heffingskorting_label: string | null;
  printed_arbeidskorting_label: string | null;
  printed_net_label: string | null;
  printed_payout_label: string | null;
  truncated: boolean;
  redacted_fields: string[];
}

/**
 * Maps a (widened) AI extraction onto PayslipPeriod. Pure and synchronous - no computation happens
 * here (spec §2), only population, exactly mirroring how tier-a.ts's buildTierAPeriod() only builds
 * a period from typed input. `applicableMinimumWage` is resolved by the caller from the rules DB
 * (getRuleAt('loonheffing_nl', period end) via getMinimumWageAt) BEFORE this runs (audit BP1 point
 * 4/N4) - never derived here from the document's own printed figure.
 */
export function mapExtractionToPeriod(extraction: TierCExtraction, applicableMinimumWage: number | null): PayslipPeriod {
  // Exactly one employer: franchise_bearing is trivially true (nothing else it could be). More than
  // one (OTTO's DHL+KF case): which one carries the StiPP franchise is not printed anywhere and took
  // manual cross-fixture reasoning to work out even for OTTO specifically (T3, rounds 7-8) - stays
  // 'unknown' for every employer on the document, reported rather than guessed (see the gap note
  // above). Zero names detected: treated as one unnamed employer, still trivially franchise-bearing.
  const employerNames = extraction.employer_names.length > 0 ? extraction.employer_names : [null];
  const employers: Employer[] = employerNames.map((name) => ({
    name,
    franchise_bearing: employerNames.length === 1 ? true : 'unknown',
  }));
  const hirer: Hirer | null = extraction.hirer_name ? { name: extraction.hirer_name } : null;

  const hourLines: HourLine[] = extraction.hour_lines.map((line) => ({
    employer_index: line.employer_index,
    description: line.description,
    hours: line.hours,
    rate: line.rate,
    percent: line.percent,
    amount: line.amount,
    category: line.category,
    tax_treatment: line.tax_treatment,
    adds_hours: line.adds_hours,
  }));

  // Stage 2e (§2e.4): "the label decides for known families... the model's category is advisory."
  // classifyPreTaxDeductionLabel/classifyPostTaxDeductionLabel are now the SOLE source of truth for
  // the four known families - overriding whatever category the extraction itself proposed, not
  // merely flagging a mismatch afterward (extraction-consistency.ts's own keyword check now runs
  // AFTER this and is a dormant backstop for Tier C's own pipeline, per that file's comment). A label
  // matching no keyword is 'other' - the model's own guess is never used as a fallback, per "never
  // guess a category for an unmatched label."
  const preTaxDeductions: PreTaxDeduction[] = extraction.pre_tax_deduction_lines.map((line) => ({
    category: classifyPreTaxDeductionLabel(line.description) ?? 'other',
    description: line.description,
    amount: line.amount === null ? unknownField() : known(magnitude(line.amount), 'payslip_extracted'),
    base: line.base,
    percent: line.percent,
  }));

  const postTaxSocial: PostTaxSocialDeduction[] = extraction.post_tax_deduction_lines.map((line) => ({
    category: classifyPostTaxDeductionLabel(line.description) ?? 'other',
    description: line.description,
    amount: line.amount === null ? unknownField() : known(magnitude(line.amount), 'payslip_extracted'),
    percent: line.percent,
  }));

  const netAdditions: NetLineItem[] = [
    ...extraction.net_lines.filter((l) => l.category === 'reimbursement').map((l) => ({ category: l.category, description: l.description, amount: magnitude(l.amount) })),
    ...extraction.et_reimbursement_lines.map((l) => ({ category: 'reimbursement' as const, description: l.description, amount: magnitude(l.amount) })),
  ];
  const netDeductions: NetLineItem[] = extraction.net_lines
    .filter((l) => l.category !== 'reimbursement')
    .map((l) => ({ category: l.category as NetDeductionCategory, description: l.description, amount: magnitude(l.amount) }));

  const et: ExtraterritorialArrangement | null = extraction.et_exchange_amount !== null || extraction.et_reimbursement_lines.length > 0
    ? {
        et_applicable: true,
        et_exchange_amount: extraction.et_exchange_amount ?? 0,
        et_reimbursements: extraction.et_reimbursement_lines.map((l) => ({ description: l.description, amount: l.amount })),
        adres_fiskalny: null, // not requested from extraction - not needed by computePayslipPeriod, informational only in the model
      }
    : null;

  const reservations: ReservationBalance[] = extraction.reservation_lines.map((r) => ({
    type: r.type,
    opgebouwd_this_period: r.opgebouwd,
    paid_out_this_period: r.paid_out,
    saldo_after: null,
  }));

  // bt_state: 'known' whenever a BT percentage is printed directly (jaarloon_bt is then irrelevant
  // to the computation - tarief_bt.printed wins over tarief_bt.computed regardless), 'not_applicable'
  // when no BT-tagged line exists at all, 'unknown' when a BT-tagged line exists but no percentage
  // was found anywhere on the document (a genuine, reportable gap - never defaulted to a rate).
  const hasBtLine = hourLines.some((l) => l.tax_treatment === 'bt');
  const btState = extraction.bijzonder_tarief_printed_percent !== null ? 'known' : hasBtLine ? 'unknown' : 'not_applicable';

  return {
    period_label: extraction.period_label,
    period_type: extraction.period_type ?? 'week', // spec gives no field to fall back to; 'week' is the most common real-fixture shape, and is reported via the `period_type` gap note when the extraction itself returned null
    period_end_date: extraction.period_end_date,
    is_correction: extraction.is_correction,
    version: extraction.version,
    employers,
    hirer,
    contract_hours: null, // not converted from hours_per_week - see the mapping-gap note above
    hour_lines: hourLines,
    pre_tax_deductions: preTaxDeductions,
    bijzonder_tarief: {
      jaarloon_bt: extraction.bijzonder_tarief_jaarloon,
      bt_state: btState,
      tarief_bt: { printed: extraction.bijzonder_tarief_printed_percent, computed: null },
    },
    et,
    post_tax_social: postTaxSocial,
    net_additions: netAdditions,
    net_deductions: netDeductions,
    payout_adjustments: extraction.payout_adjustment_lines,
    reservations,
    wml_printed: extraction.minimum_wage_printed,
    wml_applicable: applicableMinimumWage,
    printed_table_tax: magnitudeOrNull(extraction.printed_table_tax),
    printed_bt_tax: magnitudeOrNull(extraction.printed_bt_tax),
    printed_algemene_heffingskorting: extraction.printed_algemene_heffingskorting,
    printed_arbeidskorting: extraction.printed_arbeidskorting,
    // CL: these two were extracted but silently dropped here for two rounds - the fields existed on
    // TierCExtraction, comparePeriodToDocument declared codes for them, but nothing connected the two.
    printed_net: extraction.reported_total_net,
    printed_payout: extraction.reported_net_paid,
    printed_gross_total: extraction.printed_gross_total,
    printed_loon_voor_heffingen: extraction.printed_loon_voor_heffingen,
    printed_table_tax_label: extraction.printed_table_tax_label,
    printed_bt_tax_label: extraction.printed_bt_tax_label,
    printed_algemene_heffingskorting_label: extraction.printed_algemene_heffingskorting_label,
    printed_arbeidskorting_label: extraction.printed_arbeidskorting_label,
    printed_net_label: extraction.printed_net_label,
    printed_payout_label: extraction.printed_payout_label,
  };
}
