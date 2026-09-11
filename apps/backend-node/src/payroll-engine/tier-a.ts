import {
  known,
  unknownField,
  computePayslipPeriod,
  type PayslipPeriod,
  type PayslipComputationOutcome,
  type HourLine,
  type PreTaxDeduction,
  type PostTaxSocialDeduction,
  type ReservationBalance,
  type PayslipComputationRates,
} from './payslip-model.js';

/**
 * Tier A - "Quick calculator" (SPEC-loonto-architecture.md §3). Populates the SAME PayslipPeriod
 * model and runs the SAME payroll engine as Tiers B and C (spec §2 - "one engine, one model. Do not
 * fork per tier.") - this file only builds a PayslipPeriod from what a worker can supply unaided; it
 * contains no computation logic of its own beyond that construction.
 */

export interface TierAOvertimeLine {
  description: string;
  hours: number;
  percent: number;
  /** true = genuinely additional hours (real overtime); false = a surcharge multiplier on hours
   * already counted in the base line (e.g. Olympia's "onregelm. uren" surcharges) - mirrors
   * HourLine.adds_hours exactly, since Tier A builds the same HourLine shape every tier uses. */
  adds_hours: boolean;
}

export type VakantiegeldTreatment =
  | { mode: 'none' }
  /** Accruing this period, not payable now (spec §3): outside gross and net entirely, shown only as
   * a reservation balance. This is the DEFAULT reading and the one the old "Doliczaj vakantiegeld
   * (8%)" control silently implied was something else. */
  | { mode: 'accruing'; percent: number }
  /** Being paid out THIS period: enters gross and is taxed at bijzonder tarief, not the table rate
   * (spec §3). Tier A has no jaarloon_bt (that needs a document/history it does not have), so the
   * BT percentage itself is `unknown` here - computePayslipPeriod's btRateUnknown check (audit
   * round, architecture change) then correctly stops the computation rather than silently taxing
   * this amount at the table rate or at 0%, either of which would be a fabricated number. */
  | { mode: 'paid_now'; percent: number };

export type DeductionMode = 'enter' | 'estimate' | 'skip';

export interface TierADeductionInputs {
  mode: DeductionMode;
  /** Only meaningful when mode === 'enter' - amounts the user typed themselves, in EUR for this
   * period (not a percentage), since that is what a worker reads directly off a payslip line.
   * `post_tax_other` (e.g. a WHK/WGA line) is not one of the three deduction categories Tier A asks
   * about (spec §3's deduction question is specifically pension/PAWW/sector premium, all pre-tax) -
   * it exists so a worker who happens to know this smaller, less standardised figure can still enter
   * it rather than have it silently omitted; Tier A never estimates or blocks on it. */
  entered?: { pension?: number; paww?: number; sector_premium?: number; post_tax_other?: number };
}

export interface TierAInput {
  period_type: 'week' | '4-weekly' | 'month';
  hours_worked: number;
  hourly_rate: number;
  overtime_lines: TierAOvertimeLine[];
  apply_loonheffingskorting: boolean;
  travel_allowance: number;
  vakantiegeld: VakantiegeldTreatment;
  deductions: TierADeductionInputs;
}

/**
 * Sourced, population-level defaults for the "estimate for me" path (spec §3.2, point 4 of the
 * architecture-round audit reply - "do not derive them from the reference payslips, three documents
 * is not a population"). Each one cites where it comes from, independent of any fixture in this repo.
 */
export const ESTIMATED_STIPP_DEFAULTS = {
  franchise_per_hour: 9.24,
  employee_rate_percent: 7.5,
  source: 'https://www.stippensioen.nl/werknemer/pensioen-bij-stipp/de-pensioenregeling/premie/ (StiPP - mandatory pension scheme for the uitzendbranche, 2026 rates)',
};

export const ESTIMATED_PAWW_DEFAULT = {
  percent: 0.1,
  source: 'https://spaww.nl/over-spaww/nieuws/paww-premie-blijft-0-1-in-2026/ (SPAWW - nationally uniform premium, unchanged for 2026)',
};

/**
 * Deliberately NOT defaulted, even in "estimate" mode (audit round, architecture change, point 4):
 * the sector/Ziektewet premium an agency deducts from an employee varies by document in every
 * reference fixture this engagement has seen (0.7% on one, absent on another), and the only
 * authoritative published figures found (WGA ~2.92%, Ziektewet up to 6.49% for the uitzendbranche)
 * are the EMPLOYER's differentiated premium, not a confirmed employee-deducted rate. Fabricating one
 * here would repeat exactly the failure mode this whole architecture change exists to eliminate -
 * this category stays `unknownField()` even under "estimate", with this note surfaced to the user.
 */
export const SECTOR_PREMIUM_NO_DEFAULT_REASON =
  'Geen betrouwbaar landelijk gemiddelde beschikbaar voor de werknemersbijdrage sectorpremie - dit verschilt per uitzendbureau. Voer het bedrag in vanaf uw loonstrook, of laat het openstaan.';

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function buildPreTaxDeductions(input: TierAInput, grossSoFar: number): PreTaxDeduction[] {
  const { mode, entered } = input.deductions;

  if (mode === 'skip') {
    return [
      { category: 'pension', description: 'STIPP-pensioen (niet opgegeven)', amount: unknownField(), base: null, percent: null },
      { category: 'paww', description: 'PAWW-premie (niet opgegeven)', amount: unknownField(), base: null, percent: null },
      { category: 'ziektewet', description: 'Sectorpremie (niet opgegeven)', amount: unknownField(), base: null, percent: null },
    ];
  }

  if (mode === 'estimate') {
    const pensionAmount = round2(Math.max(0, grossSoFar - ESTIMATED_STIPP_DEFAULTS.franchise_per_hour * input.hours_worked) * (ESTIMATED_STIPP_DEFAULTS.employee_rate_percent / 100));
    const pawwAmount = round2(grossSoFar * (ESTIMATED_PAWW_DEFAULT.percent / 100));
    return [
      { category: 'pension', description: `STIPP-pensioen (schatting, ${ESTIMATED_STIPP_DEFAULTS.source})`, amount: known(pensionAmount, 'estimated'), base: round2(grossSoFar), percent: ESTIMATED_STIPP_DEFAULTS.employee_rate_percent },
      { category: 'paww', description: `PAWW-premie (schatting, ${ESTIMATED_PAWW_DEFAULT.source})`, amount: known(pawwAmount, 'estimated'), base: round2(grossSoFar), percent: ESTIMATED_PAWW_DEFAULT.percent },
      { category: 'ziektewet', description: `Sectorpremie (${SECTOR_PREMIUM_NO_DEFAULT_REASON})`, amount: unknownField(), base: null, percent: null },
    ];
  }

  // mode === 'enter'
  const lines: PreTaxDeduction[] = [];
  if (entered?.pension !== undefined) lines.push({ category: 'pension', description: 'STIPP-pensioen (opgegeven)', amount: known(entered.pension, 'user_entered'), base: null, percent: null });
  if (entered?.paww !== undefined) lines.push({ category: 'paww', description: 'PAWW-premie (opgegeven)', amount: known(entered.paww, 'user_entered'), base: null, percent: null });
  if (entered?.sector_premium !== undefined) lines.push({ category: 'ziektewet', description: 'Sectorpremie (opgegeven)', amount: known(entered.sector_premium, 'user_entered'), base: null, percent: null });
  return lines;
}

function buildPostTaxSocial(input: TierAInput): PostTaxSocialDeduction[] {
  const postTaxOther = input.deductions.entered?.post_tax_other;
  if (input.deductions.mode !== 'enter' || postTaxOther === undefined) return [];
  return [{ category: 'other', description: 'Overige na-belasting premie (opgegeven)', amount: known(postTaxOther, 'user_entered'), percent: null }];
}

/** Builds the PayslipPeriod Tier A's own three-way deduction question and vakantiegeld distinction
 * produce - the same model Tiers B and C populate differently (spec §2). No computation happens
 * here; call computePayslipPeriod() on the result exactly as any other tier would. */
export function buildTierAPeriod(input: TierAInput): PayslipPeriod {
  const baseAmount = round2(input.hours_worked * input.hourly_rate);
  const hourLines: HourLine[] = [
    { employer_index: 0, description: 'Uren gewerkt', hours: input.hours_worked, rate: input.hourly_rate, percent: null, amount: baseAmount, category: 'regular', tax_treatment: 'table', adds_hours: true },
  ];

  let grossBeforeVakantiegeld = baseAmount;
  for (const line of input.overtime_lines) {
    const amount = line.adds_hours
      ? round2(line.hours * input.hourly_rate * (1 + line.percent / 100))
      : round2(line.hours * input.hourly_rate * (line.percent / 100));
    grossBeforeVakantiegeld += amount;
    hourLines.push({
      employer_index: 0,
      description: line.description,
      hours: line.hours,
      rate: input.hourly_rate,
      percent: line.percent,
      amount,
      category: line.adds_hours ? 'overtime' : 'irregular_surcharge',
      // Tier A has no document establishing that a line is taxed at bijzonder tarief - BT
      // applicability and rate both depend on information (last year's income) Tier A structurally
      // lacks (spec §4 makes the same point about Tier B). Every Tier A line is 'table' by default,
      // matching the real Olympia document (which genuinely has no BT) rather than guessing BT.
      tax_treatment: 'table',
      adds_hours: line.adds_hours,
    });
  }

  const reservations: ReservationBalance[] = [];
  let bijzonderTariefState: 'not_applicable' | 'unknown' = 'not_applicable';
  if (input.vakantiegeld.mode === 'accruing') {
    const accrued = round2(grossBeforeVakantiegeld * (input.vakantiegeld.percent / 100));
    reservations.push({ type: 'vakantiegeld', opgebouwd_this_period: accrued, paid_out_this_period: 0, saldo_after: null });
  } else if (input.vakantiegeld.mode === 'paid_now') {
    const paidAmount = round2(grossBeforeVakantiegeld * (input.vakantiegeld.percent / 100));
    hourLines.push({
      employer_index: 0,
      description: 'Vakantiegeld uitbetaald',
      hours: null,
      rate: null,
      percent: input.vakantiegeld.percent,
      amount: paidAmount,
      category: 'other',
      tax_treatment: 'bt',
      adds_hours: false,
    });
    // Genuinely unknown, not a guess: the BT percentage depends on last year's jaarloon, which
    // Tier A has no way to know. computePayslipPeriod's btRateUnknown check (architecture round)
    // stops the computation here rather than silently taxing this at 0% or at the table rate.
    bijzonderTariefState = 'unknown';
  }

  return {
    period_label: null,
    period_type: input.period_type,
    period_end_date: null,
    is_correction: false,
    version: 1,
    employers: [{ name: null, franchise_bearing: 'unknown' }],
    hirer: null,
    contract_hours: null,
    hour_lines: hourLines,
    pre_tax_deductions: buildPreTaxDeductions(input, grossBeforeVakantiegeld),
    bijzonder_tarief: { jaarloon_bt: null, bt_state: bijzonderTariefState, tarief_bt: { printed: null, computed: null } },
    et: null,
    post_tax_social: buildPostTaxSocial(input),
    net_additions: input.travel_allowance > 0 ? [{ category: 'reimbursement', description: 'Reiskostenvergoeding', amount: input.travel_allowance }] : [],
    net_deductions: [],
    payout_adjustments: [],
    reservations,
    wml_printed: null,
    wml_applicable: null,
    printed_table_tax: null,
    printed_bt_tax: null,
    printed_algemene_heffingskorting: null,
    printed_arbeidskorting: null,
  };
}

export interface TierASanityWarning {
  code: 'net_exceeds_gross' | 'effective_rate_exceeds_gross_rate';
  message: string;
}

/**
 * Sanity check before rendering (spec §3, "Sanity check before rendering") - the live build showed
 * 16.54 net per hour against an entered 15.55 gross without comment. This is a Tier-A-specific UI
 * concern (it needs the user's own entered gross hourly rate for comparison, which is not part of
 * the generic PayslipPeriod/engine contract), so it lives here rather than in the shared engine.
 */
export function checkTierASanity(outcome: PayslipComputationOutcome, input: TierAInput): TierASanityWarning[] {
  if (outcome.status !== 'complete') return [];
  const warnings: TierASanityWarning[] = [];
  const { result } = outcome;
  if (result.payout_amount > result.gross_total) {
    warnings.push({ code: 'net_exceeds_gross', message: `Netto (${result.payout_amount.toFixed(2)}) is hoger dan bruto (${result.gross_total.toFixed(2)}) - controleer de invoer.` });
  }
  if (result.hours_worked > 0) {
    const effectiveNetHourlyRate = result.payout_amount / result.hours_worked;
    if (effectiveNetHourlyRate > input.hourly_rate) {
      warnings.push({ code: 'effective_rate_exceeds_gross_rate', message: `Effectief netto uurloon (${effectiveNetHourlyRate.toFixed(2)}) is hoger dan het opgegeven bruto uurloon (${input.hourly_rate.toFixed(2)}) - controleer de invoer.` });
    }
  }
  return warnings;
}

export type { PayslipComputationRates };
