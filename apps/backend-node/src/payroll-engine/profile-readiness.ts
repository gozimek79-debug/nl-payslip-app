import { createHash } from 'node:crypto';
import {
  EMPLOYMENT_FIELD_KEYS, PAYROLL_FIELD_KEYS, USABLE_EVIDENCE_STATES, valuesEqual,
  type ExcludedEvidence, type EvidenceSource, type PayrollProfile, type ProfileCandidate, type ProfileField, type ProfileReason,
  type ProfileUnit, type ProfileValue,
} from './payroll-profile.js';
import {
  canonicalJson, profileFieldFingerprint, PERIOD_TYPE_VALUES, RECURRING_COLLECTIONS, UNIT_RULES,
  type DecisionResult, type ProfileFieldPath, type RecurringCollection, type UserProfileDecision,
} from './profile-decisions.js';

/**
 * P3.1 S4 (LOONTO-PRO-P3-DECISION-LOCK.md, decisions D and E; ZADANIE-P3.1-S4-READINESS.md): calculation
 * readiness - the minimal "ask only what matters" layer.
 *
 * The product rule: an unresolved field (`conflict` / `unknown`) BLOCKS the requested calculation only
 * when it is REQUIRED in an ACTIVE requirement group. Everything else is non-blocking: a conflict stays a
 * visible `optional` issue anywhere, an unknown outside the active groups is `informational` data.
 *
 * Pure: it only reads a profile (the post-decision profile from `applyUserDecisions`) and returns data.
 * No AI, no storage, no mutation of the profile or its facts, no payroll calculation. Equality stays
 * printed-cent equality (nothing here compares values except by the resolver's own `valuesEqual`), and
 * there is NO materiality tolerance and NO payout-impact comparison: `ProfileIssue.impact` is `null`
 * until P4, which also owns scenario-driven activation of groups (the default here is `['core_pay']`).
 *
 * Each issue carries everything the later question UI (S5) needs - candidates grouped by value, hints,
 * the allowed actions, a typed input description - and the documentary evidence fingerprint (S3's
 * `profileFieldFingerprint`, never a second system) that the UI submits back with a decision.
 */

// ---------------------------------------------------------------------------------------------
// Requirement groups (decision E - the canonical table)
// ---------------------------------------------------------------------------------------------

/** Canonical order: it orders `activeGroups`, `issue.groups` and the issue list. */
export const REQUIREMENT_GROUP_IDS = [
  'core_pay', 'overtime', 'saturday', 'sunday', 'public_holiday', 'surcharges', 'employee_deductions', 'net_items', 'tax_settings',
] as const;
export type RequirementGroupId = (typeof REQUIREMENT_GROUP_IDS)[number];

/** O4 (binding owner decision): before P4 only `core_pay` is active unless the request says otherwise. */
export const DEFAULT_ACTIVE_GROUPS: readonly RequirementGroupId[] = ['core_pay'];

/** One profile field, or every field of one recurring collection (`recurringItems.<collection>.*`). */
export type GroupMember = ProfileFieldPath | { collection: RecurringCollection };

export interface RequirementGroupSpec {
  required: readonly GroupMember[];
  optional: readonly GroupMember[];
}
export type RequirementGroupTable = Record<RequirementGroupId, RequirementGroupSpec>;

/** Real repository field keys only (a typo is a compile error: `ProfileFieldPath` is a closed union for
 * employment/payroll fields). `satisfies` makes a missing group a compile error too. */
export const REQUIREMENT_GROUPS = {
  core_pay: {
    required: ['employment.hourlyRate', 'payroll.periodType'],
    optional: ['employment.hoursPerWeek', 'employment.guaranteedHours', 'employment.guaranteedHoursPeriodWeeks'],
  },
  overtime: { required: ['employment.overtimeThresholdHours', 'payroll.overtimeTier1Premium', 'payroll.overtimeTier2Premium'], optional: [] },
  saturday: { required: ['payroll.saturdayPremium'], optional: [] },
  sunday: { required: ['payroll.sundayPremium'], optional: [] },
  public_holiday: { required: ['payroll.publicHolidayPremium'], optional: [] },
  surcharges: { required: [], optional: [{ collection: 'surcharges' }] },
  employee_deductions: {
    required: [],
    optional: [
      'payroll.pensionEmployeePercent', 'payroll.pawwEmployeePercent', 'payroll.sectorPremiumPercent', 'payroll.wgaGatEmployeePercent',
      'payroll.wgaEmployeePercent', 'payroll.gediffWgaEmployeePercent', 'payroll.whkEmployeePercent',
      { collection: 'otherPreTaxDeductions' }, { collection: 'otherPostTaxDeductions' },
    ],
  },
  net_items: { required: [], optional: [{ collection: 'netAdditions' }, { collection: 'netDeductions' }, 'payroll.etExchangeAmount'] },
  // `loonheffingskorting` has no document source: an `unknown` here is valid and is never filled from documents.
  tax_settings: { required: ['payroll.loonheffingskorting'], optional: [] },
} as const satisfies RequirementGroupTable;

/** Active groups: the request's list, deduplicated and in canonical order - the order the request listed
 * them in has no effect. `undefined` (no `requirements` in the request) is the O4 default. An unknown id
 * throws (the HTTP boundary rejects it first). */
export function normalizeActiveGroups(groups?: readonly string[] | undefined): RequirementGroupId[] {
  if (groups === undefined) return [...DEFAULT_ACTIVE_GROUPS];
  const wanted = new Set<string>(groups);
  for (const g of wanted) if (!(REQUIREMENT_GROUP_IDS as readonly string[]).includes(g)) throw new Error(`unknown requirement group: ${g}`);
  return REQUIREMENT_GROUP_IDS.filter((id) => wanted.has(id));
}

function matchesMember(member: GroupMember, path: string): boolean {
  return typeof member === 'string' ? member === path : path.startsWith(`recurringItems.${member.collection}.`);
}

/** How each canonical group references one field (`required` wins over `optional` within a group). */
function membershipOf(path: string, table: RequirementGroupTable): Array<{ group: RequirementGroupId; requirement: 'required' | 'optional' }> {
  const out: Array<{ group: RequirementGroupId; requirement: 'required' | 'optional' }> = [];
  for (const group of REQUIREMENT_GROUP_IDS) {
    const spec = table[group];
    if (spec.required.some((m) => matchesMember(m, path))) out.push({ group, requirement: 'required' });
    else if (spec.optional.some((m) => matchesMember(m, path))) out.push({ group, requirement: 'optional' });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Issue contract
// ---------------------------------------------------------------------------------------------

export type IssueSeverity = 'blocking' | 'optional' | 'informational';
export type IssueAction = 'select_candidate' | 'enter_value' | 'leave_unresolved';
export type HintKind = 'observed_premium' | 'superseded_value' | 'unplaceable_matching_value' | 'excluded_value';
export type CandidateBasis = 'contractual' | 'employer_applied';

export interface IssueCandidate {
  /** Deterministic id of this value group within this field (see `candidateIdOf`). */
  candidateId: string;
  /** The documentary value of the group. */
  value: ProfileValue;
  /** Every document source of every candidate in the group. */
  sources: EvidenceSource[];
  basis: CandidateBasis;
}

/** Non-binding evidence. Never a candidate, never pre-selected, never offered as `select_candidate`. */
export interface IssueHint {
  value: ProfileValue;
  sources: EvidenceSource[];
  kind: HintKind;
}

export interface IssueInput {
  kind: 'number' | 'text' | 'date' | 'boolean' | 'enum';
  /** number: smallest accepted value; text: shortest accepted length. */
  min?: number;
  /** number: largest accepted value; text: longest accepted length. */
  max?: number;
  step?: number;
  enumValues?: string[];
}

export interface ProfileIssue {
  fieldPath: ProfileFieldPath;
  key: string;
  meaning: string;
  unit: ProfileUnit;
  state: 'conflict' | 'unknown';
  reason: ProfileReason;
  severity: IssueSeverity;
  /** EVERY canonical group that references the field (active or not), canonical order, no duplicates. */
  groups: RequirementGroupId[];
  candidates: IssueCandidate[];
  hints: IssueHint[];
  excluded: ExcludedEvidence[];
  actions: IssueAction[];
  input: IssueInput;
  /** S3's documentary fingerprint - what a decision submits back. */
  evidenceFingerprint: string;
  /** The user's last decision for this field, only when it is now stale (so the UI can pre-select it). */
  previousDecision: { kind: UserProfileDecision['kind']; value: ProfileValue } | null;
  /** Reserved for P4 (payout impact). Always null in P3. */
  impact: null;
}

export interface CalculationReadiness {
  activeGroups: RequirementGroupId[];
  ready: boolean;
  /** Unique blocking issues (a field in several groups is one issue). */
  blockingCount: number;
  /** Unique optional issues; informational issues are not counted. */
  optionalCount: number;
}

// ---------------------------------------------------------------------------------------------
// Typed input metadata (mirrors S3's server-side validation - `UNIT_RULES` is the authority)
// ---------------------------------------------------------------------------------------------

const MONEY_STEP = 0.01;

/**
 * One typed input per unit. Bounds are S3's `UNIT_RULES` limits. A lower bound S3 excludes (`0 < v`) is
 * given as the smallest accepted value on the input's step (0.01), so every value the input allows is
 * valid; S3 remains the validator. `text` bounds are lengths. `Record<ProfileUnit, …>` makes a new unit a
 * compile error until it has an input, and `inputFor` fails loudly for anything unmapped at runtime.
 */
export const UNIT_INPUTS: Record<ProfileUnit, IssueInput> = {
  eur_per_hour: { kind: 'number', min: MONEY_STEP, max: 200, step: MONEY_STEP },
  hours_per_week: { kind: 'number', min: 0.01, max: 168, step: 0.01 },
  hours: { kind: 'number', min: 0.01, max: 744, step: 0.01 },
  weeks: { kind: 'number', min: 1, max: 52, step: 1 },
  premium_percent: { kind: 'number', min: 0, max: 400, step: 0.01 },
  surcharge_percent: { kind: 'number', min: 0, max: 100, step: 0.01 },
  percent_of_printed_base: { kind: 'number', min: 0, max: 100, step: 0.01 },
  percent: { kind: 'number', min: 0, max: 100, step: 0.01 },
  eur_per_period: { kind: 'number', min: 0, step: MONEY_STEP },
  eur_per_month: { kind: 'number', min: 0, max: 100_000, step: MONEY_STEP },
  eur_per_year: { kind: 'number', min: 0, step: MONEY_STEP },
  period_type: { kind: 'enum', enumValues: [...PERIOD_TYPE_VALUES] },
  boolean: { kind: 'boolean' },
  date: { kind: 'date' },
  text: { kind: 'text', min: 1, max: 200 },
};

export function inputFor(unit: ProfileUnit): IssueInput {
  const input = UNIT_INPUTS[unit];
  if (!input || !(unit in UNIT_RULES)) throw new Error(`no input metadata for profile unit "${String(unit)}"`);
  return { ...input, ...(input.enumValues ? { enumValues: [...input.enumValues] } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Deterministic helpers (no locale, no insertion order, no request order)
// ---------------------------------------------------------------------------------------------

const cmp = (a: string | number, b: string | number): number => (a < b ? -1 : a > b ? 1 : 0);

function compareValues(a: ProfileValue, b: ProfileValue): number {
  if (typeof a === 'number' && typeof b === 'number') return cmp(a, b);
  return cmp(canonicalJson(a), canonicalJson(b));
}

const ROLE_RANK: Record<string, number> = { contract_base: 0, contract_annex: 1, payslip: 2 };

/** Stable order of sources: role, annex date, printed period, document, then the printed evidence. */
function compareSources(a: EvidenceSource, b: EvidenceSource): number {
  return cmp(ROLE_RANK[a.role] ?? 9, ROLE_RANK[b.role] ?? 9)
    || cmp(a.effectiveDate ?? '', b.effectiveDate ?? '')
    || cmp(a.payPeriod?.endDate ?? '', b.payPeriod?.endDate ?? '')
    || cmp(a.documentLabel ?? '', b.documentLabel ?? '')
    || cmp(a.documentIndex ?? -1, b.documentIndex ?? -1)
    || cmp(a.page ?? -1, b.page ?? -1)
    || cmp(a.rawValue ?? '', b.rawValue ?? '')
    || cmp(a.printedLabel ?? '', b.printedLabel ?? '');
}

function sha16(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}

/**
 * Candidate id = `sha256(canonicalJSON({ domain: 'candidate', fieldPath, value })).slice(0, 16)`. It names
 * "this documentary value of this field": stable across page / raw text / printed label / document
 * order / how many documents support the value; never random, never an array position, no raw text. It is
 * NOT the evidence fingerprint (a different domain over different content).
 */
export function candidateIdOf(fieldPath: string, value: ProfileValue): string {
  return sha16({ domain: 'candidate', fieldPath, value: typeof value === 'string' ? value.trim() : value });
}

// ---------------------------------------------------------------------------------------------
// Candidate groups and hints
// ---------------------------------------------------------------------------------------------

/** A value group is `contractual` as soon as any contract/annex source supports it, else
 * `employer_applied` (payslip evidence). Every source is preserved; no winner is chosen. */
function basisOfGroup(members: ProfileCandidate[]): CandidateBasis {
  return members.some((m) => m.source.role === 'contract_base' || m.source.role === 'contract_annex') ? 'contractual' : 'employer_applied';
}

function candidateGroups(path: string, field: ProfileField): IssueCandidate[] {
  const ordered = [...field.candidates].sort((a, b) => compareValues(a.value, b.value) || compareSources(a.source, b.source));
  const groups: Array<{ value: ProfileValue; members: ProfileCandidate[] }> = [];
  for (const c of ordered) {
    const group = groups.find((g) => valuesEqual(g.value, c.value));
    if (group) group.members.push(c);
    else groups.push({ value: c.value, members: [c] });
  }
  return groups
    .map((g): IssueCandidate => ({
      candidateId: candidateIdOf(path, g.value),
      value: g.value,
      sources: g.members.map((m) => m.source).sort(compareSources),
      basis: basisOfGroup(g.members),
    }))
    .sort((a, b) => cmp(a.basis === 'contractual' ? 0 : 1, b.basis === 'contractual' ? 0 : 1) || compareValues(a.value, b.value));
}

const OBSERVED_PREMIUM_TARGETS: ReadonlySet<string> = new Set(['payroll.overtimeTier1Premium', 'payroll.overtimeTier2Premium']);
const HINT_RANK: Record<HintKind, number> = { observed_premium: 0, superseded_value: 1, unplaceable_matching_value: 2, excluded_value: 3 };

function hintFromExcluded(x: ExcludedEvidence): IssueHint | null {
  if (x.value === null) return null; // an unreadable fact is not a value - never a fake hint
  if (x.reason === 'superseded_by_later_document') return { value: x.value, sources: [x.source], kind: 'superseded_value' };
  if (x.reason === 'payslip_period_unplaceable' && x.regime?.relation === 'value_matches_current_but_period_unknown') {
    return { value: x.value, sources: [x.source], kind: 'unplaceable_matching_value' };
  }
  return { value: x.value, sources: [x.source], kind: 'excluded_value' };
}

/** Same hint when kind, value and the semantic identity of its sources (role, document, annex date,
 * printed period) are the same - presentation (page, raw text, label) does not make a second hint. */
function hintIdentity(h: IssueHint): string {
  return canonicalJson([h.kind, h.value, h.sources.map((s) => [s.role, s.documentIndex, s.documentId, s.effectiveDate, s.payPeriod?.startDate ?? null, s.payPeriod?.endDate ?? null])]);
}

function hintsFor(profile: PayrollProfile, path: string, field: ProfileField): IssueHint[] {
  const raw: IssueHint[] = [];
  for (const x of field.excluded) {
    const hint = hintFromExcluded(x);
    if (hint) raw.push(hint);
  }
  // P1.1: an observed overtime premium never says which tier it is - at most a hint on a tier field.
  if (OBSERVED_PREMIUM_TARGETS.has(path)) {
    for (const observed of profile.observedOvertimePremiums.fields) {
      if (observed.value !== null && USABLE_EVIDENCE_STATES.includes(observed.state)) raw.push({ value: observed.value, sources: [...observed.sources], kind: 'observed_premium' });
    }
  }
  raw.sort((a, b) => cmp(HINT_RANK[a.kind], HINT_RANK[b.kind]) || compareValues(a.value, b.value) || cmp(canonicalJson(a.sources), canonicalJson(b.sources)));
  const seen = new Set<string>();
  return raw.filter((h) => {
    const id = hintIdentity(h);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Field enumeration (the profile's own order)
// ---------------------------------------------------------------------------------------------

export interface ProfileFieldEntry {
  path: ProfileFieldPath;
  field: ProfileField;
  /** [section, position in the section]: employment / payroll in key order, recurring by collection. */
  order: readonly [number, number];
}

/** Every decision-targetable field of the profile, in the profile's stable order (employment keys,
 * payroll keys, then each recurring collection). Recurring fields share a position per collection - their
 * array order depends on document order, so they are tie-broken by path. */
export function enumerateProfileFields(profile: PayrollProfile): ProfileFieldEntry[] {
  const out: ProfileFieldEntry[] = [];
  EMPLOYMENT_FIELD_KEYS.forEach((key, i) => out.push({ path: `employment.${key}`, field: profile.employment[key], order: [0, i] }));
  PAYROLL_FIELD_KEYS.forEach((key, i) => out.push({ path: `payroll.${key}`, field: profile.payroll[key], order: [1, i] }));
  RECURRING_COLLECTIONS.forEach((collection, i) => {
    for (const field of profile.recurringItems[collection]) out.push({ path: `recurringItems.${collection}.${field.key}`, field, order: [2, i] });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The issue builder
// ---------------------------------------------------------------------------------------------

export interface ReadinessInput {
  /** The request's groups (any order, duplicates allowed); omitted = the O4 default `['core_pay']`. */
  groups?: readonly RequirementGroupId[];
  /** The decisions the request carried and S3's results for them (same length, same order). */
  decisions?: readonly UserProfileDecision[];
  decisionResults?: readonly DecisionResult[];
  /** Injectable for tests only; production uses `REQUIREMENT_GROUPS`. */
  table?: RequirementGroupTable;
}

function severityOf(state: 'conflict' | 'unknown', membership: ReturnType<typeof membershipOf>, active: ReadonlySet<RequirementGroupId>): IssueSeverity {
  const inActive = membership.filter((m) => active.has(m.group));
  if (inActive.some((m) => m.requirement === 'required')) return 'blocking';
  if (inActive.some((m) => m.requirement === 'optional') || state === 'conflict') return 'optional';
  return 'informational';
}

function actionsFor(severity: IssueSeverity, candidates: IssueCandidate[]): IssueAction[] {
  const actions: IssueAction[] = [];
  if (candidates.length > 0) actions.push('select_candidate');
  actions.push('enter_value');
  if (severity !== 'blocking') actions.push('leave_unresolved');
  return actions;
}

/** The last submitted decision per field, with its result - only a STALE one becomes `previousDecision`
 * (a rejected decision was invalid input, not a choice worth pre-selecting). */
function previousDecisions(input: ReadinessInput): Map<string, { kind: UserProfileDecision['kind']; value: ProfileValue }> {
  const decisions = input.decisions ?? [];
  const results = input.decisionResults ?? [];
  if (decisions.length !== results.length) throw new Error('decisions and decisionResults must be aligned');
  const last = new Map<string, number>();
  decisions.forEach((d, i) => last.set(d.fieldPath, i));
  const out = new Map<string, { kind: UserProfileDecision['kind']; value: ProfileValue }>();
  for (const [path, i] of last) {
    const result = results[i] as DecisionResult;
    const decision = decisions[i] as UserProfileDecision;
    if (result.status === 'stale' && (result.problem === 'evidence_changed' || result.problem === 'candidate_not_present')) out.set(path, { kind: decision.kind, value: decision.value });
  }
  return out;
}

/**
 * One issue per UNRESOLVED field (`conflict` / `unknown`) - never per group, never for a resolved,
 * superseded or user-decided field. Ordered: blocking, optional, informational; within blocking/optional
 * by the first relevant requirement group (the first referencing group that is active, else the first
 * referencing group, else none), then the profile's field order, then the path. Independent of the order
 * of the request's groups, decisions and documents. Reads `profile`; returns new objects only.
 */
export function buildProfileIssues(profile: PayrollProfile, input: ReadinessInput = {}): ProfileIssue[] {
  const table = input.table ?? REQUIREMENT_GROUPS;
  const activeList = normalizeActiveGroups(input.groups);
  const active = new Set<RequirementGroupId>(activeList);
  const previous = previousDecisions(input);
  const built: Array<{ issue: ProfileIssue; rank: number; entry: ProfileFieldEntry }> = [];
  for (const entry of enumerateProfileFields(profile)) {
    const { path, field } = entry;
    if (field.state !== 'conflict' && field.state !== 'unknown') continue;
    if (field.reason === null) throw new Error(`unresolved field ${path} has no reason`);
    const membership = membershipOf(path, table);
    const severity = severityOf(field.state, membership, active);
    const candidates = candidateGroups(path, field);
    const groups = membership.map((m) => m.group);
    const firstRelevant = membership.find((m) => active.has(m.group)) ?? membership[0];
    built.push({
      entry,
      rank: firstRelevant ? REQUIREMENT_GROUP_IDS.indexOf(firstRelevant.group) : REQUIREMENT_GROUP_IDS.length,
      issue: {
        fieldPath: path,
        key: field.key,
        meaning: field.meaning,
        unit: field.unit,
        state: field.state,
        reason: field.reason,
        severity,
        groups,
        candidates,
        hints: hintsFor(profile, path, field),
        excluded: field.excluded,
        actions: actionsFor(severity, candidates),
        input: inputFor(field.unit),
        evidenceFingerprint: profileFieldFingerprint(profile, path) as string,
        previousDecision: previous.get(path) ?? null,
        impact: null,
      },
    });
  }
  const severityRank: Record<IssueSeverity, number> = { blocking: 0, optional: 1, informational: 2 };
  built.sort((a, b) =>
    cmp(severityRank[a.issue.severity], severityRank[b.issue.severity])
    || (a.issue.severity === 'informational' ? 0 : cmp(a.rank, b.rank))
    || cmp(a.entry.order[0], b.entry.order[0]) || cmp(a.entry.order[1], b.entry.order[1])
    || cmp(a.issue.fieldPath, b.issue.fieldPath));
  return built.map((b) => b.issue);
}

/** Counts are unique fields: an issue is one field however many groups reference it. */
export function calculationReadiness(activeGroups: readonly RequirementGroupId[], issues: readonly ProfileIssue[]): CalculationReadiness {
  const blockingCount = issues.filter((i) => i.severity === 'blocking').length;
  const optionalCount = issues.filter((i) => i.severity === 'optional').length;
  return { activeGroups: normalizeActiveGroups(activeGroups), ready: blockingCount === 0, blockingCount, optionalCount };
}

/** Issues and readiness for one resolve. */
export function evaluateReadiness(profile: PayrollProfile, input: ReadinessInput = {}): { issues: ProfileIssue[]; readiness: CalculationReadiness } {
  const issues = buildProfileIssues(profile, input);
  return { issues, readiness: calculationReadiness(normalizeActiveGroups(input.groups), issues) };
}
