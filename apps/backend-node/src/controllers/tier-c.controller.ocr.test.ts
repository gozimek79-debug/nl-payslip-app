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

test('2r.1: OCR text is withheld from the extraction prompt - the model never sees it, only the guard does', async () => {
  let capturedChatBody: string | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes('mistral.ai') && url.includes('/ocr')) {
      return new Response(JSON.stringify({ pages: [{ markdown: CORRECT_OCR_TEXT }] }), { status: 200 });
    }
    if (url.includes('mistral.ai') && url.includes('chat/completions')) {
      capturedChatBody = typeof init?.body === 'string' ? init.body : undefined;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(BASE_EXTRACTION) }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
  });
  const body = (await res.json()) as { technicalDetails?: { text_layer_source?: string } };
  assert.equal(body.technicalDetails?.text_layer_source, 'ocr', 'expected this request to actually take the OCR branch');
  assert.ok(capturedChatBody, 'expected a captured outgoing extraction request');
  // Not a check for the literal words "DOCUMENT TEXT LAYER" - the system prompt's OWN instructional
  // text describing the mechanism contains that phrase unconditionally, on every call, whether or not
  // a block is actually attached. The real per-request block carries a random 16-hex-digit boundary
  // token (documentTextBlock, ocr-client.ts) - its ABSENCE, plus the OCR content's own absence, is
  // what actually proves no block was attached this time.
  assert.ok(!/=== DOCUMENT TEXT LAYER [0-9a-f]{16}/.test(capturedChatBody!), 'the extraction prompt must carry no actual text-layer data block when the source is OCR');
  assert.ok(!capturedChatBody!.includes(PII_MARKER), 'OCR text must never reach the extraction model');
});

test('2q.4/2r.4b: OCR text never appears in a log line (error, log or warn) or the response body, not even as a fragment', async () => {
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
  const wrongAmountExtraction = { ...BASE_EXTRACTION, hour_lines: [{ ...BASE_EXTRACTION.hour_lines[0], amount: 699.75 }] };
  globalThis.fetch = mockFetchWithOcr(wrongAmountExtraction, CORRECT_OCR_TEXT) as typeof fetch;
  // Stage 2r (§2r.4b): a fragment of the marker (the IBAN alone), not only the exact full string -
  // the original 2q leak test would have missed a log line that echoed part of the OCR text (e.g. a
  // stray field) without reproducing the whole marker verbatim.
  const PII_FRAGMENT = 'NL00BANK0123456789';
  try {
    const res = await originalFetch(`${baseUrl}/api/tier-c/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: ['data:image/jpeg;base64,Zg=='] }),
    });
    const rawBody = await res.text();
    assert.ok(!rawBody.includes(PII_MARKER) && !rawBody.includes(PII_FRAGMENT), 'OCR text (or a fragment of it) must never reach the response body');
    for (const line of logged) {
      assert.ok(!line.includes(PII_MARKER) && !line.includes(PII_FRAGMENT), `OCR text (or a fragment) leaked into a log line: ${line}`);
    }
    assert.ok(
      logged.some((l) => l.includes('consistency-gate')),
      'expected the gate to have actually logged something for this blocked request - otherwise this test proves nothing at all',
    );
  } finally {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
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
