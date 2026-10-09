import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScenario } from './scenario-validate.js';
import { SCENARIO_FIELDS, SCENARIO_ISSUE_CODES, type ScenarioIssueCode, type ScenarioV1 } from './scenario-types.js';
import { alternatives, choice, num, range, unknown, weekdayScenario } from '../test-support/scenario-fixtures.js';

/**
 * The validator is pure and deterministic: it classifies a Scenario as invalid / blocked / ready with
 * structured codes, never throws for user-data problems, and never decides by prose.
 */

const issues = (s: unknown) => validateScenario(s).issues.map((i) => i.code);

test('R1 validator: a complete weekly scenario is ready with no issues or requirements', () => {
  const v = validateScenario(weekdayScenario());
  assert.deepEqual(v, { status: 'ready', issues: [], requirements: [], warnings: [] });
});

test('R1 validator: every structural problem is invalid, never a throw', () => {
  for (const bad of [null, undefined, 42, 'text', [], {}]) {
    const v = validateScenario(bad);
    assert.equal(v.status, 'invalid');
    assert.ok(v.issues.length > 0);
  }
  assert.ok(issues({ ...weekdayScenario(), schemaVersion: 2 }).includes('unsupported_schema_version'));
  assert.ok(issues({ ...weekdayScenario(), periodType: 'month' }).includes('unsupported_period_type'));
  assert.ok(issues({ ...weekdayScenario(), periodType: '4-weekly' }).includes('unsupported_period_type'));
  assert.ok(issues({ ...weekdayScenario(), scenarioId: '  ' }).includes('malformed_scenario'));
  assert.ok(issues({ ...weekdayScenario(), work: 'x' }).includes('malformed_scenario'));
});

test('R1 validator: units and bounds - negative hours, impossible percentages, rates, amounts, non-finite', () => {
  const cases: Array<[Partial<ScenarioV1>, ScenarioIssueCode]> = [
    [{ work: { regularWeekdayHours: num(-1) } }, 'negative_hours'],
    [{ work: { regularWeekdayHours: num(121) } }, 'hours_out_of_range'],
    [{ work: { regularWeekdayHours: num(8), saturdayHours: num(25) } }, 'hours_out_of_range'],
    [{ work: { regularWeekdayHours: num(8), sundayHours: num(-0.5) } }, 'negative_hours'],
    [{ work: { regularWeekdayHours: num(Number.NaN) } }, 'value_not_finite'],
    [{ work: { regularWeekdayHours: num(Number.POSITIVE_INFINITY) } }, 'value_not_finite'],
    [{ pay: { hourlyRate: num(0) } }, 'hourly_rate_out_of_range'],
    [{ pay: { hourlyRate: num(-16.8) } }, 'hourly_rate_out_of_range'],
    [{ pay: { hourlyRate: num(1001) } }, 'hourly_rate_out_of_range'],
    [{ pay: { hourlyRate: num(16.8), saturdayPremiumPercent: num(-1) } }, 'percent_out_of_range'],
    [{ pay: { hourlyRate: num(16.8), sundayPremiumPercent: num(501) } }, 'percent_out_of_range'],
    [{ extras: { travelAllowance: num(-5) } }, 'amount_out_of_range'],
    [{ extras: { vakantiegeld: { mode: choice('accruing' as const), percent: num(51) } } }, 'percent_out_of_range'],
    [{ deductions: { mode: choice('enter' as const), entered: { pension: num(-1), paww: num(0), sectorPremium: num(0) } } }, 'amount_out_of_range'],
  ];
  for (const [override, code] of cases) {
    const v = validateScenario(weekdayScenario(override));
    assert.equal(v.status, 'invalid', code);
    assert.ok(v.issues.some((i) => i.code === code), `${code}: ${JSON.stringify(v.issues)}`);
  }
});

test('R1 validator: malformed values, sources, ranges, alternatives and conflicts', () => {
  assert.ok(issues(weekdayScenario({ pay: { hourlyRate: { state: 'known', value: '16.8' as unknown as number, source: 'user' } } })).includes('malformed_value'));
  assert.ok(issues(weekdayScenario({ pay: { hourlyRate: { state: 'known', value: 16.8, source: 'guess' as unknown as 'user' } } })).includes('malformed_source'));
  assert.ok(issues(weekdayScenario({ pay: { hourlyRate: { state: 'wat' as unknown as 'known', value: 1, source: 'user' } } })).includes('malformed_value'));
  assert.ok(issues(weekdayScenario({ pay: { hourlyRate: range(20, 10) } })).includes('range_inverted'));
  assert.ok(issues(weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied'] as const) } })).includes('alternatives_too_few'));
  assert.ok(issues(weekdayScenario({ pay: { hourlyRate: { state: 'conflict', candidates: [{ value: 16, source: 'document' }] } } })).includes('conflict_too_few'));
  assert.ok(issues(weekdayScenario({ tax: { loonheffingskorting: choice('maybe' as unknown as 'applied') } })).includes('invalid_tax_credit_state'));
  assert.ok(issues(weekdayScenario({ deductions: { mode: choice('skip' as unknown as 'enter') } })).includes('invalid_choice_value'));
  assert.ok(issues(weekdayScenario({ requestedConcepts: [{ concept: 'magic' as unknown as 'et_exchange', source: 'user' }] })).includes('unknown_requested_concept'));
  // A range is a NUMBER concept; alternatives are a CHOICE concept - using the wrong one is malformed.
  assert.ok(issues(weekdayScenario({ tax: { loonheffingskorting: range(0, 1) as unknown as ReturnType<typeof choice<'applied'>> } })).includes('malformed_value'));
});

test('R1 validator: contradictory / overlapping work-hour representations are invalid', () => {
  const overtime = (distribution: ScenarioV1['work']['overtimeDistribution'], hours = 10) =>
    weekdayScenario({ work: { regularWeekdayHours: num(40), overtimeHours: num(hours), overtimeDistribution: distribution } });
  assert.ok(issues(overtime(choice({ kind: 'explicit' as const, byDay: { mon: 4, tue: 4, wed: 0, thu: 0, fri: 0 } }))).includes('overtime_distribution_mismatch'));
  assert.ok(issues(overtime(choice({ kind: 'explicit' as const, byDay: { mon: -1, tue: 11, wed: 0, thu: 0, fri: 0 } }))).includes('negative_hours'));
  assert.ok(issues(overtime(choice({ kind: 'explicit' as const, byDay: { mon: 25, tue: 0, wed: 0, thu: 0, fri: 0 } }), 25)).includes('day_hours_exceed_24'));
  assert.ok(issues(overtime(choice({ kind: 'even' as const, days: 6 as unknown as 5 }))).includes('invalid_overtime_distribution'));
  assert.ok(issues(overtime(choice({ kind: 'even' as const, days: 0 as unknown as 1 }))).includes('invalid_overtime_distribution'));
  assert.ok(issues(overtime(choice({ kind: 'sideways' } as unknown as { kind: 'even'; days: 1 }))).includes('invalid_overtime_distribution'));
  // 8 + 40 regular + overtime on one day: 8 regular + 20 overtime > 24 h in a single day.
  assert.ok(issues(overtime(choice({ kind: 'even' as const, days: 1 as const }), 20)).includes('day_hours_exceed_24'));
  // The whole week cannot exceed 168 hours, counting every bucket once.
  const heavy = weekdayScenario({ work: { regularWeekdayHours: num(101), overtimeHours: num(20), overtimeDistribution: choice({ kind: 'even' as const, days: 5 as const }), saturdayHours: num(24), sundayHours: num(24) } });
  assert.ok(issues(heavy).includes('hours_exceed_week'), '101 + 20 + 24 + 24 = 169 > 168');
  const exactlyFull = weekdayScenario({ work: { regularWeekdayHours: num(100), overtimeHours: num(20), overtimeDistribution: choice({ kind: 'even' as const, days: 5 as const }), saturdayHours: num(24), sundayHours: num(24) } });
  assert.ok(!issues(exactlyFull).includes('hours_exceed_week'), 'exactly 168 h is the limit, not over it');
});

test('R1 validator: blocked requirements are relevance-driven and carry who/what could resolve them', () => {
  // Only what the current scenario needs: no Sunday work -> no Sunday premium asked.
  assert.deepEqual(validateScenario(weekdayScenario()).requirements, []);

  const sunday = validateScenario(weekdayScenario({ work: { regularWeekdayHours: num(40), sundayHours: num(6) } }));
  assert.equal(sunday.status, 'blocked');
  assert.deepEqual(sunday.requirements.map((r) => r.field), ['pay.sundayPremiumPercent']);
  assert.deepEqual(sunday.requirements[0]?.resolvableBy, { userAnswer: true, explicitAssumption: true, deterministicVariants: true });

  const ot = validateScenario(weekdayScenario({ work: { regularWeekdayHours: num(40), overtimeHours: num(5) } }));
  assert.deepEqual(ot.requirements.map((r) => r.field).sort(), ['pay.overtime.thresholdHoursPerDay', 'pay.overtime.tier1Percent', 'work.overtimeDistribution']);
  assert.ok(ot.requirements.every((r) => !r.resolvableBy.explicitAssumption), 'no assumption policy exists for overtime inputs');

  const rate = validateScenario(weekdayScenario({ pay: {} }));
  assert.deepEqual(rate.requirements, [{ field: 'pay.hourlyRate', reason: 'missing', resolvableBy: { userAnswer: true, explicitAssumption: false, deterministicVariants: false } }]);

  const noHours = validateScenario(weekdayScenario({ work: {} }));
  assert.deepEqual(noHours.requirements.map((r) => r.field), ['work.hours']);
  const zeroHours = validateScenario(weekdayScenario({ work: { regularWeekdayHours: num(0) } }));
  assert.deepEqual(zeroHours.requirements.map((r) => r.field), ['work.hours']);

  const unknownHours = validateScenario(weekdayScenario({ work: { regularWeekdayHours: unknown } }));
  assert.deepEqual(unknownHours.requirements, [{ field: 'work.regularWeekdayHours', reason: 'unknown', resolvableBy: { userAnswer: true, explicitAssumption: false, deterministicVariants: false } }]);
});

test('R1 validator: deductions - enter needs all three pre-tax amounts (0 allowed explicitly); estimate is an explicit visible choice', () => {
  const partial = validateScenario(weekdayScenario({ deductions: { mode: choice('enter' as const), entered: { pension: num(30) } } }));
  assert.deepEqual(partial.requirements.map((r) => r.field).sort(), ['deductions.entered.paww', 'deductions.entered.sectorPremium']);
  const zeros = validateScenario(weekdayScenario({ deductions: { mode: choice('enter' as const), entered: { pension: num(0), paww: num(0), sectorPremium: num(0) } } }));
  assert.equal(zeros.status, 'ready');
  const estimate = validateScenario(weekdayScenario({ deductions: { mode: choice('estimate' as const, 'loonto_assumption') } }));
  assert.equal(estimate.status, 'ready');
  const missing = validateScenario(weekdayScenario({ deductions: undefined }));
  assert.deepEqual(missing.requirements.map((r) => r.field), ['deductions.mode']);
  assert.equal(missing.requirements[0]?.resolvableBy.explicitAssumption, true);
});

test('R1 validator: irrelevant values are warnings, not errors (scenario relevance, Lock §5.3)', () => {
  const v = validateScenario(weekdayScenario({ pay: { hourlyRate: num(16.8), saturdayPremiumPercent: num(50), overtime: { tier1Percent: num(25) } } }));
  assert.equal(v.status, 'ready');
  assert.deepEqual(v.warnings.map((w) => w.path).sort(), ['pay.overtime.tier1Percent', 'pay.saturdayPremiumPercent']);
  assert.ok(v.warnings.every((w) => w.code === 'irrelevant_value_ignored'));
});

test('R1 validator: is a pure function - same input, same output, input not mutated', () => {
  const s = weekdayScenario({ work: { regularWeekdayHours: num(40), saturdayHours: num(8) } });
  const before = JSON.stringify(s);
  assert.deepEqual(validateScenario(s), validateScenario(JSON.parse(before)));
  assert.equal(JSON.stringify(s), before);
});

test('R1 validator: codes are stable data - no prose, every code is in the closed union, every field has a spec', () => {
  for (const code of SCENARIO_ISSUE_CODES) assert.match(code, /^[a-z0-9_]+$/);
  const all = validateScenario({ ...weekdayScenario(), work: { regularWeekdayHours: num(-1) } });
  for (const issue of all.issues) assert.ok((SCENARIO_ISSUE_CODES as readonly string[]).includes(issue.code));
  for (const [path, spec] of Object.entries(SCENARIO_FIELDS)) {
    assert.ok(spec.kind === 'number' || spec.kind === 'choice', path);
  }
});
