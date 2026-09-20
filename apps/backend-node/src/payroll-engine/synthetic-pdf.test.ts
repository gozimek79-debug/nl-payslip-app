import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { known, type PayslipPeriod, type HourLine, type PreTaxDeduction } from './payslip-model.js';
import { verifyAmountsAgainstText, findUnusedPrintedAmounts, type DocumentTextItem } from './document-text-guard.js';

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

test('2g.4 measurement: how many unused text items remain after a fully correct read of a synthetic fixture', async () => {
  // Every printed row below IS returned by the model, correctly. hours (45,00) and the rate (15,55)
  // are also printed next to the amount, as real payslips do, and both parse as amount-like (two
  // decimals) even though `collectPeriodAmounts` never counts a rate or an hour count as a payslip
  // amount - this is the exact case the assignment names ("rates, hours and totals also print
  // numbers"). The measurement below reports the real number, not an assumed 0.
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
  // Correct as of this fixture: "45,00" and "15,55" are printed inside the label text itself here
  // (not a separate text item), so pdf.js returns them as part of one string, not as their own
  // amount-like items - this fixture therefore measures 0 unused items for a fully correct read.
  // Recorded here as the actual, checked number (per §2g.4: "report the number"), not asserted as a
  // universal property of every possible payslip layout - a layout that prints hours/rate in their
  // own table cell (as several real fixtures do) would leave more.
  assert.equal(unused.length, 0, `expected the report's stated measurement to match this fixture; got ${unused.length} unused: ${JSON.stringify(unused)}`);
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
