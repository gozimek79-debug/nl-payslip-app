import type { ContractExtraction } from './contract.js';
import type {
  HourLineCategory, TaxTreatment, PreTaxDeductionCategory, PostTaxSocialCategory, NetDeductionCategory, ReservationType,
} from './payslip-model.js';
import type { TierCExtraction, TierCPeriodType } from './tier-c.js';

/**
 * P2 (ZADANIE-P2-LOONTO-PRO.md §P2.2): the canonical, backend-owned DOCUMENT FACT model - what the
 * strong reader extracted from one document, field by field, each with its own evidence, BEFORE any
 * profile resolution and independently of any historical replay/audit.
 *
 *   document  ->  page batch(es) read by Gemini  ->  *FactsBatch (one per reader call)
 *             ->  merge*Batches (deterministic, same document)  ->  *DocumentFacts
 *             ->  resolvePayrollProfile (P1/P1.1 resolver, unchanged rules)
 *
 * Statuses are factual, never a confidence score:
 *   exact       - the reader found a printed value and every server-side check passed;
 *   ambiguous   - the reader marked it unclear, its normalised value disagrees with the printed raw
 *                 text, its code is not a known one, or one document states it two different ways;
 *   absent      - not printed (never stored: an absent fact simply has no occurrence);
 *   implausible - a printed value rejected by a domain sense check (kept, with the check's code).
 * Only `exact` carries a value. Nothing here ever defaults, sums, converts or recomputes a payroll
 * figure on the reader's behalf - with ONE documented exception: a percentage printed as two summed
 * components ("35,75 + 4,45%") is accepted as their sum when the reader's value equals it exactly.
 */

export type FactStatus = 'exact' | 'ambiguous' | 'absent' | 'implausible';

export type FactReasonCode =
  /** The reader itself reported the value as unclear on the document. */
  | 'reader_marked_ambiguous'
  /** The reader's normalised number does not appear in (or sum from) the printed raw text it cited. */
  | 'raw_value_mismatch'
  /** A value the reader reported as found but did not supply in a usable form. */
  | 'value_not_normalizable'
  /** A code outside the allowed set (e.g. a period type other than week / 4-weekly / month). */
  | 'unrecognized_code'
  | 'invalid_date'
  | 'out_of_range'
  | 'exceeds_physical_hours_per_week'
  | 'exceeds_plausible_hourly_rate'
  | 'exceeds_legal_hours_per_week'
  | 'exceeds_daily_hours'
  | 'percent_out_of_range'
  /** A percentage declared to be a total multiplier but below 100%. */
  | 'percent_unit_confusion'
  /** Two different exact values for the same fact inside ONE document (set by the merge). */
  | 'same_document_contradiction'
  /** A text value matched a personal-data pattern and was withheld. */
  | 'pii_redacted';

export type FactUnit =
  | 'text' | 'date' | 'period_type' | 'eur_per_hour' | 'eur_per_month' | 'eur_per_year' | 'eur_per_period'
  | 'hours_per_week' | 'hours' | 'weeks' | 'percent';

export type FactValue = number | string;

/** Where a fact was read. `page` is 1-based and always a page of the batch that read it (anything
 * else is dropped to null - never guessed). `line` stays null: a line index cannot be proved from an
 * image, so none is invented. */
export interface FactEvidence {
  page: number | null;
  line: number | null;
  printedLabel: string | null;
  /** The printed text fragment the value was read from, as printed. */
  rawValue: string | null;
}

export interface PayrollFact {
  /** Semantic key, e.g. `payslip.periodType`, `contract.hourlyRate`. */
  key: string;
  unit: FactUnit;
  /** Normalised value - non-null only when `status === 'exact'`. */
  value: FactValue | null;
  status: FactStatus;
  reason: FactReasonCode | null;
  evidence: FactEvidence;
}

/** A numeric sub-field of a line that could not be used, and why. Its value is null on the line. */
export interface LineIssue {
  field: 'hours' | 'rate' | 'percent' | 'amount' | 'base' | 'accrued' | 'paidOut';
  status: 'ambiguous' | 'implausible';
  reason: FactReasonCode;
}

export interface HourLineFact {
  kind: HourLineCategory;
  /** true = genuinely additional hours; false = a surcharge on hours counted elsewhere; null = the
   * document does not establish which. */
  addsHours: boolean | null;
  taxTreatment: TaxTreatment;
  employerIndex: number;
  hours: number | null;
  rate: number | null;
  /** As printed (an overtime line's printed percent is the full paid multiplier - P1.1). */
  percent: number | null;
  amount: number | null;
  /** Only when the document's own wording identifies the overtime tier - with that wording kept. */
  explicitTier: 1 | 2 | null;
  tierWording: string | null;
  issues: LineIssue[];
  evidence: FactEvidence;
}

export interface DeductionLineFact {
  placement: 'pre_tax' | 'post_tax';
  category: PreTaxDeductionCategory | PostTaxSocialCategory;
  percent: number | null;
  base: number | null;
  amount: number | null;
  issues: LineIssue[];
  evidence: FactEvidence;
}

export interface NetLineFact {
  /** `reimbursement` lines are net additions; every other category is a net deduction. */
  category: NetDeductionCategory | 'reimbursement';
  amount: number | null;
  issues: LineIssue[];
  evidence: FactEvidence;
}

export interface AmountLineFact {
  amount: number | null;
  issues: LineIssue[];
  evidence: FactEvidence;
}

export interface ReservationLineFact {
  type: ReservationType;
  accrued: number | null;
  paidOut: number | null;
  issues: LineIssue[];
  evidence: FactEvidence;
}

export const PAYSLIP_SCALAR_KEYS = [
  'periodLabel', 'periodStart', 'periodEnd', 'paymentDate', 'periodType', 'hirerName', 'hoursPerWeek',
  'bijzonderTariefPercent', 'jaarloonBt', 'etExchangeAmount',
  // Calibration-only printed figures (P6) - extracted, never forward inputs.
  'minimumWagePrinted', 'printedTableTax', 'printedBtTax', 'printedAlgemeneHeffingskorting', 'printedArbeidskorting',
  'printedGrossTotal', 'printedLoonVoorHeffingen', 'printedTaxableBaseNormal', 'printedTaxableBaseSpecial',
  'printedNet', 'printedPayout',
] as const;
export type PayslipScalarKey = (typeof PAYSLIP_SCALAR_KEYS)[number];

export const PAYSLIP_SCALAR_UNITS: Record<PayslipScalarKey, FactUnit> = {
  periodLabel: 'text', periodStart: 'date', periodEnd: 'date', paymentDate: 'date', periodType: 'period_type',
  hirerName: 'text', hoursPerWeek: 'hours_per_week', bijzonderTariefPercent: 'percent', jaarloonBt: 'eur_per_year',
  etExchangeAmount: 'eur_per_period', minimumWagePrinted: 'eur_per_hour', printedTableTax: 'eur_per_period',
  printedBtTax: 'eur_per_period', printedAlgemeneHeffingskorting: 'eur_per_period', printedArbeidskorting: 'eur_per_period',
  printedGrossTotal: 'eur_per_period', printedLoonVoorHeffingen: 'eur_per_period', printedTaxableBaseNormal: 'eur_per_period',
  printedTaxableBaseSpecial: 'eur_per_period', printedNet: 'eur_per_period', printedPayout: 'eur_per_period',
};

/** The payslip scalars that are calibration-only (P6): extracted and shown, never a profile field. */
export const CALIBRATION_ONLY_PAYSLIP_KEYS: readonly PayslipScalarKey[] = [
  'minimumWagePrinted', 'printedTableTax', 'printedBtTax', 'printedAlgemeneHeffingskorting', 'printedArbeidskorting',
  'printedGrossTotal', 'printedLoonVoorHeffingen', 'printedTaxableBaseNormal', 'printedTaxableBaseSpecial', 'printedNet', 'printedPayout',
];

export const CONTRACT_SCALAR_KEYS = [
  'employerName', 'hirerName', 'contractType', 'functionTitle', 'caoName', 'caoPhase', 'pensionFund',
  'startDate', 'endDate', 'effectiveDate', 'hourlyRate', 'monthlySalary', 'hoursPerWeek', 'guaranteedHours',
  'guaranteedHoursPeriodWeeks', 'overtimeThresholdHours',
] as const;
export type ContractScalarKey = (typeof CONTRACT_SCALAR_KEYS)[number];

export const CONTRACT_SCALAR_UNITS: Record<ContractScalarKey, FactUnit> = {
  employerName: 'text', hirerName: 'text', contractType: 'text', functionTitle: 'text', caoName: 'text', caoPhase: 'text',
  pensionFund: 'text', startDate: 'date', endDate: 'date', effectiveDate: 'date', hourlyRate: 'eur_per_hour',
  monthlySalary: 'eur_per_month', hoursPerWeek: 'hours_per_week', guaranteedHours: 'hours', guaranteedHoursPeriodWeeks: 'weeks',
  overtimeThresholdHours: 'hours',
};

export type PremiumCategory = 'overtime' | 'irregular_hours' | 'saturday' | 'sunday' | 'public_holiday' | 'other';
/** How a printed premium percentage is meant - only the document's own wording decides. */
export type PremiumSemantics = 'total_multiplier' | 'premium_above_base' | 'unclear';

export interface PremiumFact {
  category: PremiumCategory;
  percent: number | null;
  semantics: PremiumSemantics;
  explicitTier: 1 | 2 | null;
  tierWording: string | null;
  /** The printed condition the premium applies under (e.g. "after 2 hours"), as printed. */
  condition: string | null;
  status: FactStatus;
  reason: FactReasonCode | null;
  evidence: FactEvidence;
}

export interface PayslipFactsBatch {
  kind: 'payslip';
  /** The 1-based pages THIS reader call read. */
  pages: number[];
  totalPages: number;
  scalars: Record<PayslipScalarKey, PayrollFact[]>;
  employerNames: PayrollFact[];
  hourLines: HourLineFact[];
  deductionLines: DeductionLineFact[];
  netLines: NetLineFact[];
  etReimbursementLines: AmountLineFact[];
  payoutAdjustmentLines: AmountLineFact[];
  reservationLines: ReservationLineFact[];
  redactedFields: string[];
}

export interface ContractFactsBatch {
  kind: 'contract';
  pages: number[];
  totalPages: number;
  scalars: Record<ContractScalarKey, PayrollFact[]>;
  premiums: PremiumFact[];
  redactedFields: string[];
}

export interface PageCoverage {
  totalPages: number;
  processedPages: number[];
  /** Every page of the document that no successful batch read - never hidden. */
  notProcessedPages: number[];
}

export type PayslipDocumentFacts = Omit<PayslipFactsBatch, 'pages' | 'totalPages'> & { coverage: PageCoverage };
export type ContractDocumentFacts = Omit<ContractFactsBatch, 'pages' | 'totalPages'> & { coverage: PageCoverage };
export type DocumentFacts = PayslipDocumentFacts | ContractDocumentFacts;

// ---------------------------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------------------------

const EPSILON = 0.005;

export function factValuesEqual(a: FactValue, b: FactValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < EPSILON;
  return String(a).trim() === String(b).trim();
}

/** The distinct exact values of a fact's occurrences, in page order. */
export function distinctExactValues(occurrences: PayrollFact[]): FactValue[] {
  const out: FactValue[] = [];
  for (const f of occurrences) {
    if (f.status !== 'exact' || f.value === null) continue;
    if (!out.some((v) => factValuesEqual(v, f.value as FactValue))) out.push(f.value);
  }
  return out;
}

/** The one value a document states for a fact, or null when it states none or contradicts itself. */
export function singleExactValue(occurrences: PayrollFact[]): FactValue | null {
  const values = distinctExactValues(occurrences);
  return values.length === 1 ? (values[0] as FactValue) : null;
}

export function firstExactFact(occurrences: PayrollFact[]): PayrollFact | null {
  return occurrences.find((f) => f.status === 'exact' && f.value !== null) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Deterministic same-document merge (P2.10)
// ---------------------------------------------------------------------------------------------

function coverageOf(batches: Array<{ pages: number[]; totalPages: number }>): PageCoverage {
  const totalPages = Math.max(0, ...batches.map((b) => b.totalPages));
  const processed = new Set<number>();
  for (const b of batches) for (const p of b.pages) processed.add(p);
  const processedPages = [...processed].sort((x, y) => x - y);
  const notProcessedPages: number[] = [];
  for (let p = 1; p <= totalPages; p += 1) if (!processed.has(p)) notProcessedPages.push(p);
  return { totalPages, processedPages, notProcessedPages };
}

function byFirstPage<T extends { pages: number[] }>(batches: T[]): T[] {
  return [...batches].sort((a, b) => (Math.min(...a.pages) || 0) - (Math.min(...b.pages) || 0));
}

/**
 * Marks a same-document contradiction: when one document states one fact with two different exact
 * values (e.g. on different pages), every exact occurrence stays - with its own page - but is marked
 * `ambiguous` / `same_document_contradiction` so no consumer can take one of them as "the" value.
 * Identical occurrences stay `exact`: one document saying the same thing twice is still ONE source
 * (the profile counts sources by document, so it can never become `corroborated` from this).
 */
function markContradictions(occurrences: PayrollFact[]): PayrollFact[] {
  if (distinctExactValues(occurrences).length <= 1) return occurrences;
  return occurrences.map((f) => (f.status === 'exact' ? { ...f, status: 'ambiguous' as const, reason: 'same_document_contradiction' as const } : f));
}

function mergeScalars<K extends string>(keys: readonly K[], batches: Array<{ scalars: Record<K, PayrollFact[]> }>): Record<K, PayrollFact[]> {
  const out = {} as Record<K, PayrollFact[]>;
  for (const key of keys) out[key] = markContradictions(batches.flatMap((b) => b.scalars[key] ?? []));
  return out;
}

/** Concatenates the page batches of ONE payslip in page order. No LLM, no re-decision: every line
 * and every occurrence keeps its own page. */
export function mergePayslipBatches(batches: PayslipFactsBatch[]): PayslipDocumentFacts {
  const ordered = byFirstPage(batches);
  return {
    kind: 'payslip',
    coverage: coverageOf(ordered),
    scalars: mergeScalars(PAYSLIP_SCALAR_KEYS, ordered),
    employerNames: ordered.flatMap((b) => b.employerNames),
    hourLines: ordered.flatMap((b) => b.hourLines),
    deductionLines: ordered.flatMap((b) => b.deductionLines),
    netLines: ordered.flatMap((b) => b.netLines),
    etReimbursementLines: ordered.flatMap((b) => b.etReimbursementLines),
    payoutAdjustmentLines: ordered.flatMap((b) => b.payoutAdjustmentLines),
    reservationLines: ordered.flatMap((b) => b.reservationLines),
    redactedFields: ordered.flatMap((b) => b.redactedFields),
  };
}

export function mergeContractBatches(batches: ContractFactsBatch[]): ContractDocumentFacts {
  const ordered = byFirstPage(batches);
  return {
    kind: 'contract',
    coverage: coverageOf(ordered),
    scalars: mergeScalars(CONTRACT_SCALAR_KEYS, ordered),
    premiums: ordered.flatMap((b) => b.premiums),
    redactedFields: ordered.flatMap((b) => b.redactedFields),
  };
}

// ---------------------------------------------------------------------------------------------
// Bridges to existing consumers
// ---------------------------------------------------------------------------------------------

function asNumber(v: FactValue | null): number | null {
  return typeof v === 'number' ? v : null;
}
function asString(v: FactValue | null): string | null {
  return typeof v === 'string' ? v : null;
}

/** The single value per field the (unchanged) contract timeline needs. A field the document does
 * not state, states ambiguously, or contradicts itself on is null here - the profile resolver puts
 * that evidence back as excluded/conflicting candidates, so nothing is lost. */
export function contractExtractionFromFacts(facts: ContractDocumentFacts): ContractExtraction {
  const s = facts.scalars;
  return {
    contractType: asString(singleExactValue(s.contractType)),
    employerName: asString(singleExactValue(s.employerName)),
    functionTitle: asString(singleExactValue(s.functionTitle)),
    startDate: asString(singleExactValue(s.startDate)),
    endDate: asString(singleExactValue(s.endDate)),
    hoursPerWeek: asNumber(singleExactValue(s.hoursPerWeek)),
    hourlyRate: asNumber(singleExactValue(s.hourlyRate)),
    monthlySalary: asNumber(singleExactValue(s.monthlySalary)),
    caoName: asString(singleExactValue(s.caoName)),
    pensionFund: asString(singleExactValue(s.pensionFund)),
    probationPeriodWeeks: null,
    noticePeriodWeeks: null,
    thirtyPercentRuling: false,
    overtimeTierThresholdHours: asNumber(singleExactValue(s.overtimeThresholdHours)),
    guaranteedHours: asNumber(singleExactValue(s.guaranteedHours)),
    guaranteedHoursPeriodWeeks: asNumber(singleExactValue(s.guaranteedHoursPeriodWeeks)),
    redactedFields: facts.redactedFields,
  };
}

/**
 * P2.4: the ONE bridge from document facts to the historical replay/audit (internal diagnostic).
 * The replay keeps its own hard requirement - a confirmed period type - INSIDE the replay route; the
 * facts themselves are returned and resolved whether or not this replay can run. A sub-field the
 * reader could not use becomes exactly what the old reader produced for it (an unknown deduction, an
 * `unreadable_amount_fields` entry for a zero-filled amount), so the replay's own rules are unchanged.
 */
export function payslipFactsToTierCExtraction(facts: PayslipDocumentFacts): TierCExtraction {
  const s = facts.scalars;
  const unreadable: string[] = [];
  const amountOrZero = (value: number | null, path: string): number => {
    if (value === null) {
      unreadable.push(path);
      return 0;
    }
    return value;
  };
  const scalarNumber = (key: PayslipScalarKey): number | null => asNumber(singleExactValue(s[key]));
  const scalarLabel = (key: PayslipScalarKey): string | null => {
    const f = firstExactFact(s[key]);
    return f && singleExactValue(s[key]) !== null ? f.evidence.printedLabel : null;
  };
  const periodType = asString(singleExactValue(s.periodType));
  const preTax = facts.deductionLines.filter((d) => d.placement === 'pre_tax');
  const postTax = facts.deductionLines.filter((d) => d.placement === 'post_tax');
  return {
    period_label: asString(singleExactValue(s.periodLabel)),
    period_end_date: asString(singleExactValue(s.periodEnd)),
    payment_date: asString(singleExactValue(s.paymentDate)),
    period_type: periodType === 'week' || periodType === '4-weekly' || periodType === 'month' ? (periodType as TierCPeriodType) : null,
    is_correction: false,
    version: 1,
    employer_names: distinctExactValues(facts.employerNames).filter((v): v is string => typeof v === 'string'),
    hirer_name: asString(singleExactValue(s.hirerName)),
    hours_per_week: scalarNumber('hoursPerWeek'),
    minimum_wage_printed: scalarNumber('minimumWagePrinted'),
    hour_lines: facts.hourLines.map((l, i) => ({
      employer_index: l.employerIndex,
      description: l.evidence.printedLabel ?? '',
      hours: l.hours,
      rate: l.rate,
      percent: l.percent,
      amount: amountOrZero(l.amount, `hour_lines[${i}].amount`),
      category: l.kind,
      tax_treatment: l.taxTreatment,
      adds_hours: l.addsHours === true,
    })),
    pre_tax_deduction_lines: preTax.map((d) => ({ description: d.evidence.printedLabel ?? '', amount: d.amount, category: d.category, placement: 'pre_tax' as const, base: d.base, percent: d.percent })),
    post_tax_deduction_lines: postTax.map((d) => ({ description: d.evidence.printedLabel ?? '', amount: d.amount, category: d.category, placement: 'post_tax' as const, base: d.base, percent: d.percent })),
    bijzonder_tarief_printed_percent: scalarNumber('bijzonderTariefPercent'),
    bijzonder_tarief_jaarloon: scalarNumber('jaarloonBt'),
    et_exchange_amount: scalarNumber('etExchangeAmount'),
    et_reimbursement_lines: facts.etReimbursementLines.map((l, i) => ({ description: l.evidence.printedLabel ?? '', amount: amountOrZero(l.amount, `et_reimbursement_lines[${i}].amount`), category: 'reimbursement' as const })),
    net_lines: facts.netLines.map((l, i) => ({ description: l.evidence.printedLabel ?? '', amount: amountOrZero(l.amount, `net_lines[${i}].amount`), category: l.category })),
    payout_adjustment_lines: facts.payoutAdjustmentLines.map((l, i) => ({ description: l.evidence.printedLabel ?? '', amount: amountOrZero(l.amount, `payout_adjustment_lines[${i}].amount`) })),
    reservation_lines: facts.reservationLines.map((r, i) => ({
      type: r.type,
      opgebouwd: amountOrZero(r.accrued, `reservation_lines[${i}].accrued`),
      paid_out: amountOrZero(r.paidOut, `reservation_lines[${i}].paid_out`),
    })),
    printed_table_tax: scalarNumber('printedTableTax'),
    printed_bt_tax: scalarNumber('printedBtTax'),
    printed_algemene_heffingskorting: scalarNumber('printedAlgemeneHeffingskorting'),
    printed_arbeidskorting: scalarNumber('printedArbeidskorting'),
    printed_gross_total: scalarNumber('printedGrossTotal'),
    printed_loon_voor_heffingen: scalarNumber('printedLoonVoorHeffingen'),
    printed_taxable_base_normal: scalarNumber('printedTaxableBaseNormal'),
    printed_taxable_base_special: scalarNumber('printedTaxableBaseSpecial'),
    reported_total_net: scalarNumber('printedNet'),
    reported_net_paid: scalarNumber('printedPayout'),
    printed_table_tax_label: scalarLabel('printedTableTax'),
    printed_bt_tax_label: scalarLabel('printedBtTax'),
    printed_algemene_heffingskorting_label: scalarLabel('printedAlgemeneHeffingskorting'),
    printed_arbeidskorting_label: scalarLabel('printedArbeidskorting'),
    printed_net_label: scalarLabel('printedNet'),
    printed_payout_label: scalarLabel('printedPayout'),
    truncated: facts.coverage.notProcessedPages.length > 0,
    redacted_fields: facts.redactedFields,
    unreadable_amount_fields: unreadable,
  };
}
