import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { known, type PayslipPeriod, type HourLine, type PreTaxDeduction } from './payslip-model.js';
import { verifyAmountsAgainstText, findUnusedPrintedAmounts, textLayerVerificationCounts, type DocumentTextItem } from './document-text-guard.js';

/**
 * Stage 2g (audit v27, §2g.6): "generate synthetic PDFs inside the test... no names, no employer, no
 * BSN, no original layout." Rows below are a plain two-column table (label, printed amount) - nothing
 * from the real Olympia document beyond the FOUR NUMBERS the assignment itself names as evidence
 * (699,78 / 58,31 / 34,79 / the 699.75 computation trap), which are also independently in
 * FIXTURES-paski-referencyjne.md.
 *
 * `pdf-lib` (already a devDependency after this stage) writes the PDF; `pdfjs-dist` (already a
 * dependency of the frontend, added here as a backend devDependency so this test can exercise the
 * SAME text-extraction call the frontend's `local-ocr.ts extractTextItems` makes) reads it back. Node
 * needs pdfjs-dist's `legacy/build/pdf.mjs` entry point, not the default `pdfjs-dist` import the
 * frontend uses via its bundler+worker - confirmed by trial: importing plain `pdfjs-dist` in Node
 * throws `hashOriginal.toHex is not a function` reading this exact PDF, `legacy/build/pdf.mjs` reads
 * it cleanly. This means these tests prove pdf.js's `getTextContent()` extracts the right strings and
 * positions from a real PDF byte stream - the same primitive the frontend calls - but do NOT execute
 * `local-ocr.ts` itself (a browser worker + `File` API environment, which this Node test process does
 * not have and no test runner in this repo currently provides for the frontend). Said plainly in the
 * report per the assignment's own instruction.
 */

interface Row { label: string; amount: string; }

async function buildSyntheticPayslipPdf(rows: Row[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 700]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 650;
  for (const row of rows) {
    page.drawText(row.label, { x: 50, y, size: 10, font });
    page.drawText(row.amount, { x: 300, y, size: 10, font });
    y -= 20;
  }
  return doc.save();
}

/** Mirrors `local-ocr.ts`'s `extractTextItems` mapping (rounded x/y, trimmed non-empty strings) but
 * calls pdfjs-dist's Node-compatible legacy entry point instead of the browser worker one. */
async function extractPdfTextItems(bytes: Uint8Array): Promise<DocumentTextItem[]> {
  const pdf = await getDocument({ data: bytes }).promise;
  const items: DocumentTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const raw of content.items) {
      if (!('str' in raw) || typeof raw.str !== 'string') continue;
      const text = raw.str.trim();
      if (text === '') continue;
      items.push({ page: pageNumber, text, x: Math.round(raw.transform[4] ?? 0), y: Math.round(raw.transform[5] ?? 0) });
    }
  }
  return items;
}

const LOON_NORMAAL_ROW: Row = { label: 'Loon normaal', amount: '699,78' };
const LOON_ONREGELM_ROW: Row = { label: 'Loon onregelm. uren 50%', amount: '58,31' };
const STIPP_ROW: Row = { label: 'STIPP-pensioen werknemer', amount: '34,79' };

function hourLine(overrides: Partial<HourLine>): HourLine {
  return {
    employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null,
    amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true,
    ...overrides,
  };
}

function stippDeduction(amount: number): PreTaxDeduction {
  return { category: 'pension', description: 'STIPP-pensioen werknemer', amount: known(amount, 'payslip_extracted'), base: null, percent: null };
}

function basePeriod(overrides: Partial<PayslipPeriod>): PayslipPeriod {
  return {
    period_label: null,
    period_type: 'week',
    period_type_confirmed: true,
    period_end_date: null,
    is_correction: false,
    version: 1,
    employers: [{ name: null, franchise_bearing: 'unknown' }],
    hirer: null,
    contract_hours: null,
    hour_lines: [],
    pre_tax_deductions: [],
    bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
    et: null,
    post_tax_social: [],
    net_additions: [],
    net_deductions: [],
    payout_adjustments: [],
    reservations: [],
    wml_printed: null,
    wml_applicable: null,
    printed_table_tax: null,
    printed_bt_tax: null,
    printed_algemene_heffingskorting: null,
    printed_arbeidskorting: null,
    printed_net: null,
    printed_payout: null,
    printed_gross_total: null,
    printed_loon_voor_heffingen: null,
    printed_table_tax_label: null,
    printed_bt_tax_label: null,
    printed_algemene_heffingskorting_label: null,
    printed_arbeidskorting_label: null,
    printed_net_label: null,
    printed_payout_label: null,
    ...overrides,
  };
}

test('2g.6: text-layer extraction from a synthetic PDF returns the exact printed strings', async () => {
  const bytes = await buildSyntheticPayslipPdf([LOON_NORMAAL_ROW, LOON_ONREGELM_ROW, STIPP_ROW]);
  const items = await extractPdfTextItems(bytes);
  const texts = items.map((i) => i.text);
  assert.ok(texts.includes('699,78'), `expected '699,78' among extracted items, got: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('58,31'), `expected '58,31' among extracted items, got: ${JSON.stringify(texts)}`);
  assert.ok(texts.includes('34,79'), `expected '34,79' among extracted items, got: ${JSON.stringify(texts)}`);
});

test('2g.6: the guard accepts a correct read of StiPP 34.79 against the synthetic text layer', async () => {
  const bytes = await buildSyntheticPayslipPdf([STIPP_ROW]);
  const items = await extractPdfTextItems(bytes);
  const period = basePeriod({ pre_tax_deductions: [stippDeduction(34.79)] });
  const unverified = verifyAmountsAgainstText(period, items);
  assert.deepEqual(unverified, []);
});

test('2g.6: the guard rejects the same PDF when the model reads StiPP one digit wrong (34.89 instead of 34.79)', async () => {
  const bytes = await buildSyntheticPayslipPdf([STIPP_ROW]);
  const items = await extractPdfTextItems(bytes);
  const period = basePeriod({ pre_tax_deductions: [stippDeduction(34.89)] });
  const unverified = verifyAmountsAgainstText(period, items);
  assert.deepEqual(unverified, ['pre_tax_deductions[0].amount']);
});

test('2g.6: 699.75 (45 x 15.55, computed) is rejected against a text layer that prints 699.78', async () => {
  const bytes = await buildSyntheticPayslipPdf([LOON_NORMAAL_ROW]);
  const items = await extractPdfTextItems(bytes);
  assert.equal(45 * 15.55, 699.75, 'sanity: the raw multiplication really does land on .75, not .78');
  const period = basePeriod({ hour_lines: [hourLine({ amount: 699.75 })] });
  const unverified = verifyAmountsAgainstText(period, items);
  assert.deepEqual(unverified, ['hour_lines[0].amount']);
});

test('2g.6: an unused printed amount (58.31) is listed when the model never returns that line', async () => {
  const bytes = await buildSyntheticPayslipPdf([LOON_NORMAAL_ROW, LOON_ONREGELM_ROW, STIPP_ROW]);
  const items = await extractPdfTextItems(bytes);
  // Model returned Loon normaal and StiPP, but silently dropped the 58.31 line - the exact failure
  // mode the owner's three live reads reproduced.
  const period = basePeriod({
    hour_lines: [hourLine({ amount: 699.78 })],
    pre_tax_deductions: [stippDeduction(34.79)],
  });
  const unused = findUnusedPrintedAmounts(period, items);
  assert.ok(unused.includes(58.31), `expected 58.31 among unused amounts, got: ${JSON.stringify(unused)}`);
});

test('2h.1 re-run of the 2g.4 measurement: a merged label+hours+rate+amount run now leaves the SAME 2 unused items a separate-cell layout does', async () => {
  // Stage 2g's parser only ever tried a whole text item as one number, so "Loon normaal 45,00 x
  // 15,55" (one merged item) contributed nothing at all - the 2g.4 measurement on this exact fixture
  // was 0. Stage 2h's tokeniser (§2h.1) now recovers 45 and 15.55 out of that same merged run too,
  // so this fixture's real, re-measured count is 2, not 0 - matching the cell-per-layout fixture
  // below exactly. Reported as the new, checked number (§2h.1: "report the new unused counts for
  // both layouts"), not assumed unchanged from stage 2g.
  const bytes = await buildSyntheticPayslipPdf([
    { label: 'Loon normaal 45,00 x 15,55', amount: '699,78' },
    LOON_ONREGELM_ROW,
    STIPP_ROW,
  ]);
  const items = await extractPdfTextItems(bytes);
  const period = basePeriod({
    hour_lines: [hourLine({ amount: 699.78 }), hourLine({ description: 'Loon onregelm. uren 50%', hours: 7.5, rate: 15.55, percent: 50, category: 'irregular_surcharge', amount: 58.31 })],
    pre_tax_deductions: [stippDeduction(34.79)],
  });
  const unused = findUnusedPrintedAmounts(period, items);
  assert.equal(unused.length, 2, `expected the re-measured count to match this fixture; got ${unused.length} unused: ${JSON.stringify(unused)}`);
  assert.ok(unused.includes(45), `expected the hours figure (45) among unused, got: ${JSON.stringify(unused)}`);
  assert.ok(unused.includes(15.55), `expected the rate figure (15.55) among unused, got: ${JSON.stringify(unused)}`);
});

test('2g.4 measurement: a layout that prints hours and rate as their own table cells leaves those as unused amount-like items', async () => {
  const bytes = await buildSyntheticPayslipPdf([
    { label: 'Loon normaal', amount: '45,00' },
    { label: '', amount: '15,55' },
    { label: '', amount: '699,78' },
    STIPP_ROW,
  ]);
  const items = await extractPdfTextItems(bytes);
  const period = basePeriod({
    hour_lines: [hourLine({ amount: 699.78 })],
    pre_tax_deductions: [stippDeduction(34.79)],
  });
  const unused = findUnusedPrintedAmounts(period, items);
  // 45,00 (hours) and 15,55 (rate) are amount-like and genuinely unused by collectPeriodAmounts -
  // this is the honest, non-zero measurement for a cell-per-value layout, reported as such.
  assert.equal(unused.length, 2, `expected exactly the hours and rate cells to be unused; got: ${JSON.stringify(unused)}`);
  assert.ok(unused.includes(45.0));
  assert.ok(unused.includes(15.55));
});

/**
 * Stage 2h (audit v28, §2h.7): "extend the synthetic-PDF tests: one PDF in which the label and the
 * amount are drawn as ONE text run, one with a trailing EUR, one with a thousands amount printed with
 * spaces, and one dense three-page document with more than 500 items." Each row here is drawn as a
 * SINGLE `drawText` call (unlike `buildSyntheticPayslipPdf`'s two-column layout), so pdf.js hands back
 * exactly one text item per row - the real-producer shape the reviewer's T1(a) matrix named.
 */
async function buildOneRunPerLinePdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 700]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 650;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 10, font });
    y -= 20;
  }
  return doc.save();
}

test('2h.7: a merged single text run ("Loon normaal 699,78") verifies correctly - the reviewer\'s exact T1(a) failure case', async () => {
  const bytes = await buildOneRunPerLinePdf(['Loon normaal 699,78', 'STIPP-pensioen werknemer 34,79']);
  const items = await extractPdfTextItems(bytes);
  const period = basePeriod({ hour_lines: [hourLine({ amount: 699.78 })], pre_tax_deductions: [stippDeduction(34.79)] });
  assert.deepEqual(verifyAmountsAgainstText(period, items), [], 'expected both merged-run amounts to verify');
});

test('2h.7: a trailing currency code ("699,78 EUR") in one text run verifies correctly', async () => {
  const bytes = await buildOneRunPerLinePdf(['Loon normaal 699,78 EUR']);
  const items = await extractPdfTextItems(bytes);
  const period = basePeriod({ hour_lines: [hourLine({ amount: 699.78 })] });
  assert.deepEqual(verifyAmountsAgainstText(period, items), []);
});

test('2h.7: a thousands amount printed with spaces ("1 234,56") in one text run verifies correctly', async () => {
  const bytes = await buildOneRunPerLinePdf(['Jaarloon bijzonder tarief 1 234,56']);
  const items = await extractPdfTextItems(bytes);
  const period = basePeriod({ printed_gross_total: 1234.56 });
  assert.deepEqual(verifyAmountsAgainstText(period, items), []);
});

test('2h.7: 699.75 (45 x 15.55, computed) is still rejected even when the printed 699,78 sits inside a merged single text run', async () => {
  const bytes = await buildOneRunPerLinePdf(['Loon normaal 45,00 x 15,55 699,78']);
  const items = await extractPdfTextItems(bytes);
  const period = basePeriod({ hour_lines: [hourLine({ amount: 699.75 })] });
  assert.deepEqual(verifyAmountsAgainstText(period, items), ['hour_lines[0].amount']);
});

/**
 * Stage 2h (§2h.7): "one dense three-page document with more than 500 items... assert... the dense
 * document is either verified in full or falls back explicitly, and that nothing is truncated."
 * `document-text-guard.ts` itself has no cap or truncation at all (only `tier-c.controller.ts`'s
 * `sanitizeDocumentText` does, exercised separately at the HTTP level in
 * `tier-c.controller.test.ts`'s "2h.2" tests, including the exact >3000-item too_large case) - this
 * test proves the GUARD's own functions process every single item pdf.js returns for a genuinely
 * dense three-page document, with nothing silently dropped in between.
 */
async function buildDenseThreePagePdf(rowsPerPage: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const page = doc.addPage([400, 900]);
    let y = 860;
    for (let row = 0; row < rowsPerPage; row += 1) {
      page.drawText(`Regel ${pageIndex}-${row}`, { x: 30, y, size: 6, font });
      page.drawText('45,00', { x: 200, y, size: 6, font });
      page.drawText('15,55', { x: 260, y, size: 6, font });
      page.drawText('1,23', { x: 320, y, size: 6, font });
      y -= 7;
    }
  }
  return doc.save();
}

test('2h.7: a dense three-page document (>500 items) is processed in full by the guard - nothing truncated', async () => {
  const rowsPerPage = 60; // 4 items/row x 60 rows x 3 pages = 720 items, comfortably over 500
  const bytes = await buildDenseThreePagePdf(rowsPerPage);
  const items = await extractPdfTextItems(bytes);
  assert.ok(items.length > 500, `expected more than 500 text items, got ${items.length}`);

  // A period that correctly reads every row's amount (1,23) and rate (15,55), but never returns the
  // "45,00" hours figure as an amount at all (collectPeriodAmounts never counts an hours field) -
  // exactly 2h.4's own "rates/hours also print numbers" case, now measured on a genuinely dense
  // document instead of a 3-row toy one.
  const period = basePeriod({ hour_lines: Array.from({ length: rowsPerPage * 3 }, () => hourLine({ amount: 1.23 })) });
  const { checked, unverified } = textLayerVerificationCounts(period, items);
  assert.equal(checked, rowsPerPage * 3, 'expected the guard to check every single hour_line, none dropped');
  assert.equal(unverified, 0, 'expected every one of the 1,23 amounts to verify against the dense text layer');

  // "verified in full, or falls back explicitly" - this fixture verifies in full (checked>0,
  // unverified===0, well under the 2h.2 mismatch threshold); the explicit-fallback side of that same
  // guarantee is covered by tier-c.controller.test.ts's "2h.2" HTTP tests.
  const mismatchRatio = checked > 0 ? unverified / checked : 0;
  assert.ok(mismatchRatio < 0.5, 'expected this correct, dense read to stay well under the mismatch threshold');

  // Nothing truncated: the rate (15,55) and hours (45,00) columns, present on EVERY one of the
  // (rowsPerPage * 3) rows, must all still appear as unused candidates - not just the first few before
  // some accidental cutoff.
  const unused = findUnusedPrintedAmounts(period, items);
  const unusedRateCount = unused.filter((v) => v === 15.55).length;
  const unusedHoursCount = unused.filter((v) => v === 45).length;
  assert.equal(unusedRateCount, rowsPerPage * 3, `expected the rate figure on every row to be counted as unused, got ${unusedRateCount} of ${rowsPerPage * 3}`);
  assert.equal(unusedHoursCount, rowsPerPage * 3, `expected the hours figure on every row to be counted as unused, got ${unusedHoursCount} of ${rowsPerPage * 3}`);
});

/**
 * Stage 2h (§2h.7, closing instruction): "state again what these tests cannot show; only a real
 * document uploaded by the owner can." Unchanged from 2g.6's own statement, restated here because
 * this round's new fixtures are still synthetic: they exercise pdf.js's `getTextContent()` and this
 * file's own Node-compatible extraction helper (mirroring, not calling, `local-ocr.ts`'s
 * `extractTextItems`), pdf-lib's own font embedding (clean, unsubsetted Helvetica), and every printed
 * FORM these tests hand-construct. They cannot show: font subsetting or unusual glyph encodings a
 * real-world PDF producer might use; a "PDF" that is actually a wrapped scan with no real text layer;
 * or whether a REAL dense payslip's actual column layout produces the same "rate/hours also count as
 * unused" shape this synthetic one does (a real document could merge/space its columns differently).
 * Only the owner's one real Olympia PDF upload (this stage's own "why") can close these gaps.
 */

