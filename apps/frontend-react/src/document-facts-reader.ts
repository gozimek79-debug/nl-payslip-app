import type { DocumentSource } from './local-ocr.ts';
import { planDocumentBatches } from './document-batches.ts';

/**
 * P2 document reading as ONE small adapter (extracted from ProDocuments.tsx for R3-B, behaviour unchanged): a file
 * becomes the fact batches the existing `/api/pro/{payslip|contract}-facts` reader routes return. Its pages are
 * planned into batches (document-batches.ts - text-layer documents from their page-indexed text, scans and photos
 * from page images), each batch is one reader call, and every page is either read or reported as not read. A failed
 * batch does not discard the others: its pages are reported, the rest are used. Nothing here decides what the facts
 * mean - the Payroll Profile does that, on the server.
 *
 * The browser-only pieces (pdf.js / canvas rendering in local-ocr.ts, and the network) are injected, so the same
 * code runs in the node test runner with stubs. Both the existing PRO flow and the R3-B conversation use it.
 */

export type FactReaderKind = 'payslip' | 'contract';

export interface DocumentReaderDeps {
  readSource: (file: File) => Promise<DocumentSource>;
  renderImages: (file: File, hasTextLayer: boolean, pages: number[]) => Promise<{ images: string[] }>;
  photo: (file: File) => Promise<{ image: string }>;
  fetchImpl: typeof fetch;
}

export interface DocumentCoverage {
  totalPages: number;
  notProcessedPages: number[];
  reason: 'document_too_long' | 'batch_failed' | null;
}

export type DocumentReadOutcome =
  | { status: 'done'; factBatches: unknown[]; coverage: DocumentCoverage }
  /** No batch was read. `errorCode` is the reader route's own last `error_code` (undefined: network / parse failure). */
  | { status: 'error'; errorCode: string | undefined };

/** The real browser dependencies: local-ocr.ts's own readers, and `fetch` called on the window (never unbound). */
export function browserReaderDeps(ocr: Pick<typeof import('./local-ocr.ts'), 'readDocumentSource' | 'renderPageImages' | 'photoWithinBudget'>): DocumentReaderDeps {
  return {
    readSource: (file) => ocr.readDocumentSource(file),
    renderImages: (file, hasTextLayer, pages) => ocr.renderPageImages(file, hasTextLayer, pages),
    photo: (file) => ocr.photoWithinBudget(file),
    fetchImpl: (input, init) => fetch(input, init),
  };
}

/** Throws only when the file itself cannot be opened (`readSource`) - the caller reports that as a read error. */
export async function readDocumentFacts(file: File, kind: FactReaderKind, deps: DocumentReaderDeps): Promise<DocumentReadOutcome> {
  const source = await deps.readSource(file);
  const plan = planDocumentBatches(source);
  const hasTextLayer = plan.mode === 'text';
  const factBatches: unknown[] = [];
  const failedPages: number[] = [];
  let lastError: string | undefined;
  for (const batch of plan.batches) {
    try {
      const images = batch.imagePages.length === 0 ? []
        : source.isPdf ? (await deps.renderImages(file, hasTextLayer, batch.imagePages)).images
          : [(await deps.photo(file)).image];
      const textLines = source.lines.filter((l) => batch.pages.includes(l.page));
      const res = await deps.fetchImpl(`/api/pro/${kind}-facts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages: batch.pages, totalPages: source.pageCount, images, imagePages: batch.imagePages, textLines }),
      });
      const data = await res.json() as { batch?: unknown; error_code?: string };
      if (!res.ok || !data.batch) { failedPages.push(...batch.pages); lastError = data.error_code; continue; }
      factBatches.push(data.batch);
    } catch {
      failedPages.push(...batch.pages);
    }
  }
  if (factBatches.length === 0) return { status: 'error', errorCode: lastError };
  const notProcessedPages = [...plan.notProcessedPages, ...failedPages].sort((x, y) => x - y);
  return {
    status: 'done',
    factBatches,
    coverage: { totalPages: source.pageCount, notProcessedPages, reason: failedPages.length > 0 ? 'batch_failed' : plan.notProcessedReason },
  };
}
