import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapExtractionToPeriod, type TierCExtraction } from './tier-c.js';
import { computePayslipPeriod, type PayslipComputationRates } from './payslip-model.js';
import { comparePeriodToDocument } from './discrepancy.js';

/**
 * Tier C integration tests (audit BP1/BP4), in the required fixture order: Olympia, PKF, Randstad,
 * OTTO. Each test hand-builds a TierCExtraction shaped exactly as a correctly-functioning widened AI
 * extraction (see tier-c.ts's own mapping-gap comment block) would produce for that real document -
 * an AI vision call cannot be run deterministically in this test environment, so this tests the
 * MAPPING + COMPUTATION + DISCREPANCY pipeline end to end, the same way payslip-model.test.ts tests
 * the engine by hand-building PayslipPeriod objects rather than depending on a live model.
 *
 * BP4's shipping condition, restated as what these tests actually assert:
 *   - fixtures that reproduce at model level (payslip-model.test.ts) still reproduce through this
 *     integrated mapping/computation path - same tolerances, same expected figures.
 *   - the discrepancy list reports a correct payslip as correct: Olympia, PKF and Randstad must
 *     produce an EMPTY discrepancy list. A verifier that flags a valid payslip is worse than none.
 *   - OTTO is the deliberate exception: its already-documented 12.28 EUR table-tax gap
 *     (payslip-model.test.ts, round 8/9) must show up as a REAL discrepancy here too - proving the
 *     comparator actually detects a mismatch, not just that it stays silent for everything.
 */

const RATES_2026: PayslipComputationRates = {
  loonheffing_brackets: [
    { min: 0, max: 38883, rate: 0.3575 },
    { min: 38883, max: 78426, rate: 0.3756 },
    { min: 78426, max: 999999999, rate: 0.495 },
  ],
  heffingskortingen: {
    algemene_heffingskorting: { max_amount: 3115, phaseout_start: 29736, phaseout_rate: 0.06398 },
    arbeidskorting: {
      max_amount: 5685,
      phaseout_start: 45592,
      phaseout_rate: 0.0651,
      buildup_tiers: [
        { max: 11965, rate: 0.08324 },
        { max: 25845, rate: 0.31009 },
        { max: 45592, rate: 0.0195 },
      ],
    },
  },
  period_multiplier: 52,
};

const RATES_2025: PayslipComputationRates = {
  loonheffing_brackets: [
    { min: 0, max: 38441, rate: 0.3582 },
    { min: 38441, max: 76817, rate: 0.3748 },
    { min: 76817, max: 999999999, rate: 0.495 },
  ],
  heffingskortingen: {
    algemene_heffingskorting: { max_amount: 3068, phaseout_start: 28406, phaseout_rate: 0.06337 },
    arbeidskorting: {
      max_amount: 5599,
      phaseout_start: 43072,
      phaseout_rate: 0.0651,
      buildup_tiers: [
        { max: 12169, rate: 0.08053 },
        { max: 26288, rate: 0.3003 },
        { max: 43071, rate: 0.02258 },
      ],
    },
  },
  period_multiplier: 52,
};

function baseExtraction(overrides: Partial<TierCExtraction>): TierCExtraction {
  return {
    period_label: null,
    period_end_date: null,
    period_type: 'week',
    is_correction: false,
    version: 1,
    employer_names: [],
    hirer_name: null,
    hours_per_week: null,
    minimum_wage_printed: null,
    hour_lines: [],
    pre_tax_deduction_lines: [],
    post_tax_deduction_lines: [],
    bijzonder_tarief_printed_percent: null,
    bijzonder_tarief_jaarloon: null,
    et_exchange_amount: null,
    et_reimbursement_lines: [],
    net_lines: [],
    payout_adjustment_lines: [],
    reservation_lines: [],
    printed_table_tax: null,
    printed_bt_tax: null,
    printed_algemene_heffingskorting: null,
    printed_arbeidskorting: null,
    reported_total_net: null,
    reported_net_paid: null,
    truncated: false,
    redacted_fields: [],
    ...overrides,
  };
}

test('Tier C integration: Fixture 4 Olympia maps, computes and reports NO discrepancy', () => {
  const extraction = baseExtraction({
    period_label: 'week 36/2026',
    period_end_date: '2026-09-06',
    employer_names: ['Olympia Services B.V.'],
    hirer_name: 'DSV Contract Logistics B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Loon onregelm. uren 100%', hours: 7.5, rate: 15.55, percent: 100, amount: 116.63, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Loon onregelm. uren 50%', hours: 7.5, rate: 15.55, percent: 50, amount: 58.31, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'ADV toeslag', hours: 45, rate: 15.55, percent: 1.54, amount: 10.78, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Bijdrage PAWW werknemer', amount: 0.89, category: 'paww', placement: 'pre_tax', base: 885.5, percent: 0.1 },
      { description: 'AZW werknemer', amount: 4.9, category: 'ziektewet', placement: 'pre_tax', base: null, percent: null },
      { description: 'STIPP-pensioen werknemer', amount: 34.79, category: 'pension', placement: 'pre_tax', base: 879.71, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      { description: 'WHK werknemer', amount: 6.46, category: 'other', placement: 'post_tax', base: null, percent: null },
    ],
    net_lines: [{ description: 'Onb. reiskosten woon/werk', amount: 90.0, category: 'reimbursement' }],
    reservation_lines: [
      { type: 'vakantiedagen', opgebouwd: 3.91, paid_out: 0 },
      { type: 'vakantiedagen_bovenwettelijk', opgebouwd: 0.98, paid_out: 0 },
      { type: 'vakantiegeld', opgebouwd: 78.51, paid_out: 0 },
    ],
    printed_table_tax: 152.37,
    printed_arbeidskorting: 108.71,
    reported_net_paid: 776.09, // CL: exercises the newly-wired payout_mismatch check with a real, already-verified figure
  });

  const period = mapExtractionToPeriod(extraction, 14.99); // wml_applicable resolved separately (N4) - see the test below for the "stale on document" case
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  assert.equal(outcome.result.gross_total, 885.5);
  assert.ok(Math.abs(outcome.result.payout_amount - 776.09) <= 0.5, `payout ${outcome.result.payout_amount} vs printed 776.09`);

  const discrepancies = comparePeriodToDocument(period, outcome);
  // Olympia's own wml_printed (14.71) genuinely differs from wml_applicable (14.99, resolved
  // separately) - this IS expected to surface, per audit N4, as an informational staleness signal,
  // not absorbed into silence. Every OTHER discrepancy code must be absent - this is a correct
  // payslip everywhere except that one already-known printed-minimum-wage staleness.
  assert.deepEqual(discrepancies.map((d) => d.code), ['minimum_wage_stale_on_document']);
  // Stage 1: a genuine 0.28 EUR staleness gap (an out-of-date printed rate, not extraction noise)
  // must classify as 'finding' - the confirmation band here (0.10) exists only for a trivial
  // single-cent-range OCR misread, not to soften a real, already-verified fact into a question.
  assert.equal(discrepancies[0]?.status, 'finding', `expected 'finding' for Olympia's real 0.28 EUR staleness gap, got ${discrepancies[0]?.status}`);
});

test('Tier C integration: Fixture 3 PKF maps, computes and reports NO discrepancy', () => {
  // Corrected against the actual source document this round (audit BQ), not just the earlier
  // curated fixture summary: hours_per_week (40,00, printed) and a vakantiegeld reservation
  // (281,24, printed - both absent from the version of this fixture built last round) are real,
  // printed data this test was missing; jaarloon_bt (38.000,00) IS printed here ("Jaarloon BT:"),
  // correcting the earlier "essentially never printed" claim; the real printed BT rate is TWO
  // components summed ("Tarief BT: 35,75 + 4,45%"), not one pre-summed figure - confirms
  // extractTierCPayslip's own prompt needs to handle that format, not just Randstad's single-number
  // one. Deduction descriptions below use the exact real text, not a paraphrase (audit BK3).
  const extraction = baseExtraction({
    period_label: '2026-8-M',
    period_end_date: '2026-08-31',
    period_type: 'month',
    employer_names: ['PKF / Post Finsterwolde BV'],
    hours_per_week: 40.0,
    minimum_wage_printed: 14.99,
    hour_lines: [
      { employer_index: 0, description: 'Salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk uren 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk uren 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deduction_lines: [
      { description: 'Paww Wn', amount: 3.52, category: 'paww', placement: 'pre_tax', base: 3515.56, percent: 0.1 },
      { description: 'Pensioenpremie Wn', amount: 229.03, category: 'pension', placement: 'pre_tax', base: 1601.58, percent: 14.3 },
      { description: 'WGA-Gat Verzekering Wn', amount: 5.99, category: 'wga_gat', placement: 'pre_tax', base: 3277.02, percent: 0.183 },
    ],
    post_tax_deduction_lines: [
      { description: 'gediff. WGA wn', amount: 11.31, category: 'gediff_wga', placement: 'post_tax', base: 3277.02, percent: 0.345 },
    ],
    net_lines: [
      { description: 'Reiskostenvergoeding (onbelast)', amount: 91.25, category: 'reimbursement' },
      { description: 'Inhouding Personeelsvereniging', amount: 4.0, category: 'union' },
      { description: 'Inhouding Lening', amount: 1100.0, category: 'loan' },
    ],
    reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 281.24, paid_out: 0 }],
    bijzonder_tarief_printed_percent: 40.2, // printed as "35,75 + 4,45%" - see comment above
    bijzonder_tarief_jaarloon: 38000,
    printed_table_tax: 276.42,
    printed_bt_tax: 222.42,
    reported_net_paid: 1754.12, // CL: exercises payout_mismatch with the already-verified real figure
  });

  const period = mapExtractionToPeriod(extraction, 14.99);
  // PKF is a MONTHLY document - the period_multiplier must match period_type, not the RATES_2026
  // constant's own default (52, for the weekly fixtures). Same bug shape N2/AN3 exist to catch:
  // an annual-formula tax reconstruction is wrong at the multiplier level, not just the tolerance.
  const outcome = computePayslipPeriod(period, { ...RATES_2026, period_multiplier: 12 }, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  assert.equal(outcome.result.gross_total, 3515.56);
  assert.ok(Math.abs(outcome.result.payout_amount - 1754.12) <= 1.5, `payout ${outcome.result.payout_amount} vs printed 1754.12`);

  const discrepancies = comparePeriodToDocument(period, outcome);
  assert.deepEqual(discrepancies, []);
});

test('Tier C integration: Fixture 1 Randstad (a correction, v2) maps, computes and reports NO discrepancy', () => {
  // Corrected against the real source document this round (audit BQ): a hirer is printed here too
  // (Emballagefabriek H. Post B.V.) - not only Olympia, as the earlier gap-analysis comment claimed;
  // jaarloon_bt IS printed ("Jaarloon bijz. beloning 46074"), as a single number (contrast PKF's
  // two-part-sum format); the Ziektewet line's real printed text is longer than what was hand-entered
  // last round (audit BK3's as-printed-term requirement).
  const extraction = baseExtraction({
    period_label: 'week 2026-11',
    period_end_date: '2026-04-30',
    is_correction: true,
    version: 2,
    employer_names: ['Randstad'],
    hirer_name: 'Emballagefabriek H. Post B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'Bruto loon uren', hours: 38.0, rate: 17.09, percent: null, amount: 649.42, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 125%', hours: 2.0, rate: 17.09, percent: 125, amount: 42.73, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 150%', hours: 9.25, rate: 17.09, percent: 150, amount: 237.12, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Compensatie ADV', hours: null, rate: null, percent: null, amount: 39.61, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Compensatie overgangsregeling', hours: null, rate: null, percent: null, amount: 2.01, category: 'other', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Premie PAWW', amount: 0.74, category: 'paww', placement: 'pre_tax', base: 970.89, percent: 0.08 },
      { description: 'Premie aanvullende verzekering Ziektewet premiegroep II A', amount: 4.55, category: 'ziektewet', placement: 'pre_tax', base: 970.89, percent: 0.7 },
      { description: 'Pensioenpremie', amount: 38.35, category: 'pension', placement: 'pre_tax', base: null, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      { description: 'Premie WGA', amount: 12.33, category: 'wga', placement: 'post_tax', base: null, percent: 1.33 },
    ],
    net_lines: [{ description: 'Reiskosten woon-werk', amount: 36.0, category: 'reimbursement' }],
    payout_adjustment_lines: [
      { description: 'Verrekend met openstaande schuld', amount: -47.53 },
      { description: 'Eerder betaald', amount: -744.73 },
    ],
    bijzonder_tarief_printed_percent: 50.47,
    bijzonder_tarief_jaarloon: 46074,
    printed_table_tax: 71.31,
    printed_bt_tax: 141.24,
    reported_net_paid: -53.89, // CL: the real printed final figure, an amount OWED (negative) - exercises payout_mismatch on a signed value too
  });

  // Paid 30-04-2026, within H1 2026 - wml_applicable is 14.71 here, NOT 14.99 (that's H2). Matches
  // the document's own printed figure, so no staleness discrepancy expected for this one.
  const period = mapExtractionToPeriod(extraction, 14.71);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  assert.ok(Math.abs(outcome.result.wage_net - 702.37) <= 0.5, `wage_net ${outcome.result.wage_net} vs printed 702.37`);
  const finalPayout = outcome.result.wage_net + outcome.result.net_additions_total + outcome.result.payout_adjustments_total;
  assert.ok(Math.abs(finalPayout - -53.89) <= 0.5, `final payout ${finalPayout} vs printed -53.89 (owed)`);

  const discrepancies = comparePeriodToDocument(period, outcome);
  assert.deepEqual(discrepancies, []);
});

test('Tier C integration: Fixture 2 OTTO (two employers, ET) maps and computes; the documented table-tax gap surfaces as a real discrepancy', () => {
  const extraction = baseExtraction({
    period_label: '33/2025',
    period_end_date: '2025-08-17',
    employer_names: ['DHL Supply Chain (NL) B.V.', 'KF Service & Beheer B.V.'],
    minimum_wage_printed: 14.4,
    hour_lines: [
      { employer_index: 0, description: 'Godziny przepracowane (DHL)', hours: 24.0, rate: 14.45, percent: null, amount: 346.8, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 30%', hours: 21.25, rate: 4.34, percent: 30, amount: 92.23, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 100%', hours: 2.75, rate: 14.45, percent: 100, amount: 39.74, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 1, description: 'Godziny przepracowane (KF)', hours: 19.0, rate: 14.4, percent: null, amount: 273.6, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek wakacyjny', hours: null, rate: null, percent: null, amount: 56.31, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Wymiana pw. urlopu ustawowego', hours: 0.77, rate: 14.43, percent: null, amount: 11.11, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Jednorazowa zapłata', hours: null, rate: null, percent: null, amount: 98.24, category: 'other', tax_treatment: 'bt', adds_hours: false },
      { employer_index: 0, description: 'Wynagrodzenie kierowcy brutto', hours: null, rate: null, percent: null, amount: 6.0, category: 'other', tax_treatment: 'bt', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Emerytura STIPP', amount: 21.65, category: 'pension', placement: 'pre_tax', base: null, percent: 4 },
    ],
    et_exchange_amount: 177.0,
    et_reimbursement_lines: [
      { description: 'Zwrot kosztów utrzymania ET', amount: 33.0, category: 'reimbursement' },
      { description: 'Zwrot za zakwaterowanie ET', amount: 144.0, category: 'reimbursement' },
    ],
    net_lines: [
      { description: 'Potrącenie własnego wkładu WHK', amount: 1.55, category: 'other' },
      { description: 'Nominalna składka ubezpieczenia zdrowotnego', amount: 38.01, category: 'health_insurance' },
      { description: 'Potrącenie kosztów przewozu', amount: 2.63, category: 'transport' },
      { description: 'Potrącenie za zakwaterowanie', amount: 144.0, category: 'housing' },
    ],
    bijzonder_tarief_printed_percent: 38.45,
    printed_table_tax: 77.52,
    printed_bt_tax: 40.08,
  });

  const period = mapExtractionToPeriod(extraction, 14.4);
  // Two employers detected -> franchise_bearing must be 'unknown' for both (audit BP1 gap note),
  // never guessed even though round 7/8's own analysis concluded DHL likely carries it.
  assert.equal(period.employers.length, 2);
  assert.ok(period.employers.every((e) => e.franchise_bearing === 'unknown'));

  const outcome = computePayslipPeriod(period, RATES_2025, true);
  assert.equal(outcome.status, 'complete');
  if (outcome.status !== 'complete') return;
  assert.equal(outcome.result.taxable_base, 725.38);
  assert.equal(outcome.result.bt_tax.toFixed(2), '40.08'); // exact - flat percentage, not a table lookup

  const discrepancies = comparePeriodToDocument(period, outcome);
  const tableTaxDiscrepancy = discrepancies.find((d) => d.code === 'table_tax_mismatch');
  assert.ok(tableTaxDiscrepancy, 'expected the already-documented table-tax gap to surface as a real discrepancy, not be silently absorbed');
  assert.ok(Math.abs((tableTaxDiscrepancy?.residual ?? 0) + 12.28) < 0.5, `expected a residual near -12.28, got ${tableTaxDiscrepancy?.residual}`);
  // Stage 1: a 12.28 EUR residual is 24x the weekly tolerance (0.50) - nowhere near plausible
  // single-line extraction noise (confirmation band tops out at 1.5x). Must stay 'finding'.
  assert.equal(tableTaxDiscrepancy?.status, 'finding', `expected 'finding' for OTTO's real 12.28 EUR gap, got ${tableTaxDiscrepancy?.status}`);
});

/**
 * ============================================================================================
 * BW - extraction-noise false-positive test (audit round "TIER DEFINITIONS, FINAL", order item 1).
 * ============================================================================================
 * BQ4's question, restated: "if extraction noise alone generates discrepancies, the product accuses
 * employers on the strength of its own OCR errors." Every test above uses a HAND-BUILT extraction
 * that already matches its real document exactly - none of them exercise what happens when the
 * extraction is off in ways a real vision read plausibly would be. These tests do: each takes the
 * PKF or Randstad extraction (both confirmed byte-for-byte against the real PDF, audit BQ) and
 * perturbs exactly one field the way a real OCR/vision misread plausibly would, then checks whether
 * comparePeriodToDocument() manufactures a discrepancy on what is still, underneath the noise, a
 * correct payslip. This is a measurement, not a prediction - the assertions below record what was
 * actually observed running this code, not what was expected going in.
 *
 * Each noise scenario is classified FALSE POSITIVE (a correct payslip gets flagged) or CLEAN
 * (tolerance correctly absorbs the noise, or the comparator correctly has nothing to compare against
 * a field it never checks). The measured rate is reported in the round's report, not just here.
 */

test('BW1: description-only noise (diacritics dropped, case changed) changes nothing - CLEAN', () => {
  // Real documents drop diacritics inconsistently (audit BQ's OTTO finding: "zaplata" not "zapłata").
  // description is never used in computation (only category/tax_treatment/amount are) - this test
  // exists to CONFIRM that design choice holds, not just assert it in a comment.
  const extraction = baseExtraction({
    period_label: 'week 2026-11',
    period_end_date: '2026-04-30',
    is_correction: true,
    version: 2,
    employer_names: ['Randstad'],
    hirer_name: 'Emballagefabriek H. Post B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'BRUTO LOON UREN', hours: 38.0, rate: 17.09, percent: null, amount: 649.42, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'bruto loon overuren 125', hours: 2.0, rate: 17.09, percent: 125, amount: 42.73, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'bruto loon overuren 150', hours: 9.25, rate: 17.09, percent: 150, amount: 237.12, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'compensatie adv', hours: null, rate: null, percent: null, amount: 39.61, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'compensatie overgangsregeling', hours: null, rate: null, percent: null, amount: 2.01, category: 'other', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'premie paww', amount: 0.74, category: 'paww', placement: 'pre_tax', base: 970.89, percent: 0.08 },
      { description: 'premie aanvullende verzekering ziektewet premiegroep ii a (no diacritics)', amount: 4.55, category: 'ziektewet', placement: 'pre_tax', base: 970.89, percent: 0.7 },
      { description: 'pensioenpremie', amount: 38.35, category: 'pension', placement: 'pre_tax', base: null, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      { description: 'premie wga', amount: 12.33, category: 'wga', placement: 'post_tax', base: null, percent: 1.33 },
    ],
    net_lines: [{ description: 'reiskosten woon-werk', amount: 36.0, category: 'reimbursement' }],
    payout_adjustment_lines: [
      { description: 'verrekend met openstaande schuld', amount: -47.53 },
      { description: 'eerder betaald', amount: -744.73 },
    ],
    bijzonder_tarief_printed_percent: 50.47,
    bijzonder_tarief_jaarloon: 46074,
    printed_table_tax: 71.31,
    printed_bt_tax: 141.24,
  });

  const period = mapExtractionToPeriod(extraction, 14.71);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW1] description-noise discrepancies: ${discrepancies.length === 0 ? 'none (CLEAN, as expected)' : JSON.stringify(discrepancies)}`);
  assert.deepEqual(discrepancies, [], 'description-only noise must never manufacture a discrepancy - description is not a computation input');
});

test('CL: a reimbursement misclassified as a deduction now correctly surfaces as payout_mismatch (closes last round\'s false-negative gap)', () => {
  // Last round found that net_mismatch/payout_mismatch were declared but never pushed - a net_lines
  // classification error (a genuine reimbursement read as a deduction, flipping it from
  // net_additions into net_deductions) would silently produce a wrong final payout with "no
  // discrepancy" reported. This is the Randstad fixture with exactly that one error introduced:
  // 'reiskosten woon-werk' (a real, untaxed travel reimbursement) misclassified from category
  // 'reimbursement' to 'transport' (a real NetDeductionCategory) - everything else is unchanged from
  // the clean, real-document-verified fixture.
  const extraction = baseExtraction({
    period_label: 'week 2026-11',
    period_end_date: '2026-04-30',
    is_correction: true,
    version: 2,
    employer_names: ['Randstad'],
    hirer_name: 'Emballagefabriek H. Post B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'Bruto loon uren', hours: 38.0, rate: 17.09, percent: null, amount: 649.42, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 125%', hours: 2.0, rate: 17.09, percent: 125, amount: 42.73, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 150%', hours: 9.25, rate: 17.09, percent: 150, amount: 237.12, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Compensatie ADV', hours: null, rate: null, percent: null, amount: 39.61, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Compensatie overgangsregeling', hours: null, rate: null, percent: null, amount: 2.01, category: 'other', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deduction_lines: [
      { description: 'Premie PAWW', amount: 0.74, category: 'paww', placement: 'pre_tax', base: 970.89, percent: 0.08 },
      { description: 'Premie aanvullende verzekering Ziektewet premiegroep II A', amount: 4.55, category: 'ziektewet', placement: 'pre_tax', base: 970.89, percent: 0.7 },
      { description: 'Pensioenpremie', amount: 38.35, category: 'pension', placement: 'pre_tax', base: null, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      { description: 'Premie WGA', amount: 12.33, category: 'wga', placement: 'post_tax', base: null, percent: 1.33 },
    ],
    net_lines: [{ description: 'Reiskosten woon-werk', amount: 36.0, category: 'transport' }], // NOISE: was 'reimbursement'
    payout_adjustment_lines: [
      { description: 'Verrekend met openstaande schuld', amount: -47.53 },
      { description: 'Eerder betaald', amount: -744.73 },
    ],
    bijzonder_tarief_printed_percent: 50.47,
    bijzonder_tarief_jaarloon: 46074,
    printed_table_tax: 71.31,
    printed_bt_tax: 141.24,
    reported_net_paid: -53.89, // the real printed figure - unchanged by the noise, since it's what the document actually says
  });

  const period = mapExtractionToPeriod(extraction, 14.71);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [CL] reimbursement-misclassified-as-deduction discrepancies: ${JSON.stringify(discrepancies)}`);
  const payoutMismatch = discrepancies.find((d) => d.code === 'payout_mismatch');
  assert.ok(payoutMismatch, 'BEFORE this round: this error passed silently as "no discrepancy". AFTER: payout_mismatch must fire - the 36 EUR moved from net_additions to net_deductions is a real 72 EUR swing in the final payout.');
  // Stage 1 (audit "CONSOLIDATED ASSIGNMENT" round): a 72 EUR swing is nowhere near plausible
  // single-line extraction noise (the confirmation band tops out at 1.5x tableTolerance) - this must
  // classify as 'finding', stated plainly, never softened into a mere confirmation question.
  assert.equal(payoutMismatch?.status, 'finding', `expected 'finding' for a 72 EUR swing, got ${payoutMismatch?.status}`);
});

test('BW2: a small ambiguous line misclassified table->bt (a plausible AI judgment error) - measured', () => {
  // Randstad's "Compensatie overgangsregeling" (2.01 EUR) has no explicit tax marker on the document
  // beyond context; a vision read could plausibly file it as a bonus-shaped BT line instead of a
  // table-taxed one. Real document text and every other field is unchanged from the clean Randstad
  // fixture - only this one line's tax_treatment is flipped, exactly the kind of single-field
  // extraction slip BQ4 is asking about.
  const extraction = baseExtraction({
    period_label: 'week 2026-11',
    period_end_date: '2026-04-30',
    is_correction: true,
    version: 2,
    employer_names: ['Randstad'],
    hirer_name: 'Emballagefabriek H. Post B.V.',
    minimum_wage_printed: 14.71,
    hour_lines: [
      { employer_index: 0, description: 'Bruto loon uren', hours: 38.0, rate: 17.09, percent: null, amount: 649.42, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 125%', hours: 2.0, rate: 17.09, percent: 125, amount: 42.73, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 150%', hours: 9.25, rate: 17.09, percent: 150, amount: 237.12, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Compensatie ADV', hours: null, rate: null, percent: null, amount: 39.61, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Compensatie overgangsregeling', hours: null, rate: null, percent: null, amount: 2.01, category: 'other', tax_treatment: 'bt', adds_hours: false }, // NOISE: was 'table'
    ],
    pre_tax_deduction_lines: [
      { description: 'Premie PAWW', amount: 0.74, category: 'paww', placement: 'pre_tax', base: 970.89, percent: 0.08 },
      { description: 'Premie aanvullende verzekering Ziektewet premiegroep II A', amount: 4.55, category: 'ziektewet', placement: 'pre_tax', base: 970.89, percent: 0.7 },
      { description: 'Pensioenpremie', amount: 38.35, category: 'pension', placement: 'pre_tax', base: null, percent: 7.5 },
    ],
    post_tax_deduction_lines: [
      { description: 'Premie WGA', amount: 12.33, category: 'wga', placement: 'post_tax', base: null, percent: 1.33 },
    ],
    net_lines: [{ description: 'Reiskosten woon-werk', amount: 36.0, category: 'reimbursement' }],
    payout_adjustment_lines: [
      { description: 'Verrekend met openstaande schuld', amount: -47.53 },
      { description: 'Eerder betaald', amount: -744.73 },
    ],
    bijzonder_tarief_printed_percent: 50.47,
    bijzonder_tarief_jaarloon: 46074,
    printed_table_tax: 71.31,
    printed_bt_tax: 141.24,
  });

  const period = mapExtractionToPeriod(extraction, 14.71);
  const outcome = computePayslipPeriod(period, RATES_2026, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW2] tax_treatment-misclassification discrepancies: ${JSON.stringify(discrepancies)}`);
  // Measured, not assumed: moving 2.01 EUR from the table-taxed to the BT-taxed bucket shifts both
  // table_tax and bt_tax by a small amount. Whether that crosses the tolerance band is the actual
  // question BW2 answers - assert on what running the code showed, not on an assumption made before
  // running it.
  assert.ok(discrepancies.every((d) => d.code === 'table_tax_mismatch' || d.code === 'bt_tax_mismatch'), 'only tax-figure codes should be able to fire from a tax_treatment change');
  // Stage 1 (audit "CONSOLIDATED ASSIGNMENT" round, Tier C): a single plausible AI misjudgment on
  // one small ambiguous line is exactly the case the confirmation band exists for - both codes
  // measured here must classify as 'confirm' (a question), never 'finding' (a stated accusation).
  assert.ok(discrepancies.every((d) => d.status === 'confirm'), `expected both to classify as 'confirm', got: ${JSON.stringify(discrepancies.map((d) => ({ code: d.code, status: d.status })))}`);
});

test('BW3: a five-cent OCR digit-slip on the printed BT-tax figure - re-measured after CJ\'s retune', () => {
  // CJ (audit "SEVERAL EMPLOYERS AT ONCE" round): this test originally measured a FALSE POSITIVE
  // here under bt_tax_mismatch's old 0.01 EXACT_TOLERANCE (a real product gap this test itself
  // surfaced). BT_TAX_TOLERANCE is now 0.10 (discrepancy.ts) specifically to absorb this class of
  // noise - re-running the identical scenario after the retune is the CJ instruction ("retune
  // tolerances, re-run BW"), not a new scenario. (Also fixing a labelling error from last round: 0.05
  // EUR is a five-cent slip, not a one-cent one - the number was always right, the name was not.)
  const base = baseExtraction({
    period_label: '2026-8-M',
    period_end_date: '2026-08-31',
    period_type: 'month',
    employer_names: ['PKF / Post Finsterwolde BV'],
    hours_per_week: 40.0,
    minimum_wage_printed: 14.99,
    hour_lines: [
      { employer_index: 0, description: 'Salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk uren 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk uren 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deduction_lines: [
      { description: 'Paww Wn', amount: 3.52, category: 'paww', placement: 'pre_tax', base: 3515.56, percent: 0.1 },
      { description: 'Pensioenpremie Wn', amount: 229.03, category: 'pension', placement: 'pre_tax', base: 1601.58, percent: 14.3 },
      { description: 'WGA-Gat Verzekering Wn', amount: 5.99, category: 'wga_gat', placement: 'pre_tax', base: 3277.02, percent: 0.183 },
    ],
    post_tax_deduction_lines: [
      { description: 'gediff. WGA wn', amount: 11.31, category: 'gediff_wga', placement: 'post_tax', base: 3277.02, percent: 0.345 },
    ],
    net_lines: [
      { description: 'Reiskostenvergoeding (onbelast)', amount: 91.25, category: 'reimbursement' },
      { description: 'Inhouding Personeelsvereniging', amount: 4.0, category: 'union' },
      { description: 'Inhouding Lening', amount: 1100.0, category: 'loan' },
    ],
    reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 281.24, paid_out: 0 }],
    bijzonder_tarief_printed_percent: 40.2,
    bijzonder_tarief_jaarloon: 38000,
    printed_table_tax: 276.42,
    printed_bt_tax: 222.47, // NOISE: real printed figure is 222.42 - a five-cent digit slip
  });

  const period = mapExtractionToPeriod(base, 14.99);
  const outcome = computePayslipPeriod(period, { ...RATES_2026, period_multiplier: 12 }, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW3] five-cent bt_tax OCR slip discrepancies (post-CJ-retune): ${JSON.stringify(discrepancies)}`);
  assert.deepEqual(discrepancies, [], 'CJ RESOLVED: the retuned 0.10 BT_TAX_TOLERANCE now correctly absorbs this five-cent OCR slip - CLEAN');
});

test('BW3b: a 0.20 EUR bt_tax slip still correctly fires past the retuned tolerance - the retune is not a blank check', () => {
  // Same PKF base as BW3, but the noise is now large enough (0.20 EUR, twice BT_TAX_TOLERANCE) that
  // it must still be caught - proves CJ's retune widened the band, it did not remove it.
  const extraction = baseExtraction({
    period_label: '2026-8-M',
    period_end_date: '2026-08-31',
    period_type: 'month',
    employer_names: ['PKF / Post Finsterwolde BV'],
    hours_per_week: 40.0,
    minimum_wage_printed: 14.99,
    hour_lines: [
      { employer_index: 0, description: 'Salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk uren 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk uren 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deduction_lines: [
      { description: 'Paww Wn', amount: 3.52, category: 'paww', placement: 'pre_tax', base: 3515.56, percent: 0.1 },
      { description: 'Pensioenpremie Wn', amount: 229.03, category: 'pension', placement: 'pre_tax', base: 1601.58, percent: 14.3 },
      { description: 'WGA-Gat Verzekering Wn', amount: 5.99, category: 'wga_gat', placement: 'pre_tax', base: 3277.02, percent: 0.183 },
    ],
    post_tax_deduction_lines: [
      { description: 'gediff. WGA wn', amount: 11.31, category: 'gediff_wga', placement: 'post_tax', base: 3277.02, percent: 0.345 },
    ],
    net_lines: [
      { description: 'Reiskostenvergoeding (onbelast)', amount: 91.25, category: 'reimbursement' },
      { description: 'Inhouding Personeelsvereniging', amount: 4.0, category: 'union' },
      { description: 'Inhouding Lening', amount: 1100.0, category: 'loan' },
    ],
    reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 281.24, paid_out: 0 }],
    bijzonder_tarief_printed_percent: 40.2,
    bijzonder_tarief_jaarloon: 38000,
    printed_table_tax: 276.42,
    printed_bt_tax: 222.62, // NOISE: real printed figure is 222.42 - a 0.20 EUR slip, twice BT_TAX_TOLERANCE
  });

  const period = mapExtractionToPeriod(extraction, 14.99);
  const outcome = computePayslipPeriod(period, { ...RATES_2026, period_multiplier: 12 }, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW3b] 0.20 EUR bt_tax slip discrepancies: ${JSON.stringify(discrepancies)}`);
  const btMismatch = discrepancies.find((d) => d.code === 'bt_tax_mismatch');
  assert.ok(btMismatch, 'a 0.20 EUR slip must still be caught - the retune widened the band, it did not remove it');
  // Stage 1: still inside BT's confirmation band (1.5) - a modest, plausible OCR slip on the printed
  // figure should read as a question, not an accusation, even though it's beyond the silent tolerance.
  assert.equal(btMismatch?.status, 'confirm', `expected 'confirm' for a 0.20 EUR slip, got ${btMismatch?.status}`);
});

test('BW4: a table-tax OCR slip within the period tolerance band - correctly absorbed, CLEAN', () => {
  // Same PKF fixture, but the noise this time is on printed_table_tax and stays inside the monthly
  // tolerance (1.50) already established from real table-rounding behavior (N2/AN3) - this is the
  // control case proving the tolerance band does its job for realistically-sized OCR noise on a
  // figure that isn't held to EXACT_TOLERANCE.
  const extraction = baseExtraction({
    period_label: '2026-8-M',
    period_end_date: '2026-08-31',
    period_type: 'month',
    employer_names: ['PKF / Post Finsterwolde BV'],
    hours_per_week: 40.0,
    minimum_wage_printed: 14.99,
    hour_lines: [
      { employer_index: 0, description: 'Salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk uren 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk uren 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deduction_lines: [
      { description: 'Paww Wn', amount: 3.52, category: 'paww', placement: 'pre_tax', base: 3515.56, percent: 0.1 },
      { description: 'Pensioenpremie Wn', amount: 229.03, category: 'pension', placement: 'pre_tax', base: 1601.58, percent: 14.3 },
      { description: 'WGA-Gat Verzekering Wn', amount: 5.99, category: 'wga_gat', placement: 'pre_tax', base: 3277.02, percent: 0.183 },
    ],
    post_tax_deduction_lines: [
      { description: 'gediff. WGA wn', amount: 11.31, category: 'gediff_wga', placement: 'post_tax', base: 3277.02, percent: 0.345 },
    ],
    net_lines: [
      { description: 'Reiskostenvergoeding (onbelast)', amount: 91.25, category: 'reimbursement' },
      { description: 'Inhouding Personeelsvereniging', amount: 4.0, category: 'union' },
      { description: 'Inhouding Lening', amount: 1100.0, category: 'loan' },
    ],
    reservation_lines: [{ type: 'vakantiegeld', opgebouwd: 281.24, paid_out: 0 }],
    bijzonder_tarief_printed_percent: 40.2,
    bijzonder_tarief_jaarloon: 38000,
    printed_table_tax: 276.72, // NOISE: real printed figure is 276.42 - a 0.30 slip, inside the 1.50 monthly band
    printed_bt_tax: 222.42,
  });

  const period = mapExtractionToPeriod(extraction, 14.99);
  const outcome = computePayslipPeriod(period, { ...RATES_2026, period_multiplier: 12 }, true);
  const discrepancies = comparePeriodToDocument(period, outcome);
  console.log(`  [BW4] table-tax OCR slip (within tolerance) discrepancies: ${JSON.stringify(discrepancies)}`);
  assert.deepEqual(discrepancies, [], 'a 0.30 EUR slip on printed_table_tax must stay inside the 1.50 monthly tolerance');
});

/**
 * BW5 - NOT a false-positive test, a documented FALSE-NEGATIVE gap found while building the above:
 * discrepancy.ts declares 'net_mismatch' and 'payout_mismatch' codes but never pushes either one -
 * there is no comparison anywhere against period.reported_total_net / reported_net_paid. A net_lines
 * misclassification (e.g. a genuine reimbursement read as a deduction, flipping it from
 * net_additions into net_deductions) would silently change the computed final payout and NOT be
 * caught, because nothing compares the computed net/payout against what the document reports. This
 * is the opposite risk from BW1-BW4 (silence on a real error, not noise on a correct one) and is
 * reported as a NEW FINDING rather than fixed here - fixing it means deciding what `reported_net_paid`
 * should be sourced from in the extraction schema, which is its own piece of work.
 */

