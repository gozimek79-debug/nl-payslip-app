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
router.get('/status', (_req, res) => {
  res.json({ available: isGroqConfigured(), visionAvailable: readingProviderStatus().status === 'ready' });
});

export default router;
