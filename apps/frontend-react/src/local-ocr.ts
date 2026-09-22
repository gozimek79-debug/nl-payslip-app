import { createWorker } from 'tesseract.js';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { TEXT_LAYER_STEP, TARGET_MAX_BYTES, selectRenderSteps, type RenderStep } from './render-step-policy.ts';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

/** Stage 2g (audit v27, §2g.1): "read the PDF's own text layer first... if the PDF has no usable text
 * layer (nothing, or fewer than a small number of items, chosen and labelled in the code), send
 * images only, exactly as today." A scanned PDF's `getTextContent()` typically returns nothing or a
 * handful of stray items (a header/footer that happens to be real text on an otherwise-scanned page);
 * a real payslip's own text layer, when one exists, has dozens of items (every hour/deduction line,
 * label and amount is its own item). 10 is a chosen threshold, not derived from a measurement - the
 * gap between "a scan with a few incidental text items" and "an actual text-based document" is wide
 * enough that the exact number is not load-bearing. */
const MIN_TEXT_ITEMS_FOR_USABLE_LAYER = 10;

export interface DocumentTextItem {
  page: number;
  text: string;
  x: number;
  y: number;
}

export type OcrFields = {
  hours: number;
  hourlyRate: number;
  grossBase: number;
  additions: number;
  deductions: number;
  netPaid: number;
};

export type OcrResult = { fields: OcrFields; confidence: number; rawText: string; previewImageBase64: string };

function parseDutchNumber(value?: string): number {
  if (!value) return 0;
  const compact = value.replace(/\s/g, '').replace(/€/g, '');
  const normalized = compact.includes(',')
    ? compact.replace(/\./g, '').replace(',', '.')
    : compact;
  const number = Number.parseFloat(normalized.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function findAmount(text: string, labels: string[]): number {
  for (const label of labels) {
    const expression = new RegExp(`${label}[^\\d-]{0,24}(-?\\d[\\d., ]*)`, 'i');
    const match = text.match(expression);
    if (match?.[1]) return parseDutchNumber(match[1]);
  }
  return 0;
}

function mapTextToFields(text: string): OcrFields {
  return {
    hours: findAmount(text, ['gewerkte uren', 'normale uren', 'uren totaal', 'uren']),
    hourlyRate: findAmount(text, ['uurloon', 'uurtarief', 'basisloon per uur']),
    grossBase: findAmount(text, ['brutoloon', 'bruto loon', 'totaal bruto']),
    additions: findAmount(text, ['netto vergoedingen', 'netto toevoegingen', 'reiskosten', 'etk']),
    deductions: findAmount(text, ['netto inhoudingen', 'inhoudingen totaal', 'totaal inhouding']),
    netPaid: findAmount(text, ['te betalen', 'nettoloon', 'netto loon', 'uit te betalen']),
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Nie udało się przygotować podglądu dokumentu.'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Stage 2h (audit v28, §2h.5): measured a real request body for a three-page A4 PDF (`body-size-
 * proto*.mjs`, Node + pdf-lib + pdfjs-dist legacy build + `@napi-rs/canvas`): the OLD settings (scale
 * 2, PNG) cost ~0.48 MB for a dense TEXT-based synthetic fixture but ~11.5 MB for a worst-case
 * "scanned/photographed" one - more than double Vercel's documented 4.5 MB function request-body
 * limit. scale 1.5 + JPEG quality 0.9 measured at ~3.08 MB for that SAME worst-case fixture.
 *
 * Stage 2i (audit v29, §2i.0d): "replace the fixed scale 1.5 JPEG 0.9. When a text layer is found
 * (the images only give layout) the lower setting is fine. When there is no text layer the image is
 * the only source: start at scale 2, high quality, and step down (quality, then scale) only as far as
 * needed to keep the whole request under the documented limit with margin (measure blobs before
 * sending)." The reviewer's own MAJOR finding (T3/RAPORT-cursor-2h.md): the fixed low setting applied
 * to EVERY page, including the only source for a scan, with no adaptation and unverified legibility.
 *
 * `TARGET_MAX_BYTES` (3.5 MB, CHOSEN): a margin under Vercel's 4.5 MB limit, leaving headroom for the
 * JSON envelope and any `documentText` - the same margin philosophy 2h.5's own single fixed setting
 * used (3.08 MB measured against a 4.5 MB limit).
 *
 * Legibility statement, unchanged from 2h.5 and restated here rather than claimed as fixed: this
 * module cannot verify how any of these settings actually look in a real browser on a real scan -
 * only relative byte-size measurements were possible in this environment. `render_step` is reported
 * in the technical-details line specifically so a real upload's actual step is visible and checkable,
 * not asserted as "good enough" from here.
 *
 * Stage 2j (audit v30, §2j.3): "confirm explicitly (with a test, not a comment) that a text-layer-
 * present upload never needs the image ladder's high step... say plainly whether an upload that falls
 * back to image-only mid-request is stuck with the lower, pre-chosen quality." It is: `hasTextLayer`
 * is decided from the CLIENT's own local `extractTextItems` read, before anything is sent - the images
 * are rendered and fixed at `TEXT_LAYER_STEP` (moderate quality) at that point. The SERVER's own
 * `assessTextLayer` (tier-c.controller.ts) can independently decide, after receiving both, that the
 * text layer does not verify well enough and fall back to `reading_basis: 'image_only'` - but by then
 * the images already sent are the ones the client chose assuming the text layer WOULD help. There is
 * no way to "un-send" a higher-quality render after the fact within a single request. Re-architecting
 * this into two round-trips (client sends `documentText` first, server decides which quality to
 * request, client renders and sends images second) is a real fix but a genuinely bigger change than
 * this stage's own scope (§2j: "not in this stage: the image reader itself") - ACCEPTED for this round
 * as a stated limitation rather than rebuilt: the fallback path keeps the lower, pre-chosen quality,
 * and `tier-c.controller.ts`/`TierCFlow.tsx` say so explicitly on the technical-details line whenever
 * `render_step === 'text-layer-present'` AND the server's own `text_layer_status` is `'mismatch'` -
 * exactly the "stuck" case - so it is visible, never silent. The step-selection decision itself
 * (`selectRenderSteps`, `render-step-policy.ts`) is proven never to reach the image ladder's own high
 * step while `hasTextLayer` is true by `render-step-policy.test.ts`, run under plain Node (no DOM
 * needed for that one fact, unlike the actual rendering below).
 */
async function renderPageAtStep(page: Awaited<ReturnType<Awaited<ReturnType<typeof getDocument>['promise']>['getPage']>>, step: RenderStep): Promise<Blob> {
  const viewport = page.getViewport({ scale: step.scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('Przeglądarka nie może przygotować strony PDF.');
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((output) => (output ? resolve(output) : reject(new Error('Nie udało się przetworzyć PDF.'))), step.format, step.quality);
  });
}

/** Legacy path (the unused `recognizePayslip`/tesseract flow) - kept at the same fixed, moderate
 * setting it always used; not part of the adaptive budget below, and not this stage's scope. */
async function pdfPages(file: File): Promise<Blob[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data: bytes }).promise;
  const pages: Blob[] = [];
  const pageCount = Math.min(pdf.numPages, 3);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    pages.push(await renderPageAtStep(page, TEXT_LAYER_STEP));
  }
  return pages;
}

/**
 * Stage 2i (§2i.0d): renders all pages (max 3) of a PDF, adapting the render settings to whether a
 * text layer was found. With a text layer, images are only a layout aid for the model - the fixed,
 * already-small setting is used once, no measuring needed. Without one, images are the ONLY source of
 * truth: starts at the highest-quality step and measures the real combined blob size before accepting
 * it, stepping down (quality first, then scale) until the total fits under `TARGET_MAX_BYTES` or the
 * step list is exhausted (the floor is used regardless, rather than failing the upload outright).
 */
async function renderPdfPages(file: File, hasTextLayer: boolean): Promise<{ blobs: Blob[]; renderStep: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data: bytes }).promise;
  const pageCount = Math.min(pdf.numPages, 3);
  const pages = await Promise.all(Array.from({ length: pageCount }, (_, i) => pdf.getPage(i + 1)));

  // Stage 2j (§2j.3): the SAME decision `render-step-policy.test.ts` exercises under plain Node - never
  // a second, inline re-derivation of "which step(s) apply" that could drift from what was tested.
  const { usesImageLadder, steps } = selectRenderSteps(hasTextLayer);
  if (!usesImageLadder) {
    const step = steps[0] as RenderStep;
    const blobs = await Promise.all(pages.map((page) => renderPageAtStep(page, step)));
    return { blobs, renderStep: step.name };
  }

  let lastBlobs: Blob[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]!;
    const blobs = await Promise.all(pages.map((page) => renderPageAtStep(page, step)));
    lastBlobs = blobs;
    const totalBytes = blobs.reduce((sum, b) => sum + b.size, 0);
    const isLastStep = i === steps.length - 1;
    if (totalBytes <= TARGET_MAX_BYTES || isLastStep) {
      return { blobs, renderStep: step.name };
    }
  }
  return { blobs: lastBlobs, renderStep: steps[steps.length - 1]!.name };
}

/** Renderuje wszystkie strony dokumentu (maks. 3) jako obrazy base64 — do wysłania
 * do modelu wizyjnego AI, bez lokalnego OCR (AI samo odczytuje całą treść).
 *
 * Stage 2i (§2i.0d): `hasTextLayer` picks the fixed low-cost setting or the adaptive, measured one -
 * see `renderPdfPages`. `renderStep` is returned so the caller can report it on the technical line. */
export async function renderPageImages(file: File, hasTextLayer: boolean): Promise<{ images: string[]; renderStep: string }> {
  if (file.type !== 'application/pdf') {
    return { images: [await blobToBase64(file)], renderStep: 'non-pdf' };
  }
  const { blobs, renderStep } = await renderPdfPages(file, hasTextLayer);
  const images = await Promise.all(blobs.map((blob) => blobToBase64(blob)));
  return { images, renderStep };
}

/**
 * Stage 2g (§2g.1): reads the PDF's own embedded text layer via `page.getTextContent()`, on the same
 * pages `pdfPages` above rasterises for the vision call - never a different page range, so the two
 * never disagree about which pages exist. A plain image upload (JPG/PNG) has no text layer at all and
 * always returns `[]`. `2g.4`'s "amount-like items the model did not use" and `2g.3`'s verbatim guard
 * both depend on this being complete, not a best-effort sample - every text item on the read pages is
 * included, positions rounded to whole points (no sub-pixel precision needed for a consistency check).
 */
export async function extractTextItems(file: File): Promise<DocumentTextItem[]> {
  if (file.type !== 'application/pdf') return [];
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data: bytes }).promise;
  const pageCount = Math.min(pdf.numPages, 3);
  const items: DocumentTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    for (const raw of textContent.items) {
      if (!('str' in raw) || typeof raw.str !== 'string') continue;
      const item = raw as TextItem;
      const text = item.str.trim();
      if (text === '') continue;
      const x = Math.round(item.transform[4] ?? 0);
      const y = Math.round(item.transform[5] ?? 0);
      items.push({ page: pageNumber, text, x, y });
    }
  }
  return items.length >= MIN_TEXT_ITEMS_FOR_USABLE_LAYER ? items : [];
}

export async function recognizePayslip(file: File, onProgress: (progress: number) => void): Promise<OcrResult> {
  const images = file.type === 'application/pdf' ? await pdfPages(file) : [file];
  const worker = await createWorker(['nld', 'eng'], undefined, {
    logger: (message) => {
      if (message.status === 'recognizing text') onProgress(Math.round(message.progress * 100));
    },
  });

  try {
    const texts: string[] = [];
    const confidences: number[] = [];
    for (const image of images) {
      const result = await worker.recognize(image);
      texts.push(result.data.text);
      confidences.push(result.data.confidence);
    }
    const rawText = texts.join('\n');
    const confidence = confidences.length
      ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length)
      : 0;
    const previewImageBase64 = await blobToBase64(images[0]!);
    return { fields: mapTextToFields(rawText), confidence, rawText, previewImageBase64 };
  } finally {
    await worker.terminate();
  }
}
