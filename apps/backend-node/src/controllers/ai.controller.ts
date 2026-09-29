import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isGroqConfigured } from '../ai-service/groq.js';
import { readingProviderStatus } from '../ai-service/document-vision-provider.js';

const router = express.Router();

/**
 * Stage 2t (audit v52, §2t.1, §2.15): "from this account's own Gemini model list, live, choose the
 * strongest model that reads images... name it... report the exact live model ID before
 * implementation." Same §2.15-protected pattern as the 2s diagnostics: a fresh `DIAGNOSTIC_SECRET`,
 * constant-time check, any failure a bare 404. Reuses the EXISTING `GEMINI_API_KEY` (already in
 * Vercel production) and, unlike the 2s diagnostics, needs no new env var at all - `GEMINI_READER_ENABLED`
 * is already `true` in production for the owner's own retest, left untouched. Confirms the account's
 * real model list (never taken from the owner's own message or from docs, even though both already
 * name `gemini-3.1-pro-preview` - checked live anyway, per §2.2), the model's metadata (input token
 * limit, supported generation methods), and one live extraction call for latency/quality.
 */
function diagnosticAuthorized(req: express.Request): boolean {
  const configured = process.env.DIAGNOSTIC_SECRET;
  if (!configured) return false;
  const provided = req.headers['x-diagnostic-secret'];
  if (typeof provided !== 'string' || provided === '') return false;
  const configuredHash = createHash('sha256').update(configured).digest();
  const providedHash = createHash('sha256').update(provided).digest();
  return timingSafeEqual(configuredHash, providedHash);
}

router.post('/gemini-model-DIAGNOSTIC', express.json({ limit: '5mb' }), async (req, res) => {
  if (!diagnosticAuthorized(req)) return res.status(404).end();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(404).end();

  try {
    const modelsRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const modelsText = await modelsRes.text();
    let models: Array<{ name?: string; supportedGenerationMethods?: string[]; inputTokenLimit?: number; outputTokenLimit?: number; displayName?: string }> = [];
    try {
      const parsed = JSON.parse(modelsText) as { models?: typeof models };
      models = parsed.models ?? [];
    } catch {
      models = [];
    }
    const withGenerateContent = models.filter((m) => m.supportedGenerationMethods?.includes('generateContent'));
    const wanted = ['gemini-3.1-pro-preview', 'gemini-pro-latest', 'gemini-2.5-pro'];
    const wantedDetails = wanted.map((id) => {
      const m = withGenerateContent.find((mm) => (mm.name ?? '').replace(/^models\//, '') === id);
      return m ? { id, present: true, inputTokenLimit: m.inputTokenLimit, outputTokenLimit: m.outputTokenLimit, displayName: m.displayName } : { id, present: false };
    });

    const imageDataUrl = req.body?.imageDataUrl;
    let extractionResult: unknown = null;
    if (typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:image/')) {
      const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : 'gemini-3.1-pro-preview';
      const commaIndex = imageDataUrl.indexOf(',');
      const rawBase64 = commaIndex >= 0 ? imageDataUrl.slice(commaIndex + 1) : imageDataUrl;
      const mimeMatch = imageDataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
      const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
      const started = Date.now();
      const genRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Extract every printed line item and its amount from this payslip page. Return a plain JSON object mapping each line label to its printed amount.' }, { inline_data: { mime_type: mimeType, data: rawBase64 } }] }],
          generationConfig: { response_mime_type: 'application/json' },
        }),
      });
      const latencyMs = Date.now() - started;
      const text = await genRes.text();
      let parsed: unknown = null;
      try {
        const body = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        parsed = body.candidates?.[0]?.content?.parts?.[0]?.text ?? { raw_status: genRes.status };
      } catch {
        parsed = { raw_status: genRes.status };
      }
      extractionResult = { modelId, status: genRes.status, latencyMs, parsed };
    }

    return res.status(200).json({ wantedDetails, totalModelsWithGenerateContent: withGenerateContent.length, extractionResult });
  } catch (err) {
    return res.status(502).json({ error_code: 'gemini_call_failed', message: err instanceof Error ? err.message : String(err) });
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
