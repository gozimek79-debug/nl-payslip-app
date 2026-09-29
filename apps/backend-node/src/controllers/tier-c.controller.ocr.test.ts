import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';

/**
 * Stage 2t (audit v52, §2t.2): "one reader for everything." SUPERSEDES this file's own earlier content
 * (stages 2q/2r/2s): those tests exercised, in turn, the OCR-text-layer-plus-bag-of-numbers-guard
 * mechanism and then the two-reader (Mistral + Gemini) comparison for the image-only path - both are
 * retired now that `gemini-client.ts`'s `extractTierCPayslip` is the ONE reader for every document
 * shape, with no enable switch and nothing to compare against. What remains worth its own HTTP-level
 * file: the reader's own failure handling (a thrown error must reach the route's try/catch as a clean
 * 502, not an unhandled rejection - the exact bug class stage 2s's own fix targeted), and the PII
 * discipline (a reader's raw content must never reach a log line or the response body unsanitized) -
 * both apply identically regardless of which single reader is behind the call.
 */

let app: (typeof import('../app.js'))['default'];
let server: ReturnType<typeof app.listen>;
let baseUrl: string;
let originalFetch: typeof fetch;
let originalGeminiKey: string | undefined;

before(async () => {
  mock.module('../rate-limiter.js', {
    namedExports: {
      ipRateLimit: () => (_req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => next(),
    },
  });
  ({ default: app } = await import('../app.js'));

  originalGeminiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini-key-2t';
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  originalFetch = globalThis.fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalGeminiKey;
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

// Fabricated, never a real name/IBAN - present only to prove the reader's raw content never reaches a
// log line or the response body (§2q.4's own discipline, still required - the sole remaining reader
// goes through the same sanitizeText/mapRawExtractionToTierC mapping every prior reader always did).
const PII_MARKER = 'Jan Testkowalski NL00BANK0123456789';

function mockGemini(extractionJson: unknown) {
  return async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('generativelanguage.googleapis.com') && url.includes(':generateContent')) {
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(extractionJson) }] }, finishReason: 'STOP' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

test('2t.2: the reader failing (network error) produces a structured 502, not an unhandled rejection - the call must run INSIDE the try/catch, not before it', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('generativelanguage.googleapis.com')) throw new Error('simulated reader network failure');
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

test('2t.2: a clean image-only read (no documentText) computes normally through the one Gemini reader', async () => {
  globalThis.fetch = mockGemini(BASE_EXTRACTION) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
  });
  const body = (await res.json()) as { status?: string; technicalDetails?: { text_layer_source?: string } };
  assert.equal(body.status, 'ok', `expected a usable read, got: ${JSON.stringify(body)}`);
  assert.equal(body.technicalDetails?.text_layer_source, 'none', 'expected no text-layer source on an image-only upload');
});

test('2s.4: no reader content (raw JSON, PII) ever appears in a log line or the response body', async () => {
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
  // The description field goes through sanitizeText in mapRawExtractionToTierC - this isolates whether
  // the reader's own mapping leaks raw content, separate from hirer_name/employer_names (fixed in 2t.6).
  const withPii = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], description: PII_MARKER }] };
  globalThis.fetch = mockGemini(withPii) as typeof fetch;
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
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
  }
});
