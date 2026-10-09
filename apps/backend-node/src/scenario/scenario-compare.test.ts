import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareEvaluations, compareScenarios } from './scenario-compare.js';
import { evaluateScenario } from './scenario-evaluate.js';
import { RATES_2026, alternatives, dayGrid, num, oracleInput, oracleResult, weekdayScenario } from '../test-support/scenario-fixtures.js';

/** Minimal two-variant comparison: every delta is engine output minus engine output. */

test('R1 #19: an A/B comparison delta comes only from the engines\' own computed results', () => {
  const a = weekdayScenario({ scenarioId: 'a' });
  const b = weekdayScenario({ scenarioId: 'b', work: { regularWeekdayHours: num(40), saturdayHours: num(8) }, pay: { hourlyRate: num(16.8, 'document'), saturdayPremiumPercent: num(50, 'cao_rule') } });
  const c = compareScenarios(a, b, RATES_2026);
  assert.equal(c.status, 'comparable');
  assert.ok(c.status === 'comparable');

  const oa = oracleResult(oracleInput()).result;
  const ob = oracleResult(oracleInput({ week_grids: [dayGrid({ mon: { regular: 8 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 }, sat: { regular: 8 } })], saturday_percent: 50 })).result;
  assert.equal(c.a.figures.payoutAmount, oa.payout_amount);
  assert.equal(c.b.figures.payoutAmount, ob.payout_amount);
  assert.equal(c.delta.payoutAmount, Number((ob.payout_amount - oa.payout_amount).toFixed(2)));
  assert.equal(c.delta.grossTotal, Number((ob.gross_total - oa.gross_total).toFixed(2)));
  assert.equal(c.delta.totalTax, Number((ob.total_tax - oa.total_tax).toFixed(2)));
  assert.equal(c.delta.hoursWorked, 8);
  assert.ok(c.delta.payoutAmount > 0);
  assert.equal(c.rangeInvolved, false);
  // Each side keeps its complete evaluation (with its engine run and provenance).
  assert.equal(c.a.runs[0]?.engineResult.payout_amount, oa.payout_amount);
  assert.equal(c.b.scenario.scenarioId, 'b');
});

test('R1 comparison: swapping A and B negates every delta', () => {
  const a = weekdayScenario({ scenarioId: 'a' });
  const b = weekdayScenario({ scenarioId: 'b', work: { regularWeekdayHours: num(45) } });
  const ab = compareScenarios(a, b, RATES_2026);
  const ba = compareScenarios(b, a, RATES_2026);
  assert.ok(ab.status === 'comparable' && ba.status === 'comparable');
  for (const key of Object.keys(ab.delta) as Array<keyof typeof ab.delta>) assert.equal(ab.delta[key], Number((-ba.delta[key]).toFixed(2)) + 0, key);
});

test('R1 comparison: not comparable unless BOTH sides computed, with the reason per side', () => {
  const ok = weekdayScenario({ scenarioId: 'ok' });
  const blocked = weekdayScenario({ scenarioId: 'blocked', pay: {} });
  const invalid = weekdayScenario({ scenarioId: 'invalid', work: { regularWeekdayHours: num(-1) } });
  const unsupported = weekdayScenario({ scenarioId: 'unsupported', requestedConcepts: [{ concept: 'et_exchange', source: 'user' }] });
  const c1 = compareScenarios(ok, blocked, RATES_2026);
  assert.ok(c1.status === 'not_comparable');
  assert.deepEqual(c1.reasons, [{ side: 'b', status: 'blocked' }]);
  const c2 = compareScenarios(invalid, unsupported, RATES_2026);
  assert.ok(c2.status === 'not_comparable');
  assert.deepEqual(c2.reasons, [{ side: 'a', status: 'invalid' }, { side: 'b', status: 'unsupported' }]);
  assert.ok(!('delta' in c2), 'no fabricated delta');
});

test('R1 comparison: a side with a material range is flagged, and the delta compares the representative runs', () => {
  const a = weekdayScenario({ scenarioId: 'a' });
  const b = weekdayScenario({ scenarioId: 'b', tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } });
  const c = compareEvaluations(evaluateScenario(a, RATES_2026), evaluateScenario(b, RATES_2026));
  assert.ok(c.status === 'comparable');
  assert.equal(c.rangeInvolved, true);
  assert.equal(c.delta.payoutAmount, 0, 'the representative (first) option equals scenario A');
});
