import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { SCENARIO_EVALUATE_RATE_LIMIT } from '../scenario/scenario-config.js';
import { num, oracleInput, weekdayScenario } from '../test-support/scenario-fixtures.js';

/**
 * F1-D (Cursor review): `POST /api/scenario/evaluate` is rate limited, narrowly.
 *
 * The project's REAL `ipRateLimit` runs (rate-limiter.ts). Only the database underneath it is faked: an
 * in-memory stand-in that implements the single atomic UPSERT the limiter issues, so the counting,
 * windowing key and 429 response are the production code paths. A separate file because `mock.module`
 * must be registered before `app.js` (and therefore rate-limiter.ts) is first imported.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const staticFile = JSON.parse(readFileSync(path.resolve(here, '../../../../packages/tax-tables/2026-rates.json'), 'utf-8')) as { periods: Array<unknown> };
const PERIOD = staticFile.periods[staticFile.periods.length - 1];

const counters = new Map<string, number>();
const keysSeen: string[] = [];
let databaseMode: 'ok' | 'failing' = 'ok';

let app: (typeof import('../app.js'))['default'];
let server: ReturnType<typeof app.listen>;
let baseUrl: string;

before(async () => {
  mock.module('../database.js', {
    namedExports: {
      databaseConfigured: true,
      checkDatabase: async () => 'connected',
      transaction: async () => null,
      query: async (text: string, values: unknown[] = []) => {
        if (!text.includes('INSERT INTO rate_limits')) return [];
        if (databaseMode === 'failing') throw new Error('database unavailable');
        const key = String(values[0]);
        keysSeen.push(key);
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return [{ count }];
      },
    },
  });
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
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const post = (route: string, body: unknown) => fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const evaluate = () => post('/api/scenario/evaluate', { scenario: weekdayScenario({ work: { regularWeekdayHours: num(40) } }) });

test('F1-D: the limiter is configured narrowly, in the project\'s write-style fail-open mode', () => {
  assert.deepEqual(SCENARIO_EVALUATE_RATE_LIMIT, { routeName: 'scenario-evaluate', limit: 60, windowSeconds: 300, onUnknown: 'allow' });
});

test('F1-D: requests within the limit are accepted and computed normally; the 1st request past it is a 429 rate_limit_exceeded', async () => {
  counters.clear();
  keysSeen.length = 0;
  const { limit } = SCENARIO_EVALUATE_RATE_LIMIT;

  const first = await evaluate();
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as { evaluation: { status: string } };
  assert.equal(firstBody.evaluation.status, 'computed', 'accepted requests behave exactly as before');

  for (let i = 1; i < limit; i++) assert.equal((await evaluate()).status, 200, `request ${i + 1} of ${limit}`);

  const over = await evaluate();
  assert.equal(over.status, 429);
  assert.deepEqual(await over.json(), { error_code: 'rate_limit_exceeded' }, 'the standard project error body - no evaluation, no engine data');
  assert.equal((await evaluate()).status, 429, 'it stays closed for the rest of the window');

  // The limiter counts under this route's own key.
  assert.ok(keysSeen.length >= limit + 2);
  assert.ok(keysSeen.every((k) => k.startsWith('scenario-evaluate:')), `keys: ${[...new Set(keysSeen)].join(', ')}`);
});

test('F1-D: the limit is narrow - other routes are untouched while this route is exhausted', async () => {
  // The previous test left this route over its limit.
  assert.equal((await evaluate()).status, 429);
  const tierA = await post('/api/tier-a/calculate', oracleInput());
  assert.equal(tierA.status, 200, 'Tier A has no limiter and is unaffected');
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  assert.ok(![...counters.keys()].some((k) => !k.startsWith('scenario-evaluate:')), 'no other route consumed or created a bucket');
  // R2: /turn is a separate route with its OWN budget - exhausting /evaluate does not block it.
  assert.equal((await post('/api/scenario/turn', {})).status, 400, 'the turn route is reachable (its own limiter allowed it; the empty body is a 400)');
  assert.ok([...counters.keys()].some((k) => k.startsWith('scenario-turn:')), 'the turn route counts in its own bucket');
});

test('F1-D: a malformed request also counts against the budget (the limiter runs before validation)', async () => {
  counters.clear();
  const { limit } = SCENARIO_EVALUATE_RATE_LIMIT;
  for (let i = 0; i < limit; i++) assert.equal((await post('/api/scenario/evaluate', { nope: true })).status, 400);
  assert.equal((await post('/api/scenario/evaluate', { nope: true })).status, 429);
});

test('F1-D: if the limiter itself cannot be checked it fails OPEN (no money is spent here; work is already capped)', async () => {
  counters.clear();
  databaseMode = 'failing';
  const originalError = console.error;
  console.error = () => undefined; // the limiter logs the failure; keep the test output clean
  try {
    for (let i = 0; i < SCENARIO_EVALUATE_RATE_LIMIT.limit + 5; i++) assert.equal((await evaluate()).status, 200);
  } finally {
    console.error = originalError;
    databaseMode = 'ok';
  }
});
