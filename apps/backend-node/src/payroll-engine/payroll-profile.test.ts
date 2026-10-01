import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePayrollProfile, USABLE_EVIDENCE_STATES, type ProfileDocumentInput, type ProfileField } from './payroll-profile.js';
import { computePayslipPeriod, known, unknownField, type HourLine, type PayslipComputationRates, type PayslipPeriod } from './payslip-model.js';
import { comparePeriodToDocument } from './discrepancy.js';
import { checkExtractionConsistency } from './extraction-consistency.js';
import type { ContractExtraction } from './contract.js';

/**
 * P1 (ZADANIE-P1-LOONTO-PRO.md §P1.8): the Payroll Profile resolver. Every fixture here is
 * synthetic - no real owner document, no AI call. Numbered tests map 1:1 onto §P1.8's list.
 */

function extraction(overrides: Partial<ContractExtraction> = {}): ContractExtraction {
  return {
    contractType: null, employerName: null, functionTitle: null, startDate: null, endDate: null,
    hoursPerWeek: null, hourlyRate: null, monthlySalary: null, caoName: null, pensionFund: null,
    probationPeriodWeeks: null, noticePeriodWeeks: null, thirtyPercentRuling: false,
    overtimeTierThresholdHours: null, guaranteedHours: null, guaranteedHoursPeriodWeeks: null,
    redactedFields: [],
    ...overrides,
  };
}

function hourLine(overrides: Partial<HourLine>): HourLine {
  return { employer_index: 0, description: 'Uren', hours: 40, rate: 16.2, percent: null, amount: 648, category: 'regular', tax_treatment: 'table', adds_hours: true, ...overrides };
}

function period(overrides: Partial<PayslipPeriod> = {}): PayslipPeriod {
  return {
    period_label: 'week 10/2026', period_type: 'week', period_type_confirmed: true, period_end_date: '2026-03-08',
    is_correction: false, version: 1, employers: [{ name: 'Synthetic Uitzend B.V.', franchise_bearing: true }], hirer: null,
    contract_hours: null, hour_lines: [hourLine({})], pre_tax_deductions: [],
    bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
    et: null, post_tax_social: [], net_additions: [], net_deductions: [], payout_adjustments: [], reservations: [],
    wml_printed: null, wml_applicable: null,
    printed_table_tax: null, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
    printed_net: null, printed_payout: null, printed_gross_total: null, printed_loon_voor_heffingen: null,
    printed_taxable_base_normal: null, printed_taxable_base_special: null,
    printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null,
    printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
    ...overrides,
  };
}

function contractDoc(index: number, label: string, overrides: Partial<ContractExtraction>): ProfileDocumentInput {
  return { index, label, role: 'contract_base', effectiveDate: null, contractExtraction: extraction(overrides) };
}
function annexDoc(index: number, label: string, effectiveDate: string | null, overrides: Partial<ContractExtraction>): ProfileDocumentInput {
  return { index, label, role: 'contract_annex', effectiveDate, contractExtraction: extraction(overrides) };
}
function payslipDoc(index: number, label: string, p: PayslipPeriod, unreadableFieldPaths: string[] = []): ProfileDocumentInput {
  return { index, label, role: 'payslip', effectiveDate: null, payslip: { period: p, unreadableFieldPaths } };
}

const AS_OF = '2026-06-01';

function isUsable(field: ProfileField): boolean {
  return USABLE_EVIDENCE_STATES.includes(field.state) && field.value !== null;
}

/** A payslip with genuine overtime at 125% and 150% on top of regular hours. */
function overtimePeriod(overrides: Partial<PayslipPeriod> = {}): PayslipPeriod {
  return period({
    hour_lines: [
      hourLine({}),
      hourLine({ description: 'Overwerk uren 125%', hours: 4, rate: 16.2, percent: 125, amount: 81, category: 'overtime', adds_hours: true }),
      hourLine({ description: 'Overwerk uren 150%', hours: 6, rate: 16.2, percent: 150, amount: 145.8, category: 'overtime', adds_hours: true }),
    ],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------

test('P1.8 #1: contract hourly rate only -> document_exact, sourced to the base contract', () => {
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [contractDoc(0, 'umowa.pdf', { hourlyRate: 16.2 })] });
  const rate = profile.employment.hourlyRate;
  assert.equal(rate.state, 'document_exact');
  assert.equal(rate.value, 16.2);
  assert.equal(rate.sources.length, 1);
  assert.equal(rate.sources[0]?.role, 'contract_base');
  assert.equal(rate.sources[0]?.documentLabel, 'umowa.pdf');
  assert.equal(rate.sources[0]?.documentIndex, 0);
  assert.equal(rate.reason, null);
});

test('P1.8 #2: the same hourly rate from a contract and a payslip -> corroborated, both sources kept', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [contractDoc(0, 'umowa.pdf', { hourlyRate: 16.2 }), payslipDoc(1, 'pasek-10.pdf', period())],
  });
  const rate = profile.employment.hourlyRate;
  assert.equal(rate.state, 'corroborated');
  assert.equal(rate.value, 16.2);
  assert.deepEqual(rate.sources.map((s) => s.role), ['contract_base', 'payslip']);
  assert.equal(rate.sources[1]?.printedLabel, 'Uren');
  assert.equal(rate.sources[1]?.payPeriod?.label, 'week 10/2026');
});

test('P1.8 #3: different contract and payslip hourly rates -> conflict, every candidate kept, no silent winner', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [contractDoc(0, 'umowa.pdf', { hourlyRate: 15.55 }), payslipDoc(1, 'pasek-10.pdf', period())],
  });
  const rate = profile.employment.hourlyRate;
  assert.equal(rate.state, 'conflict');
  assert.equal(rate.value, null, 'a conflict carries no value - neither the contract nor the payslip is chosen');
  assert.deepEqual(rate.reason, { code: 'sources_disagree' });
  assert.deepEqual(rate.candidates.map((c) => [c.value, c.source.role]), [[15.55, 'contract_base'], [16.2, 'payslip']]);
});

test('P1.8 #4 / #12: a payslip with a real discrepancy and consistency findings still contributes its overtime evidence', () => {
  // A tax figure printed far from anything the engine computes - a guaranteed `finding` - and a
  // printed gross total that does not reconcile with the lines - a guaranteed consistency issue.
  const p = overtimePeriod({ printed_table_tax: 999, printed_gross_total: 1, wml_printed: 14.71, wml_applicable: 14.99 });
  const rates: PayslipComputationRates = {
    loonheffing_brackets: [{ min: 0, max: 999999999, rate: 0.3575 }],
    heffingskortingen: {
      algemene_heffingskorting: { max_amount: 3115, phaseout_start: 29736, phaseout_rate: 0.06398 },
      arbeidskorting: { max_amount: 5685, phaseout_start: 45592, phaseout_rate: 0.0651, buildup_tiers: [{ max: 45592, rate: 0.1 }] },
    },
    period_multiplier: 52,
  };
  const outcome = computePayslipPeriod(p, rates, true);
  const discrepancies = comparePeriodToDocument(p, outcome);
  const issues = checkExtractionConsistency(null, p, outcome);
  assert.ok(discrepancies.some((d) => d.status === 'finding'), 'precondition: this payslip has a real audit finding (under the old gate: not "fully reproduced")');
  assert.ok(issues.length > 0, 'precondition: this payslip also has open consistency issues');

  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'pasek.pdf', p)] });
  assert.equal(profile.payroll.overtimeTier1Premium.state, 'document_exact');
  assert.equal(profile.payroll.overtimeTier1Premium.value, 25);
  assert.equal(profile.payroll.overtimeTier2Premium.state, 'document_exact');
  assert.equal(profile.payroll.overtimeTier2Premium.value, 50);
  assert.equal(profile.employment.hourlyRate.state, 'document_exact');
});

test('P1.8 #5: one genuine overtime line printed at 150% -> profile premium +50 (never +150)', () => {
  const p = period({ hour_lines: [hourLine({}), hourLine({ description: 'Overuren 150%', hours: 10, percent: 150, amount: 243, category: 'overtime', adds_hours: true })] });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'pasek.pdf', p)] });
  const tier1 = profile.payroll.overtimeTier1Premium;
  assert.equal(tier1.value, 50);
  assert.equal(tier1.unit, 'premium_percent');
  assert.equal(tier1.candidates[0]?.detail?.printedPercent, 150);
  assert.equal(tier1.sources[0]?.printedLabel, 'Overuren 150%');
  assert.equal(profile.payroll.overtimeTier2Premium.state, 'unknown', 'one distinct percentage is one tier - no second tier is invented');
});

test('P1.8 #6: two payslips with the same overtime premiums -> corroborated', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [payslipDoc(0, 'pasek-10.pdf', overtimePeriod()), payslipDoc(1, 'pasek-11.pdf', overtimePeriod({ period_label: 'week 11/2026', period_end_date: '2026-03-15' }))],
  });
  assert.equal(profile.payroll.overtimeTier1Premium.state, 'corroborated');
  assert.equal(profile.payroll.overtimeTier1Premium.value, 25);
  assert.deepEqual(profile.payroll.overtimeTier1Premium.sources.map((s) => s.documentIndex), [0, 1]);
  assert.equal(profile.payroll.overtimeTier2Premium.state, 'corroborated');
});

test('P1.8 #7: two payslips with different overtime premiums -> conflict with both candidates', () => {
  const later = overtimePeriod({
    period_label: 'week 11/2026',
    hour_lines: [hourLine({}), hourLine({ description: 'Overwerk uren 130%', hours: 4, percent: 130, amount: 84.24, category: 'overtime', adds_hours: true }), hourLine({ description: 'Overwerk uren 150%', hours: 6, percent: 150, amount: 145.8, category: 'overtime', adds_hours: true })],
  });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'a.pdf', overtimePeriod()), payslipDoc(1, 'b.pdf', later)] });
  const tier1 = profile.payroll.overtimeTier1Premium;
  assert.equal(tier1.state, 'conflict');
  assert.equal(tier1.value, null);
  assert.deepEqual(tier1.candidates.map((c) => [c.value, c.source.documentLabel]), [[25, 'a.pdf'], [30, 'b.pdf']]);
  assert.equal(profile.payroll.overtimeTier2Premium.state, 'corroborated', 'the tier the two payslips agree on is unaffected by the other tier\'s conflict');
});

test('P1.8 #8: pension known while Sunday premium unknown -> pension remains usable', () => {
  const p = period({ pre_tax_deductions: [{ category: 'pension', description: 'StiPP Pensioen Basis', amount: known(22.13, 'payslip_extracted'), base: 295.06, percent: 7.5 }] });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'pasek.pdf', p)] });
  assert.equal(profile.payroll.pensionEmployeePercent.state, 'document_exact');
  assert.equal(profile.payroll.pensionEmployeePercent.value, 7.5);
  assert.equal(profile.payroll.pensionEmployeePercent.candidates[0]?.detail?.base, 295.06);
  assert.equal(profile.payroll.sundayPremium.state, 'unknown');
  assert.deepEqual(profile.payroll.sundayPremium.reason, { code: 'no_weekday_evidence' });
  assert.ok(isUsable(profile.payroll.pensionEmployeePercent));
});

test('P1.8 #9: one conflict and several unknowns do not invalidate any other resolved field', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [
      contractDoc(0, 'umowa.pdf', { hourlyRate: 15.55, hoursPerWeek: 40, overtimeTierThresholdHours: 2 }),
      payslipDoc(1, 'pasek.pdf', overtimePeriod()), // regular rate 16.20 -> hourlyRate conflict
    ],
  });
  assert.equal(profile.employment.hourlyRate.state, 'conflict');
  assert.equal(profile.payroll.saturdayPremium.state, 'unknown');
  assert.equal(profile.payroll.pensionEmployeePercent.state, 'unknown');
  // Everything else that has evidence still resolves.
  assert.ok(isUsable(profile.employment.hoursPerWeek));
  assert.ok(isUsable(profile.employment.overtimeThresholdHours));
  assert.ok(isUsable(profile.payroll.overtimeTier1Premium));
  assert.ok(isUsable(profile.payroll.overtimeTier2Premium));
  assert.ok(isUsable(profile.payroll.periodType));
});

test('P1.8 #10: guaranteed hours / hours per week / threshold keep contract source and annex effective-date provenance', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [
      contractDoc(0, 'umowa.pdf', { hoursPerWeek: 40, guaranteedHours: 64, guaranteedHoursPeriodWeeks: 4, overtimeTierThresholdHours: 2 }),
      annexDoc(1, 'aneks-1.pdf', '2026-03-01', { overtimeTierThresholdHours: 3 }),
      annexDoc(2, 'aneks-2.pdf', '2026-09-01', { hoursPerWeek: 32 }), // not yet in force on AS_OF
    ],
  });
  const { hoursPerWeek, guaranteedHours, guaranteedHoursPeriodWeeks, overtimeThresholdHours } = profile.employment;
  assert.equal(hoursPerWeek.value, 40);
  assert.deepEqual([hoursPerWeek.sources[0]?.role, hoursPerWeek.sources[0]?.documentLabel, hoursPerWeek.sources[0]?.effectiveDate], ['contract_base', 'umowa.pdf', null]);
  assert.equal(guaranteedHours.value, 64);
  assert.equal(guaranteedHoursPeriodWeeks.value, 4);
  assert.equal(guaranteedHours.sources[0]?.role, 'contract_base');
  assert.equal(overtimeThresholdHours.value, 3, 'the annex overrides only the field it states');
  assert.deepEqual([overtimeThresholdHours.sources[0]?.role, overtimeThresholdHours.sources[0]?.documentLabel, overtimeThresholdHours.sources[0]?.effectiveDate], ['contract_annex', 'aneks-1.pdf', '2026-03-01']);
  assert.deepEqual(profile.contractContext.annexesInForce.map((d) => d.label), ['aneks-1.pdf']);
  assert.deepEqual(profile.contractContext.annexesNotYetInForce.map((d) => d.label), ['aneks-2.pdf']);
});

test('P1.8 #11: printed tax / net / payout are calibration-only - changing them changes no profile field', () => {
  const clean = overtimePeriod({ pre_tax_deductions: [{ category: 'paww', description: 'PAWW', amount: known(0.65, 'payslip_extracted'), base: 648, percent: 0.1 }] });
  const wild: PayslipPeriod = { ...clean, printed_table_tax: 12345, printed_bt_tax: 999, printed_net: 1, printed_payout: 77777, printed_gross_total: 3, printed_loon_voor_heffingen: 4, printed_algemene_heffingskorting: 5, printed_arbeidskorting: 6, wml_printed: 1 };
  const a = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'p.pdf', clean)] });
  const b = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'p.pdf', wild)] });
  assert.deepEqual(b.employment, a.employment);
  assert.deepEqual(b.payroll, a.payroll);
  assert.deepEqual(b.recurringItems, a.recurringItems);
  assert.equal(b.calibrationOnly.payslips[0]?.printed.table_tax, 12345);
  assert.equal(b.calibrationOnly.payslips[0]?.printed.net, 1);
  assert.equal(b.calibrationOnly.payslips[0]?.printed.payout, 77777);
});

test('P1.8 #14: unknown never silently becomes a default value', () => {
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [contractDoc(0, 'umowa.pdf', {})] });
  const all: ProfileField[] = [...Object.values(profile.employment), ...Object.values(profile.payroll)];
  for (const field of all) {
    if (field.state === 'unknown' || field.state === 'conflict') assert.equal(field.value, null, `${field.key} is ${field.state} but carries a value`);
    if (field.state === 'unknown') assert.notEqual(field.reason, null, `${field.key} is unknown with no stated reason`);
  }
  assert.deepEqual(profile.employment.hourlyRate.reason, { code: 'not_on_documents' });
  assert.deepEqual(profile.employment.hoursPerWeek.reason, { code: 'not_in_contract_extraction' });
  assert.deepEqual(profile.payroll.overtimeTier1Premium.reason, { code: 'no_payslip_document' });
  assert.deepEqual(profile.payroll.loonheffingskorting.reason, { code: 'no_evidence_source' });
  assert.deepEqual(profile.employment.phase.reason, { code: 'not_a_separate_extraction_field' });
});

// --- further P1 semantics -------------------------------------------------------------------

test('P1.3: a timeline disagreement becomes a field-level conflict with each document\'s own value - other fields resolve normally', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [
      contractDoc(0, 'umowa.pdf', { hourlyRate: 15.55, hoursPerWeek: 40 }),
      annexDoc(1, 'aneks.pdf', '2026-03-01', { hourlyRate: 16.2 }),
      annexDoc(2, 'aneks.pdf', '2026-03-01', { hourlyRate: 16.5 }), // same filename on purpose
    ],
  });
  const rate = profile.employment.hourlyRate;
  assert.equal(rate.state, 'conflict');
  assert.deepEqual(rate.reason, { code: 'timeline_disagreement', asOfDate: AS_OF });
  assert.deepEqual(rate.candidates.map((c) => [c.value, c.source.documentIndex]), [[16.2, 1], [16.5, 2]], 'two files with the same name still map back to the right documents');
  assert.equal(profile.employment.hoursPerWeek.state, 'document_exact');
});

test('P1.3: an undated annex is excluded evidence with a reason - never trusted, never silently dropped', () => {
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [annexDoc(0, 'aneks.pdf', null, { hourlyRate: 17 })] });
  const rate = profile.employment.hourlyRate;
  assert.equal(rate.state, 'unknown');
  assert.deepEqual(rate.reason, { code: 'only_excluded_evidence' });
  assert.equal(rate.excluded[0]?.reason, 'annex_effective_date_missing');
  assert.equal(rate.excluded[0]?.value, 17);
  assert.deepEqual(profile.contractContext.annexesUndated.map((d) => d.label), ['aneks.pdf']);
});

test('P1.3: profile text values are the raw values given - nothing is translated or rewritten', () => {
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [contractDoc(0, 'umowa.pdf', { caoName: 'ABU-cao', contractType: 'Uitzendovereenkomst fase A', employerName: 'Synthetic Uitzend B.V.' })] });
  assert.equal(profile.employment.caoName.value, 'ABU-cao');
  assert.equal(profile.employment.contractType.value, 'Uitzendovereenkomst fase A');
  assert.equal(profile.employment.phase.state, 'unknown', 'a phase inside the contract-type text is not parsed into a separate field');
});

test('P1.4: a surcharge line (adds_hours false) stays surcharge evidence and never becomes an overtime tier', () => {
  const p = period({
    hour_lines: [
      hourLine({ hours: 45, amount: 729 }),
      hourLine({ description: 'Loon onregelm. uren 100%', hours: 3, percent: 100, amount: 48.6, category: 'irregular_surcharge', adds_hours: false }),
      hourLine({ description: 'Toeslag overuren 50%', hours: 2, percent: 50, amount: 16.2, category: 'overtime', adds_hours: false }),
    ],
  });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'pasek.pdf', p)] });
  assert.equal(profile.payroll.overtimeTier1Premium.state, 'unknown');
  assert.deepEqual(profile.recurringItems.surcharges.map((f) => [f.key, f.value, f.unit]), [
    ['surcharge:irregular_surcharge:loon onregelm. uren 100%', 100, 'surcharge_percent'],
    ['surcharge:overtime_surcharge:toeslag overuren 50%', 50, 'surcharge_percent'],
  ]);
});

test('P1.4: an overtime line printed below 100% is excluded as ambiguous, not turned into a negative premium', () => {
  const p = period({ hour_lines: [hourLine({}), hourLine({ description: 'Overuren 25%', hours: 2, percent: 25, amount: 8.1, category: 'overtime', adds_hours: true })] });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'pasek.pdf', p)] });
  const tier1 = profile.payroll.overtimeTier1Premium;
  assert.equal(tier1.state, 'unknown');
  assert.equal(tier1.value, null);
  assert.equal(tier1.excluded[0]?.reason, 'percent_semantics_ambiguous');
});

test('P1.4: a third distinct overtime percentage is kept as an additional tier, never dropped', () => {
  const p = overtimePeriod({
    hour_lines: [hourLine({}), ...[125, 150, 200].map((pct) => hourLine({ description: `Overwerk ${pct}%`, hours: 1, percent: pct, amount: 16.2 * pct / 100, category: 'overtime', adds_hours: true }))],
  });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'pasek.pdf', p)] });
  assert.equal(profile.payroll.overtimeTier1Premium.value, 25);
  assert.equal(profile.payroll.overtimeTier2Premium.value, 100);
  assert.deepEqual(profile.payroll.overtimeAdditionalTierPremiums.value, [50]);
});

test('P1.4: recurring net items - same amount on two payslips corroborates; an unreadable amount is excluded, not a zero', () => {
  const housing = { category: 'housing' as const, description: 'Huisvesting', amount: 95 };
  const a = period({ net_deductions: [housing], net_additions: [{ category: 'reimbursement', description: 'Reiskosten', amount: 12.5 }] });
  const b = period({ period_label: 'week 11/2026', net_deductions: [housing], net_additions: [{ category: 'reimbursement', description: 'Reiskosten', amount: 0 }] });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'a.pdf', a), payslipDoc(1, 'b.pdf', b, ['net_additions[0].amount'])] });
  const [housingField] = profile.recurringItems.netDeductions;
  assert.equal(housingField?.state, 'corroborated');
  assert.equal(housingField?.value, 95);
  const [travel] = profile.recurringItems.netAdditions;
  assert.equal(travel?.state, 'document_exact', 'the unreadable 0 on b.pdf is excluded, so it neither corroborates nor conflicts');
  assert.equal(travel?.value, 12.5);
  assert.equal(travel?.excluded[0]?.reason, 'amount_unreadable');
});

test('P1.4: a deduction line without a printed percentage is excluded evidence, its amount kept for inspection', () => {
  const p = period({ pre_tax_deductions: [{ category: 'ziektewet', description: 'AZW werknemer', amount: known(4.9, 'payslip_extracted'), base: null, percent: null }, { category: 'paww', description: 'PAWW', amount: unknownField(), base: null, percent: 0.1 }] });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'pasek.pdf', p)] });
  assert.equal(profile.payroll.sectorPremiumPercent.state, 'unknown');
  assert.equal(profile.payroll.sectorPremiumPercent.excluded[0]?.reason, 'percent_not_printed');
  assert.equal(profile.payroll.sectorPremiumPercent.excluded[0]?.detail?.amount, 4.9);
  assert.equal(profile.payroll.pawwEmployeePercent.value, 0.1, 'an unread AMOUNT does not invalidate a printed RATE');
});

test('P1.4: an unconfirmed period type is excluded; a payslip whose period type was not read still contributes overtime evidence', () => {
  const p = overtimePeriod({ period_type_confirmed: false });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'pasek.pdf', p)] });
  assert.equal(profile.payroll.periodType.state, 'unknown');
  assert.equal(profile.payroll.periodType.excluded[0]?.reason, 'period_type_unconfirmed');
  assert.equal(profile.payroll.overtimeTier1Premium.value, 25);
  assert.equal(profile.payroll.overtimeTier1Premium.sources[0]?.payPeriod?.periodType, null);
});

test('P1: two lines of one payslip agreeing is still one document - document_exact, not corroborated', () => {
  const p = period({ hour_lines: [hourLine({ employer_index: 0 }), hourLine({ description: 'Uren (2)', employer_index: 0 })] });
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslipDoc(0, 'pasek.pdf', p)] });
  assert.equal(profile.employment.hourlyRate.state, 'document_exact');
  assert.equal(profile.employment.hourlyRate.sources.length, 2);
});
