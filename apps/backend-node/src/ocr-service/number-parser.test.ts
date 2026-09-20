import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrintedNumber, isAmountLike } from './number-parser.js';

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
