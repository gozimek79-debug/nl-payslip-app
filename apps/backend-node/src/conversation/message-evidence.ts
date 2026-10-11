import type { ScenarioFieldPath } from '../scenario/scenario-types.js';

/**
 * Deterministic evidence in the user's OWN, PRESENT message (Cursor re-review M1-M4, m1).
 *
 * Invariant: a number is not a classified payroll fact until the user's statement supports both its value and
 * its category. This module answers exactly that, and nothing more - it is not a language model: digits, a
 * closed list of unit words, a closed list of hours-category words (PL / EN), their negation, and clause
 * boundaries (punctuation and a few connectives). When it cannot establish support the answer is "no", and
 * the turn asks instead of writing.
 */

export type UnitClass = 'hours' | 'rate' | 'money' | 'percent' | 'per_week';
export type HoursCategory = 'weekday' | 'saturday' | 'sunday' | 'holiday' | 'overtime' | 'weekend';

/** The Scenario hours buckets and the category each one means. `weekend` is a group word, never a bucket. */
export const HOURS_FIELD_CATEGORY = {
  'work.regularWeekdayHours': 'weekday',
  'work.overtimeHours': 'overtime',
  'work.saturdayHours': 'saturday',
  'work.sundayHours': 'sunday',
  'work.publicHolidayHours': 'holiday',
} as const satisfies Partial<Record<ScenarioFieldPath, HoursCategory>>;
export type HoursBucketField = keyof typeof HOURS_FIELD_CATEGORY;

const FIELD_FOR_CATEGORY: Partial<Record<HoursCategory, HoursBucketField>> = Object.fromEntries(
  Object.entries(HOURS_FIELD_CATEGORY).map(([field, category]) => [category, field]),
);

export function isHoursBucket(field: string): field is HoursBucketField {
  return Object.prototype.hasOwnProperty.call(HOURS_FIELD_CATEGORY, field);
}

/** Lower case, no diacritics (ł -> l), no apostrophes. */
export function foldText(message: string): string {
  return message
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .replace(/[’'`]/g, '');
}

// ---------------------------------------------------------------------------------------------
// Units (F2) - classified, never stripped to make a number fit
// ---------------------------------------------------------------------------------------------

/** Order matters: compound phrases first ("per hour" is a rate, not hours). */
const UNIT_PATTERNS: ReadonlyArray<readonly [RegExp, UnitClass]> = [
  [/\b(per|na|za|an|a)\s+(godz\w*|godzin\w*|hour|hours|hr|h|uur)\b|\b(ph|hourly|godzinowa|godzinowo|stawka)\b/g, 'rate'],
  [/\b(per|na|za|a|w)\s+(week|tydzien|tyg\w*)\b|\b(weekly|tygodniowo)\b/g, 'per_week'],
  [/\b(eur|euro|euros)\b/g, 'money'],
  [/\b(percent|procent|proc|pct)\b/g, 'percent'],
  [/\b(h|hr|hrs|hour|hours|godz|godzin|godziny|godzina|uur)\b/g, 'hours'],
];

/** Classifies (and removes) the unit words of a folded text. `€`, `%`, `/` must already be spelled out. */
export function extractUnits(text: string): { units: Set<UnitClass>; rest: string } {
  let rest = ` ${text} `;
  const units = new Set<UnitClass>();
  for (const [pattern, unit] of UNIT_PATTERNS) {
    const next = rest.replace(pattern, ' ');
    if (next !== rest) {
      units.add(unit);
      rest = next;
    }
  }
  return { units, rest };
}

/** Words that carry no unit and no category and may surround a number ("about 40", "16,80 brutto"). */
export const NEUTRAL_WORDS: ReadonlySet<string> = new Set(['about', 'approx', 'approximately', 'around', 'roughly', 'ca', 'circa', 'okolo', 'ok', 'brutto', 'gross', 'bruto']);

/** A number with an hours unit or a weekly qualifier, and nothing that makes it money or a percentage. */
const HOURS_FAMILY: ReadonlySet<UnitClass> = new Set(['hours', 'per_week']);

// ---------------------------------------------------------------------------------------------
// Categories, negation, clause markers
// ---------------------------------------------------------------------------------------------

const WEEKDAY_PATTERN = /\bmon(?:day)?\s*(?:-|to|through|thru|till|until)\s*fri(?:day)?\b|\bweekdays?\b|\bweek days?\b|\bworking days?\b|\bworkdays?\b|\bbusiness days?\b|\b(?:od\s+)?poniedzial\w*\s*(?:-|do)\s*piat\w*|\bpon\w*\s*-\s*pt\b|\bpn\s*-\s*pt\b|\bdni\s+robocz\w*|\bdni\s+powszedn\w*|\bdzien\s+roboczy\b/g;
const CATEGORY_PATTERNS: ReadonlyArray<readonly [HoursCategory, RegExp]> = [
  ['weekday', WEEKDAY_PATTERN],
  ['saturday', /\bsaturdays?\b|\bsobot\w*|\bzaterdag\w*/g],
  ['sunday', /\bsundays?\b|\bniedziel\w*|\bzondag\w*/g],
  ['holiday', /\b(?:public\s+|bank\s+)?holidays?\b|\bfeestdag\w*|\bswi[ae]t\w*/g],
  ['overtime', /\bover\s?time\b|\boveruren\b|\bnadgodzin\w*|\bnadliczbow\w*|\bextra\s+hours?\b/g],
  ['weekend', /\bweekend\w*/g],
];

/** A negation anywhere earlier in the same clause denies the category ("I do not work weekdays"). */
const NEGATION = /\b(?:not|no|dont|doesnt|didnt|never|without|except|excluding|excl|neither|nor|nie|bez|oprocz|poza|nigdy|zadn\w*)\b/;
const NEGATION_WORDS = new RegExp(NEGATION.source, 'g');
/** ... or right after it ("weekdays not included", "weekendy nie"). */
const NEGATION_AFTER = /^\s*(?:\w+\s+)?(?:not|excluded|nie|wylaczone|wylaczajac)\b/;
/** "I don't know" negates knowing, not the category - removed before looking for a negation. */
const DONT_KNOW_PHRASES = /\b(?:i\s+)?(?:dont|do\s+not|did\s+not|didnt)\s+(?:know|remember)\b|\bnot\s+sure\b|\bno\s+idea\b|\bnie\s+(?:wiem|pamietam|jestem\s+pewn\w*)\b/g;

const TOTAL_MARKER = /\b(?:total|in\s+total|altogether|overall|in\s+sum|lacznie|razem|w\s+sumie|ogolem)\b/g;
const VARY_MARKER = /\b(?:vary|varies|varying|variable|different|shifts?|rota\w*|rotating|zmian\w*|zmien\w*|rozn\w*|grafik\w*)\b/g;
const PER_DAY = /\b(?:a|per)\s+day\b|\bdaily\b|\bdziennie\b|\bna\s+dzien\b|\bkazdego\s+dnia\b/;
const DISTRIBUTION_WORDS = /\b(?:even|evenly|equally|spread|each\s+day|every\s+day|per\s+day|a\s+day|daily|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|rowno|dziennie|kazdego\s+dnia|codziennie|poniedzial\w*|wtor\w*|srod\w*|czwart\w*|piat\w*)\b/;

/** Words a short hours statement may contain besides numbers, units, categories, negations and markers. */
const FILLER: ReadonlySet<string> = new Set([
  'i', 'im', 'ive', 'my', 'we', 'work', 'works', 'worked', 'working', 'do', 'did', 'does', 'have', 'had', 'on', 'in', 'at', 'the', 'a', 'an',
  'of', 'for', 'this', 'last', 'each', 'every', 'only', 'just', 'usually', 'normally', 'mostly', 'regular', 'regularly', 'normal', 'is',
  'are', 'was', 'were', 'it', 'its', 'thats', 'yes', 'yeah', 'yep', 'correct', 'right', 'exactly', 'also', 'too', 'week',
  'pracuje', 'pracowalem', 'pracowalam', 'pracowal', 'pracowala', 'pracujemy', 'robie', 'mam', 'mialem', 'mialam', 'w', 'we', 'na', 'po',
  'od', 'do', 'z', 'ze', 'tylko', 'zwykle', 'normalnie', 'regularnie', 'tak', 'zgadza', 'sie', 'to', 'sa', 'jest', 'bylo', 'moje', 'tez',
  'rowniez', 'tydzien', 'tygodniu', 'tym',
]);

// ---------------------------------------------------------------------------------------------
// Clauses
// ---------------------------------------------------------------------------------------------

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const RANGE_BETWEEN = new RegExp(String.raw`\b(?:between|miedzy|od)\s+(${NUM})\s+(?:and|a|do|to)\s+(${NUM})`, 'g');
const RANGE_PLAIN = new RegExp(String.raw`(${NUM})\s*(?:-|–|to|do)\s*(${NUM})`, 'g');
const NUMBER_TOKEN = new RegExp(String.raw`(${NUM})(?:~(${NUM}))?`, 'g');
/** Clause connectives. The Polish "i" is handled on the raw text (lower case only - not the English "I"). */
const CONNECTIVES = /\b(?:and|but|plus|including|includes|incl|with|whereas|while|of\s+which|in\s+addition|oraz|ale|natomiast|w\s+tym|lacznie\s+ze?|z\s+czego|a\s+takze)\b/g;

export interface NumberMention {
  value: number;
  /** Upper end when the user gave a range ("between 30 and 40", "30-40"); null for one number. */
  high: number | null;
  units: ReadonlySet<UnitClass>;
}
export interface CategoryMention {
  category: HoursCategory;
  negated: boolean;
}
export interface ClauseEvidence {
  text: string;
  numbers: NumberMention[];
  categories: CategoryMention[];
  perDay: boolean;
}
export interface MessageEvidence {
  clauses: ClauseEvidence[];
  numbers: NumberMention[];
  categories: CategoryMention[];
}

const toNumber = (raw: string) => Number(raw.replace(',', '.'));
const CURRENCY_BEFORE = /(?:^|\s)(?:eur|euro|euros)\s*$/;

function splitClauses(message: string): string[] {
  let text = message.replace(/(^|\s)i(?=\s)/g, '$1|');
  text = foldText(text).replace(/€/g, ' eur ').replace(/%/g, ' percent ').replace(/\//g, ' per ');
  text = text.replace(RANGE_BETWEEN, ' $1~$2 ').replace(RANGE_PLAIN, ' $1~$2 ');
  text = text.replace(/[;:!?()[\]\n"+&]/g, '|').replace(/(?<!\d)[.,]|[.,](?!\d)/g, '|').replace(CONNECTIVES, '|');
  text = text.replace(NUMBER_TOKEN, (m) => ` ${m} `);
  return text.split('|').map((c) => c.replace(/\s+/g, ' ').trim()).filter((c) => c.length > 0);
}

function clauseNumbers(clause: string): NumberMention[] {
  const matches = [...clause.matchAll(NUMBER_TOKEN)];
  return matches.map((m, i) => {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    let units: Set<UnitClass>;
    if (matches.length === 1) {
      units = extractUnits(clause.slice(0, start) + ' ' + clause.slice(end)).units;
    } else {
      // Several numbers in one clause: a number owns the words up to the next number, and a currency word
      // written directly before it ("40 hours and €16.80": the euro belongs to 16.80, not to 40).
      const nextStart = matches[i + 1]?.index ?? clause.length;
      const prevEnd = i > 0 ? (matches[i - 1]!.index ?? 0) + matches[i - 1]![0].length : 0;
      const following = clause.slice(end, nextStart).replace(CURRENCY_BEFORE, ' ');
      units = extractUnits(following).units;
      if (CURRENCY_BEFORE.test(clause.slice(prevEnd, start))) units.add('money');
    }
    return { value: toNumber(m[1] as string), high: m[2] !== undefined ? toNumber(m[2]) : null, units };
  });
}

function clauseCategories(clause: string): CategoryMention[] {
  const out: CategoryMention[] = [];
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    for (const m of clause.matchAll(pattern)) {
      const index = m.index ?? 0;
      const before = clause.slice(0, index).replace(DONT_KNOW_PHRASES, ' ');
      const after = clause.slice(index + m[0].length);
      out.push({ category, negated: NEGATION.test(before) || NEGATION_AFTER.test(after) });
    }
  }
  return out;
}

export function analyzeMessage(message: string): MessageEvidence {
  const clauses = splitClauses(message).map((text) => ({ text, numbers: clauseNumbers(text), categories: clauseCategories(text), perDay: PER_DAY.test(text) }));
  return { clauses, numbers: clauses.flatMap((c) => c.numbers), categories: clauses.flatMap((c) => c.categories) };
}

// ---------------------------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------------------------

export const sameNumber = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const isHoursQuantity = (n: NumberMention) => [...n.units].every((u) => HOURS_FAMILY.has(u));
const sameQuantity = (n: NumberMention, value: number, high: number | null) =>
  high === null ? n.high === null && sameNumber(n.value, value) : n.high !== null && sameNumber(n.value, value) && sameNumber(n.high, high);

/** m1: the message affirmatively says the hours are Monday-Friday / weekday hours ("not weekdays" does not). */
export function statesWeekdaySemantics(message: string): boolean {
  return analyzeMessage(message).categories.some((m) => m.category === 'weekday' && !m.negated);
}

/** The message names another kind of hours, or denies that the hours are weekday hours. */
export function mentionsOtherHours(e: MessageEvidence): boolean {
  return e.categories.some((m) => (m.negated ? m.category === 'weekday' : m.category !== 'weekday'));
}

/** The category is named in the message and never denied. */
export function namesCategory(e: MessageEvidence, category: HoursCategory): boolean {
  return e.categories.some((m) => m.category === category && !m.negated) && !e.categories.some((m) => m.category === category && m.negated);
}

/** The message mentions this exact number (or range end). */
export function mentionsNumber(e: MessageEvidence, value: number): boolean {
  return e.numbers.some((n) => sameNumber(n.value, value) || (n.high !== null && sameNumber(n.high, value)));
}

/**
 * M4 / m1: the message states THIS quantity for THIS category - one clause holding exactly that one number
 * (an hours quantity, not money or a percentage) and that category, and no other kind of hours. For weekday
 * hours the category may also come from the rest of a message whose only number it is ("I work Monday to
 * Friday, 40 hours"). A category the message denies anywhere is never supported.
 */
export function supportsHoursQuantity(e: MessageEvidence, category: HoursCategory, value: number, high: number | null): boolean {
  if (e.categories.some((m) => m.category === category && m.negated)) return false;
  const inClause = e.clauses.some((c) => {
    if (c.numbers.length !== 1 || c.perDay) return false;
    const n = c.numbers[0] as NumberMention;
    if (!sameQuantity(n, value, high) || !isHoursQuantity(n)) return false;
    const named = c.categories.filter((m) => !m.negated).map((m) => m.category);
    // weekday wording only qualifies overtime ("5 overtime hours Monday to Friday") - it is not another kind
    return named.includes(category) && named.every((k) => k === category || (category === 'overtime' && k === 'weekday'));
  });
  if (inClause || category !== 'weekday') return inClause;
  if (e.numbers.length !== 1 || e.clauses.some((c) => c.perDay)) return false;
  const only = e.numbers[0] as NumberMention;
  const named = e.categories.filter((m) => !m.negated).map((m) => m.category);
  return sameQuantity(only, value, high) && isHoursQuantity(only) && named.includes('weekday') && named.every((k) => k === 'weekday');
}

/**
 * M1 / M4: an hours total the user stated WITHOUT classifying it ("40 hours a week", "40 hours total, including
 * 8 on Saturday" -> 40): a clause with one hours number (with an hours unit or weekly qualifier) and no
 * category. Never a Scenario fact - at most the parameter of the one composition clarification.
 */
export function unclassifiedHoursTotal(e: MessageEvidence): number | null {
  for (const c of e.clauses) {
    if (c.numbers.length !== 1 || c.perDay) continue;
    const n = c.numbers[0] as NumberMention;
    if (n.high !== null || n.units.size === 0 || !isHoursQuantity(n)) continue;
    if (c.categories.some((m) => !m.negated)) continue;
    return n.value;
  }
  return null;
}

/** The message describes how overtime falls over the days ("evenly", "1 hour each day", "on Monday") -
 * "Monday to Friday" names the weekday category, not a distribution. */
export function describesDistribution(e: MessageEvidence): boolean {
  return e.clauses.some((c) => DISTRIBUTION_WORDS.test(c.text.replace(WEEKDAY_PATTERN, ' ')));
}

/** The whole message is one number or one range plus unit words only ("40", "40 hours", "between 30 and 40"). */
export function pureQuantityAnswer(e: MessageEvidence): NumberMention | null {
  if (e.clauses.length !== 1 || e.numbers.length !== 1) return null;
  const rest = extractUnits((e.clauses[0] as ClauseEvidence).text.replace(NUMBER_TOKEN, ' ')).rest;
  return rest.split(/\s+/).every((w) => w.length === 0 || NEUTRAL_WORDS.has(w)) ? (e.numbers[0] as NumberMention) : null;
}

// ---------------------------------------------------------------------------------------------
// Deterministic hours statements (no model needed)
// ---------------------------------------------------------------------------------------------

export type HoursStatement =
  | { kind: 'categorized'; values: Array<{ field: HoursBucketField; value: number; high: number | null }> }
  | { kind: 'total'; total: number; otherCategories: boolean };

function leftoverWords(clause: string): string[] {
  let rest = extractUnits(clause.replace(NUMBER_TOKEN, ' ')).rest;
  for (const [, pattern] of CATEGORY_PATTERNS) rest = rest.replace(pattern, ' ');
  rest = rest.replace(NEGATION_WORDS, ' ').replace(TOTAL_MARKER, ' ').replace(VARY_MARKER, ' ');
  return rest.split(/\s+/).filter((w) => w.length > 0 && !FILLER.has(w) && !NEUTRAL_WORDS.has(w));
}

/**
 * A short hours statement understood without a model, on an hours question:
 *   - "40 hours Monday to Friday", "Saturday 8 hours", "32 Mon-Fri and 8 on Saturday", "5 overtime hours"
 *       -> categorized: each number with exactly the one kind the user named;
 *   - "40 hours a week", "40 godzin tygodniowo", "40 hours including weekends", "40 hours, shifts vary",
 *     "40 hours, not weekdays", "40 hours total, including 8 Saturday"
 *       -> total: NOTHING is classified; the total only parameterises the composition clarification.
 * Anything else (another word, money, a percentage, a per-day figure, two numbers in one clause) -> null.
 */
export function parseHoursStatement(message: string): HoursStatement | null {
  const e = analyzeMessage(message);
  const categorized: Array<{ field: HoursBucketField; value: number; high: number | null }> = [];
  const totals: NumberMention[] = [];
  for (const c of e.clauses) {
    if (leftoverWords(c.text).length > 0) return null;
    if (c.numbers.length === 0) continue;
    if (c.numbers.length > 1 || c.perDay) return null;
    const n = c.numbers[0] as NumberMention;
    if (!isHoursQuantity(n)) return null;
    const named = [...new Set(c.categories.filter((m) => !m.negated).map((m) => m.category))];
    const kinds = named.includes('overtime') ? named.filter((k) => k !== 'weekday') : named;
    if (kinds.length === 0) {
      if (n.units.size === 0 || n.high !== null) return null; // a bare number or a range is not a stated total
      totals.push(n);
      continue;
    }
    const field = kinds.length === 1 ? FIELD_FOR_CATEGORY[kinds[0] as HoursCategory] : undefined;
    if (!field || categorized.some((v) => v.field === field)) return null;
    if (e.categories.some((m) => m.negated && m.category === HOURS_FIELD_CATEGORY[field])) return null;
    categorized.push({ field, value: n.value, high: n.high });
  }
  if (totals.length > 1) return null;
  const total = totals[0];
  if (total) {
    if (categorized.length === 0 && supportsHoursQuantity(e, 'weekday', total.value, null)) {
      return { kind: 'categorized', values: [{ field: 'work.regularWeekdayHours', value: total.value, high: null }] };
    }
    return { kind: 'total', total: total.value, otherCategories: categorized.length > 0 || mentionsOtherHours(e) };
  }
  return categorized.length > 0 ? { kind: 'categorized', values: categorized } : null;
}
