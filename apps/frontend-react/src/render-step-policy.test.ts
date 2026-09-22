import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRenderSteps, TEXT_LAYER_STEP, IMAGE_ONLY_STEPS } from './render-step-policy.ts';

/**
 * Stage 2j (audit v30, §2j.3): "confirm explicitly (with a test, not a comment) that a text-layer-
 * present upload never needs the image ladder's high step." This is the one fact in the whole render
 * pipeline that does not need a real browser to prove: `local-ocr.ts`'s actual canvas rendering
 * (`renderPageAtStep`) does need `document`/`canvas`/pdf.js's worker, which is why this project has no
 * frontend test runner otherwise - but the STEP SELECTION itself is pure data logic, and Node 24 runs
 * plain `.ts` test files directly (no build step, no new dependency), so this one piece can be proven
 * under `node --test`, same tooling the backend already uses.
 */

test('2j.3: hasTextLayer=true resolves to exactly the ONE fixed text-layer step - the image-only ladder, including image-high, is never touched', () => {
  const result = selectRenderSteps(true);
  assert.equal(result.usesImageLadder, false, 'expected the image ladder never to be selected when a text layer is present');
  assert.deepEqual(result.steps, [TEXT_LAYER_STEP]);
  assert.ok(!result.steps.includes(IMAGE_ONLY_STEPS[0]!), 'expected image-high (or any image-only step) to be absent');
});

test('2j.3: hasTextLayer=false resolves to the full image-only ladder, starting at the high step', () => {
  const result = selectRenderSteps(false);
  assert.equal(result.usesImageLadder, true);
  assert.deepEqual(result.steps, IMAGE_ONLY_STEPS);
  assert.equal(result.steps[0]!.name, 'image-high');
});

test('2j.3: the text-layer step and the image-only steps never share a step name - render_step alone always tells the two paths apart', () => {
  const imageOnlyNames = new Set(IMAGE_ONLY_STEPS.map((s) => s.name));
  assert.ok(!imageOnlyNames.has(TEXT_LAYER_STEP.name), `expected '${TEXT_LAYER_STEP.name}' to be distinct from every image-only step name`);
});
