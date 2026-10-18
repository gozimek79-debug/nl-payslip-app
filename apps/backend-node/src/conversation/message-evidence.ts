import { SCENARIO_FIELDS, type ScenarioFieldPath } from '../scenario/scenario-types.js';

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
  // I1: the noun "święto" in its case forms and the adjective "świąteczny" - not the bare "świet..." prefix, which
  // also matches "świetnie" / "świetny" ("great"). "świąt" / "święcie" are left out: they fold to "świat" / "świecie"
  // ("world"). A missed holiday word only means the user is asked; a false one would invent holiday hours.
  ['holiday', /\b(?:public\s+|bank\s+)?holidays?\b|\bfeestdag\w*|\bswiet(?:o|a|u|em|om|ami|ach)\b|\bswiateczn\w*/g],
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

// ---------------------------------------------------------------------------------------------
// C1: pay components a clause names
// ---------------------------------------------------------------------------------------------

/**
 * The pay component each non-hours numeric Scenario field holds (C1). A model may write a number to one of these
 * fields only when the user's message ties THAT number to THAT component. Day premiums and overtime reuse the hours
 * categories above; the rest is a closed PL / EN / NL word list.
 */
export type PayComponent = 'rate' | 'saturday' | 'sunday' | 'holiday' | 'weekend' | 'overtime' | 'tier1' | 'tier2' | 'threshold' | 'travel' | 'pension' | 'paww' | 'sector' | 'post_tax' | 'vakantiegeld' | 'other_premium';
export interface ComponentMention {
  component: PayComponent;
  negated: boolean;
}

export const FIELD_COMPONENT: Partial<Record<ScenarioFieldPath, PayComponent>> = {
  'pay.hourlyRate': 'rate',
  'pay.saturdayPremiumPercent': 'saturday',
  'pay.sundayPremiumPercent': 'sunday',
  'pay.publicHolidayPremiumPercent': 'holiday',
  'pay.overtime.thresholdHoursPerDay': 'threshold',
  'pay.overtime.tier1Percent': 'tier1',
  'pay.overtime.tier2Percent': 'tier2',
  'deductions.entered.pension': 'pension',
  'deductions.entered.paww': 'paww',
  'deductions.entered.sectorPremium': 'sector',
  'deductions.entered.postTaxOther': 'post_tax',
  'extras.travelAllowance': 'travel',
  'extras.vakantiegeld.percent': 'vakantiegeld',
};

/** The kind of number a component takes - only components of the same kind compete for a number. */
type ComponentKind = 'money' | 'percent' | 'hours_per_day';
const COMPONENT_KINDS: Record<PayComponent, readonly ComponentKind[]> = {
  rate: ['money'], travel: ['money'], pension: ['money'], paww: ['money'], sector: ['money'], post_tax: ['money'],
  saturday: ['percent'], sunday: ['percent'], holiday: ['percent'], weekend: ['percent'], tier1: ['percent'], tier2: ['percent'], vakantiegeld: ['percent'],
  overtime: ['percent', 'hours_per_day'], threshold: ['hours_per_day'],
  other_premium: ['percent', 'money'],
};
/** A broader word that qualifies a component instead of competing with it ("overtime, first tier, 25%"). */
const QUALIFIERS: Partial<Record<PayComponent, readonly PayComponent[]>> = { tier1: ['overtime'], tier2: ['overtime'], threshold: ['overtime'] };

/** Holiday ALLOWANCE ("holiday pay", "vakantiegeld") is never public-holiday work - masked before the day categories. */
const VAKANTIEGELD = /\b(?:vakantiegeld\w*|vacation\s+pay|holiday\s+(?:pay|allowance|money)|dodat\w*\s+urlopow\w*|urlopow\w*|wakacyjn\w*)\b/g;
const COMPONENT_PATTERNS: ReadonlyArray<readonly [PayComponent, RegExp]> = [
  ['rate', /\b(?:rate|hourly|wages?|salary|earn\w*|uurloon|loon|stawk\w*|zarab\w*|zarob\w*|pensj\w*|wynagrodz\w*|verdien\w*)\b/g],
  ['tier1', /\b(?:first|pierwsz\w*)\s+(?:tier|level|band|prog\w*|poziom\w*)\b|\b(?:tier|level|band|prog\w*|poziom\w*)\s+one\b/g],
  ['tier2', /\b(?:second|drug\w*)\s+(?:tier|level|band|prog\w*|poziom\w*)\b|\b(?:tier|level|band|prog\w*|poziom\w*)\s+two\b/g],
  ['threshold', /\b(?:threshold|limit)\b/g],
  ['travel', /\b(?:travel\w*|reiskost\w*|reisvergoed\w*|kilomet\w*|kilometr\w*|commut\w*|dojazd\w*|dojezd\w*|podroz\w*|przejazd\w*)\b/g],
  ['pension', /\b(?:pension\w*|pensioen\w*|emerytur\w*|emerytaln\w*)\b/g],
  ['paww', /\b(?:paww|aww)\b/g],
  ['sector', /\b(?:sector\w*|sektor\w*)\b/g],
  ['post_tax', /\b(?:after|post)[\s-]?tax\b|\bpo\s+(?:opodatkowaniu|podatku)\b|\bnetto[\s-]?inhoud\w*/g],
  ['vakantiegeld', VAKANTIEGELD],
  // R3-B (narrow L1 subset, Contract v1.1 §5.5 / §8.3): night, evening, shift and irregular-hours allowances have no
  // Scenario field (Tier A: the unsupported night/evening/shift premium concepts) - a number tied to one is never the
  // Saturday, Sunday, holiday or overtime premium, nor the base rate, however the question was worded.
  ['other_premium', /\b(?:noc\w*|wieczor\w*|zmianow\w*|nieregularn\w*|night\w*|evening\w*|shifts?|shiftwork|irregular\w*|nacht\w*|avond\w*|ploeg\w*|onregelmatig\w*|ort)\b/g],
];
const DAY_COMPONENTS: ReadonlySet<string> = new Set(['saturday', 'sunday', 'holiday', 'weekend', 'overtime']);

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
  /** C1: the pay components this clause names (affirmative or denied). */
  components: ComponentMention[];
  perDay: boolean;
}
export interface MessageEvidence {
  clauses: ClauseEvidence[];
  numbers: NumberMention[];
  categories: CategoryMention[];
  components: ComponentMention[];
}

const toNumber = (raw: string) => Number(raw.replace(',', '.'));
const CURRENCY_BEFORE = /(?:^|\s)(?:eur|euro|euros)\s*$/;

function splitClauses(message: string): string[] {
  let text = message.replace(/(^|\s)i(?=\s)/g, '$1|');
  text = foldText(text).replace(/€/g, ' eur ').replace(/%/g, ' percent ').replace(/\//g, ' per ');
  // C1: "Saturday +50%" - a plus sign on a number is a sign, not a clause break ("32 + 8" / "32+8" still are);
  // "tier 1" / "1st tier" name a tier, they are not numbers.
  text = text.replace(/(?<![\d.,]\s*)\+(?=\d)/g, ' ');
  text = text.replace(/\b(tier|level|band|prog|poziom)\s*([12])\b/g, (_m, word: string, digit: string) => `${word} ${digit === '1' ? 'one' : 'two'}`).replace(/\b1st\b/g, 'first').replace(/\b2nd\b/g, 'second');
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

function mentions<K extends string>(clause: string, patterns: ReadonlyArray<readonly [K, RegExp]>): Array<{ kind: K; negated: boolean }> {
  const out: Array<{ kind: K; negated: boolean }> = [];
  for (const [kind, pattern] of patterns) {
    for (const m of clause.matchAll(pattern)) {
      const index = m.index ?? 0;
      const before = clause.slice(0, index).replace(DONT_KNOW_PHRASES, ' ');
      const after = clause.slice(index + m[0].length);
      out.push({ kind, negated: NEGATION.test(before) || NEGATION_AFTER.test(after) });
    }
  }
  return out;
}

function clauseCategories(clause: string): CategoryMention[] {
  return mentions(clause, CATEGORY_PATTERNS).map((m) => ({ category: m.kind, negated: m.negated }));
}

function clauseComponents(clause: string, perDay: boolean): ComponentMention[] {
  const out: ComponentMention[] = mentions(clause, COMPONENT_PATTERNS).map((m) => ({ component: m.kind, negated: m.negated }));
  for (const m of mentions(clause.replace(VAKANTIEGELD, ' '), CATEGORY_PATTERNS)) {
    if (DAY_COMPONENTS.has(m.kind)) out.push({ component: m.kind as PayComponent, negated: m.negated });
  }
  // overtime counted per day is the overtime threshold ("overtime after 8 hours a day")
  if (perDay && out.some((m) => m.component === 'overtime' && !m.negated)) out.push({ component: 'threshold', negated: false });
  return out;
}

export function analyzeMessage(message: string): MessageEvidence {
  const clauses = splitClauses(message).map((text) => {
    const perDay = PER_DAY.test(text);
    return { text, numbers: clauseNumbers(text), categories: clauseCategories(text), components: clauseComponents(text, perDay), perDay };
  });
  return { clauses, numbers: clauses.flatMap((c) => c.numbers), categories: clauses.flatMap((c) => c.categories), components: clauses.flatMap((c) => c.components) };
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

function componentKindOf(field: ScenarioFieldPath): ComponentKind | null {
  const spec = SCENARIO_FIELDS[field];
  if (spec.kind !== 'number') return null;
  if (spec.unit === 'eur_per_hour' || spec.unit === 'eur_per_week') return 'money';
  if (spec.unit === 'premium_percent' || spec.unit === 'percent') return 'percent';
  return spec.unit === 'hours_per_day' ? 'hours_per_day' : null;
}

/**
 * C1: the numbers of this message that belong to `field`'s pay component - a model's value for that field may come
 * only from one of them. A number belongs to the component when
 *   - its own clause names that component and nothing competing ("Sunday premium 50%", "€50 travel"; a number
 *     stated "per hour" with no other component around it is the hourly rate);
 *   - or it is the message's only number, its clause names nothing, and the message names exactly that component
 *     elsewhere ("Za niedzielę, 50%");
 *   - or the message names no competing component at all and the server's own current question is this field: a
 *     pure quantity ("50%", "50 percent I think") answers the question asked - but "50% for Sunday" never answers
 *     a Saturday question.
 * Competing = another component taking the same kind of number; for the hourly rate, any other component at all
 * ("overtime rate €25", "Saturday €5 extra" are not the base rate). A component the message denies is never evidence.
 */
export function mentionsForField(e: MessageEvidence, field: ScenarioFieldPath, currentField: string | null): NumberMention[] {
  const own = FIELD_COMPONENT[field];
  const kind = componentKindOf(field);
  if (!own || !kind) return [];
  const competes = (k: PayComponent) => own === 'rate' || COMPONENT_KINDS[k].includes(kind);
  const fits = (names: PayComponent[]) => names.includes(own) && names.every((k) => k === own || (QUALIFIERS[own] ?? []).includes(k));
  const relevant = e.components.filter((m) => competes(m.component));
  if (relevant.some((m) => m.component === own && m.negated)) return [];
  const named = relevant.filter((m) => !m.negated).map((m) => m.component);
  const out: NumberMention[] = [];
  for (const c of e.clauses) {
    const inClause = c.components.filter((m) => !m.negated).map((m) => m.component);
    const competing = inClause.filter(competes);
    for (const n of c.numbers) {
      if (own === 'rate' && n.units.has('rate') && inClause.every((k) => k === 'rate')) out.push(n);
      else if (competing.length > 0) {
        if (fits(competing)) out.push(n);
      } else if (inClause.length > 0) {
        continue; // the clause ties this number to another kind of component
      } else if (e.numbers.length === 1 && named.length > 0) {
        if (fits(named)) out.push(n);
      } else if (relevant.length === 0 && currentField === field) {
        out.push(n);
      }
    }
  }
  return out;
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
