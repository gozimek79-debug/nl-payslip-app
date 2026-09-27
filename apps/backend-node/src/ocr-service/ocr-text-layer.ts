import type { DocumentTextItem } from '../payroll-engine/document-text-guard.js';
import { activeDocumentVisionConfig, isOcrConfigured, ocrModel } from '../ai-service/document-vision-provider.js';

interface MistralOcrPage {
  markdown?: unknown;
}
interface MistralOcrResponse {
  pages?: MistralOcrPage[];
}

/**
 * Stage 2q (§2q.1b/c, live-confirmed): POST {baseURL}/ocr, `document: { type: 'image_url', image_url:
 * <the data: URL string> }` - a BARE string, not the `{ url }` object the chat-completions vision call
 * uses (confirmed by one live call on a synthetic image during this stage's own survey; see the
 * report). Returns null (never throws) on any non-200 response or malformed body - a page OCR cannot
 * read is simply a page with no text layer, exactly as if OCR had never run for it.
 */
async function callMistralOcrPage(imageDataUrl: string): Promise<string | null> {
  const config = activeDocumentVisionConfig();
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) return null;
  const res = await fetch(`${config.baseURL}/ocr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ocrModel(), document: { type: 'image_url', image_url: imageDataUrl } }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as MistralOcrResponse;
  const markdown = body.pages?.[0]?.markdown;
  return typeof markdown === 'string' && markdown.trim() !== '' ? markdown : null;
}

/**
 * Stage 2q (§2q.2): "when a request carries no usable text layer, run OCR on the same page images and
 * build a text layer in the DocumentTextItem shape already used, feeding it to (a) the extraction call
 * and (b) document-text-guard.ts." Fails closed exactly like `documentVisionClient()` - refuses (empty
 * result) unless the active provider is Mistral and EU-hosted (`isOcrConfigured()`). Never throws: a
 * single page's OCR call failing (network error, non-200, malformed body) is swallowed and that page
 * simply contributes no text - OCR can only ever ADD a text layer where none existed; it can never
 * turn a working image-only read into a failed request. One call per page image, in parallel, using
 * the exact same JPEG data URLs the vision call already receives (§2q.1c: confirmed live, no frontend
 * change needed).
 *
 * Position data (§2q.2's own question - "confirm what position data OCR returns and map it, or state
 * plainly it can't and what that costs"): confirmed live (this stage's diagnostic call on a synthetic
 * three-row document) that Mistral's OCR response gives BLOCK-level bounding boxes only - the entire
 * three-row table came back as ONE block. There is no per-word/per-token position data to map onto
 * `document-text-guard.ts`'s per-item x/y well enough to replicate its cross-ITEM split-thousands join
 * (`extractedNumbers`, document-text-guard.ts:106-113), which requires two items sharing an identical
 * rounded y. Stated plainly rather than invented: every item below carries x:0,y:0 (page-scoped, never
 * compared across pages or against a pdf.js-produced item's own coordinate space, which uses a
 * different origin and axis direction entirely) - the cross-item join never fires for OCR-sourced
 * text. The cost is small in practice, not zero in theory: `extractPrintedNumbers` (number-parser.ts)
 * already recovers a split-thousands number from WITHIN one string (its own intra-string fallback,
 * unconditional, unrelated to the guard's cross-item join) - and OCR reconstructs continuous, readable
 * markdown rather than pdf.js's per-glyph-run text items, so a number like "1 234,56" reaches this
 * function as part of ONE page's whole markdown string, never split across two separate items to begin
 * with. This is exactly why this function returns ONE DocumentTextItem per PAGE (the page's entire
 * markdown), not one per block or per line: splitting further would only risk introducing an artificial
 * item boundary through the middle of a number that the guard was never built to rejoin, for a
 * granularity OCR does not actually provide anyway.
 */
export async function buildOcrTextLayer(imageDataUrls: string[]): Promise<DocumentTextItem[]> {
  if (!isOcrConfigured()) return [];
  const pages = await Promise.all(
    imageDataUrls.map(async (url) => {
      try {
        return await callMistralOcrPage(url);
      } catch {
        return null;
      }
    }),
  );
  const items: DocumentTextItem[] = [];
  pages.forEach((markdown, index) => {
    if (markdown !== null) items.push({ page: index + 1, text: markdown, x: 0, y: 0 });
  });
  return items;
}
