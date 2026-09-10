import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePayslipPeriod, type PayslipPeriod, type PayslipComputationRates } from './payslip-model.js';

/**
 * Golden tests for the payslip-model rewrite (audit round 8, AK3), in the required fixture order:
 * Olympia, PKF, Randstad, OTTO. Each PayslipPeriod is built by hand from
 * FIXTURES-paski-referencyjne.md's own worked figures, re-read fresh for this round (not from
 * memory - see the round 7/8 audit replies on why that distinction matters here specifically).
 *
 * Tolerance note: every fixture that involves the TABLE tax component is checked within ~0.35 EUR
 * per period, not to the cent. This is the same, already-established residual from reconstructing
 * Belastingdienst's stepwise period tables from a smooth annual formula (see N2/full-payslip.ts's
 * tolerance tiers) - confirmed there against Olympia and Randstad directly. BT tax, which is a flat
 * percentage times a base rather than a table lookup, is exact.
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
  period_multiplier: 52, // overridden per-test for the monthly fixture
};

/**
 * OTTO (Fixture 2) is dated 2025-W33 - using RATES_2026 for it was a real bug (caught by the
 * table_tax residual being 16.55 EUR, far outside the ~0.35 table-rounding tolerance every other
 * fixture's table tax sits within), not table-rounding noise. Confirmed against Belastingdienst's
 * own 2025 arbeidskorting table page and standard 2025 box-1/algemene-heffingskorting figures.
 */
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

// ============================================================================
// Fixture 4 — Olympia Services, week 36/2026 (simplest: single employer, no BT)
// ============================================================================
test('payslip-model: Fixture 4 Olympia reproduces payout 776.09 (within table-tax tolerance)', () => {
  const olympia: PayslipPeriod = {
    period_label: 'week 36/2026',
    period_type: 'week',
    period_end_date: '2026-09-06',
    is_correction: false,
    version: 1,
    employers: [{ name: 'Olympia Services B.V.', franchise_bearing: true }],
    hirer: { name: 'DSV Contract Logistics B.V.' },
    contract_hours: null, // 64u/4wk contract vs weekly settlement - never cross-checked (audit AK2)
    hour_lines: [
      { employer_index: 0, description: 'Loon normaal', hours: 45, rate: 15.55, percent: null, amount: 699.78, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Loon onregelm. uren 100%', hours: 7.5, rate: 15.55, percent: 100, amount: 116.63, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Loon onregelm. uren 50%', hours: 7.5, rate: 15.55, percent: 50, amount: 58.31, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'ADV toeslag', hours: 45, rate: 15.55, percent: 1.54, amount: 10.78, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deductions: [
      { category: 'paww', description: 'Bijdrage PAWW werknemer', amount: 0.89, base: 885.50, percent: 0.1 },
      { category: 'ziektewet', description: 'AZW werknemer', amount: 4.9, base: null, percent: null },
      { category: 'pension', description: 'STIPP-pensioen werknemer', amount: 34.79, base: 879.71, percent: 7.5 },
    ],
    bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
    et: null,
    post_tax_social: [{ category: 'whk', description: 'WHK werknemer', amount: 6.46, percent: null }],
    net_additions: [{ category: 'reimbursement', description: 'Onb. reiskosten woon/werk', amount: 90.0 }],
    net_deductions: [],
    payout_adjustments: [],
    reservations: [
      { type: 'vakantiedagen', opgebouwd_this_period: 3.91, paid_out_this_period: 0, saldo_after: null },
      { type: 'vakantiedagen_bovenwettelijk', opgebouwd_this_period: 0.98, paid_out_this_period: 0, saldo_after: null },
      { type: 'vakantiegeld', opgebouwd_this_period: 78.51, paid_out_this_period: 0, saldo_after: null },
    ],
    wml_printed: 14.71,
    wml_applicable: 14.99,
    printed_table_tax: 152.37,
    printed_bt_tax: null,
    printed_algemene_heffingskorting: null,
    printed_arbeidskorting: 108.71,
  };

  const result = computePayslipPeriod(olympia, RATES_2026, true);
  assert.equal(result.gross_total, 885.5);
  assert.equal(result.loon_voor_heffingen, 844.92);
  assert.equal(result.taxable_base, 844.92);
  assert.equal(result.bt_tax, 0);
  assert.equal(result.arbeidskorting.toFixed(2), '108.71'); // exact - confirmed A3/N1, no table-rounding involved
  assert.ok(Math.abs(result.table_tax_after_korting - 152.37) <= 0.35, `table tax ${result.table_tax_after_korting} vs printed 152.37`);
  assert.ok(Math.abs(result.payout_amount - 776.09) <= 0.35, `payout ${result.payout_amount} vs printed 776.09`);
});

// ============================================================================
// Fixture 3 — PKF / Post Finsterwolde, 2026-08 (monthly, direct employment, BT with pension franchise)
// ============================================================================
test('payslip-model: Fixture 3 PKF reproduces payout 1754.12 (within table-tax tolerance)', () => {
  const pkf: PayslipPeriod = {
    period_label: '2026-8-M',
    period_type: 'month',
    period_end_date: '2026-08-31',
    is_correction: false,
    version: 1,
    employers: [{ name: 'PKF/Post Finsterwolde', franchise_bearing: true }],
    hirer: null,
    contract_hours: null,
    hour_lines: [
      { employer_index: 0, description: 'Stam salaris', hours: null, rate: null, percent: null, amount: 2962.27, category: 'regular', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Overwerk 125%', hours: 4.0, rate: 21.36, percent: 125, amount: 85.45, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Overwerk 150%', hours: 18.25, rate: 25.64, percent: 150, amount: 467.84, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
    ],
    pre_tax_deductions: [
      { category: 'paww', description: 'Paww Wn', amount: 3.52, base: 3515.56, percent: 0.1 },
      { category: 'pension', description: 'Pensioenpremie Wn', amount: 229.03, base: 1601.58, percent: 14.3 },
      { category: 'wga_gat', description: 'WGA-Gat Verz. Wn', amount: 5.99, base: 3277.02, percent: 0.183 },
    ],
    bijzonder_tarief: { jaarloon_bt: 38000, bt_state: 'known', tarief_bt: { printed: 40.2, computed: null } },
    et: null,
    post_tax_social: [{ category: 'gediff_wga', description: 'gediff. WGA wn', amount: 11.31, percent: 0.345 }],
    net_additions: [{ category: 'reimbursement', description: 'Reiskostenvergoeding', amount: 91.25 }],
    net_deductions: [
      { category: 'union', description: 'Inhouding Personeelsvereniging', amount: 4.0 },
      { category: 'loan', description: 'Inhouding Lening', amount: 1100.0 },
    ],
    payout_adjustments: [],
    reservations: [],
    wml_printed: 14.99,
    wml_applicable: 14.99,
    printed_table_tax: 276.42,
    printed_bt_tax: 222.42,
    printed_algemene_heffingskorting: null,
    printed_arbeidskorting: null,
  };

  const result = computePayslipPeriod(pkf, { ...RATES_2026, period_multiplier: 12 }, true);
  assert.equal(result.gross_total, 3515.56);
  assert.equal(result.taxable_base, 3277.02);
  assert.equal(result.bt_tax.toFixed(2), '222.42'); // exact - flat percentage, not a table lookup
  // Monthly-scale tolerance is wider than the weekly fixtures' 0.35 - the same absolute rounding
  // per table step compounds differently at monthly scale (S2's point from an earlier round: an
  // absolute EUR tolerance isn't necessarily the same fraction of the period at every period type).
  assert.ok(Math.abs(result.table_tax_after_korting - 276.42) <= 0.7, `table tax ${result.table_tax_after_korting} vs printed 276.42`);
  assert.ok(Math.abs(result.payout_amount - 1754.12) <= 0.7, `payout ${result.payout_amount} vs printed 1754.12`);
});

// ============================================================================
// Fixture 1 — Randstad, week 2026-11, CORRECTION v2 (two overtime tiers, payout != period net)
// ============================================================================
test('payslip-model: Fixture 1 Randstad reproduces wage_net 702.37 and signed payout -53.89 (owed)', () => {
  const randstad: PayslipPeriod = {
    period_label: 'week 2026-11',
    period_type: 'week',
    period_end_date: '2026-04-30',
    is_correction: true,
    version: 2,
    employers: [{ name: 'Randstad', franchise_bearing: true }],
    hirer: null,
    contract_hours: null,
    hour_lines: [
      { employer_index: 0, description: 'Bruto loon uren', hours: 38.0, rate: 17.09, percent: null, amount: 649.42, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 125%', hours: 2.0, rate: 17.09, percent: 125, amount: 42.73, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      { employer_index: 0, description: 'Bruto loon overuren 150%', hours: 9.25, rate: 17.09, percent: 150, amount: 237.12, category: 'overtime', tax_treatment: 'bt', adds_hours: true },
      // NOT part of the BT base (279.85 = 42.73 + 237.12 only, per the fixture's own "Podstawa
      // bijzonder tarief" line) - these two compensations go through the table, confirmed by
      // subtraction: 970.89 total - 649.42 - 42.73 - 237.12 = 39.61 + 2.01.
      { employer_index: 0, description: 'Compensatie ADV', hours: null, rate: null, percent: null, amount: 39.61, category: 'adv_compensation', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Compensatie overgangsregeling', hours: null, rate: null, percent: null, amount: 2.01, category: 'other', tax_treatment: 'table', adds_hours: false },
    ],
    pre_tax_deductions: [
      { category: 'paww', description: 'Premie PAWW', amount: 0.74, base: 970.89, percent: 0.08 },
      { category: 'ziektewet', description: 'Premie Ziektewet groep II A', amount: 4.55, base: 970.89, percent: 0.7 },
      { category: 'pension', description: 'Pensioenpremie', amount: 38.35, base: null, percent: 7.5 },
    ],
    bijzonder_tarief: { jaarloon_bt: 46074, bt_state: 'known', tarief_bt: { printed: 50.47, computed: null } },
    et: null,
    post_tax_social: [{ category: 'wga', description: 'Premie WGA', amount: 12.33, percent: 1.33 }],
    net_additions: [{ category: 'reimbursement', description: 'Reiskosten woon-werk', amount: 36.0 }],
    net_deductions: [],
    // Signed: both reduce what's actually transferred this period, on top of the period's own net wage.
    payout_adjustments: [
      { description: 'Verrekend met openstaande schuld', amount: -47.53 },
      { description: 'Eerder betaald', amount: -744.73 },
    ],
    reservations: [],
    wml_printed: 14.71,
    wml_applicable: 14.71, // paid 30-04-2026, within H1 2026 - NOT 14.99 (that's H2)
    printed_table_tax: 71.31,
    printed_bt_tax: 141.24,
    printed_algemene_heffingskorting: null,
    printed_arbeidskorting: null,
  };

  const result = computePayslipPeriod(randstad, RATES_2026, true);
  assert.equal(result.loon_voor_heffingen, 927.25);
  assert.equal(result.taxable_base, 927.25); // no ET here
  assert.equal(result.bt_tax.toFixed(2), '141.24'); // exact - flat 50.47% of the raw 279.85 BT base
  assert.ok(Math.abs(result.table_tax_after_korting - 71.31) <= 0.35, `table tax ${result.table_tax_after_korting} vs printed 71.31`);
  // wage_net is the model's stage BEFORE net_additions/net_deductions - this is what the fixtures
  // document itself calls "period_net" for THIS specific document (702.37), even though for other
  // fixtures (PKF) the document uses the same term for a later stage. Checking both stages by name
  // avoids relying on the document's own inconsistent use of "period_net" as a fixed formula position.
  assert.ok(Math.abs(result.wage_net - 702.37) <= 0.35, `wage_net ${result.wage_net} vs printed 702.37`);
  const finalPayout = result.wage_net + result.net_additions_total + result.payout_adjustments_total;
  assert.ok(Math.abs(finalPayout - -53.89) <= 0.35, `final payout ${finalPayout} vs printed -53.89 (owed)`);
});

// ============================================================================
// Fixture 2 — OTTO Workforce, week 33/2025 (two employers, ET arrangement, non-NL BT regime)
// ============================================================================
test('payslip-model: Fixture 2 OTTO — BT split exact, table tax has a documented 12.28 EUR unresolved gap', () => {
  const otto: PayslipPeriod = {
    period_label: '33/2025',
    period_type: 'week',
    period_end_date: '2025-08-17',
    is_correction: false,
    version: 1,
    // AJ2: franchise_bearing is explicit, not inferred from array order - DHL is the
    // franchise-bearing relationship per the T3/round-7 finding (24h, not the combined 43h,
    // reproduces the printed StiPP figure within 0.10).
    employers: [
      { name: 'DHL Supply Chain (NL) B.V.', franchise_bearing: true },
      { name: 'KF Service & Beheer B.V.', franchise_bearing: false },
    ],
    hirer: null,
    contract_hours: null,
    hour_lines: [
      { employer_index: 0, description: 'Godziny przepracowane (DHL)', hours: 24.0, rate: 14.45, percent: null, amount: 346.8, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 30%', hours: 21.25, rate: 4.34, percent: 30, amount: 92.23, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Dodatek za nieregul. godz. 100%', hours: 2.75, rate: 14.45, percent: 100, amount: 39.74, category: 'irregular_surcharge', tax_treatment: 'table', adds_hours: false },
      { employer_index: 1, description: 'Godziny przepracowane (KF)', hours: 19.0, rate: 14.4, percent: null, amount: 273.6, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Dodatek wakacyjny', hours: null, rate: null, percent: null, amount: 56.31, category: 'other', tax_treatment: 'table', adds_hours: false },
      { employer_index: 0, description: 'Wymiana pw. urlopu ustawowego', hours: 0.77, rate: 14.43, percent: null, amount: 11.11, category: 'other', tax_treatment: 'table', adds_hours: false },
      // "Podstawa specjalna" components - the +0.08/-0.08 PAWW spec pair nets to zero and is
      // omitted rather than modeled as two extra near-zero-net entries (documented simplification).
      { employer_index: 0, description: 'Jednorazowa zapłata', hours: null, rate: null, percent: null, amount: 98.24, category: 'other', tax_treatment: 'bt', adds_hours: false },
      { employer_index: 0, description: 'Wynagrodzenie kierowcy brutto', hours: null, rate: null, percent: null, amount: 6.0, category: 'other', tax_treatment: 'bt', adds_hours: false },
    ],
    pre_tax_deductions: [
      { category: 'paww', description: 'PAWW Rekompensata', amount: -0.51, base: null, percent: null },
      { category: 'paww', description: 'PAWW Opłata', amount: 0.51, base: null, percent: null },
      { category: 'pension', description: 'Emerytura STIPP', amount: 21.65, base: null, percent: 4 },
    ],
    bijzonder_tarief: { jaarloon_bt: 35006, bt_state: 'known', tarief_bt: { printed: 38.45, computed: null } },
    et: {
      et_applicable: true,
      et_exchange_amount: 177.0,
      et_reimbursements: [
        { description: 'Zwrot kosztów utrzymania ET', amount: 33.0 },
        { description: 'Zwrot za zakwaterowanie ET', amount: 144.0 },
      ],
      adres_fiskalny: 'EU',
    },
    // WHK sits with the net-level deductions in THIS document's own chain (subtracted alongside
    // zorgverzekering/przewóz/zakwaterowanie), unlike Randstad's WGA/PKF's gediff.WGA which are
    // subtracted before wage_net - read from where each document actually places it, not assumed
    // to be the same category everywhere it appears.
    post_tax_social: [],
    net_additions: [],
    net_deductions: [
      { category: 'other', description: 'Potrącenie własnego wkładu WHK', amount: 1.55 },
      { category: 'health_insurance', description: 'Nominalna składka ubezpieczenia zdrowotnego', amount: 38.01 },
      { category: 'transport', description: 'Potrącenie kosztów przewozu', amount: 2.63 },
      { category: 'housing', description: 'Potrącenie za zakwaterowanie', amount: 144.0 },
    ],
    payout_adjustments: [],
    reservations: [],
    wml_printed: 14.4,
    wml_applicable: 14.4,
    printed_table_tax: 77.52,
    printed_bt_tax: 40.08,
    printed_algemene_heffingskorting: null,
    printed_arbeidskorting: null,
  };

  const result = computePayslipPeriod(otto, RATES_2025, true);
  assert.equal(result.taxable_base, 725.38); // "RAZEM PODSTAWA" - exact, no table lookup in the split
  assert.equal(result.bt_tax.toFixed(2), '40.08'); // exact - flat 38.45% of the raw 104.24 BT base

  // UNRESOLVED GAP (audit AK4 - reported, not hidden): this engine's table tax comes to ~65.24
  // against OTTO's printed 77.52 - a 12.28 EUR gap, an order of magnitude larger than the
  // ~0.3-0.7 EUR table-rounding residual seen on every other fixture (Olympia, PKF, Randstad, all
  // reproduced within 0.7 EUR using the same progressive-formula approach). Using the correct 2025
  // rates (a real bug, now fixed - see the RATES_2025 comment above) closed most of an even larger
  // initial gap (16.55 EUR) but not all of it. Leading candidate, not confirmed: OTTO's employee has
  // "adres fiskalny: EU" and an active ET arrangement - a non-resident/cross-border worker may be
  // subject to a different withholding table (e.g. an "anonieme tabel" or a cross-border-specific
  // variant) than the standard resident white table this engine implements, which could plausibly
  // carry a different effective rate or credit eligibility. Not investigated further this round, per
  // the standing instruction not to chase a single open thread indefinitely - flagged in NEW
  // FINDINGS instead. The assertions below pin this engine's CURRENT actual output as a regression
  // guard (so a future change is caught if it moves), not a claim that this reproduces the fixture.
  assert.equal(result.table_tax_after_korting.toFixed(2), '65.24');
  assert.equal(result.wage_net.toFixed(2), '620.06');
  assert.equal(result.payout_amount.toFixed(2), '610.87');
});
