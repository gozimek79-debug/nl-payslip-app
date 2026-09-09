import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContract, resolveReferenceDate, type ContractExtraction } from './contract.js';

function baseExtraction(overrides: Partial<ContractExtraction> = {}): ContractExtraction {
  return {
    contractType: 'Onbepaalde tijd',
    employerName: 'Test Employer BV',
    functionTitle: 'Operator',
    startDate: '2021-03-01',
    endDate: null,
    hoursPerWeek: 40,
    hourlyRate: 10.5,
    monthlySalary: null,
    caoName: null,
    pensionFund: null,
    probationPeriodWeeks: null,
    noticePeriodWeeks: null,
    thirtyPercentRuling: false,
    redactedFields: [],
    ...overrides,
  };
}

test('R2 regression: a 2021 contract at EUR 10.50/h is flagged against the CURRENT minimum wage, not the 2021 rate', () => {
  // This is the controller's job (passing getMinimumWageAt(new Date()), not
  // getMinimumWageAt(contract start date)) - analyzeContract itself just compares whatever rate
  // it's handed. This test locks in that comparison correctly catches the case the controller must
  // feed it: EUR 10.50/h was legal in 2021 (WML was under EUR 10) but is roughly a third below the
  // 2026 rate the fixed controller now looks up.
  const currentMinimumWage2026 = 14.99;
  return analyzeContract(baseExtraction(), currentMinimumWage2026).then((analysis) => {
    assert.equal(analysis.isBelowMinimumWage, true);
    assert.equal(analysis.minimumWageVerifiable, true);
  });
});

test('resolveReferenceDate still returns the CONTRACT start date (used for proeftijd/opzegtermijn, unaffected by R2)', () => {
  const date = resolveReferenceDate(baseExtraction({ startDate: '2021-03-01' }));
  assert.equal(date.toISOString().slice(0, 10), '2021-03-01');
});

test('proeftijd/opzegtermijn checks use the contract start date even when minimum wage must use today', () => {
  // A 2021 contract with an unusually long stated probation period, checked against the rule
  // that applied in 2021 (static fallback, since no DB in this test run) - proves the two lookups
  // in analyzeContract stay on the contract's own timeline regardless of what the controller now
  // passes for minimum wage.
  return analyzeContract(baseExtraction({ probationPeriodWeeks: 6 }), 14.99).then((analysis) => {
    assert.equal(analysis.maxAllowedProbationWeeks, 8.7); // indefinite contract -> long-contract limit
    assert.equal(analysis.probationExceedsLimit, false);
  });
});
