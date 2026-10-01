import type { ContractExtraction } from './contract.js';
import { resolveEffectiveContract, type ContractDocumentEntry, type EffectiveContract } from './contract-timeline.js';
import { stripDiacritics } from './extraction-consistency.js';
import type { PayslipPeriod, PreTaxDeductionCategory, PostTaxSocialCategory } from './payslip-model.js';

/**
 * P1 (ZADANIE-P1-LOONTO-PRO.md) - the Payroll Profile: one canonical, backend-owned description of
 * the user's employment/payroll parameters, built from contract + annexes + payslips, where EVERY
 * parameter is resolved independently of every other one.
 *
 * Owner decisions this module implements (binding, P1 §"Binding owner decisions"):
 *   - there is no global winner between contract and payslip evidence. The same value from
 *     independent documents is `corroborated`; materially different values are `conflict` with every
 *     candidate kept; nothing here silently picks the contract or the payslip;
 *   - historical payslip auditing does not gate parameters. This resolver takes NO discrepancy list,
 *     NO needsConfirmation list and NO "fully reproduced" flag - a payslip contributes whatever facts
 *     it carries, field by field;
 *   - no probabilistic confidence: evidence states are factual (what the documents say), not scores.
 *
 * Pure and synchronous: no I/O, no AI call, no rules lookup. Inputs are only structures that already
 * exist (ContractExtraction, the contract timeline, PayslipPeriod).
 */

export type EvidenceState = 'document_exact' | 'corroborated' | 'user_confirmed' | 'user_corrected' | 'conflict' | 'unknown';

/** States whose `value` may feed a forward calculation as a document- or user-backed parameter.
 * `user_confirmed`/`user_corrected` are defined now so the schema is final, but nothing in P1 produces
 * them - field-level user confirmation is P3. */
export const USABLE_EVIDENCE_STATES: readonly EvidenceState[] = ['document_exact', 'corroborated', 'user_confirmed', 'user_corrected'];

export type SourceRole = 'contract_base' | 'contract_annex' | 'payslip' | 'rules' | 'user';
export type SourceType = 'document' | 'rules' | 'user';
export type PayslipPeriodType = PayslipPeriod['period_type'];

export interface PayPeriodRef {
  label: string | null;
  endDate: string | null;
  /** null when the payslip's own period type was not confirmed by the read. */
  periodType: PayslipPeriodType | null;
}

export interface EvidenceSource {
  sourceType: SourceType;
  role: SourceRole;
  /** The document's index in the request's own document list - never re-numbered. */
  documentIndex: number | null;
  documentLabel: string | null;
  /** Annex effective date (as entered today - extracting it is P2). null for a base contract/payslip. */
  effectiveDate: string | null;
  /** Payslip pay period, null for contracts. */
  payPeriod: PayPeriodRef | null;
  /** The as-printed line description the value was read from, when one exists. */
  printedLabel: string | null;
  /** Page/line evidence - always null in P1, populated by P2's extraction. */
  page: number | null;
  line: number | null;
}

/** Units are codes, never prose (CONVENTIONS.md) - the interface decides how to word them. */
export type ProfileUnit =
  | 'text'
  | 'date'
  | 'eur_per_hour'
  | 'eur_per_month'
  | 'eur_per_year'
  | 'eur_per_period'
  | 'hours_per_week'
  | 'hours'
  | 'weeks'
  /** Engine premium above the base rate: a printed 150% overtime line is +50. */
  | 'premium_percent'
  | 'premium_percent_list'
  /** A surcharge on hours already counted elsewhere, as printed (amount = hours x rate x percent/100). */
  | 'surcharge_percent'
  /** A deduction percentage as printed, applied to the base the payslip itself prints. */
  | 'percent_of_printed_base'
  | 'percent'
  | 'period_type'
  | 'boolean';

export type ProfileValue = number | string | number[] | boolean;

export interface CandidateDetail {
  amount: number | null;
  base: number | null;
  hours: number | null;
  printedPercent: number | null;
}

export interface ProfileCandidate {
  value: ProfileValue;
  source: EvidenceSource;
  detail: CandidateDetail | null;
}

export type ExcludedReasonCode =
  /** An annex sets this field but has no usable effective date, so it cannot be placed in the timeline. */
  | 'annex_effective_date_missing'
  /** The read flagged this specific amount as unreadable (its stored 0 is not a reading). */
  | 'amount_unreadable'
  /** An overtime line printed below 100% - full multiplier vs premium-only print cannot be told apart. */
  | 'percent_semantics_ambiguous'
  /** The line exists but prints no percentage, so no forward rate can be taken from it. */
  | 'percent_not_printed'
  | 'period_type_unconfirmed'
  /** Evidence that exists but is not itself a forward rate (e.g. an accrued vakantiegeld amount). */
  | 'not_a_forward_rate'
  /** A payslip naming more than one employer - which one a value belongs to is not established. */
  | 'multiple_employers_on_payslip';

export interface ExcludedEvidence {
  value: ProfileValue | null;
  source: EvidenceSource;
  reason: ExcludedReasonCode;
  detail: CandidateDetail | null;
}

export type UnknownReasonCode =
  | 'no_documents'
  | 'no_contract_document'
  | 'no_payslip_document'
  /** A contract document exists but its extraction carries no value for this field. */
  | 'not_in_contract_extraction'
  | 'not_on_payslips'
  | 'not_on_documents'
  /** Evidence exists but every piece of it was excluded (see `excluded`). */
  | 'only_excluded_evidence'
  /** P5: no reference document labels hours by weekday; never derived from generic tier percentages. */
  | 'no_weekday_evidence'
  /** No document field establishes this switch; nothing is derived from printed credits in P1. */
  | 'no_evidence_source'
  /** Not a separate extraction field today (e.g. CAO phase may only appear inside the contract type text). */
  | 'not_a_separate_extraction_field';

export type ProfileReason =
  | { code: 'sources_disagree' }
  /** The contract timeline itself reported two documents disagreeing on the same date. */
  | { code: 'timeline_disagreement'; asOfDate: string }
  | { code: UnknownReasonCode };

export interface ProfileField {
  /** Stable key, unique within the profile (recurring items carry a group-qualified key). */
  key: string;
  /** Stable semantic code - what the value means, independent of wording. */
  meaning: string;
  unit: ProfileUnit;
  /** Non-null only for document_exact/corroborated (and, from P3, user states). Never a default. */
  value: ProfileValue | null;
  state: EvidenceState;
  /** The sources supporting `value` (every one of them, for corroborated). Empty for unknown. For
   * conflict: every competing candidate's source. */
  sources: EvidenceSource[];
  /** Every usable candidate considered, with its own value - the competing set when state is conflict. */
  candidates: ProfileCandidate[];
  /** Evidence seen but not usable, each with its own reason - kept visible, never silently dropped. */
  excluded: ExcludedEvidence[];
  /** Why the field is unknown or in conflict; null for a resolved field. */
  reason: ProfileReason | null;
}

export type ProfileDocumentRole = 'contract_base' | 'contract_annex' | 'payslip';

export interface ProfilePayslipInput {
  period: PayslipPeriod;
  /** Field-level only: PayslipPeriod paths whose stored amount is a non-reading (`amount_unreadable`,
   * `et_exchange_amount_unknown`). Never a count, never a gate - it excludes exactly these amounts. */
  unreadableFieldPaths: string[];
}

export interface ProfileDocumentInput {
  index: number;
  label: string;
  role: ProfileDocumentRole;
  /** Only meaningful for an annex. */
  effectiveDate: string | null;
  contractExtraction?: ContractExtraction;
  payslip?: ProfilePayslipInput;
}

export interface ResolvePayrollProfileInput {
  /** The date the contract timeline is resolved for (user-chosen today, as before P1). */
  asOfDate: string;
  documents: ProfileDocumentInput[];
}

export interface ProfileDocumentRef {
  index: number;
  label: string;
  role: ProfileDocumentRole;
  effectiveDate: string | null;
  payPeriod: PayPeriodRef | null;
}

export interface ContractContext {
  asOfDate: string;
  baseContracts: ProfileDocumentRef[];
  annexesInForce: ProfileDocumentRef[];
  annexesNotYetInForce: ProfileDocumentRef[];
  annexesUndated: ProfileDocumentRef[];
}

export const EMPLOYMENT_FIELD_KEYS = [
  'employerName', 'payslipEmployerName', 'hirerName', 'hourlyRate', 'hoursPerWeek', 'guaranteedHours',
  'guaranteedHoursPeriodWeeks', 'overtimeThresholdHours', 'caoName', 'phase', 'contractType', 'functionTitle',
  'contractStartDate', 'contractEndDate', 'monthlySalary', 'pensionFundName',
] as const;
export type EmploymentFieldKey = (typeof EMPLOYMENT_FIELD_KEYS)[number];

export const PAYROLL_FIELD_KEYS = [
  'periodType', 'overtimeTier1Premium', 'overtimeTier2Premium', 'overtimeAdditionalTierPremiums',
  'saturdayPremium', 'sundayPremium', 'publicHolidayPremium', 'loonheffingskorting',
  'pensionEmployeePercent', 'pawwEmployeePercent', 'sectorPremiumPercent', 'wgaGatEmployeePercent',
  'wgaEmployeePercent', 'gediffWgaEmployeePercent', 'whkEmployeePercent', 'vakantiegeldAccrualPercent',
  'bijzonderTariefPrintedPercent', 'jaarloonBt', 'etExchangeAmount',
] as const;
export type PayrollFieldKey = (typeof PAYROLL_FIELD_KEYS)[number];

export interface RecurringItems {
  /** Irregular-hours / ADV / non-hour-adding surcharge lines, by percent. */
  surcharges: ProfileField[];
  /** Pre-tax deductions outside the four named families, by percent. */
  otherPreTaxDeductions: ProfileField[];
  /** Post-tax deductions outside the three named families, by percent. */
  otherPostTaxDeductions: ProfileField[];
  /** Net additions (incl. ET reimbursements), by amount per period. */
  netAdditions: ProfileField[];
  /** Net deductions, by amount per period. */
  netDeductions: ProfileField[];
}

/** Printed historical figures - kept for calibration (P6) only. Never a profile field, never a
 * forward input, and never read by any field resolver above. */
export interface CalibrationPayslipEvidence {
  source: EvidenceSource;
  printed: {
    table_tax: number | null;
    bt_tax: number | null;
    algemene_heffingskorting: number | null;
    arbeidskorting: number | null;
    gross_total: number | null;
    loon_voor_heffingen: number | null;
    net: number | null;
    payout: number | null;
    minimum_wage: number | null;
  };
}

export interface PayrollProfile {
  version: 1;
  asOfDate: string;
  documents: ProfileDocumentRef[];
  contractContext: ContractContext;
  employment: Record<EmploymentFieldKey, ProfileField>;
  payroll: Record<PayrollFieldKey, ProfileField>;
  recurringItems: RecurringItems;
  calibrationOnly: { payslips: CalibrationPayslipEvidence[] };
}

// ---------------------------------------------------------------------------------------------
// Generic resolution
// ---------------------------------------------------------------------------------------------

/** Two numbers are the same value when they agree to the printed cent - the precision documents
 * print at. Anything wider would be a tolerance the owner has not approved; anything narrower
 * would turn float noise into conflicts. */
const NUMERIC_EQUALITY_EPSILON = 0.005;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function valuesEqual(a: ProfileValue, b: ProfileValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < NUMERIC_EQUALITY_EPSILON;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] as number)) < NUMERIC_EQUALITY_EPSILON);
  return false;
}

interface FieldSpec {
  key: string;
  meaning: string;
  unit: ProfileUnit;
}

/**
 * The one resolution rule every field goes through:
 *   no usable candidate                  -> unknown (`emptyReason`, or `only_excluded_evidence`)
 *   one distinct value, one document     -> document_exact
 *   one distinct value, 2+ documents     -> corroborated (every supporting source kept)
 *   2+ distinct values                   -> conflict (every candidate kept, value null - no winner)
 */
function resolveField(spec: FieldSpec, candidates: ProfileCandidate[], excluded: ExcludedEvidence[], emptyReason: UnknownReasonCode, timelineConflictAsOf: string | null = null): ProfileField {
  const base = { key: spec.key, meaning: spec.meaning, unit: spec.unit, candidates, excluded };
  if (candidates.length === 0) {
    return { ...base, value: null, state: 'unknown', sources: [], reason: { code: excluded.length > 0 ? 'only_excluded_evidence' : emptyReason } };
  }
  const groups: Array<{ value: ProfileValue; members: ProfileCandidate[] }> = [];
  for (const candidate of candidates) {
    const group = groups.find((g) => valuesEqual(g.value, candidate.value));
    if (group) group.members.push(candidate);
    else groups.push({ value: candidate.value, members: [candidate] });
  }
  if (groups.length > 1 || timelineConflictAsOf !== null) {
    return {
      ...base,
      value: null,
      state: 'conflict',
      sources: candidates.map((c) => c.source),
      reason: timelineConflictAsOf !== null ? { code: 'timeline_disagreement', asOfDate: timelineConflictAsOf } : { code: 'sources_disagree' },
    };
  }
  const only = groups[0] as { value: ProfileValue; members: ProfileCandidate[] };
  const distinctDocuments = new Set(only.members.map((m) => m.source.documentIndex)).size;
  return {
    ...base,
    value: only.value,
    state: distinctDocuments >= 2 ? 'corroborated' : 'document_exact',
    sources: only.members.map((m) => m.source),
    reason: null,
  };
}

function unknownField(spec: FieldSpec, reason: UnknownReasonCode, excluded: ExcludedEvidence[] = []): ProfileField {
  return resolveField(spec, [], excluded, reason);
}

function detail(partial: Partial<CandidateDetail>): CandidateDetail {
  return { amount: partial.amount ?? null, base: partial.base ?? null, hours: partial.hours ?? null, printedPercent: partial.printedPercent ?? null };
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

function payPeriodOf(period: PayslipPeriod): PayPeriodRef {
  return { label: period.period_label, endDate: period.period_end_date, periodType: period.period_type_confirmed ? period.period_type : null };
}

function contractSource(doc: ProfileDocumentInput): EvidenceSource {
  return {
    sourceType: 'document',
    role: doc.role === 'contract_annex' ? 'contract_annex' : 'contract_base',
    documentIndex: doc.index,
    documentLabel: doc.label,
    effectiveDate: doc.role === 'contract_annex' ? doc.effectiveDate : null,
    payPeriod: null,
    printedLabel: null,
    page: null,
    line: null,
  };
}

function payslipSource(doc: ProfileDocumentInput, period: PayslipPeriod, printedLabel: string | null): EvidenceSource {
  return {
    sourceType: 'document',
    role: 'payslip',
    documentIndex: doc.index,
    documentLabel: doc.label,
    effectiveDate: null,
    payPeriod: payPeriodOf(period),
    printedLabel,
    page: null,
    line: null,
  };
}

function docRef(doc: ProfileDocumentInput): ProfileDocumentRef {
  return {
    index: doc.index,
    label: doc.label,
    role: doc.role,
    effectiveDate: doc.role === 'contract_annex' ? doc.effectiveDate : null,
    payPeriod: doc.payslip ? payPeriodOf(doc.payslip.period) : null,
  };
}

function hasUsableDate(value: string | null): value is string {
  return value !== null && value !== '';
}

// ---------------------------------------------------------------------------------------------
// Contract / annex side - reuses resolveEffectiveContract unchanged
// ---------------------------------------------------------------------------------------------

type TimelineFieldKey = keyof EffectiveContract;

interface ContractSide {
  docs: ProfileDocumentInput[];
  effective: EffectiveContract | null;
}

/** Timeline-internal label - unique per contract document, so a `disagreement`/`undated_document`
 * reason (which names documents by label) maps back to exactly one document even when two uploaded
 * files share a filename. The real label is restored on every profile source. */
function timelineKey(position: number): string {
  return `#${position}`;
}

function buildContractSide(documents: ProfileDocumentInput[], asOfDate: string): ContractSide {
  const docs = documents.filter((d) => (d.role === 'contract_base' || d.role === 'contract_annex') && d.contractExtraction);
  if (docs.length === 0) return { docs, effective: null };
  const entries: ContractDocumentEntry[] = docs.map((d, position) => ({
    role: d.role === 'contract_annex' ? 'annex' : 'base',
    effectiveDate: d.effectiveDate,
    label: timelineKey(position),
    extraction: d.contractExtraction as ContractExtraction,
  }));
  return { docs, effective: resolveEffectiveContract(entries, asOfDate) };
}

function docByTimelineLabel(side: ContractSide, label: string): ProfileDocumentInput | null {
  const position = Number(label.slice(1));
  return Number.isInteger(position) ? side.docs[position] ?? null : null;
}

function normalizeContractValue(value: unknown): ProfileValue | null {
  if (isFiniteNumber(value)) return round2(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

interface ContractEvidence {
  candidates: ProfileCandidate[];
  excluded: ExcludedEvidence[];
  timelineConflictAsOf: string | null;
}

/** Turns one timeline field into profile evidence. The timeline's own answer is never re-decided
 * here: its winner is the single contract-side candidate; its `disagreement` becomes the competing
 * candidates (values read back from the exact documents it named); its `undated_document` becomes
 * excluded evidence. */
function contractEvidence(side: ContractSide, field: TimelineFieldKey, asOfDate: string): ContractEvidence {
  const result: ContractEvidence = { candidates: [], excluded: [], timelineConflictAsOf: null };
  const effective = side.effective?.[field];
  if (!effective) return result;
  if (effective.value !== null && effective.source) {
    const doc = side.docs[effective.source.documentIndex];
    const value = normalizeContractValue(effective.value);
    if (doc && value !== null) result.candidates.push({ value, source: contractSource(doc), detail: null });
    return result;
  }
  const reason = effective.reason;
  if (reason?.code === 'disagreement') {
    for (const label of reason.documentLabels) {
      const doc = docByTimelineLabel(side, label);
      const value = doc ? normalizeContractValue(doc.contractExtraction?.[field]) : null;
      if (doc && value !== null) result.candidates.push({ value, source: contractSource(doc), detail: null });
    }
    result.timelineConflictAsOf = reason.asOfDate ?? asOfDate;
  } else if (reason?.code === 'undated_document') {
    const doc = docByTimelineLabel(side, reason.documentLabel);
    const value = doc ? normalizeContractValue(doc.contractExtraction?.[field]) : null;
    if (doc && value !== null) result.excluded.push({ value, source: contractSource(doc), reason: 'annex_effective_date_missing', detail: null });
  }
  return result;
}

function contractOnlyField(spec: FieldSpec, side: ContractSide, field: TimelineFieldKey, asOfDate: string): ProfileField {
  const ev = contractEvidence(side, field, asOfDate);
  return resolveField(spec, ev.candidates, ev.excluded, side.docs.length === 0 ? 'no_contract_document' : 'not_in_contract_extraction', ev.timelineConflictAsOf);
}

function buildContractContext(side: ContractSide, asOfDate: string): ContractContext {
  const base = side.docs.filter((d) => d.role === 'contract_base');
  const annexes = side.docs.filter((d) => d.role === 'contract_annex');
  return {
    asOfDate,
    baseContracts: base.map(docRef),
    annexesInForce: annexes.filter((d) => hasUsableDate(d.effectiveDate) && d.effectiveDate <= asOfDate).map(docRef),
    annexesNotYetInForce: annexes.filter((d) => hasUsableDate(d.effectiveDate) && d.effectiveDate > asOfDate).map(docRef),
    annexesUndated: annexes.filter((d) => !hasUsableDate(d.effectiveDate)).map(docRef),
  };
}

// ---------------------------------------------------------------------------------------------
// Payslip side - each payslip contributes independently, never as a whole-document verdict
// ---------------------------------------------------------------------------------------------

interface PayslipDoc {
  doc: ProfileDocumentInput;
  period: PayslipPeriod;
  unreadable: Set<string>;
}

function payslipDocs(documents: ProfileDocumentInput[]): PayslipDoc[] {
  return documents
    .filter((d) => d.role === 'payslip' && d.payslip)
    .map((d) => ({ doc: d, period: (d.payslip as ProfilePayslipInput).period, unreadable: new Set((d.payslip as ProfilePayslipInput).unreadableFieldPaths) }));
}

function payslipEmptyReason(slips: PayslipDoc[]): UnknownReasonCode {
  return slips.length === 0 ? 'no_payslip_document' : 'not_on_payslips';
}

function regularRateEvidence(slips: PayslipDoc[]): ProfileCandidate[] {
  const out: ProfileCandidate[] = [];
  for (const { doc, period } of slips) {
    for (const line of period.hour_lines) {
      if (line.category !== 'regular' || !isFiniteNumber(line.rate) || line.rate <= 0) continue;
      out.push({ value: round2(line.rate), source: payslipSource(doc, period, line.description || null), detail: detail({ hours: line.hours, amount: line.amount }) });
    }
  }
  return out;
}

interface OvertimeEvidence {
  tier1: ProfileCandidate[];
  tier2: ProfileCandidate[];
  additional: ProfileCandidate[];
  excluded: ExcludedEvidence[];
}

/**
 * Backend home of `derivePayslipOvertimePercents`' semantics (pro-parameter-sourcing.ts), applied
 * PER PAYSLIP with no whole-payslip verdict:
 *   - only a genuine overtime line counts: `category: 'overtime'` AND `adds_hours: true` AND a percent;
 *   - its printed percent is the FULL paid multiplier, so the engine premium is `percent - 100`
 *     (printed 150% -> +50) - the conversion confirmed against PKF's fixture in 3.0a.5;
 *   - within one payslip the lowest distinct percent is tier 1, the highest tier 2, any in between
 *     are additional tiers (the grid has two slots - an extra tier is named, never dropped);
 *   - a surcharge line (`adds_hours: false`) is NOT overtime here - it is surcharge evidence;
 *   - P1 addition, reported: an overtime line printed BELOW 100% cannot be read either way (a
 *     premium-only print vs a sub-base multiplier), so that payslip's overtime lines are excluded as
 *     `percent_semantics_ambiguous` rather than turned into a negative premium.
 */
function overtimeEvidence(slips: PayslipDoc[]): OvertimeEvidence {
  const ev: OvertimeEvidence = { tier1: [], tier2: [], additional: [], excluded: [] };
  for (const { doc, period } of slips) {
    const lines = period.hour_lines.filter((l) => l.category === 'overtime' && l.adds_hours === true && isFiniteNumber(l.percent));
    if (lines.length === 0) continue;
    if (lines.some((l) => (l.percent as number) < 100)) {
      for (const l of lines) {
        ev.excluded.push({ value: l.percent as number, source: payslipSource(doc, period, l.description || null), reason: 'percent_semantics_ambiguous', detail: detail({ hours: l.hours, amount: l.amount, printedPercent: l.percent }) });
      }
      continue;
    }
    const distinct = Array.from(new Set(lines.map((l) => round2(l.percent as number)))).sort((a, b) => a - b);
    const lineFor = (percent: number) => lines.find((l) => Math.abs((l.percent as number) - percent) < NUMERIC_EQUALITY_EPSILON);
    const candidateFor = (percent: number): ProfileCandidate => {
      const line = lineFor(percent);
      return { value: round2(percent - 100), source: payslipSource(doc, period, line?.description || null), detail: detail({ hours: line?.hours ?? null, amount: line?.amount ?? null, printedPercent: percent }) };
    };
    const lowest = distinct[0] as number;
    ev.tier1.push(candidateFor(lowest));
    if (distinct.length > 1) ev.tier2.push(candidateFor(distinct[distinct.length - 1] as number));
    if (distinct.length > 2) {
      const middle = distinct.slice(1, -1);
      ev.additional.push({ value: middle.map((p) => round2(p - 100)), source: payslipSource(doc, period, null), detail: null });
    }
  }
  return ev;
}

function normalizeDescription(description: string): string {
  return stripDiacritics(description).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A line whose forward parameter is its printed percentage (a deduction rate, a surcharge rate). */
interface PercentLine {
  doc: ProfileDocumentInput;
  period: PayslipPeriod;
  description: string;
  percent: number | null;
  amount: number | null;
  base: number | null;
  hours: number | null;
}

function percentLineEvidence(lines: PercentLine[]): { candidates: ProfileCandidate[]; excluded: ExcludedEvidence[] } {
  const candidates: ProfileCandidate[] = [];
  const excluded: ExcludedEvidence[] = [];
  for (const l of lines) {
    const source = payslipSource(l.doc, l.period, l.description || null);
    const d = detail({ amount: l.amount, base: l.base, hours: l.hours, printedPercent: l.percent });
    if (isFiniteNumber(l.percent)) candidates.push({ value: round2(l.percent), source, detail: d });
    else excluded.push({ value: null, source, reason: 'percent_not_printed', detail: d });
  }
  return { candidates, excluded };
}

function preTaxLines(slips: PayslipDoc[], category: PreTaxDeductionCategory): PercentLine[] {
  return slips.flatMap(({ doc, period }) =>
    period.pre_tax_deductions
      .filter((d) => d.category === category)
      .map((d) => ({ doc, period, description: d.description, percent: isFiniteNumber(d.percent) ? d.percent : null, amount: d.amount.value, base: isFiniteNumber(d.base) ? d.base : null, hours: null })),
  );
}

function postTaxLines(slips: PayslipDoc[], category: PostTaxSocialCategory): PercentLine[] {
  return slips.flatMap(({ doc, period }) =>
    period.post_tax_social
      .filter((d) => d.category === category)
      .map((d) => ({ doc, period, description: d.description, percent: isFiniteNumber(d.percent) ? d.percent : null, amount: d.amount.value, base: null, hours: null })),
  );
}

/** Groups lines by (group, category, normalised printed description) and resolves each group as its
 * own field - a recurring item is "the same line on several payslips", never a merge across lines. */
function groupedPercentFields(group: string, meaning: string, unit: ProfileUnit, lines: Array<PercentLine & { category: string }>): ProfileField[] {
  const byKey = new Map<string, Array<PercentLine & { category: string }>>();
  for (const line of lines) {
    const key = `${group}:${line.category}:${normalizeDescription(line.description)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), line]);
  }
  return [...byKey.entries()].map(([key, members]) => {
    const ev = percentLineEvidence(members);
    return resolveField({ key, meaning, unit }, ev.candidates, ev.excluded, 'not_on_payslips');
  });
}

interface AmountLine {
  doc: ProfileDocumentInput;
  period: PayslipPeriod;
  category: string;
  description: string;
  amount: number;
  path: string;
  unreadable: boolean;
}

function groupedAmountFields(group: string, meaning: string, lines: AmountLine[]): ProfileField[] {
  const byKey = new Map<string, AmountLine[]>();
  for (const line of lines) {
    const key = `${group}:${line.category}:${normalizeDescription(line.description)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), line]);
  }
  return [...byKey.entries()].map(([key, members]) => {
    const candidates: ProfileCandidate[] = [];
    const excluded: ExcludedEvidence[] = [];
    for (const m of members) {
      const source = payslipSource(m.doc, m.period, m.description || null);
      if (m.unreadable) excluded.push({ value: null, source, reason: 'amount_unreadable', detail: null });
      else candidates.push({ value: round2(m.amount), source, detail: detail({ amount: m.amount }) });
    }
    return resolveField({ key, meaning, unit: 'eur_per_period' }, candidates, excluded, 'not_on_payslips');
  });
}

function netLineEvidence(slips: PayslipDoc[]): { additions: AmountLine[]; deductions: AmountLine[] } {
  const additions: AmountLine[] = [];
  const deductions: AmountLine[] = [];
  for (const { doc, period, unreadable } of slips) {
    period.net_additions.forEach((l, i) => {
      const path = `net_additions[${i}].amount`;
      additions.push({ doc, period, category: l.category, description: l.description, amount: l.amount, path, unreadable: unreadable.has(path) });
    });
    period.et?.et_reimbursements.forEach((l, i) => {
      const path = `et.et_reimbursements[${i}].amount`;
      additions.push({ doc, period, category: 'et_reimbursement', description: l.description, amount: l.amount, path, unreadable: unreadable.has(path) });
    });
    period.net_deductions.forEach((l, i) => {
      const path = `net_deductions[${i}].amount`;
      deductions.push({ doc, period, category: l.category, description: l.description, amount: l.amount, path, unreadable: unreadable.has(path) });
    });
  }
  return { additions, deductions };
}

function surchargeLines(slips: PayslipDoc[]): Array<PercentLine & { category: string }> {
  return slips.flatMap(({ doc, period }) =>
    period.hour_lines
      .filter((l) => l.category === 'irregular_surcharge' || l.category === 'adv_compensation' || (l.category === 'overtime' && l.adds_hours === false))
      .map((l) => ({
        doc,
        period,
        // A non-hour-adding "overtime" line keeps its own key so it is never mistaken for, or merged
        // with, a genuine overtime tier.
        category: l.category === 'overtime' ? 'overtime_surcharge' : l.category,
        description: l.description,
        percent: isFiniteNumber(l.percent) ? l.percent : null,
        amount: l.amount,
        base: null,
        hours: l.hours,
      })),
  );
}

// ---------------------------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------------------------

const F = (key: string, meaning: string, unit: ProfileUnit): FieldSpec => ({ key, meaning, unit });

export function resolvePayrollProfile(input: ResolvePayrollProfileInput): PayrollProfile {
  const { asOfDate, documents } = input;
  const side = buildContractSide(documents, asOfDate);
  const slips = payslipDocs(documents);
  const slipReason = payslipEmptyReason(slips);

  // --- employment ---------------------------------------------------------------------------
  const rateContract = contractEvidence(side, 'hourlyRate', asOfDate);
  const rateCandidates = [...rateContract.candidates, ...regularRateEvidence(slips)];
  const hourlyRate = resolveField(
    F('hourlyRate', 'gross_base_hourly_wage', 'eur_per_hour'),
    rateCandidates,
    rateContract.excluded,
    documents.length === 0 ? 'no_documents' : 'not_on_documents',
    rateContract.timelineConflictAsOf,
  );

  const payslipEmployerCandidates: ProfileCandidate[] = [];
  const payslipEmployerExcluded: ExcludedEvidence[] = [];
  const hirerCandidates: ProfileCandidate[] = [];
  for (const { doc, period } of slips) {
    const names = period.employers.map((e) => e.name).filter((n): n is string => typeof n === 'string' && n.trim() !== '');
    if (period.employers.length === 1 && names[0]) payslipEmployerCandidates.push({ value: names[0].trim(), source: payslipSource(doc, period, null), detail: null });
    else if (period.employers.length > 1) for (const n of names) payslipEmployerExcluded.push({ value: n.trim(), source: payslipSource(doc, period, null), reason: 'multiple_employers_on_payslip', detail: null });
    const hirer = period.hirer?.name;
    if (typeof hirer === 'string' && hirer.trim() !== '') hirerCandidates.push({ value: hirer.trim(), source: payslipSource(doc, period, null), detail: null });
  }

  const employment: Record<EmploymentFieldKey, ProfileField> = {
    // Employer as named by the contract and employer as named by the payslip are kept as two fields:
    // agency/legal-entity name variants ("X Nederland B.V." vs "X Services") would otherwise become
    // conflicts on a non-calculation field, and P1 has no approved rule for name equivalence.
    employerName: contractOnlyField(F('employerName', 'employer_or_agency_name_contract', 'text'), side, 'employerName', asOfDate),
    payslipEmployerName: resolveField(F('payslipEmployerName', 'employer_name_payslip', 'text'), payslipEmployerCandidates, payslipEmployerExcluded, slipReason),
    hirerName: resolveField(F('hirerName', 'hirer_name_payslip', 'text'), hirerCandidates, [], slipReason),
    hourlyRate,
    hoursPerWeek: contractOnlyField(F('hoursPerWeek', 'contract_hours_per_week', 'hours_per_week'), side, 'hoursPerWeek', asOfDate),
    guaranteedHours: contractOnlyField(F('guaranteedHours', 'guaranteed_hours_per_guarantee_period', 'hours'), side, 'guaranteedHours', asOfDate),
    guaranteedHoursPeriodWeeks: contractOnlyField(F('guaranteedHoursPeriodWeeks', 'guarantee_period_length', 'weeks'), side, 'guaranteedHoursPeriodWeeks', asOfDate),
    overtimeThresholdHours: contractOnlyField(F('overtimeThresholdHours', 'daily_overtime_hours_before_tier_2', 'hours'), side, 'overtimeTierThresholdHours', asOfDate),
    caoName: contractOnlyField(F('caoName', 'cao_name', 'text'), side, 'caoName', asOfDate),
    phase: unknownField(F('phase', 'cao_phase', 'text'), 'not_a_separate_extraction_field'),
    contractType: contractOnlyField(F('contractType', 'contract_type', 'text'), side, 'contractType', asOfDate),
    functionTitle: contractOnlyField(F('functionTitle', 'function_title', 'text'), side, 'functionTitle', asOfDate),
    contractStartDate: contractOnlyField(F('contractStartDate', 'contract_start_date', 'date'), side, 'startDate', asOfDate),
    contractEndDate: contractOnlyField(F('contractEndDate', 'contract_end_date', 'date'), side, 'endDate', asOfDate),
    monthlySalary: contractOnlyField(F('monthlySalary', 'gross_monthly_salary', 'eur_per_month'), side, 'monthlySalary', asOfDate),
    pensionFundName: contractOnlyField(F('pensionFundName', 'pension_fund_name', 'text'), side, 'pensionFund', asOfDate),
  };

  // --- payroll ------------------------------------------------------------------------------
  const periodCandidates: ProfileCandidate[] = [];
  const periodExcluded: ExcludedEvidence[] = [];
  for (const { doc, period } of slips) {
    if (period.period_type_confirmed) periodCandidates.push({ value: period.period_type, source: payslipSource(doc, period, null), detail: null });
    else periodExcluded.push({ value: null, source: payslipSource(doc, period, null), reason: 'period_type_unconfirmed', detail: null });
  }

  const ot = overtimeEvidence(slips);

  const vakantiegeldExcluded: ExcludedEvidence[] = slips.flatMap(({ doc, period, unreadable }) =>
    period.reservations
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.type === 'vakantiegeld')
      .map(({ r, i }) => ({
        value: null,
        source: payslipSource(doc, period, null),
        reason: unreadable.has(`reservations[${i}].opgebouwd_this_period`) ? ('amount_unreadable' as const) : ('not_a_forward_rate' as const),
        detail: detail({ amount: r.opgebouwd_this_period }),
      })),
  );

  const btCandidates: ProfileCandidate[] = [];
  const jaarloonCandidates: ProfileCandidate[] = [];
  const etCandidates: ProfileCandidate[] = [];
  const etExcluded: ExcludedEvidence[] = [];
  for (const { doc, period, unreadable } of slips) {
    const printed = period.bijzonder_tarief.tarief_bt.printed;
    if (isFiniteNumber(printed)) btCandidates.push({ value: round2(printed), source: payslipSource(doc, period, null), detail: null });
    const jaarloon = period.bijzonder_tarief.jaarloon_bt;
    if (isFiniteNumber(jaarloon)) jaarloonCandidates.push({ value: round2(jaarloon), source: payslipSource(doc, period, null), detail: null });
    if (period.et?.et_applicable) {
      const source = payslipSource(doc, period, null);
      if (unreadable.has('et.et_exchange_amount')) etExcluded.push({ value: null, source, reason: 'amount_unreadable', detail: null });
      else etCandidates.push({ value: round2(period.et.et_exchange_amount), source, detail: null });
    }
  }

  const percentField = (key: string, meaning: string, lines: PercentLine[]): ProfileField => {
    const ev = percentLineEvidence(lines);
    return resolveField(F(key, meaning, 'percent_of_printed_base'), ev.candidates, ev.excluded, slipReason);
  };

  const payroll: Record<PayrollFieldKey, ProfileField> = {
    periodType: resolveField(F('periodType', 'pay_period_type', 'period_type'), periodCandidates, periodExcluded, slipReason),
    overtimeTier1Premium: resolveField(F('overtimeTier1Premium', 'overtime_tier_1_premium_above_base', 'premium_percent'), ot.tier1, ot.excluded, slipReason),
    overtimeTier2Premium: resolveField(F('overtimeTier2Premium', 'overtime_tier_2_premium_above_base', 'premium_percent'), ot.tier2, ot.excluded, slipReason),
    overtimeAdditionalTierPremiums: resolveField(F('overtimeAdditionalTierPremiums', 'overtime_premiums_between_tier_1_and_tier_2', 'premium_percent_list'), ot.additional, [], slipReason),
    saturdayPremium: unknownField(F('saturdayPremium', 'saturday_premium_above_base', 'premium_percent'), 'no_weekday_evidence'),
    sundayPremium: unknownField(F('sundayPremium', 'sunday_premium_above_base', 'premium_percent'), 'no_weekday_evidence'),
    publicHolidayPremium: unknownField(F('publicHolidayPremium', 'public_holiday_premium_above_base', 'premium_percent'), 'no_weekday_evidence'),
    loonheffingskorting: unknownField(F('loonheffingskorting', 'loonheffingskorting_applied', 'boolean'), 'no_evidence_source'),
    pensionEmployeePercent: percentField('pensionEmployeePercent', 'pension_employee_contribution', preTaxLines(slips, 'pension')),
    pawwEmployeePercent: percentField('pawwEmployeePercent', 'paww_employee_contribution', preTaxLines(slips, 'paww')),
    sectorPremiumPercent: percentField('sectorPremiumPercent', 'sector_premium_ziektewet_azw_employee', preTaxLines(slips, 'ziektewet')),
    wgaGatEmployeePercent: percentField('wgaGatEmployeePercent', 'wga_gat_employee_contribution', preTaxLines(slips, 'wga_gat')),
    wgaEmployeePercent: percentField('wgaEmployeePercent', 'wga_employee_contribution_post_tax', postTaxLines(slips, 'wga')),
    gediffWgaEmployeePercent: percentField('gediffWgaEmployeePercent', 'gediff_wga_employee_contribution_post_tax', postTaxLines(slips, 'gediff_wga')),
    whkEmployeePercent: percentField('whkEmployeePercent', 'whk_employee_contribution_post_tax', postTaxLines(slips, 'whk')),
    vakantiegeldAccrualPercent: unknownField(F('vakantiegeldAccrualPercent', 'vakantiegeld_accrual_rate', 'percent'), slipReason, vakantiegeldExcluded),
    bijzonderTariefPrintedPercent: resolveField(F('bijzonderTariefPrintedPercent', 'bijzonder_tarief_rate_as_printed', 'percent'), btCandidates, [], slipReason),
    jaarloonBt: resolveField(F('jaarloonBt', 'jaarloon_used_for_bijzonder_tarief', 'eur_per_year'), jaarloonCandidates, [], slipReason),
    etExchangeAmount: resolveField(F('etExchangeAmount', 'et_taxable_base_reduction_per_period', 'eur_per_period'), etCandidates, etExcluded, slipReason),
  };

  // --- recurring items ------------------------------------------------------------------------
  const net = netLineEvidence(slips);
  const otherPre = slips.flatMap(({ doc, period }) =>
    period.pre_tax_deductions
      .filter((d) => d.category === 'other')
      .map((d) => ({ doc, period, category: d.category, description: d.description, percent: isFiniteNumber(d.percent) ? d.percent : null, amount: d.amount.value, base: isFiniteNumber(d.base) ? d.base : null, hours: null })),
  );
  const otherPost = slips.flatMap(({ doc, period }) =>
    period.post_tax_social
      .filter((d) => d.category === 'other')
      .map((d) => ({ doc, period, category: d.category, description: d.description, percent: isFiniteNumber(d.percent) ? d.percent : null, amount: d.amount.value, base: null, hours: null })),
  );
  const recurringItems: RecurringItems = {
    surcharges: groupedPercentFields('surcharge', 'surcharge_on_hours_already_counted', 'surcharge_percent', surchargeLines(slips)),
    otherPreTaxDeductions: groupedPercentFields('pre_tax', 'other_pre_tax_deduction_rate', 'percent_of_printed_base', otherPre),
    otherPostTaxDeductions: groupedPercentFields('post_tax', 'other_post_tax_deduction_rate', 'percent_of_printed_base', otherPost),
    netAdditions: groupedAmountFields('net_addition', 'recurring_net_addition', net.additions),
    netDeductions: groupedAmountFields('net_deduction', 'recurring_net_deduction', net.deductions),
  };

  // --- calibration only ---------------------------------------------------------------------
  const calibrationOnly = {
    payslips: slips.map(({ doc, period }) => ({
      source: payslipSource(doc, period, null),
      printed: {
        table_tax: period.printed_table_tax,
        bt_tax: period.printed_bt_tax,
        algemene_heffingskorting: period.printed_algemene_heffingskorting,
        arbeidskorting: period.printed_arbeidskorting,
        gross_total: period.printed_gross_total,
        loon_voor_heffingen: period.printed_loon_voor_heffingen,
        net: period.printed_net,
        payout: period.printed_payout,
        minimum_wage: period.wml_printed,
      },
    })),
  };

  return {
    version: 1,
    asOfDate,
    documents: documents.map(docRef),
    contractContext: buildContractContext(side, asOfDate),
    employment,
    payroll,
    recurringItems,
    calibrationOnly,
  };
}
