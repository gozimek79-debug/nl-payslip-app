import type { ConsistencyIssue } from './tier-c-shared.ts';

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
  documentLabel: string | null;
  effectiveDate: string | null;
  payPeriod: { label: string | null; endDate: string | null; periodType: string | null } | null;
  printedLabel: string | null;
  page: number | null;
  line: number | null;
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
  excluded: Array<{ value: ProfileValueView | null; source: ProfileSourceView; reason: string }>;
  reason: { code: string; asOfDate?: string } | null;
}

export interface PayrollProfileView {
  version: 1;
  asOfDate: string;
  employment: Record<string, ProfileFieldView>;
  payroll: Record<string, ProfileFieldView>;
  recurringItems: Record<string, ProfileFieldView[]>;
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
 * Field-level only (§P1.4): the PayslipPeriod paths whose stored amount is a non-reading, taken from
 * the specific issues that name them. This is never a count and never a gate - the backend excludes
 * exactly these amounts and still uses every other fact on the payslip.
 */
export function unreadableFieldPathsFor(needsConfirmation: ConsistencyIssue[]): string[] {
  const paths = new Set<string>();
  for (const issue of needsConfirmation) {
    if (issue.code === 'amount_unreadable') paths.add(issue.field);
    if (issue.code === 'et_exchange_amount_unknown') paths.add('et.et_exchange_amount');
  }
  return [...paths];
}
