import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { computeTierAResult } from '../payroll-engine/tier-a.js';
import { periodMultiplierFor, type PayslipComputationRates } from '../payroll-engine/payslip-model.js';
import { evaluateScenario } from '../scenario/scenario-evaluate.js';
import { alternatives, choice, dayGrid, num, oracleInput, range, weekdayScenario } from '../test-support/scenario-fixtures.js';

/**
 * R1 backend boundary: `POST /api/scenario/evaluate` over real HTTP. The rates source is mocked to a
 * fixed static period (read from packages/tax-tables) so the test does not depend on today's date or a
 * database. `globalThis.fetch` is wrapped to PROVE the deterministic boundary makes no outbound call
 * (no LLM, no Gemini, no document read).
 *
 * F3 (Cursor review): the HTTP response is the PUBLIC projection - no `engineInput` / `engineResult`.
 * Replay (Scenario -> Tier A) is verified through the INTERNAL evaluator, never through this endpoint.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const staticFile = JSON.parse(readFileSync(path.resolve(here, '../../../../packages/tax-tables/2026-rates.json'), 'utf-8')) as { periods: Array<{ loonheffing_brackets: unknown; heffingskortingen: unknown }> };
const PERIOD = staticFile.periods[staticFile.periods.length - 1] as { loonheffing_brackets: unknown; heffingskortingen: unknown };
const RATES = { loonheffing_brackets: PERIOD.loonheffing_brackets, heffingskortingen: PERIOD.heffingskortingen, period_multiplier: periodMultiplierFor('week') } as PayslipComputationRates;

let app: (typeof import('../app.js'))['default'];
let server: ReturnType<typeof app.listen>;
let baseUrl: string;
const outbound: string[] = [];
const realFetch = globalThis.fetch;

before(async () => {
  mock.module('../rules-repository.js', {
    namedExports: {
      getCurrentRule: async () => PERIOD,
      getRuleAt: async () => null,
      getMinimumWageAt: async () => null,
      listRuleFreshness: async () => [],
    },
  });
  ({ default: app } = await import('../app.js'));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (!url.startsWith(baseUrl)) outbound.push(url);
    return realFetch(input, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function post(route: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

type Variant = { kind: string; assignments: Record<string, unknown>; figures: { payoutAmount: number } };
type EvaluateBody = {
  evaluation: {
    status: string;
    figures?: { payoutAmount: number; hoursWorked: number };
    variants?: Variant[];
    requirements?: Array<{ field: string }>;
    issues?: Array<{ code: string; variant?: Record<string, unknown> }>;
    unsupported?: Array<{ kind: string; params?: { atLeastRuns: number; max: number } }>;
    range: { lowVariant: number; highVariant: number; low: number; high: number } | null;
  };
  comparison?: { status: string; delta?: { payoutAmount: number } };
  taxRatesSource: string;
};

/** Every key anywhere in a JSON value. */
function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, into));
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

/** Replay-only / engine-internal structures that must never appear in a public response. */
const ENGINE_INTERNAL_KEYS = ['engineInput', 'engineResult', 'engineInputDigest', 'consumption', 'week_grids', 'hour_lines', 'hourly_rate', 'outcome', 'period', 'estimate', 'sector_premium_estimate'];

// ---------------------------------------------------------------------------------------------
// Boundary behaviour
// ---------------------------------------------------------------------------------------------

test('R1 endpoint: a ready Scenario returns a computed evaluation equal to the engine, with no outbound call', async () => {
  const res = await post('/api/scenario/evaluate', { scenario: weekdayScenario({ work: { regularWeekdayHours: num(40), saturdayHours: num(8) }, pay: { hourlyRate: num(16.8, 'document'), saturdayPremiumPercent: num(50, 'cao_rule') } }) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as EvaluateBody;
  assert.equal(body.evaluation.status, 'computed');
  assert.equal(body.taxRatesSource, 'database', 'the (mocked) rules repository answered');

  const expected = computeTierAResult(
    oracleInput({ week_grids: [dayGrid({ mon: { regular: 8 }, tue: { regular: 8 }, wed: { regular: 8 }, thu: { regular: 8 }, fri: { regular: 8 }, sat: { regular: 8 } })], saturday_percent: 50 }),
    RATES,
  );
  assert.ok(expected.status === 'computed' && expected.outcome.status === 'complete');
  assert.equal(body.evaluation.figures?.payoutAmount, expected.status === 'computed' && expected.outcome.status === 'complete' ? expected.outcome.result.payout_amount : -1);
  assert.equal(body.evaluation.figures?.hoursWorked, 48);
  assert.equal(body.evaluation.range, null);
  assert.deepEqual(outbound, [], 'no LLM / Gemini / network call: the boundary is deterministic only');
});

test('R1 endpoint: the same request twice gives byte-identical responses (deterministic, stateless)', async () => {
  const request = { scenario: weekdayScenario() };
  const a = await (await post('/api/scenario/evaluate', request)).text();
  const b = await (await post('/api/scenario/evaluate', request)).text();
  assert.equal(a, b);
});

test('R1 endpoint: domain problems are 200 with structured status, never a 400 and never a fabricated result', async () => {
  const blocked = (await (await post('/api/scenario/evaluate', { scenario: weekdayScenario({ pay: {} }) })).json()) as EvaluateBody;
  assert.equal(blocked.evaluation.status, 'blocked');
  assert.deepEqual(blocked.evaluation.requirements?.map((r) => r.field), ['pay.hourlyRate']);
  assert.equal(blocked.evaluation.figures, undefined);

  const invalid = await post('/api/scenario/evaluate', { scenario: weekdayScenario({ work: { regularWeekdayHours: num(-4) } }) });
  assert.equal(invalid.status, 200);
  const invalidBody = (await invalid.json()) as EvaluateBody;
  assert.equal(invalidBody.evaluation.status, 'invalid');
  assert.ok(invalidBody.evaluation.issues?.some((i) => i.code === 'negative_hours'));

  const unsupported = (await (await post('/api/scenario/evaluate', { scenario: weekdayScenario({ requestedConcepts: [{ concept: 'night_premium', source: 'user' }] }) })).json()) as EvaluateBody;
  assert.equal(unsupported.evaluation.status, 'unsupported');
  assert.equal(unsupported.evaluation.unsupported?.length, 1);

  const unsupportedPeriod = (await (await post('/api/scenario/evaluate', { scenario: { ...weekdayScenario(), periodType: 'month' } })).json()) as EvaluateBody;
  assert.equal(unsupportedPeriod.evaluation.status, 'invalid');
  assert.ok(unsupportedPeriod.evaluation.issues?.some((i) => i.code === 'unsupported_period_type'));
});

test('R1 endpoint: a malformed (wrong-shape) request is a 400 invalid_input', async () => {
  for (const bad of [{}, { scenario: 5 }, { scenario: { ...weekdayScenario(), work: 'x' } }, { scenario: weekdayScenario(), extra: 1 }, { scenario: { ...weekdayScenario(), surprise: true } }, { scenario: weekdayScenario({ pay: { hourlyRate: { state: 'known', value: 'abc' as unknown as number, source: 'user' } } }) }]) {
    const res = await post('/api/scenario/evaluate', bad);
    assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal(((await res.json()) as { error_code: string }).error_code, 'invalid_input');
  }
});

test('R1 endpoint: an optional second Scenario returns a comparison built from the two engine results', async () => {
  const a = weekdayScenario({ scenarioId: 'a' });
  const b = weekdayScenario({ scenarioId: 'b', work: { regularWeekdayHours: num(45) } });
  const body = (await (await post('/api/scenario/evaluate', { scenario: a, compareTo: b })).json()) as EvaluateBody;
  assert.equal(body.comparison?.status, 'comparable');
  const ea = computeTierAResult(oracleInput(), RATES);
  const eb = computeTierAResult(oracleInput({ week_grids: [dayGrid({ mon: { regular: 9 }, tue: { regular: 9 }, wed: { regular: 9 }, thu: { regular: 9 }, fri: { regular: 9 } })] }), RATES);
  assert.ok(ea.status === 'computed' && ea.outcome.status === 'complete' && eb.status === 'computed' && eb.outcome.status === 'complete');
  if (ea.status === 'computed' && ea.outcome.status === 'complete' && eb.status === 'computed' && eb.outcome.status === 'complete') {
    assert.equal(body.comparison?.delta?.payoutAmount, Number((eb.outcome.result.payout_amount - ea.outcome.result.payout_amount).toFixed(2)));
  }
  // No compareTo -> no comparison key.
  const single = (await (await post('/api/scenario/evaluate', { scenario: a })).json()) as EvaluateBody;
  assert.equal(single.comparison, undefined);
});

test('R1 endpoint: a material range is returned with its evaluated variants (public shape)', async () => {
  const body = (await (await post('/api/scenario/evaluate', { scenario: weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } }) })).json()) as EvaluateBody;
  assert.equal(body.evaluation.status, 'computed');
  assert.ok(body.evaluation.range);
  assert.equal(body.evaluation.variants?.length, 2, 'the central variant IS the first option, so it is not evaluated twice');
  const { range: r, variants } = body.evaluation;
  assert.equal(variants?.[r.lowVariant]?.figures.payoutAmount, r.low, 'the range endpoints are variants the engine evaluated');
  assert.equal(variants?.[r.highVariant]?.figures.payoutAmount, r.high);
  assert.equal(variants?.[r.highVariant]?.assignments['tax.loonheffingskorting'], 'applied');
  assert.equal(variants?.[r.lowVariant]?.assignments['tax.loonheffingskorting'], 'not_applied');
});

test('R1 endpoint: /turn is R2\'s own route (not part of /evaluate), and the existing Tier A route is untouched', async () => {
  // R2 added POST /api/scenario/turn. Without a database its fail-closed limiter answers 503 here; the
  // conversation behaviour itself is covered in conversation.controller.test.ts.
  assert.notEqual((await post('/api/scenario/turn', { scenario: weekdayScenario() })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/scenario/evaluate`)).status, 404, 'POST only');
  const tierA = await post('/api/tier-a/calculate', oracleInput());
  assert.equal(tierA.status, 200);
  assert.equal(((await tierA.json()) as { status: string }).status, 'computed');
});

test('F3-D: Scenario -> Tier A replay is verified through the INTERNAL evaluator (incl. the holiday bucket), not through the endpoint', async () => {
  const scenario = weekdayScenario({
    work: { regularWeekdayHours: num(32), publicHolidayHours: num(8), saturdayHours: num(4) },
    pay: { hourlyRate: num(16.8, 'document'), publicHolidayPremiumPercent: num(100, 'cao_rule'), saturdayPremiumPercent: num(50, 'cao_rule') },
  });
  const internal = evaluateScenario(scenario, RATES);
  assert.equal(internal.status, 'computed');
  assert.ok(internal.status === 'computed');
  if (internal.status !== 'computed') return;
  assert.equal(internal.runs[0]?.engineInput.week_grids.length, 2, 'the holiday second-grid behaviour is unchanged');
  // The internal engine input is accepted by the EXISTING public Tier A contract and gives the same figures.
  const replay = await post('/api/tier-a/calculate', internal.runs[0]?.engineInput);
  assert.equal(replay.status, 200, 'the Scenario mapper only produces inputs the existing Tier A contract accepts');
  const replayed = (await replay.json()) as { status: string; outcome: { result: { payout_amount: number; gross_total: number } } };
  assert.equal(replayed.status, 'computed');
  assert.equal(replayed.outcome.result.payout_amount, internal.figures.payoutAmount);
  assert.equal(replayed.outcome.result.gross_total, internal.figures.grossTotal);
  // ...and the public endpoint returns the same figures without any of that structure.
  const publicBody = (await (await post('/api/scenario/evaluate', { scenario })).json()) as EvaluateBody;
  assert.equal(publicBody.evaluation.figures?.payoutAmount, internal.figures.payoutAmount);
});

// ---------------------------------------------------------------------------------------------
// F3 - the public response has no engine internals
// ---------------------------------------------------------------------------------------------

function assertNoEngineInternals(json: unknown, label: string): void {
  const keys = allKeys(json);
  for (const forbidden of ENGINE_INTERNAL_KEYS) assert.ok(!keys.has(forbidden), `${label}: response must not contain "${forbidden}"`);
}

test('F3-A: a computed HTTP response recursively contains no engineInput / engineResult (nor any replay-only Tier A structure)', async () => {
  const scenarios = [
    weekdayScenario(),
    weekdayScenario({ work: { regularWeekdayHours: num(40), sundayHours: num(8), publicHolidayHours: num(8) }, pay: { hourlyRate: num(16.8), sundayPremiumPercent: range(50, 100, 'loonto_assumption'), publicHolidayPremiumPercent: num(100) } }),
    weekdayScenario({ deductions: { mode: choice('estimate' as const, 'loonto_assumption') } }),
    weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } }),
  ];
  for (const [i, scenario] of scenarios.entries()) {
    const res = await post('/api/scenario/evaluate', { scenario });
    const body = (await res.json()) as EvaluateBody;
    assert.equal(body.evaluation.status, 'computed', `scenario ${i}`);
    assertNoEngineInternals(body, `computed #${i}`);
  }
});

test('F3-A2: the computed response has EXACTLY the public allow-list of keys', async () => {
  const body = (await (await post('/api/scenario/evaluate', { scenario: weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } }) })).json()) as EvaluateBody;
  assert.deepEqual(Object.keys(body).sort(), ['evaluation', 'taxRatesSource']);
  assert.deepEqual(Object.keys(body.evaluation).sort(), ['assumptionsUsed', 'figures', 'provenance', 'range', 'scenario', 'status', 'variants', 'warnings']);
  assert.deepEqual(Object.keys(body.evaluation.figures ?? {}).sort(), ['grossTotal', 'hoursWorked', 'payoutAmount', 'totalTax', 'wageNet']);
  assert.deepEqual(Object.keys(body.evaluation.variants?.[0] ?? {}).sort(), ['assignments', 'figures', 'kind']);
  assert.deepEqual(Object.keys(body.evaluation.range ?? {}).sort(), ['basis', 'high', 'highVariant', 'low', 'lowVariant', 'referencePayout', 'swing', 'threshold', 'uncertainFields']);
});

test('F3-B: a comparison response (comparable and not comparable) also contains no internal engine structures', async () => {
  const a = weekdayScenario({ scenarioId: 'a' });
  const comparable = (await (await post('/api/scenario/evaluate', { scenario: a, compareTo: weekdayScenario({ scenarioId: 'b', work: { regularWeekdayHours: num(45) } }) })).json()) as EvaluateBody;
  assert.equal(comparable.comparison?.status, 'comparable');
  assertNoEngineInternals(comparable, 'comparable');
  assert.deepEqual(Object.keys(comparable.comparison ?? {}).sort(), ['a', 'b', 'delta', 'rangeInvolved', 'status']);
  const notComparable = (await (await post('/api/scenario/evaluate', { scenario: a, compareTo: weekdayScenario({ scenarioId: 'c', pay: {} }) })).json()) as EvaluateBody;
  assert.equal(notComparable.comparison?.status, 'not_comparable');
  assertNoEngineInternals(notComparable, 'not comparable');
});

test('F3-C: blocked / invalid / unsupported responses keep their shape and stay deterministic', async () => {
  const cases: Array<[string, unknown, string[]]> = [
    ['blocked', weekdayScenario({ pay: {} }), ['requirements', 'scenario', 'status', 'warnings']],
    ['invalid', weekdayScenario({ work: { regularWeekdayHours: num(-1) } }), ['issues', 'scenario', 'status']],
    ['unsupported', weekdayScenario({ requestedConcepts: [{ concept: 'et_exchange', source: 'user' }] }), ['scenario', 'status', 'unsupported']],
  ];
  for (const [status, scenario, keys] of cases) {
    const first = await (await post('/api/scenario/evaluate', { scenario })).text();
    const second = await (await post('/api/scenario/evaluate', { scenario })).text();
    assert.equal(first, second, status);
    const body = JSON.parse(first) as EvaluateBody;
    assert.equal(body.evaluation.status, status);
    assert.deepEqual(Object.keys(body.evaluation).sort(), keys, status);
    assertNoEngineInternals(body, status);
  }
});

test('F3: there is no way to ask the endpoint for engine internals - no query flag, header, env switch or body field', async () => {
  const scenario = weekdayScenario();
  for (const [route, headers] of [
    ['/api/scenario/evaluate?debug=1', {}],
    ['/api/scenario/evaluate?diag=1', {}],
    ['/api/scenario/evaluate?internal=true&engine=1&replay=1', {}],
    ['/api/scenario/evaluate', { 'x-debug': '1', 'x-diag': '1', 'x-loonto-internal': '1' }],
  ] as Array<[string, Record<string, string>]>) {
    const res = await post(route, { scenario }, headers);
    assert.equal(res.status, 200, route);
    assertNoEngineInternals(await res.json(), `${route} ${JSON.stringify(headers)}`);
  }
  // A body field asking for them is a strict-schema 400, not an opt-in.
  for (const extra of [{ debug: true }, { includeEngine: true }, { diag: 1 }, { replay: true }]) {
    assert.equal((await post('/api/scenario/evaluate', { scenario, ...extra })).status, 400, JSON.stringify(extra));
  }
});

// ---------------------------------------------------------------------------------------------
// F1 / F2 as seen through HTTP
// ---------------------------------------------------------------------------------------------

test('F1 (HTTP): an over-cap request returns a safe unsupported/too_many_variants and no money (the no-enumeration proof is structural: scenario-variants.test.ts)', async () => {
  const wide = weekdayScenario({
    work: { regularWeekdayHours: range(30, 40), saturdayHours: range(1, 8), sundayHours: range(1, 8), publicHolidayHours: range(1, 8) },
    pay: { hourlyRate: range(16, 17), saturdayPremiumPercent: range(25, 50), sundayPremiumPercent: range(50, 100), publicHolidayPremiumPercent: range(100, 150) },
    extras: { travelAllowance: range(0, 10) },
  });
  const res = await post('/api/scenario/evaluate', { scenario: wide });
  const body = (await res.json()) as EvaluateBody;
  assert.equal(res.status, 200);
  assert.equal(body.evaluation.status, 'unsupported');
  assert.equal(body.evaluation.unsupported?.[0]?.kind, 'capability');
  assert.ok((body.evaluation.unsupported?.[0]?.params?.atLeastRuns ?? 0) > 16);
  assert.equal(body.evaluation.figures, undefined);
});

test('F2 (HTTP): the review probes return invalid with the offending variant and no money', async () => {
  const ot = { thresholdHoursPerDay: num(2), tier1Percent: num(25), tier2Percent: num(50) };
  const probes: Array<[string, ReturnType<typeof weekdayScenario>, string]> = [
    ['A', weekdayScenario({ work: { regularWeekdayHours: num(40), overtimeHours: range(4, 12), overtimeDistribution: choice({ kind: 'explicit' as const, byDay: { mon: 8, tue: 0, wed: 0, thu: 0, fri: 0 } }) }, pay: { hourlyRate: num(16.8), overtime: ot } }), 'overtime_distribution_mismatch'],
    ['B', weekdayScenario({ work: { regularWeekdayHours: num(40), overtimeHours: num(10), overtimeDistribution: alternatives([{ kind: 'explicit' as const, byDay: { mon: 10, tue: 0, wed: 0, thu: 0, fri: 0 } }, { kind: 'explicit' as const, byDay: { mon: 20, tue: 0, wed: 0, thu: 0, fri: 0 } }]) }, pay: { hourlyRate: num(16.8), overtime: ot } }), 'overtime_distribution_mismatch'],
    ['C', weekdayScenario({ work: { regularWeekdayHours: num(40), overtimeHours: num(20), overtimeDistribution: alternatives([{ kind: 'even' as const, days: 1 as const }, { kind: 'even' as const, days: 5 as const }]) }, pay: { hourlyRate: num(16.8), overtime: ot } }), 'day_hours_exceed_24'],
  ];
  for (const [name, scenario, code] of probes) {
    const body = (await (await post('/api/scenario/evaluate', { scenario })).json()) as EvaluateBody;
    assert.equal(body.evaluation.status, 'invalid', `probe ${name}`);
    assert.ok(body.evaluation.issues?.some((i) => i.code === code && i.variant), `probe ${name}: ${JSON.stringify(body.evaluation.issues)}`);
    assert.equal(body.evaluation.figures, undefined, `probe ${name}: no money result`);
    assert.equal(body.evaluation.variants, undefined);
  }
});
