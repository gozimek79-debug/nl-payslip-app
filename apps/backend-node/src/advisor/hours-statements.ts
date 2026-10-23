import { parseAmountToken } from './grounding.js';

/**
 * AI-001 P0-1: what the USER actually said about working days and hours - the provenance the orientation tool checks
 * before it multiplies anything. Three separate kinds of statement, never derived from one another:
 *   - days      "7 dni w tygodniu", "od poniedziałku do niedzieli", "Monday to Friday", "every day of the week", "pięć dni"
 *   - perDay    "po 8 h", "8 godzin dziennie", "8 hours a day", "daily 8h"
 *   - totals    "56 godzin", "40 h", "56 hours" (a number of hours that is not a per-day statement)
 * "7 dni, 56 godzin" states days 7 and total 56 - NOT 8 hours per day. "8 godzin dziennie" states per-day 8 - NOT 7 days.
 * A bare "codziennie" / "every day" does not say whether the weekend is included, so it states no day count.
 *
 * Confirmation: a short "tak" / "yes" answers the advisor's previous message; it grounds a value only when that message
 * named exactly ONE value of the kind (so "od poniedziałku do piątku czy 7 dni?" + "tak" grounds nothing). A bare number
 * answers the advisor's question about days / hours per day / hours.
 */

export interface HourStatements {
  days: number[];
  perDay: number[];
  totals: number[];
  /** FIN-03: WHICH days, when the user said so: an explicit range ("od poniedziałku do piątku") or all seven days. */
  spans: DaySpan[];
  /** FIN-03: a base hourly rate the user stated as such ("po 16 €" after hours, "16 € za godzinę", "stawka 16 €"). */
  rates: number[];
}

export type DaySpan = 'mon-fri' | 'mon-sat' | 'mon-sun';
const SPAN_OF_RANGE: Record<string, DaySpan> = { '1-5': 'mon-fri', '1-6': 'mon-sat', '1-7': 'mon-sun' };

export interface DialogueTurn {
  role: 'user' | 'assistant';
  text: string;
}

const L = '\\p{L}';
const NUM = '(\\d{1,3}(?:[.,]\\d{1,2})?)';
const HOUR_UNIT = `(?:h|godz${L}*|hours?|hrs?|uur)(?![${L}])`;
const PER_DAY = `(?:dziennie|na dzień|każdego dnia|codziennie|a day|per day|each day|every day|daily|\\/\\s*(?:dzień|day|d)(?![${L}]))`;
const before = `(?<![${L}\\d.,])`;

const WEEKDAYS: Array<[RegExp, number]> = [
  [new RegExp(`^(?:poniedział${L}*|pon\\.?|pn\\.?|monday|mon\\.?)$`, 'iu'), 1],
  [new RegExp(`^(?:wtor${L}*|wt\\.?|tuesday|tue\\.?|tues\\.?)$`, 'iu'), 2],
  [new RegExp(`^(?:środ${L}*|śr\\.?|sr\\.?|wednesday|wed\\.?)$`, 'iu'), 3],
  [new RegExp(`^(?:czwart${L}*|czw\\.?|thursday|thu\\.?|thurs\\.?)$`, 'iu'), 4],
  [new RegExp(`^(?:piąt${L}*|piat${L}*|pt\\.?|friday|fri\\.?)$`, 'iu'), 5],
  [new RegExp(`^(?:sobot${L}*|sob\\.?|saturday|sat\\.?)$`, 'iu'), 6],
  [new RegExp(`^(?:niedziel${L}*|niedz\\.?|ndz\\.?|nd\\.?|sunday|sun\\.?)$`, 'iu'), 7],
];
const DAY_TOKEN = `(?:poniedział${L}*|pon\\.?|pn\\.?|monday|mon\\.?|wtor${L}*|wt\\.?|tuesday|tues?\\.?|środ${L}*|śr\\.?|wednesday|wed\\.?|czwart${L}*|czw\\.?|thursday|thu(?:rs)?\\.?|piąt${L}*|piat${L}*|pt\\.?|friday|fri\\.?|sobot${L}*|sob\\.?|saturday|sat\\.?|niedziel${L}*|niedz\\.?|ndz\\.?|nd\\.?|sunday|sun\\.?)`;
const RANGE = new RegExp(`(?<![${L}])(${DAY_TOKEN})\\s*(?:do|–|—|-|to|till|until|through|thru)\\s*(${DAY_TOKEN})(?![${L}])`, 'giu');

const WORD_NUMBERS: Record<string, number> = {
  jeden: 1, jednego: 1, dwa: 2, dwóch: 2, trzy: 3, trzech: 3, cztery: 4, czterech: 4, pięć: 5, pieć: 5, pięciu: 5, sześć: 6, sześciu: 6, siedem: 7, siedmiu: 7,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
};
const DAY_ADJECTIVES: Array<[RegExp, number]> = [
  [new RegExp(`dwudniow${L}*|two-day`, 'iu'), 2], [new RegExp(`trzydniow${L}*|three-day`, 'iu'), 3], [new RegExp(`czterodniow${L}*|four-day`, 'iu'), 4],
  [new RegExp(`pięciodniow${L}*|five-day`, 'iu'), 5], [new RegExp(`sześciodniow${L}*|six-day`, 'iu'), 6], [new RegExp(`siedmiodniow${L}*|seven-day`, 'iu'), 7],
];
/** Explicit "the whole seven-day week" phrasing (not a bare "every day"). */
const SEVEN_DAY_PHRASES = new RegExp([
  `każdego dnia tygodnia`, `wszystkie (?:7|siedem) dni`, `every day of the(?: seven-day| 7-day)? week`, `all (?:7|seven) days`, `seven days a week`,
  `(?:codziennie|każdego dnia|every day|daily)${'[^.!?\\n]{0,40}'}(?:łącznie z|razem z|także w|też w|również w|w tym|including|incl\\.?)\\s*(?:weekend${L}*|sobot${L}*\\s*i\\s*niedziel${L}*|saturdays?\\s*and\\s*sundays?)`,
].join('|'), 'iu');

const weekday = (token: string): number | null => {
  const t = token.trim();
  for (const [re, n] of WEEKDAYS) if (re.test(t)) return n;
  return null;
};
const num = (raw: string): number | null => {
  const v = parseAmountToken(raw);
  return v !== null && v > 0 ? v : null;
};
const uniq = (values: number[]) => [...new Set(values.map((v) => Math.round(v * 100) / 100))];

/** The statements a single text makes (user words, or the advisor's own question for the confirmation path). */
export function statementsIn(text: string): HourStatements {
  const days: number[] = [];
  const spans: DaySpan[] = [];
  const perDay: number[] = [];
  const totals: number[] = [];

  // Days: "7 dni", "5 days", "7-day", "7/7".
  for (const m of text.matchAll(new RegExp(`${before}([1-7])\\s*-?\\s*(?:dni|dzień|dnia|dniow${L}*|days?|-day)(?![${L}])(?!\\s*(?:temu|ago))`, 'giu'))) days.push(Number(m[1]));
  if (new RegExp(`(?<![\\d/])7\\s*\\/\\s*7(?![\\d/])`).test(text)) days.push(7);
  for (const m of text.matchAll(new RegExp(`(?<![${L}])(${Object.keys(WORD_NUMBERS).join('|')})\\s+(?:dni|dzień|days?)(?![${L}])(?!\\s*(?:temu|ago))`, 'giu'))) {
    const n = WORD_NUMBERS[(m[1] as string).toLowerCase()];
    if (n) days.push(n);
  }
  for (const [re, n] of DAY_ADJECTIVES) if (re.test(text)) days.push(n);
  for (const m of text.matchAll(RANGE)) {
    const a = weekday(m[1] as string);
    const b = weekday(m[2] as string);
    if (a !== null && b !== null && b > a) {
      days.push(b - a + 1);
      const span = SPAN_OF_RANGE[`${a}-${b}`];
      if (span) spans.push(span);
    }
  }
  if (SEVEN_DAY_PHRASES.test(text)) days.push(7);
  // All seven days of the week say WHICH days too (Monday to Sunday); "5 dni" does not say which five.
  if (days.includes(7)) spans.push('mon-sun');

  // Hours per day: "po 8 h", "8 godzin dziennie", "dziennie po 8 h", "8 hours a day", "8h/day".
  const perDaySpans: Array<[number, number]> = [];
  const perDayPatterns = [
    new RegExp(`(?<![${L}])po\\s+${NUM}\\s*${HOUR_UNIT}`, 'giu'),
    new RegExp(`(?<![${L}])po\\s+${NUM}\\s*(?=${PER_DAY})`, 'giu'),
    new RegExp(`${before}${NUM}\\s*${HOUR_UNIT}\\s*${PER_DAY}`, 'giu'),
    new RegExp(`${PER_DAY}\\s*(?:po\\s+)?${NUM}\\s*${HOUR_UNIT}`, 'giu'),
  ];
  for (const re of perDayPatterns) {
    for (const m of text.matchAll(re)) {
      const v = num(m[1] as string);
      if (v !== null && v <= 24) {
        perDay.push(v);
        perDaySpans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
      }
    }
  }

  // Totals: a number of hours that is not part of a per-day statement.
  for (const m of text.matchAll(new RegExp(`${before}${NUM}\\s*${HOUR_UNIT}`, 'giu'))) {
    const start = m.index ?? 0;
    if (perDaySpans.some(([a, b]) => start >= a && start < b)) continue;
    const v = num(m[1] as string);
    if (v !== null) totals.push(v);
  }
  return { days: uniq(days), perDay: uniq(perDay), totals: uniq(totals), spans: [...new Set(spans)], rates: uniq(ratesIn(text)) };
}

// ---------------------------------------------------------------------------------------------
// FIN-03: a base hourly rate stated as such
// ---------------------------------------------------------------------------------------------

const MONEY_NUM = '(\\d{1,3}(?:[.,]\\d{1,2})?)';
const EUR = '(?:€|eur(?![\\p{L}])|euro\\p{L}*)';
const RATE_PATTERNS = [
  // "40 godzin po 16 €" / "40 hours at 16 EUR": the Polish distributive "po" / English "at" after hours = per hour.
  // The Polish distributive "po 16 €" / English "at €16" in a sentence that states hours = per hour. A currency is
  // required ("40 godzin po 8 dziennie" is not a rate) and an amount per day / week / month is not an hourly rate.
  new RegExp(`(?<![\\p{L}])(?:po|at)\\s+(?:${EUR}\\s*${MONEY_NUM}|${MONEY_NUM}\\s*${EUR})(?!\\s*(?:brutto\\s*)?(?:dziennie|na dzień|za dzień|tygodniowo|na tydzień|za tydzień|miesięcznie|na miesiąc|per day|a day|per week|a week|per month|a month))`, 'giu'),
  new RegExp(`${MONEY_NUM}\\s*${EUR}\\s*(?:brutto\\s*|gross\\s*)?(?:\\/\\s*(?:h|godz\\p{L}*|hr|hour)(?![\\p{L}])|za\\s+godzin\\p{L}*|na\\s+godzin\\p{L}*|per\\s+hour|an\\s+hour|hourly)`, 'giu'),
  new RegExp(`${EUR}\\s*${MONEY_NUM}\\s*(?:\\/\\s*(?:h|hr|hour)(?![\\p{L}])|per\\s+hour|an\\s+hour)`, 'giu'),
  new RegExp(`(?:stawk\\p{L}*|rate|uurloon|hourly wage)(?:\\s+(?:godzinow\\p{L}*|brutto|gross|to|is|wynosi|of|:))*\\s*${EUR}?\\s*${MONEY_NUM}\\s*${EUR}`, 'giu'),
];
const HOURS_WORD = /(?<![\p{L}])(?:godzin\p{L}*|godz\.?|hours?|hrs?|uur|\d+\s*h)(?![\p{L}])/iu;
/** Another pay component in the same sentence makes the rate ambiguous ("w sobotę 10 godzin po 20 €"). */
const OTHER_COMPONENT = /(?<![\p{L}])(?:sobot\p{L}*|niedziel\p{L}*|weekend\p{L}*|saturday|sunday|święt\p{L}*|holiday|nadgodzin\p{L}*|overtime|dodat\p{L}*|premi\p{L}*|toeslag|bonus|dojazd\p{L}*|travel|zwrot\p{L}*|reiskost\p{L}*)/iu;

export function ratesIn(text: string): number[] {
  const out: number[] = [];
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/u)) {
    const others = [...sentence.matchAll(new RegExp(OTHER_COMPONENT.source, 'giu'))].filter((m) => !/(?<![\p{L}])(?:bez|without|no|nie)\s+$/iu.test(sentence.slice(Math.max(0, (m.index ?? 0) - 8), m.index ?? 0)));
    if (others.length > 0) continue;
    const statesHours = HOURS_WORD.test(sentence);
    for (const re of RATE_PATTERNS) {
      if (re === RATE_PATTERNS[0] && !statesHours) continue;
      re.lastIndex = 0;
      for (const m of sentence.matchAll(re)) {
        const v = num((m[1] ?? m[2]) as string);
        if (v !== null && v >= 1 && v <= 200) out.push(v);
      }
    }
  }
  return out;
}

const AFFIRMATIVE = /^\s*(?:tak|tak jest|zgadza się|dokładnie|owszem|zgadza|yes|yeah|yep|correct|exactly|right|that's right|ja)\s*[!.,]*\s*$/iu;
const BARE_NUMBER = /^\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:h|godz\p{L}*|hours?|dni|days?)?\s*[!.]*\s*$/iu;
const ASKS_DAYS = /(?<!\p{L})(?:dni|dzień|days?)(?!\p{L})/iu;
const ASKS_PER_DAY = /dziennie|na dzień|każdego dnia|a day|per day|each day|daily/iu;
const ASKS_HOURS = /godzin|(?<!\p{L})hours?(?!\p{L})/iu;

/** Everything the user stated in the conversation, plus values they explicitly confirmed (see the module comment). */
export function statedInDialogue(dialogue: readonly DialogueTurn[]): HourStatements {
  const out: HourStatements = { days: [], perDay: [], totals: [], spans: [], rates: [] };
  dialogue.forEach((turn, i) => {
    if (turn.role !== 'user') return;
    const own = statementsIn(turn.text);
    out.days.push(...own.days);
    out.perDay.push(...own.perDay);
    out.totals.push(...own.totals);
    out.spans.push(...own.spans);
    out.rates.push(...own.rates);
    const previous = dialogue[i - 1];
    if (!previous || previous.role !== 'assistant') return;
    if (AFFIRMATIVE.test(turn.text)) {
      const asked = statementsIn(previous.text);
      if (asked.days.length === 1) out.days.push(asked.days[0] as number);
      if (asked.perDay.length === 1) out.perDay.push(asked.perDay[0] as number);
      if (asked.totals.length === 1) out.totals.push(asked.totals[0] as number);
      if (asked.spans.length === 1) out.spans.push(asked.spans[0] as DaySpan);
      if (asked.rates.length === 1) out.rates.push(asked.rates[0] as number);
      return;
    }
    const bare = BARE_NUMBER.exec(turn.text);
    if (bare) {
      const v = num(bare[1] as string);
      if (v === null) return;
      if (ASKS_PER_DAY.test(previous.text)) { if (v <= 24) out.perDay.push(v); }
      else if (ASKS_DAYS.test(previous.text) && Number.isInteger(v) && v >= 1 && v <= 7) out.days.push(v);
      else if (ASKS_HOURS.test(previous.text)) out.totals.push(v);
    }
  });
  return { days: uniq(out.days), perDay: uniq(out.perDay), totals: uniq(out.totals), spans: [...new Set(out.spans)], rates: uniq(out.rates) };
}

/**
 * FIN-03: the hours buckets a STATED schedule determines - one per-day figure and one explicit day span, nothing else
 * ("od poniedziałku do niedzieli po 8 h" -> Mon-Fri 40, Saturday 8, Sunday 8). A weekly total is never split ("7 dni,
 * 56 godzin" -> null: which days got how many hours is not stated), and two different per-day figures or spans are
 * ambiguous (null). Arithmetic on stated numbers only: per-day x number of weekdays in the span.
 */
export function scheduleBuckets(stated: HourStatements): { regularWeekdayHours: number; saturdayHours?: number; sundayHours?: number } | null {
  // A weekly total stated for Monday-Friday only IS the weekday bucket ("40 godzin od poniedziałku do piątku").
  if (stated.perDay.length === 0 && stated.totals.length === 1 && stated.spans.length === 1 && stated.spans[0] === 'mon-fri') return { regularWeekdayHours: stated.totals[0] as number };
  if (stated.perDay.length !== 1 || stated.spans.length !== 1) return null;
  const perDay = stated.perDay[0] as number;
  const weekday = Math.round(perDay * 5 * 100) / 100;
  switch (stated.spans[0]) {
    case 'mon-fri': return { regularWeekdayHours: weekday };
    case 'mon-sat': return { regularWeekdayHours: weekday, saturdayHours: perDay };
    case 'mon-sun': return { regularWeekdayHours: weekday, saturdayHours: perDay, sundayHours: perDay };
    default: return null;
  }
}
