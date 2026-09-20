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
