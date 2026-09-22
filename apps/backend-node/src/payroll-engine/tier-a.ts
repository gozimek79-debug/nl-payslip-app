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
import {
  convertHourGridToLines,
  resolveOvertimeTierThreshold,
  type HourGridInput,
  type HourGridLineCategory,
  type OvertimeTierThreshold,
} from './hour-grid.js';

/**
 * Tier A - "Quick calculator" (SPEC-loonto-architecture.md §3). Populates the SAME PayslipPeriod
 * model and runs the SAME payroll engine as Tiers B and C (spec §2 - "one engine, one model. Do not
 * fork per tier.") - this file only builds a PayslipPeriod from what a worker can supply unaided; it
 * contains no computation logic of its own beyond that construction.
 */

/**
 * CX2a (audit "CK RESTATED, THEN FINISH TIER A" round): a percentage surcharge on hours already
 * counted elsewhere (Olympia's real "Loon onregelm. uren 100%/50%", "ADV toeslag") - always
 * adds_hours:false. Deliberately NOT part of the day grid below: these are period-level CAO
 * allowances a worker states directly by hours+percent, not tied to which day of the week they fell
 * on - forcing them into a day cell would ask the user a question their payslip doesn't answer
 * either. This is the exact mechanism Tier A already had (renamed from TierAOvertimeLine) - the day
 * grid ADDS the missing Saturday/Sunday/holiday/tiered-overtime dimension, it does not replace this.
 */
export interface TierASurchargeLine {
  description: string;
  hours: number;
  percent: number;
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
  hourly_rate: number;
  /** CD/CX2a: one HourGridInput per week - length 1 for 'week', typically 4 for '4-weekly'/'month'
   * (CM1: a week-selector reuses one grid component across several weeks in the UI; the underlying
   * data is still N independent week-grids, summed here). CM2: starts empty (all-zero) in the UI -
   * this module makes no assumption about a "typical" week. */
  week_grids: HourGridInput[];
  /** User-entered only (Tier A has no contract/payslip to derive it from, spec §4/§5b) - null means
   * genuinely unknown, never defaulted (spec §5b: "do not ship a default"). */
  overtime_tier_threshold_hours: number | null;
  overtime_tier_1_percent: number | null;
  overtime_tier_2_percent: number | null;
  saturday_percent: number | null;
  sunday_percent: number | null;
  holiday_percent: number | null;
  surcharge_lines: TierASurchargeLine[];
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
 * Owner's decision (audit AZ1-AZ4, following up on the earlier round's refusal to invent this
 * default): the sector/Ziektewet premium still has no statutory or sector-published employee-side
 * rate (the only authoritative figures found - WGA ~2.92%, Ziektewet up to 6.49% - are the
 * EMPLOYER's differentiated premium, not a confirmed employee-deducted one). Rather than block net
 * entirely on this one line, the estimate path now uses a RANGE observed across the four real
 * reference payslips this engagement has, disclosed as a range rather than averaged into a single,
 * falsely-precise number (AZ2 - an average would be wrong by up to 40% in one direction, silently).
 *
 *   Randstad   Ziektewet premiegroep II A      0.700%   <- upper bound
 *   Olympia    AZW werknemer                   0.553%
 *   PKF        WGA-Gat werknemer                0.183%   <- lower bound (gediff. WGA 0.345% is a
 *                                                            separate, additional line on that
 *                                                            document, not folded into this floor)
 *   OTTO       WHK own contribution            not stated on the document
 *
 * AZ4: this is a sample of FOUR DOCUMENTS FROM ONE PERSON, not a population - it is provisional.
 * If a future payslip's own printed figure for this line falls outside 0.18%-0.70%, WIDEN this
 * range; do not treat that document as anomalous. Update this object, not the engine - it is data
 * Tier A supplies to the model, not a constant baked into computePayslipPeriod.
 */
export const SECTOR_PREMIUM_ESTIMATE_RANGE = {
  low_percent: 0.18,
  high_percent: 0.7,
};

/**
 * BK4 (language-regression round): the Dutch line names this category is filed under vary by
 * agency - this is data, not UI copy, and lives here (reference data) rather than baked into a
 * sentence in either language. The frontend renders the SURROUNDING sentence in the interface
 * language and inserts these literal (untranslated - they are Dutch proper nouns/line names, not
 * concepts) terms into it, rather than the backend supplying one hardcoded Dutch sentence that
 * ignored the language switch entirely (the exact defect this round exists to fix, audit BJ1).
 */
export const SECTOR_PREMIUM_KNOWN_TERMS = ['Ziektewet', 'AZW', 'WGA', 'WHK'];

export interface TierASectorPremiumEstimate {
  low_percent: number;
  high_percent: number;
  low_amount: number;
  high_amount: number;
  provenance: 'estimated';
  /** BK4: the payslip line names this category appears under, across the reference documents -
   * literal Dutch terms, not translated copy. The frontend builds its own translated sentence
   * around this list (see translations.ts's tierA.sectorPremiumBasis). */
  known_terms: string[];
}

/** Computes the sector-premium range in EUR for a given gross total (AZ1). Kept separate from
 * pre_tax_deductions entirely (AZ5 - "only net and the sector-premium line... gross, taxable base
 * and tax are unaffected") rather than modeled as a Field<number> range, since PreTaxDeduction.amount
 * is a single Field<number> by design everywhere else in this model. */
export function estimateSectorPremiumRange(grossTotal: number): TierASectorPremiumEstimate {
  return {
    low_percent: SECTOR_PREMIUM_ESTIMATE_RANGE.low_percent,
    high_percent: SECTOR_PREMIUM_ESTIMATE_RANGE.high_percent,
    low_amount: round2(grossTotal * (SECTOR_PREMIUM_ESTIMATE_RANGE.low_percent / 100)),
    high_amount: round2(grossTotal * (SECTOR_PREMIUM_ESTIMATE_RANGE.high_percent / 100)),
    provenance: 'estimated',
    known_terms: SECTOR_PREMIUM_KNOWN_TERMS,
  };
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * BK1/BK3/BK4 (language-regression round): `description` on every line is the DUTCH TERM, not a
 * translated, provenance-annotated sentence - the earlier version baked "(schatting, <url>)" /
 * "(opgegeven)" / "(niet opgegeven)" directly into this Dutch string, which is exactly why the
 * frontend had to `.split(' (')[0]` it back apart to render anything else (audit BJ1's regression).
 * Provenance is ALREADY carried by `amount.provenance` (Field<T>) and is the frontend's job to
 * label, in the interface language; this constant is the single source for Tier A's CANONICAL term
 * per category (Tiers B/C would instead use the term AS PRINTED on the user's own document, once
 * built - same field, different population, per BK3).
 */
const TIER_A_DUTCH_TERMS = {
  pension: 'StiPP-pensioenpremie',
  paww: 'PAWW-premie',
  sectorPremium: 'Sectorpremie (Ziektewet/AZW/WGA/WHK)',
  postTaxOther: 'Overige inhouding na belasting',
};

function buildPreTaxDeductions(input: TierAInput, grossSoFar: number, hoursWorked: number): PreTaxDeduction[] {
  const { mode, entered } = input.deductions;

  if (mode === 'skip') {
    return [
      { category: 'pension', description: TIER_A_DUTCH_TERMS.pension, amount: unknownField(), base: null, percent: null },
      { category: 'paww', description: TIER_A_DUTCH_TERMS.paww, amount: unknownField(), base: null, percent: null },
      { category: 'ziektewet', description: TIER_A_DUTCH_TERMS.sectorPremium, amount: unknownField(), base: null, percent: null },
    ];
  }

  if (mode === 'estimate') {
    const pensionAmount = round2(Math.max(0, grossSoFar - ESTIMATED_STIPP_DEFAULTS.franchise_per_hour * hoursWorked) * (ESTIMATED_STIPP_DEFAULTS.employee_rate_percent / 100));
    const pawwAmount = round2(grossSoFar * (ESTIMATED_PAWW_DEFAULT.percent / 100));
    // Sector premium is deliberately NOT a row here (AZ1/AZ5, owner's decision): it is a RANGE, not
    // a single Field<number>, computed separately by estimateSectorPremiumRange() and applied
    // directly to net/payout in computeTierAResult() - never entering pre_tax_deductions, so it
    // cannot affect taxable_base or tax the way a normal PreTaxDeduction would. Each default's
    // source URL (ESTIMATED_STIPP_DEFAULTS.source / ESTIMATED_PAWW_DEFAULT.source) documents where
    // the rate came from for audit purposes - it was never actually surfaced to the user (the old
    // description string with the URL embedded was stripped by the frontend before rendering).
    return [
      { category: 'pension', description: TIER_A_DUTCH_TERMS.pension, amount: known(pensionAmount, 'estimated'), base: round2(grossSoFar), percent: ESTIMATED_STIPP_DEFAULTS.employee_rate_percent },
      { category: 'paww', description: TIER_A_DUTCH_TERMS.paww, amount: known(pawwAmount, 'estimated'), base: round2(grossSoFar), percent: ESTIMATED_PAWW_DEFAULT.percent },
    ];
  }

  // mode === 'enter'
  const lines: PreTaxDeduction[] = [];
  if (entered?.pension !== undefined) lines.push({ category: 'pension', description: TIER_A_DUTCH_TERMS.pension, amount: known(entered.pension, 'user_entered'), base: null, percent: null });
  if (entered?.paww !== undefined) lines.push({ category: 'paww', description: TIER_A_DUTCH_TERMS.paww, amount: known(entered.paww, 'user_entered'), base: null, percent: null });
  if (entered?.sector_premium !== undefined) lines.push({ category: 'ziektewet', description: TIER_A_DUTCH_TERMS.sectorPremium, amount: known(entered.sector_premium, 'user_entered'), base: null, percent: null });
  return lines;
}

function buildPostTaxSocial(input: TierAInput): PostTaxSocialDeduction[] {
  const postTaxOther = input.deductions.entered?.post_tax_other;
  if (input.deductions.mode !== 'enter' || postTaxOther === undefined) return [];
  return [{ category: 'other', description: TIER_A_DUTCH_TERMS.postTaxOther, amount: known(postTaxOther, 'user_entered'), percent: null }];
}

/**
 * CD/CX2a: which day an hour falls on (Saturday/Sunday/public holiday, and tiered overtime within a
 * working day) - resolved via the SAME hour-grid.ts module built and tested for Tier C (audit
 * "SEVERAL EMPLOYERS AT ONCE" round), not a second, parallel implementation. Tier A is
 * single-employer only (CR3: the common case does not pay for the rare one) - this calls
 * convertHourGridToLines() once per week in `week_grids` and sums the per-category totals across
 * weeks, exactly mirroring how convertMultiEmployerHourGrid sums across employers, just across weeks
 * of one worker's one job instead.
 */
export type TierAGridResult =
  | { status: 'blocked'; reason: 'overtime_threshold_unknown'; days_affected: string[] }
  | { status: 'blocked'; reason: 'category_percent_missing'; categories: HourGridLineCategory[] }
  | { status: 'ready'; hour_lines: HourLine[]; hours_worked: number };

const CATEGORY_DUTCH_TERM: Record<HourGridLineCategory, string> = {
  regular: 'Uren gewerkt',
  overtime_tier_1: 'Overwerk (1e schijf)',
  overtime_tier_2: 'Overwerk (2e schijf)',
  saturday: 'Zaterdaguren',
  sunday: 'Zondaguren',
  holiday: 'Feestdaguren',
};

function categoryPercent(category: HourGridLineCategory, input: TierAInput): number | null {
  switch (category) {
    case 'regular':
      return 0;
    case 'overtime_tier_1':
      return input.overtime_tier_1_percent;
    case 'overtime_tier_2':
      return input.overtime_tier_2_percent;
    case 'saturday':
      return input.saturday_percent;
    case 'sunday':
      return input.sunday_percent;
    case 'holiday':
      return input.holiday_percent;
  }
}

export function resolveTierAHourGrid(input: TierAInput): TierAGridResult {
  const threshold: OvertimeTierThreshold = resolveOvertimeTierThreshold({
    contract_stated: null,
    payslip_reproduced_evidence: null,
    user_entered: input.overtime_tier_threshold_hours,
  });

  const categoryTotals: Record<HourGridLineCategory, number> = {
    regular: 0,
    overtime_tier_1: 0,
    overtime_tier_2: 0,
    saturday: 0,
    sunday: 0,
    holiday: 0,
  };
  const blockedDays = new Set<string>();

  for (const grid of input.week_grids) {
    const converted = convertHourGridToLines(grid, threshold);
    if (converted.status === 'blocked') {
      for (const day of converted.days_affected) blockedDays.add(day);
      continue;
    }
    for (const line of converted.lines) categoryTotals[line.category] += line.hours;
  }

  if (blockedDays.size > 0) {
    return { status: 'blocked', reason: 'overtime_threshold_unknown', days_affected: [...blockedDays] };
  }

  const missingPercentCategories: HourGridLineCategory[] = [];
  const hourLines: HourLine[] = [];
  let hoursWorked = 0;

  for (const category of Object.keys(categoryTotals) as HourGridLineCategory[]) {
    const hours = categoryTotals[category];
    if (hours <= 0) continue;
    const percent = categoryPercent(category, input);
    if (percent === null) {
      missingPercentCategories.push(category);
      continue;
    }
    hourLines.push({
      employer_index: 0,
      description: CATEGORY_DUTCH_TERM[category],
      hours,
      rate: input.hourly_rate,
      percent: percent === 0 ? null : percent,
      amount: round2(hours * input.hourly_rate * (1 + percent / 100)),
      category: category === 'regular' ? 'regular' : category === 'overtime_tier_1' || category === 'overtime_tier_2' ? 'overtime' : 'irregular_surcharge',
      // Same reasoning as the pre-existing surcharge lines below: Tier A has no document
      // establishing BT applicability, so every grid-derived line is 'table' by default.
      tax_treatment: 'table',
      adds_hours: true,
    });
    hoursWorked += hours;
  }

  if (missingPercentCategories.length > 0) {
    return { status: 'blocked', reason: 'category_percent_missing', categories: missingPercentCategories };
  }

  return { status: 'ready', hour_lines: hourLines, hours_worked: hoursWorked };
}

/** Builds the PayslipPeriod Tier A's own three-way deduction question and vakantiegeld distinction
 * produce - the same model Tiers B and C populate differently (spec §2). No computation happens
 * here; call computePayslipPeriod() on the result exactly as any other tier would. Takes the ALREADY
 * -resolved grid (caller must check resolveTierAHourGrid() first - see computeTierAResult) rather
 * than resolving it itself, so this function (like every other tier's period-builder) stays a pure,
 * always-succeeding construction step; the "can we even build this" decision lives one level up. */
export function buildTierAPeriod(input: TierAInput, grid: { hour_lines: HourLine[]; hours_worked: number }): PayslipPeriod {
  const hourLines: HourLine[] = [...grid.hour_lines];
  let grossBeforeVakantiegeld = hourLines.reduce((sum, l) => sum + l.amount, 0);

  for (const line of input.surcharge_lines) {
    const amount = round2(line.hours * input.hourly_rate * (line.percent / 100));
    grossBeforeVakantiegeld += amount;
    hourLines.push({
      employer_index: 0,
      description: line.description,
      hours: line.hours,
      rate: input.hourly_rate,
      percent: line.percent,
      amount,
      category: 'irregular_surcharge',
      // Tier A has no document establishing that a line is taxed at bijzonder tarief - BT
      // applicability and rate both depend on information (last year's income) Tier A structurally
      // lacks (spec §4 makes the same point about Tier B). Every Tier A line is 'table' by default,
      // matching the real Olympia document (which genuinely has no BT) rather than guessing BT.
      tax_treatment: 'table',
      adds_hours: false,
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
    period_type_confirmed: true, // Tier A: always user-entered, never unknown
    period_end_date: null,
    is_correction: false,
    version: 1,
    employers: [{ name: null, franchise_bearing: 'unknown' }],
    hirer: null,
    contract_hours: null,
    hour_lines: hourLines,
    pre_tax_deductions: buildPreTaxDeductions(input, grossBeforeVakantiegeld, grid.hours_worked),
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
    printed_net: null,
    printed_payout: null,
    printed_gross_total: null,
    printed_loon_voor_heffingen: null,
    printed_taxable_base_normal: null,
    printed_taxable_base_special: null,
    printed_table_tax_label: null,
    printed_bt_tax_label: null,
    printed_algemene_heffingskorting_label: null,
    printed_arbeidskorting_label: null,
    printed_net_label: null,
    printed_payout_label: null,
  };
}

export interface TierAComputedResult {
  status: 'computed';
  /** The full PayslipPeriod Tier A built from the input - every hour_line/pre_tax_deductions/
   * post_tax_social entry still carries its own Field<number> provenance, so a consumer (the API
   * response, then the result panel) can render the full chain per-line without a second lookup
   * (architecture-round audit reply, point 2 - "if the API returns a bare number per line, the UI
   * cannot show where it came from"). */
  period: PayslipPeriod;
  outcome: PayslipComputationOutcome;
  /** Present only when deductions.mode === 'estimate' AND the base computation (pension/PAWW
   * known/estimated, nothing else unknown) succeeded. AZ5: gross_total/taxable_base/table_tax/bt_tax
   * inside `outcome` are the single, correct figures - unaffected by this range. Only these three
   * fields, and the sector-premium line itself, are ever shown as a range (AZ5 - "do not render
   * every figure as a range"). */
  sector_premium_estimate?: TierASectorPremiumEstimate;
  net_range?: { low: number; high: number };
  payout_range?: { low: number; high: number };
}

/** CX2a: the hour grid can refuse to produce hour_lines at all (an unknown overtime threshold or an
 * unstated Saturday/Sunday/holiday percent) - this is a stated gap BEFORE the engine ever runs, not
 * an engine-level 'incomplete' outcome (payslip-model.ts's own IncompletePayslipComputation is about
 * unknown DEDUCTIONS, a different gap). Kept as its own status so the frontend can render "we need
 * one more thing from you" distinctly from "here is your incomplete tax computation". */
export type TierABlockedResult = Extract<TierAGridResult, { status: 'blocked' }>;
export type TierAComputeResult = TierABlockedResult | TierAComputedResult;

/**
 * The Tier A entry point: resolves the hour grid first (CX2a - refuses to guess a threshold or a
 * weekend/holiday percent), builds the period, runs the shared engine, and - only for the "estimate"
 * deduction mode - applies the sector-premium range (AZ1) to net and payout afterward. A higher
 * assumed premium means a lower net, so the range's HIGH percent produces the LOW end of the net
 * range and vice versa; this is a direct EUR subtraction from the already-computed wage_net/payout,
 * not a second pass through pre_tax_deductions/taxable_base/tax (AZ5).
 */
export function computeTierAResult(input: TierAInput, rates: PayslipComputationRates): TierAComputeResult {
  const grid = resolveTierAHourGrid(input);
  if (grid.status === 'blocked') return grid;

  const period = buildTierAPeriod(input, grid);
  const outcome = computePayslipPeriod(period, rates, input.apply_loonheffingskorting);

  if (input.deductions.mode !== 'estimate' || outcome.status !== 'complete') {
    return { status: 'computed', period, outcome };
  }

  const sectorPremiumEstimate = estimateSectorPremiumRange(outcome.result.gross_total);
  return {
    status: 'computed',
    period,
    outcome,
    sector_premium_estimate: sectorPremiumEstimate,
    net_range: {
      low: round2(outcome.result.wage_net - sectorPremiumEstimate.high_amount),
      high: round2(outcome.result.wage_net - sectorPremiumEstimate.low_amount),
    },
    payout_range: {
      low: round2(outcome.result.payout_amount - sectorPremiumEstimate.high_amount),
      high: round2(outcome.result.payout_amount - sectorPremiumEstimate.low_amount),
    },
  };
}

/**
 * Structured, not a prebaked sentence (audit BJ1, language-regression round): the earlier version
 * carried a fully-formatted Dutch `message` string, which is the same defect as the deduction-line
 * descriptions above - it ignored the interface language switch entirely. The frontend now builds
 * the sentence itself, in the interface language, from these numeric fields.
 */
export type TierASanityWarning =
  | { code: 'net_exceeds_gross'; wage_net: number; gross_total: number }
  | { code: 'effective_rate_exceeds_gross_rate'; effective_rate: number; hourly_rate: number };

/**
 * Sanity check before rendering (spec §3, "Sanity check before rendering") - the live build showed
 * 16.54 net per hour against an entered 15.55 gross without comment. This is a Tier-A-specific UI
 * concern (it needs the user's own entered gross hourly rate for comparison, which is not part of
 * the generic PayslipPeriod/engine contract), so it lives here rather than in the shared engine.
 *
 * Checked against `wage_net` (before net_additions/net_deductions), not `payout_amount` - found
 * while wiring this into the actual API route (this round): a real, generous travel_allowance is
 * one of Tier A's own listed inputs (spec §3) and routinely pushes the final payout above the
 * wage-only gross for a worker with few hours - that is not a bug, it is an untaxed reimbursement
 * doing exactly what it is supposed to. wage_net, in contrast, can never legitimately exceed
 * gross_total under this engine's own tax arithmetic (heffingskortingen only ever reduce tax,
 * floored at 0) UNLESS a pre-tax deduction line is itself negative (a genuine compensation/refund
 * line, e.g. OTTO's "PAWW Rekompensata") large enough that even the resulting tax doesn't cancel it
 * out - so this check still has a real, non-hypothetical case to catch, just not the travel-
 * allowance false positive the first version of this function produced.
 */
export function checkTierASanity(outcome: PayslipComputationOutcome, input: TierAInput): TierASanityWarning[] {
  if (outcome.status !== 'complete') return [];
  const warnings: TierASanityWarning[] = [];
  const { result } = outcome;
  if (result.wage_net > result.gross_total) {
    warnings.push({ code: 'net_exceeds_gross', wage_net: result.wage_net, gross_total: result.gross_total });
  }
  if (result.hours_worked > 0) {
    const effectiveWageNetHourlyRate = result.wage_net / result.hours_worked;
    if (effectiveWageNetHourlyRate > input.hourly_rate) {
      warnings.push({ code: 'effective_rate_exceeds_gross_rate', effective_rate: round2(effectiveWageNetHourlyRate), hourly_rate: input.hourly_rate });
    }
  }
  return warnings;
}

export type { PayslipComputationRates };
