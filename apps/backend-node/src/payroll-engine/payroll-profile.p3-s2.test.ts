import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePayrollProfile, type ProfileDocumentInput, type ProfileField, type PayrollProfile } from './payroll-profile.js';
import { mergePayslipBatches, mergeContractBatches } from './document-facts.js';
import { payslipBatch, contractBatch, rawPayslip, rawContract, found, ambiguous, absent, hourLine } from '../test-support/fact-fixtures.js';

/**
 * P3.1 S2 (LOONTO-PRO-P3-DECISION-LOCK.md, decision A; ZADANIE-P3.1-S2-REGIME-PLACEMENT.md): regime-aware
 * placement of payslip evidence for fields with both contract-timeline and payslip evidence, superseded
 * contract evidence, A3a/A3b, A4, disputed annex dates per variant, `documentId` provenance and
 * profile `version: 2`. Synthetic reader responses only, mapped by the production mapper.
 */

const fmt = (n: number) => n.toFixed(2).replace('.', ',');

function rateLine(rate: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const amount = Math.round(40 * rate * 100) / 100;
  return hourLine({ rate, amount, raw: `Uren normaal 40,00 ${fmt(rate)} ${fmt(amount)}`, ...extra });
}

/** Printed period start/end and payment date; `null` = not printed. */
function period(start: string | null, end: string | null, payment: string | null = null): Record<string, unknown> {
  return {
    period_start: start ? found(start, `van ${start}`, 1, 'Periode') : absent,
    period_end: end ? found(end, `t/m ${end}`, 1, 'Periode') : absent,
    payment_date: payment ? found(payment, `betaald ${payment}`, 1, 'Betaaldatum') : absent,
  };
}

function payslip(index: number, label: string, rate: number, when: Record<string, unknown>, extra: Record<string, unknown> = {}, documentId?: string): ProfileDocumentInput {
  return { index, ...(documentId ? { documentId } : {}), label, role: 'payslip', effectiveDate: null, facts: mergePayslipBatches([payslipBatch(rawPayslip({ ...when, hour_lines: [rateLine(rate)], ...extra }))]) };
}

function baseContract(index: number, raw: Record<string, unknown>, documentId?: string): ProfileDocumentInput {
  return { index, ...(documentId ? { documentId } : {}), label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, facts: mergeContractBatches([contractBatch(rawContract(raw))]) };
}

function annex(index: number, label: string, userDate: string | null, raw: Record<string, unknown>, documentId?: string): ProfileDocumentInput {
  return { index, ...(documentId ? { documentId } : {}), label, role: 'contract_annex', effectiveDate: userDate, facts: mergeContractBatches([contractBatch(rawContract(raw))]) };
}

const rate = (value: number) => ({ hourly_rate: found(value, `Uurloon € ${fmt(value)}`, 1, 'Uurloon') });
const BASE_1620 = () => baseContract(0, rate(16.2));
const ANNEX_1680 = (date: string | null = '2026-09-01') => annex(1, 'aneks.pdf', date, rate(16.8));

function resolve(asOfDate: string, documents: ProfileDocumentInput[]): PayrollProfile {
  return resolvePayrollProfile({ asOfDate, documents });
}

/** [reason, relation, boundary date, boundary label, value, document label] per excluded entry. */
const placed = (f: ProfileField) => f.excluded.map((x) => [x.reason, x.regime?.relation ?? null, x.regime?.effectiveDate ?? null, x.regime?.documentLabel ?? null, x.value, x.source.documentLabel]);
const values = (f: ProfileField) => f.candidates.map((c) => [c.value, c.source.role, c.source.documentLabel]);

// ---------------------------------------------------------------------------------------------
// Canonical matrix
// ---------------------------------------------------------------------------------------------

test('P3 #1 (A1): a payslip ending before the in-force annex is superseded history - no conflict, the annex decides, the old base value is shown superseded too', () => {
  const p = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek-sierpien.pdf', 16.2, period('2026-08-25', '2026-08-31'))]);
  const f = p.employment.hourlyRate;
  assert.deepEqual([f.state, f.value, f.reason], ['document_exact', 16.8, null], 'no current conflict and no user question');
  assert.deepEqual(values(f), [[16.8, 'contract_annex', 'aneks.pdf']]);
  assert.deepEqual(placed(f), [
    ['superseded_by_later_document', 'superseded_by', '2026-09-01', 'aneks.pdf', 16.2, 'umowa.pdf'],
    ['superseded_by_later_document', 'superseded_by', '2026-09-01', 'aneks.pdf', 16.2, 'pasek-sierpien.pdf'],
  ]);
  assert.deepEqual(f.regime, { start: '2026-09-01', end: null, winnerDocumentIndex: 1, winnerDocumentId: null, winnerDocumentLabel: 'aneks.pdf' });
});

test('P3 #2 (A2 / O2): a payslip inside the annex regime with another rate is a genuine conflict - contractual and employer-applied candidates, no winner', () => {
  const p = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek-wrzesien.pdf', 16.2, period('2026-09-01', '2026-09-07'))]);
  const f = p.employment.hourlyRate;
  assert.deepEqual([f.state, f.value, f.reason], ['conflict', null, { code: 'sources_disagree' }]);
  assert.deepEqual(values(f), [[16.8, 'contract_annex', 'aneks.pdf'], [16.2, 'payslip', 'pasek-wrzesien.pdf']]);
  assert.deepEqual(f.sources.map((s) => s.role), ['contract_annex', 'payslip']);
  assert.deepEqual(placed(f), [['superseded_by_later_document', 'superseded_by', '2026-09-01', 'aneks.pdf', 16.2, 'umowa.pdf']], 'only the overridden base value is history; the in-regime payslip is not');
});

test('P3 #3 (A3a): an undated payslip with a value other than the in-force contract stays a candidate and forces a payslip_period_unplaceable conflict', () => {
  const p = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek-bez-daty.pdf', 16.2, period(null, null, '2026-09-11'))]);
  const f = p.employment.hourlyRate;
  assert.deepEqual([f.state, f.value, f.reason], ['conflict', null, { code: 'payslip_period_unplaceable', changeDate: '2026-09-01' }]);
  assert.deepEqual(values(f), [[16.8, 'contract_annex', 'aneks.pdf'], [16.2, 'payslip', 'pasek-bez-daty.pdf']], 'the contract candidate is kept; the payslip keeps its full evidence');
  assert.deepEqual([f.candidates[1]?.source.payPeriod?.startDate, f.candidates[1]?.source.payPeriod?.endDate, f.candidates[1]?.source.rawValue], [null, null, 'Uren normaal 40,00 16,20 648,00']);
});

test('P3 #4 (A4): a later in-force annex stating the rate unreadably or implausibly is a later_document_unclear conflict - never a false document_exact', () => {
  for (const [annexRate, reason, factReason] of [
    [ambiguous('Uurloon € 1?,80', 1, 'Uurloon'), 'ambiguous_on_document', 'reader_marked_ambiguous'],
    [found(1680, 'Uurloon € 1680', 1, 'Uurloon'), 'implausible_value', 'exceeds_plausible_hourly_rate'],
  ] as const) {
    const p = resolve('2026-09-15', [baseContract(0, rate(16.2), 'doc-base'), annex(1, 'aneks.pdf', '2026-09-01', { hourly_rate: annexRate }, 'doc-annex')]);
    const f = p.employment.hourlyRate;
    assert.deepEqual([f.state, f.value], ['conflict', null], `${reason}: no silent fallback to the earlier value`);
    assert.deepEqual(f.reason, { code: 'later_document_unclear', documentIndex: 1, documentId: 'doc-annex', effectiveDate: '2026-09-01' });
    assert.deepEqual(values(f), [[16.2, 'contract_base', 'umowa.pdf']], 'the earlier readable value is the single candidate');
    assert.deepEqual(f.excluded.map((x) => [x.reason, x.factReason, x.source.documentLabel, x.source.effectiveDate, x.value]), [[reason, factReason, 'aneks.pdf', '2026-09-01', null]]);
  }
});

test('P3 #4 (A4 scope): an unclear payslip never triggers A4, and an unclear annex not yet in force does not either', () => {
  const unclearSlip = resolve('2026-09-15', [BASE_1620(), payslip(1, 'pasek.pdf', 16.2, period('2026-09-07', '2026-09-13'), { hour_lines: [rateLine(16.2, { rate: null, unclear_fields: ['rate'] })] })]);
  assert.deepEqual([unclearSlip.employment.hourlyRate.state, unclearSlip.employment.hourlyRate.value], ['document_exact', 16.2]);
  assert.equal(unclearSlip.employment.hourlyRate.excluded[0]?.reason, 'ambiguous_on_document');
  const futureUnclear = resolve('2026-06-15', [BASE_1620(), annex(1, 'aneks.pdf', '2026-09-01', { hourly_rate: ambiguous('Uurloon € 1?,80', 1, 'Uurloon') })]);
  assert.deepEqual([futureUnclear.employment.hourlyRate.state, futureUnclear.employment.hourlyRate.value, futureUnclear.employment.hourlyRate.reason], ['document_exact', 16.2, null]);
});

test('P3 #14: no majority vote - three in-regime payslips at 16.20 against the annex 16.80 are still a conflict', () => {
  const p = resolve('2026-09-30', [
    BASE_1620(), ANNEX_1680(),
    payslip(2, 'w36.pdf', 16.2, period('2026-09-01', '2026-09-07')),
    payslip(3, 'w37.pdf', 16.2, period('2026-09-08', '2026-09-14')),
    payslip(4, 'w38.pdf', 16.2, period('2026-09-15', '2026-09-21')),
  ]);
  const f = p.employment.hourlyRate;
  assert.deepEqual([f.state, f.value, f.reason], ['conflict', null, { code: 'sources_disagree' }]);
  assert.deepEqual(f.candidates.map((c) => c.value), [16.8, 16.2, 16.2, 16.2]);
});

test('P3 #16: a disputed annex date - placement is per variant, and a field whose placement depends on the date stays annex_effective_date_disputed', () => {
  // Printed 2026-08-01, user-entered 2026-09-01; as of 2026-10-01 the annex is in force under both.
  const disputedAnnex = () => annex(1, 'aneks.pdf', '2026-09-01', { ...rate(16.8), effective_date: found('2026-08-01', 'met ingang van 1 augustus 2026', 1, 'Ingangsdatum') });
  const at = (slip: ProfileDocumentInput) => resolve('2026-10-01', [BASE_1620(), disputedAnnex(), slip]).employment.hourlyRate;

  // An August payslip at 16.20: superseded under the user date, in the regime (a conflict) under the printed one.
  const differs = at(payslip(2, 'pasek-sierpien.pdf', 16.2, period('2026-08-10', '2026-08-16')));
  assert.deepEqual([differs.state, differs.value, differs.reason], ['conflict', null, { code: 'annex_effective_date_disputed' }]);
  // The annex is in force under both dates: as in P2, it is listed once per date it was placed at.
  assert.deepEqual(differs.candidates.map((c) => [c.value, c.source.documentLabel, c.source.effectiveDate]), [[16.8, 'aneks.pdf', '2026-09-01'], [16.8, 'aneks.pdf', '2026-08-01'], [16.2, 'pasek-sierpien.pdf', null]]);
  assert.ok(differs.excluded.some((x) => x.source.documentLabel === 'pasek-sierpien.pdf' && x.reason === 'superseded_by_later_document' && x.regime?.effectiveDate === '2026-09-01'), 'the variant that supersedes it is shown too');
  assert.deepEqual([differs.regime?.start, differs.regime?.winnerDocumentLabel], [null, 'aneks.pdf'], 'a regime start that depends on the disputed date is not asserted');

  // Same VALUE, different placement: corroborated under one date, document_exact under the other - still disputed.
  const sameValue = at(payslip(2, 'pasek-sierpien.pdf', 16.8, period('2026-08-10', '2026-08-16')));
  assert.deepEqual([sameValue.state, sameValue.reason], ['conflict', { code: 'annex_effective_date_disputed' }], 'the placement outcome is part of the variant comparison, not just the values');

  // A payslip inside the regime under BOTH dates does not depend on the dispute.
  const settled = at(payslip(2, 'pasek-wrzesien.pdf', 16.8, period('2026-09-14', '2026-09-20')));
  assert.deepEqual([settled.state, settled.value, settled.reason], ['corroborated', 16.8, null]);

  // The P2.6 case without payslips is unchanged: a dispute that changes nothing manufactures no conflict.
  const noSlips = resolve('2026-10-01', [BASE_1620(), disputedAnnex()]).employment.hourlyRate;
  assert.deepEqual([noSlips.state, noSlips.value], ['document_exact', 16.8]);
  const inForceUnderOneDate = resolve('2026-08-15', [BASE_1620(), disputedAnnex()]).employment.hourlyRate;
  assert.deepEqual([inForceUnderOneDate.state, inForceUnderOneDate.reason], ['conflict', { code: 'annex_effective_date_disputed' }]);
});

test('P3 #21: a pay period crossing a regime boundary is excluded pay_period_straddles_change - at the start and at the end of the regime', () => {
  const atStart = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', 16.2, period('2026-08-28', '2026-09-03'))]).employment.hourlyRate;
  assert.deepEqual([atStart.state, atStart.value], ['document_exact', 16.8]);
  assert.deepEqual(placed(atStart)[1], ['pay_period_straddles_change', 'straddles', '2026-09-01', 'aneks.pdf', 16.2, 'pasek.pdf']);
  const atEnd = resolve('2026-06-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', 16.2, period('2026-08-28', '2026-09-03'))]).employment.hourlyRate;
  assert.deepEqual([atEnd.state, atEnd.value], ['document_exact', 16.2], 'it does not corroborate the old regime either');
  assert.deepEqual(placed(atEnd), [['pay_period_straddles_change', 'straddles', '2026-09-01', 'aneks.pdf', 16.2, 'pasek.pdf']]);
});

test('P3 #22: a payslip from a regime starting after the as-of date is excluded outside_as_of_regime', () => {
  const p = resolve('2026-06-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek-wrzesien.pdf', 16.8, period('2026-09-07', '2026-09-13'))]);
  const f = p.employment.hourlyRate;
  assert.deepEqual([f.state, f.value, f.reason], ['document_exact', 16.2, null]);
  assert.deepEqual(placed(f), [['outside_as_of_regime', 'later_than_as_of', '2026-09-01', 'aneks.pdf', 16.8, 'pasek-wrzesien.pdf']]);
  assert.deepEqual(f.regime, { start: null, end: '2026-09-01', winnerDocumentIndex: 0, winnerDocumentId: null, winnerDocumentLabel: 'umowa.pdf' });
});

test('P3 #23: base and earlier-annex values the timeline overrode stay visible as superseded, with their full provenance', () => {
  const p = resolve('2026-09-15', [
    baseContract(0, { hourly_rate: found(16.2, 'Uurloon € 16,20 bruto', 1, 'Uurloon') }, 'u-base'),
    annex(1, 'aneks-1.pdf', '2026-03-01', rate(16.5), 'u-a1'),
    annex(2, 'aneks-2.pdf', '2026-09-01', rate(16.8), 'u-a2'),
  ]);
  const f = p.employment.hourlyRate;
  assert.deepEqual([f.state, f.value], ['document_exact', 16.8]);
  assert.deepEqual(f.excluded.map((x) => [x.reason, x.value, x.source.role, x.source.documentLabel, x.source.documentId, x.source.effectiveDate, x.source.page, x.source.rawValue]), [
    ['superseded_by_later_document', 16.2, 'contract_base', 'umowa.pdf', 'u-base', null, 1, 'Uurloon € 16,20 bruto'],
    ['superseded_by_later_document', 16.5, 'contract_annex', 'aneks-1.pdf', 'u-a1', '2026-03-01', 1, 'Uurloon € 16,50'],
  ]);
  assert.deepEqual(f.excluded.map((x) => x.regime), [0, 1].map(() => ({ relation: 'superseded_by', documentIndex: 2, documentId: 'u-a2', documentLabel: 'aneks-2.pdf', role: 'contract_annex', effectiveDate: '2026-09-01' })));
  // A contract-only timeline field gets the same transparency.
  const hpw = resolve('2026-09-15', [baseContract(0, { hours_per_week: found(40, '40 uur per week', 1, 'Arbeidsduur') }), annex(1, 'aneks.pdf', '2026-09-01', { hours_per_week: found(32, '32 uur per week', 1, 'Arbeidsduur') })]).employment.hoursPerWeek;
  assert.deepEqual([hpw.value, hpw.excluded.map((x) => [x.reason, x.value])], [32, [['superseded_by_later_document', 40]]]);
  const end = resolve('2026-09-15', [baseContract(0, { end_date: found('2026-12-31', 'tot 31-12-2026', 1, 'Einddatum') }), annex(1, 'aneks.pdf', '2026-09-01', { end_date: found('2027-06-30', 'tot 30-06-2027', 1, 'Einddatum') })]).employment.contractEndDate;
  assert.deepEqual([end.value, end.excluded.map((x) => [x.reason, x.value]), end.regime?.start], ['2027-06-30', [['superseded_by_later_document', '2026-12-31']], '2026-09-01']);
});

test('P3 #24: P1.8 #3 unchanged - contract vs payslip with no annex and no dated boundary still conflict, dated or not', () => {
  for (const when of [period(null, '2026-03-08'), period(null, null)]) {
    const f = resolve('2026-06-01', [baseContract(0, rate(15.55)), payslip(1, 'pasek.pdf', 16.2, when)]).employment.hourlyRate;
    assert.deepEqual([f.state, f.value, f.reason], ['conflict', null, { code: 'sources_disagree' }]);
    assert.deepEqual(f.candidates.map((c) => [c.value, c.source.role]), [[15.55, 'contract_base'], [16.2, 'payslip']]);
    assert.deepEqual(f.excluded, []);
    assert.deepEqual(f.regime, { start: null, end: null, winnerDocumentIndex: 0, winnerDocumentId: null, winnerDocumentLabel: 'umowa.pdf' });
  }
  const same = resolve('2026-06-01', [baseContract(0, rate(16.2)), payslip(1, 'pasek.pdf', 16.2, period(null, null))]).employment.hourlyRate;
  assert.deepEqual([same.state, same.value], ['corroborated', 16.2], 'with no dated boundary an undated payslip still corroborates (P1 behaviour)');
});

test('P3 #25: payslip-only fields have no recency rule - a 2025 and a 2026 pension percentage stay a conflict, even beside an annex', () => {
  const pension = (percent: number) => ({ deduction_lines: [{ description: 'Pensioen StiPP', placement: 'pre_tax', category: 'pension', percent, base: 648, amount: Math.round(648 * percent) / 100, raw: `Pensioen StiPP ${fmt(percent)}% 648,00 ${fmt(Math.round(648 * percent) / 100)}`, page: 1, unclear_fields: [] }] });
  const p = resolve('2026-09-15', [
    BASE_1620(), ANNEX_1680('2026-01-01'),
    payslip(2, 'pasek-2025.pdf', 16.2, period('2025-11-24', '2025-11-30'), pension(7.5)),
    payslip(3, 'pasek-2026.pdf', 16.8, period('2026-09-07', '2026-09-13'), pension(7.9)),
  ]);
  const f = p.payroll.pensionEmployeePercent;
  assert.deepEqual([f.state, f.value, f.reason, f.regime], ['conflict', null, { code: 'sources_disagree' }, null]);
  assert.deepEqual(f.candidates.map((c) => [c.value, c.source.payPeriod?.endDate]), [[7.5, '2025-11-30'], [7.9, '2026-09-13']], 'both periods shown, the newer one is not preferred');
  assert.deepEqual(f.excluded, []);
});

test('P3 #26 (A3b): an undated payslip equal to the in-force contract value - no conflict, no corroboration, visible as unplaceable', () => {
  const p = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek-bez-daty.pdf', 16.8, period(null, null, '2026-09-11'))]);
  const f = p.employment.hourlyRate;
  assert.deepEqual([f.state, f.value, f.reason], ['document_exact', 16.8, null], 'documentary-only: never upgraded to corroborated');
  assert.deepEqual(f.sources.map((s) => s.documentLabel), ['aneks.pdf']);
  assert.deepEqual(values(f), [[16.8, 'contract_annex', 'aneks.pdf']]);
  assert.deepEqual(placed(f)[1], ['payslip_period_unplaceable', 'value_matches_current_but_period_unknown', '2026-09-01', 'aneks.pdf', 16.8, 'pasek-bez-daty.pdf']);
  // The same payslip WITH a period inside the regime does corroborate - the period, not the value, is the difference.
  const dated = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', 16.8, period('2026-09-07', '2026-09-13'))]).employment.hourlyRate;
  assert.deepEqual([dated.state, dated.value], ['corroborated', 16.8]);
});

// ---------------------------------------------------------------------------------------------
// Focused boundary behaviour
// ---------------------------------------------------------------------------------------------

test('P3 S2: only a printed period start, or only a printed end, is used as both bounds', () => {
  const at = (when: Record<string, unknown>, rateValue = 16.2) => resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', rateValue, when)]).employment.hourlyRate;
  assert.equal(at(period('2026-08-25', null)).excluded[1]?.reason, 'superseded_by_later_document', 'start only, before S');
  assert.deepEqual(at(period('2026-09-02', null), 16.8).state, 'corroborated', 'start only, inside the regime');
  assert.equal(at(period(null, '2026-08-31')).excluded[1]?.reason, 'superseded_by_later_document', 'end only, before S');
  assert.deepEqual(at(period(null, '2026-09-07'), 16.8).state, 'corroborated', 'end only, inside the regime');
});

test('P3 S2: the payment date is never a period bound', () => {
  // Paid inside the new regime, but no printed period: still unplaceable (A3a), never placed by its payment date.
  const undated = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', 16.2, period(null, null, '2026-09-04'))]).employment.hourlyRate;
  assert.deepEqual(undated.reason, { code: 'payslip_period_unplaceable', changeDate: '2026-09-01' });
  // August period paid in September: placed by its period (superseded), not by its payment date.
  const august = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', 16.2, period('2026-08-25', '2026-08-31', '2026-09-04'))]).employment.hourlyRate;
  assert.deepEqual([august.state, august.excluded[1]?.reason], ['document_exact', 'superseded_by_later_document']);
});

test('P3 S2: exact boundary dates - pe < S superseded, ps == S inside, pe == S straddles, ps == X outside, pe == X - 1 inside', () => {
  const now = (when: Record<string, unknown>, rateValue: number) => resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', rateValue, when)]).employment.hourlyRate;
  const before = (when: Record<string, unknown>, rateValue: number) => resolve('2026-06-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', rateValue, when)]).employment.hourlyRate;
  assert.equal(now(period('2026-08-25', '2026-08-31'), 16.2).excluded[1]?.reason, 'superseded_by_later_document', 'pe = S - 1 day');
  assert.equal(now(period('2026-09-01', '2026-09-07'), 16.8).state, 'corroborated', 'ps = S is inside');
  assert.equal(now(period('2026-08-26', '2026-09-01'), 16.8).excluded[1]?.reason, 'pay_period_straddles_change', 'pe = S with ps < S straddles');
  assert.equal(before(period('2026-09-01', '2026-09-07'), 16.8).excluded[0]?.reason, 'outside_as_of_regime', 'ps = X belongs to the later regime');
  assert.equal(before(period('2026-08-25', '2026-08-31'), 16.2).state, 'corroborated', 'pe = X - 1 day is inside [S, X)');
});

test('P3 S2: a future annex that does not state the field does not end its regime; one that states it unreadably does', () => {
  const sept = () => payslip(2, 'pasek-wrzesien.pdf', 16.2, period('2026-09-07', '2026-09-13'));
  const hoursOnly = resolve('2026-06-15', [baseContract(0, { ...rate(16.2), hours_per_week: found(40, '40 uur per week', 1, 'Arbeidsduur') }), annex(1, 'aneks.pdf', '2026-09-01', { hours_per_week: found(32, '32 uur per week', 1, 'Arbeidsduur') }), sept()]);
  assert.equal(hoursOnly.employment.hourlyRate.regime?.end, null, 'the annex does not address the rate');
  assert.deepEqual([hoursOnly.employment.hourlyRate.state, hoursOnly.employment.hourlyRate.value], ['corroborated', 16.2], 'so the September payslip is still in the rate regime');
  assert.equal(hoursOnly.employment.hoursPerWeek.regime?.end, '2026-09-01', 'it does end the hours-per-week regime');
  const unclearRate = resolve('2026-06-15', [BASE_1620(), annex(1, 'aneks.pdf', '2026-09-01', { hourly_rate: ambiguous('Uurloon € 1?,80', 1, 'Uurloon') }), sept()]);
  const f = unclearRate.employment.hourlyRate;
  assert.equal(f.regime?.end, '2026-09-01');
  assert.deepEqual([f.state, f.value], ['document_exact', 16.2]);
  assert.deepEqual(placed(f), [['outside_as_of_regime', 'later_than_as_of', '2026-09-01', 'aneks.pdf', 16.2, 'pasek-wrzesien.pdf']]);
});

test('P3 S2: hours per week is regime-aware the same way (one generic path)', () => {
  const hpw = (n: number) => ({ hours_per_week: found(n, `${n} uur per week`, 1, 'Arbeidsduur') });
  const p = resolve('2026-09-15', [
    baseContract(0, hpw(40)), annex(1, 'aneks.pdf', '2026-09-01', hpw(32)),
    payslip(2, 'pasek-sierpien.pdf', 16.2, period('2026-08-25', '2026-08-31'), hpw(40)),
    payslip(3, 'pasek-wrzesien.pdf', 16.2, period('2026-09-07', '2026-09-13'), hpw(32)),
  ]);
  const f = p.employment.hoursPerWeek;
  assert.deepEqual([f.state, f.value], ['corroborated', 32]);
  assert.deepEqual(placed(f), [
    ['superseded_by_later_document', 'superseded_by', '2026-09-01', 'aneks.pdf', 40, 'umowa.pdf'],
    ['superseded_by_later_document', 'superseded_by', '2026-09-01', 'aneks.pdf', 40, 'pasek-sierpien.pdf'],
  ]);
});

test('P3 S2: a timeline disagreement keeps its reason; the overridden base is shown superseded at the shared annex date', () => {
  const p = resolve('2026-09-15', [BASE_1620(), annex(1, 'aneks-a.pdf', '2026-09-01', rate(16.8)), annex(2, 'aneks-b.pdf', '2026-09-01', rate(16.9)), payslip(3, 'pasek.pdf', 16.2, period(null, null))]);
  const f = p.employment.hourlyRate;
  assert.deepEqual([f.state, f.reason], ['conflict', { code: 'timeline_disagreement', asOfDate: '2026-09-15' }]);
  assert.deepEqual(f.candidates.map((c) => c.value), [16.8, 16.9, 16.2], 'an undated payslip is a candidate - there is no single in-force value to match');
  assert.deepEqual(placed(f)[0], ['superseded_by_later_document', 'superseded_by', '2026-09-01', 'aneks-a.pdf', 16.2, 'umowa.pdf']);
  assert.deepEqual([f.regime?.start, f.regime?.winnerDocumentLabel], ['2026-09-01', null]);
});

// ---------------------------------------------------------------------------------------------
// documentId plumbing and version
// ---------------------------------------------------------------------------------------------

test('P3 S2: documentId is carried, opaque, into sources, document refs, regime markers and the field regime; absent means null', () => {
  const p = resolve('2026-09-15', [
    baseContract(0, rate(16.2), '1738000000000-base'),
    annex(1, 'aneks.pdf', '2026-09-01', rate(16.8), '1738000000001-annx'),
    payslip(2, 'pasek.pdf', 16.2, period('2026-08-25', '2026-08-31'), {}, '1738000000002-slip'),
  ]);
  assert.equal(p.version, 2);
  assert.deepEqual(p.documents.map((d) => [d.index, d.documentId]), [[0, '1738000000000-base'], [1, '1738000000001-annx'], [2, '1738000000002-slip']]);
  const f = p.employment.hourlyRate;
  assert.equal(f.sources[0]?.documentId, '1738000000001-annx');
  assert.deepEqual(f.excluded.map((x) => [x.source.documentId, x.regime?.documentId]), [['1738000000000-base', '1738000000001-annx'], ['1738000000002-slip', '1738000000001-annx']]);
  assert.equal(f.regime?.winnerDocumentId, '1738000000001-annx');
  const legacy = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', 16.2, period('2026-08-25', '2026-08-31'))]);
  assert.deepEqual(legacy.documents.map((d) => d.documentId), [null, null, null]);
  assert.ok(legacy.employment.hourlyRate.excluded.every((x) => x.source.documentId === null && x.regime?.documentId === null));
  assert.equal(legacy.calibrationOnly.payslips[0]?.source.documentId, null);
});

test('P3 S2: fields outside the contract timeline carry no regime', () => {
  const p = resolve('2026-09-15', [BASE_1620(), ANNEX_1680(), payslip(2, 'pasek.pdf', 16.8, period('2026-09-07', '2026-09-13'))]);
  for (const f of [p.payroll.periodType, p.payroll.pensionEmployeePercent, p.employment.payslipEmployerName, p.employment.phase, p.payroll.saturdayPremium]) assert.equal(f.regime, null, f.key);
  assert.notEqual(p.employment.hourlyRate.regime, null);
  assert.notEqual(p.employment.caoName.regime, null, 'a contract-only timeline field has a regime too');
  const slipsOnly = resolve('2026-09-15', [payslip(0, 'pasek.pdf', 16.2, period(null, null))]);
  assert.deepEqual([slipsOnly.employment.hourlyRate.state, slipsOnly.employment.hourlyRate.regime], ['document_exact', null], 'no contract document: no regime, P1 behaviour');
});
