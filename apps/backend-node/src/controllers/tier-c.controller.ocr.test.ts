import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';

/**
 * Stage 2q (audit v45, §2q.5): the four required end-to-end proofs for the OCR text-layer path - "a
 * synthetic image-only document produces an OCR text layer and the guard verifies its amounts... a
 * synthetic document with a deliberately wrong amount is flagged on the image-only path same as the
 * text-PDF path... OCR text never appears in a log line or response body (tested, not just asserted)...
 * fail-closed holds." A SEPARATE file from tier-c.controller.test.ts: that file's own `mockCompletion`
 * only ever answers `chat/completions`; every test here needs BOTH that AND `/ocr` answered, plus its
 * own captured console.error calls - a clean separation of concern, not a module-mock timing
 * requirement this time (the same `ipRateLimit` passthrough every HTTP-level Tier C test file needs).
 */

let app: (typeof import('../app.js'))['default'];
let server: ReturnType<typeof app.listen>;
let baseUrl: string;
let originalFetch: typeof fetch;
let originalApiKey: string | undefined;

before(async () => {
  mock.module('../rate-limiter.js', {
    namedExports: {
      ipRateLimit: () => (_req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => next(),
    },
  });
  ({ default: app } = await import('../app.js'));

  originalApiKey = process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY = 'test-key-2q';
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

// A minimal, single-line synthetic extraction - deliberately small so the only thing that can block
// it is the one thing each test means to exercise (the text-layer guard), not an unrelated gate.
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

// Fabricated, never a real name/IBAN - present ONLY to prove OCR's full document text (which would, on
// a real document, carry a name/address/IBAN/BSN) never reaches a log line or the response body.
const PII_MARKER = 'Jan Testkowalski NL00BANK0123456789';

// Every printed figure BASE_EXTRACTION itself carries (hour line, table tax, net, payout) - a genuinely
// clean synthetic OCR read that confirms all four, so the guard's own "too little confirms, distrust
// the whole layer" fallback (2i.0a) never fires and each test exercises the ONE thing it means to.
const CORRECT_OCR_TEXT = `${PII_MARKER}\nLoon normaal 699,78\nLoonheffing 145,51\nNetto 554,27`;

function mockFetchWithOcr(extractionJson: unknown, ocrMarkdown: string) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('mistral.ai') && url.includes('/ocr')) {
      return new Response(JSON.stringify({ pages: [{ markdown: ocrMarkdown }] }), { status: 200 });
    }
    if (url.includes('mistral.ai') && url.includes('chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(extractionJson) }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  };
}

test('2q.2/2q.5: an image-only upload (no documentText) builds an OCR text layer and the guard verifies a correct amount', async () => {
  globalThis.fetch = mockFetchWithOcr(BASE_EXTRACTION, CORRECT_OCR_TEXT) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
  });
  const body = (await res.json()) as { status?: string; technicalDetails?: { text_layer_source?: string; amounts_checked?: number; amounts_not_found?: number } };
  assert.equal(res.status, 200);
  assert.equal(body.status, 'ok', `expected an 'ok' read, got: ${JSON.stringify(body)}`);
  assert.equal(body.technicalDetails?.text_layer_source, 'ocr');
  assert.ok((body.technicalDetails?.amounts_checked ?? 0) > 0, 'expected at least one amount checked against the OCR text layer');
  assert.equal(body.technicalDetails?.amounts_not_found, 0);
});

test('2q.3/2q.5: a deliberately wrong amount is flagged on the image-only (OCR) path, the same way the text-PDF path already flags it', async () => {
  const wrongAmountExtraction = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], amount: 699.75 }] };
  globalThis.fetch = mockFetchWithOcr(wrongAmountExtraction, CORRECT_OCR_TEXT) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
  });
  const body = (await res.json()) as { status?: string; issues?: Array<{ code?: string; field?: string }> };
  assert.equal(body.status, 'unreliable', `expected the guard to block, got: ${JSON.stringify(body)}`);
  assert.ok(
    body.issues?.some((i) => i.code === 'amount_unreadable' && i.field === 'hour_lines[0].amount'),
    `expected an amount_unreadable issue for hour_lines[0].amount, got: ${JSON.stringify(body.issues)}`,
  );
});

test('2q.4: OCR text never appears in a log line or the response body', async () => {
  const originalConsoleError = console.error;
  const logged: string[] = [];
  console.error = ((...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }) as typeof console.error;
  const wrongAmountExtraction = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], amount: 699.75 }] };
  globalThis.fetch = mockFetchWithOcr(wrongAmountExtraction, CORRECT_OCR_TEXT) as typeof fetch;
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const rawBody = await res.text();
    assert.ok(!rawBody.includes(PII_MARKER), 'OCR text must never reach the response body');
    for (const line of logged) {
      assert.ok(!line.includes(PII_MARKER), `OCR text leaked into a log line: ${line}`);
    }
    assert.ok(
      logged.some((l) => l.includes('consistency-gate')),
      'expected the gate to have actually logged something for this blocked request - otherwise this test proves nothing at all',
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test('2q.4: TIER_C_OCR_DISABLED skips OCR entirely, falling back to the pre-existing image_only behaviour', async () => {
  globalThis.fetch = mockFetchWithOcr(BASE_EXTRACTION, CORRECT_OCR_TEXT) as typeof fetch;
  process.env.TIER_C_OCR_DISABLED = 'true';
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const body = (await res.json()) as {
      status?: string;
      technicalDetails?: { text_layer_source?: string };
      trace?: { technical_details?: { text_layer_source?: string } };
    };
    const source = body.technicalDetails?.text_layer_source ?? body.trace?.technical_details?.text_layer_source;
    assert.equal(source, 'none', `expected OCR to be skipped entirely, got: ${JSON.stringify(body)}`);
  } finally {
    delete process.env.TIER_C_OCR_DISABLED;
  }
});
