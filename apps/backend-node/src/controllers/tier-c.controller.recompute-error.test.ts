import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';

/**
 * Stage 2p (audit v38, §2p.2): "/recompute's own fetchRates / computePayslipPeriod /
 * checkExtractionConsistency sequence has none [error handling]." Confirmed by Cursor (T7, read only,
 * deliberately not triggered live on production): /analyze wraps its own vision call and the gate in
 * try/catch and answers a structured 502 on failure; /recompute's own sequence had none at all - any
 * input that made it throw had no defined behaviour, an unhandled rejection with no response, exactly
 * the kind of thing that hangs a request to a platform timeout instead of failing cleanly.
 *
 * This is a SEPARATE file (not a test added to `tier-c.controller.test.ts`) because forcing the throw
 * needs `getCurrentRule` (`../rules-repository.js`, `fetchRates`'s own dependency) mocked via
 * `mock.module` BEFORE `app.js` is ever imported - the same requirement that file's own `ipRateLimit`
 * mock has, and its `app` is already loaded by the time any test in it runs. `node --test` gives each
 * test FILE its own module registry, so a fresh file gets a fresh, still-unmocked module to intercept.
 */

let app: (typeof import('../app.js'))['default'];
let server: ReturnType<typeof app.listen>;
let baseUrl: string;
let originalApiKey: string | undefined;

before(async () => {
  // Mirrors tier-c.controller.test.ts's own ipRateLimit mock exactly, but for getCurrentRule instead -
  // registered before app.js (and therefore tier-c.controller.ts, and therefore rules-repository.ts)
  // is ever imported, so the real Postgres-backed implementation is never reached at all.
  // Every other module reachable from app.js's own import graph (e.g. contract.js) also imports from
  // rules-repository.js - mock.module() replaces the WHOLE module's export surface, not just the one
  // named export being overridden, so every real export must still be present (even as a stub never
  // actually called on this route) or the app's own module graph fails to link at all.
  mock.module('../rules-repository.js', {
    namedExports: {
      getCurrentRule: async () => {
        throw new Error('2p.2 injected failure - proving the /recompute try/catch catches it');
      },
      getRuleAt: async () => null,
      getMinimumWageAt: async () => null,
      listRuleFreshness: async () => [],
    },
  });
  mock.module('../rate-limiter.js', {
    namedExports: {
      ipRateLimit: () => (_req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => next(),
    },
  });
  ({ default: app } = await import('../app.js'));

  originalApiKey = process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY = 'test-key-2p2';
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (originalApiKey === undefined) delete process.env.MISTRAL_API_KEY;
  else process.env.MISTRAL_API_KEY = originalApiKey;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const RECOMPUTE_TEST_PERIOD = {
  period_label: null, period_type: 'week' as const, period_type_confirmed: true, period_end_date: null, is_correction: false, version: 1,
  employers: [{ name: null, franchise_bearing: true }], hirer: null, contract_hours: null,
  hour_lines: [{ employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 885.5, category: 'regular', tax_treatment: 'table', adds_hours: true }],
  pre_tax_deductions: [], bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable' as const, tarief_bt: { printed: null, computed: null } },
  et: null, post_tax_social: [], net_additions: [], net_deductions: [], payout_adjustments: [], reservations: [],
  wml_printed: null, wml_applicable: null,
  printed_table_tax: 170.46, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
  printed_net: null, printed_payout: null, printed_gross_total: null, printed_loon_voor_heffingen: null,
  printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
};

test('2p.2: /recompute answers a structured 502 (not a hang/crash) when its own compute sequence throws', async () => {
  const res = await fetch(`${baseUrl}/api/tier-c/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: RECOMPUTE_TEST_PERIOD, flaggedFieldPaths: [] }),
  });
  const body = (await res.json()) as { error_code?: string; stack?: unknown };
  assert.equal(res.status, 502, `expected a structured 502, got ${res.status} ${JSON.stringify(body)}`);
  assert.equal(body.error_code, 'recompute_failed');
  assert.equal(body.stack, undefined, 'must carry no stack trace');
  assert.deepEqual(Object.keys(body), ['error_code'], 'must carry no field names beyond the code');
});
