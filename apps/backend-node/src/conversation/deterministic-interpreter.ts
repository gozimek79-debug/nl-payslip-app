import { SCENARIO_FIELDS, type ScenarioFieldPath } from '../scenario/scenario-types.js';
import type { NextQuestionSpec, TurnIntent } from './conversation-types.js';
import type { ScenarioPatchV1 } from './scenario-patch.js';

/**
 * Deterministic interpretation of the short replies that need no language model (R2 §10: "no paid AI call
 * when the turn can be resolved deterministically"; Lock §42: the conversation must still work without the
 * model). It only ever answers THE question the server itself would ask now (`current`, recomputed by the
 * selector from the Scenario - never a client-supplied claim), and only for unambiguous messages:
 *   - "nie wiem" / "I don't know"            -> set_unknown on that field (never zero);
 *   - "tak" / "yes" to an assumption offer    -> accept_assumption (the catalogued value);
 *   - "nie" / "no" to an assumption offer     -> decline (no patch);
 *   - "tak" / "nie" to the tax-credit question -> applied / not_applied;
 *   - one bare number to a numeric question   -> set that number (as a USER value);
 *   - one bare number equal to a conflict candidate -> resolve_conflict.
 * Anything longer or ambiguous returns null and goes to the model (or to the fallback).
 */

export interface DeterministicInterpretation {
  intent: TurnIntent;
  patch: ScenarioPatchV1;
  /** Set when the user declined the assumption offered for this field. */
  declined?: ScenarioFieldPath;
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

/** Words allowed around a single bare number ("16,80 €", "40 h", "50%", "8 godzin"). */
const UNIT_WORDS = new Set(['eur', 'euro', 'h', 'godz', 'godzin', 'godziny', 'godzina', 'hours', 'hour', 'hrs', 'uur', 'procent', 'percent', 'proc', 'na', 'za', 'godzine', 'per', 'brutto', 'gross', 'tygodniowo', 'weekly', 'okolo', 'about', 'approx']);

function isDontKnow(normalized: string): boolean {
  if (/\d/.test(normalized)) return false;
  if (DONT_KNOW.includes(normalized)) return true;
  const words = normalized.split(' ');
  return words.length <= 6 && DONT_KNOW.some((phrase) => normalized.startsWith(`${phrase} `) || normalized.endsWith(` ${phrase}`));
}

/** The single number in a short numeric reply, or null. Decimal comma accepted. */
export function bareNumber(message: string): number | null {
  const cleaned = message.replace(/[€%/]/g, ' ').replace(/\s+/g, ' ').trim();
  const matches = cleaned.match(/-?\d+(?:[.,]\d+)?/g);
  if (!matches || matches.length !== 1) return null;
  const rest = normalize(cleaned.replace(matches[0], ' ')).split(' ').filter(Boolean);
  if (rest.length > 3 || !rest.every((w) => UNIT_WORDS.has(w))) return null;
  const value = Number(matches[0].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

const patchOf = (ops: ScenarioPatchV1['ops']): ScenarioPatchV1 => ({ version: 1, ops });

export function interpretDeterministically(message: string, current: NextQuestionSpec | null): DeterministicInterpretation | null {
  const normalized = normalize(message);
  if (!current || current.field === 'work.hours') {
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

  const number = bareNumber(message);
  if (number === null) return null;
  if (current.kind === 'resolve_conflict') {
    const pick = (current.candidates ?? []).findIndex((c) => typeof c.value === 'number' && Math.abs(c.value - number) < 1e-9);
    return pick >= 0 ? { intent: 'correction', patch: patchOf([{ op: 'resolve_conflict', field, pick }]) } : null;
  }
  if ((current.kind === 'provide_value' || current.kind === 'correct_value') && SCENARIO_FIELDS[field].kind === 'number') {
    return { intent: current.kind === 'correct_value' ? 'correction' : 'provide_information', patch: patchOf([{ op: 'set', field, value: number }]) };
  }
  return null;
}
