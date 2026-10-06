/**
 * P1 (ZADANIE-P1-LOONTO-PRO.md §P1.5): PRO's calculator prefill now comes from the backend-owned
 * Payroll Profile (`POST /api/profile/resolve`, apps/backend-node/src/payroll-engine/payroll-profile.ts).
 *
 * This file RESOLVES NOTHING (owner decision 4: one resolver, in the backend). It only reads each
 * field's own `state` and `value` as the backend returned them, and copies a value into the prefill
 * when - and only when - that state is a usable evidence state. A `conflict` or `unknown` field leaves
 * the calculator input empty: no candidate is picked here and no Basic default is filled in.
 *
 * Types below mirror the backend response shape (there is no shared-types package between the two
 * projects - the same reason tier-c-shared.ts mirrors the Tier C types). Only what the frontend reads.
 */

export type EvidenceState = 'document_exact' | 'corroborated' | 'user_confirmed' | 'user_corrected' | 'conflict' | 'unknown';

/** Mirrors the backend's USABLE_EVIDENCE_STATES exactly. */
export const USABLE_EVIDENCE_STATES: readonly EvidenceState[] = ['document_exact', 'corroborated', 'user_confirmed', 'user_corrected'];

export interface ProfileSourceView {
  sourceType: 'document' | 'rules' | 'user';
  role: 'contract_base' | 'contract_annex' | 'payslip' | 'rules' | 'user';
  documentIndex: number | null;
  /** P3: the opaque per-upload identity the request carried (DocEntry.id), or null. */
  documentId?: string | null;
  documentLabel: string | null;
  effectiveDate: string | null;
  payPeriod: { label: string | null; endDate: string | null; periodType: string | null } | null;
  printedLabel: string | null;
  page: number | null;
  line: number | null;
  /** P2: the printed text fragment the value was read from. */
  rawValue?: string | null;
  /** P3.1 S3: on a `user` source only - the decision it records. */
  decisionId?: string | null;
}

export type ProfileValueView = number | string | number[] | boolean;

export interface ProfileFieldView {
  key: string;
  meaning: string;
  unit: string;
  value: ProfileValueView | null;
  state: EvidenceState;
  sources: ProfileSourceView[];
  candidates: Array<{ value: ProfileValueView; source: ProfileSourceView }>;
  excluded: Array<{ value: ProfileValueView | null; source: ProfileSourceView; reason: string; factReason?: string; regime?: RegimeMarkerView }>;
  /** P3: `changeDate` (payslip_period_unplaceable) and the document members (later_document_unclear). */
  reason: { code: string; asOfDate?: string; changeDate?: string; documentIndex?: number; documentId?: string | null; effectiveDate?: string | null } | null;
  /** P3: a contract-timeline field's in-force regime; null/absent for every other field. */
  regime?: { start: string | null; end: string | null; winnerDocumentIndex: number | null; winnerDocumentId: string | null; winnerDocumentLabel: string | null } | null;
  /** P3.1 S3: the user decision applied to this field (null/absent on a documentary field). */
  resolution?: UserResolutionView | null;
}

/** P3.1 S3: what a user decision did to a field, and the documentary result it replaced. */
export interface UserResolutionView {
  decisionId: string;
  kind: 'confirm_candidate' | 'correct_value';
  decidedAt: string;
  evidenceFingerprint: string;
  previous: { state: EvidenceState; value: ProfileValueView | null; reason: ProfileFieldView['reason'] };
}

/** P3.1 S3: a field-level user decision as sent to `POST /api/profile/resolve` (backend
 * profile-decisions.ts). `evidenceFingerprint` is the documentary fingerprint the decision was made
 * under; the backend re-checks it on every resolve. */
export type ProfileDecisionView =
  | { kind: 'confirm_candidate'; decisionId: string; fieldPath: string; value: ProfileValueView; evidenceFingerprint: string; decidedAt: string }
  | { kind: 'correct_value'; decisionId: string; fieldPath: string; value: ProfileValueView; unit: string; evidenceFingerprint: string; decidedAt: string };

/** P3.1 S3: one result per submitted decision, in request order. */
export interface DecisionResultView {
  decisionId: string;
  fieldPath: string;
  status: 'applied' | 'satisfied_by_documents' | 'stale' | 'rejected';
  problem: 'field_not_found' | 'evidence_changed' | 'candidate_not_present' | 'invalid_value' | 'unit_mismatch' | 'duplicate_field_decision' | null;
}

/** P3.1 S4: the requirement groups (backend profile-readiness.ts), in the backend's canonical order. */
export const REQUIREMENT_GROUP_IDS_VIEW = [
  'core_pay', 'overtime', 'saturday', 'sunday', 'public_holiday', 'surcharges', 'employee_deductions', 'net_items', 'tax_settings',
] as const;
export type RequirementGroupIdView = (typeof REQUIREMENT_GROUP_IDS_VIEW)[number];

/** P3.1 S4: which requirement groups the calculation needs. Omit it and the backend uses `['core_pay']`. */
export interface RequirementsView {
  groups: RequirementGroupIdView[];
}

export type IssueSeverityView = 'blocking' | 'optional' | 'informational';

/** P3.1 S4: one unresolved field (conflict / unknown) with everything a question needs - the later UI
 * renders it; nothing here decides anything. `impact` is reserved for P4 and always null. */
export interface ProfileIssueView {
  fieldPath: string;
  key: string;
  meaning: string;
  unit: string;
  state: 'conflict' | 'unknown';
  reason: NonNullable<ProfileFieldView['reason']>;
  severity: IssueSeverityView;
  groups: RequirementGroupIdView[];
  candidates: Array<{ candidateId: string; value: ProfileValueView; sources: ProfileSourceView[]; basis: 'contractual' | 'employer_applied' }>;
  hints: Array<{ value: ProfileValueView; sources: ProfileSourceView[]; kind: 'observed_premium' | 'superseded_value' | 'unplaceable_matching_value' | 'excluded_value' }>;
  excluded: ProfileFieldView['excluded'];
  actions: Array<'select_candidate' | 'enter_value' | 'leave_unresolved'>;
  input: { kind: 'number' | 'text' | 'date' | 'boolean' | 'enum'; min?: number; max?: number; step?: number; enumValues?: string[] };
  /** The documentary fingerprint to submit back with a decision on this field. */
  evidenceFingerprint: string;
  previousDecision: { kind: 'confirm_candidate' | 'correct_value'; value: ProfileValueView } | null;
  impact: null;
}

export interface CalculationReadinessView {
  activeGroups: RequirementGroupIdView[];
  ready: boolean;
  blockingCount: number;
  optionalCount: number;
}

/** P3: the regime boundary an excluded piece of evidence was placed against. */
export interface RegimeMarkerView {
  relation: 'superseded_by' | 'later_than_as_of' | 'straddles' | 'value_matches_current_but_period_unknown';
  documentIndex: number;
  documentId: string | null;
  documentLabel: string;
  role: 'contract_base' | 'contract_annex';
  effectiveDate: string;
}

export interface PayrollProfileView {
  /** 2 since P3.1 S2 (regime-aware evidence, documentId). */
  version: 2;
  asOfDate: string;
  employment: Record<string, ProfileFieldView>;
  payroll: Record<string, ProfileFieldView>;
  recurringItems: Record<string, ProfileFieldView[]>;
  /** P1.1: overtime premiums seen on payslips, tier position unknown - shown, never prefilled. */
  observedOvertimePremiums: { fields: ProfileFieldView[]; excluded: ProfileFieldView['excluded'] };
  /** P2: annex effective dates - the user-entered and the printed one side by side. */
  contractContext: { annexDates: Array<{ index: number; label: string; userEnteredDate: string | null; documentDate: string | null; state: string }> };
}

/** P2 (§P2.14): one row of the developer extraction table, exactly as the backend built it. */
export interface ExtractionRowView {
  documentIndex: number;
  documentLabel: string;
  role: string;
  key: string;
  value: string | number | null;
  rawValue: string | null;
  page: number | null;
  printedLabel: string | null;
  status: string;
  reason: string | null;
  destination: string;
}

export interface ResolvedProfileView {
  profile: PayrollProfileView;
  extractionTable: ExtractionRowView[];
  /** P3.1 S3: one per submitted decision, request order (empty when none were sent). */
  decisionResults: DecisionResultView[];
  /** P3.1 S4: one per unresolved field, blocking first (empty when there are none). */
  issues: ProfileIssueView[];
  /** P3.1 S4: null only when the backend sent none - a readiness is never made up here. */
  readiness: CalculationReadinessView | null;
}

export function isUsableField(field: ProfileFieldView | undefined): field is ProfileFieldView & { value: ProfileValueView } {
  return !!field && USABLE_EVIDENCE_STATES.includes(field.state) && field.value !== null;
}

/** A usable numeric value, or undefined - undefined is what the calculator renders as an empty input. */
export function usableNumber(field: ProfileFieldView | undefined): number | undefined {
  return isUsableField(field) && typeof field.value === 'number' ? field.value : undefined;
}

/** The distinct document labels behind a field, in source order - what a badge names. */
export function sourceDocumentLabels(field: ProfileFieldView): string[] {
  return Array.from(new Set(field.sources.map((s) => s.documentLabel).filter((l): l is string => typeof l === 'string' && l !== '')));
}

/** Structurally identical to TierACalculator.tsx's `TierAContractPrefill` for the fields PRO sources
 * (kept separate so this file stays importable by the plain `node --test` runner, which cannot load
 * a .tsx module). */
export interface ProfilePrefill {
  hourly_rate?: number;
  hours_per_week?: number;
  overtime_tier_threshold_hours?: number;
  overtime_tier_1_percent?: number;
  overtime_tier_2_percent?: number;
  sourceLabels: Partial<Record<'hourlyRate' | 'hoursPerWeek' | 'threshold' | 'tier1Percent' | 'tier2Percent', string>>;
}

/**
 * P1.5's required prefill fields, each taken from exactly one profile field. Saturday/Sunday/holiday
 * percentages are deliberately not mapped: the profile reports them `unknown` (P5), and an unknown
 * must stay an empty input.
 *
 * P1.1: the two overtime tier inputs come ONLY from `overtimeTier1Premium`/`overtimeTier2Premium`,
 * which the backend fills only from a source that explicitly identifies the tier (none exists in P1,
 * so they stay empty). `observedOvertimePremiums` is never read here - an observed premium does not
 * say which tier it is, and choosing one would be exactly the inference P1.1 removed.
 */
export function profilePrefill(profile: PayrollProfileView, badge: (field: ProfileFieldView) => string): ProfilePrefill {
  const pairs = [
    ['hourly_rate', 'hourlyRate', profile.employment.hourlyRate],
    ['hours_per_week', 'hoursPerWeek', profile.employment.hoursPerWeek],
    ['overtime_tier_threshold_hours', 'threshold', profile.employment.overtimeThresholdHours],
    ['overtime_tier_1_percent', 'tier1Percent', profile.payroll.overtimeTier1Premium],
    ['overtime_tier_2_percent', 'tier2Percent', profile.payroll.overtimeTier2Premium],
  ] as const;
  const prefill: ProfilePrefill = { sourceLabels: {} };
  for (const [prefillKey, labelKey, field] of pairs) {
    const value = usableNumber(field);
    if (value === undefined || !field) continue;
    prefill[prefillKey] = value;
    prefill.sourceLabels[labelKey] = badge(field);
  }
  return prefill;
}

/**
 * P1.1 (Cursor F10): one document as sent to `POST /api/profile/resolve`. The client keeps the last
 * submitted list of these - facts that were ALREADY read - so the profile can be re-resolved for a new
 * as-of date without re-reading any document (no Gemini call). Extraction/period payloads are opaque
 * here; the backend validates them.
 */
export interface ProfileRequestDocument {
  index: number;
  /** P3: the document's per-upload `DocEntry.id` - opaque identity, never interpreted. */
  documentId?: string;
  label: string;
  role: 'contract_base' | 'contract_annex' | 'payslip';
  /** User-entered annex effective date (null for anything else). */
  effectiveDate: string | null;
  /** P2: the document-fact batches /api/pro/*-facts returned for this document (all its pages). */
  factBatches: unknown[];
}

/** Only a complete ISO date is a meaningful as-of date - a cleared or half-typed date input is not. */
export function isResolvableAsOfDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * The one call that turns already-read document facts into a profile - used both after a submit and
 * when the as-of date changes. It calls exactly one endpoint, the pure profile resolver; it never
 * touches a document-reading endpoint. `null` on any failure (the caller shows an error, never the
 * previous profile under the new date).
 *
 * P3.1 S3: optional field-level `decisions` are sent with the documents (the backend is stateless - the
 * client re-sends them on every resolve); without decisions the request body is exactly as before. The
 * returned profile is the one with the decisions overlaid, plus one `decisionResults` entry per decision.
 *
 * P3.1 S4: optional `requirements` name the active requirement groups. Without them the request body is
 * exactly as before and the backend applies its default (`core_pay`). The response also carries `issues`
 * and `readiness`. Nothing here renders or decides them.
 */
export async function resolveProfile(asOfDate: string, documents: ProfileRequestDocument[], fetchImpl: typeof fetch = fetch, decisions: ProfileDecisionView[] = [], requirements?: RequirementsView): Promise<ResolvedProfileView | null> {
  try {
    const res = await fetchImpl('/api/profile/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asOfDate, documents, ...(decisions.length > 0 ? { decisions } : {}), ...(requirements ? { requirements } : {}) }),
    });
    const data = await res.json() as { profile?: PayrollProfileView; extractionTable?: ExtractionRowView[]; decisionResults?: DecisionResultView[]; issues?: ProfileIssueView[]; readiness?: CalculationReadinessView };
    return res.ok && data.profile
      ? { profile: data.profile, extractionTable: data.extractionTable ?? [], decisionResults: data.decisionResults ?? [], issues: data.issues ?? [], readiness: data.readiness ?? null }
      : null;
  } catch {
    return null;
  }
}
