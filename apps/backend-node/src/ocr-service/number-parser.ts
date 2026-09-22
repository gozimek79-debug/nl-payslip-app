/**
 * Stage 2g (audit v27, §2g.2): "One function turns a printed string into a number or into 'not a
 * number', and nothing else in the code parses amounts from text." Handles every printed form named
 * in the assignment and confirmed against `FIXTURES-paski-referencyjne.md` itself (§2.2 - checked,
 * not assumed):
 *
 *   - `1.234,56` / `1 234,56` - period or space as the thousands grouping, comma as the decimal mark
 *     (confirmed: FIXTURES' own "16 244,55" uses the space form)
 *   - `-40,58` / `40,58-` - a leading or trailing hyphen-minus
 *   - `−21,65` - a leading Unicode MINUS SIGN (U+2212, not a hyphen) - confirmed printed literally
 *     this way in FIXTURES fixture 2 (OTTO), not something to assume is a typo
 *   - a leading `€`
 *   - a bare integer with no separators at all (confirmed: Randstad's real jaarloon "46074")
 *   - a bare comma-decimal with no thousands grouping (confirmed: "3515,56", "699,78")
 *
 * An AMBIGUOUS string - the assignment's own example is `1.234` with no decimal part at all - returns
 * `null`, never a guess at which meaning (1234 grouped, or a literal 1.234) was intended. This
 * project's own locale (Dutch/Polish payroll documents) never uses a bare period as a decimal
 * separator, so a period-only number with no comma is always presumptively a thousands grouping - but
 * "presumptively" is exactly what §2.3 forbids acting on for a number that will feed a computation.
 */
export function parsePrintedNumber(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '') return null;

  // Leading/trailing currency sign - only euro, only this project's actual documents.
  s = s.replace(/^€\s*/, '').replace(/\s*€$/, '').trim();
  if (s === '') return null;

  // Sign: a leading hyphen-minus, a leading Unicode minus sign (U+2212, confirmed printed in
  // FIXTURES), or a trailing hyphen-minus (Dutch accounting notation, "40,58-"). Never both ends -
  // that is malformed, not a number this function will guess the meaning of.
  let negative = false;
  const leadingMinus = /^[-−]/.test(s);
  const trailingMinus = /-$/.test(s);
  if (leadingMinus && trailingMinus) return null;
  if (leadingMinus) {
    negative = true;
    s = s.slice(1).trim();
  } else if (trailingMinus) {
    negative = true;
    s = s.slice(0, -1).trim();
  }
  if (s === '' || /[-−]/.test(s)) return null; // any remaining sign character is malformed

  if (!/^[\d.,\s]+$/.test(s)) return null; // only digits and the three separator characters allowed

  const hasComma = s.includes(',');
  const hasPeriod = s.includes('.');

  if (hasComma) {
    // Comma is the decimal mark in this locale - the LAST comma, in case of a malformed double-comma
    // input, which the digit-count check below will reject anyway.
    const commaIndex = s.lastIndexOf(',');
    const integerPart = s.slice(0, commaIndex).replace(/[.\s]/g, ''); // strip thousands grouping
    const decimalPart = s.slice(commaIndex + 1);
    if (!/^\d+$/.test(integerPart) || !/^\d{1,2}$/.test(decimalPart)) return null;
    const value = Number(`${integerPart}.${decimalPart}`);
    if (!Number.isFinite(value)) return null;
    return negative ? -value : value;
  }

  if (hasPeriod) {
    // No comma at all - a bare period in this locale is never a decimal mark, so this is always a
    // thousands-grouped integer IN PRINCIPLE, but the assignment's own example ("1.234 with no
    // decimals") names exactly this shape as ambiguous and requires `null`, not a resolved guess.
    return null;
  }

  // Plain digits, optionally space-grouped, no decimal part shown at all (e.g. "46074", "1 234").
  const digitsOnly = s.replace(/\s/g, '');
  if (!/^\d+$/.test(digitsOnly)) return null;
  const value = Number(digitsOnly);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * Stage 2g (§2g.4): "amount-like means the parser accepts it and it has two decimals." A payslip
 * prints plenty of numbers that are not payment amounts (hours, percentages, rates with more or
 * fewer decimals) - this narrows `parsePrintedNumber`'s output to the shape a EUR amount actually
 * takes on these documents, for the unused-printed-amounts detector only.
 */
export function isAmountLike(raw: string): boolean {
  return /,\d{2}(?!\d)/.test(raw.trim()) && parsePrintedNumber(raw) !== null;
}

/**
 * Stage 2i (audit v29, §2i.0c): "extractPrintedNumbers returns each token with a shape: money
 * (exactly two decimals) or integer." Renamed from 2g.4's plain `amountLike` boolean to a named
 * shape, carried alongside the value so a caller never has to re-derive it from a different
 * substring than the one that actually parsed. `'money'` is `isAmountLike`'s own two-decimal test;
 * `'integer'` is everything else that still parses (a bare integer like the reviewer's IBAN/week/BSN
 * fragments, but also a one- or three-decimal figure like an hours count or a rate - the assignment's
 * own two-way split, not a claim that every non-money value is literally an integer).
 */
export interface ExtractedNumber {
  value: number;
  shape: 'money' | 'integer';
}

const CURRENCY_MARKERS = ['EUR', 'PLN', 'zł', '€'];

function stripCurrencyMarkers(s: string): string {
  let out = s.trim();
  for (const marker of CURRENCY_MARKERS) {
    if (out.startsWith(marker)) out = out.slice(marker.length).trim();
  }
  for (const marker of CURRENCY_MARKERS) {
    if (out.endsWith(marker)) out = out.slice(0, out.length - marker.length).trim();
  }
  return out;
}

// Punctuation that can sit against a number in running text without ever being PART of the number's
// own syntax (unlike '.', ',' and '-', which parsePrintedNumber must see intact to parse correctly).
function stripEdgePunctuation(s: string): string {
  return s.replace(/^[:;()]+/, '').replace(/[:;()]+$/, '');
}

/**
 * Stage 2h (§2h.1): the precise shape of "the first fragment of a thousands-grouped number that pdf.js
 * (or a caller's own tokeniser) split off from its remainder" - a BARE 1-3 digit integer with no
 * separators of its own, e.g. the "1" in "1 234,56". Deliberately narrower than "any bare number" (an
 * earlier version of this check used exactly that and found a real bug: two ordinary, already-complete
 * numbers sitting side by side on the same row - e.g. an hours cell "45,00" next to a rate cell
 * "15,55" - both independently look like "a bare number fragment", so joining on that alone produces a
 * bogus THIRD candidate ("45,00 15,55" -> tokenised right back into 45 and 15.55, duplicating both).
 * A genuine split-thousands prefix never has its own decimal part; requiring that asymmetry is what
 * tells the two cases apart.
 */
function isSplitThousandsPrefix(text: string): boolean {
  return /^\d{1,3}$/.test(text.trim());
}
/** The remainder half of the same split: exactly three digits, a comma, then exactly two decimal
 * digits - the "234,56" in "1 234,56". Exactly three digits before the comma is what a THOUSANDS
 * grouping produces; a differently-shaped neighbour is not this pattern and is left alone. */
function isSplitThousandsRemainder(text: string): boolean {
  return /^\d{3},\d{2}$/.test(text.trim());
}

/**
 * Stage 2h (§2h.1): "treat two consecutive items on the same page with the same rounded y as one
 * candidate joined by a single space (this recovers "1" + "234,56")." Exported so
 * `document-text-guard.ts`'s cross-item join (two SEPARATE `DocumentTextItem`s) and this file's own
 * intra-string token join (two ADJACENT TOKENS inside one already-merged text run, e.g. "Jaarloon
 * bijzonder tarief 1 234,56") use the exact same, precise criterion and can never disagree about what
 * counts as a genuine split-thousands pair.
 */
export function looksLikeSplitThousandsPair(a: string, b: string): boolean {
  return isSplitThousandsPrefix(a) && isSplitThousandsRemainder(b);
}

/**
 * Stage 2h (audit v28, §2h.1): "the guard finds numbers inside text." Stage 2g's guard only ever
 * tried `parsePrintedNumber` on a whole text item - the reviewer showed this fails the instant a real
 * PDF glues a label and its amount into one text run ("Loon normaal 699,78") or prints a trailing
 * currency code ("699,78 EUR"), which `parsePrintedNumber`'s strict single-number grammar correctly
 * refuses as a whole string.
 *
 * Two-tier, in this order:
 *   1. Try the WHOLE string (after stripping a leading/trailing currency marker) as one number first.
 *      This is what makes "1 234,56" (a normal space, U+00A0, or U+202F INSIDE one string) parse as
 *      1234.56 in one piece - `parsePrintedNumber`'s own regex already tolerates internal whitespace
 *      of any of those three kinds (confirmed: JS `\s` matches NBSP and NNBSP). Splitting on
 *      whitespace BEFORE this step would break exactly this case, which is why splitting only
 *      happens as a fallback, never first.
 *   2. Only if that whole-string parse fails (letters or other tokens are present) does it split on
 *      ASCII whitespace, strip a currency marker and inert edge punctuction from each token, and try
 *      each token on its own - this is what recovers 699.78 out of "Loon normaal 699,78" or
 *      "Loon normaal 45,00 x 15,55 699,78" (three separate numbers, still found individually) without
 *      ever breaking a single already-whole number apart.
 *
 * A token is matched WHOLE: "1699,78" parses to 1699.78, never partially to 699.78; "699,785" (three
 * decimal digits) and "699,7" (one) both parse to their own, different values, never silently treated
 * as 699.78; "699.78" (period as the decimal mark) stays unparseable, per this locale's own rule.
 *
 * Cross-item recovery (two SEPARATE text items forming one number, e.g. pdf.js splitting "1" from
 * "234,56" onto two runs) is a SEPARATE concern from the intra-string one this function DOES handle
 * (§2h.1 addition, below) - `document-text-guard.ts` joins same-page, same-y adjacent ITEMS using the
 * identical `looksLikeSplitThousandsPair` test, so the two can never disagree about what counts as
 * "one candidate number".
 */
export function extractPrintedNumbers(text: string): ExtractedNumber[] {
  if (typeof text !== 'string') return [];
  const whole = stripCurrencyMarkers(text.trim());
  if (whole !== '') {
    const wholeParsed = parsePrintedNumber(whole);
    if (wholeParsed !== null) return [{ value: wholeParsed, shape: isAmountLike(whole) ? 'money' : 'integer' }];
  }

  const tokens = text.trim().split(/[ \t\n\r\f\v]+/).filter((token) => token !== '');
  const stripped = tokens.map((rawToken) => stripEdgePunctuation(stripCurrencyMarkers(rawToken)));
  const results: ExtractedNumber[] = [];
  for (const s of stripped) {
    if (s === '') continue;
    const parsed = parsePrintedNumber(s);
    if (parsed !== null) results.push({ value: parsed, shape: isAmountLike(s) ? 'money' : 'integer' });
  }
  // Stage 2h (§2h.1): "1 234,56" embedded inside a longer merged run (e.g. "Jaarloon ... 1 234,56")
  // tokenises into "1" and "234,56" separately - each already parses ALONE (to 1 and 234.56), which is
  // exactly why this must be gated on the precise split-thousands shape rather than "both look like
  // numbers": two ordinary adjacent amounts (an hours cell next to a rate cell) would otherwise also
  // pass and produce a bogus duplicate third candidate.
  for (let i = 0; i < stripped.length - 1; i += 1) {
    const a = stripped[i];
    const b = stripped[i + 1];
    if (a === undefined || b === undefined || a === '' || b === '') continue;
    if (looksLikeSplitThousandsPair(a, b)) {
      const joined = `${a} ${b}`;
      const parsed = parsePrintedNumber(joined);
      if (parsed !== null) results.push({ value: parsed, shape: isAmountLike(joined) ? 'money' : 'integer' });
    }
  }
  return results;
}
