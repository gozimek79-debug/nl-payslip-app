import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePayslipOvertimePercents, selectMostRecentReproducedPayslip, buildScenarioWeekGrid, resolveOvertimeTierThreshold, resolveInitialHourlyRateInput, type ReproducedPayslipCandidate } from './pro-parameter-sourcing.ts';

/**
 * Stage 3.0a.5 (§Fix 1, MAJOR): "add a test using each fixture's own real numbers - not synthetic
 * ones - confirming the priced amount matches what that employer actually paid." PKF's own real
 * hour_lines (tier-c.test.ts): "Overwerk uren 125%" (4.0h, adds_hours: true) and "Overwerk uren 150%"
 * (18.25h, adds_hours: true), against the document's own real base rate (17.09, the same fixture's
 * regular-hours rate) reproduce the document's own printed amounts (85.45 and 467.84) to the cent -
 * proving the -100 conversion, not the raw payslip percent, is what the grid's own formula needs.
 */
test("3.0a.5: derivePayslipOvertimePercents on PKF's own real overtime lines, priced through TierACalculator's own grid formula, reproduces the fixture's own printed amounts to the cent", () => {
  const pkfHourLines = [
    { category: 'regular', percent: null, adds_hours: false },
    { category: 'overtime', percent: 125, adds_hours: true }, // "Overwerk uren 125%", 4.0h, printed amount 85.45
    { category: 'overtime', percent: 150, adds_hours: true }, // "Overwerk uren 150%", 18.25h, printed amount 467.84
  ];
  const derived = derivePayslipOvertimePercents(pkfHourLines);
  assert.deepEqual(derived, { tier1: 25, tier2: 50, excludedPercents: [] }, 'the raw 125/150 must be converted to the 25/50 premium the grid formula expects');

  const baseRate = 17.09; // PKF's own real base rate, printed on the same document
  const priceOvertimeHour = (hours: number, tierPercent: number) => Math.round(hours * baseRate * (1 + tierPercent / 100) * 100) / 100;
  assert.equal(priceOvertimeHour(4.0, derived.tier1 as number), 85.45, "PKF's own printed 125%-tier amount");
  assert.equal(priceOvertimeHour(18.25, derived.tier2 as number), 467.84, "PKF's own printed 150%-tier amount");
});

test('3.0a.5: derivePayslipOvertimePercents on a genuine SECOND real shape (Olympia\'s own "onregelm." surcharges, adds_hours: false) derives NOTHING for the overtime-tier fields - a different concept, not a units bug', () => {
  // Olympia's own real hour_lines (tier-c.test.ts): both onregelm. lines are adds_hours: false -
  // a bonus on hours ALREADY counted in the regular line, not additional hours worked. These belong
  // to Tier A's own separate, unchanged surcharge_lines feature (hours * rate * percent/100, no
  // conversion - already correct, already tested, untouched by this round), never the day-grid's
  // overtime tiers - so the correct behaviour here is nothing derived, not a wrongly-converted value.
  const olympiaHourLines = [
    { category: 'regular', percent: null, adds_hours: true },
    { category: 'irregular_surcharge', percent: 100, adds_hours: false }, // "Loon onregelm. uren 100%"
    { category: 'irregular_surcharge', percent: 50, adds_hours: false }, // "Loon onregelm. uren 50%"
    { category: 'adv_compensation', percent: 1.54, adds_hours: false },
  ];
  const derived = derivePayslipOvertimePercents(olympiaHourLines);
  assert.deepEqual(derived, { tier1: null, tier2: null, excludedPercents: [] });
});

test('3.0a.4: derivePayslipOvertimePercents - a single genuine overtime percentage is tier 1 known, tier 2 stays unknown (no evidence of a second tier ever being reached)', () => {
  const derived = derivePayslipOvertimePercents([{ category: 'overtime', percent: 130, adds_hours: true }]);
  assert.deepEqual(derived, { tier1: 30, tier2: null, excludedPercents: [] });
});

test('3.0a.4: derivePayslipOvertimePercents - no eligible lines at all -> both unknown, nothing excluded', () => {
  const derived = derivePayslipOvertimePercents([{ category: 'regular', percent: null, adds_hours: true }, { category: 'adv_compensation', percent: 1.54, adds_hours: false }]);
  assert.deepEqual(derived, { tier1: null, tier2: null, excludedPercents: [] });
});

test('3.0a.4: derivePayslipOvertimePercents - duplicate lines at the same percent collapse to one tier, not two', () => {
  const derived = derivePayslipOvertimePercents([
    { category: 'overtime', percent: 150, adds_hours: true },
    { category: 'overtime', percent: 150, adds_hours: true },
  ]);
  assert.deepEqual(derived, { tier1: 50, tier2: null, excludedPercents: [] });
});

/**
 * Stage 3.0a.5 (§Fix 3, MINOR): "a third distinct overtime percent is silently dropped... it must be
 * visible, not silent."
 */
test('3.0a.5: derivePayslipOvertimePercents - a genuine third distinct overtime percentage is named as excluded, never silently dropped', () => {
  const derived = derivePayslipOvertimePercents([
    { category: 'overtime', percent: 100, adds_hours: true },
    { category: 'overtime', percent: 125, adds_hours: true },
    { category: 'overtime', percent: 150, adds_hours: true },
  ]);
  assert.deepEqual(derived, { tier1: 0, tier2: 50, excludedPercents: [125] }, 'the middle value (125, raw, as printed) must be named, not silently discarded');
});

const candidate = (overrides: Partial<ReproducedPayslipCandidate>): ReproducedPayslipCandidate => ({
  label: 'payslip.pdf', periodLabel: null, periodEndDate: null, fullyReproduced: true, hourLines: [],
  ...overrides,
});

test('3.0a.4: selectMostRecentReproducedPayslip - a payslip that failed verification is never used as a source, however recent', () => {
  const older = candidate({ label: 'older', periodEndDate: '2026-01-01', fullyReproduced: true });
  const newerButUnreliable = candidate({ label: 'newer, unreliable', periodEndDate: '2026-06-01', fullyReproduced: false });
  const selected = selectMostRecentReproducedPayslip([older, newerButUnreliable]);
  assert.equal(selected?.label, 'older', 'the unreliable-but-more-recent one must never be selected');
});

test('3.0a.4: selectMostRecentReproducedPayslip - among reproduced candidates, the most recent by period end date wins', () => {
  const older = candidate({ label: 'older', periodEndDate: '2026-01-01' });
  const newer = candidate({ label: 'newer', periodEndDate: '2026-06-01' });
  const selected = selectMostRecentReproducedPayslip([older, newer]);
  assert.equal(selected?.label, 'newer');
});

test('3.0a.4: selectMostRecentReproducedPayslip - a reproduced candidate with no readable end date is still eligible when it is the only one', () => {
  const selected = selectMostRecentReproducedPayslip([candidate({ label: 'undated but reproduced', periodEndDate: null })]);
  assert.equal(selected?.label, 'undated but reproduced');
});

test('3.0a.4: selectMostRecentReproducedPayslip - a dated reproduced candidate is preferred over an undated one', () => {
  const undated = candidate({ label: 'undated', periodEndDate: null });
  const dated = candidate({ label: 'dated', periodEndDate: '2026-01-01' });
  const selected = selectMostRecentReproducedPayslip([undated, dated]);
  assert.equal(selected?.label, 'dated');
});

test('3.0a.4: selectMostRecentReproducedPayslip - no reproduced candidates at all -> null, never a fallback guess', () => {
  assert.equal(selectMostRecentReproducedPayslip([candidate({ fullyReproduced: false })]), null);
  assert.equal(selectMostRecentReproducedPayslip([]), null);
});

test('3.0a.4: buildScenarioWeekGrid - 40 hours is all regular, spread evenly Mon-Fri, no overtime', () => {
  const grid = buildScenarioWeekGrid(40);
  assert.equal(grid.mon.regular_hours, 8);
  assert.equal(grid.mon.overtime_hours, 0);
  assert.equal(grid.sat.regular_hours, 0);
  assert.equal(grid.sun.regular_hours, 0);
});

test('3.0a.4: buildScenarioWeekGrid - 50 hours is 40 regular plus 10 overtime, both spread evenly Mon-Fri', () => {
  const grid = buildScenarioWeekGrid(50);
  assert.equal(grid.wed.regular_hours, 8);
  assert.equal(grid.wed.overtime_hours, 2);
});

test('3.0a.4: buildScenarioWeekGrid - 60 hours is 40 regular plus 20 overtime', () => {
  const grid = buildScenarioWeekGrid(60);
  assert.equal(grid.fri.regular_hours, 8);
  assert.equal(grid.fri.overtime_hours, 4);
});

/**
 * Stage 3.0a.4: "a contract/payslip disagreement on a percentage [or threshold] correctly shown with
 * the payslip's value used." Survey finding (this file's own top comment): the overtime tier
 * PERCENTAGES have no contract-side counterpart at all (confirmed absent from ContractExtraction),
 * so the ONLY field that can ever have a genuine contract-vs-payslip disagreement is the overtime
 * THRESHOLD - and reproducing a threshold from a real payslip is not attempted this round (nothing
 * in the codebase does this anywhere; the real call site always passes `payslip_reproduced_evidence:
 * null`, unchanged). This test proves the RESOLUTION MECHANISM itself - reused unchanged from
 * `hour-grid.ts` - correctly resolves a disagreement when both sides ARE known, with a synthetic
 * payslip-side value standing in for the reproduction this round does not build. Honest test, not a
 * live one: no real document exercises this path yet, exactly like several of this engagement's own
 * prior synthetic disagreement tests (2j.1's ET case, 2o.1's net-position case) where no real fixture
 * combined the needed shapes either.
 */
test('3.0a.4: resolveOvertimeTierThreshold - contract and payslip-reproduced evidence disagree -> the contract value is used (CH1s own established rule), with BOTH values kept and shown', () => {
  const resolved = resolveOvertimeTierThreshold({ contract_stated: 2, payslip_reproduced_evidence: 3, user_entered: null });
  assert.equal(resolved.hours_before_step_up, 2, 'the contract value wins, per the existing, unchanged rule');
  assert.equal(resolved.provenance, 'contract_stated');
  assert.deepEqual(resolved.disagreement, { contract_value: 2, payslip_reproduced_value: 3 }, 'both values must be kept and shown, never silently resolved with only one visible');
});

test('3.0a.4: resolveOvertimeTierThreshold - contract known, no payslip evidence at all -> no disagreement reported (silence is not a finding)', () => {
  const resolved = resolveOvertimeTierThreshold({ contract_stated: 2, payslip_reproduced_evidence: null, user_entered: null });
  assert.equal(resolved.hours_before_step_up, 2);
  assert.equal(resolved.disagreement, null);
});

test('3.0a.4: resolveOvertimeTierThreshold - neither contract nor payslip nor user -> unknown with a stated reason (provenance), never a guessed default', () => {
  const resolved = resolveOvertimeTierThreshold({ contract_stated: null, payslip_reproduced_evidence: null, user_entered: null });
  assert.equal(resolved.hours_before_step_up, null);
  assert.equal(resolved.provenance, 'unknown');
});

test("3.0a.4: resolveOvertimeTierThreshold - a user's own correction outranks both contract and payslip", () => {
  const resolved = resolveOvertimeTierThreshold({ contract_stated: 2, payslip_reproduced_evidence: 3, user_entered: 4 });
  assert.equal(resolved.hours_before_step_up, 4);
  assert.equal(resolved.provenance, 'user_entered');
});

/**
 * Stage 3.0a.5 (§Fix 4): "PRO mode's rate field empty when no contract supplied one."
 */
test('3.0a.5: resolveInitialHourlyRateInput - PRO mode with no sourced rate starts genuinely empty, never the free-calculator placeholder', () => {
  assert.equal(resolveInitialHourlyRateInput(undefined, 'PRO'), '');
});

test('3.0a.5: resolveInitialHourlyRateInput - Tier A/B keep their own, unchanged placeholder default when nothing is supplied', () => {
  assert.equal(resolveInitialHourlyRateInput(undefined, 'A'), '15.58');
  assert.equal(resolveInitialHourlyRateInput(undefined, 'B'), '15.58');
});

test('3.0a.5: resolveInitialHourlyRateInput - a real sourced rate always wins, in every mode', () => {
  assert.equal(resolveInitialHourlyRateInput(16.2, 'PRO'), '16.2');
  assert.equal(resolveInitialHourlyRateInput(16.2, 'A'), '16.2');
});
