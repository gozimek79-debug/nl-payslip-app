import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isGroqConfigured } from '../ai-service/groq.js';
import { readingProviderStatus, activeDocumentVisionConfig } from '../ai-service/document-vision-provider.js';

const router = express.Router();

/**
 * Stage 2s (audit v48, §2s.1a, §2.15): "a temporary route that uses a production secret or calls a
 * paid provider refuses every request that does not carry a secret header checked against a
 * production env var set for that purpose... obeys the same rules as the real path it stands in
 * for... returns only what the question needs, never a raw upstream body... is removed in the same
 * round." `DIAGNOSTIC_SECRET` was generated and set in Vercel production this round (value never
 * committed, logged, or printed anywhere - see the report for the exact deploy window). Constant-time
 * compare (SHA-256 digest + timingSafeEqual) so a wrong-length or wrong-value guess cannot be timed
 * apart; any failure (missing secret, missing/wrong header, disabled) answers a bare 404, so the route
 * never confirms its own existence to a caller without the secret. The header value itself is never
 * logged or echoed back under any circumstance, success or failure.
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
 * Stage 2s (§2s.1a): "confirm live that the OCR endpoint on this account accepts a JSON-schema
 * annotation request with the JPEG data URLs the frontend sends, and returns the annotation. Latency,
 * per-page cost from the response's own usage data." A small, representative schema (period label, hour
 * lines, printed net) - proving the MECHANISM (document_annotation_format on the same confirmed
 * mistral-ocr-latest /v1/ocr endpoint, per Mistral's own docs), not exercising the full ~30-field
 * TierCExtraction schema, which is not needed to answer this one question. EU/Mistral fail-closed
 * exactly like the real reading path (documentVisionClient()) - refuses before any network call if the
 * active provider is not both EU-hosted and Mistral specifically (OCR is a Mistral-only endpoint).
 * Returns the parsed annotation and the response's own usage_info only - never the raw OCR markdown/
 * full upstream body, which is not needed to answer §2s.1a's question and could carry document content
 * on a future, non-synthetic call.
 */
router.post('/ocr-annotation-DIAGNOSTIC', express.json({ limit: '5mb' }), async (req, res) => {
  if (!diagnosticAuthorized(req)) return res.status(404).end();
  const config = activeDocumentVisionConfig();
  if (!config.euHosted || config.name !== 'mistral') return res.status(404).end();
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) return res.status(404).end();
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
        document_annotation_format: {
          type: 'json_schema',
          json_schema: {
            name: 'payslip_probe',
            // Widened for a second latency measurement (§2s.1a: "latency per page" needed a more
            // representative schema than the first 3-field probe - closer to TierCExtraction's real
            // ~20-field shape, though still not the full prompt, which is not needed to answer this
            // one question honestly).
            schema: {
              type: 'object',
              properties: {
                period_label: { type: ['string', 'null'] },
                period_end_date: { type: ['string', 'null'] },
                period_type: { type: ['string', 'null'] },
                hour_lines: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { description: { type: 'string' }, hours: { type: ['number', 'null'] }, rate: { type: ['number', 'null'] }, amount: { type: 'number' }, category: { type: 'string' } },
                    required: ['description', 'amount', 'category'],
                  },
                },
                pre_tax_deduction_lines: {
                  type: 'array',
                  items: { type: 'object', properties: { description: { type: 'string' }, amount: { type: 'number' }, category: { type: 'string' } }, required: ['description', 'amount', 'category'] },
                },
                printed_table_tax: { type: ['number', 'null'] },
                reported_total_net: { type: ['number', 'null'] },
                reported_net_paid: { type: ['number', 'null'] },
              },
              required: ['period_label', 'period_end_date', 'period_type', 'hour_lines', 'pre_tax_deduction_lines', 'printed_table_tax', 'reported_total_net', 'reported_net_paid'],
            },
          },
        },
      }),
    });
    const latencyMs = Date.now() - started;
    const text = await ocrRes.text();
    let parsed: { document_annotation?: string; usage_info?: unknown } | null = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    let documentAnnotation: unknown = null;
    if (parsed?.document_annotation) {
      try {
        documentAnnotation = JSON.parse(parsed.document_annotation);
      } catch {
        documentAnnotation = { unparsed: true };
      }
    }
    return res.status(200).json({
      upstream_status: ocrRes.status,
      latencyMs,
      documentAnnotation,
      usageInfo: parsed?.usage_info ?? null,
    });
  } catch {
    return res.status(502).json({ error_code: 'ocr_call_failed', latencyMs: Date.now() - started });
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
