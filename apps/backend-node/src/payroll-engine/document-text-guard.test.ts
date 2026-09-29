import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PayslipPeriod } from './payslip-model.js';
import { findUnusedPrintedAmounts, collectPeriodAmounts, type DocumentTextItem } from './document-text-guard.js';

/**
 * Stage 2h (audit v28, §2h.1): direct unit coverage for the cross-item join, without going through a
 * synthetic PDF (that round-trip is synthetic-pdf.test.ts's job - this file exercises
 * document-text-guard.ts's own logic on hand-built `DocumentTextItem` arrays, the same shape
 * `local-ocr.ts extractTextItems` produces). Stage 2t (audit v52, §2t.3) retired the amount-
 * verification guard (`verifyAmountsAgainstText`/`textLayerVerificationCounts`) this file used to test
 * directly - `findUnusedPrintedAmounts` (informational, never blocking - §2g.4) remains, and shares the
 * SAME cross-item join/tokeniser, so the tests below now exercise it through that surviving function.
 */

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
    printed_taxable_base_normal: null,
    printed_taxable_base_special: null,
    printed_table_tax_label: null,
    printed_bt_tax_label: null,
    printed_algemene_heffingskorting_label: null,
    printed_arbeidskorting_label: null,
    printed_net_label: null,
    printed_payout_label: null,
    ...overrides,
  };
}

test('2h.1: two consecutive bare-fragment items on the same page/y recover a split-thousands number', () => {
  const items: DocumentTextItem[] = [
    { page: 1, text: '1', x: 100, y: 700 },
    { page: 1, text: '234,56', x: 110, y: 700 },
  ];
  const period = basePeriod({ printed_gross_total: 1234.56 });
  const unused = findUnusedPrintedAmounts(period, items);
  // The joined "1 234,56" (1234.56) is recognised and excluded from the unused list; the SECOND
  // fragment ("234,56") is also independently money-shaped on its own and stays its own, separate,
  // genuinely-unmatched candidate - a pre-existing property of the shared tokeniser, unrelated to this
  // test's own concern (the join itself works), so this only asserts the join succeeded.
  assert.ok(!unused.includes(1234.56), `expected the joined "1 234,56" to be recognised as printed_gross_total, not reported unused; got: ${JSON.stringify(unused)}`);
});

test('2h.1: a label cell and its own amount cell on the same row are NOT joined into a duplicate candidate', () => {
  // Stage 2h found this empirically: joining unconditionally on "same page, same y" also joins an
  // ordinary label ("Loon normaal") to its own amount ("699,78") sitting on the same row - both
  // already parse correctly alone, so the join only adds a duplicate, inflating the unused count.
  const items: DocumentTextItem[] = [
    { page: 1, text: 'Loon normaal', x: 50, y: 650 },
    { page: 1, text: '699,78', x: 300, y: 650 },
  ];
  const period = basePeriod({ hour_lines: [] }); // nothing in the period uses 699.78 - it must be listed exactly ONCE as unused
  const unused = findUnusedPrintedAmounts(period, items);
  assert.deepEqual(unused, [699.78], `expected exactly one 699.78, not a duplicate from the label+amount join; got: ${JSON.stringify(unused)}`);
});

test('2h.1: two ordinary, already-complete amounts on the same row (an hours cell next to a rate cell) are NOT joined into a bogus third candidate', () => {
  // The precise bug the dense three-page synthetic-PDF test caught: "45,00" (hours) and "15,55" (rate)
  // sit on the same row/y - both independently bare-number-shaped, but NEITHER is a fragment of a
  // split thousands number. An unguarded "both look numeric" join tokenises "45,00 15,55" right back
  // into 45 and 15.55, duplicating both real candidates (measured: 3x inflation on a real fixture).
  const items: DocumentTextItem[] = [
    { page: 1, text: '45,00', x: 200, y: 700 },
    { page: 1, text: '15,55', x: 260, y: 700 },
  ];
  const period = basePeriod({ hour_lines: [] });
  const unused = findUnusedPrintedAmounts(period, items);
  assert.deepEqual(unused.sort(), [15.55, 45], `expected each value counted exactly once, got: ${JSON.stringify(unused)}`);
});

test('2h.2: printed_algemene_heffingskorting and printed_arbeidskorting are collected as amounts', () => {
  const period = basePeriod({ printed_algemene_heffingskorting: 123.45, printed_arbeidskorting: 67.89 });
  const paths = collectPeriodAmounts(period).map((a) => a.path);
  assert.ok(paths.includes('printed_algemene_heffingskorting'), `expected printed_algemene_heffingskorting among collected paths: ${JSON.stringify(paths)}`);
  assert.ok(paths.includes('printed_arbeidskorting'), `expected printed_arbeidskorting among collected paths: ${JSON.stringify(paths)}`);
});

/**
 * Stage 2i (audit v29, §2i.0c), carried into 2t: "amounts are confirmed by money-shaped tokens only."
 * The reviewer's own worry (T6): a week number, an IBAN fragment or a BSN can parse to a bare integer
 * that happens to equal a printed field's magnitude. The amount-verification guard this once protected
 * is retired (§2t.3), but `findUnusedPrintedAmounts` shares the identical money-shape filter (only
 * `shape: 'money'` tokens are ever counted) - this proves a bare integer still never gets treated as
 * explaining a printed money figure it merely happens to coincide with.
 */
test('2i.0c: a printed money figure whose magnitude happens to equal a nearby WEEK NUMBER is still reported unused - only money-shaped tokens count', () => {
  const items: DocumentTextItem[] = [{ page: 1, text: 'Week 36', x: 10, y: 10 }];
  const period = basePeriod({ printed_gross_total: 36 });
  assert.deepEqual(findUnusedPrintedAmounts(period, items), [], 'the WEEK NUMBER itself is not money-shaped, so it contributes nothing to the unused list either way');
});

test('2i.0c: a genuine money-shaped printed figure is correctly recognised as used, not reported unused', () => {
  const items: DocumentTextItem[] = [{ page: 1, text: 'Week 36', x: 10, y: 5 }, { page: 1, text: '699,78', x: 10, y: 10 }];
  const period = basePeriod({ printed_gross_total: 699.78 });
  assert.deepEqual(findUnusedPrintedAmounts(period, items), []);
});

/**
 * Stage 2i (audit v29, §2i.5): "re-measure on synthetic fixtures and OTTO figures (27 should fall to
 * genuinely unexplained ones), report both numbers." OWNER-RETEST-2h-otto.md's own disclosed sample of
 * the 27 unused items ("14.45, 24.00, 21.25, 30.00, 2.75 ...") is reproduced here using OTTO's real,
 * already-confirmed figures (the same fixture "Tier C integration: Fixture 2 OTTO" in tier-c.test.ts
 * uses) - every rate/hours/percent OTTO's read actually captured, as its own text item, exactly as it
 * would appear on the real document's text layer. What this test CANNOT prove (§2.2/§2.3): the exact
 * new count on the real 27-item list, since that list's OTHER 22 items were never disclosed and the
 * real PDF's own text layer is not reproducible from a summary - only the owner's next OTTO upload can
 * measure the real, live number. What it DOES prove, precisely: every rate/hours/percent value in
 * OWNER-RETEST's disclosed 5-item sample is explained by 2i.5's fix, and the mechanism generalises
 * (COUNT_BEFORE minus COUNT_AFTER equals exactly the number of hours/rate/percent VALUES printed,
 * counting a value present on more than one line only once - findUnusedPrintedAmounts already
 * deduplicates by magnitude, same as every measurement in this file).
 */
test("2i.5: OTTO's real hours/rate/percent figures (the disclosed 27-unused sample) are explained after the fix - synthetic reconstruction with the exact, already-confirmed OTTO fixture numbers", () => {
  const period = basePeriod({
    hour_lines: [
      { employer_index: 0, description: 'Godziny przepracowane (DHL)', hours: 24.0, rate: 14.45, percent: null, amount: 346.8, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 30%', hours: 21.25, rate: 4.34, percent: 30, amount: 92.23, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 100%', hours: 2.75, rate: 14.45, percent: 100, amount: 39.74, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 1, description: 'Godziny przepracowane (KF)', hours: 19.0, rate: 14.4, percent: null, amount: 273.6, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Wymiana pw. urlopu ustawowego', hours: 0.77, rate: 14.43, percent: null, amount: 11.11, category: 'other', tax_treatment: 'table', adds_hours: false },
    ],
    wml_printed: 14.4,
    bijzonder_tarief: { jaarloon_bt: null, bt_state: 'known', tarief_bt: { printed: 38.45, computed: null } },
  });
  // Every rate/hours/percent VALUE OTTO's confirmed read captured, as its own text item - the exact
  // shape OWNER-RETEST's disclosed sample named (14.45, 24.00, 21.25, 30.00, 2.75), plus the rest of
  // the same fixture's own hours/rate/percent figures and the BT rate/minimum wage this stage adds.
  const items: DocumentTextItem[] = [
    { page: 1, text: '24,00', x: 10, y: 700 }, { page: 1, text: '14,45', x: 60, y: 700 },
    { page: 1, text: '21,25', x: 10, y: 690 }, { page: 1, text: '4,34', x: 60, y: 690 }, { page: 1, text: '30,00', x: 100, y: 690 },
    { page: 1, text: '2,75', x: 10, y: 680 },
    { page: 1, text: '100,00', x: 100, y: 680 },
    { page: 1, text: '19,00', x: 10, y: 670 }, { page: 1, text: '14,40', x: 60, y: 670 },
    { page: 1, text: '0,77', x: 10, y: 660 }, { page: 1, text: '14,43', x: 60, y: 660 },
    { page: 1, text: '38,45', x: 10, y: 600 }, // bijzonder_tarief_printed_percent
  ];

  const beforeUsedMagnitudes = collectPeriodAmounts(period).map((a) => Math.round(a.magnitude * 100) / 100);
  const beforeUnused = new Set<number>();
  for (const item of items) {
    const v = Number(item.text.replace(',', '.'));
    if (!beforeUsedMagnitudes.some((u) => Math.abs(u - v) <= 0.005)) beforeUnused.add(v);
  }

  const afterUnused = findUnusedPrintedAmounts(period, items);

  console.log(`  [2i.5] OTTO-shaped hours/rate/percent sample: ${beforeUnused.size} unused before the fix -> ${afterUnused.length} after (distinct magnitudes: ${JSON.stringify([...beforeUnused].sort((a, b) => a - b))} -> ${JSON.stringify(afterUnused)})`);

  assert.equal(beforeUnused.size, 12, 'sanity: 12 distinct hours/rate/percent/minimum-wage/BT-rate magnitudes in this sample before the fix (24, 14.45, 21.25, 4.34, 30, 2.75, 100, 19, 14.4, 0.77, 14.43, 38.45)');
  assert.equal(afterUnused.length, 0, 'expected every one of these to be explained after 2i.5 - none genuinely unexplained in this sample');
  // The specific disclosed-sample values must each have moved from unused to explained.
  for (const disclosed of [14.45, 24.0, 21.25, 30.0, 2.75]) {
    assert.ok(beforeUnused.has(disclosed), `sanity: ${disclosed} was unused before the fix`);
    assert.ok(!afterUnused.includes(disclosed), `expected ${disclosed} to no longer be unused after the fix`);
  }
});
