import { SCENARIO_FIELDS, type ScenarioFieldPath, type ScenarioUnit } from '../scenario/scenario-types.js';
import type { HoursClarification, NextQuestionSpec, TurnIntent } from './conversation-types.js';
import type { ScenarioPatchV1 } from './scenario-patch.js';

/**
 * Deterministic interpretation of the short replies that need no language model (R2 §10: "no paid AI call
 * when the turn can be resolved deterministically"; Lock §42: the conversation must still work without the
 * model). It only ever answers THE question the server itself would ask now (`current`, recomputed by the
 * selector from the Scenario - never a client-supplied claim), and only for unambiguous messages:
 *   - "nie wiem" / "I don't know"            -> set_unknown on that field (never zero);
 *       on the opening hours question (F5)   -> set_unknown on WEEKDAY REGULAR hours, so the next question is
 *                                               a concrete, fallback-bearing one instead of the same dead end;
 *   - "tak" / "yes" to an assumption offer    -> accept_assumption (the catalogued value);
 *   - "nie" / "no" to an assumption offer     -> decline (no patch);
 *   - "tak" / "nie" to the tax-credit question -> applied / not_applied;
 *   - "tak" / "nie" to the hours-composition clarification (F1) -> the stated total IS / is NOT
 *       Monday-Friday regular hours (only the user's explicit "yes" commits it);
 *   - one number whose unit agrees with the question's unit (F2) -> set that number (as a USER value);
 *   - one number equal to a conflict candidate -> resolve_conflict.
 * Anything longer, ambiguous or with a contradictory unit returns null and goes to the model (or to the
 * fallback). A unit is never stripped to make a number fit.
 */

export interface DeterministicInterpretation {
  intent: TurnIntent;
  patch: ScenarioPatchV1;
  /** Set when the user declined the assumption offered for this field. */
  declined?: ScenarioFieldPath;
  /** Set when the user answered the hours-composition clarification with "no". */
  hoursClarification?: HoursClarification;
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

export type UnitClass = 'hours' | 'rate' | 'money' | 'percent' | 'per_week';

/** Words that carry no unit and may surround a number ("about 40", "16,80 brutto"). */
const NEUTRAL_WORDS = new Set(['about', 'approx', 'approximately', 'around', 'roughly', 'ca', 'circa', 'okolo', 'ok', 'brutto', 'gross', 'bruto']);

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

  let rest = ` ${normalize(message.replace(numbers[0] as string, ' ').replace(/€/g, ' eur ').replace(/%/g, ' percent ').replace(/\//g, ' per '))} `;
  const units = new Set<UnitClass>();
  const take = (pattern: RegExp, unit: UnitClass) => {
    if (pattern.test(rest)) {
      units.add(unit);
      rest = rest.replace(pattern, ' ');
    }
  };
  // Order matters: compound phrases first ("per hour" is a rate, not hours).
  take(/\b(per|na|za|an|a)\s+(godz\w*|godzin\w*|hour|hours|hr|h|uur)\b|\b(ph|hourly|godzinowa|godzinowo|stawka)\b/g, 'rate');
  take(/\b(per|na|za|a|w)\s+(week|tydzien|tyg\w*)\b|\b(weekly|tygodniowo)\b/g, 'per_week');
  take(/\b(eur|euro|euros)\b/g, 'money');
  take(/\b(percent|procent|proc|pct)\b/g, 'percent');
  take(/\b(h|hr|hrs|hour|hours|godz|godzin|godziny|godzina|uur)\b/g, 'hours');
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

export function unitsFitField(field: ScenarioFieldPath, units: ReadonlySet<UnitClass>): boolean {
  const spec = SCENARIO_FIELDS[field];
  if (spec.kind !== 'number') return false;
  const allowed = UNITS_FOR[spec.unit];
  for (const unit of units) if (!allowed.has(unit)) return false;
  return true;
}

/** The number of a reply that carries NO unit at all, else null. */
export function bareNumber(message: string): number | null {
  const parsed = parseNumericAnswer(message);
  return parsed && parsed.units.size === 0 ? parsed.value : null;
}

const patchOf = (ops: ScenarioPatchV1['ops']): ScenarioPatchV1 => ({ version: 1, ops });

export function interpretDeterministically(message: string, current: NextQuestionSpec | null): DeterministicInterpretation | null {
  const normalized = normalize(message);
  if (!current) return null;

  // The opening / composition hours questions are about the virtual `work.hours`.
  if (current.field === 'work.hours') {
    if (isDontKnow(normalized)) {
      // F5: never zero, never invented hours, never an assumption. The user does not know their hours, so
      // the concrete weekday-regular-hours field is recorded as UNKNOWN; the selector then asks that one
      // specific field with real ways forward (range, split) instead of repeating the opening question.
      return { intent: 'dont_know', patch: patchOf([{ op: 'set_unknown', field: 'work.regularWeekdayHours' }]) };
    }
    if (current.kind === 'clarify_hours_composition') {
      const total = current.prompt.params.statedWeeklyTotal;
      if (YES.includes(normalized) && typeof total === 'number') {
        // The question asked whether THESE hours are Monday-Friday regular hours - an explicit yes.
        return { intent: 'provide_information', patch: patchOf([{ op: 'set', field: 'work.regularWeekdayHours', value: total }]) };
      }
      if (NO.includes(normalized)) {
        return { intent: 'provide_information', patch: patchOf([]), hoursClarification: { ...(typeof total === 'number' ? { statedWeeklyTotal: total } : {}), weekdayOnly: false } };
      }
    }
    return null;
  }
  const field = current.field;

  if (current.kind === 'offer_assumption') {
    if (YES.includes(normalized)) return { intent: 'accept_assumption', patch: patchOf([{ op: 'accept_assumption', field }]) };
    if (NO.includes(normalized)) return { intent: 'decline_assumption', patch: patchOf([]), declined: field };
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

  const parsed = parseNumericAnswer(message);
  if (!parsed || SCENARIO_FIELDS[field].kind !== 'number' || !unitsFitField(field, parsed.units)) return null;
  if (current.kind === 'resolve_conflict') {
    const pick = (current.candidates ?? []).findIndex((c) => typeof c.value === 'number' && Math.abs(c.value - parsed.value) < 1e-9);
    return pick >= 0 ? { intent: 'correction', patch: patchOf([{ op: 'resolve_conflict', field, pick }]) } : null;
  }
  if (current.kind === 'provide_value' || current.kind === 'correct_value') {
    return { intent: current.kind === 'correct_value' ? 'correction' : 'provide_information', patch: patchOf([{ op: 'set', field, value: parsed.value }]) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// F1: weekday-semantics evidence in the user's own words
// ---------------------------------------------------------------------------------------------

/** True when the message itself says the hours are Monday-Friday / weekday / working-day hours (PL / EN). */
export function statesWeekdaySemantics(message: string): boolean {
  const n = normalize(message);
  return (
    /\b(mon(day)?\s*(-|to|through|thru|till|until)\s*fri(day)?|weekdays?|week days?|working days?|workdays?|business days?)\b/.test(n) ||
    /\b(od\s+)?poniedzial\w*\s*(-|do)\s*piat\w*|\bpon\w*\s*-\s*pt\b|\bpn\s*-\s*pt\b|\bdni\s+robocz\w*|\bdni\s+powszedn\w*/.test(n)
  );
}

/** True when the reply confirms weekday-only without mentioning any other kind of hours. */
export function confirmsWeekdayOnly(message: string): boolean {
  const n = normalize(message);
  if (/\b(no|nie|not|nope|except|oprocz|include|including|incl|plus|weekend\w*|saturday\w*|sunday\w*|sobot\w*|niedziel\w*|holiday\w*|swiet\w*|shift\w*|zmian\w*|overtime|nadgodzin\w*)\b/.test(n)) return false;
  return /\b(yes|yep|yeah|correct|right|exactly|only|tak|zgadza|dokladnie|tylko|owszem)\b/.test(n);
}
