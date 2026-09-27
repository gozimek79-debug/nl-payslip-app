import express from 'express';
import { isGroqConfigured } from '../ai-service/groq.js';
import { readingProviderStatus, activeDocumentVisionConfig } from '../ai-service/document-vision-provider.js';

const router = express.Router();

// Stage 2q (audit v45, §2q.1a): "query this account's /v1/models directly and name the exact OCR
// model ID that exists today... do not take an ID from docs or from this task." TEMPORARY - the same
// idiom ocr-client.ts's own `logVisionProviderFailure` already uses (a raw, unauthenticated-by-key
// fetch of the provider's own /models endpoint, since the SDK's own model-list helper isn't wired up
// here) - added purely to capture this one answer live, then removed once it's confirmed and recorded
// in this round's own report. Never logs the API key; the response is the provider's own public model
// metadata, not document content.
router.get('/vision-models-DIAGNOSTIC', async (_req, res) => {
  const config = activeDocumentVisionConfig();
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) return res.status(503).json({ error_code: 'not_configured' });
  try {
    const modelsRes = await fetch(`${config.baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const text = await modelsRes.text();
    return res.status(modelsRes.status).type('application/json').send(text);
  } catch {
    return res.status(502).json({ error_code: 'models_list_failed' });
  }
});

/**
 * Stage 2h (audit v28, §2h.6): "GET /api/ai/status reports readingProviderStatus() instead of
 * reading GROQ_API_KEY; nothing else changes." `visionAvailable` was still checking `GROQ_API_KEY`
 * (via `isVisionConfigured`) even though document reading moved to Mistral in stage 2c - flagged by
 * both the contractor (stage 2h report) and the reviewer as stale. `available` stays `isGroqConfigured()`
 * unchanged: Groq is still genuinely used for `/explain`'s text-explanation call, a different feature
 * this field was always about.
 */
// Stage 2q (audit v45, §2q.1b/c/d): "confirm the OCR endpoint's request/response shape against
// Mistral's own docs AND one live call on a synthetic document... confirm it accepts the JPEG data
// URLs the frontend already sends... measure latency per page." TEMPORARY - accepts a synthetic JPEG
// data URL in the request body (never a real document; the caller supplies it), calls POST /v1/ocr
// directly with the confirmed 'mistral-ocr-latest' model, and returns the raw response plus latency.
// Removed once this round's report records the answer. Never logs the API key or the document body.
router.post('/ocr-DIAGNOSTIC', express.json({ limit: '5mb' }), async (req, res) => {
  const config = activeDocumentVisionConfig();
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) return res.status(503).json({ error_code: 'not_configured' });
  const imageDataUrl = req.body?.imageDataUrl;
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error_code: 'missing_image_data_url' });
  }
  const started = Date.now();
  try {
    const ocrRes = await fetch(`${config.baseURL}/ocr`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mistral-ocr-latest',
        document: { type: 'image_url', image_url: imageDataUrl },
      }),
    });
    const latencyMs = Date.now() - started;
    const text = await ocrRes.text();
    return res.status(200).json({ upstream_status: ocrRes.status, latencyMs, body: JSON.parse(text) });
  } catch (err) {
    return res.status(502).json({ error_code: 'ocr_call_failed', latencyMs: Date.now() - started, message: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/status', (_req, res) => {
  res.json({ available: isGroqConfigured(), visionAvailable: readingProviderStatus().status === 'ready' });
});

export default router;
