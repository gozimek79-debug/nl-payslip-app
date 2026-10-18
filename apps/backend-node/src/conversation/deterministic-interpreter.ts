import { SCENARIO_FIELDS, type ScenarioFieldPath, type ScenarioUnit } from '../scenario/scenario-types.js';
import type { AnswerNotAppliedReason, HoursClarification, NextQuestionSpec, TurnIntent } from './conversation-types.js';
import { extractUnits, isHoursBucket, NEUTRAL_WORDS, parseHoursStatement, type UnitClass } from './message-evidence.js';
import type { PatchOp, ScenarioPatchV1 } from './scenario-patch.js';

export { statesWeekdaySemantics, type UnitClass } from './message-evidence.js';

/**
 * Deterministic interpretation of the short replies that need no language model (R2 §10: "no paid AI call
 * when the turn can be resolved deterministically"; Lock §42: the conversation must still work without the
 * model). It only ever answers THE question the server itself would ask now (`current`, recomputed by the
 * selector from the Scenario - never a client-supplied claim), and only for unambiguous messages:
 *   - "nie wiem" / "I don't know"            -> set_unknown on that field (never zero);
 *       on the opening hours question (M1)   -> NOTHING is written: the user does not know their hours in
 *                                               general, which is not a weekday-hours fact; the hours question
 *                                               stays open with its split / range ways forward;
 *   - "tak" / "yes" to an assumption offer    -> accept_assumption (the catalogued value);
 *   - "nie" / "no" to an assumption offer     -> decline (no patch);
 *   - "nie wiem" to an assumption offer (R3-B) -> NOT an acceptance (Contract v1.1, CEO decision 10): nothing is
 *       written and no model is asked to guess what the user meant;
 *   - "tak" / "nie" to the tax-credit question -> applied / not_applied;
 *   - "tak" / "yes" to the hours-composition clarification (M2) -> NOTHING is written: the total it would
 *       confirm comes from the request-carried digest, which is untrusted; the user is asked to state the
 *       number and the kind ("40 hours Monday to Friday"); "nie" / "no" -> ask for the split;
 *   - an hours statement on an hours question (M1/M4) -> only what the user classified ("40 hours Monday to
 *       Friday", "8 hours on Saturday"); an unclassified total ("40 hours a week") -> one clarification;
 *   - one number whose unit agrees with the question's unit (F2) -> set that number (as a USER value);
 *     a unit that contradicts the question (M3) -> nothing written, no model call, the question stays;
 *   - one number equal to a conflict candidate -> resolve_conflict.
 * Anything longer or ambiguous returns null and goes to the model (or to the fallback). A unit is never
 * stripped to make a number fit.
 */

export interface DeterministicInterpretation {
  intent: TurnIntent;
  patch: ScenarioPatchV1;
  /** Set when the user declined the assumption offered for this field. */
  declined?: ScenarioFieldPath;
  /** Set when the user stated an unclassified hours total, or answered the composition clarification with "no". */
  hoursClarification?: HoursClarification;
  /** M1-M3: the reply was understood but deliberately not applied, and why. */
  notApplied?: AnswerNotAppliedReason;
}

function normalize(message: string): string {
  return message
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'l')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[!?.,;:()"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DONT_KNOW = [
  'nie wiem', 'nie mam pojecia', 'nie jestem pewien', 'nie jestem pewna', 'nie pamietam', 'trudno powiedziec', 'nie wiem niestety',
  'i dont know', 'dont know', 'i do not know', 'no idea', 'not sure', 'im not sure', 'i am not sure', 'idk', 'dunno', 'no clue',
];
const YES = ['tak', 'ok', 'okej', 'okay', 'dobrze', 'zgoda', 'jasne', 'pewnie', 'niech bedzie', 'moze byc', 'przyjmuje', 'tak przyjmij', 'yes', 'yep', 'yeah', 'sure', 'fine', 'sounds good', 'go ahead', 'agreed', 'accept', 'yes please'];
const NO = ['nie', 'no', 'nope', 'nie chce', 'wole nie', 'nie dziekuje', 'no thanks', 'i dont want', 'decline'];

function isDontKnow(normalized: string): boolean {
  if (/\d/.test(normalized)) return false;
  if (DONT_KNOW.includes(normalized)) return true;
  const words = normalized.split(' ');
  return words.length <= 6 && DONT_KNOW.some((phrase) => normalized.startsWith(`${phrase} `) || normalized.endsWith(` ${phrase}`));
}

// ---------------------------------------------------------------------------------------------
// F2: unit-aware numeric answers
// ---------------------------------------------------------------------------------------------

/**
 * The single number in a short reply, with every unit the reply attaches to it. Units are CLASSIFIED,
 * never stripped: "40 hours" is {40, hours}, "50%" is {50, percent}, "€16,80 per hour" is {16.8, money+rate}.
 * Returns null for zero or several numbers, or for any word that is neither a known unit nor neutral.
 */
export function parseNumericAnswer(message: string): { value: number; units: Set<UnitClass> } | null {
  const numbers = message.match(/-?\d+(?:[.,]\d+)?/g);
  if (!numbers || numbers.length !== 1) return null;
  const value = Number((numbers[0] as string).replace(',', '.'));
  if (!Number.isFinite(value)) return null;

  const { units, rest } = extractUnits(normalize(message.replace(numbers[0] as string, ' ').replace(/€/g, ' eur ').replace(/%/g, ' percent ').replace(/\//g, ' per ')));
  const leftover = rest.split(' ').filter((w) => w.length > 0 && !NEUTRAL_WORDS.has(w));
  if (leftover.length > 0) return null;
  return { value, units };
}

/** Which unit classes a field accepts. An empty set (a bare number) is always acceptable. */
const UNITS_FOR: Record<ScenarioUnit, ReadonlySet<UnitClass>> = {
  hours: new Set<UnitClass>(['hours', 'per_week']),
  hours_per_day: new Set<UnitClass>(['hours']),
  eur_per_hour: new Set<UnitClass>(['money', 'rate']),
  eur_per_week: new Set<UnitClass>(['money', 'per_week']),
  premium_percent: new Set<UnitClass>(['percent']),
  percent: new Set<UnitClass>(['percent']),
};

/** Unit families: whether a number stated with these units can be a value of this field at all (M3). */
export function unitsFitField(field: ScenarioFieldPath, units: ReadonlySet<UnitClass>): boolean {
  const spec = SCENARIO_FIELDS[field];
  if (spec.kind !== 'number') return false;
  const allowed = UNITS_FOR[spec.unit];
  for (const unit of units) if (!allowed.has(unit)) return false;
  return true;
}

/**
 * Whether a one-number reply ANSWERS this field's question. Stricter than `unitsFitField` for weekday hours
 * (M1): a weekly qualifier ("40 hours a week", "tygodniowo") marks a weekly total of all kinds of hours, which
 * is not evidence that the hours are Monday-Friday regular hours - even when that is the question asked.
 */
export function answerFitsField(field: ScenarioFieldPath, units: ReadonlySet<UnitClass>): boolean {
  if (field === 'work.regularWeekdayHours' && units.has('per_week')) return false;
  return unitsFitField(field, units);
}

/** The number of a reply that carries NO unit at all, else null. */
export function bareNumber(message: string): number | null {
  const parsed = parseNumericAnswer(message);
  return parsed && parsed.units.size === 0 ? parsed.value : null;
}

const patchOf = (ops: ScenarioPatchV1['ops']): ScenarioPatchV1 => ({ version: 1, ops });
const notApplied = (reason: AnswerNotAppliedReason, intent: TurnIntent = 'provide_information'): DeterministicInterpretation => ({ intent, patch: patchOf([]), notApplied: reason });

/** M1 / M4: an hours statement understood without a model; null when the message is not one. */
function interpretHoursStatement(message: string, current: NextQuestionSpec): DeterministicInterpretation | null {
  const statement = parseHoursStatement(message);
  if (!statement) return null;
  if (statement.kind === 'categorized') {
    const ops: PatchOp[] = statement.values.map((v) => (v.high === null ? { op: 'set', field: v.field, value: v.value } : { op: 'set_range', field: v.field, low: v.value, high: v.high }));
    return { intent: 'provide_information', patch: patchOf(ops) };
  }
  if (current.field !== 'work.hours') return notApplied('weekly_total_not_category');
  // An unclassified total is never written - it only parameterises the composition clarification.
  const splitAsked = current.kind === 'provide_value' && current.reasonCode === 'hours_include_other_categories';
  return {
    intent: 'provide_information',
    patch: patchOf([]),
    hoursClarification: { statedWeeklyTotal: statement.total, ...(statement.otherCategories || splitAsked ? { weekdayOnly: false as const } : {}) },
  };
}

export function interpretDeterministically(message: string, current: NextQuestionSpec | null): DeterministicInterpretation | null {
  const normalized = normalize(message);
  if (!current) return null;

  // The opening / composition hours questions are about the virtual `work.hours`.
  if (current.field === 'work.hours') {
    // M1: "I don't know" about hours in general classifies nothing - no zero, no weekday-unknown node, no
    // assumption. The open hours question (split by kind, or a range) is the way forward.
    if (isDontKnow(normalized)) return { intent: 'dont_know', patch: patchOf([]) };
    if (current.kind === 'clarify_hours_composition') {
      // M2: the total being confirmed is request-carried and untrusted - a bare "yes" never writes it.
      if (YES.includes(normalized)) return notApplied('explicit_hours_required');
      if (NO.includes(normalized)) {
        const total = current.prompt.params.statedWeeklyTotal;
        return { intent: 'provide_information', patch: patchOf([]), hoursClarification: { ...(typeof total === 'number' ? { statedWeeklyTotal: total } : {}), weekdayOnly: false } };
      }
    }
    return interpretHoursStatement(message, current);
  }
  const field = current.field;

  if (current.kind === 'offer_assumption') {
    if (YES.includes(normalized)) return { intent: 'accept_assumption', patch: patchOf([{ op: 'accept_assumption', field }]) };
    if (NO.includes(normalized)) return { intent: 'decline_assumption', patch: patchOf([]), declined: field };
    if (isDontKnow(normalized)) return { intent: 'dont_know', patch: patchOf([]) };
    return null;
  }

  if (isDontKnow(normalized)) {
    if (current.kind === 'provide_value') return { intent: 'dont_know', patch: patchOf([{ op: 'set_unknown', field }]) };
    return null;
  }

  if (current.kind === 'provide_value' && field === 'tax.loonheffingskorting') {
    if (YES.includes(normalized)) return { intent: 'provide_information', patch: patchOf([{ op: 'set', field, value: 'applied' }]) };
    if (NO.includes(normalized)) return { intent: 'provide_information', patch: patchOf([{ op: 'set', field, value: 'not_applied' }]) };
    return null;
  }

  if (SCENARIO_FIELDS[field].kind !== 'number') return null;
  const parsed = parseNumericAnswer(message);
  if (parsed && !answerFitsField(field, parsed.units)) {
    // M3: the server KNOWS this number is not a value of this field ("40 hours" asked for an hourly rate). Not
    // written, and no model call either: a model could only ignore - or break - that known contradiction.
    const weeklyTotal = isHoursBucket(field) && unitsFitField(field, parsed.units);
    return notApplied(weeklyTotal ? 'weekly_total_not_category' : 'unit_mismatch', 'unclear');
  }
  if (!parsed && isHoursBucket(field) && (current.kind === 'provide_value' || current.kind === 'correct_value')) {
    return interpretHoursStatement(message, current);
  }
  if (!parsed) return null;
  if (current.kind === 'resolve_conflict') {
    const pick = (current.candidates ?? []).findIndex((c) => typeof c.value === 'number' && Math.abs(c.value - parsed.value) < 1e-9);
    return pick >= 0 ? { intent: 'correction', patch: patchOf([{ op: 'resolve_conflict', field, pick }]) } : null;
  }
  if (current.kind === 'provide_value' || current.kind === 'correct_value') {
    return { intent: current.kind === 'correct_value' ? 'correction' : 'provide_information', patch: patchOf([{ op: 'set', field, value: parsed.value }]) };
  }
  return null;
}
