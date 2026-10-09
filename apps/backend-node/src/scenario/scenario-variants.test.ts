import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Cursor review findings F1 (variant amplification) and F2 (resolved-variant revalidation).
 *
 * The real Tier A engine is wrapped in a call counter (it still computes for real - the wrapper only
 * counts) so the tests can prove the ORDER of operations, not just the final status:
 *   - an over-cap candidate space is rejected before Tier A is called and before any variant is built
 *     (`structuredClone` is what building a resolved variant costs, so it is counted too);
 *   - an invalid resolved variant never reaches Tier A - not even the valid variants beside it.
 * The mock must be registered before the modules under test are first imported, hence dynamic imports.
 */

const realTierA = await import('../payroll-engine/tier-a.js');
let engineCalls = 0;
mock.module('../payroll-engine/tier-a.js', {
  namedExports: {
    ...realTierA,
    computeTierAResult: (...args: Parameters<typeof realTierA.computeTierAResult>) => {
      engineCalls++;
      return realTierA.computeTierAResult(...args);
    },
  },
});

const { evaluateScenario, planVariantRuns } = await import('./scenario-evaluate.js');
const { MAX_VARIANT_RUNS } = await import('./scenario-config.js');
const { RATES_2026, alternatives, choice, dayGrid, num, oracleInput, oracleResult, range, weekdayScenario } = await import('../test-support/scenario-fixtures.js');
type Scenario = ReturnType<typeof weekdayScenario>;

/** Runs `fn` and reports how many engine calls and resolved-variant clones it caused. */
function measured<T>(fn: () => T): { out: T; engineCalls: number; clones: number } {
  const realClone = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    clones++;
    return realClone(value, options);
  }) as typeof structuredClone;
  const before = engineCalls;
  try {
    const out = fn();
    return { out, engineCalls: engineCalls - before, clones };
  } finally {
    globalThis.structuredClone = realClone;
  }
}

const ev = (s: unknown) => evaluateScenario(s, RATES_2026);
const OT = { thresholdHoursPerDay: num(2), tier1Percent: num(25), tier2Percent: num(50) };
const overtimeScenario = (work: Scenario['work']): Scenario => weekdayScenario({ work, pay: { hourlyRate: num(16.8, 'document'), overtime: OT } });

// ---------------------------------------------------------------------------------------------
// F1 - count first, reject, only then enumerate
// ---------------------------------------------------------------------------------------------

test('F1-A: one run over the cap -> unsupported/too_many_variants; Tier A is never called and no variant is built', () => {
  // 4 independent ranges = 2^4 = 16 corner runs + 1 central = 17 > 16
  const s = weekdayScenario({
    work: { regularWeekdayHours: range(30, 40), saturdayHours: range(1, 8) },
    pay: { hourlyRate: range(16, 17), saturdayPremiumPercent: range(25, 50) },
  });
  const { out, engineCalls: calls, clones } = measured(() => ev(s));
  assert.equal(out.status, 'unsupported');
  assert.ok(out.status === 'unsupported');
  assert.deepEqual(out.unsupported, [{ kind: 'capability', capability: 'too_many_variants', params: { atLeastRuns: 17, max: MAX_VARIANT_RUNS } }]);
  assert.equal(calls, 0, 'Tier A not invoked');
  assert.equal(clones, 0, 'no resolved variant was constructed');
  assert.ok(!('figures' in out) && !('runs' in out));
});

test('F1-B: a review-style candidate space (every uncertain field at once) fails closed before enumeration', () => {
  const s = weekdayScenario({
    work: { regularWeekdayHours: range(30, 40), overtimeHours: range(2, 6), overtimeDistribution: alternatives([{ kind: 'even' as const, days: 2 as const }, { kind: 'even' as const, days: 3 as const }]), saturdayHours: range(1, 8), sundayHours: range(1, 8), publicHolidayHours: range(1, 8) },
    pay: {
      hourlyRate: range(16, 17), saturdayPremiumPercent: range(25, 50), sundayPremiumPercent: range(50, 100), publicHolidayPremiumPercent: range(100, 150),
      overtime: { thresholdHoursPerDay: range(1, 3), tier1Percent: range(20, 25), tier2Percent: range(40, 50) },
    },
    tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) },
    deductions: { mode: alternatives(['enter', 'estimate'] as const), entered: { pension: range(1, 2), paww: range(0, 1), sectorPremium: range(1, 3), postTaxOther: range(0, 2) } },
    extras: { travelAllowance: range(0, 10), vakantiegeld: { mode: alternatives(['none', 'accruing'] as const), percent: range(5, 8) } },
  });
  const { out, engineCalls: calls, clones } = measured(() => ev(s));
  assert.equal(out.status, 'unsupported', 'about 2^23 combinations existed before the fix');
  assert.equal(calls, 0);
  assert.equal(clones, 0, 'nothing was resolved, let alone 8 million variants');
  // Counting stopped at the first dimension that crossed the cap - it did not count them all.
  assert.ok(out.status === 'unsupported' && out.unsupported[0]?.kind === 'capability' && (out.unsupported[0].params.atLeastRuns <= 17 * 2));
  // Repeating it is just as cheap: there is no state and nothing accumulates.
  for (let i = 0; i < 25; i++) assert.equal(measured(() => ev(s)).clones, 0);
});

test('F1-B2: the planner sees only candidate COUNTS - it is bounded, overflow-free and exact at the boundary', () => {
  assert.deepEqual(planVariantRuns([]), { status: 'within_cap', totalRuns: 1 });
  assert.deepEqual(planVariantRuns([2, 2, 2]), { status: 'within_cap', totalRuns: 9 });
  assert.deepEqual(planVariantRuns([15]), { status: 'within_cap', totalRuns: 16 }, 'exactly at the cap');
  assert.deepEqual(planVariantRuns([3, 5]), { status: 'within_cap', totalRuns: 16 });
  assert.deepEqual(planVariantRuns([16]), { status: 'over_cap', atLeastRuns: 17 }, 'one over');
  assert.deepEqual(planVariantRuns([2, 2, 2, 2]), { status: 'over_cap', atLeastRuns: 17 });
  // Enormous / many dimensions: the early exit means the running product never exceeds cap x largest count.
  for (const counts of [[2 ** 40], [1e9, 1e9, 1e9], Array(1000).fill(2), Array(64).fill(10), [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
    const plan = planVariantRuns(counts);
    assert.equal(plan.status, 'over_cap');
    assert.ok(plan.status === 'over_cap' && Number.isFinite(plan.atLeastRuns) && plan.atLeastRuns > MAX_VARIANT_RUNS);
  }
  // Agrees with an exact BigInt reference on random inputs.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 500; i++) {
    const counts = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => 1 + Math.floor(rnd() * 8));
    const exact = counts.reduce((a, c) => a * BigInt(c), 1n) + 1n;
    const plan = planVariantRuns(counts);
    assert.equal(plan.status === 'within_cap', exact <= BigInt(MAX_VARIANT_RUNS), JSON.stringify(counts));
    if (plan.status === 'within_cap') assert.equal(BigInt(plan.totalRuns), exact);
  }
  // A smaller explicit cap is honoured.
  assert.equal(planVariantRuns([3], 4).status, 'within_cap', '1 central + 3 = 4 runs, cap 4');
  assert.equal(planVariantRuns([3], 3).status, 'over_cap', '4 runs > cap 3');
});

test('F1-C: a candidate count exactly within the cap evaluates normally, calling the engine once per planned run', () => {
  // central + 3 ranges (2^3 = 8) = 9 planned runs
  const s = weekdayScenario({ work: { regularWeekdayHours: range(30, 40), saturdayHours: range(1, 8) }, pay: { hourlyRate: range(16, 17), saturdayPremiumPercent: num(25) } });
  const { out, engineCalls: calls } = measured(() => ev(s));
  assert.equal(out.status, 'computed');
  assert.ok(out.status === 'computed');
  assert.equal(calls, 9);
  assert.equal(out.runs.length, 9);
  assert.equal(out.runs[0]?.kind, 'central');

  // exactly MAX_VARIANT_RUNS planned runs: central + 15 alternatives of one choice
  const fifteen = Array.from({ length: 15 }, (_, i) => ({ kind: 'even' as const, days: ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5 }));
  const atCap = overtimeScenario({ regularWeekdayHours: num(40), overtimeHours: num(4), overtimeDistribution: alternatives(fifteen) });
  const capped = measured(() => ev(atCap));
  assert.equal(capped.out.status, 'computed');
  assert.equal(capped.engineCalls, 16, 'exactly the cap: 1 central + 15');
  assert.ok(capped.out.status === 'computed');
  // output unchanged: the central variant is the first option, and identical engine inputs are evaluated once
  assert.equal(capped.out.runs.length, 5, 'five distinct overtime layouts');
  const first = oracleResult(oracleInput({
    week_grids: [dayGrid({ mon: { regular: 8, overtime: 4 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 } })],
    overtime_tier_threshold_hours: 2, overtime_tier_1_percent: 25, overtime_tier_2_percent: 50,
  }));
  assert.equal(capped.out.figures.payoutAmount, first.result.payout_amount);

  // one more candidate -> over the cap, nothing runs
  const sixteen = [...fifteen, { kind: 'even' as const, days: 1 as const }];
  const over = measured(() => ev(overtimeScenario({ regularWeekdayHours: num(40), overtimeHours: num(4), overtimeDistribution: alternatives(sixteen) })));
  assert.equal(over.out.status, 'unsupported');
  assert.equal(over.engineCalls, 0);
  assert.equal(over.clones, 0);
});

test('F1: a Scenario with no uncertainty is a single engine run (no variants, no planning overhead visible)', () => {
  const { out, engineCalls: calls } = measured(() => ev(weekdayScenario()));
  assert.ok(out.status === 'computed');
  assert.equal(calls, 1);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0]?.kind, 'single');
});

// ---------------------------------------------------------------------------------------------
// F2 - every resolved variant is revalidated, and an invalid one never reaches Tier A
// ---------------------------------------------------------------------------------------------

function assertInvalidWithoutMoney(scenario: Scenario, code: string, label: string) {
  const { out, engineCalls: calls } = measured(() => ev(scenario));
  assert.equal(out.status, 'invalid', label);
  assert.ok(out.status === 'invalid');
  assert.ok(out.issues.some((i) => i.code === code && i.variant), `${label}: ${JSON.stringify(out.issues)}`);
  assert.ok(!('figures' in out) && !('runs' in out), `${label}: no money result`);
  assert.equal(calls, 0, `${label}: not even the valid variants are priced - Tier A is never called`);
  return out;
}

test('F2 probe A: overtime range 4-12 with an explicit Monday-8 layout is invalid (the 4 h and 12 h variants disagree)', () => {
  const out = assertInvalidWithoutMoney(
    overtimeScenario({ regularWeekdayHours: num(40), overtimeHours: range(4, 12), overtimeDistribution: choice({ kind: 'explicit' as const, byDay: { mon: 8, tue: 0, wed: 0, thu: 0, fri: 0 } }) }),
    'overtime_distribution_mismatch',
    'A',
  );
  // It names the offending variants (4 h and 12 h), not the central 8 h one that happens to agree.
  const hours = out.issues.map((i) => i.variant?.['work.overtimeHours']).sort();
  assert.deepEqual(hours, [12, 4]);
  assert.ok(out.issues.every((i) => i.params?.distributed === 8));
});

test('F2 probe B: known overtime 10 with explicit alternatives Mon-10 | Mon-20 is invalid (the 20 h layout cannot be priced)', () => {
  const out = assertInvalidWithoutMoney(
    overtimeScenario({
      regularWeekdayHours: num(40),
      overtimeHours: num(10),
      overtimeDistribution: alternatives([{ kind: 'explicit' as const, byDay: { mon: 10, tue: 0, wed: 0, thu: 0, fri: 0 } }, { kind: 'explicit' as const, byDay: { mon: 20, tue: 0, wed: 0, thu: 0, fri: 0 } }]),
    }),
    'overtime_distribution_mismatch',
    'B',
  );
  // Only the Monday-20 variant is impossible - and it breaks two rules at once (sum != 10, and 8 + 20 > 24 h).
  assert.deepEqual(out.issues.map((i) => i.code).sort(), ['day_hours_exceed_24', 'overtime_distribution_mismatch']);
  assert.ok(out.issues.every((i) => String(i.variant?.['work.overtimeDistribution']).includes('"mon":20')), 'the valid Monday-10 variant is not blamed');
  const mismatch = out.issues.find((i) => i.code === 'overtime_distribution_mismatch');
  assert.equal(mismatch?.params?.distributed, 20);
  assert.equal(mismatch?.params?.overtimeHours, 10);
});

test('F2 probe C: 40 regular + 20 overtime with even-over-1-day | even-over-5-days is invalid (28 h in one day)', () => {
  const out = assertInvalidWithoutMoney(
    overtimeScenario({ regularWeekdayHours: num(40), overtimeHours: num(20), overtimeDistribution: alternatives([{ kind: 'even' as const, days: 1 as const }, { kind: 'even' as const, days: 5 as const }]) }),
    'day_hours_exceed_24',
    'C',
  );
  assert.equal(out.issues.length, 1);
  assert.equal(out.issues[0]?.params?.day, 'mon');
  assert.equal(out.issues[0]?.params?.hours, 28);
});

test('F2: the same layouts submitted as plain KNOWN values were already invalid - variants are now held to the same rule', () => {
  const known = (distribution: Scenario['work']['overtimeDistribution'], hours: number) => ev(overtimeScenario({ regularWeekdayHours: num(40), overtimeHours: num(hours), overtimeDistribution: distribution }));
  assert.equal(known(choice({ kind: 'explicit' as const, byDay: { mon: 8, tue: 0, wed: 0, thu: 0, fri: 0 } }), 4).status, 'invalid');
  assert.equal(known(choice({ kind: 'explicit' as const, byDay: { mon: 20, tue: 0, wed: 0, thu: 0, fri: 0 } }), 10).status, 'invalid');
  assert.equal(known(choice({ kind: 'even' as const, days: 1 as const }), 20).status, 'invalid');
});

test('F2-D: a valid explicit distribution whose byDay sum equals overtimeHours still computes (and equals the engine)', () => {
  const r = ev(overtimeScenario({ regularWeekdayHours: num(40), overtimeHours: num(10), overtimeDistribution: choice({ kind: 'explicit' as const, byDay: { mon: 4, tue: 6, wed: 0, thu: 0, fri: 0 } }) }));
  assert.ok(r.status === 'computed');
  const oracle = oracleResult(oracleInput({
    week_grids: [dayGrid({ mon: { regular: 8, overtime: 4 }, tue: { regular: 8, overtime: 6 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 } })],
    overtime_tier_threshold_hours: 2, overtime_tier_1_percent: 25, overtime_tier_2_percent: 50,
  }));
  assert.equal(r.figures.payoutAmount, oracle.result.payout_amount);
  assert.equal(r.figures.hoursWorked, 50);
  // Several valid explicit layouts as alternatives all compute, each priced by the engine.
  const alt = measured(() => ev(overtimeScenario({
    regularWeekdayHours: num(40), overtimeHours: num(10),
    overtimeDistribution: alternatives([{ kind: 'explicit' as const, byDay: { mon: 10, tue: 0, wed: 0, thu: 0, fri: 0 } }, { kind: 'explicit' as const, byDay: { mon: 5, tue: 5, wed: 0, thu: 0, fri: 0 } }]),
  })));
  assert.ok(alt.out.status === 'computed');
  assert.equal(alt.engineCalls, 3);
});

test('F2-E: a ranged / alternative Scenario whose every resolved variant is valid computes, deterministically', () => {
  const s = overtimeScenario({ regularWeekdayHours: num(40), overtimeHours: range(4, 12), overtimeDistribution: choice({ kind: 'even' as const, days: 5 as const }) });
  const a = ev(s);
  const b = ev(s);
  assert.ok(a.status === 'computed');
  assert.deepEqual(a, b);
  assert.equal(a.runs.length, 3);
  assert.deepEqual(a.runs.map((r) => r.assignments['work.overtimeHours']), [8, 4, 12]);
  for (const run of a.runs) assert.ok(run.engineResult.payout_amount > 0);
  // Mixed: a range and an alternatives choice, every combination valid.
  const mixed = ev(weekdayScenario({ work: { regularWeekdayHours: range(36, 40) }, tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } }));
  assert.ok(mixed.status === 'computed');
  assert.ok(mixed.runs.length >= 4);
});

test('F2-F: the holiday / weekend second-grid behaviour is unchanged, in every evaluated variant', () => {
  const s = weekdayScenario({
    work: { regularWeekdayHours: num(32), sundayHours: num(8), publicHolidayHours: num(8) },
    pay: { hourlyRate: num(16.8, 'document'), sundayPremiumPercent: range(50, 100, 'loonto_assumption'), publicHolidayPremiumPercent: num(100, 'cao_rule') },
  });
  const r = ev(s);
  assert.ok(r.status === 'computed');
  assert.equal(r.runs.length, 3);
  for (const run of r.runs) {
    assert.equal(run.engineInput.week_grids.length, 2, 'main grid + holiday bucket');
    assert.equal(Object.values(run.engineInput.week_grids[1] ?? {}).filter((c) => c.is_public_holiday).reduce((a, c) => a + c.regular_hours, 0), 8);
    assert.equal(run.engineInput.week_grids[0]?.sun.regular_hours, 8);
    assert.equal(run.figures.hoursWorked, 48, 'weekday 32 + Sunday 8 + holiday 8, nothing double counted');
  }
  const oracleAt = (sunday: number) => oracleResult(oracleInput({
    week_grids: [
      dayGrid({ mon: { regular: 6.4 }, tue: { regular: 6.4 }, wed: { regular: 6.4 }, thu: { regular: 6.4 }, fri: { regular: 6.4 }, sun: { regular: 8 } }),
      dayGrid({ mon: { regular: 8, holiday: true } }),
    ],
    sunday_percent: sunday, holiday_percent: 100,
  })).result.payout_amount;
  assert.equal(r.runs.find((x) => x.assignments['pay.sundayPremiumPercent'] === 50)?.engineResult.payout_amount, oracleAt(50));
  assert.equal(r.runs.find((x) => x.assignments['pay.sundayPremiumPercent'] === 100)?.engineResult.payout_amount, oracleAt(100));
});

test('F2: top-level problems are still reported as before (a known invalid Scenario is not turned into a variant issue)', () => {
  const r = ev(weekdayScenario({ work: { regularWeekdayHours: num(-3) }, tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } }));
  assert.ok(r.status === 'invalid');
  assert.ok(r.issues.every((i) => i.variant === undefined), 'a top-level issue carries no variant');
  assert.ok(r.issues.some((i) => i.code === 'negative_hours'));
});
