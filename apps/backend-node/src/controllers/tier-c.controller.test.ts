import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';

/**
 * Stage 2f (audit v26, §2f.11) / 2g (audit v27, §2g.0a): "tests that bind the HTTP path." Every
 * OTHER Tier C test (tier-c.test.ts, extraction-consistency.test.ts) calls `mapExtractionToPeriod`/
 * `checkExtractionConsistency` directly - the reviewer's own finding (RAPORT-cursor-2e.md, T7e):
 * "if the controller gate were removed, these tests would still pass. They do not bind the HTTP
 * path." These tests start the real Express app on an ephemeral port and drive it over real HTTP.
 *
 * Stage 2f left `/analyze` itself untested at the HTTP level: its `aiRateLimit` middleware
 * (`ipRateLimit('tier-c-ai', 10, 300, 'deny')`) queries a Postgres-backed rate-limit table and fails
 * closed (503 `rate_limit_unknown`) whenever that query cannot complete - true in this environment
 * regardless of whether `DATABASE_URL` is set (confirmed: `AggregateError [ECONNREFUSED]` against
 * the checked-in `.env`'s `localhost:5432`, no Postgres or Docker running here). §2g.0a's fix, per
 * the reviewer's own T8 answer ("bypass without production redesign: yes, in the test file"): mock
 * `../rate-limiter.js`'s `ipRateLimit` export with `node:test`'s `mock.module()` (Node's built-in
 * ESM module mock, `--experimental-test-module-mocks` - added to this workspace's `test` script) so
 * every rate-limited route becomes a no-op `next()` FOR THIS TEST FILE ONLY. No production code
 * changes; `rate-limiter.ts` itself is untouched. The mock must be registered before `app.js` (and
 * therefore `tier-c.controller.ts`) is ever imported, so `app` is loaded dynamically, after the mock,
 * inside `before()`, not via a static top-level `import`.
 */

let app: (typeof import('../app.js'))['default'];
let isTextLayerMismatch: (typeof import('./tier-c.controller.js'))['isTextLayerMismatch'];
let resolveRequestSize: (typeof import('./tier-c.controller.js'))['resolveRequestSize'];
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
  // §2g.0a: replace ipRateLimit with a factory that returns a no-op passthrough middleware - every
  // route that would normally rate-limit (including /analyze's aiRateLimit) just calls next().
  // Registered before app.js is imported, so tier-c.controller.ts's own `import { ipRateLimit } from
  // '../rate-limiter.js'` resolves to this mock, not the real Postgres-backed implementation.
  mock.module('../rate-limiter.js', {
    namedExports: {
      ipRateLimit: () => (_req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => next(),
    },
  });
  ({ default: app } = await import('../app.js'));
  ({ isTextLayerMismatch, resolveRequestSize } = await import('./tier-c.controller.js'));

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
  minimum_wage_printed: 14.71, // the real document's own printed rate (H1 2026) - stale against the H2 2026 rate this test's real-world reference date resolves to; matches tier-c.test.ts's own Olympia fixture
  printed_gross_total: 885.5,
  printed_loon_voor_heffingen: 844.92,
};

test('2g.0a: /analyze with the live read-1 (5a8442c) extraction blocks with the old combined identity, never a discrepancy list', async () => {
  globalThis.fetch = mockCompletion(READ_1_5A8442C) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,Zg=='] }) });
  const body = (await res.json()) as { status: string; issues?: Array<{ code: string }> };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'unreliable');
  assert.ok(body.issues?.some((i) => i.code === 'totals_do_not_reconcile_net'), `expected totals_do_not_reconcile_net, got ${JSON.stringify(body.issues)}`);
});

test('2g.0a: /analyze with the live read-2 (aaaeae1) extraction names the unresolved subtotal role, matching the exit condition\'s own example', async () => {
  globalThis.fetch = mockCompletion(READ_2_AAAEAE1) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,Zg=='] }) });
  const body = (await res.json()) as { status: string; issues?: Array<{ code: string; printed_subtotal?: number; gross_hypothesis?: number; loon_voor_heffingen_hypothesis?: number }> };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'unreliable');
  const issue = body.issues?.find((i) => i.code === 'printed_subtotal_role_unresolved');
  assert.ok(issue, `expected printed_subtotal_role_unresolved, got ${JSON.stringify(body.issues)}`);
  assert.equal(issue?.printed_subtotal, 844.92);
  assert.equal(issue?.gross_hypothesis, 826.84);
  assert.equal(issue?.loon_voor_heffingen_hypothesis, 789.37);
});

test('2g.0a: /analyze with a correct Olympia extraction returns an empty issue list', async () => {
  globalThis.fetch = mockCompletion(CORRECT_OLYMPIA) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,Zg=='] }) });
  const body = (await res.json()) as { status: string; discrepancies?: Array<{ code: string }>; net_position?: string };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok', JSON.stringify(body));
  // Only the already-known printed-minimum-wage staleness (14.71 printed vs 14.99 current) - the same
  // single expected discrepancy tier-c.test.ts's own Olympia fixture asserts.
  assert.deepEqual(body.discrepancies?.map((d) => d.code), ['minimum_wage_stale_on_document']);
  // Stage 2i (§2i.0b): Olympia's printed net (686.09) confirms the BEFORE position - matches
  // tier-c.test.ts's own "2h.3" assertion for the same fixture shape via resolveNetReconciliationBasis.
  assert.equal(body.net_position, 'before');
});

/**
 * Stage 2i (audit v29, §2i.0b): "build the reviewer's construction (overstated printed table tax by
 * 50, a compensating net addition of 50, printed_payout equal to the same net) and run it through the
 * real HTTP path: the user must still see table_tax_mismatch of 50 from the discrepancy layer."
 * Reproduces RAPORT-cursor-2h.md's T1(b) exactly, verified end to end with `node` against `dist/`
 * before being written into this HTTP test (numbers below are measured, not assumed): a single clean
 * 1000 EUR gross line, no deductions, whose engine-computed table tax is 228.26 - overstate the
 * PRINTED table tax by exactly 50 (278.26) and add ONE fake 50 EUR net addition; the +50 overstatement
 * and the +50 fake addition cancel out exactly in the gate's own AFTER-position arithmetic (loon voor
 * heffingen − printed_table_tax + 50 = loon voor heffingen − real_table_tax), landing printed_net
 * exactly on the coincidence value (771.74) with zero gate issues - but the discrepancy layer compares
 * the ENGINE's own computed tax (228.26) against the still-wrong printed one (278.26) independently of
 * any net-position coincidence, so `table_tax_mismatch` still fires.
 */
test("2i.0b: an overstated printed_table_tax + a compensating fake net line that makes the gate's dual check coincide still surfaces as table_tax_mismatch from the discrepancy layer", async () => {
  const GATE_COINCIDENCE_CONSTRUCTION = {
    period_label: 'week 1/2026', period_end_date: null, payment_date: null, period_type: 'week',
    is_correction: false, version: 1, employer_names: [], hirer_name: null, hours_per_week: null, minimum_wage_printed: null,
    hour_lines: [{ description: 'Loon normaal', hours: 50, rate: 20, percent: null, amount: 1000, category: 'regular', tax_treatment: 'table', adds_hours: true, employer_index: 0 }],
    pre_tax_deduction_lines: [], post_tax_deduction_lines: [],
    bijzonder_tarief_printed_percent: null, bijzonder_tarief_jaarloon: null,
    et_exchange_amount: null, et_reimbursement_lines: [], payout_adjustment_lines: [], reservation_lines: [],
    printed_table_tax: 278.26, // overstated by exactly 50 vs the engine's own 228.26 computation
    printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
    printed_gross_total: 1000, printed_loon_voor_heffingen: 1000,
    net_lines: [{ description: 'Fake compensating net addition', amount: 50.0, category: 'reimbursement' }],
    // The coincidence value: matches the gate's own AFTER-position arithmetic exactly (measured, see
    // the doc comment above) - printed_payout equal to the same net, per the reviewer's construction.
    reported_total_net: 771.74,
    reported_net_paid: 771.74,
    printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
  };
  globalThis.fetch = mockCompletion(GATE_COINCIDENCE_CONSTRUCTION) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,Zg=='] }) });
  const body = (await res.json()) as { status: string; discrepancies?: Array<{ code: string; residual: number | null; status: string }> };
  // Confirms the reviewer's finding is real and reproduced: the gate itself does NOT block.
  assert.equal(body.status, 'ok', `expected the gate's dual-position check to let this through (reproducing the reviewer's construction), got ${JSON.stringify(body)}`);
  // The discrepancy layer must still catch the wrong tax - this is what makes the construction safe.
  const tableTaxDiscrepancy = body.discrepancies?.find((d) => d.code === 'table_tax_mismatch');
  assert.ok(tableTaxDiscrepancy, `expected table_tax_mismatch to still surface despite the gate passing, got ${JSON.stringify(body.discrepancies)}`);
  assert.ok(Math.abs((tableTaxDiscrepancy?.residual ?? 0) + 50) < 0.5, `expected a residual near -50, got ${tableTaxDiscrepancy?.residual}`);
  assert.equal(tableTaxDiscrepancy?.status, 'finding', '50 EUR is far outside the confirmation band - must be a finding, not a question');
});

/**
 * Stage 2l (audit v32, §2l.2): "a flagged amount should not sit inside a sum shown as fact." Confirms
 * the controller actually WIRES the amount_unreadable field paths it already raises (from
 * extraction.unreadable_amount_fields, via toNumberTracked's non-finite check) into
 * buildExtractionTrace's flaggedFieldPaths - unit-tested directly in extraction-consistency.test.ts's
 * own "2l.2" tests; this is the HTTP-level proof the wiring itself is not missing a step.
 */
test('2l.2: /analyze wires amount_unreadable field paths through to the trace - the flagged line is marked and excluded from gross_total over the real HTTP path', async () => {
  const UNREADABLE_HOUR_LINE = {
    period_label: 'week 1/2026', period_end_date: null, payment_date: null, period_type: 'week',
    is_correction: false, version: 1, employer_names: [], hirer_name: null, hours_per_week: null, minimum_wage_printed: null,
    hour_lines: [
      { description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true, employer_index: 0 },
      { description: 'Onleesbare kwota', hours: null, rate: null, percent: null, amount: 'onbekend', category: 'other', tax_treatment: 'table', adds_hours: false, employer_index: 0 },
    ],
    pre_tax_deduction_lines: [], post_tax_deduction_lines: [],
    bijzonder_tarief_printed_percent: null, bijzonder_tarief_jaarloon: null,
    et_exchange_amount: null, et_reimbursement_lines: [], net_lines: [], payout_adjustment_lines: [], reservation_lines: [],
    printed_table_tax: null, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
    printed_gross_total: null, printed_loon_voor_heffingen: null,
    reported_total_net: null, reported_net_paid: null,
    printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
  };
  globalThis.fetch = mockCompletion(UNREADABLE_HOUR_LINE) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,Zg=='] }) });
  const body = (await res.json()) as { status: string; issues?: Array<{ code: string; field?: string }>; trace?: { gross_total: number; hour_lines: Array<{ label: string; amount: number | null; flagged: boolean }> } };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'unreliable');
  assert.ok(body.issues?.some((i) => i.code === 'amount_unreadable' && i.field === 'hour_lines[1].amount'), `expected amount_unreadable for hour_lines[1].amount, got ${JSON.stringify(body.issues)}`);
  assert.equal(body.trace?.gross_total, 699.78, `expected the unreadable line excluded from gross_total over HTTP, got ${body.trace?.gross_total}`);
  assert.equal(body.trace?.hour_lines[0]?.flagged, false);
  assert.equal(body.trace?.hour_lines[1]?.flagged, true, 'expected the flagged line marked true in the actual JSON response');
});

/**
 * Stage 2m (audit v33, §2m.1): "a flagged amount must stay excluded even through a repost... one test
 * that reposts the exact blocked period from 2l.2's own fixture and confirms the guessed amount stays
 * out of the sum." Reproduces RAPORT-cursor-2l.md's own MINOR finding: a blocked /analyze response's
 * `period` still carries the guessed 'onbekend'-amount (stored as 0 by toNumberTracked's non-finite
 * fallback here, but the SAME field-path mechanism applies regardless of the stored value - see
 * extraction-consistency.test.ts's own 2l.2 tests for the non-zero case). Before this stage, /recompute
 * had no way to know that field was ever flagged at all, and would have happily computed a REAL tax
 * outcome from it - not merely a wrong display sum, an `status: 'ok'` result built on an admitted guess.
 */
test('2m.1: reposting the exact blocked period (from the 2l.2 fixture above) to /recompute, WITH its flagged field paths, refuses to compute rather than silently re-including the guess', async () => {
  const UNREADABLE_HOUR_LINE = {
    period_label: 'week 1/2026', period_end_date: null, payment_date: null, period_type: 'week',
    is_correction: false, version: 1, employer_names: [], hirer_name: null, hours_per_week: null, minimum_wage_printed: null,
    hour_lines: [
      { description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true, employer_index: 0 },
      { description: 'Onleesbare kwota', hours: null, rate: null, percent: null, amount: 'onbekend', category: 'other', tax_treatment: 'table', adds_hours: false, employer_index: 0 },
    ],
    pre_tax_deduction_lines: [], post_tax_deduction_lines: [],
    bijzonder_tarief_printed_percent: null, bijzonder_tarief_jaarloon: null,
    et_exchange_amount: null, et_reimbursement_lines: [], net_lines: [], payout_adjustment_lines: [], reservation_lines: [],
    printed_table_tax: null, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
    printed_gross_total: null, printed_loon_voor_heffingen: null,
    reported_total_net: null, reported_net_paid: null,
    printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
  };
  globalThis.fetch = mockCompletion(UNREADABLE_HOUR_LINE) as typeof fetch;
  const analyzeRes = await originalFetch(`${baseUrl}/api/tier-c/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: ['data:image/png;base64,Zg=='] }) });
  const analyzeBody = (await analyzeRes.json()) as { status: string; issues: Array<{ code: string; field?: string }>; period: unknown };
  assert.equal(analyzeBody.status, 'unreliable');
  const flaggedFieldPaths = analyzeBody.issues.filter((i) => i.code === 'amount_unreadable').map((i) => i.field as string);
  assert.deepEqual(flaggedFieldPaths, ['hour_lines[1].amount'], 'sanity: the same single flagged path as the 2l.2 test above');

  // The exact repost the reviewer's finding describes: the blocked response's own `period`, still
  // carrying the guessed amount, posted straight to /recompute - this time WITH the flagged paths the
  // client can already read off `issues` (no new field needed on the /analyze response at all).
  const recomputeRes = await originalFetch(`${baseUrl}/api/tier-c/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: analyzeBody.period, flaggedFieldPaths }),
  });
  const recomputeBody = (await recomputeRes.json()) as { status: string; issues?: Array<{ code: string; field?: string }>; trace?: { gross_total: number; hour_lines: Array<{ flagged: boolean }> }; outcome?: unknown };
  assert.equal(recomputeRes.status, 200);
  assert.equal(recomputeBody.status, 'unreliable', `expected /recompute to refuse rather than compute an 'ok' outcome from the guessed amount, got ${JSON.stringify(recomputeBody)}`);
  assert.equal(recomputeBody.outcome, undefined, 'expected no computed outcome at all - the guess never reached the engine');
  assert.ok(recomputeBody.issues?.some((i) => i.code === 'amount_unreadable' && i.field === 'hour_lines[1].amount'), `expected the same amount_unreadable issue to survive the repost, got ${JSON.stringify(recomputeBody.issues)}`);
  assert.equal(recomputeBody.trace?.gross_total, 699.78, `expected the guessed amount still excluded from gross_total on the /recompute trace too, got ${recomputeBody.trace?.gross_total}`);
  assert.equal(recomputeBody.trace?.hour_lines[1]?.flagged, true, 'expected the flagged line still marked on the /recompute response');
});

test('2m.1: /recompute with NO flaggedFieldPaths at all (the ordinary case, untouched by this fix) still computes normally', async () => {
  const res = await originalFetch(`${baseUrl}/api/tier-c/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      period: {
        period_label: null, period_type: 'week', period_type_confirmed: true, period_end_date: null, is_correction: false, version: 1,
        employers: [{ name: null, franchise_bearing: true }], hirer: null, contract_hours: null,
        hour_lines: [{ employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 885.5, category: 'regular', tax_treatment: 'table', adds_hours: true }],
        pre_tax_deductions: [], bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
        et: null, post_tax_social: [], net_additions: [], net_deductions: [], payout_adjustments: [], reservations: [],
        wml_printed: null, wml_applicable: null,
        printed_table_tax: 170.46, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
        printed_net: null, printed_payout: null, printed_gross_total: null, printed_loon_voor_heffingen: null,
        printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
      },
    }),
  });
  const body = (await res.json()) as { status: string };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok', `expected the ordinary, no-flagged-fields case unaffected by 2m.1, got ${JSON.stringify(body)}`);
});

test('2m.1: /recompute rejects a malformed flaggedFieldPaths (not an array of strings) with invalid_period, never crashes', async () => {
  const res = await originalFetch(`${baseUrl}/api/tier-c/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      period: {
        period_label: null, period_type: 'week', period_type_confirmed: true, period_end_date: null, is_correction: false, version: 1,
        employers: [{ name: null, franchise_bearing: true }], hirer: null, contract_hours: null,
        hour_lines: [], pre_tax_deductions: [], bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
        et: null, post_tax_social: [], net_additions: [], net_deductions: [], payout_adjustments: [], reservations: [],
        wml_printed: null, wml_applicable: null,
        printed_table_tax: null, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
        printed_net: null, printed_payout: null, printed_gross_total: null, printed_loon_voor_heffingen: null,
        printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
      },
      flaggedFieldPaths: [123, 'ok'],
    }),
  });
  const body = (await res.json()) as { error_code?: string };
  assert.equal(res.status, 400);
  assert.equal(body.error_code, 'invalid_period');
});

/**
 * Stage 2h (audit v28, §2h.2): "if the guard cannot find half or more of the amounts it checked...
 * treat the layer as unusable: do not block on the guard, fall back to the image-only read." A
 * correct Olympia read has several printed amounts to check (gross lines, StiPP, printed subtotals,
 * minimum wage); a documentText list that confirms only ONE of them (well under half) must fall back
 * to image-only rather than blocking on `amount_unreadable` for every unconfirmed field.
 */
test('2h.2: a text layer that confirms fewer than half the checked amounts falls back to image-only, never blocks per-field', async () => {
  globalThis.fetch = mockCompletion(CORRECT_OLYMPIA) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      images: ['data:image/png;base64,Zg=='],
      // Only "699,78" (one gross line) is genuinely printed here - every other real amount
      // (116.63, 58.31, 10.78, 0.89, 4.90, 34.79, 6.46, 90.00, 885.50, 844.92, 14.71) is unconfirmed.
      documentText: [{ page: 1, text: '699,78', x: 10, y: 10 }],
    }),
  });
  const body = (await res.json()) as { status: string; issues?: Array<{ code: string }>; technicalDetails?: { text_layer_status: string; amounts_checked: number; amounts_not_found: number } };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok', `expected the mismatch to fall back to a clean image-only read, got ${JSON.stringify(body)}`);
  assert.equal(body.technicalDetails?.text_layer_status, 'mismatch');
  assert.ok((body.technicalDetails?.amounts_checked ?? 0) > 1, 'expected more than one amount to have been checked');
  assert.ok((body.technicalDetails?.amounts_not_found ?? 0) / (body.technicalDetails?.amounts_checked ?? 1) >= 0.5, 'expected at least half unverified, matching the mismatch threshold');
});

/**
 * Stage 2h (§2h.2): "no silent truncation... if it is still over [after dropping non-digit items],
 * send images only and record text_layer_status: 'too_large'." A list with more items than
 * MAX_DOCUMENT_TEXT_ITEMS (3000), every one of them containing a digit (so the digit-only-drop step
 * cannot reduce it below the cap), must fall back exactly like a mismatch would - never partially
 * trusted, never silently cut down to the first 3000 (which would have looked identical to a clean,
 * small, correct list).
 */
test('2h.2: a documentText list over the item cap (even after dropping non-digit items) is treated as too_large, never silently truncated', async () => {
  globalThis.fetch = mockCompletion(CORRECT_OLYMPIA) as typeof fetch;
  const oversizedDocumentText = Array.from({ length: 3500 }, (_, i) => ({ page: 1, text: `${i},00`, x: 0, y: i }));
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/png;base64,Zg=='], documentText: oversizedDocumentText }),
  });
  const body = (await res.json()) as { status: string; technicalDetails?: { text_layer_status: string; text_items_sent: number } };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok', `expected a clean image-only fallback, got ${JSON.stringify(body)}`);
  assert.equal(body.technicalDetails?.text_layer_status, 'too_large');
  assert.equal(body.technicalDetails?.text_items_sent, 0, 'expected the too-large list to be treated as if nothing was sent, not partially kept');
});

/**
 * Stage 2i (audit v29, §2i.0a): "the guard cannot be switched off by one miss. The fallback needs
 * both a ratio and an absolute floor... Tests at checked 2/1, 4/2, 6/3, 12/6, 12/1." The reviewer's
 * own MAJOR finding: at checked=2, unverified=1 (ratio exactly 0.5) the old ratio-only rule already
 * fell back - precisely the shape of a single invented digit (e.g. 699.75 vs printed 699.78) in an
 * otherwise short, correctly-read period, silencing the one check built to catch it.
 */
const MISMATCH_MATRIX: Array<{ checked: number; unverified: number; expectMismatch: boolean; label: string }> = [
  { checked: 2, unverified: 1, expectMismatch: false, label: 'ratio 0.5 but under the floor - the classic single-invented-digit shape, must still block per-field' },
  { checked: 4, unverified: 2, expectMismatch: false, label: 'ratio 0.5 but under the floor' },
  { checked: 6, unverified: 3, expectMismatch: true, label: 'ratio 0.5 and at the floor - falls back' },
  { checked: 12, unverified: 6, expectMismatch: true, label: 'ratio 0.5 and well over the floor - falls back' },
  { checked: 12, unverified: 1, expectMismatch: false, label: 'over the floor is not even reached - ratio alone (0.083) is far below the threshold' },
];

for (const { checked, unverified, expectMismatch, label } of MISMATCH_MATRIX) {
  test(`2i.0a: isTextLayerMismatch(${checked}, ${unverified}) - ${label}`, () => {
    assert.equal(isTextLayerMismatch(checked, unverified), expectMismatch);
  });
}

/**
 * Stage 2i (audit v29, §2i.0e): "when Content-Length is absent or disagrees with the re-encoded size
 * by more than a margin, show the measured size and say which." A pure-function test, since fetch
 * computes its own real Content-Length automatically and cannot easily be made to send a spoofed one.
 */
test('2i.0e: resolveRequestSize trusts a Content-Length header that roughly agrees with the measured size', () => {
  const result = resolveRequestSize(100, 101); // within the 10% margin
  assert.deepEqual(result, { requestSizeKb: 100, requestSizeSource: 'content_length' });
});

test('2i.0e: resolveRequestSize falls back to the measured size when the header disagrees by more than the margin', () => {
  const result = resolveRequestSize(50, 100); // header claims half the real size
  assert.deepEqual(result, { requestSizeKb: 100, requestSizeSource: 'measured' });
});

test('2i.0e: resolveRequestSize falls back to the measured size when the header is absent entirely', () => {
  const result = resolveRequestSize(null, 250);
  assert.deepEqual(result, { requestSizeKb: 250, requestSizeSource: 'measured' });
});

test('2i.0d: /analyze echoes back a known render_step exactly as sent', async () => {
  globalThis.fetch = mockCompletion(CORRECT_OLYMPIA) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/png;base64,Zg=='], renderStep: 'image-medium' }),
  });
  const body = (await res.json()) as { technicalDetails?: { render_step: string } };
  assert.equal(body.technicalDetails?.render_step, 'image-medium');
});

test('2i.0d: /analyze normalises an unrecognised render_step to "unknown" rather than surfacing arbitrary text', async () => {
  globalThis.fetch = mockCompletion(CORRECT_OLYMPIA) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/png;base64,Zg=='], renderStep: '<script>alert(1)</script>' }),
  });
  const body = (await res.json()) as { technicalDetails?: { render_step: string } };
  assert.equal(body.technicalDetails?.render_step, 'unknown');
});

test('2f.11c: /recompute normalises a signed body before computing - a negative deduction is not double-subtracted', async () => {
  // A period shaped as if a caller sent one straight through with the printed sign still on it -
  // exactly the gap §2f.5 named ("/recompute... today passes the browser's period straight in").
  const signedPeriod = {
    period_label: 'week 36/2026', period_type: 'week', period_type_confirmed: true, period_end_date: null, is_correction: false, version: 1,
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

test('2g.0b: /recompute refuses a period whose period_type was never confirmed - the placeholder cannot drive a computation', async () => {
  // Shaped exactly as /analyze's early return sends back when extraction.period_type is null: a
  // concrete-looking 'week' sits in period_type (mapExtractionToPeriod's own placeholder, needed
  // only so the trace panel can render), but period_type_confirmed says it was never actually read.
  // Before §2g.0b, this period would have computed anyway - the ONE placeholder-carrying path that
  // /analyze's own gate could not reach, since /analyze never calls fetchRates/computePayslipPeriod
  // on it, but /recompute took a client-echoed period at face value.
  const echoedUnknownTypePeriod = {
    period_label: null, period_type: 'week', period_type_confirmed: false, period_end_date: null, is_correction: false, version: 1,
    employers: [{ name: null, franchise_bearing: true }], hirer: null, contract_hours: null,
    hour_lines: [{ employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 885.5, category: 'regular', tax_treatment: 'table', adds_hours: true }],
    pre_tax_deductions: [], bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
    et: null, post_tax_social: [], net_additions: [], net_deductions: [], payout_adjustments: [], reservations: [],
    wml_printed: null, wml_applicable: null,
    printed_table_tax: null, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
    printed_net: null, printed_payout: null, printed_gross_total: null, printed_loon_voor_heffingen: null,
    printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
  };
  const res = await originalFetch(`${baseUrl}/api/tier-c/recompute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period: echoedUnknownTypePeriod }) });
  const body = (await res.json()) as { status: string; issues?: Array<{ code: string }>; outcome?: unknown };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'unreliable');
  assert.deepEqual(body.issues?.map((i) => i.code), ['period_type_unknown']);
  assert.equal(body.outcome, undefined, 'must not have computed anything - no tax figure from an unconfirmed period type');
});

test('2g.0b: /recompute still computes normally when period_type_confirmed is true (no regression)', async () => {
  const res = await originalFetch(`${baseUrl}/api/tier-c/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      period: {
        period_label: null, period_type: 'week', period_type_confirmed: true, period_end_date: null, is_correction: false, version: 1,
        employers: [{ name: null, franchise_bearing: true }], hirer: null, contract_hours: null,
        hour_lines: [{ employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 885.5, category: 'regular', tax_treatment: 'table', adds_hours: true }],
        pre_tax_deductions: [], bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
        et: null, post_tax_social: [], net_additions: [], net_deductions: [], payout_adjustments: [], reservations: [],
        wml_printed: null, wml_applicable: null,
        // Stage 2i (§2i.4): "make an absent printed table tax a stated gap" - now fires unconditionally
        // (not only alongside a printed_net check), so this fixture (unrelated to tax reading - it
        // tests only the period_type_confirmed gate) needs a non-null printed_table_tax to stay 'ok'.
        printed_table_tax: 170.46, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
        printed_net: null, printed_payout: null, printed_gross_total: null, printed_loon_voor_heffingen: null,
        printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
      },
    }),
  });
  const body = (await res.json()) as { status: string; outcome?: { status: string } };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok', JSON.stringify(body));
});

/**
 * Stage 2k (audit v31, §2k.2): "say the two rate sources out loud." The frontend's new
 * `discrepanciesRatesSourceNote` (TierCFlow.tsx) reads `response.taxRatesSource` unconditionally on
 * every 'ok' response - this must actually be present and correctly typed every time, or the note
 * silently has nothing to key off. `taxRatesSource` itself is unchanged this round (no engine change,
 * per the assignment) - this closes a real gap: nothing previously asserted it is present at the HTTP
 * boundary at all.
 */
test("2k.2: /recompute's 'ok' response always carries a valid taxRatesSource - the panel's rates-source note depends on it", async () => {
  const res = await originalFetch(`${baseUrl}/api/tier-c/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      period: {
        period_label: null, period_type: 'week', period_type_confirmed: true, period_end_date: null, is_correction: false, version: 1,
        employers: [{ name: null, franchise_bearing: true }], hirer: null, contract_hours: null,
        hour_lines: [{ employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 885.5, category: 'regular', tax_treatment: 'table', adds_hours: true }],
        pre_tax_deductions: [], bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
        et: null, post_tax_social: [], net_additions: [], net_deductions: [], payout_adjustments: [], reservations: [],
        wml_printed: null, wml_applicable: null,
        printed_table_tax: 170.46, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
        printed_net: null, printed_payout: null, printed_gross_total: null, printed_loon_voor_heffingen: null,
        printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
      },
    }),
  });
  const body = (await res.json()) as { status: string; taxRatesSource?: string };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok', JSON.stringify(body));
  assert.ok(body.taxRatesSource === 'database' || body.taxRatesSource === 'static', `expected taxRatesSource to be present and valid, got ${JSON.stringify(body.taxRatesSource)}`);
});

/**
 * Stage 2h (audit v28, §2h.6): "test with the malformed body the reviewer used." RAPORT-cursor-2g.md
 * T3c's exact reproduction: `buildExtractionTrace({ period_type:'week', period_type_confirmed:false,
 * hour_lines:[] }, null)` crashed with `TypeError: Cannot read properties of undefined (reading
 * 'map')` because the period is missing almost every other required field - Express's default error
 * handler turned that into a generic 500. `isValidPayslipPeriodShape` now runs before ANY other logic
 * in the route (including the period_type_confirmed branch that used to reach the crash), so this
 * exact body gets a clean 400 `invalid_period` instead.
 */
test('2h.6: /recompute answers 400 invalid_period (not a 500 crash) on the reviewer\'s malformed body', async () => {
  const res = await originalFetch(`${baseUrl}/api/tier-c/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: { period_type: 'week', period_type_confirmed: false, hour_lines: [] } }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error_code?: string; stack?: unknown };
  assert.equal(body.error_code, 'invalid_period');
  assert.equal(body.stack, undefined, 'must carry no stack trace');
  assert.deepEqual(Object.keys(body), ['error_code'], 'must carry no field names beyond the code');
});

test('2h.6: /recompute still answers 400 invalid_period on a period missing arrays entirely (not merely wrong-typed hour_lines)', async () => {
  const res = await originalFetch(`${baseUrl}/api/tier-c/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period: { period_type: 'week', period_type_confirmed: true } }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error_code?: string };
  assert.equal(body.error_code, 'invalid_period');
});
