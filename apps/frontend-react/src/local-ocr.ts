import { createWorker } from 'tesseract.js';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

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

async function pdfPages(file: File): Promise<Blob[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocument({ data: bytes }).promise;
  const pages: Blob[] = [];
  const pageCount = Math.min(pdf.numPages, 3);

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Przeglądarka nie może przygotować strony PDF.');
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((output) => output ? resolve(output) : reject(new Error('Nie udało się przetworzyć PDF.')), 'image/png');
    });
    pages.push(blob);
  }
  return pages;
}

/** Renderuje wszystkie strony dokumentu (maks. 3) jako obrazy base64 — do wysłania
 * do modelu wizyjnego AI, bez lokalnego OCR (AI samo odczytuje całą treść). */
export async function renderPageImages(file: File): Promise<string[]> {
  const images = file.type === 'application/pdf' ? await pdfPages(file) : [file];
  return Promise.all(images.map((image) => blobToBase64(image)));
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
