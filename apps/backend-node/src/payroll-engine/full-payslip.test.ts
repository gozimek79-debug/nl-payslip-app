import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFullPayslip, type FullPayslipExtraction } from './full-payslip.js';

function baseExtraction(overrides: Partial<FullPayslipExtraction> = {}): FullPayslipExtraction {
  return {
    period: 'week 36/2026',
    periodEndDate: '2026-09-06',
    hourlyRate: 15.55,
    minimumWage: 14.71,
    hoursPerWeek: null,
    contractType: null,
    thirtyPercentRuling: false,
    lineItems: [
      { section: 'Brutto', description: 'Loon normaal', quantity: 45, rate: 15.55, payment: 699.78, deduction: null },
    ],
    reportedTotalGross: null,
    reportedTotalNet: 686.09,
    reportedNetPaid: 776.09,
    truncated: false,
    redactedFields: [],
    ...overrides,
  };
}

test('N2: sub-1-EUR variance is not reported as a discrepancy at all', () => {
  const extraction = baseExtraction({
    lineItems: [{ section: 'Netto', description: 'Totaal', quantity: null, rate: null, payment: 686.5, deduction: null }],
  });
  const result = validateFullPayslip(extraction, 14.99);
  assert.equal(result.isConsistent, true);
  assert.equal(result.discrepancies.length, 0);
});

test('N2: a table-rounding-sized variance (0.31 EUR, matching the calibrated Olympia/Randstad deviation) raises nothing', () => {
  // Both reference payslips show the annual-model tax reconstruction landing 0.21-0.35 EUR off
  // the printed period-table figure - N2 is explicit that this must never raise a discrepancy.
  const extraction = baseExtraction({
    lineItems: [{ section: 'Netto', description: 'Totaal', quantity: null, rate: null, payment: 686.4, deduction: null }],
  });
  const result = validateFullPayslip(extraction, 14.99);
  assert.equal(result.isConsistent, true);
  assert.equal(result.discrepancies.length, 0);
});

test('N2: a variance in the 1-10 EUR band is a soft review note, not a hard discrepancy', () => {
  const extraction = baseExtraction({
    lineItems: [{ section: 'Netto', description: 'Totaal', quantity: null, rate: null, payment: 684, deduction: null }],
  });
  const result = validateFullPayslip(extraction, 14.99);
  assert.equal(result.isConsistent, true, 'a ~2 EUR variance must not flip isConsistent to false');
  assert.equal(result.discrepancies.length, 1);
  assert.match(result.discrepancies[0]!, /niewielka różnica/);
});

test('N2: a real multi-euro variance is still a hard discrepancy', () => {
  const extraction = baseExtraction({
    lineItems: [{ section: 'Netto', description: 'Totaal', quantity: null, rate: null, payment: 650, deduction: null }],
  });
  const result = validateFullPayslip(extraction, 14.99);
  assert.equal(result.isConsistent, false);
});

test('N4: minimum-wage violation is checked against the rules-DB value, not the printed one', () => {
  // Printed 14.71 (stale), actual rate 15.55 - compliant against both, so this alone wouldn't
  // catch the bug. The real test is the one below: an hourly rate between the two thresholds.
  const compliant = validateFullPayslip(baseExtraction(), 14.99);
  assert.equal(compliant.wmlViolation, false);

  // An employee paid 14.80/h: above the stale printed figure (14.71) but below the rate actually
  // in force (14.99). Checking against the printed value would clear this as compliant - checking
  // against the applicable value (as required) correctly flags it.
  const underpaid = validateFullPayslip(baseExtraction({ hourlyRate: 14.8 }), 14.99);
  assert.equal(underpaid.wmlViolation, true);
});

test('N4: printed-vs-applicable mismatch is an informational note, never mixed into discrepancies', () => {
  const result = validateFullPayslip(baseExtraction(), 14.99);
  assert.ok(result.minimumWageNote, 'expected a note when printed (14.71) differs from applicable (14.99)');
  assert.equal(result.discrepancies.some((d) => d.includes('Minimumloon')), false);
});

test('N4: no note when printed and applicable minimum wage agree', () => {
  const result = validateFullPayslip(baseExtraction({ minimumWage: 14.99 }), 14.99);
  assert.equal(result.minimumWageNote, null);
});
