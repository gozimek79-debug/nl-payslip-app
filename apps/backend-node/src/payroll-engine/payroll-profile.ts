import type { ContractExtraction } from './contract.js';
import { resolveEffectiveContract, type ContractDocumentEntry, type EffectiveContract } from './contract-timeline.js';
import { stripDiacritics } from './extraction-consistency.js';
import type { PreTaxDeductionCategory, PostTaxSocialCategory } from './payslip-model.js';
import {
  contractExtractionFromFacts, singleExactValue, firstExactFact,
  type DocumentFacts, type PayslipDocumentFacts, type ContractDocumentFacts, type PayrollFact, type FactEvidence,
  type FactReasonCode, type LineIssue, type PayslipScalarKey, type ContractScalarKey, type PremiumFact,
} from './document-facts.js';

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
 * P2 (ZADANIE-P2-LOONTO-PRO.md §P2.13): the INPUT BOUNDARY now consumes document facts
 * (document-facts.ts) - typed facts with page / printed label / raw value - instead of a
 * `PayslipPeriod` and a `ContractExtraction`. The resolution rules are P1/P1.1's, unchanged:
 *   fact `exact`                         -> candidate
 *   fact `ambiguous` / `implausible`     -> excluded evidence, with the fact's own reason
 *   same-document contradiction          -> each value a candidate (so the field is a visible
 *                                           conflict; one document counts as ONE source)
 *   fact absent                          -> nothing
 * Minimal, backward-compatible extensions (documented in LOONTO-PRO-P2-DOCUMENT-FACTS.md):
 * `EvidenceSource.rawValue`, page now populated, `PayPeriodRef.startDate/paymentDate`,
 * `ExcludedEvidence.factReason`, three excluded-reason codes, one conflict reason
 * (`annex_effective_date_disputed`), and explicitly evidenced tier/weekday facts.
 *
 * Pure and synchronous: no I/O, no AI call, no rules lookup.
 */

export type EvidenceState = 'document_exact' | 'corroborated' | 'user_confirmed' | 'user_corrected' | 'conflict' | 'unknown';

/** States whose `value` may feed a forward calculation as a document- or user-backed parameter.
 * `user_confirmed`/`user_corrected` are defined so the schema is final, but nothing produces them
 * yet - field-level user confirmation is P3. */
export const USABLE_EVIDENCE_STATES: readonly EvidenceState[] = ['document_exact', 'corroborated', 'user_confirmed', 'user_corrected'];

export type SourceRole = 'contract_base' | 'contract_annex' | 'payslip' | 'rules' | 'user';
export type SourceType = 'document' | 'rules' | 'user';
export type PayslipPeriodType = 'week' | '4-weekly' | 'month';

export interface PayPeriodRef {
  label: string | null;
  /** P2: printed period start, when the payslip prints one. */
  startDate: string | null;
  endDate: string | null;
  /** P2: printed payment date. */
  paymentDate: string | null;
  /** null when the payslip's period type is not established by an exact fact. */
  periodType: PayslipPeriodType | null;
}

export interface EvidenceSource {
  sourceType: SourceType;
  role: SourceRole;
  /** The document's index in the request's own document list - never re-numbered. */
  documentIndex: number | null;
  documentLabel: string | null;
  /** Annex effective date used to place it in the timeline. null for a base contract/payslip. */
  effectiveDate: string | null;
  /** Payslip pay period, null for contracts. */
  payPeriod: PayPeriodRef | null;
  /** The as-printed label/line description the value was read from, when one exists. */
  printedLabel: string | null;
  /** P2: the printed text fragment the value was read from, as printed. */
  rawValue: string | null;
  /** 1-based page (P2). `line` stays null - a line index cannot be proved from an image. */
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
  /** An overtime line printed below 100%, or a contract premium whose wording does not say whether
   * the percentage is the total paid rate or an addition - semantics cannot be told apart. */
  | 'percent_semantics_ambiguous'
  /** The line exists but prints no percentage, so no forward rate can be taken from it. */
  | 'percent_not_printed'
  | 'period_type_unconfirmed'
  /** Evidence that exists but is not itself a forward rate (e.g. an accrued vakantiegeld amount). */
  | 'not_a_forward_rate'
  /** A payslip naming more than one employer - which one a value belongs to is not established. */
  | 'multiple_employers_on_payslip'
  /** P2: the document prints it, but not readably/unambiguously (see `factReason`). */
  | 'ambiguous_on_document'
  /** P2: a printed value rejected by a domain sense check (see `factReason`). */
  | 'implausible_value'
  /** P2: an overtime line whose document does not show whether it adds hours or surcharges them. */
  | 'adds_hours_unclear';

export interface ExcludedEvidence {
  value: ProfileValue | null;
  source: EvidenceSource;
  reason: ExcludedReasonCode;
  detail: CandidateDetail | null;
  /** P2: the document fact's own reason code (e.g. `raw_value_mismatch`, `exceeds_legal_hours_per_week`). */
  factReason?: FactReasonCode;
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
  /** P5: no document names the weekday/holiday category; never derived from generic percentages. */
  | 'no_weekday_evidence'
  /** No document field establishes this switch; nothing is derived from printed credits. */
  | 'no_evidence_source'
  /** Not a separate extraction field (kept for compatibility; P2 extracts the CAO phase when printed). */
  | 'not_a_separate_extraction_field'
  /** P1.1: overtime premiums were observed (see `observedOvertimePremiums`) but no source explicitly
   * identifies which overtime tier any of them is - the tier stays unknown rather than invented. */
  | 'tier_identity_not_evidenced';

export type ProfileReason =
  | { code: 'sources_disagree' }
  /** The contract timeline itself reported two documents disagreeing on the same date. */
  | { code: 'timeline_disagreement'; asOfDate: string }
  /** P2: an annex's printed effective date and the user-entered date disagree, and the field's value
   * depends on which one is right - both outcomes are kept, none is chosen. */
  | { code: 'annex_effective_date_disputed' }
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

export interface ProfileDocumentInput {
  index: number;
  label: string;
  role: ProfileDocumentRole;
  /** User-entered annex effective date (unchanged UI mechanism). Only meaningful for an annex. */
  effectiveDate: string | null;
  /** P2: the document's merged facts (document-facts.ts). Payslip facts for a payslip, contract facts
   * for a base contract or annex. */
  facts: DocumentFacts;
}

export interface ResolvePayrollProfileInput {
  /** The date the contract timeline is resolved for (user-chosen). */
  asOfDate: string;
  documents: ProfileDocumentInput[];
}

export interface ProfileDocumentRef {
  index: number;
  label: string;
  role: ProfileDocumentRole;
  /** For an annex: the effective date used to place it, or null when none is usable or the printed and
   * user-entered dates are disputed (see `contractContext.annexDates`). */
  effectiveDate: string | null;
  payPeriod: PayPeriodRef | null;
}

export type AnnexDateState = 'agreed' | 'user_entered_only' | 'document_only' | 'disputed' | 'none';

export interface AnnexDateEvidence {
  index: number;
  label: string;
  userEnteredDate: string | null;
  /** The annex's own printed effective date (P2 extraction), when exactly one is printed. */
  documentDate: string | null;
  documentEvidence: FactEvidence | null;
  state: AnnexDateState;
}

export interface ContractContext {
  asOfDate: string;
  baseContracts: ProfileDocumentRef[];
  annexesInForce: ProfileDocumentRef[];
  annexesNotYetInForce: ProfileDocumentRef[];
  annexesUndated: ProfileDocumentRef[];
  /** P2: annexes whose printed and user-entered dates disagree - neither date silently wins. */
  annexesDateDisputed: ProfileDocumentRef[];
  /** P2: per annex, both date sources side by side. */
  annexDates: AnnexDateEvidence[];
}

export const EMPLOYMENT_FIELD_KEYS = [
  'employerName', 'payslipEmployerName', 'hirerName', 'contractHirerName', 'hourlyRate', 'hoursPerWeek', 'guaranteedHours',
  'guaranteedHoursPeriodWeeks', 'overtimeThresholdHours', 'caoName', 'phase', 'contractType', 'functionTitle',
  'contractStartDate', 'contractEndDate', 'monthlySalary', 'pensionFundName',
] as const;
export type EmploymentFieldKey = (typeof EMPLOYMENT_FIELD_KEYS)[number];

export const PAYROLL_FIELD_KEYS = [
  'periodType', 'overtimeTier1Premium', 'overtimeTier2Premium',
  'saturdayPremium', 'sundayPremium', 'publicHolidayPremium', 'loonheffingskorting',
  'pensionEmployeePercent', 'pawwEmployeePercent', 'sectorPremiumPercent', 'wgaGatEmployeePercent',
  'wgaEmployeePercent', 'gediffWgaEmployeePercent', 'whkEmployeePercent', 'vakantiegeldAccrualPercent',
  'bijzonderTariefPrintedPercent', 'jaarloonBt', 'etExchangeAmount',
] as const;
export type PayrollFieldKey = (typeof PAYROLL_FIELD_KEYS)[number];

export interface RecurringItems {
  /** Irregular-hours / ADV / non-hour-adding surcharge lines (payslips) and printed irregular-hours
   * premiums (contracts), by percent. */
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

/** P1.1: overtime premiums observed on documents, tier position unknown. Neutral evidence - never a
 * calculator tier prefill by itself. P2: contract-printed overtime premiums with explicit semantics
 * join the payslip observations here. */
export interface ObservedOvertimePremiums {
  /** One field per distinct observed premium (key `observed_overtime_premium:<premium>`). */
  fields: ProfileField[];
  /** Overtime evidence seen but not usable - each line/premium exactly once. */
  excluded: ExcludedEvidence[];
}

export interface PayrollProfile {
  version: 1;
  asOfDate: string;
  documents: ProfileDocumentRef[];
  contractContext: ContractContext;
  employment: Record<EmploymentFieldKey, ProfileField>;
  payroll: Record<PayrollFieldKey, ProfileField>;
  recurringItems: RecurringItems;
  observedOvertimePremiums: ObservedOvertimePremiums;
  calibrationOnly: { payslips: CalibrationPayslipEvidence[] };
}

// ---------------------------------------------------------------------------------------------
// Generic resolution (P1/P1.1 - unchanged rules)
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
 * `forcedConflict` (a timeline disagreement, a disputed annex date) makes the field a conflict with
 * that reason whenever it has candidates.
 */
function resolveField(spec: FieldSpec, candidates: ProfileCandidate[], excluded: ExcludedEvidence[], emptyReason: UnknownReasonCode, forcedConflict: ProfileReason | null = null): ProfileField {
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
  if (groups.length > 1 || forcedConflict !== null) {
    return { ...base, value: null, state: 'conflict', sources: candidates.map((c) => c.source), reason: forcedConflict ?? { code: 'sources_disagree' } };
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

const F = (key: string, meaning: string, unit: ProfileUnit): FieldSpec => ({ key, meaning, unit });

// ---------------------------------------------------------------------------------------------
// Fact -> evidence (the ONE mapping from document-fact status to profile evidence)
// ---------------------------------------------------------------------------------------------

function isContradiction(f: PayrollFact): boolean {
  return f.status === 'ambiguous' && f.reason === 'same_document_contradiction' && f.value !== null;
}

function normalizeFactValue(value: unknown): ProfileValue | null {
  if (isFiniteNumber(value)) return round2(value);
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

/** Turns one document's occurrences of one fact into candidates/excluded evidence. */
function factEvidence(occurrences: PayrollFact[], source: (f: PayrollFact) => EvidenceSource): { candidates: ProfileCandidate[]; excluded: ExcludedEvidence[] } {
  const candidates: ProfileCandidate[] = [];
  const excluded: ExcludedEvidence[] = [];
  for (const f of occurrences) {
    const value = normalizeFactValue(f.value);
    if ((f.status === 'exact' || isContradiction(f)) && value !== null) {
      candidates.push({ value, source: source(f), detail: null });
    } else if (f.status === 'ambiguous') {
      excluded.push({ value: null, source: source(f), reason: 'ambiguous_on_document', detail: null, ...(f.reason ? { factReason: f.reason } : {}) });
    } else if (f.status === 'implausible') {
      excluded.push({ value: null, source: source(f), reason: 'implausible_value', detail: null, ...(f.reason ? { factReason: f.reason } : {}) });
    }
  }
  return { candidates, excluded };
}

function issueFor(issues: LineIssue[], field: LineIssue['field']): LineIssue | undefined {
  return issues.find((i) => i.field === field);
}

/** Exclusion for a line sub-field that could not be used. Amount issues keep P1's
 * `amount_unreadable` code; any other sub-field reports ambiguity/implausibility with the reason. */
function issueExclusion(issue: LineIssue, source: EvidenceSource, d: CandidateDetail): ExcludedEvidence {
  if (issue.field === 'amount' || issue.field === 'accrued' || issue.field === 'paidOut') {
    return { value: null, source, reason: 'amount_unreadable', detail: d, factReason: issue.reason };
  }
  return { value: null, source, reason: issue.status === 'implausible' ? 'implausible_value' : 'ambiguous_on_document', detail: d, factReason: issue.reason };
}

// ---------------------------------------------------------------------------------------------
// Payslip side - each payslip contributes independently, never as a whole-document verdict
// ---------------------------------------------------------------------------------------------

interface PayslipDoc {
  doc: ProfileDocumentInput;
  facts: PayslipDocumentFacts;
  payPeriod: PayPeriodRef;
}

function asText(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function payPeriodOfFacts(facts: PayslipDocumentFacts): PayPeriodRef {
  const s = facts.scalars;
  const periodType = asText(singleExactValue(s.periodType));
  return {
    label: asText(singleExactValue(s.periodLabel)),
    startDate: asText(singleExactValue(s.periodStart)),
    endDate: asText(singleExactValue(s.periodEnd)),
    paymentDate: asText(singleExactValue(s.paymentDate)),
    periodType: periodType === 'week' || periodType === '4-weekly' || periodType === 'month' ? periodType : null,
  };
}

function payslipDocs(documents: ProfileDocumentInput[]): PayslipDoc[] {
  return documents
    .filter((d) => d.role === 'payslip' && d.facts.kind === 'payslip')
    .map((d) => ({ doc: d, facts: d.facts as PayslipDocumentFacts, payPeriod: payPeriodOfFacts(d.facts as PayslipDocumentFacts) }));
}

function payslipEmptyReason(slips: PayslipDoc[]): UnknownReasonCode {
  return slips.length === 0 ? 'no_payslip_document' : 'not_on_payslips';
}

function payslipSource(slip: PayslipDoc, evidence: FactEvidence | null): EvidenceSource {
  return {
    sourceType: 'document',
    role: 'payslip',
    documentIndex: slip.doc.index,
    documentLabel: slip.doc.label,
    effectiveDate: null,
    payPeriod: slip.payPeriod,
    printedLabel: evidence?.printedLabel ?? null,
    rawValue: evidence?.rawValue ?? null,
    page: evidence?.page ?? null,
    line: evidence?.line ?? null,
  };
}

function payslipScalarEvidence(slips: PayslipDoc[], key: PayslipScalarKey): { candidates: ProfileCandidate[]; excluded: ExcludedEvidence[] } {
  const candidates: ProfileCandidate[] = [];
  const excluded: ExcludedEvidence[] = [];
  for (const slip of slips) {
    const ev = factEvidence(slip.facts.scalars[key], (f) => payslipSource(slip, f.evidence));
    candidates.push(...ev.candidates);
    excluded.push(...ev.excluded);
  }
  return { candidates, excluded };
}

function regularRateEvidence(slips: PayslipDoc[]): { candidates: ProfileCandidate[]; excluded: ExcludedEvidence[] } {
  const candidates: ProfileCandidate[] = [];
  const excluded: ExcludedEvidence[] = [];
  for (const slip of slips) {
    for (const line of slip.facts.hourLines) {
      if (line.kind !== 'regular') continue;
      const source = payslipSource(slip, line.evidence);
      const d = detail({ hours: line.hours, amount: line.amount });
      const issue = issueFor(line.issues, 'rate');
      if (issue) excluded.push(issueExclusion(issue, source, d));
      else if (isFiniteNumber(line.rate) && line.rate > 0) candidates.push({ value: round2(line.rate), source, detail: d });
    }
  }
  return { candidates, excluded };
}

interface OvertimeEvidence {
  /** One candidate per genuine overtime observation with usable semantics - tier position unknown. */
  observed: ProfileCandidate[];
  /** Candidates whose source EXPLICITLY identifies tier 1 / tier 2 (with the wording kept). */
  tier1: ProfileCandidate[];
  tier2: ProfileCandidate[];
  excluded: ExcludedEvidence[];
}

/**
 * P1.1 (binding) + P2: what an overtime fact PROVES, and nothing more.
 *   Payslip lines - only a genuine overtime line counts: `kind: 'overtime'` AND `addsHours: true`. Its
 *     printed percent is the FULL paid multiplier, so the observed premium is `percent - 100` (printed
 *     150% -> +50; the conversion confirmed against PKF's fixture in 3.0a.5). A surcharge
 *     (`addsHours: false`) is surcharge evidence; an overtime line whose adds-hours nature the
 *     document does not show is excluded (`adds_hours_unclear`). No printed percent ->
 *     `percent_not_printed`. Below-100% rule unchanged: a payslip printing one has each of its
 *     overtime lines excluded once as `percent_semantics_ambiguous`.
 *   Contract premiums (P2) - category overtime only; a `total_multiplier` percentage becomes
 *     `percent - 100`, a `premium_above_base` one stays as printed; `unclear` semantics are excluded,
 *     never guessed.
 *   Tier identity is NEVER derived from size, ordering, count, recency or position. A fact populates
 *   a tier field only when its own source explicitly identifies the tier (`explicitTier` with the
 *   document's wording kept - document-facts.ts drops a bare tier number).
 */
function overtimeEvidence(slips: PayslipDoc[], contracts: ApplicableContract[]): OvertimeEvidence {
  const ev: OvertimeEvidence = { observed: [], tier1: [], tier2: [], excluded: [] };
  const pushTier = (tier: 1 | 2 | null, c: ProfileCandidate) => {
    if (tier === 1) ev.tier1.push(c);
    if (tier === 2) ev.tier2.push(c);
  };
  for (const slip of slips) {
    const overtime = slip.facts.hourLines.filter((l) => l.kind === 'overtime' && l.addsHours !== false);
    const ambiguousSlip = overtime.some((l) => l.addsHours === true && isFiniteNumber(l.percent) && l.percent < 100);
    for (const l of overtime) {
      const source = payslipSource(slip, l.evidence);
      const d = detail({ hours: l.hours, amount: l.amount, printedPercent: l.percent });
      const percentIssue = issueFor(l.issues, 'percent');
      if (l.addsHours === null) ev.excluded.push({ value: l.percent, source, reason: 'adds_hours_unclear', detail: d });
      else if (percentIssue) ev.excluded.push(issueExclusion(percentIssue, source, d));
      else if (!isFiniteNumber(l.percent)) ev.excluded.push({ value: null, source, reason: 'percent_not_printed', detail: d });
      else if (ambiguousSlip) ev.excluded.push({ value: l.percent, source, reason: 'percent_semantics_ambiguous', detail: d });
      else {
        const candidate: ProfileCandidate = { value: round2(l.percent - 100), source, detail: d };
        ev.observed.push(candidate);
        pushTier(l.explicitTier, candidate);
      }
    }
  }
  for (const c of contracts) {
    for (const p of c.facts.premiums.filter((x) => x.category === 'overtime')) {
      const source = contractSource(c, p.evidence);
      const outcome = premiumValue(p, source);
      if ('excluded' in outcome) ev.excluded.push(outcome.excluded);
      else {
        ev.observed.push(outcome.candidate);
        pushTier(p.explicitTier, outcome.candidate);
      }
    }
  }
  return ev;
}

/** One neutral field per distinct observed premium. Grouping by the premium itself means documents
 * with different SETS of premiums never "conflict": +25 and +50 are two observations, not two
 * candidates for one slot. The same premium on several documents is `corroborated`. */
function observedOvertimeFields(observed: ProfileCandidate[]): ProfileField[] {
  const byPremium = new Map<number, ProfileCandidate[]>();
  for (const c of observed) {
    const premium = c.value as number;
    const existing = [...byPremium.keys()].find((k) => Math.abs(k - premium) < NUMERIC_EQUALITY_EPSILON);
    const key = existing ?? premium;
    byPremium.set(key, [...(byPremium.get(key) ?? []), c]);
  }
  return [...byPremium.entries()]
    .sort(([x], [y]) => x - y) // display order only - carries no tier meaning
    .map(([premium, members]) => resolveField(F(`observed_overtime_premium:${premium}`, 'overtime_premium_observed_tier_unknown', 'premium_percent'), members, [], 'not_on_documents'));
}

function normalizeDescription(description: string): string {
  return stripDiacritics(description).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** A line whose forward parameter is its printed percentage (a deduction rate, a surcharge rate). */
interface PercentLine {
  source: EvidenceSource;
  description: string;
  percent: number | null;
  percentIssue: LineIssue | undefined;
  amount: number | null;
  base: number | null;
  hours: number | null;
}

function percentLineEvidence(lines: PercentLine[]): { candidates: ProfileCandidate[]; excluded: ExcludedEvidence[] } {
  const candidates: ProfileCandidate[] = [];
  const excluded: ExcludedEvidence[] = [];
  for (const l of lines) {
    const d = detail({ amount: l.amount, base: l.base, hours: l.hours, printedPercent: l.percent });
    if (l.percentIssue) excluded.push(issueExclusion(l.percentIssue, l.source, d));
    else if (isFiniteNumber(l.percent)) candidates.push({ value: round2(l.percent), source: l.source, detail: d });
    else excluded.push({ value: null, source: l.source, reason: 'percent_not_printed', detail: d });
  }
  return { candidates, excluded };
}

function deductionLines(slips: PayslipDoc[], placement: 'pre_tax' | 'post_tax', category: PreTaxDeductionCategory | PostTaxSocialCategory): Array<PercentLine & { category: string }> {
  return slips.flatMap((slip) =>
    slip.facts.deductionLines
      .filter((d) => d.placement === placement && d.category === category)
      .map((d) => ({
        source: payslipSource(slip, d.evidence),
        category: d.category,
        description: d.evidence.printedLabel ?? '',
        percent: d.percent,
        percentIssue: issueFor(d.issues, 'percent'),
        amount: d.amount,
        base: d.base,
        hours: null,
      })),
  );
}

/** Groups lines by (group, category, normalised printed description) and resolves each group as its
 * own field - a recurring item is "the same line on several documents", never a merge across lines. */
function groupedFields<L extends { category: string; description: string }>(group: string, lines: L[], resolveGroup: (key: string, members: L[]) => ProfileField): ProfileField[] {
  const byKey = new Map<string, L[]>();
  for (const line of lines) {
    const key = `${group}:${line.category}:${normalizeDescription(line.description)}`;
    byKey.set(key, [...(byKey.get(key) ?? []), line]);
  }
  return [...byKey.entries()].map(([key, members]) => resolveGroup(key, members));
}

function groupedPercentFields(group: string, meaning: string, unit: ProfileUnit, lines: Array<PercentLine & { category: string }>, extra: Array<{ category: string; description: string; candidate?: ProfileCandidate; excluded?: ExcludedEvidence }> = []): ProfileField[] {
  type Item = { category: string; description: string; line?: PercentLine; candidate?: ProfileCandidate; excluded?: ExcludedEvidence };
  const items: Item[] = [...lines.map((line) => ({ category: line.category, description: line.description, line })), ...extra];
  return groupedFields(group, items, (key, members) => {
    const ev = percentLineEvidence(members.flatMap((m) => (m.line ? [m.line] : [])));
    for (const m of members) {
      if (m.candidate) ev.candidates.push(m.candidate);
      if (m.excluded) ev.excluded.push(m.excluded);
    }
    return resolveField({ key, meaning, unit }, ev.candidates, ev.excluded, 'not_on_documents');
  });
}

interface AmountLine {
  source: EvidenceSource;
  category: string;
  description: string;
  amount: number | null;
  amountIssue: LineIssue | undefined;
}

function groupedAmountFields(group: string, meaning: string, lines: AmountLine[]): ProfileField[] {
  return groupedFields(group, lines, (key, members) => {
    const candidates: ProfileCandidate[] = [];
    const excluded: ExcludedEvidence[] = [];
    for (const m of members) {
      const d = detail({ amount: m.amount });
      if (m.amountIssue) excluded.push(issueExclusion(m.amountIssue, m.source, d));
      else if (isFiniteNumber(m.amount)) candidates.push({ value: round2(m.amount), source: m.source, detail: d });
      else excluded.push({ value: null, source: m.source, reason: 'amount_unreadable', detail: d });
    }
    return resolveField({ key, meaning, unit: 'eur_per_period' }, candidates, excluded, 'not_on_payslips');
  });
}

function netLineEvidence(slips: PayslipDoc[]): { additions: AmountLine[]; deductions: AmountLine[] } {
  const additions: AmountLine[] = [];
  const deductions: AmountLine[] = [];
  for (const slip of slips) {
    for (const l of slip.facts.netLines) {
      const line: AmountLine = { source: payslipSource(slip, l.evidence), category: l.category, description: l.evidence.printedLabel ?? '', amount: l.amount, amountIssue: issueFor(l.issues, 'amount') };
      if (l.category === 'reimbursement') additions.push(line);
      else deductions.push(line);
    }
    for (const l of slip.facts.etReimbursementLines) {
      additions.push({ source: payslipSource(slip, l.evidence), category: 'et_reimbursement', description: l.evidence.printedLabel ?? '', amount: l.amount, amountIssue: issueFor(l.issues, 'amount') });
    }
  }
  return { additions, deductions };
}

function surchargeLines(slips: PayslipDoc[]): Array<PercentLine & { category: string }> {
  return slips.flatMap((slip) =>
    slip.facts.hourLines
      .filter((l) => l.kind === 'irregular_surcharge' || l.kind === 'adv_compensation' || (l.kind === 'overtime' && l.addsHours === false))
      .map((l) => ({
        source: payslipSource(slip, l.evidence),
        // A non-hour-adding "overtime" line keeps its own key so it is never mistaken for, or merged
        // with, a genuine overtime observation.
        category: l.kind === 'overtime' ? 'overtime_surcharge' : l.kind,
        description: l.evidence.printedLabel ?? '',
        percent: l.percent,
        percentIssue: issueFor(l.issues, 'percent'),
        amount: l.amount,
        base: null,
        hours: l.hours,
      })),
  );
}

// ---------------------------------------------------------------------------------------------
// Contract / annex side - reuses resolveEffectiveContract unchanged
// ---------------------------------------------------------------------------------------------

type TimelineFieldKey = keyof EffectiveContract;

const TIMELINE_FACT_KEY: Partial<Record<TimelineFieldKey, ContractScalarKey>> = {
  contractType: 'contractType', employerName: 'employerName', functionTitle: 'functionTitle', startDate: 'startDate', endDate: 'endDate',
  hoursPerWeek: 'hoursPerWeek', hourlyRate: 'hourlyRate', monthlySalary: 'monthlySalary', caoName: 'caoName', pensionFund: 'pensionFund',
  overtimeTierThresholdHours: 'overtimeThresholdHours', guaranteedHours: 'guaranteedHours', guaranteedHoursPeriodWeeks: 'guaranteedHoursPeriodWeeks',
};

interface ContractDoc {
  doc: ProfileDocumentInput;
  facts: ContractDocumentFacts;
  extraction: ContractExtraction;
  annexDate: AnnexDateEvidence | null;
}

/** One contract document as placed in ONE timeline variant. */
interface ApplicableContract {
  doc: ProfileDocumentInput;
  facts: ContractDocumentFacts;
  /** Date this variant places it at (null for a base contract). */
  effectiveDate: string | null;
}

function contractSource(c: { doc: ProfileDocumentInput; effectiveDate: string | null }, evidence: FactEvidence | null): EvidenceSource {
  return {
    sourceType: 'document',
    role: c.doc.role === 'contract_annex' ? 'contract_annex' : 'contract_base',
    documentIndex: c.doc.index,
    documentLabel: c.doc.label,
    effectiveDate: c.doc.role === 'contract_annex' ? c.effectiveDate : null,
    payPeriod: null,
    printedLabel: evidence?.printedLabel ?? null,
    rawValue: evidence?.rawValue ?? null,
    page: evidence?.page ?? null,
    line: evidence?.line ?? null,
  };
}

function hasUsableDate(value: string | null): value is string {
  return value !== null && value !== '';
}

/**
 * P2.6: an annex's effective date has two possible sources - the user-entered date (unchanged UI
 * mechanism) and the date printed on the annex. Neither silently overwrites the other:
 *   both, equal -> agreed;  one only -> that one;  both, different -> disputed;  neither -> none.
 */
function annexDateEvidence(doc: ProfileDocumentInput, facts: ContractDocumentFacts): AnnexDateEvidence {
  const user = hasUsableDate(doc.effectiveDate) ? doc.effectiveDate : null;
  const printed = asText(singleExactValue(facts.scalars.effectiveDate));
  const evidenceFact = printed !== null ? firstExactFact(facts.scalars.effectiveDate) : null;
  const state: AnnexDateState = user && printed ? (user === printed ? 'agreed' : 'disputed') : user ? 'user_entered_only' : printed ? 'document_only' : 'none';
  return { index: doc.index, label: doc.label, userEnteredDate: user, documentDate: printed, documentEvidence: evidenceFact?.evidence ?? null, state };
}

/** Above this many disputed annexes, the extra ones are treated as undated (their fields excluded)
 * rather than enumerating every combination - a bound on a pure function, stated, not hidden. */
const MAX_DISPUTED_ANNEXES = 4;

interface TimelineVariant {
  /** Date per contract document position (null = base contract or undated annex). */
  dates: Array<string | null>;
  effective: EffectiveContract;
}

interface ContractSide {
  docs: ContractDoc[];
  variants: TimelineVariant[];
}

function timelineKey(position: number): string {
  return `#${position}`;
}

function buildContractSide(documents: ProfileDocumentInput[], asOfDate: string): ContractSide {
  const docs: ContractDoc[] = documents
    .filter((d) => (d.role === 'contract_base' || d.role === 'contract_annex') && d.facts.kind === 'contract')
    .map((d) => {
      const facts = d.facts as ContractDocumentFacts;
      return { doc: d, facts, extraction: contractExtractionFromFacts(facts), annexDate: d.role === 'contract_annex' ? annexDateEvidence(d, facts) : null };
    });
  if (docs.length === 0) return { docs, variants: [] };
  const disputed = docs.map((c, i) => (c.annexDate?.state === 'disputed' ? i : -1)).filter((i) => i >= 0);
  const enumerated = disputed.slice(0, MAX_DISPUTED_ANNEXES);
  const baseDates = docs.map((c, i) => {
    const a = c.annexDate;
    if (!a) return null;
    if (a.state === 'disputed' && !enumerated.includes(i)) return null; // beyond the bound: treated as undated
    return a.userEnteredDate ?? a.documentDate;
  });
  const variants: TimelineVariant[] = [];
  for (let mask = 0; mask < 1 << enumerated.length; mask += 1) {
    const dates = [...baseDates];
    enumerated.forEach((docPosition, bit) => {
      const a = docs[docPosition]?.annexDate;
      if (a) dates[docPosition] = mask & (1 << bit) ? a.documentDate : a.userEnteredDate;
    });
    const entries: ContractDocumentEntry[] = docs.map((c, position) => ({
      role: c.doc.role === 'contract_annex' ? 'annex' : 'base',
      effectiveDate: dates[position] ?? null,
      label: timelineKey(position),
      extraction: c.extraction,
    }));
    variants.push({ dates, effective: resolveEffectiveContract(entries, asOfDate) });
  }
  return { docs, variants };
}

function applicableContracts(side: ContractSide, variant: TimelineVariant, asOfDate: string): Array<ApplicableContract & { position: number }> {
  return side.docs
    .map((c, position) => ({ doc: c.doc, facts: c.facts, effectiveDate: variant.dates[position] ?? null, position }))
    .filter((c) => c.doc.role === 'contract_base' || (hasUsableDate(c.effectiveDate) && c.effectiveDate <= asOfDate));
}

interface ContractEvidence {
  candidates: ProfileCandidate[];
  excluded: ExcludedEvidence[];
  forcedConflict: ProfileReason | null;
}

/** Evidence for one timeline field in ONE variant. The timeline's own answer is never re-decided:
 * its winner's printed occurrences are the contract-side candidates; a `disagreement` becomes the
 * competing candidates; an `undated_document` becomes excluded evidence. On top (P2): documents in
 * force at or after the winner that state the field unclearly are shown as excluded evidence, and
 * one that contradicts itself contributes both values (a visible conflict). */
function variantEvidence(side: ContractSide, variant: TimelineVariant, field: TimelineFieldKey, factKey: ContractScalarKey, asOfDate: string): ContractEvidence {
  const result: ContractEvidence = { candidates: [], excluded: [], forcedConflict: null };
  const effective = variant.effective[field];
  const at = (position: number) => ({ doc: side.docs[position]!.doc, effectiveDate: variant.dates[position] ?? null });
  const occurrences = (position: number) => side.docs[position]?.facts.scalars[factKey] ?? [];
  const exactCandidates = (position: number) => factEvidence(occurrences(position).filter((f) => f.status === 'exact'), (f) => contractSource(at(position), f.evidence)).candidates;
  const used = new Set<number>();
  let winnerKey = '';
  if (effective.value !== null && effective.source) {
    const position = effective.source.documentIndex;
    result.candidates.push(...exactCandidates(position));
    used.add(position);
    winnerKey = side.docs[position]?.doc.role === 'contract_annex' ? (variant.dates[position] ?? '') : '';
  } else if (effective.reason?.code === 'disagreement') {
    for (const label of effective.reason.documentLabels) {
      const position = Number(label.slice(1));
      if (!Number.isInteger(position)) continue;
      result.candidates.push(...exactCandidates(position));
      used.add(position);
    }
    result.forcedConflict = { code: 'timeline_disagreement', asOfDate: effective.reason.asOfDate ?? asOfDate };
  } else if (effective.reason?.code === 'undated_document') {
    const position = Number(effective.reason.documentLabel.slice(1));
    if (Number.isInteger(position)) {
      for (const f of occurrences(position)) {
        const value = normalizeFactValue(f.value);
        if (f.status === 'exact' && value !== null) result.excluded.push({ value, source: contractSource(at(position), f.evidence), reason: 'annex_effective_date_missing', detail: null });
      }
      used.add(position);
    }
  }
  // An annex with no usable date at all cannot be placed (the timeline lets the rest decide); what it
  // states about this field is still shown, never silently dropped.
  side.docs.forEach((c, position) => {
    if (used.has(position) || c.doc.role !== 'contract_annex' || hasUsableDate(variant.dates[position] ?? null)) return;
    for (const f of occurrences(position)) {
      const value = normalizeFactValue(f.value);
      if (f.status === 'exact' && value !== null) result.excluded.push({ value, source: contractSource(at(position), f.evidence), reason: 'annex_effective_date_missing', detail: null });
    }
    used.add(position);
  });
  for (const c of applicableContracts(side, variant, asOfDate)) {
    if (used.has(c.position)) continue;
    const key = c.doc.role === 'contract_annex' ? (c.effectiveDate ?? '') : '';
    if (key < winnerKey) continue; // superseded by the winner - nothing it says about this field applies
    const ev = factEvidence(occurrences(c.position).filter((f) => f.status !== 'exact'), (f) => contractSource(c, f.evidence));
    result.candidates.push(...ev.candidates);
    result.excluded.push(...ev.excluded);
  }
  return result;
}

function candidateSignature(ev: ContractEvidence): string {
  const values = ev.candidates.map((c) => JSON.stringify(c.value)).sort();
  return JSON.stringify([[...new Set(values)], ev.forcedConflict?.code ?? null]);
}

/** P2.6: with a disputed annex date the timeline is resolved under each date; a field whose outcome
 * does not depend on the date resolves normally; one that does is a conflict naming both outcomes. */
function contractFieldEvidence(side: ContractSide, field: TimelineFieldKey, asOfDate: string): ContractEvidence {
  const factKey = TIMELINE_FACT_KEY[field];
  if (!factKey || side.variants.length === 0) return { candidates: [], excluded: [], forcedConflict: null };
  const perVariant = side.variants.map((v) => variantEvidence(side, v, field, factKey, asOfDate));
  const first = perVariant[0] as ContractEvidence;
  if (perVariant.every((ev) => candidateSignature(ev) === candidateSignature(first))) return first;
  const seen = new Set<string>();
  const candidates: ProfileCandidate[] = [];
  const excluded: ExcludedEvidence[] = [];
  for (const ev of perVariant) {
    for (const c of ev.candidates) {
      const sig = JSON.stringify([c.source.documentIndex, c.source.page, c.source.effectiveDate, c.value]);
      if (!seen.has(sig)) { seen.add(sig); candidates.push(c); }
    }
    excluded.push(...ev.excluded);
  }
  return { candidates, excluded, forcedConflict: { code: 'annex_effective_date_disputed' } };
}

function contractEmptyReason(side: ContractSide): UnknownReasonCode {
  return side.docs.length === 0 ? 'no_contract_document' : 'not_in_contract_extraction';
}

function contractOnlyField(spec: FieldSpec, side: ContractSide, field: TimelineFieldKey, asOfDate: string): ProfileField {
  const ev = contractFieldEvidence(side, field, asOfDate);
  return resolveField(spec, ev.candidates, ev.excluded, contractEmptyReason(side), ev.forcedConflict);
}

/** Contract documents applicable in ANY timeline variant (base contracts, annexes in force under at
 * least one of their possible dates) - used for facts outside the timeline's field set (premiums,
 * CAO phase, hirer), where every applicable document's statement is a candidate. */
function anyVariantApplicable(side: ContractSide, asOfDate: string): ApplicableContract[] {
  const out = new Map<number, ApplicableContract>();
  for (const v of side.variants) {
    for (const c of applicableContracts(side, v, asOfDate)) if (!out.has(c.position)) out.set(c.position, { doc: c.doc, facts: c.facts, effectiveDate: c.effectiveDate });
  }
  return [...out.values()];
}

function applicableScalarField(spec: FieldSpec, contracts: ApplicableContract[], key: ContractScalarKey, side: ContractSide): ProfileField {
  const candidates: ProfileCandidate[] = [];
  const excluded: ExcludedEvidence[] = [];
  for (const c of contracts) {
    const ev = factEvidence(c.facts.scalars[key], (f) => contractSource(c, f.evidence));
    candidates.push(...ev.candidates);
    excluded.push(...ev.excluded);
  }
  return resolveField(spec, candidates, excluded, contractEmptyReason(side));
}

/** A printed premium's value in engine terms - only when its own wording fixes the semantics. */
function premiumValue(p: PremiumFact, source: EvidenceSource): { candidate: ProfileCandidate } | { excluded: ExcludedEvidence } {
  const d = detail({ printedPercent: p.percent });
  if (p.status === 'ambiguous') return { excluded: { value: null, source, reason: 'ambiguous_on_document', detail: d, ...(p.reason ? { factReason: p.reason } : {}) } };
  if (p.status !== 'exact' || !isFiniteNumber(p.percent)) return { excluded: { value: null, source, reason: 'implausible_value', detail: d, ...(p.reason ? { factReason: p.reason } : {}) } };
  if (p.semantics === 'unclear') return { excluded: { value: p.percent, source, reason: 'percent_semantics_ambiguous', detail: d } };
  const premium = p.semantics === 'total_multiplier' ? p.percent - 100 : p.percent;
  return { candidate: { value: round2(premium), source, detail: d } };
}

function weekdayPremiumField(spec: FieldSpec, contracts: ApplicableContract[], category: 'saturday' | 'sunday' | 'public_holiday'): ProfileField {
  const candidates: ProfileCandidate[] = [];
  const excluded: ExcludedEvidence[] = [];
  for (const c of contracts) {
    for (const p of c.facts.premiums.filter((x) => x.category === category)) {
      const outcome = premiumValue(p, contractSource(c, p.evidence));
      if ('excluded' in outcome) excluded.push(outcome.excluded);
      else candidates.push(outcome.candidate);
    }
  }
  return resolveField(spec, candidates, excluded, 'no_weekday_evidence');
}

function docRef(doc: ProfileDocumentInput, side: ContractSide): ProfileDocumentRef {
  let effectiveDate: string | null = null;
  if (doc.role === 'contract_annex') {
    const a = side.docs.find((c) => c.doc.index === doc.index)?.annexDate;
    effectiveDate = a && a.state !== 'disputed' ? (a.userEnteredDate ?? a.documentDate) : null;
  }
  return {
    index: doc.index,
    label: doc.label,
    role: doc.role,
    effectiveDate,
    payPeriod: doc.facts.kind === 'payslip' ? payPeriodOfFacts(doc.facts) : null,
  };
}

function buildContractContext(side: ContractSide, asOfDate: string): ContractContext {
  const base = side.docs.filter((c) => c.doc.role === 'contract_base');
  const annexes = side.docs.filter((c) => c.doc.role === 'contract_annex');
  const ref = (c: ContractDoc) => docRef(c.doc, side);
  const date = (c: ContractDoc) => {
    const a = c.annexDate;
    return a && a.state !== 'disputed' ? (a.userEnteredDate ?? a.documentDate) : null;
  };
  return {
    asOfDate,
    baseContracts: base.map(ref),
    annexesInForce: annexes.filter((c) => { const d = date(c); return d !== null && d <= asOfDate; }).map(ref),
    annexesNotYetInForce: annexes.filter((c) => { const d = date(c); return d !== null && d > asOfDate; }).map(ref),
    annexesUndated: annexes.filter((c) => c.annexDate?.state === 'none').map(ref),
    annexesDateDisputed: annexes.filter((c) => c.annexDate?.state === 'disputed').map(ref),
    annexDates: annexes.map((c) => c.annexDate as AnnexDateEvidence),
  };
}

// ---------------------------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------------------------

export function resolvePayrollProfile(input: ResolvePayrollProfileInput): PayrollProfile {
  const { asOfDate, documents } = input;
  const side = buildContractSide(documents, asOfDate);
  const slips = payslipDocs(documents);
  const slipReason = payslipEmptyReason(slips);
  const applicable = anyVariantApplicable(side, asOfDate);

  // --- employment ---------------------------------------------------------------------------
  const rateContract = contractFieldEvidence(side, 'hourlyRate', asOfDate);
  const rateSlips = regularRateEvidence(slips);
  const hourlyRate = resolveField(
    F('hourlyRate', 'gross_base_hourly_wage', 'eur_per_hour'),
    [...rateContract.candidates, ...rateSlips.candidates],
    [...rateContract.excluded, ...rateSlips.excluded],
    documents.length === 0 ? 'no_documents' : 'not_on_documents',
    rateContract.forcedConflict,
  );

  // P2.3: a contract-hours-per-week figure printed on a payslip is evidence for the same parameter.
  const hpwContract = contractFieldEvidence(side, 'hoursPerWeek', asOfDate);
  const hpwSlips = payslipScalarEvidence(slips, 'hoursPerWeek');
  const hoursPerWeek = resolveField(
    F('hoursPerWeek', 'contract_hours_per_week', 'hours_per_week'),
    [...hpwContract.candidates, ...hpwSlips.candidates],
    [...hpwContract.excluded, ...hpwSlips.excluded],
    documents.length === 0 ? 'no_documents' : 'not_on_documents',
    hpwContract.forcedConflict,
  );

  const payslipEmployerCandidates: ProfileCandidate[] = [];
  const payslipEmployerExcluded: ExcludedEvidence[] = [];
  for (const slip of slips) {
    const exact = slip.facts.employerNames.filter((f) => f.status === 'exact' && typeof f.value === 'string');
    const distinct = new Set(exact.map((f) => (f.value as string).trim()));
    const ev = factEvidence(slip.facts.employerNames, (f) => payslipSource(slip, f.evidence));
    if (distinct.size > 1) {
      for (const c of ev.candidates) payslipEmployerExcluded.push({ value: c.value, source: c.source, reason: 'multiple_employers_on_payslip', detail: null });
    } else payslipEmployerCandidates.push(...ev.candidates);
    payslipEmployerExcluded.push(...ev.excluded);
  }
  const hirer = payslipScalarEvidence(slips, 'hirerName');

  const employment: Record<EmploymentFieldKey, ProfileField> = {
    // Employer/hirer as named by contracts and as named by payslips stay separate fields: name
    // variants ("X Nederland B.V." vs "X Services") would otherwise become conflicts on non-calculation
    // fields, and there is no approved rule for name equivalence.
    employerName: contractOnlyField(F('employerName', 'employer_or_agency_name_contract', 'text'), side, 'employerName', asOfDate),
    payslipEmployerName: resolveField(F('payslipEmployerName', 'employer_name_payslip', 'text'), payslipEmployerCandidates, payslipEmployerExcluded, slipReason),
    hirerName: resolveField(F('hirerName', 'hirer_name_payslip', 'text'), hirer.candidates, hirer.excluded, slipReason),
    contractHirerName: applicableScalarField(F('contractHirerName', 'hirer_name_contract', 'text'), applicable, 'hirerName', side),
    hourlyRate,
    hoursPerWeek,
    guaranteedHours: contractOnlyField(F('guaranteedHours', 'guaranteed_hours_per_guarantee_period', 'hours'), side, 'guaranteedHours', asOfDate),
    guaranteedHoursPeriodWeeks: contractOnlyField(F('guaranteedHoursPeriodWeeks', 'guarantee_period_length', 'weeks'), side, 'guaranteedHoursPeriodWeeks', asOfDate),
    overtimeThresholdHours: contractOnlyField(F('overtimeThresholdHours', 'daily_overtime_hours_before_tier_2', 'hours'), side, 'overtimeTierThresholdHours', asOfDate),
    caoName: contractOnlyField(F('caoName', 'cao_name', 'text'), side, 'caoName', asOfDate),
    phase: applicableScalarField(F('phase', 'cao_phase', 'text'), applicable, 'caoPhase', side),
    contractType: contractOnlyField(F('contractType', 'contract_type', 'text'), side, 'contractType', asOfDate),
    functionTitle: contractOnlyField(F('functionTitle', 'function_title', 'text'), side, 'functionTitle', asOfDate),
    contractStartDate: contractOnlyField(F('contractStartDate', 'contract_start_date', 'date'), side, 'startDate', asOfDate),
    contractEndDate: contractOnlyField(F('contractEndDate', 'contract_end_date', 'date'), side, 'endDate', asOfDate),
    monthlySalary: contractOnlyField(F('monthlySalary', 'gross_monthly_salary', 'eur_per_month'), side, 'monthlySalary', asOfDate),
    pensionFundName: contractOnlyField(F('pensionFundName', 'pension_fund_name', 'text'), side, 'pensionFund', asOfDate),
  };

  // --- payroll ------------------------------------------------------------------------------
  const period = payslipScalarEvidence(slips, 'periodType');
  const ot = overtimeEvidence(slips, applicable);
  const anyOvertime = ot.observed.length > 0 || ot.excluded.length > 0;
  const tierReason: UnknownReasonCode = anyOvertime ? 'tier_identity_not_evidenced' : slips.length === 0 && side.docs.length === 0 ? 'no_documents' : 'not_on_documents';

  const vakantiegeldExcluded: ExcludedEvidence[] = slips.flatMap((slip) =>
    slip.facts.reservationLines
      .filter((r) => r.type === 'vakantiegeld')
      .map((r) => {
        const issue = issueFor(r.issues, 'accrued');
        return {
          value: null,
          source: payslipSource(slip, r.evidence),
          reason: issue ? ('amount_unreadable' as const) : ('not_a_forward_rate' as const),
          detail: detail({ amount: r.accrued }),
          ...(issue ? { factReason: issue.reason } : {}),
        };
      }),
  );

  const bt = payslipScalarEvidence(slips, 'bijzonderTariefPercent');
  const jaarloon = payslipScalarEvidence(slips, 'jaarloonBt');
  const et = payslipScalarEvidence(slips, 'etExchangeAmount');

  const percentField = (key: string, meaning: string, lines: PercentLine[]): ProfileField => {
    const ev = percentLineEvidence(lines);
    return resolveField(F(key, meaning, 'percent_of_printed_base'), ev.candidates, ev.excluded, slipReason);
  };

  const payroll: Record<PayrollFieldKey, ProfileField> = {
    periodType: resolveField(F('periodType', 'pay_period_type', 'period_type'), period.candidates, period.excluded, slipReason),
    // Tier fields are filled ONLY from sources that explicitly identify the tier (P1.1 rule, P2 schema).
    overtimeTier1Premium: resolveField(F('overtimeTier1Premium', 'overtime_tier_1_premium_above_base', 'premium_percent'), ot.tier1, [], tierReason),
    overtimeTier2Premium: resolveField(F('overtimeTier2Premium', 'overtime_tier_2_premium_above_base', 'premium_percent'), ot.tier2, [], tierReason),
    // Weekday/holiday premiums only from a printed premium whose own text names that day (P2.5).
    saturdayPremium: weekdayPremiumField(F('saturdayPremium', 'saturday_premium_above_base', 'premium_percent'), applicable, 'saturday'),
    sundayPremium: weekdayPremiumField(F('sundayPremium', 'sunday_premium_above_base', 'premium_percent'), applicable, 'sunday'),
    publicHolidayPremium: weekdayPremiumField(F('publicHolidayPremium', 'public_holiday_premium_above_base', 'premium_percent'), applicable, 'public_holiday'),
    loonheffingskorting: unknownField(F('loonheffingskorting', 'loonheffingskorting_applied', 'boolean'), 'no_evidence_source'),
    pensionEmployeePercent: percentField('pensionEmployeePercent', 'pension_employee_contribution', deductionLines(slips, 'pre_tax', 'pension')),
    pawwEmployeePercent: percentField('pawwEmployeePercent', 'paww_employee_contribution', deductionLines(slips, 'pre_tax', 'paww')),
    sectorPremiumPercent: percentField('sectorPremiumPercent', 'sector_premium_ziektewet_azw_employee', deductionLines(slips, 'pre_tax', 'ziektewet')),
    wgaGatEmployeePercent: percentField('wgaGatEmployeePercent', 'wga_gat_employee_contribution', deductionLines(slips, 'pre_tax', 'wga_gat')),
    wgaEmployeePercent: percentField('wgaEmployeePercent', 'wga_employee_contribution_post_tax', deductionLines(slips, 'post_tax', 'wga')),
    gediffWgaEmployeePercent: percentField('gediffWgaEmployeePercent', 'gediff_wga_employee_contribution_post_tax', deductionLines(slips, 'post_tax', 'gediff_wga')),
    whkEmployeePercent: percentField('whkEmployeePercent', 'whk_employee_contribution_post_tax', deductionLines(slips, 'post_tax', 'whk')),
    vakantiegeldAccrualPercent: unknownField(F('vakantiegeldAccrualPercent', 'vakantiegeld_accrual_rate', 'percent'), slipReason, vakantiegeldExcluded),
    bijzonderTariefPrintedPercent: resolveField(F('bijzonderTariefPrintedPercent', 'bijzonder_tarief_rate_as_printed', 'percent'), bt.candidates, bt.excluded, slipReason),
    jaarloonBt: resolveField(F('jaarloonBt', 'jaarloon_used_for_bijzonder_tarief', 'eur_per_year'), jaarloon.candidates, jaarloon.excluded, slipReason),
    etExchangeAmount: resolveField(F('etExchangeAmount', 'et_taxable_base_reduction_per_period', 'eur_per_period'), et.candidates, et.excluded, slipReason),
  };

  // --- recurring items ------------------------------------------------------------------------
  const net = netLineEvidence(slips);
  const contractIrregular = applicable.flatMap((c) =>
    c.facts.premiums
      .filter((p) => p.category === 'irregular_hours')
      .map((p) => {
        const outcome = premiumValue(p, contractSource(c, p.evidence));
        return { category: 'contract_irregular_hours', description: p.evidence.printedLabel ?? p.condition ?? '', ...('excluded' in outcome ? { excluded: outcome.excluded } : { candidate: outcome.candidate }) };
      }),
  );
  const recurringItems: RecurringItems = {
    surcharges: groupedPercentFields('surcharge', 'surcharge_on_hours_already_counted', 'surcharge_percent', surchargeLines(slips), contractIrregular),
    otherPreTaxDeductions: groupedPercentFields('pre_tax', 'other_pre_tax_deduction_rate', 'percent_of_printed_base', deductionLines(slips, 'pre_tax', 'other')),
    otherPostTaxDeductions: groupedPercentFields('post_tax', 'other_post_tax_deduction_rate', 'percent_of_printed_base', deductionLines(slips, 'post_tax', 'other')),
    netAdditions: groupedAmountFields('net_addition', 'recurring_net_addition', net.additions),
    netDeductions: groupedAmountFields('net_deduction', 'recurring_net_deduction', net.deductions),
  };

  // --- calibration only ---------------------------------------------------------------------
  const printed = (slip: PayslipDoc, key: PayslipScalarKey): number | null => {
    const v = singleExactValue(slip.facts.scalars[key]);
    return typeof v === 'number' ? v : null;
  };
  const calibrationOnly = {
    payslips: slips.map((slip) => ({
      source: payslipSource(slip, null),
      printed: {
        table_tax: printed(slip, 'printedTableTax'),
        bt_tax: printed(slip, 'printedBtTax'),
        algemene_heffingskorting: printed(slip, 'printedAlgemeneHeffingskorting'),
        arbeidskorting: printed(slip, 'printedArbeidskorting'),
        gross_total: printed(slip, 'printedGrossTotal'),
        loon_voor_heffingen: printed(slip, 'printedLoonVoorHeffingen'),
        net: printed(slip, 'printedNet'),
        payout: printed(slip, 'printedPayout'),
        minimum_wage: printed(slip, 'minimumWagePrinted'),
      },
    })),
  };

  return {
    version: 1,
    asOfDate,
    documents: documents.map((d) => docRef(d, side)),
    contractContext: buildContractContext(side, asOfDate),
    employment,
    payroll,
    recurringItems,
    observedOvertimePremiums: { fields: observedOvertimeFields(ot.observed), excluded: ot.excluded },
    calibrationOnly,
  };
}
