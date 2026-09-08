import { createWorker } from 'tesseract.js';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

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
