/**
 * P2 (ZADANIE-P2-LOONTO-PRO.md §P2.8/§P2.9): how one PRO document is split into reader calls -
 * pure, DOM-free, testable with the plain `node --test` runner (same pattern as render-step-policy.ts).
 *
 * The old path rendered `Math.min(pdf.numPages, 3)` pages and silently ignored the rest. Now:
 *   - a document whose every page carries an embedded text layer is read from its page-indexed text,
 *     up to TEXT_PAGES_PER_BATCH pages per call. A THIN page (little text - a signature page, or a
 *     scanned page with only a printed header) is always sent as an image too, so nothing printed on
 *     it can be lost to the text-only path; at most IMAGE_PAGES_PER_BATCH images per call. A call of
 *     at most IMAGE_PAGES_PER_BATCH pages carries every page image as a layout aid;
 *   - anything else (a scan, a photo, a mixed document) is read from page images, IMAGE_PAGES_PER_BATCH
 *     pages per call - the measured budget under Vercel's 4.5 MB request-body limit - plus whatever
 *     text those pages do have;
 *   - every page up to MAX_PAGES_PER_DOCUMENT is covered by exactly one batch. Beyond that, the pages
 *     are NOT read and are returned by number with the reason `document_too_long`, so the interface
 *     says so - a document is never presented as fully read when it was not.
 * The server (pro-facts.controller.ts) enforces the same per-call limits.
 */

export const IMAGE_PAGES_PER_BATCH = 3;
export const TEXT_PAGES_PER_BATCH = 20;
export const MAX_PAGES_PER_DOCUMENT = 30;
/** A page with less embedded text than this is "thin": it is also sent as an image. */
export const THIN_PAGE_CHARS = 300;
/** Kept under the server's 200 000-character per-call cap. */
export const MAX_TEXT_CHARS_PER_BATCH = 180_000;

export interface PlanInput {
  pageCount: number;
  /** Embedded text items per page (index 0 = page 1). */
  itemsPerPage: number[];
  /** Characters of embedded text per page (index 0 = page 1). */
  charsPerPage: number[];
}

export interface DocumentBatch {
  /** 1-based pages this reader call covers. */
  pages: number[];
  /** Pages sent as images in this call (a subset of `pages`). */
  imagePages: number[];
}

export interface DocumentPlan {
  mode: 'text' | 'image';
  batches: DocumentBatch[];
  /** Pages no batch will read. */
  notProcessedPages: number[];
  notProcessedReason: 'document_too_long' | null;
}

export function planDocumentBatches(input: PlanInput): DocumentPlan {
  const total = Math.max(0, Math.floor(input.pageCount));
  const readable = Math.min(total, MAX_PAGES_PER_DOCUMENT);
  const pages = Array.from({ length: readable }, (_, i) => i + 1);
  const notProcessedPages = Array.from({ length: total - readable }, (_, i) => readable + i + 1);
  const notProcessedReason = notProcessedPages.length > 0 ? 'document_too_long' : null;
  // Text mode only when EVERY page has embedded text; one page without any sends the whole document
  // down the image path (a mixed scan/text document is never read text-only).
  const textMode = pages.length > 0 && pages.every((p) => (input.itemsPerPage[p - 1] ?? 0) > 0 && (input.charsPerPage[p - 1] ?? 0) > 0);
  const isThin = (p: number) => (input.charsPerPage[p - 1] ?? 0) < THIN_PAGE_CHARS;

  const batches: DocumentBatch[] = [];
  const close = (current: number[]) => {
    const imagePages = current.length <= IMAGE_PAGES_PER_BATCH ? [...current] : current.filter(isThin);
    batches.push({ pages: current, imagePages });
  };
  if (textMode) {
    let current: number[] = [];
    let chars = 0;
    for (const p of pages) {
      const pageChars = input.charsPerPage[p - 1] ?? 0;
      const thinInBatch = current.filter(isThin).length + (isThin(p) ? 1 : 0);
      const full = current.length >= TEXT_PAGES_PER_BATCH || chars + pageChars > MAX_TEXT_CHARS_PER_BATCH || (current.length >= IMAGE_PAGES_PER_BATCH && thinInBatch > IMAGE_PAGES_PER_BATCH);
      if (current.length > 0 && full) {
        close(current);
        current = [];
        chars = 0;
      }
      current.push(p);
      chars += pageChars;
    }
    if (current.length > 0) close(current);
  } else {
    for (let i = 0; i < pages.length; i += IMAGE_PAGES_PER_BATCH) {
      const chunk = pages.slice(i, i + IMAGE_PAGES_PER_BATCH);
      batches.push({ pages: chunk, imagePages: [...chunk] });
    }
  }
  return { mode: textMode ? 'text' : 'image', batches, notProcessedPages, notProcessedReason };
}
