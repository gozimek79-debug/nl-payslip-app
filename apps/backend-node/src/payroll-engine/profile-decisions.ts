import { createHash } from 'node:crypto';
import {
  EMPLOYMENT_FIELD_KEYS, PAYROLL_FIELD_KEYS, USABLE_EVIDENCE_STATES, valuesEqual,
  type EmploymentFieldKey, type PayrollFieldKey, type RecurringItems, type PayrollProfile, type ProfileField,
  type ProfileValue, type ProfileUnit, type ProfileReason, type ProfileDocumentRef, type EvidenceSource,
  type SourceRole, type UserResolution,
} from './payroll-profile.js';

/**
 * P3.1 S3 (LOONTO-PRO-P3-DECISION-LOCK.md, decisions B, C, H): field-level user decisions on the Payroll
 * Profile, as a STATELESS, PURE overlay.
 *
 * Every resolve rebuilds the documentary profile from facts (payroll-profile.ts, untouched by this
 * module), computes each decision target's temporal evidence fingerprint on that DOCUMENTARY field, and
 * only then applies the decisions:
 *   - `confirm_candidate` -> `user_confirmed`: the user picked one of the field's existing candidate value
 *     groups; sources = that group's document sources + one `user` source. Never a new value.
 *   - `correct_value`     -> `user_corrected`: the user's own value; sources = exactly one `user` source,
 *     never documentary corroboration.
 * A decision never touches facts, other fields, `candidates`, `excluded` or `regime`; the documentary
 * result it replaced is kept in `resolution.previous`. Nothing is stored (persistence is P8).
 *
 * Order of evaluation per decision (binding, task §10): duplicate -> field missing -> invalid ->
 * already satisfied by documents -> fingerprint equal (apply; a confirmation still needs its candidate)
 * -> otherwise stale.
 */

// ---------------------------------------------------------------------------------------------
// Decision / result contract
// ---------------------------------------------------------------------------------------------

/** Every recurring collection is a decision target; a new collection is a compile error until listed. */
export const RECURRING_COLLECTIONS = ['surcharges', 'otherPreTaxDeductions', 'otherPostTaxDeductions', 'netAdditions', 'netDeductions'] as const satisfies readonly (keyof RecurringItems)[];
export type RecurringCollection = (typeof RECURRING_COLLECTIONS)[number];
export const ALL_RECURRING_COLLECTIONS_LISTED: [Exclude<keyof RecurringItems, RecurringCollection>] extends [never] ? true : false = true;

/** Stable field identity. A recurring field is addressed by its existing group key
 * `<group>:<category>:<normalised description>`. calibrationOnly, observed premiums, extraction-table
 * rows, raw facts and individual excluded entries are deliberately NOT addressable. */
export type ProfileFieldPath =
  | `employment.${EmploymentFieldKey}`
  | `payroll.${PayrollFieldKey}`
  | `recurringItems.${RecurringCollection}.${string}`;

export interface ConfirmCandidateDecision {
  kind: 'confirm_candidate';
  /** Client-generated, opaque. */
  decisionId: string;
  fieldPath: ProfileFieldPath;
  /** Must equal one existing candidate value group (`valuesEqual`). */
  value: ProfileValue;
  evidenceFingerprint: string;
  /** Client-supplied, echoed only - never used in any logic. */
  decidedAt: string;
}

export interface CorrectValueDecision {
  kind: 'correct_value';
  decisionId: string;
  fieldPath: ProfileFieldPath;
  value: ProfileValue;
  /** Must equal the field's own unit. */
  unit: ProfileUnit;
  evidenceFingerprint: string;
  decidedAt: string;
}

export type UserProfileDecision = ConfirmCandidateDecision | CorrectValueDecision;

export type DecisionStatus = 'applied' | 'satisfied_by_documents' | 'stale' | 'rejected';

export type DecisionProblem =
  | 'field_not_found'
  | 'evidence_changed'
  | 'candidate_not_present'
  | 'invalid_value'
  | 'unit_mismatch'
  | 'duplicate_field_decision';

export interface DecisionResult {
  decisionId: string;
  fieldPath: ProfileFieldPath;
  status: DecisionStatus;
  problem: DecisionProblem | null;
}

/** Request bound (task §14). */
export const MAX_DECISIONS = 200;
export const MAX_FIELD_PATH_LENGTH = 300;

// ---------------------------------------------------------------------------------------------
// Field paths
// ---------------------------------------------------------------------------------------------

type ParsedPath =
  | { section: 'employment'; key: EmploymentFieldKey }
  | { section: 'payroll'; key: PayrollFieldKey }
  | { section: 'recurringItems'; collection: RecurringCollection; key: string };

function parseFieldPath(path: string): ParsedPath | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_FIELD_PATH_LENGTH) return null;
  const dot = path.indexOf('.');
  if (dot <= 0) return null;
  const section = path.slice(0, dot);
  const rest = path.slice(dot + 1);
  if (section === 'employment') return (EMPLOYMENT_FIELD_KEYS as readonly string[]).includes(rest) ? { section, key: rest as EmploymentFieldKey } : null;
  if (section === 'payroll') return (PAYROLL_FIELD_KEYS as readonly string[]).includes(rest) ? { section, key: rest as PayrollFieldKey } : null;
  if (section !== 'recurringItems') return null;
  const next = rest.indexOf('.');
  if (next <= 0) return null;
  const collection = rest.slice(0, next);
  const key = rest.slice(next + 1);
  if (!(RECURRING_COLLECTIONS as readonly string[]).includes(collection) || key === '') return null;
  return { section, collection: collection as RecurringCollection, key };
}

/** A well-formed path to a decision-targetable field (the field itself may still not exist). */
export function isProfileFieldPath(path: string): path is ProfileFieldPath {
  return parseFieldPath(path) !== null;
}

export function findProfileField(profile: PayrollProfile, path: string): ProfileField | null {
  const p = parseFieldPath(path);
  if (!p) return null;
  if (p.section === 'employment') return profile.employment[p.key] ?? null;
  if (p.section === 'payroll') return profile.payroll[p.key] ?? null;
  return profile.recurringItems[p.collection].find((f) => f.key === p.key) ?? null;
}

/** A copy of `profile` with one field replaced - every other field object is the same object. */
function withField(profile: PayrollProfile, path: string, field: ProfileField): PayrollProfile {
  const p = parseFieldPath(path);
  if (!p) return profile;
  if (p.section === 'employment') return { ...profile, employment: { ...profile.employment, [p.key]: field } };
  if (p.section === 'payroll') return { ...profile, payroll: { ...profile.payroll, [p.key]: field } };
  return { ...profile, recurringItems: { ...profile.recurringItems, [p.collection]: profile.recurringItems[p.collection].map((f) => (f.key === p.key ? field : f)) } };
}

// ---------------------------------------------------------------------------------------------
// Document identity (task §4) - safe BEFORE any fingerprint is computed
// ---------------------------------------------------------------------------------------------

/** The supplied `documentId`s that occur more than once (sorted). The controller rejects such a request;
 * `documentKeys` refuses to build an identity from it. */
export function duplicateDocumentIds(documents: ReadonlyArray<{ documentId?: string | null }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const d of documents) {
    if (d.documentId === undefined || d.documentId === null) continue;
    if (seen.has(d.documentId)) duplicates.add(d.documentId);
    seen.add(d.documentId);
  }
  return [...duplicates].sort();
}

/**
 * `documentKey` per profile document index: the supplied `documentId`; otherwise the deterministic
 * fallback role + label + ordinal among the documents WITHOUT an id that share that role and label (for
 * older callers). The bare request index is never the identity. The two kinds live in separate
 * namespaces, so an id can never collide with a fallback key.
 */
export function documentKeys(documents: readonly ProfileDocumentRef[]): Map<number, string> {
  if (duplicateDocumentIds(documents).length > 0) throw new Error('duplicate documentId: document identity is ambiguous');
  const ordinals = new Map<string, number>();
  const keys = new Map<number, string>();
  for (const d of documents) {
    if (d.documentId) {
      keys.set(d.index, JSON.stringify(['id', d.documentId]));
      continue;
    }
    const group = JSON.stringify([d.role, d.label]);
    const ordinal = ordinals.get(group) ?? 0;
    ordinals.set(group, ordinal + 1);
    keys.set(d.index, JSON.stringify(['fallback', d.role, d.label, ordinal]));
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// Temporal evidence fingerprint (decision H - binding)
// ---------------------------------------------------------------------------------------------

/** JSON with object keys sorted at every level - independent of property insertion order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).filter((k) => record[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Entries as a set, in a canonical order (by their canonical JSON) - the order evidence was listed in
 * and a byte-identical repeat (e.g. one value printed twice in one document) never change the result. */
function canonicalSet<T>(entries: T[]): T[] {
  const byJson = new Map<string, T>();
  for (const e of entries) byJson.set(canonicalJson(e), e);
  return [...byJson.keys()].sort().map((k) => byJson.get(k) as T);
}

function basisOf(role: SourceRole): string {
  if (role === 'payslip') return 'employer_applied';
  if (role === 'contract_base' || role === 'contract_annex') return 'contractual';
  return role;
}

/** The reason as identity, not presentation: a document is named by its key (never its index), and the
 * as-of date that `timeline_disagreement` merely echoes is left out - the regime start already
 * identifies the disagreement, so moving the as-of date inside the regime changes nothing. */
function canonicalReason(reason: ProfileReason | null, keyOf: (index: number | null) => string | null): unknown {
  if (reason === null) return null;
  if (reason.code === 'timeline_disagreement') return { code: reason.code };
  if (reason.code === 'later_document_unclear') return { code: reason.code, documentKey: keyOf(reason.documentIndex), effectiveDate: reason.effectiveDate };
  return reason;
}

function fingerprintOf(fieldPath: string, field: ProfileField, keys: Map<number, string>): string {
  const keyOf = (index: number | null): string | null => {
    if (index === null) return null;
    const key = keys.get(index);
    if (key === undefined) throw new Error(`document ${index} is not in the profile's document list`);
    return key;
  };
  // Always the DOCUMENTARY field: an applied decision changes only state/value/sources/reason, and its
  // `resolution.previous` holds the documentary state and reason - so an overlay never feeds back.
  const documentary = field.resolution ? field.resolution.previous : field;
  const payPeriod = (s: EvidenceSource) => ({ payPeriodStart: s.payPeriod?.startDate ?? null, payPeriodEnd: s.payPeriod?.endDate ?? null });
  const F = {
    fieldPath,
    state: documentary.state,
    reason: canonicalReason(documentary.reason, keyOf),
    regime: field.regime ? { start: field.regime.start, end: field.regime.end, winnerDocumentKey: keyOf(field.regime.winnerDocumentIndex) } : null,
    candidates: canonicalSet(field.candidates.map((c) => ({
      role: c.source.role,
      basis: basisOf(c.source.role),
      documentKey: keyOf(c.source.documentIndex),
      documentLabel: c.source.documentLabel,
      value: c.value,
      effectiveDate: c.source.effectiveDate,
      ...payPeriod(c.source),
    }))),
    excluded: canonicalSet(field.excluded.map((x) => ({
      role: x.source.role,
      documentKey: keyOf(x.source.documentIndex),
      documentLabel: x.source.documentLabel,
      value: x.value,
      reason: x.reason,
      factReason: x.factReason ?? null,
      regimeRelation: x.regime?.relation ?? null,
      regimeBoundaryDate: x.regime?.effectiveDate ?? null,
      ...payPeriod(x.source),
    }))),
  };
  return createHash('sha256').update(canonicalJson(F)).digest('hex').slice(0, 16);
}

/**
 * `sha256(canonicalJSON(F)).slice(0, 16)` of the documentary field: state, full reason (as identity),
 * regime identity (S, X, winner key - instead of the as-of date), every candidate's role / basis /
 * documentKey / label / value / annex effective date / printed pay period, and every excluded entry's
 * role / documentKey / label / value / reason / factReason / regime relation and boundary / printed pay
 * period. Page, printed label, raw text, line and the request index are never part of it.
 * `documents` (the profile's own list) is needed for the documentKey fallback.
 */
export function evidenceFingerprint(fieldPath: ProfileFieldPath, field: ProfileField, documents: readonly ProfileDocumentRef[]): string {
  return fingerprintOf(fieldPath, field, documentKeys(documents));
}

/** The fingerprint of the field at `path` in `profile`, or null when there is no such field. */
export function profileFieldFingerprint(profile: PayrollProfile, path: ProfileFieldPath): string | null {
  const field = findProfileField(profile, path);
  return field ? evidenceFingerprint(path, field, profile.documents) : null;
}

// ---------------------------------------------------------------------------------------------
// Unit / value validation (decision C) - server-side, no coercion
// ---------------------------------------------------------------------------------------------

const isNumber = (v: ProfileValue): v is number => typeof v === 'number' && Number.isFinite(v);
const within = (min: number, max: number, minExclusive = false) => (v: ProfileValue) => isNumber(v) && (minExclusive ? v > min : v >= min) && v <= max;
/** F2 (S1): amounts are magnitudes. A negative amount is invalid input - never silently made positive. */
const amount = (max = Number.POSITIVE_INFINITY) => (v: ProfileValue) => isNumber(v) && v >= 0 && v <= max;

function isIsoCalendarDate(v: ProfileValue): boolean {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The pay-period types a user may give (the P2 fact layer's own set). One list: the readiness layer's
 * `period_type` input metadata (profile-readiness.ts) reads it too, so the two cannot drift. */
export const PERIOD_TYPE_VALUES = ['week', '4-weekly', 'month'] as const;

/**
 * The value a user may give a field of each unit. Ranges are the canonical limits (task §9). Monetary
 * units: >= 0 (F2); the only established plausibility maximum in the repository is the monthly salary's
 * (fact-extraction.ts `contract.monthlySalary`, 100 000 - pinned by a test), so `eur_per_month` reuses it
 * and no new upper limit is invented for `eur_per_period` / `eur_per_year`.
 */
export const UNIT_RULES: Record<ProfileUnit, (v: ProfileValue) => boolean> = {
  text: (v) => typeof v === 'string' && v.length >= 1 && v.length <= 200 && v.trim() !== '',
  date: isIsoCalendarDate,
  eur_per_hour: within(0, 200, true),
  eur_per_month: amount(100_000),
  eur_per_year: amount(),
  eur_per_period: amount(),
  hours_per_week: within(0, 168, true),
  hours: within(0, 744, true),
  weeks: (v) => isNumber(v) && Number.isInteger(v) && v >= 1 && v <= 52,
  premium_percent: within(0, 400),
  surcharge_percent: within(0, 100),
  percent_of_printed_base: within(0, 100),
  percent: within(0, 100),
  period_type: (v) => typeof v === 'string' && (PERIOD_TYPE_VALUES as readonly string[]).includes(v),
  boolean: (v) => typeof v === 'boolean',
};

export const PROFILE_UNITS = Object.keys(UNIT_RULES) as ProfileUnit[];

const AMOUNT_UNITS: readonly ProfileUnit[] = ['eur_per_month', 'eur_per_year', 'eur_per_period'];

/** A confirmation only has to be well-formed for the field's unit (its range is whatever the documents
 * printed - it must equal a candidate anyway); amounts must still be magnitudes (F2). */
function confirmationShapeValid(unit: ProfileUnit, v: ProfileValue): boolean {
  if (unit === 'boolean') return typeof v === 'boolean';
  if (unit === 'text' || unit === 'date' || unit === 'period_type') return typeof v === 'string';
  if (AMOUNT_UNITS.includes(unit)) return isNumber(v) && v >= 0;
  return isNumber(v);
}

function validationProblem(decision: UserProfileDecision, field: ProfileField): 'invalid_value' | 'unit_mismatch' | null {
  if (decision.kind === 'correct_value') {
    if (decision.unit !== field.unit) return 'unit_mismatch';
    return UNIT_RULES[field.unit](decision.value) ? null : 'invalid_value';
  }
  return confirmationShapeValid(field.unit, decision.value) ? null : 'invalid_value';
}

// ---------------------------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------------------------

function userSource(decisionId: string): EvidenceSource {
  return {
    sourceType: 'user', role: 'user', documentIndex: null, documentId: null, documentLabel: null, effectiveDate: null,
    payPeriod: null, printedLabel: null, rawValue: null, page: null, line: null, decisionId,
  };
}

function resolutionOf(field: ProfileField, decision: UserProfileDecision, fingerprint: string): UserResolution {
  return {
    decisionId: decision.decisionId,
    kind: decision.kind,
    decidedAt: decision.decidedAt,
    evidenceFingerprint: fingerprint,
    previous: { state: field.state, value: field.value, reason: field.reason },
  };
}

/** `user_confirmed` with the selected candidate group, or null when no candidate has that value. */
function confirmed(field: ProfileField, decision: ConfirmCandidateDecision, fingerprint: string): ProfileField | null {
  const group = field.candidates.filter((c) => valuesEqual(c.value, decision.value));
  const first = group[0];
  if (!first) return null;
  return {
    ...field,
    state: 'user_confirmed',
    value: first.value,
    sources: [...group.map((c) => c.source), userSource(decision.decisionId)],
    reason: null,
    resolution: resolutionOf(field, decision, fingerprint),
  };
}

function corrected(field: ProfileField, decision: CorrectValueDecision, fingerprint: string): ProfileField {
  return {
    ...field,
    state: 'user_corrected',
    value: decision.value,
    sources: [userSource(decision.decisionId)],
    reason: null,
    resolution: resolutionOf(field, decision, fingerprint),
  };
}

/**
 * Applies `decisions` to a DOCUMENTARY profile (one just built by `resolvePayrollProfile`) and returns the
 * resulting profile plus one `DecisionResult` per decision, in request order. Pure: the input profile is
 * not mutated, and only the fields a decision is applied to are replaced.
 *
 * For one field, the LAST decision in request order is evaluated; every earlier one is `rejected` /
 * `duplicate_field_decision`. Every evaluated decision is judged against the documentary field, so the
 * profile does not depend on the order of decisions for different fields.
 *
 * Throws when two profile documents share a `documentId` - an ambiguous identity is never fingerprinted
 * (the HTTP boundary rejects such a request with 400 before it gets here).
 */
export function applyUserDecisions(documentary: PayrollProfile, decisions: readonly UserProfileDecision[]): { profile: PayrollProfile; decisionResults: DecisionResult[] } {
  const keys = documentKeys(documentary.documents);
  const lastIndex = new Map<string, number>();
  decisions.forEach((d, i) => lastIndex.set(d.fieldPath, i));
  let profile = documentary;
  const decisionResults = decisions.map((decision, i): DecisionResult => {
    const result = (status: DecisionStatus, problem: DecisionProblem | null = null): DecisionResult => ({ decisionId: decision.decisionId, fieldPath: decision.fieldPath, status, problem });
    if (lastIndex.get(decision.fieldPath) !== i) return result('rejected', 'duplicate_field_decision');
    const field = findProfileField(documentary, decision.fieldPath);
    if (!field) return result('stale', 'field_not_found');
    const problem = validationProblem(decision, field);
    if (problem) return result('rejected', problem);
    // Documents already establish this value: their provenance is stronger than the user's.
    if (field.value !== null && USABLE_EVIDENCE_STATES.includes(field.state) && valuesEqual(field.value, decision.value)) return result('satisfied_by_documents');
    const fingerprint = fingerprintOf(decision.fieldPath, field, keys);
    if (decision.evidenceFingerprint !== fingerprint) return result('stale', 'evidence_changed');
    const applied = decision.kind === 'confirm_candidate' ? confirmed(field, decision, fingerprint) : corrected(field, decision, fingerprint);
    if (!applied) return result('stale', 'candidate_not_present');
    profile = withField(profile, decision.fieldPath, applied);
    return result('applied');
  });
  return { profile, decisionResults };
}
