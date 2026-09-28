import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isGroqConfigured } from '../ai-service/groq.js';
import { readingProviderStatus } from '../ai-service/document-vision-provider.js';

const router = express.Router();

/**
 * Stage 2s (audit v51, §2s.1b/e, §2.15): "a temporary route that uses a production secret or calls a
 * paid provider refuses every request that does not carry a secret header checked against a
 * production env var set for that purpose... is removed in the same round." Same mechanism as the
 * 2s.1(a) diagnostic (removed at the end of that round) - a fresh `DIAGNOSTIC_SECRET` is set for this
 * round's own window, value never committed, logged, or printed. Constant-time compare, any failure
 * (missing secret, missing/wrong header) answers a bare 404.
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

/**
 * Stage 2s (§2s.1b): "confirm the exact Gemini model ID live against the account's own model list...
 * never from documentation." Reuses the EXISTING `GEMINI_API_KEY` env var (already present in Vercel
 * production, set by the owner before this round - found via `vercel env ls`, never a new key). Lists
 * every model and, for each, whether `generateContent` is a supported method (the REST shape, per
 * Google's own docs, confirmed live below) - so the eventual model choice is read off this account's
 * real list, the same discipline 2q used for Mistral's OCR model.
 *
 * §2s.1(e): "measure a synthetic three-page document through both readers... pages run in parallel."
 * `parallelBatchMs` fires 3 concurrent calls (simulating 3 page images processed at once, matching this
 * project's own per-page-in-parallel architecture) and times the WHOLE batch, not the sum of each -
 * this is the number that answers whether a 3-page document fits inside one function invocation.
 */
router.post('/gemini-probe-DIAGNOSTIC', express.json({ limit: '5mb' }), async (req, res) => {
  if (!diagnosticAuthorized(req)) return res.status(404).end();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(404).end();
  const imageDataUrl = req.body?.imageDataUrl;
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error_code: 'missing_image_data_url' });
  }
  // Gemini's inline_data.data field takes RAW base64, no "data:image/...;base64," prefix - confirmed
  // against Google's own REST docs this round. The FRONTEND's own data URL shape does not change
  // (2s.1c's own instruction) - this stripping happens only in this backend-side request builder,
  // exactly the same kind of reshaping the Mistral request builder already does for its own shape.
  const commaIndex = imageDataUrl.indexOf(',');
  const rawBase64 = commaIndex >= 0 ? imageDataUrl.slice(commaIndex + 1) : imageDataUrl;
  const mimeMatch = imageDataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  try {
    const modelsRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const modelsText = await modelsRes.text();
    let models: Array<{ name?: string; supportedGenerationMethods?: string[] }> = [];
    try {
      const parsedModels = JSON.parse(modelsText) as { models?: typeof models };
      models = parsedModels.models ?? [];
    } catch {
      models = [];
    }
    const modelSummary = models
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''));

    // Confirmed live (this call): a preview/flash-tier model name from the list above, once known -
    // not hardcoded from docs. The env var name itself is left unset here on purpose (§2s.1c: only
    // the NAME goes in .env.example, never a guessed default before this round's own live answer).
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : modelSummary[0];
    if (!modelId) {
      return res.status(200).json({ modelsAvailable: modelSummary, note: 'no model with generateContent found, or none requested' });
    }

    const schema = {
      type: 'OBJECT',
      properties: {
        period_label: { type: 'STRING', nullable: true },
        hour_lines: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { description: { type: 'STRING' }, amount: { type: 'NUMBER' }, category: { type: 'STRING' } },
            required: ['description', 'amount', 'category'],
          },
        },
        pre_tax_deduction_lines: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: { description: { type: 'STRING' }, amount: { type: 'NUMBER' }, category: { type: 'STRING' } }, required: ['description', 'amount', 'category'] },
        },
        printed_table_tax: { type: 'NUMBER', nullable: true },
        reported_total_net: { type: 'NUMBER', nullable: true },
      },
      required: ['period_label', 'hour_lines', 'pre_tax_deduction_lines', 'printed_table_tax', 'reported_total_net'],
    };

    const callGemini = async (): Promise<{ status: number; latencyMs: number; parsed: unknown }> => {
      const started = Date.now();
      const res2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Extract every printed line into the given schema, values exactly as printed.' }, { inline_data: { mime_type: mimeType, data: rawBase64 } }] }],
          generationConfig: { response_mime_type: 'application/json', response_schema: schema },
        }),
      });
      const latencyMs = Date.now() - started;
      const text = await res2.text();
      let parsed: unknown = null;
      try {
        const body = JSON.parse(text) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const rawJson = body.candidates?.[0]?.content?.parts?.[0]?.text;
        parsed = rawJson ? JSON.parse(rawJson) : { unparsed_status: res2.status };
      } catch {
        parsed = { unparsed_status: res2.status };
      }
      return { status: res2.status, latencyMs, parsed };
    };

    const single = await callGemini();
    const batchStarted = Date.now();
    const batch = await Promise.all([callGemini(), callGemini(), callGemini()]);
    const parallelBatchMs = Date.now() - batchStarted;

    return res.status(200).json({
      modelsAvailable: modelSummary,
      modelUsed: modelId,
      single,
      parallelBatchMs,
      parallelIndividualMs: batch.map((b) => b.latencyMs),
    });
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
