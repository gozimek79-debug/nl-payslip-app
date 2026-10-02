import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePayrollProfile, type ProfileDocumentInput } from './payroll-profile.js';
import { mergePayslipBatches, mergeContractBatches } from './document-facts.js';
import { buildExtractionTable } from './fact-table.js';
import { payslipBatch, contractBatch, rawPayslip, rawContract, found, ambiguous, hourLine, overtimeLine } from '../test-support/fact-fixtures.js';

/**
 * P2 (ZADANIE-P2-LOONTO-PRO.md §P2.13/§P2.17): document facts -> the unchanged P1/P1.1 resolver.
 * Synthetic reader responses only, mapped by the production mapper.
 */

const AS_OF = '2026-06-01';

function payslip(index: number, label: string, raw: Record<string, unknown>): ProfileDocumentInput {
  return { index, label, role: 'payslip', effectiveDate: null, facts: mergePayslipBatches([payslipBatch(raw)]) };
}
function contract(index: number, label: string, raw: Record<string, unknown>, pages = [1]): ProfileDocumentInput {
  return { index, label, role: 'contract_base', effectiveDate: null, facts: mergeContractBatches([contractBatch(raw, pages)]) };
}
function annex(index: number, label: string, userDate: string | null, raw: Record<string, unknown>): ProfileDocumentInput {
  return { index, label, role: 'contract_annex', effectiveDate: userDate, facts: mergeContractBatches([contractBatch(raw)]) };
}

function premium(category: string, percent: number, semantics: string, raw: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { category, percent, semantics, explicit_tier: null, tier_wording: null, condition: null, status: 'found', raw, page: 1, label: null, ...extra };
}

test('P2.17 #3: page, printed label and raw value survive from extraction into profile provenance', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [
      contract(0, 'umowa.pdf', { hourly_rate: found(16.2, '€ 16,20 bruto per uur', 2, 'Uurloon') }, [1, 2]),
      payslip(1, 'pasek.pdf', rawPayslip()),
    ],
  });
  const rate = profile.employment.hourlyRate;
  assert.equal(rate.state, 'corroborated');
  assert.deepEqual(rate.sources.map((s) => [s.role, s.page, s.printedLabel, s.rawValue]), [
    ['contract_base', 2, 'Uurloon', '€ 16,20 bruto per uur'],
    ['payslip', 1, 'Uren normaal', 'Uren normaal 40,00 16,20 648,00'],
  ]);
  assert.deepEqual(rate.sources[1]?.payPeriod, { label: 'week 10/2026', startDate: null, endDate: '2026-03-08', paymentDate: '2026-03-13', periodType: 'week' });
});

test('P2.17 #4/#5: an ambiguous or implausible fact is excluded with its reason; it never becomes a value and touches no other field', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [contract(0, 'umowa.pdf', {
      hourly_rate: ambiguous('€ 1?,20', 1, 'Uurloon'),
      hours_per_week: found(400, '400 uur per week', 1, 'Arbeidsduur'),
      overtime_threshold_hours: found(2, 'na 2 overuren', 1),
      cao_name: found('ABU-cao', 'ABU-cao', 1),
    })],
  });
  const rate = profile.employment.hourlyRate;
  assert.deepEqual([rate.state, rate.value, rate.excluded[0]?.reason, rate.excluded[0]?.factReason, rate.excluded[0]?.source.rawValue], ['unknown', null, 'ambiguous_on_document', 'reader_marked_ambiguous', '€ 1?,20']);
  const hpw = profile.employment.hoursPerWeek;
  assert.deepEqual([hpw.state, hpw.value, hpw.excluded[0]?.reason, hpw.excluded[0]?.factReason], ['unknown', null, 'implausible_value', 'exceeds_physical_hours_per_week']);
  assert.equal(profile.employment.overtimeThresholdHours.value, 2);
  assert.equal(profile.employment.caoName.value, 'ABU-cao');
});

test('P2.17 #2: a payslip whose period type is unknown still contributes every unrelated readable fact to the profile', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [payslip(0, 'pasek.pdf', rawPayslip({
      period_type: ambiguous('Periode 10'),
      hirer_name: found('Synthetic Client B.V.', 'Opdrachtgever Synthetic Client B.V.', 1, 'Opdrachtgever'),
      hour_lines: [hourLine(), overtimeLine(150)],
      deduction_lines: [
        { description: 'Pensioen StiPP', placement: 'pre_tax', category: 'pension', percent: 7.5, base: 295.06, amount: 22.13, raw: 'Pensioen StiPP 7,50% 295,06 22,13', page: 1, unclear_fields: [] },
        { description: 'PAWW', placement: 'pre_tax', category: 'paww', percent: 0.1, base: 648, amount: 0.65, raw: 'PAWW 0,10% 648,00 0,65', page: 1, unclear_fields: [] },
      ],
      net_lines: [{ description: 'Huisvesting', category: 'housing', amount: 95, raw: 'Huisvesting 95,00-', page: 1, unclear_fields: [] }],
    }))],
  });
  assert.equal(profile.payroll.periodType.state, 'unknown');
  assert.equal(profile.payroll.periodType.excluded[0]?.reason, 'ambiguous_on_document');
  assert.equal(profile.employment.hourlyRate.value, 16.2);
  assert.deepEqual(profile.observedOvertimePremiums.fields.map((f) => f.value), [50]);
  assert.equal(profile.payroll.pensionEmployeePercent.value, 7.5);
  assert.equal(profile.payroll.pawwEmployeePercent.value, 0.1);
  assert.equal(profile.recurringItems.netDeductions[0]?.value, 95);
  assert.equal(profile.employment.payslipEmployerName.value, 'Synthetic Uitzend B.V.');
  assert.equal(profile.employment.hirerName.value, 'Synthetic Client B.V.');
  assert.equal(profile.documents[0]?.payPeriod?.paymentDate, '2026-03-13');
  assert.equal(profile.documents[0]?.payPeriod?.periodType, null);
});

test('P2.17 #10/#12: a generic overtime percentage - payslip or contract, one rate or two - stays a neutral observed premium', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [
      payslip(0, 'pasek.pdf', rawPayslip({ hour_lines: [hourLine(), overtimeLine(150)] })),
      contract(1, 'umowa.pdf', { premiums: [premium('overtime', 125, 'total_multiplier', 'Overwerk 125%'), premium('overtime', 150, 'total_multiplier', 'Overwerk 150%')] }),
    ],
  });
  assert.equal(profile.payroll.overtimeTier1Premium.state, 'unknown');
  assert.equal(profile.payroll.overtimeTier2Premium.state, 'unknown');
  assert.deepEqual(profile.payroll.overtimeTier1Premium.reason, { code: 'tier_identity_not_evidenced' });
  assert.deepEqual(profile.observedOvertimePremiums.fields.map((f) => [f.value, f.state, f.sources.map((s) => s.role)]), [
    [25, 'document_exact', ['contract_base']],
    [50, 'corroborated', ['payslip', 'contract_base']],
  ]);
});

test('P2.17 #11: explicit tier wording on the document populates exactly that tier, with its wording and page', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [contract(0, 'umowa.pdf', {
      overtime_threshold_hours: found(2, 'de eerste 2 overuren', 3),
      premiums: [
        premium('overtime', 125, 'total_multiplier', 'de eerste 2 overuren worden betaald tegen 125%', { explicit_tier: 1, tier_wording: 'de eerste 2 overuren', page: 3, label: 'Overwerk' }),
        premium('overtime', 150, 'total_multiplier', 'daarna tegen 150%', { explicit_tier: 2, tier_wording: 'daarna', page: 3, label: 'Overwerk' }),
      ],
    }, [1, 2, 3])],
  });
  const t1 = profile.payroll.overtimeTier1Premium;
  const t2 = profile.payroll.overtimeTier2Premium;
  assert.deepEqual([t1.state, t1.value, t1.sources[0]?.page, t1.sources[0]?.rawValue], ['document_exact', 25, 3, 'de eerste 2 overuren worden betaald tegen 125%']);
  assert.deepEqual([t2.state, t2.value], ['document_exact', 50]);
  assert.equal(profile.employment.overtimeThresholdHours.value, 2);
  // A payslip line naming its own tier works the same way.
  const fromPayslip = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslip(0, 'pasek.pdf', rawPayslip({ hour_lines: [overtimeLine(125, { explicit_tier: 1, tier_wording: 'Overwerk 1e schijf' })] }))] });
  assert.deepEqual([fromPayslip.payroll.overtimeTier1Premium.value, fromPayslip.payroll.overtimeTier2Premium.state], [25, 'unknown']);
});

test('P2.17 #13: a Saturday/Sunday/holiday premium is populated only from a premium the document itself names for that day', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [contract(0, 'umowa.pdf', {
      premiums: [
        premium('sunday', 200, 'total_multiplier', 'Zondaguren worden betaald tegen 200%', { label: 'Zondag' }),
        premium('saturday', 50, 'premium_above_base', 'Zaterdag: toeslag van 50%', { label: 'Zaterdag' }),
        premium('public_holiday', 200, 'unclear', 'Feestdagen 200%'),
        premium('overtime', 150, 'total_multiplier', 'Overwerk 150%'),
      ],
    })],
  });
  assert.deepEqual([profile.payroll.sundayPremium.state, profile.payroll.sundayPremium.value], ['document_exact', 100]);
  assert.deepEqual([profile.payroll.saturdayPremium.state, profile.payroll.saturdayPremium.value], ['document_exact', 50]);
  const holiday = profile.payroll.publicHolidayPremium;
  assert.deepEqual([holiday.state, holiday.value, holiday.excluded[0]?.reason], ['unknown', null, 'percent_semantics_ambiguous'], 'printed, but whether 200% is the total or the addition is not stated');
  const none = resolvePayrollProfile({ asOfDate: AS_OF, documents: [contract(0, 'umowa.pdf', { premiums: [premium('overtime', 150, 'total_multiplier', 'Overwerk 150%')] })] });
  assert.deepEqual(none.payroll.sundayPremium.reason, { code: 'no_weekday_evidence' }, 'a generic percentage never becomes a weekday premium');
});

test('P2.17 #14: a genuine overtime line with no printed percent is visible excluded evidence', () => {
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslip(0, 'pasek.pdf', rawPayslip({ hour_lines: [hourLine({ description: 'Overuren', kind: 'overtime', percent: null, rate: null, hours: 3, amount: 72.9, raw: 'Overuren 3,00 72,90', page: 1 })] }))] });
  const [ex] = profile.observedOvertimePremiums.excluded;
  assert.deepEqual([ex?.reason, ex?.source.printedLabel, ex?.source.page, ex?.source.rawValue], ['percent_not_printed', 'Overuren', 1, 'Overuren 3,00 72,90']);
  const unclear = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslip(0, 'pasek.pdf', rawPayslip({ hour_lines: [overtimeLine(150, { adds_hours: 'unclear' })] }))] });
  assert.equal(unclear.observedOvertimePremiums.excluded[0]?.reason, 'adds_hours_unclear');
  assert.deepEqual(unclear.observedOvertimePremiums.fields, []);
});

test('P2.17 #8/#9 + P2.6: annex effective date - printed and user dates agree, printed only, missing, or disputed', () => {
  const base = contract(0, 'umowa.pdf', { hourly_rate: found(15.55, 'Uurloon € 15,55', 1, 'Uurloon') });
  const rate = (a: ProfileDocumentInput, asOf = AS_OF) => resolvePayrollProfile({ asOfDate: asOf, documents: [base, a] });
  const annexRaw = (date: Record<string, unknown> | null) => ({ hourly_rate: found(16.2, 'Uurloon € 16,20', 1, 'Uurloon'), ...(date ? { effective_date: date } : {}) });
  const printed = found('2026-03-01', 'met ingang van 1 maart 2026', 1, 'Ingangsdatum');

  const agreed = rate(annex(1, 'aneks.pdf', '2026-03-01', annexRaw(printed)));
  assert.deepEqual([agreed.employment.hourlyRate.value, agreed.contractContext.annexDates[0]?.state], [16.2, 'agreed']);

  const printedOnly = rate(annex(1, 'aneks.pdf', null, annexRaw(printed)));
  assert.deepEqual([printedOnly.employment.hourlyRate.value, printedOnly.contractContext.annexDates[0]?.state, printedOnly.employment.hourlyRate.sources[0]?.effectiveDate], [16.2, 'document_only', '2026-03-01']);

  const missing = rate(annex(1, 'aneks.pdf', null, annexRaw(null)));
  assert.equal(missing.contractContext.annexDates[0]?.state, 'none');
  assert.equal(missing.contractContext.annexDates[0]?.documentDate, null, 'no printed date is ever invented');
  assert.equal(missing.employment.hourlyRate.value, 15.55);
  assert.equal(missing.employment.hourlyRate.excluded[0]?.reason, 'annex_effective_date_missing');

  // Printed 2026-03-01, user entered 2026-07-01, asked as of 2026-06-01: the annex is in force under
  // one date and not under the other - the rate depends on which is right, so neither wins.
  const disputed = rate(annex(1, 'aneks.pdf', '2026-07-01', annexRaw(printed)));
  const field = disputed.employment.hourlyRate;
  assert.deepEqual([field.state, field.value, field.reason], ['conflict', null, { code: 'annex_effective_date_disputed' }]);
  assert.deepEqual(field.candidates.map((c) => c.value).sort(), [15.55, 16.2]);
  assert.deepEqual(disputed.contractContext.annexesDateDisputed.map((d) => d.label), ['aneks.pdf']);
  assert.deepEqual([disputed.contractContext.annexDates[0]?.userEnteredDate, disputed.contractContext.annexDates[0]?.documentDate], ['2026-07-01', '2026-03-01']);

  // The same dispute does not matter when both dates are in the past: no conflict is manufactured.
  const settled = rate(annex(1, 'aneks.pdf', '2026-07-01', annexRaw(printed)), '2026-09-01');
  assert.deepEqual([settled.employment.hourlyRate.state, settled.employment.hourlyRate.value], ['document_exact', 16.2]);
});

test('P2.17 #19: printed tax/net/payout are calibration-only - present in calibrationOnly and the table, never a field', () => {
  const doc = payslip(0, 'pasek.pdf', rawPayslip({
    printed_table_tax: found(52.1, 'Loonheffing 52,10', 1, 'Loonheffing'),
    printed_net: found(512.34, 'Netto loon 512,34', 1, 'Netto loon'),
    printed_payout: found(500, 'Uit te betalen 500,00', 1, 'Uit te betalen'),
  }));
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [doc] });
  assert.deepEqual([profile.calibrationOnly.payslips[0]?.printed.table_tax, profile.calibrationOnly.payslips[0]?.printed.net, profile.calibrationOnly.payslips[0]?.printed.payout], [52.1, 512.34, 500]);
  const allFields = [...Object.values(profile.employment), ...Object.values(profile.payroll), ...Object.values(profile.recurringItems).flat(), ...profile.observedOvertimePremiums.fields];
  for (const f of allFields) for (const v of [52.1, 512.34, 500]) assert.notEqual(f.value, v, `${f.key} must not carry a printed calibration figure`);
  const table = buildExtractionTable([{ documentIndex: 0, documentLabel: 'pasek.pdf', role: 'payslip', facts: doc.facts }]);
  for (const key of ['payslip.printedTableTax', 'payslip.printedNet', 'payslip.printedPayout']) {
    assert.equal(table.find((r) => r.key === key)?.destination, 'calibrationOnly');
  }
});

test('P2.14: the extraction table names, per fact, its page, raw text, status and destination - including absent and rejected facts', () => {
  const doc = contract(0, 'umowa.pdf', {
    hourly_rate: found(16.2, '€ 16,20 per uur', 2, 'Uurloon'),
    hours_per_week: found(400, '400 uur', 1),
    premiums: [premium('overtime', 150, 'unclear', 'Overwerk 150%')],
  }, [1, 2]);
  const table = buildExtractionTable([{ documentIndex: 0, documentLabel: 'umowa.pdf', role: 'contract_base', facts: doc.facts }]);
  const row = (key: string) => table.find((r) => r.key === key);
  assert.deepEqual([row('contract.hourlyRate')?.value, row('contract.hourlyRate')?.page, row('contract.hourlyRate')?.rawValue, row('contract.hourlyRate')?.destination], [16.2, 2, '€ 16,20 per uur', 'employment.hourlyRate']);
  assert.deepEqual([row('contract.hoursPerWeek')?.status, row('contract.hoursPerWeek')?.reason], ['implausible', 'exceeds_physical_hours_per_week']);
  assert.deepEqual([row('contract.endDate')?.status, row('contract.endDate')?.value], ['absent', null]);
  assert.deepEqual([row('contract.premium.overtime.unclear')?.reason, row('contract.premium.overtime.unclear')?.destination], ['percent_semantics_ambiguous', 'observedOvertimePremiums']);
});
