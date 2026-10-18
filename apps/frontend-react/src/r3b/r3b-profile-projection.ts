import { USABLE_EVIDENCE_STATES, type EvidenceState, type ProfileFieldView, type ProfileIssueView, type ProfileSourceView, type ProfileValueView, type ResolvedProfileView } from '../pro-profile-prefill.ts';

/**
 * R3-B: a typed, read-only projection of the backend Payroll Profile - the ONLY place the interface learns what the
 * documents say. Nothing here resolves, ranks or merges evidence: every state, value, candidate and source is the
 * backend's own (`/api/profile/resolve`). The projection only selects what matters for a normal weekly pay
 * calculation and says which questions a usable reading lets the conversation skip.
 *
 * Trust boundary (Contract v1.1 §4.1): a document reading is shown as "read from the document - needs verification".
 * It never enters the R2 Scenario (no `source: document` is ever sent - the public turn route would reject it, and
 * the browser cannot prove it); it only defers the matching question, so the evaluation stays blocked and no amount
 * can appear. A user's own choice between candidates is the profile's `user_confirmed` state, kept apart.
 */

/** Profile fields that feed a Scenario field - the same pairs the backend declares as `consumed` in
 * scenario-profile-gaps.ts (r3b-document-first.test.ts checks this table against it). */
export const DOCUMENT_FIELD_TO_SCENARIO = {
  'employment.hourlyRate': 'pay.hourlyRate',
  'payroll.saturdayPremium': 'pay.saturdayPremiumPercent',
  'payroll.sundayPremium': 'pay.sundayPremiumPercent',
  'payroll.publicHolidayPremium': 'pay.publicHolidayPremiumPercent',
  'payroll.overtimeTier1Premium': 'pay.overtime.tier1Percent',
  'payroll.overtimeTier2Premium': 'pay.overtime.tier2Percent',
  'employment.overtimeThresholdHours': 'pay.overtime.thresholdHoursPerDay',
} as const;
export type DocumentFieldPath = keyof typeof DOCUMENT_FIELD_TO_SCENARIO;

/** The unit a reading must carry to stand for its Scenario field (a premium only when normalised above base). */
const SCENARIO_UNIT: Record<DocumentFieldPath, string> = {
  'employment.hourlyRate': 'eur_per_hour',
  'payroll.saturdayPremium': 'premium_percent',
  'payroll.sundayPremium': 'premium_percent',
  'payroll.publicHolidayPremium': 'premium_percent',
  'payroll.overtimeTier1Premium': 'premium_percent',
  'payroll.overtimeTier2Premium': 'premium_percent',
  'employment.overtimeThresholdHours': 'hours',
};

/** Shown in the short summary only - informative, never a reason to skip a question about THIS week. */
const CONTEXT_FIELDS = ['payroll.periodType', 'employment.hoursPerWeek'] as const;

export const SUMMARY_FIELDS = ['employment.hourlyRate', ...CONTEXT_FIELDS, 'payroll.saturdayPremium', 'payroll.sundayPremium', 'payroll.publicHolidayPremium', 'payroll.overtimeTier1Premium', 'payroll.overtimeTier2Premium', 'employment.overtimeThresholdHours'] as const;
export type SummaryFieldPath = (typeof SUMMARY_FIELDS)[number];

/** How the interface labels a value (Contract v1.1 §4.1): a reading is not a legal finding; a choice is the user's. */
export type FactStatus = 'document_reading' | 'documents_agree' | 'user_confirmed' | 'user_corrected' | 'conflict' | 'unknown';

const STATUS_OF: Record<EvidenceState, FactStatus> = {
  document_exact: 'document_reading', corroborated: 'documents_agree', user_confirmed: 'user_confirmed', user_corrected: 'user_corrected', conflict: 'conflict', unknown: 'unknown',
};

export interface FactSource {
  role: ProfileSourceView['role'];
  documentId: string | null;
  /** Printed pay period (payslips) - only what the document printed. */
  period: { label: string | null; start: string | null; end: string | null; periodType: string | null } | null;
  /** Annex effective date. */
  effectiveDate: string | null;
  page: number | null;
  printedLabel: string | null;
  rawValue: string | null;
}

export interface KnownFact {
  path: SummaryFieldPath;
  scenarioField: string | null;
  unit: string;
  value: ProfileValueView | null;
  status: FactStatus;
  sources: FactSource[];
  /** Competing values (a conflict): each with its own sources; `candidateId` lets the user choose one. */
  candidates: Array<{ candidateId: string | null; value: ProfileValueView; sources: FactSource[] }>;
  /** Readings that belong to another period of a contract change - shown, never a conflict. */
  otherPeriods: Array<{ value: ProfileValueView | null; source: FactSource; reason: string }>;
  /** When the user decided (user_confirmed / user_corrected). */
  decidedAt: string | null;
  /** A usable reading of a Scenario field: the conversation does not ask that question again. */
  defersQuestion: boolean;
}

export interface DocumentKnowledge {
  asOfDate: string;
  facts: KnownFact[];
  /** Scenario fields whose question a usable reading makes unnecessary to ask now (selection only). */
  deferrableFields: string[];
  /** The hourly-rate conflict issue, when the profile has one - asked as ONE grounded clarification. */
  rateConflict: ProfileIssueView | null;
}

function source(s: ProfileSourceView): FactSource {
  const p = s.payPeriod;
  return {
    role: s.role, documentId: s.documentId ?? null,
    period: p ? { label: p.label ?? null, start: p.startDate ?? null, end: p.endDate ?? null, periodType: p.periodType ?? null } : null,
    effectiveDate: s.effectiveDate ?? null, page: typeof s.page === 'number' ? s.page : null, printedLabel: s.printedLabel ?? null, rawValue: s.rawValue ?? null,
  };
}

function fieldAt(resolved: ResolvedProfileView, path: SummaryFieldPath): ProfileFieldView | undefined {
  const [group, key] = path.split('.') as ['employment' | 'payroll', string];
  const table = resolved.profile?.[group];
  return table && typeof table === 'object' ? table[key] : undefined;
}

const REGIME_REASONS = new Set(['superseded_by_later_document', 'outside_as_of_regime', 'pay_period_straddles_change']);

export function projectProfile(resolved: ResolvedProfileView): DocumentKnowledge {
  const issues = Array.isArray(resolved.issues) ? resolved.issues : [];
  const facts: KnownFact[] = [];
  for (const path of SUMMARY_FIELDS) {
    const field = fieldAt(resolved, path);
    if (!field || !(field.state in STATUS_OF)) continue;
    // The summary shows what the documents actually contain; the hourly rate is always shown (also when not found).
    if (field.state === 'unknown' && path !== 'employment.hourlyRate') continue;
    const scenarioField = (DOCUMENT_FIELD_TO_SCENARIO as Record<string, string>)[path] ?? null;
    const usable = USABLE_EVIDENCE_STATES.includes(field.state) && field.value !== null;
    const unitFits = scenarioField !== null && field.unit === SCENARIO_UNIT[path as DocumentFieldPath];
    const issue = issues.find((i) => i.fieldPath === path && i.state === 'conflict');
    facts.push({
      path, scenarioField, unit: field.unit, value: field.value, status: STATUS_OF[field.state],
      sources: (field.sources ?? []).map(source),
      candidates: issue
        ? issue.candidates.map((c) => ({ candidateId: c.candidateId, value: c.value, sources: c.sources.map(source) }))
        : field.state === 'conflict' ? (field.candidates ?? []).map((c) => ({ candidateId: null, value: c.value, sources: [source(c.source)] })) : [],
      otherPeriods: (field.excluded ?? []).filter((x) => REGIME_REASONS.has(x.reason)).map((x) => ({ value: x.value, source: source(x.source), reason: x.reason })),
      decidedAt: field.resolution?.decidedAt ?? null,
      defersQuestion: usable && unitFits,
    });
  }
  return {
    asOfDate: typeof resolved.profile?.asOfDate === 'string' ? resolved.profile.asOfDate : '',
    facts,
    deferrableFields: facts.filter((f) => f.defersQuestion && f.scenarioField).map((f) => f.scenarioField as string),
    rateConflict: issues.find((i) => i.fieldPath === 'employment.hourlyRate' && i.state === 'conflict') ?? null,
  };
}

export const factFor = (knowledge: DocumentKnowledge | null, scenarioField: string): KnownFact | undefined =>
  knowledge?.facts.find((f) => f.scenarioField === scenarioField);
