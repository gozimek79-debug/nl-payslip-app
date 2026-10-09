import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_FIELD_FOR, UNSUPPORTED_CONCEPT_GAPS, findUnsupported, mapScenarioToEngine } from './scenario-map.js';
import { SCENARIO_FIELD_PATHS, UNSUPPORTED_CONCEPTS } from './scenario-types.js';
import { computeTierAResult } from '../payroll-engine/tier-a.js';
import { RATES_2026, alternatives, choice, dayGrid, num, oracleInput, range, weekdayScenario } from '../test-support/scenario-fixtures.js';
import { expandWeekdayHours, holidayDayCells, splitEvenly } from './scenario-util.js';

/** The single Scenario -> Tier A mapping path: deterministic, no hidden defaults, explicit accounting. */

function mapped(scenario: Parameters<typeof mapScenarioToEngine>[0]) {
  const r = mapScenarioToEngine(scenario);
  assert.equal(r.status, 'mapped', JSON.stringify(r));
  return (r as Extract<typeof r, { status: 'mapped' }>).mapping;
}

test('R1 mapper: the simplest scenario maps to exactly the input a Tier A user would have typed', () => {
  const { input } = mapped(weekdayScenario());
  assert.deepEqual(input, oracleInput({ week_grids: [dayGrid({ mon: { regular: 8 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 } })] }));
});

test('R1 mapper #14: identical input -> deeply identical output (and no input mutation)', () => {
  const s = weekdayScenario({ work: { regularWeekdayHours: num(40), saturdayHours: num(8), publicHolidayHours: num(8) }, pay: { hourlyRate: num(16.8), saturdayPremiumPercent: num(50), publicHolidayPremiumPercent: num(100) } });
  const before = JSON.stringify(s);
  assert.deepEqual(mapScenarioToEngine(s), mapScenarioToEngine(JSON.parse(before)));
  assert.equal(JSON.stringify(s), before);
});

test('R1 mapper: every consumed Scenario field is accounted for as consumed / ignored_irrelevant / unsupported', () => {
  const { consumption } = mapped(
    weekdayScenario({
      work: { regularWeekdayHours: num(40), saturdayHours: num(8) },
      pay: { hourlyRate: num(16.8, 'document'), saturdayPremiumPercent: num(50, 'cao_rule'), sundayPremiumPercent: num(100), overtime: { tier1Percent: num(25) } },
      requestedConcepts: [],
    }),
  );
  const status = new Map(consumption.map((c) => [c.path, c.status]));
  assert.equal(status.get('work.regularWeekdayHours'), 'consumed');
  assert.equal(status.get('pay.saturdayPremiumPercent'), 'consumed');
  assert.equal(status.get('pay.sundayPremiumPercent'), 'ignored_irrelevant', 'no Sunday hours');
  assert.equal(status.get('pay.overtime.tier1Percent'), 'ignored_irrelevant', 'no overtime hours');
  assert.equal(consumption.find((c) => c.path === 'pay.hourlyRate')?.engineField, 'hourly_rate');
  assert.equal(consumption.find((c) => c.path === 'pay.hourlyRate')?.source, 'document');
  // An ignored field names no engine field.
  assert.equal(consumption.find((c) => c.path === 'pay.sundayPremiumPercent')?.engineField, undefined);
  // Sorted, so the table is deterministic too.
  assert.deepEqual(consumption.map((c) => c.path), [...consumption.map((c) => c.path)].sort());
});

test('R1 mapper: a mapping-table entry exists for every Scenario field', () => {
  assert.deepEqual(Object.keys(ENGINE_FIELD_FOR).sort(), [...SCENARIO_FIELD_PATHS].sort());
  for (const concept of UNSUPPORTED_CONCEPTS) assert.ok(UNSUPPORTED_CONCEPT_GAPS[concept].length > 0, concept);
});

test('R1 mapper #13: no hidden default - a needed value that is absent / not a single known value blocks the mapping', () => {
  const blockedOf = (s: Parameters<typeof mapScenarioToEngine>[0]) => {
    const r = mapScenarioToEngine(s);
    assert.equal(r.status, 'blocked');
    return r.status === 'blocked' ? r.requirements : [];
  };
  assert.deepEqual(blockedOf(weekdayScenario({ pay: {} })).map((q) => [q.field, q.reason]), [['pay.hourlyRate', 'missing']]);
  assert.deepEqual(blockedOf(weekdayScenario({ tax: {} })).map((q) => [q.field, q.reason]), [['tax.loonheffingskorting', 'missing']]);
  assert.deepEqual(blockedOf(weekdayScenario({ deductions: undefined })).map((q) => [q.field, q.reason]), [['deductions.mode', 'missing']]);
  assert.deepEqual(blockedOf(weekdayScenario({ work: { regularWeekdayHours: num(8), saturdayHours: num(8) } })).map((q) => q.field), ['pay.saturdayPremiumPercent']);
  // An unresolved range / alternatives / conflict that reaches the mapper is never picked from.
  assert.deepEqual(blockedOf(weekdayScenario({ pay: { hourlyRate: range(16, 17) } })).map((q) => [q.field, q.reason]), [['pay.hourlyRate', 'unknown']]);
  assert.deepEqual(blockedOf(weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } })).map((q) => [q.field, q.reason]), [['tax.loonheffingskorting', 'unknown']]);
  assert.deepEqual(
    blockedOf(weekdayScenario({ pay: { hourlyRate: { state: 'conflict', candidates: [{ value: 1, source: 'document' }, { value: 2, source: 'user' }] } } })).map((q) => [q.field, q.reason]),
    [['pay.hourlyRate', 'conflict']],
  );
});

test('R1 mapper: weekend and holiday hours are separate buckets - never double counted', () => {
  const { input } = mapped(
    weekdayScenario({
      work: { regularWeekdayHours: num(40), saturdayHours: num(8), sundayHours: num(6), publicHolidayHours: num(8) },
      pay: { hourlyRate: num(16.8), saturdayPremiumPercent: num(50), sundayPremiumPercent: num(100), publicHolidayPremiumPercent: num(100) },
    }),
  );
  assert.equal(input.saturday_percent, 50);
  assert.equal(input.sunday_percent, 100);
  assert.equal(input.holiday_percent, 100);
  const [main, holiday] = input.week_grids;
  assert.equal(main?.sat.regular_hours, 8);
  assert.equal(main?.sun.regular_hours, 6);
  assert.equal(main?.mon.is_public_holiday, false);
  assert.equal(Object.values(holiday ?? {}).filter((c) => c.is_public_holiday).reduce((a, c) => a + c.regular_hours, 0), 8);
  // The weekday cells hold exactly the regular hours.
  const weekday = ['mon', 'tue', 'wed', 'thu', 'fri'].reduce((a, d) => a + (main?.[d as 'mon'].regular_hours ?? 0), 0);
  assert.equal(weekday, 40);
  // The engine agrees on the total.
  const computedResult = computeTierAResult(input, RATES_2026);
  assert.ok(computedResult.status === 'computed' && computedResult.outcome.status === 'complete' && computedResult.outcome.result.hours_worked === 62);
});

test('R1 mapper: deductions and extras map to the engine contract', () => {
  assert.deepEqual(mapped(weekdayScenario()).input.deductions, { mode: 'enter', entered: { pension: 30, paww: 0.7, sector_premium: 2.5 } });
  assert.deepEqual(mapped(weekdayScenario({ deductions: { mode: choice('estimate' as const, 'loonto_assumption') } })).input.deductions, { mode: 'estimate' });
  assert.deepEqual(
    mapped(weekdayScenario({ deductions: { mode: choice('enter' as const), entered: { pension: num(1), paww: num(2), sectorPremium: num(3), postTaxOther: num(4) } } })).input.deductions.entered,
    { pension: 1, paww: 2, sector_premium: 3, post_tax_other: 4 },
  );
  assert.equal(mapped(weekdayScenario({ extras: { travelAllowance: num(12.5) } })).input.travel_allowance, 12.5);
  assert.equal(mapped(weekdayScenario()).input.travel_allowance, 0);
  assert.deepEqual(mapped(weekdayScenario({ extras: { vakantiegeld: { mode: choice('accruing' as const), percent: num(8) } } })).input.vakantiegeld, { mode: 'accruing', percent: 8 });
  assert.equal(mapped(weekdayScenario({ tax: { loonheffingskorting: choice('not_applied' as const) } })).input.apply_loonheffingskorting, false);
  assert.equal(mapped(weekdayScenario()).input.period_type, 'week');
  assert.deepEqual(mapped(weekdayScenario()).input.surcharge_lines, []);
});

test('R1 mapper §6/§12: requested concepts the engine cannot represent are listed with their gap, never mapped', () => {
  const found = findUnsupported(weekdayScenario({ requestedConcepts: [{ concept: 'percent_based_deduction', source: 'document', ref: 'p' }, { concept: 'vakantiegeld_paid_now', source: 'user' }] }));
  assert.deepEqual(found.map((f) => [f.concept, f.requestedBy]), [['percent_based_deduction', 'document'], ['vakantiegeld_paid_now', 'user']]);
  assert.ok(found.every((f) => f.kind === 'concept' && f.reason === 'engine_cannot_represent'));
  const { consumption } = mapped(weekdayScenario({ requestedConcepts: [{ concept: 'night_premium', source: 'user' }] }));
  assert.ok(consumption.some((c) => c.path === 'requestedConcepts.night_premium' && c.status === 'unsupported'));
  assert.deepEqual(findUnsupported(weekdayScenario()), []);
});

test('R1 allocation helpers: exact, deterministic, and never price anything', () => {
  for (const [total, parts] of [[40, 5], [41, 5], [37.5, 5], [10, 3], [0.1, 3], [100, 7]] as const) {
    const shares = splitEvenly(total, parts);
    assert.equal(shares.length, parts);
    assert.equal(Math.round(shares.reduce((a, b) => a + b, 0) * 1e6), Math.round(total * 1e6), `${total}/${parts}`);
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1e-6 + 1e-12);
  }
  assert.deepEqual(holidayDayCells(8), [8]);
  assert.deepEqual(holidayDayCells(60), [24, 24, 12]);
  assert.deepEqual(holidayDayCells(0), []);
  const cells = expandWeekdayHours(40, 10, { kind: 'even', days: 2 });
  assert.deepEqual([cells.mon.overtime, cells.tue.overtime, cells.wed.overtime], [5, 5, 0]);
  assert.deepEqual(Object.values(cells).map((c) => c.regular), [8, 8, 8, 8, 8]);
  assert.deepEqual(expandWeekdayHours(40, 0, null).mon, { regular: 8, overtime: 0 });
});
