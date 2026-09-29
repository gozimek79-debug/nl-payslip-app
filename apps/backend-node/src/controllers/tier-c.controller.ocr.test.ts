import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';

/**
 * Stage 2s (audit v51, §2s.2/§2s.3): the required HTTP-level disagreement matrix for the two-reader
 * image-only path - "Mistral and Gemini calls mocked, each in both directions... 3 of 5 fields
 * disagreeing (must be unreliable, never ok)... a line only one reading has... both agreeing on
 * everything (ok, two-readings wording)... one reader failing (single-reader state, never ok as
 * confirmed)... fail-closed: reader B makes no network call unless its enabling env var is set."
 *
 * SUPERSEDES this file's own earlier content (stages 2q/2r): those tests exercised the
 * OCR-text-layer-plus-bag-of-numbers-guard mechanism for the image-only path, which 2s retires
 * entirely ("the bag-of-numbers guard is no longer what decides a photo or a scan"). The comparison
 * ALGORITHM itself (field/line alignment, the disagreement matrix) is unit-tested directly against
 * `compareReaderExtractions` in `reader-comparison.test.ts`; these HTTP-level tests exist to prove the
 * WIRING - that `/analyze` actually calls both readers in parallel, gates on their comparison, reports
 * the right `reading_basis`/`text_layer_source` state, and fails closed on reader B's own switch.
 */

let app: (typeof import('../app.js'))['default'];
let server: ReturnType<typeof app.listen>;
let baseUrl: string;
let originalFetch: typeof fetch;
let originalMistralKey: string | undefined;
let originalGeminiKey: string | undefined;
let originalGeminiEnabled: string | undefined;

before(async () => {
  mock.module('../rate-limiter.js', {
    namedExports: {
      ipRateLimit: () => (_req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => next(),
    },
  });
  ({ default: app } = await import('../app.js'));

  originalMistralKey = process.env.MISTRAL_API_KEY;
  originalGeminiKey = process.env.GEMINI_API_KEY;
  originalGeminiEnabled = process.env.GEMINI_READER_ENABLED;
  process.env.MISTRAL_API_KEY = 'test-key-2s';
  process.env.GEMINI_API_KEY = 'test-gemini-key-2s';
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  originalFetch = globalThis.fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalMistralKey === undefined) delete process.env.MISTRAL_API_KEY;
  else process.env.MISTRAL_API_KEY = originalMistralKey;
  if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiKey;
  if (originalGeminiEnabled === undefined) delete process.env.GEMINI_READER_ENABLED;
  else process.env.GEMINI_READER_ENABLED = originalGeminiEnabled;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// A minimal, single-line synthetic extraction - deliberately small so the only thing that can block
// it is the ONE thing each test means to exercise, not an unrelated gate.
const BASE_EXTRACTION = {
  period_label: 'week 12/2026', period_end_date: '2026-03-22', payment_date: null, period_type: 'week',
  is_correction: false, version: 1, employer_names: [], hirer_name: null, hours_per_week: null, minimum_wage_printed: null,
  hour_lines: [{ description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true, employer_index: 0 }],
  pre_tax_deduction_lines: [], post_tax_deduction_lines: [], net_lines: [], et_reimbursement_lines: [], payout_adjustment_lines: [], reservation_lines: [],
  bijzonder_tarief_printed_percent: null, bijzonder_tarief_jaarloon: null, et_exchange_amount: null,
  printed_table_tax: 145.51, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
  printed_gross_total: null, printed_loon_voor_heffingen: null,
  reported_total_net: 554.27, reported_net_paid: 554.27,
  printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null, printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
};

// Fabricated, never a real name/IBAN - present only to prove a reader's raw content never reaches a
// log line or the response body (§2q.4's own discipline, still required - readers still go through
// the same sanitizeText/mapRawExtractionToTierC mapping every extraction always has).
const PII_MARKER = 'Jan Testkowalski NL00BANK0123456789';

function mockReaders(mistralJson: unknown, geminiJson: unknown | null) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('mistral.ai') && url.includes('/ocr')) {
      return new Response(JSON.stringify({ document_annotation: JSON.stringify(mistralJson) }), { status: 200 });
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      if (geminiJson === null) return new Response('{}', { status: 500 });
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiJson) }] } }] }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

test('2s.3: both readers disabled/reader B not configured - a clean read is still usable, reported as one_reader, never presented as two', async () => {
  delete process.env.GEMINI_READER_ENABLED;
  globalThis.fetch = mockReaders(BASE_EXTRACTION, null) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
  });
  const body = (await res.json()) as { status?: string; technicalDetails?: { text_layer_source?: string } };
  assert.equal(body.status, 'ok', `expected a usable single-reader read, got: ${JSON.stringify(body)}`);
  assert.equal(body.technicalDetails?.text_layer_source, 'one_reader');
});

test('2s: Reader A failing produces a structured 502, not an unhandled rejection - the reader calls must run INSIDE the try/catch, not before it', async () => {
  delete process.env.GEMINI_READER_ENABLED;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('mistral.ai') && url.includes('/ocr')) throw new Error('simulated Reader A network failure');
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
  });
  assert.equal(res.status, 502, `expected a structured 502, got ${res.status}`);
  const body = (await res.json()) as { error_code?: string };
  assert.equal(body.error_code, 'extraction_failed');
});

test('2s.1e/2s.3: reader B makes NO network call at all when its switch is off - fail-closed, not merely unused', async () => {
  delete process.env.GEMINI_READER_ENABLED;
  let geminiCalled = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('generativelanguage.googleapis.com')) {
      geminiCalled = true;
      return new Response('{}', { status: 200 });
    }
    if (url.includes('mistral.ai') && url.includes('/ocr')) {
      return new Response(JSON.stringify({ document_annotation: JSON.stringify(BASE_EXTRACTION) }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
  });
  assert.equal(geminiCalled, false, 'Gemini must never be called at all while GEMINI_READER_ENABLED is unset');
});

test('2s.3: reader B failing (network error) still produces a usable one-reader read - reader A alone is not blocked by reader B', async () => {
  process.env.GEMINI_READER_ENABLED = 'true';
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('generativelanguage.googleapis.com')) throw new Error('simulated network failure');
    if (url.includes('mistral.ai') && url.includes('/ocr')) return new Response(JSON.stringify({ document_annotation: JSON.stringify(BASE_EXTRACTION) }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const body = (await res.json()) as { status?: string; technicalDetails?: { text_layer_source?: string } };
    assert.equal(body.status, 'ok');
    assert.equal(body.technicalDetails?.text_layer_source, 'one_reader', 'a failed reader B must degrade to one_reader, never crash the whole request');
  } finally {
    delete process.env.GEMINI_READER_ENABLED;
  }
});

test('2s.2/2s.3: both readers agreeing on everything - status ok, reading_basis says two readers were compared', async () => {
  process.env.GEMINI_READER_ENABLED = 'true';
  globalThis.fetch = mockReaders(BASE_EXTRACTION, BASE_EXTRACTION) as typeof fetch;
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const body = (await res.json()) as { status?: string; technicalDetails?: { text_layer_source?: string } };
    assert.equal(body.status, 'ok', `expected agreement to read clean, got: ${JSON.stringify(body)}`);
    assert.equal(body.technicalDetails?.text_layer_source, 'two_readers');
  } finally {
    delete process.env.GEMINI_READER_ENABLED;
  }
});

test("2s.2: Cursor's self-consistent 699,59/699,51 disagreement - unreliable, never resolved to either value, A right / B wrong", async () => {
  process.env.GEMINI_READER_ENABLED = 'true';
  const a = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], amount: 699.59 }] };
  const b = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], amount: 699.51 }] };
  globalThis.fetch = mockReaders(a, b) as typeof fetch;
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const body = (await res.json()) as { status?: string; issues?: Array<{ code?: string; value_a?: unknown; value_b?: unknown }> };
    assert.equal(body.status, 'unreliable', `expected a two-reader disagreement to block, got: ${JSON.stringify(body)}`);
    assert.ok(body.issues?.some((i) => i.code === 'reader_line_disagreement'), JSON.stringify(body.issues));
  } finally {
    delete process.env.GEMINI_READER_ENABLED;
  }
});

test('2s.2: B right / A wrong - the same disagreement, direction reversed, still blocks (neither reader is trusted by default)', async () => {
  process.env.GEMINI_READER_ENABLED = 'true';
  const a = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], amount: 699.51 }] };
  const b = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], amount: 699.59 }] };
  globalThis.fetch = mockReaders(a, b) as typeof fetch;
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const body = (await res.json()) as { status?: string; issues?: Array<{ code?: string }> };
    assert.equal(body.status, 'unreliable');
    assert.ok(body.issues?.some((i) => i.code === 'reader_line_disagreement'));
  } finally {
    delete process.env.GEMINI_READER_ENABLED;
  }
});

test('2s.2: a line only one reading has (a reservation the other reader missed) blocks with reader_line_only_in_a/b', async () => {
  process.env.GEMINI_READER_ENABLED = 'true';
  const a = { ...BASE_EXTRACTION, reservation_lines: [{ type: 'vakantiegeld', accrued: 78.51, paid_out: 0 }] };
  const b = { ...BASE_EXTRACTION, reservation_lines: [] };
  globalThis.fetch = mockReaders(a, b) as typeof fetch;
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const body = (await res.json()) as { status?: string; issues?: Array<{ code?: string }> };
    assert.equal(body.status, 'unreliable');
    assert.ok(body.issues?.some((i) => i.code === 'reader_line_only_in_a'), JSON.stringify(body.issues));
  } finally {
    delete process.env.GEMINI_READER_ENABLED;
  }
});

test('2s.2: many disagreements (3+ fields) still block - unreliable, never ok, no threshold clears them', async () => {
  process.env.GEMINI_READER_ENABLED = 'true';
  const a = { ...BASE_EXTRACTION, printed_table_tax: 100, reported_total_net: 500, reported_net_paid: 500 };
  const b = { ...BASE_EXTRACTION, printed_table_tax: 200, reported_total_net: 501, reported_net_paid: 502 };
  globalThis.fetch = mockReaders(a, b) as typeof fetch;
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const body = (await res.json()) as { status?: string; issues?: Array<{ code?: string }> };
    assert.equal(body.status, 'unreliable');
    const disagreements = body.issues?.filter((i) => i.code === 'reader_field_disagreement') ?? [];
    assert.ok(disagreements.length >= 3, `expected at least 3 disagreement issues, got ${disagreements.length}: ${JSON.stringify(body.issues)}`);
  } finally {
    delete process.env.GEMINI_READER_ENABLED;
  }
});

test('2s.4: no reader content (raw JSON, PII) ever appears in a log line or the response body', async () => {
  process.env.GEMINI_READER_ENABLED = 'true';
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const logged: string[] = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.error = capture as typeof console.error;
  console.log = capture as typeof console.log;
  console.warn = capture as typeof console.warn;
  // Stage 2s (§2s.4): the description field goes through sanitizeText in mapRawExtractionToTierC (the
  // same as every existing reader) - this isolates whether the COMPARISON mechanism itself (the new
  // surface this round adds) introduces a leak, separate from hirer_name/employer_names, which were
  // already unsanitized before this round and already reach period.hirer.name regardless of reader
  // comparison - a real, pre-existing gap, out of this round's own scope, named in the report.
  const a = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], description: PII_MARKER, amount: 699.59 }] };
  const b = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], description: PII_MARKER, amount: 699.51 }] };
  globalThis.fetch = mockReaders(a, b) as typeof fetch;
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const rawBody = await res.text();
    assert.ok(!rawBody.includes(PII_MARKER), 'reader content must never reach the response body raw');
    for (const line of logged) {
      assert.ok(!line.includes(PII_MARKER), `reader content leaked into a log line: ${line}`);
    }
  } finally {
    delete process.env.GEMINI_READER_ENABLED;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
  }
});
