import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { computeTierAResult } from '../payroll-engine/tier-a.js';
import { periodMultiplierFor, type PayslipComputationRates } from '../payroll-engine/payslip-model.js';
import { alternatives, dayGrid, num, oracleInput, weekdayScenario } from '../test-support/scenario-fixtures.js';

/**
 * R1 backend boundary: `POST /api/scenario/evaluate` over real HTTP. The rates source is mocked to a
 * fixed static period (read from packages/tax-tables) so the test does not depend on today's date or a
 * database. `globalThis.fetch` is wrapped to PROVE the deterministic boundary makes no outbound call
 * (no LLM, no Gemini, no document read).
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

async function post(route: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

type EvaluateBody = { evaluation: { status: string; figures?: { payoutAmount: number; hoursWorked: number }; runs?: Array<{ engineInputDigest: string }>; requirements?: Array<{ field: string }>; issues?: Array<{ code: string }>; unsupported?: unknown[]; range: unknown }; comparison?: { status: string; delta?: { payoutAmount: number } }; taxRatesSource: string };

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

test('R1 endpoint: a material range is returned with its engine runs', async () => {
  const body = (await (await post('/api/scenario/evaluate', { scenario: weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } }) })).json()) as EvaluateBody;
  assert.equal(body.evaluation.status, 'computed');
  assert.ok(body.evaluation.range);
  assert.equal(body.evaluation.runs?.length, 2, 'the central run IS the first option, so it is not run twice');
  assert.equal(new Set(body.evaluation.runs?.map((r) => r.engineInputDigest)).size, 2, 'the two distinct engine inputs have distinct digests');
});

test('R1 endpoint: R2\'s turn endpoint does not exist, and the existing Tier A route is untouched', async () => {
  assert.equal((await post('/api/scenario/turn', { scenario: weekdayScenario() })).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/scenario/evaluate`)).status, 404, 'POST only');
  const tierA = await post('/api/tier-a/calculate', oracleInput());
  assert.equal(tierA.status, 200);
  assert.equal(((await tierA.json()) as { status: string }).status, 'computed');
});

test('R1 endpoint: the engine input of an evaluation replays through the EXISTING Tier A route to the same figures (incl. the holiday bucket)', async () => {
  const scenario = weekdayScenario({
    work: { regularWeekdayHours: num(32), publicHolidayHours: num(8), saturdayHours: num(4) },
    pay: { hourlyRate: num(16.8, 'document'), publicHolidayPremiumPercent: num(100, 'cao_rule'), saturdayPremiumPercent: num(50, 'cao_rule') },
  });
  const body = (await (await post('/api/scenario/evaluate', { scenario })).json()) as { evaluation: { status: string; figures: { payoutAmount: number; grossTotal: number }; runs: Array<{ engineInput: unknown }> } };
  assert.equal(body.evaluation.status, 'computed');
  const replay = await post('/api/tier-a/calculate', body.evaluation.runs[0]?.engineInput);
  assert.equal(replay.status, 200, 'the Scenario mapper only produces inputs the existing Tier A contract accepts');
  const replayed = (await replay.json()) as { status: string; outcome: { result: { payout_amount: number; gross_total: number } } };
  assert.equal(replayed.status, 'computed');
  assert.equal(replayed.outcome.result.payout_amount, body.evaluation.figures.payoutAmount);
  assert.equal(replayed.outcome.result.gross_total, body.evaluation.figures.grossTotal);
});
