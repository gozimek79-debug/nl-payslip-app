import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePayslipOvertimePercents, selectMostRecentReproducedPayslip, buildScenarioWeekGrid, resolveOvertimeTierThreshold, type ReproducedPayslipCandidate } from './pro-parameter-sourcing.ts';

test("3.0a.4: derivePayslipOvertimePercents - two distinct overtime percentages, lower is tier 1, higher is tier 2 (Olympia's own real shape: 'onregelm. 100%/50%')", () => {
  const derived = derivePayslipOvertimePercents([
    { category: 'regular', percent: null },
    { category: 'irregular_surcharge', percent: 100 },
    { category: 'irregular_surcharge', percent: 50 },
  ]);
  assert.deepEqual(derived, { tier1: 50, tier2: 100 });
});

test('3.0a.4: derivePayslipOvertimePercents - a single distinct percentage is tier 1 known, tier 2 stays unknown (no evidence of a second tier ever being reached)', () => {
  const derived = derivePayslipOvertimePercents([{ category: 'overtime', percent: 130 }]);
  assert.deepEqual(derived, { tier1: 130, tier2: null });
});

test('3.0a.4: derivePayslipOvertimePercents - no overtime/irregular_surcharge lines at all -> both unknown', () => {
  const derived = derivePayslipOvertimePercents([{ category: 'regular', percent: null }, { category: 'adv_compensation', percent: 1.54 }]);
  assert.deepEqual(derived, { tier1: null, tier2: null });
});

test('3.0a.4: derivePayslipOvertimePercents - duplicate lines at the same percent collapse to one tier, not two', () => {
  const derived = derivePayslipOvertimePercents([
    { category: 'overtime', percent: 150 },
    { category: 'overtime', percent: 150 },
  ]);
  assert.deepEqual(derived, { tier1: 150, tier2: null });
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
