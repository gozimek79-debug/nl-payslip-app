import {
  resolveProfile,
  type CalculationReadinessView, type DecisionResultView, type PayrollProfileView, type ProfileDecisionView, type ProfileFieldView,
  type ProfileIssueView, type ProfileRequestDocument, type ProfileSourceView, type ProfileValueView, type ResolvedProfileView,
} from './pro-profile-prefill.ts';
import { translations, type Lang } from './translations.ts';

/**
 * P3.1 S5 (LOONTO-PRO-P3-DECISION-LOCK.md decision G; ZADANIE-P3.1-S5-RESOLUTION-UI.md): the pure logic
 * behind the "Do uzupełnienia / To resolve" panel - everything that is not rendering.
 *
 * It resolves NOTHING (the backend owns every decision and every fingerprint). It only:
 *   - picks the issues to show (blocking + optional, in the backend's order - never re-sorted);
 *   - keeps the user's in-progress choices, one per field, candidate XOR manual;
 *   - turns choices into S3 decisions from the CURRENT issue (value from the candidate, fingerprint from
 *     the issue) and builds the full decision set for ONE re-resolve;
 *   - settles the result: a rejected decision leaves the set, everything else (applied, satisfied, stale)
 *     is kept so the backend sees it again on the next resolve;
 *   - words what the issue payload says (labels, reasons, sources, values) with no backend code or field
 *     path ever becoming user text.
 * A stale decision is only ever SUGGESTED (`suggestionFor`); it is never submitted unless the user acts.
 */

export type QuestionsCopy = (typeof translations)['pl']['proDocuments']['questions'];

// ---------------------------------------------------------------------------------------------
// Which issues are shown
// ---------------------------------------------------------------------------------------------

/** Blocking and optional issues only, in the backend's order. Informational issues are data for
 * diagnostics - never a question in the normal panel. */
export function visibleIssues(issues: readonly ProfileIssueView[]): ProfileIssueView[] {
  return issues.filter((i) => i.severity === 'blocking' || i.severity === 'optional');
}

// ---------------------------------------------------------------------------------------------
// Pending choices (client state, keyed by field path - at most one per field)
// ---------------------------------------------------------------------------------------------

export type PendingChoice =
  | { kind: 'candidate'; candidateId: string }
  | { kind: 'manual'; raw: string }
  /** The user chose to leave the field unresolved: no decision, and any stale suggestion is dismissed. */
  | { kind: 'skip' };
export type PendingMap = Readonly<Record<string, PendingChoice>>;

/** A candidate choice replaces whatever was pending for the field (a manual value included). */
export function chooseCandidate(pending: PendingMap, fieldPath: string, candidateId: string): PendingMap {
  return { ...pending, [fieldPath]: { kind: 'candidate', candidateId } };
}

/** A manual value replaces whatever was pending for the field (a candidate choice included). */
export function enterManual(pending: PendingMap, fieldPath: string, raw: string): PendingMap {
  return { ...pending, [fieldPath]: { kind: 'manual', raw } };
}

export function skipIssue(pending: PendingMap, fieldPath: string): PendingMap {
  return { ...pending, [fieldPath]: { kind: 'skip' } };
}

export function withoutField<T>(map: Readonly<Record<string, T>>, fieldPath: string): Record<string, T> {
  const { [fieldPath]: _removed, ...rest } = map;
  return rest;
}

/** The same value under the backend's own rule (printed-cent numbers, trimmed text) - used only to
 * recognise a previous choice among the CURRENT candidates; the submitted value is always the candidate's. */
export function valuesMatch(a: ProfileValueView, b: ProfileValueView): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] as number)) < 0.005);
  return false;
}

/** How a domain value is shown in a manual input (not a display format - round-trips through the parser). */
export function rawFromValue(value: ProfileValueView): string {
  return Array.isArray(value) ? value.join(',') : String(value);
}

/**
 * A stale decision, as a SUGGESTION: the previous choice pre-selected when it still maps to a current
 * candidate (`confirm_candidate`), otherwise - and for a correction - as a prefilled manual value. It is
 * never fabricated into a candidate and never submitted by itself.
 */
export function suggestionFor(issue: ProfileIssueView): PendingChoice | null {
  const previous = issue.previousDecision;
  if (!previous) return null;
  if (previous.kind === 'confirm_candidate') {
    const match = issue.candidates.find((c) => valuesMatch(c.value, previous.value));
    if (match) return { kind: 'candidate', candidateId: match.candidateId };
  }
  return { kind: 'manual', raw: rawFromValue(previous.value) };
}

export interface EffectiveChoice {
  choice: Exclude<PendingChoice, { kind: 'skip' }> | null;
  /** true when `choice` is only the stale suggestion and the user has not acted on it. */
  suggested: boolean;
}

/** What the card shows as selected: the user's own choice, else the stale suggestion, else nothing. */
export function effectiveChoice(issue: ProfileIssueView, pending: PendingMap): EffectiveChoice {
  const own = pending[issue.fieldPath];
  if (own) return { choice: own.kind === 'skip' ? null : own, suggested: false };
  const suggestion = suggestionFor(issue);
  return { choice: suggestion && suggestion.kind !== 'skip' ? suggestion : null, suggested: suggestion !== null };
}

/** The user acts on the stale suggestion ("use previous choice"): it becomes a real pending choice. */
export function acceptSuggestion(pending: PendingMap, issue: ProfileIssueView): PendingMap {
  const suggestion = suggestionFor(issue);
  return suggestion ? { ...pending, [issue.fieldPath]: suggestion } : pending;
}

// ---------------------------------------------------------------------------------------------
// Manual input -> a domain value (never silently changed: -95 stays -95; the backend judges it)
// ---------------------------------------------------------------------------------------------

export type ParsedValue = { ok: true; value: ProfileValueView } | { ok: false };

export function parseManualValue(input: ProfileIssueView['input'], raw: string): ParsedValue {
  switch (input.kind) {
    case 'number': {
      const s = raw.trim().replace(',', '.');
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return { ok: false };
      const n = Number(s);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    case 'enum': return input.enumValues?.includes(raw) ? { ok: true, value: raw } : { ok: false };
    case 'boolean': return raw === 'true' ? { ok: true, value: true } : raw === 'false' ? { ok: true, value: false } : { ok: false };
    case 'date': return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { ok: true, value: raw } : { ok: false };
    case 'text': return raw.trim() !== '' ? { ok: true, value: raw } : { ok: false };
    default: return { ok: false };
  }
}

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

/** Opaque and client-generated: never a candidate id, never derived from evidence. */
export function newDecisionId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  return `d-${random}`.slice(0, 64);
}

/**
 * The new decisions for the user's pending choices, in the order of the visible issues. Only a USER
 * choice becomes a decision (a stale suggestion never does). Each carries the CURRENT issue's evidence
 * fingerprint; a candidate choice is `confirm_candidate` with the candidate's own domain value, a manual
 * one `correct_value` with the issue's unit. A choice that cannot form a valid decision (unknown
 * candidate, unparsable or empty input) produces nothing.
 */
export function buildPendingDecisions(
  visible: readonly ProfileIssueView[], pending: PendingMap, makeId: () => string = newDecisionId, decidedAt: string = new Date().toISOString(),
): ProfileDecisionView[] {
  const out: ProfileDecisionView[] = [];
  for (const issue of visible) {
    const choice = pending[issue.fieldPath];
    if (!choice || choice.kind === 'skip') continue;
    if (choice.kind === 'candidate') {
      const candidate = issue.candidates.find((c) => c.candidateId === choice.candidateId);
      if (!candidate) continue;
      out.push({ kind: 'confirm_candidate', decisionId: makeId(), fieldPath: issue.fieldPath, value: candidate.value, evidenceFingerprint: issue.evidenceFingerprint, decidedAt });
      continue;
    }
    const parsed = parseManualValue(issue.input, choice.raw);
    if (!parsed.ok) continue;
    out.push({ kind: 'correct_value', decisionId: makeId(), fieldPath: issue.fieldPath, value: parsed.value, unit: issue.unit, evidenceFingerprint: issue.evidenceFingerprint, decidedAt });
  }
  return out;
}

/** One decision per field: an added decision replaces the field's earlier one (a stale one included). */
export function mergeDecisionSet(current: readonly ProfileDecisionView[], added: readonly ProfileDecisionView[]): ProfileDecisionView[] {
  const replaced = new Set(added.map((d) => d.fieldPath));
  return [...current.filter((d) => !replaced.has(d.fieldPath)), ...added];
}

/** Undo: the field's decision leaves the set; the backend rebuilds the documentary state without it. */
export function removeDecision(current: readonly ProfileDecisionView[], fieldPath: string): ProfileDecisionView[] {
  return current.filter((d) => d.fieldPath !== fieldPath);
}

/** What one Apply sends, and what is new in it. Nothing pending (or nothing valid) means nothing to send. */
export function planApply(
  visible: readonly ProfileIssueView[], pending: PendingMap, current: readonly ProfileDecisionView[], makeId?: () => string, decidedAt?: string,
): { added: ProfileDecisionView[]; sent: ProfileDecisionView[] } {
  const added = buildPendingDecisions(visible, pending, makeId, decidedAt);
  return { added, sent: added.length === 0 ? [...current] : mergeDecisionSet(current, added) };
}

export function canApply(visible: readonly ProfileIssueView[], pending: PendingMap): boolean {
  return buildPendingDecisions(visible, pending, () => 'probe', 'probe').length > 0;
}

export type DecisionProblem = NonNullable<DecisionResultView['problem']>;

/**
 * The decision set to keep after a resolve: everything the backend did not REJECT. Applied and
 * satisfied decisions stay (they keep applying while the evidence is unchanged); stale ones stay too, so
 * the backend sees them again and they come back as a `previousDecision`. A rejected one (invalid input)
 * leaves the set and is reported per field. If the results cannot be matched to what was sent, nothing is
 * dropped and nothing is claimed.
 */
export function settleDecisions(sent: readonly ProfileDecisionView[], results: readonly DecisionResultView[]): { decisions: ProfileDecisionView[]; problems: Record<string, DecisionProblem> } {
  if (results.length !== sent.length) return { decisions: [...sent], problems: {} };
  const decisions: ProfileDecisionView[] = [];
  const problems: Record<string, DecisionProblem> = {};
  sent.forEach((decision, i) => {
    const result = results[i] as DecisionResultView;
    if (result.status === 'rejected') problems[decision.fieldPath] = result.problem ?? 'invalid_value';
    else decisions.push(decision);
  });
  return { decisions, problems };
}

/** Pending choices after a resolve: a choice whose decision was sent and not rejected is now in the
 * decision set (drop it); a rejected one stays so the user can correct it; a choice for a field that is
 * no longer an open question is dropped. */
export function settlePending(pending: PendingMap, sent: readonly ProfileDecisionView[], problems: Readonly<Record<string, DecisionProblem>>, visibleAfter: readonly ProfileIssueView[]): PendingMap {
  const sentPaths = new Set(sent.map((d) => d.fieldPath));
  const stillOpen = new Set(visibleAfter.map((i) => i.fieldPath));
  const next: Record<string, PendingChoice> = {};
  for (const [fieldPath, choice] of Object.entries(pending)) {
    if (!stillOpen.has(fieldPath)) continue;
    if (sentPaths.has(fieldPath) && !problems[fieldPath]) continue;
    next[fieldPath] = choice;
  }
  return next;
}

export interface DecisionResolveOutcome {
  resolved: ResolvedProfileView;
  /** The decision set to keep (what was sent, minus rejected decisions). */
  decisions: ProfileDecisionView[];
  problems: Record<string, DecisionProblem>;
}

/**
 * THE one way the panel talks to the backend: the documents and as-of date it already has, plus the
 * COMPLETE decision set, in a single `resolveProfile` request. Apply, Undo, a new as-of date and a
 * document re-read all go through here, so the existing decisions are always resubmitted and the backend
 * (never the client) decides what applies, is satisfied, stale or rejected. `null` on failure - the
 * caller then keeps everything it has.
 */
export async function resolveWithDecisions(
  asOfDate: string, documents: ProfileRequestDocument[], sent: readonly ProfileDecisionView[], fetchImpl: typeof fetch = fetch,
): Promise<DecisionResolveOutcome | null> {
  const resolved = await resolveProfile(asOfDate, documents, fetchImpl, [...sent]);
  if (!resolved) return null;
  const settled = settleDecisions(sent, resolved.decisionResults);
  return { resolved, decisions: settled.decisions, problems: settled.problems };
}

// ---------------------------------------------------------------------------------------------
// "Resolved by you"
// ---------------------------------------------------------------------------------------------

export interface ResolvedEntry {
  fieldPath: string;
  key: string;
  meaning: string;
  unit: string;
  value: ProfileValueView;
  kind: 'confirm_candidate' | 'correct_value';
}

/** Fields whose CURRENT profile state is `user_confirmed` or `user_corrected`, in profile order. A field
 * the documents satisfy on their own is documentary (not a user state) and is never listed. */
export function resolvedByYou(profile: PayrollProfileView | null): ResolvedEntry[] {
  if (!profile) return [];
  const out: ResolvedEntry[] = [];
  const add = (fieldPath: string, field: ProfileFieldView) => {
    if ((field.state !== 'user_confirmed' && field.state !== 'user_corrected') || field.value === null) return;
    out.push({ fieldPath, key: field.key, meaning: field.meaning, unit: field.unit, value: field.value, kind: field.resolution?.kind ?? (field.state === 'user_confirmed' ? 'confirm_candidate' : 'correct_value') });
  };
  for (const [key, field] of Object.entries(profile.employment)) add(`employment.${key}`, field);
  for (const [key, field] of Object.entries(profile.payroll)) add(`payroll.${key}`, field);
  for (const [collection, fields] of Object.entries(profile.recurringItems)) for (const field of fields) add(`recurringItems.${collection}.${field.key}`, field);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Wording - what a card says (never a backend code or a field path)
// ---------------------------------------------------------------------------------------------

function lookup(table: object, key: string): string | undefined {
  const value = (table as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** `group:category:normalised description` -> the description (the user's own document text). */
function recurringDescription(key: string): string | null {
  const parts = key.split(':');
  const description = parts.slice(2).join(':').trim();
  return description === '' ? null : description;
}

/** The translated parameter name; a recurring line adds the description printed on the documents. */
export function issueTitle(issue: { fieldPath: string; key: string; meaning: string }, q: QuestionsCopy): string {
  const base = lookup(q.fields, issue.meaning) ?? q.fieldFallback;
  if (!issue.fieldPath.startsWith('recurringItems.')) return base;
  const description = recurringDescription(issue.key);
  return description ? `${base}: ${description}` : base;
}

export function reasonText(reason: { code: string }, q: QuestionsCopy): string {
  return lookup(q.reasons, reason.code) ?? q.reasonFallback;
}

export function excludedReasonText(code: string, q: QuestionsCopy): string {
  return lookup(q.excludedReasons, code) ?? q.excludedFallback;
}

export function hintText(kind: ProfileIssueView['hints'][number]['kind'], q: QuestionsCopy): string {
  return kind === 'observed_premium' ? q.hintObservedPremium
    : kind === 'superseded_value' ? q.hintSuperseded
    : kind === 'unplaceable_matching_value' ? q.hintUnplaceableMatching
    : q.hintExcluded;
}

export function problemText(problem: DecisionProblem | undefined, q: QuestionsCopy): string {
  return problem === 'invalid_value' || problem === 'unit_mismatch' ? q.problemInvalid : q.problemFallback;
}

export function severityText(severity: ProfileIssueView['severity'], q: QuestionsCopy): string {
  return severity === 'blocking' ? q.severityBlocking : q.severityOptional;
}

export function basisText(basis: 'contractual' | 'employer_applied', q: QuestionsCopy): string {
  return basis === 'contractual' ? q.basisContractual : q.basisEmployerApplied;
}

/** The summary under the panel title, from the BACKEND's readiness only (nothing is recomputed here). */
export function readinessSummary(readiness: CalculationReadinessView, q: QuestionsCopy): { message: string; counts: string } {
  return {
    message: readiness.blockingCount > 0 ? q.readinessBlocking : q.readinessReady,
    counts: q.readinessCounts(readiness.blockingCount, readiness.optionalCount),
  };
}

/** The unit shown next to a manual input (the input's own numbers are plain domain values). */
export function inputUnitLabel(unit: string, q: QuestionsCopy): string {
  if (unit === 'eur_per_hour') return `€ ${q.unitPerHour}`;
  if (unit === 'eur_per_month') return `€ ${q.unitPerMonth}`;
  if (unit === 'eur_per_year') return `€ ${q.unitPerYear}`;
  if (unit === 'eur_per_period') return `€ ${q.unitPerPeriod}`;
  if (unit === 'premium_percent' || unit === 'surcharge_percent' || unit === 'percent_of_printed_base' || unit === 'percent') return '%';
  if (unit === 'hours_per_week') return q.unitHoursPerWeek;
  if (unit === 'hours') return q.unitHours;
  if (unit === 'weeks') return q.unitWeeks;
  return '';
}

export function formatDate(iso: string, lang: Lang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m && lang === 'pl' ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

const MONEY_UNITS = new Set(['eur_per_hour', 'eur_per_month', 'eur_per_year', 'eur_per_period']);

export interface FormattedValue { value: string; unit: string }

/** A domain value for display (locale number format, currency, percent, yes/no, period type, date). The
 * submitted value is never this string. */
export function formatValue(unit: string, value: ProfileValueView, q: QuestionsCopy, lang: Lang): FormattedValue {
  const locale = lang === 'pl' ? 'pl-PL' : 'en-GB';
  if (typeof value === 'boolean') return { value: value ? q.boolYes : q.boolNo, unit: '' };
  if (Array.isArray(value)) return { value: value.join(', '), unit: '' };
  if (typeof value === 'string') {
    if (unit === 'period_type') return { value: lookup(q.periodTypes, value) ?? value, unit: '' };
    return { value: unit === 'date' ? formatDate(value, lang) : value, unit: '' };
  }
  if (MONEY_UNITS.has(unit)) {
    const unitLabel = unit === 'eur_per_hour' ? q.unitPerHour : unit === 'eur_per_month' ? q.unitPerMonth : unit === 'eur_per_year' ? q.unitPerYear : q.unitPerPeriod;
    return { value: new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(value), unit: unitLabel };
  }
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  if (unit === 'premium_percent') return { value: `+${number}%`, unit: '' };
  if (unit === 'surcharge_percent' || unit === 'percent_of_printed_base' || unit === 'percent') return { value: `${number}%`, unit: '' };
  if (unit === 'hours_per_week') return { value: number, unit: q.unitHoursPerWeek };
  if (unit === 'hours') return { value: number, unit: q.unitHours };
  if (unit === 'weeks') return { value: number, unit: q.unitWeeks };
  return { value: number, unit: '' };
}

export interface SourceChip {
  kind: 'contract' | 'annex' | 'payslip' | 'user' | 'other';
  /** The document's own name (a file label), or null (a user decision has none). */
  document: string | null;
  /** Role / date / period wording: "Aneks od …", "Pasek: …". */
  text: string;
  /** A payslip with no printed period date - it cannot be placed on the contract timeline. */
  periodUnknown: boolean;
  details: Array<{ label: string; value: string }>;
}

/** One source as a compact chip plus collapsed details (page, printed label, raw fragment). */
export function sourceChip(source: ProfileSourceView, q: QuestionsCopy, lang: Lang): SourceChip {
  const details: SourceChip['details'] = [];
  if (source.documentLabel) details.push({ label: q.detailDocument, value: source.documentLabel });
  if (source.page !== null && source.page !== undefined) details.push({ label: q.detailPage(source.page), value: '' });
  if (source.printedLabel) details.push({ label: q.detailPrintedLabel, value: source.printedLabel });
  if (source.rawValue) details.push({ label: q.detailRaw, value: source.rawValue });
  const base = { document: source.documentLabel, details } as const;
  if (source.role === 'contract_base') return { ...base, kind: 'contract', text: q.sourceContract, periodUnknown: false };
  if (source.role === 'contract_annex') return { ...base, kind: 'annex', text: source.effectiveDate ? q.sourceAnnexFrom(formatDate(source.effectiveDate, lang)) : q.sourceAnnex, periodUnknown: false };
  if (source.role === 'payslip') {
    const start = source.payPeriod?.startDate ?? null;
    const end = source.payPeriod?.endDate ?? null;
    if (!start && !end) return { ...base, kind: 'payslip', text: q.sourcePayslip, periodUnknown: true };
    const period = start && end && start !== end ? `${formatDate(start, lang)} – ${formatDate(end, lang)}` : formatDate((end ?? start) as string, lang);
    return { ...base, kind: 'payslip', text: q.sourcePayslipPeriod(period), periodUnknown: false };
  }
  if (source.role === 'user') return { document: null, details: [], kind: 'user', text: q.sourceUser, periodUnknown: false };
  return { ...base, kind: 'other', text: source.documentLabel ?? source.role, periodUnknown: false };
}
