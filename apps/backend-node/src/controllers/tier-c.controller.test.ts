import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import app from '../app.js';

/**
 * Stage 2f (audit v26, §2f.11): "tests that bind the HTTP path." Every existing Tier C test
 * (tier-c.test.ts, extraction-consistency.test.ts) calls `mapExtractionToPeriod`/
 * `checkExtractionConsistency` directly - the reviewer's own finding (RAPORT-cursor-2e.md, T7e):
 * "if the controller gate were removed, these tests would still pass. They do not bind the HTTP
 * path." These tests start the real Express app on an ephemeral port and drive it over real HTTP.
 *
 * BLOCKED, not attempted here: an HTTP-level test of POST /api/tier-c/analyze itself. Its
 * `aiRateLimit` middleware (`tier-c.controller.ts`, `ipRateLimit('tier-c-ai', 10, 300, 'deny')`)
 * queries a Postgres-backed rate-limit table and, by explicit design (rate-limiter.ts's own
 * comment: "a route that spends real money on every request... must fail closed"), returns 503
 * `rate_limit_unknown` whenever that check cannot be completed - which includes "no database
 * reachable at all", not only "database says no". Command run: `node -e "...fetch('.../analyze')"`
 * against this checkout's `apps/backend-node/.env` (`DATABASE_URL=postgresql://admin:...@localhost:5432/...`,
 * no local Postgres or Docker running in this environment) - exact error: `AggregateError
 * [ECONNREFUSED]... connect ECONNREFUSED ::1:5432` / `127.0.0.1:5432`, response `503
 * {"error_code":"rate_limit_unknown"}`. Unsetting DATABASE_URL does not help - `checkRateLimit`'s
 * `!databaseConfigured` branch also returns 'unknown', which this route's `onUnknown: 'deny'` still
 * turns into the same 503. There is no environment variable that makes this route reachable without
 * an actually-running Postgres, and standing one up is out of this round's scope. `/recompute` has
 * no rate limiter and is fully tested below; `/analyze`'s gate/mapping logic (the two live reads,
 * and a correct read) is exercised by extraction-consistency.test.ts's "2f.2" tests and
 * tier-c.test.ts's "Stage 2e regression" test instead, calling the exact same
 * `mapExtractionToPeriod`/`checkExtractionConsistency`/`buildExtractionTrace` functions the
 * controller calls, with the identical fixture numbers - not a substitute for an HTTP test, but the
 * same production code path minus the rate-limit middleware this environment cannot exercise.
 *
 * `extractTierCPayslip`'s vision call would be mocked at the `fetch` boundary (not the
 * `ocr-client.js` module) if the rate limiter did not block first - `documentVisionClient()` is a
 * real OpenAI-SDK client that calls `fetch()` internally, so intercepting that one boundary was
 * meant to test the REAL controller code with a result shaped exactly like a real Mistral response.
 * Kept here, unused by any test, as the mechanism a future round can use once a database is
 * reachable - not deleted per §5.1.
 */

let server: ReturnType<typeof app.listen>;
let baseUrl: string;
let originalFetch: typeof fetch;
let originalApiKey: string | undefined;

function mockCompletion(extractionJson: unknown) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('mistral.ai') && url.includes('chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(extractionJson) }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

before(async () => {
  originalApiKey = process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY = 'test-key-2f11';
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  originalFetch = globalThis.fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.MISTRAL_API_KEY;
  else process.env.MISTRAL_API_KEY = originalApiKey;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const READ_1_5A8442C = {
  period_label: 'week 36/2026', period_end_date: null, payment_date: null, period_type: 'week',
  is_correction: false, version: 1, employer_names: [], hirer_name: null, hours_per_week: null, minimum_wage_printed: null,
  hour_lines: [
    { description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.75, category: 'regular', tax_treatment: 'table', adds_hours: true, employer_index: 0 },
    { description: 'Loon onregelm. uren', hours: 7.5, rate: 15.55, percent: 100, amount: 116.63, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false, employer_index: 0 },
    { description: 'ADV toeslag', hours: 45, rate: 15.55, percent: 1.54, amount: 10.78, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false, employer_index: 0 },
  ],
  // v24/2e's live read: deduction amounts arrived NEGATIVE (as printed), the bug 2e.1/2f.5 fix.
  pre_tax_deduction_lines: [
    { description: 'Bijlage PAWW werknemer', amount: -0.89, category: 'paww', base: null, percent: null },
    { description: 'AZW werknemer', amount: -1.23, category: 'other', base: null, percent: null },
    { description: 'StiPP-pensioen werknemer', amount: -34.79, category: 'pension', base: null, percent: null },
  ],
  post_tax_deduction_lines: [{ description: 'WHK werknemer', amount: -6.46, category: 'whk', percent: null }],
  bijzonder_tarief_printed_percent: null, bijzonder_tarief_jaarloon: null,
  et_exchange_amount: null, et_reimbursement_lines: [], net_lines: [], payout_adjustment_lines: [], reservation_lines: [],
  printed_table_tax: 152.37, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
  printed_gross_total: null, printed_loon_voor_heffingen: null,
  reported_total_net: 686.09, reported_net_paid: 776.09,
  printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
};

const READ_2_AAAEAE1 = {
  ...READ_1_5A8442C,
  hour_lines: [
    { description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.75, category: 'regular', tax_treatment: 'table', adds_hours: true, employer_index: 0 },
    { description: 'Loon onregelm. uren', hours: 7.5, rate: 15.55, percent: 100, amount: 116.31, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false, employer_index: 0 },
    { description: 'ADV toeslag', hours: 45, rate: 15.55, percent: 1.54, amount: 10.78, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false, employer_index: 0 },
  ],
  // build aaaeae1: sign fix + label classifier both already live - amounts positive, AZW correctly 'ziektewet'.
  pre_tax_deduction_lines: [
    { description: 'Bijlage PAWW werknemer', amount: 0.89, category: 'paww', base: null, percent: null },
    { description: 'AZW werknemer', amount: 1.79, category: 'ziektewet', base: null, percent: null },
    { description: 'StiPP-pensioen werknemer', amount: 34.79, category: 'pension', base: null, percent: null },
  ],
  post_tax_deduction_lines: [{ description: 'WHK werknemer', amount: 6.46, category: 'whk', percent: null }],
  net_lines: [{ description: 'Ontv. Reiskosten woon/werk', amount: 90.0, category: 'reimbursement' }],
  printed_gross_total: 844.92, // OWNER-RETEST-2e-olympia.md's own panel - "TOTAAL BRUTO", actually loon voor heffingen on this document
};

const CORRECT_OLYMPIA = {
  ...READ_1_5A8442C,
  hour_lines: [
    { description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true, employer_index: 0 },
    { description: 'Loon onregelm. uren 100%', hours: 7.5, rate: 15.55, percent: 100, amount: 116.63, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false, employer_index: 0 },
    { description: 'Loon onregelm. uren 50%', hours: 7.5, rate: 15.55, percent: 50, amount: 58.31, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false, employer_index: 0 },
    { description: 'ADV toeslag', hours: 45, rate: 15.55, percent: 1.54, amount: 10.78, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false, employer_index: 0 },
  ],
  pre_tax_deduction_lines: [
    { description: 'Bijlage PAWW werknemer', amount: 0.89, category: 'paww', base: null, percent: null },
    { description: 'AZW werknemer', amount: 4.9, category: 'ziektewet', base: null, percent: null },
    { description: 'StiPP-pensioen werknemer', amount: 34.79, category: 'pension', base: null, percent: null },
  ],
  post_tax_deduction_lines: [{ description: 'WHK werknemer', amount: 6.46, category: 'whk', percent: null }],
  net_lines: [{ description: 'Onb. reiskosten woon/werk', amount: 90.0, category: 'reimbursement' }],
  minimum_wage_printed: 14.99,
  printed_gross_total: 885.5,
  printed_loon_voor_heffingen: 844.92,
};

/**
 * BLOCKED (see the file header comment for the exact command/error): these three would run
 * /api/tier-c/analyze itself over real HTTP, using the mock/fixtures above, once a reachable
 * Postgres makes its rate limiter's `checkRateLimit` return something other than 'unknown'. Kept
 * as a template, not deleted (§5.1) - uncomment once a database is available to test against.
 *
 * test('2f.11a: /analyze with the live read-1 (5a8442c) extraction blocks with the old combined identity, never a discrepancy list', async () => {
 *   globalThis.fetch = mockCompletion(READ_1_5A8442C) as typeof fetch;
 *   const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,Zg=='] }) });
 *   const body = (await res.json()) as { status: string; issues?: Array<{ code: string }> };
 *   assert.equal(res.status, 200);
 *   assert.equal(body.status, 'unreliable');
 *   assert.ok(body.issues?.some((i) => i.code === 'totals_do_not_reconcile_net'));
 * });
 *
 * test('2f.11a: /analyze with the live read-2 (aaaeae1) extraction names the unresolved subtotal role', async () => {
 *   globalThis.fetch = mockCompletion(READ_2_AAAEAE1) as typeof fetch;
 *   const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,Zg=='] }) });
 *   const body = (await res.json()) as { status: string; issues?: Array<{ code: string; printed_subtotal?: number; gross_hypothesis?: number; loon_voor_heffingen_hypothesis?: number }> };
 *   assert.equal(res.status, 200);
 *   assert.equal(body.status, 'unreliable');
 *   const issue = body.issues?.find((i) => i.code === 'printed_subtotal_role_unresolved');
 *   assert.ok(issue);
 *   assert.equal(issue?.printed_subtotal, 844.92);
 *   assert.equal(issue?.gross_hypothesis, 826.84);
 *   assert.equal(issue?.loon_voor_heffingen_hypothesis, 789.37);
 * });
 *
 * test('2f.11b: /analyze with a correct Olympia extraction returns an empty issue list', async () => {
 *   globalThis.fetch = mockCompletion(CORRECT_OLYMPIA) as typeof fetch;
 *   const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,Zg=='] }) });
 *   const body = (await res.json()) as { status: string; discrepancies?: Array<{ code: string }> };
 *   assert.equal(res.status, 200);
 *   assert.equal(body.status, 'ok');
 *   assert.deepEqual(body.discrepancies?.map((d) => d.code), ['minimum_wage_stale_on_document']);
 * });
 */

test('2f.11c: /recompute normalises a signed body before computing - a negative deduction is not double-subtracted', async () => {
  // A period shaped as if a caller sent one straight through with the printed sign still on it -
  // exactly the gap §2f.5 named ("/recompute... today passes the browser's period straight in").
  const signedPeriod = {
    period_label: 'week 36/2026', period_type: 'week', period_end_date: null, is_correction: false, version: 1,
    employers: [{ name: null, franchise_bearing: true }], hirer: null, contract_hours: null,
    hour_lines: [{ employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 885.5, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    pre_tax_deductions: [{ category: 'pension', description: 'StiPP', amount: { provenance: 'payslip_extracted', value: -40.58 }, base: null, percent: null }],
    bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
    et: null, post_tax_social: [], net_additions: [], net_deductions: [], payout_adjustments: [], reservations: [],
    wml_printed: null, wml_applicable: null,
    printed_table_tax: 152.37, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
    printed_net: 692.55, printed_payout: 692.55, printed_gross_total: null, printed_loon_voor_heffingen: null,
    printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
  };
  const res = await originalFetch(`${baseUrl}/api/tier-c/recompute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period: signedPeriod }) });
  const body = (await res.json()) as { status: string; outcome?: { status: string; result?: { taxable_base: number } } };
  assert.equal(res.status, 200);
  // If the -40.58 deduction were NOT normalised to a magnitude, gross - (-40.58) = 926.08 (added, not
  // subtracted) - the exact 2e.1/2f.5 bug, now checked at the HTTP boundary /recompute uses.
  assert.equal(body.outcome?.status, 'complete');
  assert.equal(body.outcome?.result?.taxable_base, 844.92, `expected 885.50 - 40.58 = 844.92 (magnitude subtracted), got ${JSON.stringify(body.outcome)}`);
});
