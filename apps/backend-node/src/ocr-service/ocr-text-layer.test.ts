import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOcrTextLayer } from './ocr-text-layer.js';

/**
 * Stage 2q (audit v45, §2q.5): "a synthetic image-only document produces an OCR text layer... fail-
 * closed holds for the OCR call." Unit-level coverage for `buildOcrTextLayer` itself, isolated from the
 * HTTP layer (see tier-c.controller.test.ts's own 2q tests for the end-to-end /analyze path). Every
 * test restores `globalThis.fetch` and the two env vars it touches in a `finally`, following this
 * project's own established pattern (ocr-client.test.ts).
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) originals[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('2q.2: builds one DocumentTextItem per page from a real /ocr response shape, x:0,y:0, model+document sent as confirmed live', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, body });
    const page = calls.length - 1;
    return new Response(JSON.stringify({ pages: [{ markdown: `Loon normaal 699,7${page}` }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const items = await withEnv({ MISTRAL_API_KEY: 'test-key', TIER_C_VISION_PROVIDER: undefined }, () =>
      buildOcrTextLayer(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']),
    );
    assert.equal(calls.length, 2);
    assert.ok(calls[0]!.url.endsWith('/ocr'), `expected the /ocr endpoint, got ${calls[0]!.url}`);
    assert.deepEqual(calls[0]!.body, { model: 'mistral-ocr-latest', document: { type: 'image_url', image_url: 'data:image/jpeg;base64,AAA' } });
    assert.deepEqual(items, [
      { page: 1, text: 'Loon normaal 699,70', x: 0, y: 0 },
      { page: 2, text: 'Loon normaal 699,71', x: 0, y: 0 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2q.4: fail-closed - refuses when the active provider is not Mistral, even with an API key set', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('must not be called');
  }) as typeof fetch;
  try {
    const items = await withEnv({ MISTRAL_API_KEY: 'test-key', OPENAI_API_KEY: 'test-key', TIER_C_VISION_PROVIDER: 'openai' }, () =>
      buildOcrTextLayer(['data:image/jpeg;base64,AAA']),
    );
    assert.deepEqual(items, []);
    assert.equal(fetchCalled, false, 'expected buildOcrTextLayer to refuse before ever calling fetch for a non-Mistral provider');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2q.4: fail-closed - refuses when Mistral is active but no API key is configured', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('must not be called');
  }) as typeof fetch;
  try {
    const items = await withEnv({ MISTRAL_API_KEY: undefined, TIER_C_VISION_PROVIDER: 'mistral' }, () => buildOcrTextLayer(['data:image/jpeg;base64,AAA']));
    assert.deepEqual(items, []);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2r.3: if ANY page\'s OCR call throws, the WHOLE result is empty - never a partial layer covering only the pages that succeeded', async () => {
  const originalFetch = globalThis.fetch;
  let callIndex = -1;
  globalThis.fetch = (async () => {
    callIndex += 1;
    if (callIndex === 0) throw new Error('network error on page 1');
    return new Response(JSON.stringify({ pages: [{ markdown: 'STIPP-pensioen werknemer 34,79' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const items = await withEnv({ MISTRAL_API_KEY: 'test-key', TIER_C_VISION_PROVIDER: undefined }, () =>
      buildOcrTextLayer(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']),
    );
    assert.deepEqual(items, [], 'expected the whole layer discarded, not just page 1 dropped');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2r.3: a non-200 upstream response on one page discards the whole layer, not just that page', async () => {
  const originalFetch = globalThis.fetch;
  let callIndex = -1;
  globalThis.fetch = (async () => {
    callIndex += 1;
    if (callIndex === 0) return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
    return new Response(JSON.stringify({ pages: [{ markdown: 'STIPP-pensioen werknemer 34,79' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const items = await withEnv({ MISTRAL_API_KEY: 'test-key', TIER_C_VISION_PROVIDER: undefined }, () =>
      buildOcrTextLayer(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']),
    );
    assert.deepEqual(items, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2q.2: every page succeeding still returns one item per page, unaffected by the all-or-nothing rule', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ pages: [{ markdown: 'Loon normaal 699,78' }] }), { status: 200 })) as typeof fetch;
  try {
    const items = await withEnv({ MISTRAL_API_KEY: 'test-key', TIER_C_VISION_PROVIDER: undefined }, () =>
      buildOcrTextLayer(['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB']),
    );
    assert.deepEqual(items, [
      { page: 1, text: 'Loon normaal 699,78', x: 0, y: 0 },
      { page: 2, text: 'Loon normaal 699,78', x: 0, y: 0 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2q.2: an empty imageDataUrls list returns an empty text layer without calling fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const items = await withEnv({ MISTRAL_API_KEY: 'test-key', TIER_C_VISION_PROVIDER: undefined }, () => buildOcrTextLayer([]));
    assert.deepEqual(items, []);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
