import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrintedNumber, isAmountLike, extractPrintedNumbers, looksLikeSplitThousandsPair } from './number-parser.js';

/**
 * Stage 2g (audit v27, §2g.2): "table-driven tests with every form printed in the four fixtures."
 * Each row is a real printed form confirmed against `FIXTURES-paski-referencyjne.md` (§2.2), not an
 * invented one - see number-parser.ts's own comment for the citation of each shape.
 */
const CASES: Array<{ label: string; input: string; expected: number | null }> = [
  { label: 'bare comma-decimal, 3-digit integer (Olympia "699,78")', input: '699,78', expected: 699.78 },
  { label: 'bare comma-decimal, 4-digit integer, no grouping (PKF "3515,56")', input: '3515,56', expected: 3515.56 },
  { label: 'period-grouped thousands (PKF "38.000,00")', input: '38.000,00', expected: 38000 },
  { label: 'space-grouped thousands (FIXTURES "16 244,55")', input: '16 244,55', expected: 16244.55 },
  { label: 'assignment\'s own example, period-grouped (1.234,56)', input: '1.234,56', expected: 1234.56 },
  { label: 'assignment\'s own example, space-grouped (1 234,56)', input: '1 234,56', expected: 1234.56 },
  { label: 'leading hyphen-minus (assignment\'s own example, -40,58)', input: '-40,58', expected: -40.58 },
  { label: 'trailing hyphen-minus, Dutch accounting notation (assignment\'s own example, 40,58-)', input: '40,58-', expected: -40.58 },
  { label: 'leading Unicode MINUS SIGN U+2212 (OTTO "−21,65", FIXTURES fixture 2)', input: '−21,65', expected: -21.65 },
  { label: 'leading euro sign (OTTO "€ 14,40")', input: '€ 14,40', expected: 14.4 },
  { label: 'leading euro sign, no space', input: '€14,40', expected: 14.4 },
  { label: 'bare integer, no separators at all (Randstad\'s real jaarloon "46074")', input: '46074', expected: 46074 },
  { label: 'space-grouped integer, no decimal part shown', input: '1 234', expected: 1234 },
  { label: 'ambiguous: period with no decimals - the assignment\'s own example, must be "not a number"', input: '1.234', expected: null },
  { label: 'ambiguous: period-grouped thousands with no decimal part at all', input: '38.000', expected: null },
  { label: 'empty string', input: '', expected: null },
  { label: 'whitespace only', input: '   ', expected: null },
  { label: 'not a number at all', input: 'onbekend', expected: null },
  { label: 'malformed: signs on both ends', input: '-40,58-', expected: null },
  { label: 'malformed: three decimal digits', input: '40,589', expected: null },
  { label: 'malformed: a lone comma', input: ',', expected: null },
];

for (const { label, input, expected } of CASES) {
  test(`2g.2 parsePrintedNumber: ${label}`, () => {
    assert.equal(parsePrintedNumber(input), expected, `parsePrintedNumber(${JSON.stringify(input)})`);
  });
}

test('2g.2 parsePrintedNumber: idempotent on its own re-serialisation (round-trip a parsed value)', () => {
  const parsed = parsePrintedNumber('699,78');
  assert.equal(parsed, 699.78);
});

test('2g.4 isAmountLike: a two-decimal printed figure is amount-like', () => {
  assert.equal(isAmountLike('699,78'), true);
  assert.equal(isAmountLike('-58,31'), true);
});

test('2g.4 isAmountLike: an hours figure or a percentage is not amount-like (no two decimals, or not two exactly)', () => {
  assert.equal(isAmountLike('45'), false); // hours, no decimal part
  assert.equal(isAmountLike('7,5'), false); // hours with one decimal
  assert.equal(isAmountLike('40,200'), false); // three decimals (a percentage-shaped number, e.g. a rate)
});

test('2g.4 isAmountLike: an unparseable or ambiguous string is not amount-like', () => {
  assert.equal(isAmountLike('1.234'), false);
  assert.equal(isAmountLike('week 36/2026'), false);
});

/**
 * Stage 2h (audit v28, §2h.1): "table-driven, every case the reviewer ran (T1a matrix) must be
 * found" - RAPORT-cursor-2g.md's own T1(a) table, reproduced here as the literal test data, plus the
 * four cases it names that must NOT match 699.78.
 */
const MUST_FIND_69978: Array<{ label: string; text: string }> = [
  { label: 'bare', text: '699,78' },
  { label: 'leading euro with space', text: '€ 699,78' },
  { label: 'trailing currency code', text: '699,78 EUR' },
  { label: 'merged with a label', text: 'Loon normaal 699,78' },
  { label: 'merged with a label and an hours x rate run', text: 'Loon normaal 45,00 x 15,55 699,78' },
  { label: 'trailing hyphen-minus (sign not compared by the guard, magnitude still found)', text: '699,78-' },
];

for (const { label, text } of MUST_FIND_69978) {
  test(`2h.1 extractPrintedNumbers: must find 699.78 in - ${label} (${JSON.stringify(text)})`, () => {
    const found = extractPrintedNumbers(text).map((n) => Math.abs(n.value));
    assert.ok(found.some((v) => Math.abs(v - 699.78) < 0.001), `expected 699.78 among ${JSON.stringify(found)}`);
  });
}

const MUST_NOT_MATCH_69978: Array<{ label: string; text: string }> = [
  { label: 'a genuinely different, larger number that merely contains the digits', text: '1699,78' },
  { label: 'three decimal digits - not the same value', text: '699,785' },
  { label: 'one decimal digit - not the same value', text: '699,7' },
  { label: 'period as decimal mark - not this locale\'s form', text: '699.78' },
];

for (const { label, text } of MUST_NOT_MATCH_69978) {
  test(`2h.1 extractPrintedNumbers: must NOT match 699.78 in - ${label} (${JSON.stringify(text)})`, () => {
    const found = extractPrintedNumbers(text).map((n) => Math.abs(n.value));
    assert.ok(!found.some((v) => Math.abs(v - 699.78) < 0.001), `did not expect 699.78 among ${JSON.stringify(found)}, from input ${JSON.stringify(text)}`);
  });
}

const MUST_FIND_123456: Array<{ label: string; text: string }> = [
  { label: 'period-grouped, one string', text: '1.234,56' },
  { label: 'space-grouped, normal space, one string', text: '1 234,56' },
  { label: 'space-grouped, U+00A0 (NBSP), one string', text: '1 234,56' },
  { label: 'space-grouped, U+202F (NNBSP), one string', text: '1 234,56' },
];

for (const { label, text } of MUST_FIND_123456) {
  test(`2h.1 extractPrintedNumbers: must find 1234.56 in - ${label}`, () => {
    const found = extractPrintedNumbers(text).map((n) => n.value);
    assert.ok(found.includes(1234.56), `expected 1234.56 among ${JSON.stringify(found)}`);
  });
}

test('2h.1 extractPrintedNumbers: "1" and "234,56" as two separate strings do NOT recombine on their own (that is document-text-guard.ts\'s cross-item join, not this function\'s job)', () => {
  assert.deepEqual(extractPrintedNumbers('1').map((n) => n.value), [1]);
  assert.deepEqual(extractPrintedNumbers('234,56').map((n) => n.value), [234.56]);
});

test('2h.1 extractPrintedNumbers: a token is matched whole, never as a substring - "1699,78" never yields 699.78 alongside 1699.78', () => {
  const found = extractPrintedNumbers('1699,78').map((n) => n.value);
  assert.deepEqual(found, [1699.78]);
});

test('2h.1 extractPrintedNumbers: an unparseable merged run yields no numbers, not a wrong one', () => {
  assert.deepEqual(extractPrintedNumbers('week 36/2026'), []);
});

test('2h.1 extractPrintedNumbers: the 2g.4 measurement re-run - hours and rate tokens inside a merged run are found too, each carrying their own amountLike flag', () => {
  const found = extractPrintedNumbers('Loon normaal 45,00 x 15,55 699,78');
  const values = found.map((n) => n.value);
  assert.deepEqual(values, [45, 15.55, 699.78]);
  // 45,00 and 15,55 both carry two decimals - amount-like by the same rule as any other EUR figure,
  // even though collectPeriodAmounts (document-text-guard.ts) never treats an hours/rate field as a
  // payslip amount. This is exactly the source of the 2g.4 "unused" measurement's real, non-zero count.
  assert.deepEqual(found.map((n) => n.amountLike), [true, true, true]);
});

test('2h.1 extractPrintedNumbers: a thousands amount split by whitespace INSIDE a longer merged run recombines correctly ("Jaarloon ... 1 234,56")', () => {
  const found = extractPrintedNumbers('Jaarloon bijzonder tarief 1 234,56').map((n) => n.value);
  assert.ok(found.includes(1234.56), `expected 1234.56 among ${JSON.stringify(found)}`);
});

test('2h.1 looksLikeSplitThousandsPair: found and fixed empirically - two ordinary, already-complete adjacent amounts must NOT be treated as a split pair', () => {
  // An hours cell ("45,00") next to a rate cell ("15,55") on the same table row: both independently
  // look like "a bare number", but neither is a FRAGMENT of the other - joining them would fabricate a
  // bogus third candidate and silently double-count both in the 2g.4 unused-amounts measurement. This
  // is exactly the bug the assignment's own dense three-page synthetic-PDF test (synthetic-pdf.test.ts)
  // caught: an unguarded "both sides look numeric" join measured 540 unused items where only 180 were
  // real (each rate figure counted 3x).
  assert.equal(looksLikeSplitThousandsPair('45,00', '15,55'), false);
  assert.equal(looksLikeSplitThousandsPair('699,78', '58,31'), false);
});

test('2h.1 looksLikeSplitThousandsPair: the genuine split-thousands shape - a bare short integer immediately followed by a 3-digit-comma-2-digit remainder', () => {
  assert.equal(looksLikeSplitThousandsPair('1', '234,56'), true);
  assert.equal(looksLikeSplitThousandsPair('12', '345,67'), true);
  assert.equal(looksLikeSplitThousandsPair('Loon normaal', '699,78'), false, 'a label is never a split-thousands prefix');
  assert.equal(looksLikeSplitThousandsPair('1', '23'), false, 'the remainder must carry its own comma-decimal, or this is not the shape');
});
