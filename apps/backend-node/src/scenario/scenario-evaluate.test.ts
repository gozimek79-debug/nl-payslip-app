import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScenario, type ScenarioEvaluationResult } from './scenario-evaluate.js';
import { rangeMaterialityThreshold, MAX_VARIANT_RUNS } from './scenario-config.js';
import type { ScenarioV1 } from './scenario-types.js';
import { RATES_2026, alternatives, choice, dayGrid, num, oracleInput, oracleResult, range, unknown, weekdayScenario } from '../test-support/scenario-fixtures.js';

/**
 * R1 Scenario Core - evaluation against the REAL Tier A engine. Every expected money figure is the
 * output of the existing engine for a hand-written TierAInput that describes the same user intent; the
 * Scenario layer is checked for equality with it, never against a re-implemented formula.
 */

type Computed = Extract<ScenarioEvaluationResult, { status: 'computed' }>;
function computed(result: ScenarioEvaluationResult): Computed {
  assert.equal(result.status, 'computed', JSON.stringify(result.status === 'blocked' ? result.requirements : result.status === 'invalid' ? result.issues : result));
  return result as Computed;
}
const ev = (s: unknown) => evaluateScenario(s, RATES_2026);

// ---- 1-5: supported scenarios equal the engine ---------------------------------------------

test('R1 #1: a simple 40 h weekday scenario computes and equals the engine for the same input', () => {
  const r = computed(ev(weekdayScenario()));
  const oracle = oracleResult(oracleInput());
  assert.equal(r.figures.payoutAmount, oracle.result.payout_amount);
  assert.equal(r.figures.wageNet, oracle.result.wage_net);
  assert.equal(r.figures.grossTotal, oracle.result.gross_total);
  assert.equal(r.figures.totalTax, oracle.result.total_tax);
  assert.equal(r.figures.hoursWorked, 40);
  assert.equal(r.range, null);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0]?.kind, 'single');
  assert.equal(r.scenario.status, 'ready');
  // The engine's full result is carried through untouched.
  assert.deepEqual(r.runs[0]?.engineResult, oracle.result);
});

test('R1 #2: weekday + Saturday equals the engine, and Saturday hours are not also counted as regular', () => {
  const s = weekdayScenario({ work: { regularWeekdayHours: num(40), saturdayHours: num(8) }, pay: { hourlyRate: num(16.8, 'document'), saturdayPremiumPercent: num(50, 'cao_rule') } });
  const r = computed(ev(s));
  const oracle = oracleResult(
    oracleInput({
      week_grids: [dayGrid({ mon: { regular: 8 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 }, sat: { regular: 8 } })],
      saturday_percent: 50,
    }),
  );
  assert.equal(r.figures.payoutAmount, oracle.result.payout_amount);
  assert.equal(r.figures.grossTotal, oracle.result.gross_total);
  assert.equal(r.figures.hoursWorked, 48, '40 + 8, never 56');
});

test('R1 #3: weekday + Sunday equals the engine', () => {
  const s = weekdayScenario({ work: { regularWeekdayHours: num(40), sundayHours: num(6) }, pay: { hourlyRate: num(16.8, 'document'), sundayPremiumPercent: num(100, 'loonto_assumption') } });
  const r = computed(ev(s));
  const oracle = oracleResult(
    oracleInput({
      week_grids: [dayGrid({ mon: { regular: 8 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 }, sun: { regular: 6 } })],
      sunday_percent: 100,
    }),
  );
  assert.equal(r.figures.payoutAmount, oracle.result.payout_amount);
  assert.equal(r.figures.hoursWorked, 46);
});

test('R1 #4: public-holiday hours equal the engine and are a separate bucket (never also weekday hours)', () => {
  const s = weekdayScenario({ work: { regularWeekdayHours: num(32), publicHolidayHours: num(8) }, pay: { hourlyRate: num(16.8, 'document'), publicHolidayPremiumPercent: num(100, 'cao_rule') } });
  const r = computed(ev(s));
  const oracle = oracleResult(
    oracleInput({
      week_grids: [dayGrid({ mon: { regular: 8 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { holiday: true, regular: 8 } })],
      holiday_percent: 100,
    }),
  );
  assert.equal(r.figures.payoutAmount, oracle.result.payout_amount);
  assert.equal(r.figures.hoursWorked, 40, '32 + 8, never 48');
  assert.equal(r.runs[0]?.engineInput.week_grids.length, 2, 'the holiday bucket is its own grid');
});

test('R1 #5: weekday overtime with a distribution equals the engine (per-day tiering)', () => {
  const s = weekdayScenario({
    work: { regularWeekdayHours: num(40), overtimeHours: num(10), overtimeDistribution: choice({ kind: 'even' as const, days: 2 as const }) },
    pay: { hourlyRate: num(16.8, 'document'), overtime: { thresholdHoursPerDay: num(2, 'document'), tier1Percent: num(25, 'document'), tier2Percent: num(50, 'document') } },
  });
  const r = computed(ev(s));
  const oracle = oracleResult(
    oracleInput({
      week_grids: [dayGrid({ mon: { regular: 8, overtime: 5 }, tue: { regular: 8, overtime: 5 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 } })],
      overtime_tier_threshold_hours: 2,
      overtime_tier_1_percent: 25,
      overtime_tier_2_percent: 50,
    }),
  );
  assert.equal(r.figures.payoutAmount, oracle.result.payout_amount);
  assert.equal(r.figures.hoursWorked, 50);
});

test('R1 #5b: the overtime distribution changes the money (it is not decorative); an explicit one equals the engine', () => {
  const base = {
    pay: { hourlyRate: num(16.8, 'document'), overtime: { thresholdHoursPerDay: num(2, 'document'), tier1Percent: num(25, 'document'), tier2Percent: num(50, 'document') } },
  };
  const oneDay = computed(ev(weekdayScenario({ ...base, work: { regularWeekdayHours: num(40), overtimeHours: num(10), overtimeDistribution: choice({ kind: 'even' as const, days: 1 as const }) } })));
  const fiveDays = computed(ev(weekdayScenario({ ...base, work: { regularWeekdayHours: num(40), overtimeHours: num(10), overtimeDistribution: choice({ kind: 'even' as const, days: 5 as const }) } })));
  assert.notEqual(oneDay.figures.grossTotal, fiveDays.figures.grossTotal);
  const explicit = computed(
    ev(weekdayScenario({ ...base, work: { regularWeekdayHours: num(40), overtimeHours: num(10), overtimeDistribution: choice({ kind: 'explicit' as const, byDay: { mon: 10, tue: 0, wed: 0, thu: 0, fri: 0 } }) } })),
  );
  assert.equal(explicit.figures.grossTotal, oneDay.figures.grossTotal, 'all overtime on one day, either way of saying it');
});

test('R1 #5c: how REGULAR hours are spread over the week is money-neutral (flat-priced), checked against the engine', () => {
  for (const hours of [37.5, 38, 40, 41.25, 16, 3.5]) {
    const r = computed(ev(weekdayScenario({ work: { regularWeekdayHours: num(hours) } })));
    const oracle = oracleResult(oracleInput({ week_grids: [dayGrid({ mon: { regular: hours } })] }));
    assert.equal(r.figures.payoutAmount, oracle.result.payout_amount, `${hours} h`);
    assert.equal(r.figures.grossTotal, oracle.result.gross_total, `${hours} h`);
  }
});

test('R1 #5d: overtime with the engine-level missing tier-2 percent is blocked as engine_requires, with no money figure', () => {
  const s = weekdayScenario({
    work: { regularWeekdayHours: num(40), overtimeHours: num(10), overtimeDistribution: choice({ kind: 'even' as const, days: 2 as const }) },
    pay: { hourlyRate: num(16.8, 'document'), overtime: { thresholdHoursPerDay: num(2, 'document'), tier1Percent: num(25, 'document') } },
  });
  const r = ev(s);
  assert.equal(r.status, 'blocked');
  assert.ok(r.status === 'blocked' && r.requirements.some((q) => q.field === 'pay.overtime.tier2Percent' && q.reason === 'engine_requires'));
  assert.ok(!('figures' in r));
  // ...and when no day exceeds the threshold the engine does not need tier 2 at all.
  const fine = computed(ev(weekdayScenario({ ...s, work: { regularWeekdayHours: num(40), overtimeHours: num(4), overtimeDistribution: choice({ kind: 'even' as const, days: 2 as const }) } })));
  assert.equal(fine.figures.hoursWorked, 44);
});

// ---- 6-10: blocked / invalid -------------------------------------------------------------------

test('R1 #6: a missing hourly rate is blocked - no money result is fabricated', () => {
  const s = weekdayScenario({ pay: {} });
  const r = ev(s);
  assert.equal(r.status, 'blocked');
  assert.ok(r.status === 'blocked' && r.requirements.some((q) => q.field === 'pay.hourlyRate' && q.reason === 'missing' && q.resolvableBy.userAnswer && !q.resolvableBy.explicitAssumption));
  assert.ok(!('figures' in r) && !('runs' in r));
});

test('R1 #7: a missing material premium is blocked, an assumption could resolve it; as an explicit assumption it computes', () => {
  const s = weekdayScenario({ work: { regularWeekdayHours: num(40), sundayHours: num(6) } });
  const blocked = ev(s);
  assert.equal(blocked.status, 'blocked');
  const req = blocked.status === 'blocked' ? blocked.requirements.find((q) => q.field === 'pay.sundayPremiumPercent') : undefined;
  assert.ok(req && req.reason === 'missing' && req.resolvableBy.explicitAssumption && req.resolvableBy.userAnswer);

  const withAssumption = computed(ev({ ...s, pay: { ...s.pay, sundayPremiumPercent: num(100, 'loonto_assumption') } }));
  assert.deepEqual(withAssumption.assumptionsUsed, [{ path: 'pay.sundayPremiumPercent', state: 'known' }]);
});

test('R1 #8: negative hours are invalid and no engine calculation happens', () => {
  const r = ev(weekdayScenario({ work: { regularWeekdayHours: num(-3) } }));
  assert.equal(r.status, 'invalid');
  assert.ok(r.status === 'invalid' && r.issues.some((i) => i.code === 'negative_hours' && i.path === 'work.regularWeekdayHours'));
  assert.ok(!('runs' in r) && !('figures' in r));
});

test('R1 #9: an impossible premium percentage is invalid', () => {
  for (const bad of [600, -5, 501]) {
    const r = ev(weekdayScenario({ work: { regularWeekdayHours: num(40), saturdayHours: num(8) }, pay: { hourlyRate: num(16.8), saturdayPremiumPercent: num(bad) } }));
    assert.equal(r.status, 'invalid', String(bad));
    assert.ok(r.status === 'invalid' && r.issues.some((i) => i.code === 'percent_out_of_range'));
  }
});

test('R1 #10: unresolved competing values are blocked as a conflict - Scenario Core never picks a winner', () => {
  const s = weekdayScenario({
    pay: { hourlyRate: { state: 'conflict', candidates: [{ value: 16.8, source: 'document', ref: 'contract' }, { value: 16.2, source: 'document', ref: 'payslip' }] } },
  });
  const r = ev(s);
  assert.equal(r.status, 'blocked');
  assert.ok(r.status === 'blocked' && r.requirements.some((q) => q.field === 'pay.hourlyRate' && q.reason === 'conflict'));
  assert.ok(!('figures' in r));
});

test('R1: tax-credit and deductions are high-impact and never silently assumed - absent or unknown means blocked', () => {
  const noTax = ev(weekdayScenario({ tax: {} }));
  assert.ok(noTax.status === 'blocked' && noTax.requirements.some((q) => q.field === 'tax.loonheffingskorting' && q.reason === 'missing' && q.resolvableBy.deterministicVariants));
  const unknownTax = ev(weekdayScenario({ tax: { loonheffingskorting: unknown } }));
  assert.ok(unknownTax.status === 'blocked' && unknownTax.requirements.some((q) => q.field === 'tax.loonheffingskorting' && q.reason === 'unknown'));
  const noDeductions = ev(weekdayScenario({ deductions: undefined }));
  assert.ok(noDeductions.status === 'blocked' && noDeductions.requirements.some((q) => q.field === 'deductions.mode' && q.resolvableBy.explicitAssumption));
});

// ---- 11-13: provenance --------------------------------------------------------------------------

test('R1 #11/#12: assumption and document origins are preserved through evaluation and stay distinguishable', () => {
  const s = weekdayScenario({
    work: { regularWeekdayHours: num(40, 'user'), saturdayHours: num(8, 'user') },
    pay: { hourlyRate: num(16.8, 'document', 'doc-contract-1'), saturdayPremiumPercent: num(50, 'loonto_assumption', 'orientation-sat') },
  });
  const r = computed(ev(s));
  const byPath = new Map(r.provenance.map((p) => [p.path, p]));
  assert.deepEqual(byPath.get('pay.hourlyRate'), { path: 'pay.hourlyRate', state: 'known', source: 'document', ref: 'doc-contract-1', consumedByEngine: true });
  assert.deepEqual(byPath.get('pay.saturdayPremiumPercent'), { path: 'pay.saturdayPremiumPercent', state: 'known', source: 'loonto_assumption', ref: 'orientation-sat', consumedByEngine: true });
  assert.deepEqual(r.assumptionsUsed, [{ path: 'pay.saturdayPremiumPercent', state: 'known', ref: 'orientation-sat' }]);
  assert.ok(r.warnings.some((w) => w.code === 'assumption_in_use' && w.path === 'pay.saturdayPremiumPercent'));
  assert.ok(!r.assumptionsUsed.some((a) => a.path === 'pay.hourlyRate'), 'a document value is never reported as an assumption');
  // The normalised scenario still says where each value came from.
  assert.equal((r.scenario.pay.hourlyRate as { source: string }).source, 'document');
});

test('R1: every provenance source type is accepted and carried (document, user, CAO, official rule, memory, assumption)', () => {
  for (const source of ['document', 'user', 'cao_rule', 'official_rule', 'intelligence_memory', 'loonto_assumption'] as const) {
    const r = computed(ev(weekdayScenario({ pay: { hourlyRate: num(16.8, source) } })));
    assert.equal(r.provenance.find((p) => p.path === 'pay.hourlyRate')?.source, source);
    assert.equal(r.assumptionsUsed.length, source === 'loonto_assumption' ? 1 : 0);
  }
});

test('R1 #13: no hidden default - irrelevant premiums are not passed to the engine, nothing is invented', () => {
  const r = computed(ev(weekdayScenario()));
  const input = r.runs[0]?.engineInput;
  assert.equal(input?.saturday_percent, null);
  assert.equal(input?.sunday_percent, null);
  assert.equal(input?.holiday_percent, null);
  assert.equal(input?.overtime_tier_threshold_hours, null);
  assert.equal(input?.overtime_tier_1_percent, null);
  assert.equal(input?.overtime_tier_2_percent, null);
  assert.deepEqual(input?.surcharge_lines, []);
  // A premium handed to us with no matching hours is IGNORED (and flagged), not applied.
  const withStray = computed(ev(weekdayScenario({ pay: { hourlyRate: num(16.8), sundayPremiumPercent: num(100, 'loonto_assumption') } })));
  assert.equal(withStray.runs[0]?.engineInput.sunday_percent, null);
  assert.ok(withStray.warnings.some((w) => w.code === 'irrelevant_value_ignored' && w.path === 'pay.sundayPremiumPercent'));
  assert.equal(withStray.assumptionsUsed.length, 0, 'an ignored assumption is not "used"');
  assert.equal(withStray.figures.payoutAmount, r.figures.payoutAmount);
});

// ---- 14-15: determinism --------------------------------------------------------------------------

test('R1 #14/#15: identical Scenario -> identical engine input, digest and result; key order does not matter', () => {
  const a = computed(ev(weekdayScenario({ work: { regularWeekdayHours: num(40), saturdayHours: num(8) }, pay: { hourlyRate: num(16.8, 'document'), saturdayPremiumPercent: num(50) } })));
  const b = computed(ev(weekdayScenario({ work: { regularWeekdayHours: num(40), saturdayHours: num(8) }, pay: { hourlyRate: num(16.8, 'document'), saturdayPremiumPercent: num(50) } })));
  assert.deepEqual(a, b);
  assert.equal(a.runs[0]?.engineInputDigest, b.runs[0]?.engineInputDigest);
  // Same Scenario with keys in a different order (JSON from another producer).
  const reordered = JSON.parse(JSON.stringify({ tax: weekdayScenario().tax, periodType: 'week', pay: { saturdayPremiumPercent: num(50), hourlyRate: { ref: undefined, source: 'document', value: 16.8, state: 'known' } }, work: { saturdayHours: num(8), regularWeekdayHours: num(40) }, deductions: weekdayScenario().deductions, scenarioId: 'test-scenario', schemaVersion: 1 })) as ScenarioV1;
  const c = computed(ev(reordered));
  assert.equal(c.runs[0]?.engineInputDigest, a.runs[0]?.engineInputDigest);
  assert.equal(c.figures.payoutAmount, a.figures.payoutAmount);
  // A different scenario has a different digest.
  const d = computed(ev(weekdayScenario({ work: { regularWeekdayHours: num(41) } })));
  assert.notEqual(d.runs[0]?.engineInputDigest, a.runs[0]?.engineInputDigest);
});

test('R1: the engine input is replayable through the existing Tier A contract (every day cell <= 24 h, <= 5 grids)', () => {
  const s = weekdayScenario({ work: { regularWeekdayHours: num(100), publicHolidayHours: num(60) }, pay: { hourlyRate: num(16.8), publicHolidayPremiumPercent: num(100) } });
  const r = computed(ev(s));
  const input = r.runs[0]?.engineInput;
  assert.ok(input && input.week_grids.length <= 5);
  for (const grid of input.week_grids) for (const cell of Object.values(grid)) assert.ok(cell.regular_hours + cell.overtime_hours <= 24);
  assert.equal(r.figures.hoursWorked, 160);
});

// ---- 16-18: ranges -----------------------------------------------------------------------------

test('R1 #16/#18: a material uncertainty yields a range whose endpoints are separate engine runs', () => {
  const s = weekdayScenario({ work: { regularWeekdayHours: num(40), sundayHours: num(8) }, pay: { hourlyRate: num(16.8, 'document'), sundayPremiumPercent: range(50, 100, 'loonto_assumption') } });
  const r = computed(ev(s));
  assert.ok(r.range, 'a €67 gross swing is material');
  assert.equal(r.runs.length, 3, 'central + two endpoints = three separate engine runs');
  const low = oracleResult(oracleInput({ week_grids: [dayGrid({ mon: { regular: 8 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 }, sun: { regular: 8 } })], sunday_percent: 50 }));
  const high = oracleResult(oracleInput({ week_grids: [dayGrid({ mon: { regular: 8 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 }, sun: { regular: 8 } })], sunday_percent: 100 }));
  assert.equal(r.range.low, low.result.payout_amount, 'low endpoint = the engine at 50%');
  assert.equal(r.range.high, high.result.payout_amount, 'high endpoint = the engine at 100%');
  assert.equal(r.range.basis, 'payout_amount');
  assert.equal(r.runs[r.range.lowRun]?.assignments['pay.sundayPremiumPercent'], 50);
  assert.equal(r.runs[r.range.highRun]?.assignments['pay.sundayPremiumPercent'], 100);
  assert.deepEqual(r.range.uncertainFields, ['pay.sundayPremiumPercent']);
  assert.equal(r.runs[0]?.kind, 'central');
  assert.equal(r.runs[0]?.assignments['pay.sundayPremiumPercent'], 75, 'the central variant is the midpoint');
  assert.equal(r.figures.payoutAmount, r.runs[0]?.figures.payoutAmount);
  // The assumption behind the range is reported as used.
  assert.deepEqual(r.assumptionsUsed, [{ path: 'pay.sundayPremiumPercent', state: 'range' }]);
});

test('R1 #17: a sub-material uncertainty does not produce an unnecessary range', () => {
  const s = weekdayScenario({ pay: { hourlyRate: range(16.8, 16.81, 'document') } });
  const r = computed(ev(s));
  assert.equal(r.range, null);
  assert.equal(r.runs.length, 3, 'the variants were still evaluated by the engine');
  assert.ok(r.figures.payoutAmount > 0);
});

test('R1 #18b: tax-credit alternatives run both variants and produce a material range (Lock §33)', () => {
  const s = weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } });
  const r = computed(ev(s));
  assert.ok(r.range);
  const applied = oracleResult(oracleInput({ apply_loonheffingskorting: true })).result.payout_amount;
  const notApplied = oracleResult(oracleInput({ apply_loonheffingskorting: false })).result.payout_amount;
  assert.equal(r.range.high, applied);
  assert.equal(r.range.low, notApplied);
  assert.equal(r.runs[0]?.assignments['tax.loonheffingskorting'], 'applied', 'the producer-first option is the representative');
  assert.equal(r.figures.payoutAmount, applied);
});

test('R1 §9: the materiality threshold is the LARGER of EUR 5 and 1% of the payout, defined in one place', () => {
  assert.equal(rangeMaterialityThreshold(200), 5);
  assert.equal(rangeMaterialityThreshold(500), 5);
  assert.equal(rangeMaterialityThreshold(1000), 10);
  assert.equal(rangeMaterialityThreshold(2500), 25);
  const s = weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } });
  const r = computed(ev(s));
  assert.ok(r.range);
  assert.equal(r.range.threshold, Number(rangeMaterialityThreshold(r.range.referencePayout).toFixed(2)));
  assert.ok(r.range.swing >= r.range.threshold);
});

test('R1 §9: the engine\'s own estimate-mode range is carried from the engine, never recomputed - and is sub-material, so no range is shown', () => {
  const r = computed(ev(weekdayScenario({ deductions: { mode: choice('estimate' as const, 'loonto_assumption') } })));
  const oracle = oracleResult(oracleInput({ deductions: { mode: 'estimate' } }));
  assert.equal(r.figures.payoutAmount, oracle.result.payout_amount);
  assert.deepEqual(r.runs[0]?.estimate?.payoutRange, oracle.computed.status === 'computed' ? oracle.computed.payout_range : undefined);
  assert.equal(r.range, null, 'a ~EUR 3.5 engine swing is below max(EUR 5, 1%)');
  assert.ok(r.warnings.some((w) => w.code === 'sector_premium_estimated'));
  assert.deepEqual(r.assumptionsUsed, [{ path: 'deductions.mode', state: 'known' }]);
});

test('R1 §9: too many uncertain values are unsupported rather than approximated', () => {
  const s = weekdayScenario({
    work: { regularWeekdayHours: range(30, 40), sundayHours: range(2, 8), saturdayHours: range(2, 8) },
    pay: { hourlyRate: range(16, 17), saturdayPremiumPercent: range(25, 50), sundayPremiumPercent: range(50, 100) },
  });
  const r = ev(s);
  assert.equal(r.status, 'unsupported');
  assert.ok(r.status === 'unsupported' && r.unsupported.some((u) => u.kind === 'capability' && u.capability === 'too_many_variants' && u.params.max === MAX_VARIANT_RUNS));
});

// ---- 20: unsupported ------------------------------------------------------------------------------

test('R1 #20: a concept the engine cannot represent returns an explicit unsupported result - never silently omitted', () => {
  const s = weekdayScenario({ requestedConcepts: [{ concept: 'night_premium', source: 'user' }, { concept: 'recurring_net_deduction', source: 'document', ref: 'doc-1' }] });
  const r = ev(s);
  assert.equal(r.status, 'unsupported');
  assert.ok(r.status === 'unsupported');
  assert.deepEqual(r.unsupported.map((u) => (u.kind === 'concept' ? u.concept : '')), ['night_premium', 'recurring_net_deduction']);
  assert.ok(r.unsupported.every((u) => u.kind === 'concept' && u.reason === 'engine_cannot_represent' && u.gap.length > 0));
  assert.ok(!('figures' in r) && !('runs' in r));
});

test('R1: lifecycle priority - invalid beats unsupported beats blocked beats computed', () => {
  const unsupportedAndBlocked = weekdayScenario({ pay: {}, requestedConcepts: [{ concept: 'et_exchange', source: 'user' }] });
  assert.equal(ev(unsupportedAndBlocked).status, 'unsupported');
  const invalidToo = weekdayScenario({ pay: {}, work: { regularWeekdayHours: num(-1) }, requestedConcepts: [{ concept: 'et_exchange', source: 'user' }] });
  assert.equal(ev(invalidToo).status, 'invalid');
});

test('R1: a travel allowance and accruing vakantiegeld are carried; accruing vakantiegeld is money-neutral', () => {
  const plain = computed(ev(weekdayScenario()));
  const withVg = computed(ev(weekdayScenario({ extras: { vakantiegeld: { mode: choice('accruing' as const), percent: num(8, 'document') } } })));
  assert.equal(withVg.figures.payoutAmount, plain.figures.payoutAmount, 'accruing vakantiegeld is outside gross and net');
  const withTravel = computed(ev(weekdayScenario({ extras: { travelAllowance: num(25) } })));
  assert.equal(withTravel.figures.payoutAmount, oracleResult(oracleInput({ travel_allowance: 25 })).result.payout_amount);
  assert.equal(withTravel.runs[0]?.engineInput.vakantiegeld.mode, 'none');
});
