import { mapRawExtractionToTierC, TIER_C_SYSTEM_PROMPT, documentTextBlock } from '../ocr-service/ocr-client.js';
import { mapRawContractExtraction, CONTRACT_SYSTEM_PROMPT } from '../ocr-service/contract-client.js';
import { TIER_C_EXTRACTION_SCHEMA, toGeminiResponseSchema } from '../ocr-service/tier-c-extraction-schema.js';
import type { TierCExtraction } from '../payroll-engine/tier-c.js';
import type { DocumentTextItem } from '../payroll-engine/document-text-guard.js';
import type { ContractExtraction } from '../payroll-engine/contract.js';
import {
  pageTextBlock, batchInstruction, PAYSLIP_FACTS_PROMPT, CONTRACT_FACTS_PROMPT, PAYSLIP_FACTS_SCHEMA, CONTRACT_FACTS_SCHEMA,
  mapPayslipFactsResponse, mapContractFactsResponse, type PageTextLine,
} from '../ocr-service/fact-extraction.js';
import type { PayslipFactsBatch, ContractFactsBatch } from '../payroll-engine/document-facts.js';

/**
 * Stage 2t (audit v52, §2t.1/§2t.2, owner's 29 September decision): "use a stronger Gemini model for
 * reading and stop with Mistral or cheaper models. The client pays for this; we are not looking for
 * the cheapest cost." Confirmed live this round against this account's own `/v1beta/models` (never
 * from the owner's own message or from docs, though both already named it - checked anyway, per
 * §2.2): `gemini-3.1-pro-preview` exists, is a genuine "pro"-class model (1,048,576 input / 65,536
 * output token limit - not a flash/lite variant), and correctly extracted every printed value on a
 * synthetic payslip page in 3193 ms. This is now the ONLY document reader in the product - every
 * payslip (embedded-PDF, scan or photo) and every contract, replacing Mistral Medium, Mistral OCR
 * annotation and the 2s two-reader comparison entirely (§2t.2: "remove them from the path, don't
 * leave dead switches") - no enable switch, no provider choice: this is the one reading path there is.
 */
const DEFAULT_GEMINI_MODEL = 'gemini-3.1-pro-preview';

export function geminiModel(): string {
  return process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/**
 * Stage 2t (§5.2, honesty requirement): "no code comment or /api/health field may still claim reading
 * is EU-only." All document reading now goes to Google's ordinary Gemini API, outside the EU - the
 * status this project reports about its own reading path must say so plainly, not carry over Mistral's
 * old EU-hosted framing. `readingProviderStatus()`'s old shape (`euOnly: true` always) is retired with
 * it - see `app.ts`/`ai.controller.ts` for the two callers this replaces.
 */
export function readingProviderStatus(): { provider: string | null; status: 'ready' | 'not_configured'; euOnly: false } {
  if (!isGeminiConfigured()) return { provider: null, status: 'not_configured', euOnly: false };
  return { provider: `Google Gemini (${geminiModel()}) - reading is NOT EU-hosted`, status: 'ready', euOnly: false };
}

interface GeminiCallResult {
  status: number;
  text: string;
  finishReason?: string;
}

async function callGemini(promptText: string, imageDataUrls: string[], schema: unknown): Promise<GeminiCallResult> {
  if (!isGeminiConfigured()) throw new Error('GEMINI_API_KEY is not configured.');
  const apiKey = process.env.GEMINI_API_KEY as string;
  const model = geminiModel();
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
      contents: [{ parts: [{ text: promptText }, ...imageParts] }],
      generationConfig: { response_mime_type: 'application/json', response_schema: schema },
    }),
  });
  if (!res.ok) throw new Error(`Gemini generateContent call failed: HTTP ${res.status}`);
  const body = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> };
  const candidate = body.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no extractable content.');
  return { status: res.status, text, finishReason: candidate?.finishReason };
}

/**
 * Stage 2t (§2t.2): "a PDF's embedded text layer is still sent with the images and is still the
 * source for amounts (it is exact)." Same `TIER_C_SYSTEM_PROMPT` (unchanged - the prompt's own
 * payslip-reading instructions are not vendor-specific) and the same `documentTextBlock` (the
 * random-boundary, prompt-injection-safe wrapper) every prior reader already used; `inline_data`
 * (Gemini's own multi-image-per-call shape, confirmed live in stage 2s) replaces the OpenAI-style
 * `image_url` parts, nothing else about the prompt discipline changes.
 */
export async function extractTierCPayslip(imageDataUrls: string[], textItems: DocumentTextItem[] = []): Promise<TierCExtraction> {
  const textBlock = documentTextBlock(textItems);
  const promptText = [
    TIER_C_SYSTEM_PROMPT,
    `\n\nOdczytaj wszystkie ${imageDataUrls.length} stron(y) tego paska wypłaty i zwróć JSON zgodny z opisaną strukturą.`,
    ...(textBlock ? [textBlock] : []),
  ].join('\n');
  const schema = toGeminiResponseSchema(TIER_C_EXTRACTION_SCHEMA);
  const result = await callGemini(promptText, imageDataUrls, schema);
  const parsed = JSON.parse(result.text) as Record<string, unknown>;
  return mapRawExtractionToTierC(parsed, result.finishReason === 'MAX_TOKENS');
}

/** Stage 2t (§2t.2): the same move for contract reading - same prompt, same mapping, only the vendor
 * changes. No JSON schema enforced here (the contract prompt's own compact-key shape is small and has
 * run reliably as free-form JSON since it was written; adding one is a reasonable future hardening,
 * not required for this round's own scope). */
export async function extractContract(imageDataUrls: string[]): Promise<ContractExtraction> {
  const promptText = [CONTRACT_SYSTEM_PROMPT, `\n\nOdczytaj wszystkie ${imageDataUrls.length} stron(y) tej umowy i zwróć zwarty JSON zgodny z opisaną strukturą. Pamiętaj o zakazie danych osobowych.`].join('\n');
  const result = await callGemini(promptText, imageDataUrls, undefined);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.text) as Record<string, unknown>;
  } catch {
    const match = result.text.match(/\{[\s\S]*\}/);
    parsed = match ? (JSON.parse(match[0]) as Record<string, unknown>) : {};
  }
  return mapRawContractExtraction(parsed);
}

/**
 * P2 (ZADANIE-P2-LOONTO-PRO.md §P2.7): the fact-oriented reads - the SAME transport and model as above
 * (`callGemini`, `geminiModel()`), with the typed fact schemas and prompts from fact-extraction.ts.
 * One call reads one page batch of one document; the caller says which pages the images are and
 * which pages the text layer covers, and the reader is told to report facts for those pages only.
 * The page-indexed text layer goes in through `pageTextBlock` - the same random-boundary,
 * data-not-instructions construction as `documentTextBlock`.
 */
export interface FactReadRequest {
  images: string[];
  /** The 1-based page each image is, in image order. */
  imagePages: number[];
  /** Every page this call covers (images and/or text). */
  pages: number[];
  totalPages: number;
  textLines: PageTextLine[];
}

function factPrompt(basePrompt: string, kind: 'payslip' | 'contract', req: FactReadRequest): string {
  const textBlock = pageTextBlock(req.textLines);
  return [basePrompt, `\n\n${batchInstruction(kind, req.pages, req.totalPages, req.imagePages)}`, ...(textBlock ? [textBlock] : [])].join('\n');
}

export async function extractPayslipFacts(req: FactReadRequest): Promise<PayslipFactsBatch> {
  const result = await callGemini(factPrompt(PAYSLIP_FACTS_PROMPT, 'payslip', req), req.images, toGeminiResponseSchema(PAYSLIP_FACTS_SCHEMA));
  return mapPayslipFactsResponse(JSON.parse(result.text) as unknown, req.pages, req.totalPages);
}

export async function extractContractFacts(req: FactReadRequest): Promise<ContractFactsBatch> {
  const result = await callGemini(factPrompt(CONTRACT_FACTS_PROMPT, 'contract', req), req.images, toGeminiResponseSchema(CONTRACT_FACTS_SCHEMA));
  return mapContractFactsResponse(JSON.parse(result.text) as unknown, req.pages, req.totalPages);
}
