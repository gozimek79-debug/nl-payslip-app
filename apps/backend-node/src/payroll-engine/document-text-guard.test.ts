import { test } from 'node:test';
import assert from 'node:assert/strict';
import { known, type PayslipPeriod, type PreTaxDeduction } from './payslip-model.js';
import { verifyAmountsAgainstText, findUnusedPrintedAmounts, textLayerVerificationCounts, collectPeriodAmounts, type DocumentTextItem } from './document-text-guard.js';

/**
 * Stage 2h (audit v28, §2h.1/§2h.2): direct unit coverage for the cross-item join and the
 * checked/unverified counts, without going through a synthetic PDF (that round-trip is
 * synthetic-pdf.test.ts's job - this file exercises document-text-guard.ts's own logic on
 * hand-built `DocumentTextItem` arrays, the same shape `local-ocr.ts extractTextItems` produces).
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
  const unverified = verifyAmountsAgainstText(period, items);
  assert.deepEqual(unverified, [], `expected the joined "1 234,56" to verify printed_gross_total; got unverified: ${JSON.stringify(unverified)}`);
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

test('2h.2: a correct printed heffingskorting verifies against the text layer', () => {
  const items: DocumentTextItem[] = [{ page: 1, text: '123,45', x: 10, y: 10 }];
  const period = basePeriod({ printed_algemene_heffingskorting: 123.45 });
  assert.deepEqual(verifyAmountsAgainstText(period, items), []);
});

test('2h.2: textLayerVerificationCounts reports checked/unverified consistently with verifyAmountsAgainstText', () => {
  const items: DocumentTextItem[] = [{ page: 1, text: '100,00', x: 0, y: 0 }];
  const stippDeduction = (amount: number): PreTaxDeduction => ({ category: 'pension', description: 'STIPP', amount: known(amount, 'payslip_extracted'), base: null, percent: null });
  const period = basePeriod({ pre_tax_deductions: [stippDeduction(100), stippDeduction(200), stippDeduction(300)] });
  const counts = textLayerVerificationCounts(period, items);
  assert.equal(counts.checked, 3);
  assert.equal(counts.unverified, 2, `only 100,00 is printed; the other two deductions (200, 300) should be unverified, got ${JSON.stringify(counts)}`);
  assert.equal(verifyAmountsAgainstText(period, items).length, counts.unverified, 'counts.unverified must match verifyAmountsAgainstText length exactly');
});

test('2h.2: textLayerVerificationCounts reports unverified 0 (never a false mismatch) when there is no text list at all', () => {
  const period = basePeriod({ printed_gross_total: 100 });
  assert.deepEqual(textLayerVerificationCounts(period, []), { checked: 1, unverified: 0 });
});
