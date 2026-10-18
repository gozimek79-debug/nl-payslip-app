/**
 * R3-B client of the existing R2 conversation route `POST /api/scenario/turn` (schema-bound, server-owned question
 * selection, deterministic interpreter first, at most one model call, deterministic fallback on timeout).
 *
 * What the interface sends is ONLY what the public route accepts: the Scenario it received back, the user's message,
 * the locale and the request-carried digest. Document facts are never sent - not as Scenario values, not as a
 * `source: document`, not as text. The one R3-B addition is `conversation.deferredFields` (selection only): the
 * questions a provisional document reading, the user's "nie wiem" or the weekly base-pay goal make unnecessary now.
 */

export type R3BLocale = 'pl' | 'en';

/** The weekly base-pay goal does not ask about tax, deductions or extras - and without them R2 stays blocked, so no
 * amount can appear. Must equal the backend generator's list (r3b-contract-fixtures.json `outOfGoalFields`). */
export const OUT_OF_GOAL_FIELDS = [
  'tax.loonheffingskorting', 'deductions.mode', 'deductions.entered.pension', 'deductions.entered.paww', 'deductions.entered.sectorPremium',
  'deductions.entered.postTaxOther', 'extras.travelAllowance', 'extras.vakantiegeld.mode', 'extras.vakantiegeld.percent',
] as const;

export const PREMIUM_FIELDS = ['pay.saturdayPremiumPercent', 'pay.sundayPremiumPercent', 'pay.publicHolidayPremiumPercent', 'pay.overtime.tier1Percent', 'pay.overtime.tier2Percent'] as const;
export const HOURS_FIELDS = ['work.hours', 'work.regularWeekdayHours', 'work.overtimeHours', 'work.saturdayHours', 'work.sundayHours', 'work.publicHolidayHours'] as const;

export interface ScenarioNodeView {
  state: 'known' | 'range' | 'alternatives' | 'conflict' | 'unknown';
  value?: unknown;
  low?: number;
  high?: number;
  options?: unknown[];
  candidates?: Array<{ value: unknown; source?: string }>;
  source?: string;
}
export interface ScenarioView {
  schemaVersion: 1;
  scenarioId: string;
  periodType: 'week';
  work: Record<string, unknown>;
  pay: Record<string, unknown>;
  tax: Record<string, unknown>;
  [key: string]: unknown;
}
export interface TurnDigestView {
  pendingQuestion?: { field: string; kind: string };
  declinedAssumptions?: string[];
  hoursClarification?: { statedWeeklyTotal?: number; weekdayOnly?: false };
  deferredFields?: string[];
}
export interface NextQuestionView {
  kind: 'provide_value' | 'offer_assumption' | 'resolve_conflict' | 'correct_value' | 'clarify_hours_composition';
  field: string;
  reasonCode: string;
  answerMode: string;
  unit?: string;
  options?: unknown[];
  candidates?: Array<{ value: unknown; source: string }>;
  canUseAssumption: boolean;
  suggestedAssumption?: { value?: unknown; options?: unknown[]; source: 'loonto_assumption' };
  fallbackOptions: string[];
  priority: number;
  prompt: { key: string; params: Record<string, string | number> };
}
export interface PublicEvaluationView {
  status: 'computed' | 'blocked' | 'invalid' | 'unsupported';
  requirements?: Array<{ field: string; reason: string }>;
  issues?: Array<{ path: string; code: string }>;
  unsupported?: Array<{ kind: string; concept?: string; capability?: string }>;
}
export interface TurnResultView {
  turnId: string;
  status: 'updated' | 'unchanged' | 'rejected';
  intent: string;
  agentStatus: string;
  scenario: ScenarioView;
  patchApplied: Array<{ op: string; field?: string; node?: ScenarioNodeView; concept?: string }> | null;
  patchIssues: Array<{ code: string; field?: string; params?: Record<string, unknown> }>;
  patchNotes: Array<{ code: string; field?: string; params?: Record<string, unknown> }>;
  evaluation: PublicEvaluationView | null;
  nextQuestion: NextQuestionView | null;
  conversation: TurnDigestView;
  responseHint: { code: string; params?: Record<string, string | number> } | null;
}

export interface TurnRequestBody {
  scenario?: ScenarioView;
  message: string;
  locale: R3BLocale;
  conversation: TurnDigestView & { deferredFields: string[] };
}

/** Append what is missing, keeping the order already established (the server's list first). */
export function unionDeferred(base: readonly string[], add: readonly string[]): string[] {
  const out = [...base];
  for (const f of add) if (!out.includes(f)) out.push(f);
  return out;
}

/**
 * The deferral list of the next request. The server's own list is kept in its order, minus document / goal deferrals
 * that no longer hold (e.g. the document was removed), but always with every field the user put aside ("nie wiem").
 */
export function nextDeferred(serverList: readonly string[], userDeferred: readonly string[], clientAdds: readonly string[]): string[] {
  const kept = serverList.filter((f) => userDeferred.includes(f) || clientAdds.includes(f));
  return unionDeferred(kept, clientAdds);
}

/** Fields the server itself deferred in this turn (the user did not know, or declined the offered assumption). */
export function serverDeferrals(sent: readonly string[], received: readonly string[] | undefined): string[] {
  return (received ?? []).filter((f) => !sent.includes(f));
}

export function buildTurnRequest(input: { scenario: ScenarioView | null; message: string; locale: R3BLocale; digest: TurnDigestView | null; deferredFields: string[] }): TurnRequestBody {
  return {
    ...(input.scenario ? { scenario: input.scenario } : {}),
    message: input.message,
    locale: input.locale,
    conversation: { ...(input.digest ?? {}), deferredFields: input.deferredFields },
  };
}

export type TurnFailure = 'network' | 'timeout' | 'rate_limited' | 'unavailable' | 'invalid' | 'server';

export async function postTurn(body: TurnRequestBody, fetchImpl: typeof fetch, timeoutMs = 25_000): Promise<{ ok: true; result: TurnResultView } | { ok: false; reason: TurnFailure }> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl('/api/scenario/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(controller ? { signal: controller.signal } : {}) });
    if (res.status === 429) return { ok: false, reason: 'rate_limited' };
    if (res.status === 503) return { ok: false, reason: 'unavailable' };
    if (res.status === 400) return { ok: false, reason: 'invalid' };
    if (!res.ok) return { ok: false, reason: 'server' };
    const result = (await res.json()) as TurnResultView;
    if (!result || typeof result !== 'object' || typeof result.status !== 'string' || !result.scenario) return { ok: false, reason: 'server' };
    return { ok: true, result };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Contract v1.1 §5 / G08 (R2 P1 is still OPEN): on a premium question, a percentage of 100 or more ("150%", "150",
 * "150 procent", "150% za sobotę") may be the TOTAL multiplier or a premium ABOVE base. R2 would store the number as
 * given; the interface therefore does not send it and asks what it means. Returns the percentage, or null.
 */
export function ambiguousTotalPercent(message: string, pendingField: string | null | undefined): number | null {
  if (!pendingField || !(PREMIUM_FIELDS as readonly string[]).includes(pendingField)) return null;
  const text = message.trim().toLowerCase();
  const withUnit = /(\d{3}(?:[.,]\d+)?)\s*(?:%|procent\w*|percent\w*|pct)/.exec(text);
  const bare = /^\+?\s*(\d{3}(?:[.,]\d+)?)$/.exec(text);
  const raw = withUnit?.[1] ?? bare?.[1];
  if (!raw) return null;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) && value >= 100 && value <= 500 ? value : null;
}

const pl = (n: number) => String(n).replace('.', ',');
/** Polish "godzina / godziny / godzin" for a count (a fraction takes "godziny"). */
export function plHours(n: number): string {
  if (!Number.isInteger(n)) return 'godziny';
  const tens = n % 100;
  const ones = n % 10;
  if (n === 1) return 'godzina';
  return ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? 'godziny' : 'godzin';
}

const DONT_KNOW: Record<R3BLocale, string> = { pl: 'Nie wiem', en: "I don't know" };
export const dontKnowReply = (locale: R3BLocale) => DONT_KNOW[locale];

/** The message sent for the user's choice of what an ambiguous percentage means. */
export function percentMeaningMessage(choice: 'total' | 'above' | 'unknown', value: number, locale: R3BLocale): string {
  if (choice === 'unknown') return DONT_KNOW[locale];
  const n = choice === 'total' ? Math.round((value - 100) * 100) / 100 : value;
  return `${locale === 'pl' ? pl(n) : String(n)}%`;
}

/**
 * Example replies for the question being asked - each is answered by R2 deterministically (no model call; the
 * backend records and checks every one of them in r3b-contract-fixtures.json `probes`).
 */
export function suggestionsFor(question: NextQuestionView | null, started: boolean, locale: R3BLocale): string[] {
  const en = locale === 'en';
  const weekdays = (n: number) => (en ? `${n} hours Monday to Friday` : `${pl(n)} ${plHours(n)} od poniedziałku do piątku`);
  const withSaturday = (n: number) => (en ? `${n - 8} hours Monday to Friday and 8 hours on Saturday` : `${pl(n - 8)} ${plHours(n - 8)} od poniedziałku do piątku i 8 godzin w sobotę`);
  if (!started) return en ? ['40 hours a week', withSaturday(40)] : ['40 godzin w tygodniu', withSaturday(40)];
  if (!question) return [];
  const total = typeof question.prompt.params.statedWeeklyTotal === 'number' ? question.prompt.params.statedWeeklyTotal : null;
  if (question.kind === 'clarify_hours_composition') return [...(total !== null ? [weekdays(total)] : []), en ? 'No' : 'Nie', DONT_KNOW[locale]];
  if (question.kind === 'offer_assumption') return en ? ['Yes', 'No', DONT_KNOW.en] : ['Tak', 'Nie', DONT_KNOW.pl];
  if (question.field === 'work.hours') {
    if (question.reasonCode === 'hours_include_other_categories') return [...(total !== null && total > 8 ? [withSaturday(total)] : []), DONT_KNOW[locale]];
    return [weekdays(40), withSaturday(40), DONT_KNOW[locale]];
  }
  if (question.kind === 'provide_value' && question.field === 'pay.hourlyRate') return [en ? '€16.80/h' : '16,80 €/h', DONT_KNOW[locale]];
  if (question.kind === 'provide_value' && (PREMIUM_FIELDS as readonly string[]).includes(question.field)) return ['50%', '150%', DONT_KNOW[locale]];
  return question.kind === 'provide_value' ? [DONT_KNOW[locale]] : [];
}

/** A Scenario value node as the interface shows it (null when the field is absent). */
export function nodeAt(scenario: ScenarioView | null, field: string): ScenarioNodeView | null {
  let cur: unknown = scenario;
  for (const part of field.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur && typeof cur === 'object' && typeof (cur as { state?: unknown }).state === 'string' ? (cur as ScenarioNodeView) : null;
}

/** A user's explicit edit, written exactly as R2 itself writes a user answer (`source: user`) - never a document value. */
export function withUserValue(scenario: ScenarioView | null, field: string, value: number, localId = 'r3b-local'): ScenarioView {
  const base: ScenarioView = scenario ? structuredClone(scenario) : { schemaVersion: 1, scenarioId: localId, periodType: 'week', work: {}, pay: {}, tax: {} };
  const parts = field.split('.');
  let cur = base as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    cur[part] = next && typeof next === 'object' ? next : {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1] as string] = { state: 'known', value, source: 'user' };
  return base;
}
