/**
 * Stage 2j (audit v30, §2j.3): the render-step DECISION logic, pulled out of `local-ocr.ts` into its
 * own dependency-free module - no DOM, no `pdfjs-dist`, no canvas. `local-ocr.ts` needs a real browser
 * to actually rasterise a page (`document.createElement('canvas')`, `page.render(...)`), which is why
 * this project has never had a frontend test runner at all; this ONE piece - which step(s) a given
 * `hasTextLayer` resolves to - has no such dependency and is exactly the fact the reviewer's 2j.3 asks
 * to be confirmed "with a test, not a comment": that a text-layer-present upload never touches the
 * image-only ladder's high step. `local-ocr.ts` imports `selectRenderSteps` from here and calls it,
 * rather than re-deciding the same thing inline - the tested logic and the real runtime logic are the
 * SAME code path, not a parallel reimplementation that could drift.
 */
export interface RenderStep {
  name: string;
  scale: number;
  format: 'image/jpeg';
  quality: number;
}

/** Stage 2i (§2i.0d): "when a text layer is found... the lower setting is fine." Used ONLY while the
 * text layer is still trusted at upload time - see local-ocr.ts's own doc comment on the 2j.3 gap this
 * step can fall into if the server later rejects that same text layer. */
export const TEXT_LAYER_STEP: RenderStep = { name: 'text-layer-present', scale: 1.5, format: 'image/jpeg', quality: 0.9 };

/** Stage 2i (§2i.0d): highest quality first, stepping down only as far as needed to stay under
 * `TARGET_MAX_BYTES`. See local-ocr.ts's own doc comment for the measured byte-size reasoning. */
export const IMAGE_ONLY_STEPS: RenderStep[] = [
  { name: 'image-high', scale: 2, format: 'image/jpeg', quality: 0.92 },
  { name: 'image-medium', scale: 2, format: 'image/jpeg', quality: 0.75 },
  { name: 'image-low', scale: 1.5, format: 'image/jpeg', quality: 0.75 },
  { name: 'image-floor', scale: 1, format: 'image/jpeg', quality: 0.6 },
];

/** Stage 2h (§2h.5)/2i (§2i.0d): a margin under Vercel's 4.5 MB function request-body limit. */
export const TARGET_MAX_BYTES = 3.5 * 1024 * 1024;

/**
 * The one decision point: whether this upload uses the fixed, single text-layer step, or the adaptive,
 * measured image-only ladder. `usesImageLadder: false` means exactly one step (`TEXT_LAYER_STEP`) is
 * ever tried - the image-only steps, including `image-high`, are never reached in that case.
 */
export function selectRenderSteps(hasTextLayer: boolean): { usesImageLadder: boolean; steps: RenderStep[] } {
  return hasTextLayer ? { usesImageLadder: false, steps: [TEXT_LAYER_STEP] } : { usesImageLadder: true, steps: IMAGE_ONLY_STEPS };
}
