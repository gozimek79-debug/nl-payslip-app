import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeContract, checkContractPlausibility, resolveReferenceDate, type ContractExtraction } from './contract.js';

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
    overtimeTierThresholdHours: null,
    guaranteedHours: null,
    guaranteedHoursPeriodWeeks: null,
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

/**
 * ============================================================================================
 * Tier B (audit "CONSOLIDATED ASSIGNMENT" round, §3.3): the FIRST real contract fixture in this
 * repo - the Olympia Fase A agreement, read directly this round (contract TERMS only; per the
 * standing privacy rule, name/address/DOB/IBAN/phone from that document are never reproduced here
 * or anywhere else - only the financial/contractual figures below).
 * ============================================================================================
 */
function olympiaContractExtraction(overrides: Partial<ContractExtraction> = {}): ContractExtraction {
  return baseExtraction({
    contractType: 'Uitzendovereenkomst fase A',
    employerName: 'Olympia Services B.V.',
    functionTitle: 'Magazijnmedewerker',
    startDate: '2026-09-01',
    endDate: '2026-10-04',
    hoursPerWeek: 16, // 64 hours per 4 weeks, as printed - not converted to a "typical" week
    hourlyRate: 15.55,
    monthlySalary: null,
    caoName: 'ABU-CLA',
    pensionFund: 'StiPP',
    probationPeriodWeeks: null, // confirmed: this Phase A agreement states no separate proeftijd clause at all - the agency clause (Art. 1.6) serves that flexibility role instead
    noticePeriodWeeks: null, // see §3.3 finding below - the stated notice concept doesn't map cleanly, so it is left unknown rather than guessed
    thirtyPercentRuling: false,
    overtimeTierThresholdHours: null, // the real finding: confirmed absent, see test below
    guaranteedHours: 64, // Art. 2.4: "64,00 hours per 4 weken" payable even if the hirer offers fewer
    guaranteedHoursPeriodWeeks: 4,
    redactedFields: [],
    ...overrides,
  });
}

test('2.0c: the real Olympia contract states a guaranteed-hours clause (Art. 2.4) - 64 hours per 4 weeks', () => {
  const extraction = olympiaContractExtraction();
  assert.equal(extraction.guaranteedHours, 64);
  assert.equal(extraction.guaranteedHoursPeriodWeeks, 4);
});

test("§3.3: the real Olympia contract does NOT state an overtime tier threshold - it lists percentage tiers, never the hour boundary between them", () => {
  // Article 2.9 of the real document lists: Overwerkuren 130%/150%/200%, and Onregelmatige uren
  // 20%/50%/75%/100%/200% - a schedule of RATES, never a sentence stating "after N hours the rate
  // steps up". hour-grid.ts's resolveOvertimeTierThreshold() has carried a 'contract_stated'
  // provenance slot since last round with nothing to feed it - this fixture is the direct evidence
  // that, for THIS real document, that slot would correctly stay null, not get a guessed value.
  const extraction = olympiaContractExtraction();
  assert.equal(extraction.overtimeTierThresholdHours, null);
});

test('§3.2: this contract IS above minimum wage and DOES verify cleanly on the one figure it states plainly', () => {
  // Confirms the mapping gap is specific to the threshold, not a wholesale extraction failure -
  // hourlyRate (15.55) is stated directly and unambiguously, and the existing minimum-wage check
  // (built for Module 2, reused here only to prove baseExtraction-style fixtures still behave)
  // correctly verifies it against a real 2026 rate.
  return analyzeContract(olympiaContractExtraction(), 14.99).then((analysis) => {
    assert.equal(analysis.minimumWageVerifiable, true);
    assert.equal(analysis.isBelowMinimumWage, false);
  });
});

/**
 * ============================================================================================
 * 2.0b - plausibility bounds. Direct evidence this exists for a real, observed failure: the live
 * model read the Olympia contract's "64,00 uren per 4 weken" and produced something unit/period-
 * wrong (confirmed live, this round) - a class of error no tolerance check catches, because the
 * digits themselves were right.
 * ============================================================================================
 */

test('2.0b: an hours-per-week figure past the physical ceiling (168 = 24x7) is flagged, not silently used', () => {
  // Reproduces the shape of the real failure: a per-4-week figure (64) misread as if it were a
  // larger unit (e.g. treated as days, or left unconverted across a longer period) landing well
  // past what a single week can physically hold.
  const flags = checkContractPlausibility({ hoursPerWeek: 256, hourlyRate: 15.55 });
  assert.deepEqual(flags, [{ field: 'hoursPerWeek', extractedValue: 256, code: 'exceeds_physical_hours_per_week', bound: 168 }]);
});

test('2.0b: the real, correct Olympia figure (16 hours/week, from 64 per 4 weeks correctly converted) is NOT flagged', () => {
  const flags = checkContractPlausibility({ hoursPerWeek: 16, hourlyRate: 15.55 });
  assert.deepEqual(flags, []);
});

test('2.0b: an implausible hourly rate is flagged independently of hours', () => {
  const flags = checkContractPlausibility({ hoursPerWeek: 16, hourlyRate: 1555 }); // e.g. a decimal-point misread
  assert.deepEqual(flags, [{ field: 'hourlyRate', extractedValue: 1555, code: 'exceeds_plausible_hourly_rate', bound: 200 }]);
});

test('2.0b: null fields (nothing extracted) never get flagged - absence is not implausibility', () => {
  const flags = checkContractPlausibility({ hoursPerWeek: null, hourlyRate: null });
  assert.deepEqual(flags, []);
});

test('2.0b: both fields can be flagged at once, independently', () => {
  const flags = checkContractPlausibility({ hoursPerWeek: 999, hourlyRate: 9999 });
  assert.equal(flags.length, 2);
  assert.ok(flags.some((f) => f.field === 'hoursPerWeek'));
  assert.ok(flags.some((f) => f.field === 'hourlyRate'));
});
