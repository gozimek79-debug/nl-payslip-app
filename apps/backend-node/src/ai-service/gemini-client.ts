import { mapRawExtractionToTierC } from '../ocr-service/ocr-client.js';
import { TIER_C_EXTRACTION_SCHEMA, toGeminiResponseSchema } from '../ocr-service/tier-c-extraction-schema.js';
import type { TierCExtraction } from '../payroll-engine/tier-c.js';

/**
 * Stage 2s (audit v51, §2s.1c/§5.2): "Gemini is off unless one env var enables it, and it is the only
 * reading call allowed to be non-EU." Document images reach Google's servers OUTSIDE the EU on this
 * path (the ordinary Gemini API, not Vertex AI - the owner's own 28 September decision) - this is
 * accepted for development and the owner's own test documents only (§5.5 gates real-user launch on
 * three conditions, none met yet). Every OTHER reading call (Mistral, and any future EU-hosted
 * provider) keeps its own unchanged fail-closed rule; this switch does not loosen that, it is the one
 * deliberate, named exception the owner made for reader B specifically.
 */
export function isGeminiReaderEnabled(): boolean {
  return process.env.GEMINI_READER_ENABLED === 'true' && Boolean(process.env.GEMINI_API_KEY);
}

/** Stage 2s (§2s.1b): confirmed live against this account's own `/v1beta/models` - `gemini-3.8-flash`
 * is present, supports `generateContent`, is not a "-preview" build (the stable release in its own
 * generation, per Google's own public model page), and correctly extracted every printed line on two
 * separate live calls this round. Not simply "whichever model the list returned first" - `gemini-2.5-
 * flash` happened to sort earlier in the same list and was NOT chosen, for that same reason. */
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export function geminiModel(): string {
  return process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

/**
 * Stage 2s (§2s.2): "Reader B - Gemini, reading the page images with the same extraction instruction
 * and the same schema." Gemini's `generateContent` naturally accepts several images as separate
 * `inline_data` parts within ONE call (confirmed against Google's own REST docs) - unlike Mistral's
 * OCR annotation endpoint (one document per call, §2s.1a), so this reader sends every page in a
 * SINGLE request, no per-page merge needed. `inline_data.data` takes raw base64 with no `data:
 * image/...;base64,` prefix (confirmed live, §2s.1b) - stripped here, never a frontend change.
 */
export async function extractTierCPayslipViaGemini(imageDataUrls: string[]): Promise<TierCExtraction> {
  if (!isGeminiReaderEnabled()) {
    throw new Error('Gemini reader is not enabled (GEMINI_READER_ENABLED is not "true", or GEMINI_API_KEY is not configured).');
  }
  const apiKey = process.env.GEMINI_API_KEY as string;
  const model = geminiModel();
  const schema = toGeminiResponseSchema(TIER_C_EXTRACTION_SCHEMA);

  const imageParts = imageDataUrls.map((url) => {
    const commaIndex = url.indexOf(',');
    const rawBase64 = commaIndex >= 0 ? url.slice(commaIndex + 1) : url;
    const mimeMatch = url.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    return { inline_data: { mime_type: mimeType, data: rawBase64 } };
  });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { text: 'Odczytaj wszystkie strony tego paska wypłaty i zwróć JSON zgodny z opisaną strukturą, wartości dokładnie jak wydrukowane.' },
            ...imageParts,
          ],
        },
      ],
      generationConfig: { response_mime_type: 'application/json', response_schema: schema },
    }),
  });
  if (!res.ok) throw new Error(`Gemini generateContent call failed: HTTP ${res.status}`);
  const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> };
  const candidate = body.candidates?.[0];
  const rawJson = candidate?.content?.parts?.[0]?.text;
  if (!rawJson) throw new Error('Gemini returned no extractable content.');
  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  const truncated = candidate?.finishReason === 'MAX_TOKENS';
  return mapRawExtractionToTierC(parsed, truncated);
}
