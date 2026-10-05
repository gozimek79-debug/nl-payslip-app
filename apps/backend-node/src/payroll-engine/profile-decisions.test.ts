import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePayrollProfile, EMPLOYMENT_FIELD_KEYS, PAYROLL_FIELD_KEYS, type ProfileDocumentInput, type PayrollProfile, type ProfileValue, type ProfileUnit } from './payroll-profile.js';
import {
  applyUserDecisions, evidenceFingerprint, profileFieldFingerprint, documentKeys, findProfileField, isProfileFieldPath, canonicalJson,
  type ProfileFieldPath, type UserProfileDecision, type ConfirmCandidateDecision, type CorrectValueDecision,
} from './profile-decisions.js';
import { mergePayslipBatches, mergeContractBatches } from './document-facts.js';
import { payslipBatch, contractBatch, rawPayslip, rawContract, found, absent, hourLine, overtimeLine } from '../test-support/fact-fixtures.js';

/**
 * P3.1 S3 (LOONTO-PRO-P3-DECISION-LOCK.md decisions B, C, H; ZADANIE-P3.1-S3-USER-DECISIONS.md): the
 * stateless user-decision overlay and the temporal evidence fingerprint. Synthetic reader responses only,
 * mapped by the production mapper; every fingerprint a decision carries is the one the documentary
 * profile itself yields (`profileFieldFingerprint`) - nothing is faked.
 */

const fmt = (n: number) => n.toFixed(2).replace('.', ',');
const RATE: ProfileFieldPath = 'employment.hourlyRate';
const PENSION: ProfileFieldPath = 'payroll.pensionEmployeePercent';
const HOUSING: ProfileFieldPath = 'recurringItems.netDeductions.net_deduction:housing:huisvesting';

function rateLine(rate: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const amount = Math.round(40 * rate * 100) / 100;
  return hourLine({ rate, amount, raw: `Uren normaal 40,00 ${fmt(rate)} ${fmt(amount)}`, ...extra });
}
function period(start: string | null, end: string | null): Record<string, unknown> {
  return { period_start: start ? found(start, `van ${start}`, 1, 'Periode') : absent, period_end: end ? found(end, `t/m ${end}`, 1, 'Periode') : absent };
}
const pension = (percent: number) => ({ description: 'Pensioen StiPP', placement: 'pre_tax', category: 'pension', percent, base: 648, amount: Math.round(648 * percent) / 100, raw: `Pensioen StiPP ${fmt(percent)}% 648,00 ${fmt(Math.round(648 * percent) / 100)}`, page: 1, unclear_fields: [] });
const housing = (amount: number) => ({ description: 'Huisvesting', category: 'housing', amount, raw: `Huisvesting ${fmt(amount)}`, page: 1, unclear_fields: [] });

function payslip(index: number, id: string | null, rate: number, when: Record<string, unknown>, extra: Record<string, unknown> = {}, pages = [1], label = `pasek-${id ?? index}.pdf`): ProfileDocumentInput {
  return { index, ...(id ? { documentId: id } : {}), label, role: 'payslip', effectiveDate: null, facts: mergePayslipBatches([payslipBatch(rawPayslip({ ...when, hour_lines: [rateLine(rate)], ...extra }), pages)]) };
}
function base(index: number, id: string | null, raw: Record<string, unknown>, pages = [1]): ProfileDocumentInput {
  return { index, ...(id ? { documentId: id } : {}), label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, facts: mergeContractBatches([contractBatch(rawContract(raw), pages)]) };
}
function annex(index: number, id: string | null, date: string | null, raw: Record<string, unknown>, label = 'aneks.pdf'): ProfileDocumentInput {
  return { index, ...(id ? { documentId: id } : {}), label, role: 'contract_annex', effectiveDate: date, facts: mergeContractBatches([contractBatch(rawContract(raw))]) };
}
const rate = (v: number, raw = `Uurloon € ${fmt(v)}`, page = 1, label = 'Uurloon') => ({ hourly_rate: found(v, raw, page, label) });

const resolve = (asOfDate: string, documents: ProfileDocumentInput[]): PayrollProfile => resolvePayrollProfile({ asOfDate, documents });
const fp = (profile: PayrollProfile, path: ProfileFieldPath): string => profileFieldFingerprint(profile, path) as string;
const DECIDED_AT = '2026-10-05T10:00:00Z';

function confirm(profile: PayrollProfile, fieldPath: ProfileFieldPath, value: ProfileValue, decisionId = 'dec-1', decidedAt = DECIDED_AT): ConfirmCandidateDecision {
  return { kind: 'confirm_candidate', decisionId, fieldPath, value, evidenceFingerprint: fp(profile, fieldPath), decidedAt };
}
function correct(profile: PayrollProfile, fieldPath: ProfileFieldPath, value: ProfileValue, unit: ProfileUnit, decisionId = 'dec-1', decidedAt = DECIDED_AT): CorrectValueDecision {
  return { kind: 'correct_value', decisionId, fieldPath, value, unit, evidenceFingerprint: fp(profile, fieldPath), decidedAt };
}
const results = (r: ReturnType<typeof applyUserDecisions>) => r.decisionResults.map((d) => [d.decisionId, d.status, d.problem]);

/** A2: base 16.20, annex 16.80 from 2026-09-01, an in-regime payslip at 16.20 -> conflict. */
const a2Documents = (): ProfileDocumentInput[] => [
  base(0, 'u-base', rate(16.2)),
  annex(1, 'u-annex', '2026-09-01', rate(16.8)),
  payslip(2, 'u-slip', 16.2, period('2026-09-07', '2026-09-13')),
];

// ---------------------------------------------------------------------------------------------
// #5-#8 - confirm, correct, isolation, preservation
// ---------------------------------------------------------------------------------------------

test('P3 #5 (B): confirming a candidate of a conflict gives user_confirmed - its document sources plus one user source, all evidence kept', () => {
  const documentary = resolve('2026-09-15', a2Documents());
  assert.equal(documentary.employment.hourlyRate.state, 'conflict');
  const out = applyUserDecisions(documentary, [confirm(documentary, RATE, 16.2, 'dec-rate')]);
  const f = out.profile.employment.hourlyRate;
  assert.deepEqual(results(out), [['dec-rate', 'applied', null]]);
  assert.deepEqual([f.state, f.value, f.reason], ['user_confirmed', 16.2, null]);
  assert.deepEqual(f.sources.map((s) => [s.sourceType, s.role, s.documentLabel, s.decisionId ?? null]), [['document', 'payslip', 'pasek-u-slip.pdf', null], ['user', 'user', null, 'dec-rate']]);
  const before = documentary.employment.hourlyRate;
  assert.deepEqual([f.candidates, f.excluded, f.regime], [before.candidates, before.excluded, before.regime], 'every candidate, exclusion and the regime are unchanged');
  assert.deepEqual(f.resolution, { decisionId: 'dec-rate', kind: 'confirm_candidate', decidedAt: DECIDED_AT, evidenceFingerprint: fp(documentary, RATE), previous: { state: 'conflict', value: null, reason: { code: 'sources_disagree' } } });
  // The other (contractual) group can be confirmed the same way.
  const other = applyUserDecisions(documentary, [confirm(documentary, RATE, 16.8)]).profile.employment.hourlyRate;
  assert.deepEqual([other.state, other.value, other.sources.map((s) => s.role)], ['user_confirmed', 16.8, ['contract_annex', 'user']]);
});

test('P3 #6 (C): a correction gives user_corrected with exactly one user source - never documentary corroboration, documents still visible', () => {
  const documentary = resolve('2026-09-15', a2Documents());
  const f = applyUserDecisions(documentary, [correct(documentary, RATE, 17.1, 'eur_per_hour', 'dec-c')]).profile.employment.hourlyRate;
  assert.deepEqual([f.state, f.value, f.reason], ['user_corrected', 17.1, null]);
  assert.deepEqual(f.sources, [{ sourceType: 'user', role: 'user', documentIndex: null, documentId: null, documentLabel: null, effectiveDate: null, payPeriod: null, printedLabel: null, rawValue: null, page: null, line: null, decisionId: 'dec-c' }]);
  assert.deepEqual(f.candidates, documentary.employment.hourlyRate.candidates);
  assert.deepEqual(f.excluded, documentary.employment.hourlyRate.excluded);
  // Even a corrected value that a document also shows stays a user correction - user input never corroborates.
  const same = applyUserDecisions(documentary, [correct(documentary, RATE, 16.2, 'eur_per_hour')]).profile.employment.hourlyRate;
  assert.deepEqual([same.state, same.sources.map((s) => s.role)], ['user_corrected', ['user']]);
  assert.notEqual(same.state, 'corroborated');
});

test('P3 #7: a decision changes only its own field - every other part of the profile is identical (same objects)', () => {
  const documentary = resolve('2026-09-15', [...a2Documents(), payslip(3, 'u-slip2', 16.8, period('2026-09-14', '2026-09-20'), { deduction_lines: [pension(7.5)], net_lines: [housing(95)] })]);
  const out = applyUserDecisions(documentary, [correct(documentary, RATE, 17.1, 'eur_per_hour')]).profile;
  for (const key of EMPLOYMENT_FIELD_KEYS) if (key !== 'hourlyRate') assert.equal(out.employment[key], documentary.employment[key], `employment.${key}`);
  for (const key of PAYROLL_FIELD_KEYS) assert.equal(out.payroll[key], documentary.payroll[key], `payroll.${key}`);
  assert.equal(out.recurringItems, documentary.recurringItems);
  for (const k of ['documents', 'contractContext', 'observedOvertimePremiums', 'calibrationOnly', 'asOfDate', 'version'] as const) assert.equal(out[k], documentary[k], k);
  assert.notEqual(out.employment.hourlyRate, documentary.employment.hourlyRate);
});

test('P3 #8: after a decision the candidates and exclusions are unchanged, the documentary result is in resolution.previous, and the input profile is not mutated', () => {
  const documentary = resolve('2026-09-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', rate(16.8)), payslip(2, 'u-old', 16.2, period('2026-08-24', '2026-08-30'))]);
  const snapshot = JSON.stringify(documentary);
  const f = applyUserDecisions(documentary, [correct(documentary, RATE, 17, 'eur_per_hour')]).profile.employment.hourlyRate;
  assert.equal(JSON.stringify(documentary), snapshot, 'the documentary profile passed in is untouched');
  assert.deepEqual(f.excluded.map((x) => [x.reason, x.source.documentLabel]), [['superseded_by_later_document', 'umowa.pdf'], ['superseded_by_later_document', 'pasek-u-old.pdf']]);
  assert.deepEqual(f.candidates.map((c) => c.value), [16.8]);
  assert.deepEqual(f.resolution?.previous, { state: 'document_exact', value: 16.8, reason: null });
});

// ---------------------------------------------------------------------------------------------
// #9 determinism, #10 stale detection
// ---------------------------------------------------------------------------------------------

test('P3 #9: the same documents and decisions give a byte-identical result; permuting decisions for different fields changes no profile byte', () => {
  const docs = () => [...a2Documents(), payslip(3, 'u-p1', 16.2, period('2026-09-14', '2026-09-20'), { deduction_lines: [pension(7.5)], net_lines: [housing(95)] }), payslip(4, 'u-p2', 16.2, period('2026-09-21', '2026-09-27'), { deduction_lines: [pension(7.9)], net_lines: [housing(95)] })];
  const documentary = resolve('2026-09-15', docs());
  const decisions: UserProfileDecision[] = [
    confirm(documentary, RATE, 16.2, 'a'),
    confirm(documentary, PENSION, 7.9, 'b'),
    correct(documentary, HOUSING, 90, 'eur_per_period', 'c'),
  ];
  const run = (ds: UserProfileDecision[]) => applyUserDecisions(resolve('2026-09-15', docs()), ds);
  assert.equal(JSON.stringify(run(decisions)), JSON.stringify(run(decisions)), 'byte-identical');
  const permuted = run([decisions[2]!, decisions[0]!, decisions[1]!]);
  assert.equal(JSON.stringify(permuted.profile), JSON.stringify(run(decisions).profile));
  assert.deepEqual(permuted.decisionResults.map((r) => r.decisionId), ['c', 'a', 'b'], 'results follow request order');
  assert.ok(permuted.decisionResults.every((r) => r.status === 'applied'));
});

test('P3 #10: stale detection - a new candidate gives evidence_changed, a vanished recurring line field_not_found, a value that is no candidate candidate_not_present', () => {
  const documentary = resolve('2026-09-15', a2Documents());
  const decision = confirm(documentary, RATE, 16.2);
  // A new in-regime payslip with another rate is a new candidate: the evidence the user saw has changed.
  const more = resolve('2026-09-15', [...a2Documents(), payslip(3, 'u-new', 16.5, period('2026-09-14', '2026-09-20'))]);
  const stale = applyUserDecisions(more, [decision]);
  assert.deepEqual(results(stale), [['dec-1', 'stale', 'evidence_changed']]);
  assert.equal(stale.profile.employment.hourlyRate, more.employment.hourlyRate, 'not applied: the documentary field stays as it is');
  // The confirmed payslip's document is gone (re-upload without it): also a changed fingerprint, never a silent apply.
  const gone = resolve('2026-09-15', a2Documents().slice(0, 2));
  assert.deepEqual(results(applyUserDecisions(gone, [decision])), [['dec-1', 'stale', 'evidence_changed']]);
  // A recurring line that no longer exists after a re-upload.
  const withLine = resolve('2026-09-15', [payslip(0, 'u-s', 16.2, period('2026-09-07', '2026-09-13'), { net_lines: [housing(95)] })]);
  const lineDecision = correct(withLine, HOUSING, 90, 'eur_per_period');
  const withoutLine = resolve('2026-09-15', [payslip(0, 'u-s', 16.2, period('2026-09-07', '2026-09-13'))]);
  assert.deepEqual(results(applyUserDecisions(withoutLine, [lineDecision])), [['dec-1', 'stale', 'field_not_found']]);
  // With the fingerprint unchanged, a confirmation of a value that is not a candidate group (here: the
  // superseded base value, visible only as excluded evidence) is candidate_not_present - never applied.
  const a1 = resolve('2026-09-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', rate(16.8))]);
  assert.deepEqual(a1.employment.hourlyRate.excluded.map((x) => x.value), [16.2]);
  const notCandidate = applyUserDecisions(a1, [confirm(a1, RATE, 16.2)]);
  assert.deepEqual(results(notCandidate), [['dec-1', 'stale', 'candidate_not_present']]);
  assert.equal(notCandidate.profile.employment.hourlyRate.state, 'document_exact');
});

// ---------------------------------------------------------------------------------------------
// #15 overtime tiers, #27-#30
// ---------------------------------------------------------------------------------------------

test('P3 #15 (P1.1): an observed overtime premium never becomes a tier candidate; the user may assert a tier value as user_corrected', () => {
  const documentary = resolve('2026-06-01', [payslip(0, 'u-s', 16.2, period('2026-03-02', '2026-03-08'), { hour_lines: [rateLine(16.2), overtimeLine(150)] })]);
  const tier1: ProfileFieldPath = 'payroll.overtimeTier1Premium';
  assert.deepEqual([documentary.payroll.overtimeTier1Premium.state, documentary.payroll.overtimeTier1Premium.candidates, documentary.observedOvertimePremiums.fields[0]?.value], ['unknown', [], 50]);
  // "Confirming" the observed +50 as tier 1: it is not a candidate of the tier field, so nothing is promoted.
  const promoted = applyUserDecisions(documentary, [confirm(documentary, tier1, 50)]);
  assert.deepEqual(results(promoted), [['dec-1', 'stale', 'candidate_not_present']]);
  assert.equal(promoted.profile.payroll.overtimeTier1Premium.state, 'unknown');
  // The user asserting the tier is a correction.
  const asserted = applyUserDecisions(documentary, [correct(documentary, tier1, 50, 'premium_percent')]);
  const f = asserted.profile.payroll.overtimeTier1Premium;
  assert.deepEqual([f.state, f.value, f.sources.map((s) => s.role), f.candidates], ['user_corrected', 50, ['user'], []]);
  assert.equal(asserted.profile.observedOvertimePremiums, documentary.observedOvertimePremiums, 'observed premiums untouched');
  assert.equal(asserted.profile.payroll.overtimeTier2Premium, documentary.payroll.overtimeTier2Premium, 'tier 2 untouched');
  assert.deepEqual(results(applyUserDecisions(documentary, [correct(documentary, tier1, 50, 'percent')])), [['dec-1', 'rejected', 'unit_mismatch']]);
});

test('P3 #27: confirming the value documents already resolve is satisfied_by_documents - the documentary state stays', () => {
  const documentary = resolve('2026-06-01', [base(0, 'u-base', rate(16.2)), payslip(1, 'u-s', 16.2, period('2026-03-02', '2026-03-08'))]);
  const out = applyUserDecisions(documentary, [confirm(documentary, RATE, 16.2)]);
  assert.deepEqual(results(out), [['dec-1', 'satisfied_by_documents', null]]);
  assert.equal(out.profile.employment.hourlyRate, documentary.employment.hourlyRate);
  assert.deepEqual([out.profile.employment.hourlyRate.state, out.profile.employment.hourlyRate.resolution], ['corroborated', null]);
});

test('P3 #28: validation - wrong unit, out of range, non-finite and a negative amount are rejected; nothing is coerced', () => {
  const documentary = resolve('2026-06-01', [
    base(0, 'u-base', { ...rate(16.2), hours_per_week: found(40, '40 uur per week', 1, 'Arbeidsduur'), monthly_salary: found(2800, 'Salaris € 2.800,00', 1, 'Salaris') }),
    payslip(1, 'u-s', 16.2, period('2026-03-02', '2026-03-08'), { net_lines: [housing(95)] }),
  ]);
  const check = (path: ProfileFieldPath, value: ProfileValue, unit: ProfileUnit) => applyUserDecisions(documentary, [correct(documentary, path, value, unit)]).decisionResults[0]?.problem ?? 'ok';
  assert.equal(check(RATE, 17, 'eur_per_month'), 'unit_mismatch');
  for (const [path, value, unit] of [
    [RATE, 250, 'eur_per_hour'], [RATE, 0, 'eur_per_hour'], [RATE, '17', 'eur_per_hour'], [RATE, Number.NaN, 'eur_per_hour'], [RATE, Number.POSITIVE_INFINITY, 'eur_per_hour'],
    ['employment.hoursPerWeek', 169, 'hours_per_week'], ['employment.guaranteedHours', 745, 'hours'], ['employment.guaranteedHoursPeriodWeeks', 2.5, 'weeks'], ['employment.guaranteedHoursPeriodWeeks', 53, 'weeks'],
    ['payroll.overtimeTier1Premium', 401, 'premium_percent'], [PENSION, 101, 'percent_of_printed_base'], ['payroll.vakantiegeldAccrualPercent', -1, 'percent'],
    ['payroll.periodType', 'daily', 'period_type'], ['payroll.loonheffingskorting', 'true', 'boolean'], ['employment.contractEndDate', '2026-02-30', 'date'],
    ['employment.caoName', '', 'text'], ['employment.caoName', '   ', 'text'], ['employment.caoName', 'x'.repeat(201), 'text'],
    [HOUSING, -95, 'eur_per_period'], [HOUSING, -90, 'eur_per_period'], [HOUSING, Number.NaN, 'eur_per_period'], ['employment.monthlySalary', 100_000.01, 'eur_per_month'],
  ] as Array<[ProfileFieldPath, ProfileValue, ProfileUnit]>) {
    assert.equal(check(path, value, unit), 'invalid_value', `${path} = ${String(value)}`);
  }
  // F2: the magnitude is accepted; the negative is never silently turned into it.
  const positive = applyUserDecisions(documentary, [correct(documentary, HOUSING, 90, 'eur_per_period')]);
  assert.deepEqual([positive.decisionResults[0]?.status, positive.profile.recurringItems.netDeductions[0]?.value], ['applied', 90]);
  for (const [path, value, unit] of [[RATE, 200, 'eur_per_hour'], ['employment.guaranteedHoursPeriodWeeks', 52, 'weeks'], ['payroll.loonheffingskorting', true, 'boolean'], ['payroll.periodType', '4-weekly', 'period_type'], ['employment.contractEndDate', '2028-02-29', 'date'], ['employment.monthlySalary', 100_000, 'eur_per_month'], [HOUSING, 0, 'eur_per_period']] as Array<[ProfileFieldPath, ProfileValue, ProfileUnit]>) {
    assert.equal(check(path, value, unit), 'ok', `${path} = ${String(value)} is valid`);
  }
  // A confirmation must be a magnitude as well (a candidate always is).
  assert.equal(applyUserDecisions(documentary, [confirm(documentary, HOUSING, -95)]).decisionResults[0]?.problem, 'invalid_value');
});

test('P3 #28: the monthly-salary bound is the established fact-layer plausibility limit, not a new one', () => {
  const read = (v: number) => mergeContractBatches([contractBatch(rawContract({ monthly_salary: found(v, `Salaris € ${v}`, 1, 'Salaris') }))]).scalars.monthlySalary[0]?.status;
  assert.deepEqual([read(100_000), read(100_000.01)], ['exact', 'implausible']);
});

test('P3 #29: a correction the documents later agree with is satisfied_by_documents - the documentary state is kept', () => {
  const earlier = resolve('2026-06-01', [base(0, 'u-base', rate(16.2)), payslip(1, 'u-s', 16.8, period('2026-03-02', '2026-03-08'))]);
  const decision = correct(earlier, RATE, 16.5, 'eur_per_hour');
  assert.equal(applyUserDecisions(earlier, [decision]).profile.employment.hourlyRate.state, 'user_corrected');
  const later = resolve('2026-06-01', [base(0, 'u-base', rate(16.5)), payslip(1, 'u-s', 16.5, period('2026-03-02', '2026-03-08'))]);
  const out = applyUserDecisions(later, [decision]);
  assert.deepEqual(results(out), [['dec-1', 'satisfied_by_documents', null]]);
  assert.deepEqual([out.profile.employment.hourlyRate.state, out.profile.employment.hourlyRate.value, out.profile.employment.hourlyRate.resolution], ['corroborated', 16.5, null]);
});

test('P3 #30: with the fingerprint unchanged a correction overrides a document_exact value - documentary evidence kept', () => {
  const documentary = resolve('2026-06-01', [base(0, 'u-base', rate(16.2))]);
  const out = applyUserDecisions(documentary, [correct(documentary, RATE, 16.5, 'eur_per_hour')]);
  const f = out.profile.employment.hourlyRate;
  assert.deepEqual([results(out)[0]?.[1], f.state, f.value], ['applied', 'user_corrected', 16.5]);
  assert.deepEqual(f.candidates, documentary.employment.hourlyRate.candidates);
  assert.deepEqual(f.resolution?.previous, { state: 'document_exact', value: 16.2, reason: null });
});

// ---------------------------------------------------------------------------------------------
// #39 duplicates, #40 as-of across a boundary
// ---------------------------------------------------------------------------------------------

test('P3 #39: two decisions for one field - the last wins under the normal rules, earlier ones are duplicate_field_decision; results in request order', () => {
  const documentary = resolve('2026-09-15', [...a2Documents(), payslip(3, 'u-p1', 16.2, period('2026-09-14', '2026-09-20'), { deduction_lines: [pension(7.5)] }), payslip(4, 'u-p2', 16.2, period('2026-09-21', '2026-09-27'), { deduction_lines: [pension(7.9)] })]);
  const out = applyUserDecisions(documentary, [correct(documentary, RATE, 17, 'eur_per_hour', 'first'), confirm(documentary, PENSION, 7.5, 'other-field'), confirm(documentary, RATE, 16.8, 'last')]);
  assert.deepEqual(results(out), [['first', 'rejected', 'duplicate_field_decision'], ['other-field', 'applied', null], ['last', 'applied', null]]);
  assert.deepEqual([out.profile.employment.hourlyRate.state, out.profile.employment.hourlyRate.value, out.profile.employment.hourlyRate.resolution?.decisionId], ['user_confirmed', 16.8, 'last']);
  // The last one is judged normally: if it is invalid, the field stays documentary.
  const invalidLast = applyUserDecisions(documentary, [correct(documentary, RATE, 17, 'eur_per_hour', 'first'), correct(documentary, RATE, 999, 'eur_per_hour', 'last')]);
  assert.deepEqual(results(invalidLast), [['first', 'rejected', 'duplicate_field_decision'], ['last', 'rejected', 'invalid_value']]);
  assert.equal(invalidLast.profile.employment.hourlyRate.state, 'conflict');
});

test('P3 #40: moving the as-of date across the annex boundary stales the affected decision; an unrelated decision stays applied', () => {
  const docs = () => [
    base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', rate(16.8)),
    payslip(2, 'u-june', 16.6, period('2026-06-01', '2026-06-07'), { deduction_lines: [pension(7.5)] }),
    payslip(3, 'u-march', 16.6, period('2026-03-02', '2026-03-08'), { deduction_lines: [pension(7.9)] }),
  ];
  const june = resolve('2026-06-15', docs());
  assert.deepEqual([june.employment.hourlyRate.state, june.payroll.pensionEmployeePercent.state], ['conflict', 'conflict']);
  const decisions = [correct(june, RATE, 16.4, 'eur_per_hour', 'rate'), confirm(june, PENSION, 7.5, 'pension')];
  assert.deepEqual(results(applyUserDecisions(june, decisions)), [['rate', 'applied', null], ['pension', 'applied', null]]);
  const september = resolve('2026-09-15', docs());
  const out = applyUserDecisions(september, decisions);
  assert.deepEqual(results(out), [['rate', 'stale', 'evidence_changed'], ['pension', 'applied', null]]);
  assert.deepEqual([out.profile.employment.hourlyRate.state, out.profile.employment.hourlyRate.value], ['document_exact', 16.8], 'the new regime decides; the old decision is not silently kept');
  assert.equal(out.profile.payroll.pensionEmployeePercent.state, 'user_confirmed');
});

// ---------------------------------------------------------------------------------------------
// #42-#47 - temporal fingerprint semantics
// ---------------------------------------------------------------------------------------------

test('P3 #42: the same displayed value under a changed annex effective date (another regime) is stale / evidence_changed', () => {
  const at = (annexDate: string) => resolve('2026-10-01', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', annexDate, rate(16.8))]);
  const september = at('2026-09-01');
  const august = at('2026-08-01');
  for (const p of [september, august]) assert.deepEqual([p.employment.hourlyRate.state, p.employment.hourlyRate.value, p.employment.hourlyRate.candidates.map((c) => c.value)], ['document_exact', 16.8, [16.8]]);
  assert.notEqual(fp(september, RATE), fp(august, RATE));
  assert.deepEqual(results(applyUserDecisions(august, [correct(september, RATE, 17, 'eur_per_hour')])), [['dec-1', 'stale', 'evidence_changed']]);
});

test('P3 #43: the same payslip value moving from before the regime into it is stale', () => {
  const at = (when: Record<string, unknown>) => resolve('2026-09-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', rate(16.8)), payslip(2, 'u-s', 16.8, when)]);
  const before = at(period('2026-08-24', '2026-08-30'));
  const inside = at(period('2026-09-07', '2026-09-13'));
  assert.deepEqual([before.employment.hourlyRate.excluded.at(-1)?.reason, inside.employment.hourlyRate.state], ['superseded_by_later_document', 'corroborated']);
  assert.deepEqual(results(applyUserDecisions(inside, [correct(before, RATE, 17, 'eur_per_hour')])), [['dec-1', 'stale', 'evidence_changed']]);
});

test('P3 #44: page, raw-text formatting and printed-label wording are presentation noise - identical fingerprint, the decision stays applied', () => {
  const plain = resolve('2026-06-01', [
    base(0, 'u-base', rate(15.55)),
    payslip(1, 'u-s', 16.2, period('2026-03-02', '2026-03-08')),
  ]);
  const reworded = resolve('2026-06-01', [
    base(0, 'u-base', rate(15.55, 'uurloon:   €15,55 bruto per uur', 2, 'Bruto uurloon'), [1, 2]),
    payslip(1, 'u-s', 16.2, period('2026-03-02', '2026-03-08'), { hour_lines: [rateLine(16.2, { page: 2, raw: 'Normale uren  40,00 x 16,20 = 648,00', description: 'Normale uren' })] }, [1, 2]),
  ]);
  const a = plain.employment.hourlyRate;
  const b = reworded.employment.hourlyRate;
  assert.notDeepEqual([a.sources.map((s) => [s.page, s.rawValue, s.printedLabel])], [b.sources.map((s) => [s.page, s.rawValue, s.printedLabel])], 'the noise really differs');
  assert.equal(fp(plain, RATE), fp(reworded, RATE));
  const out = applyUserDecisions(reworded, [confirm(plain, RATE, 16.2)]);
  assert.deepEqual([results(out)[0]?.[1], out.profile.employment.hourlyRate.state], ['applied', 'user_confirmed']);
});

test('P3 #45: a change to evidence outside the field\'s fingerprint does not stale its decision', () => {
  const docs = (netAmount: number, extra: ProfileDocumentInput[] = []) => resolve('2026-09-15', [...a2Documents().slice(0, 2), payslip(2, 'u-slip', 16.2, period('2026-09-07', '2026-09-13'), { net_lines: [housing(netAmount)] }), ...extra]);
  const first = docs(95);
  const decision = confirm(first, RATE, 16.2);
  // Another net-line amount on the same payslip, plus a new in-force annex that only states guaranteed hours.
  const changed = docs(96, [annex(3, 'u-annex-2', '2026-09-10', { guaranteed_hours: found(64, '64 uur per 4 weken', 1, 'Garantie') }, 'aneks-2.pdf')]);
  assert.notEqual(fp(first, HOUSING), fp(changed, HOUSING), 'control: the changed field\'s fingerprint did change');
  assert.equal(fp(first, RATE), fp(changed, RATE));
  assert.deepEqual(results(applyUserDecisions(changed, [decision])), [['dec-1', 'applied', null]]);
});

test('P3 #46: moving the as-of date inside the same regime changes no fingerprint - including a timeline disagreement, whose reason echoes the date', () => {
  const docs = () => [...a2Documents(), annex(3, 'u-h1', '2026-09-01', { hours_per_week: found(32, '32 uur', 1, 'Arbeidsduur') }, 'aneks-h1.pdf'), annex(4, 'u-h2', '2026-09-01', { hours_per_week: found(36, '36 uur', 1, 'Arbeidsduur') }, 'aneks-h2.pdf')];
  const early = resolve('2026-09-15', docs());
  const late = resolve('2026-09-30', docs());
  assert.equal(fp(early, RATE), fp(late, RATE));
  const hpw: ProfileFieldPath = 'employment.hoursPerWeek';
  assert.deepEqual([early.employment.hoursPerWeek.reason, late.employment.hoursPerWeek.reason], [{ code: 'timeline_disagreement', asOfDate: '2026-09-15' }, { code: 'timeline_disagreement', asOfDate: '2026-09-30' }]);
  assert.equal(fp(early, hpw), fp(late, hpw));
  assert.deepEqual(results(applyUserDecisions(late, [confirm(early, RATE, 16.2, 'r'), confirm(early, hpw, 32, 'h')])), [['r', 'applied', null], ['h', 'applied', null]]);
});

test('P3 #47: reordering documents (new request indices, same documentIds) changes no fingerprint and keeps the decision applied', () => {
  const ordered = resolve('2026-09-15', a2Documents());
  const reordered = resolve('2026-09-15', [...a2Documents()].reverse().map((d, index) => ({ ...d, index })));
  assert.notDeepEqual(ordered.documents.map((d) => d.index), reordered.documents.map((d) => d.documentId === 'u-base' ? 0 : d.documentId === 'u-annex' ? 1 : 2), 'indices really moved');
  assert.equal(reordered.employment.hourlyRate.candidates.find((c) => c.source.role === 'payslip')?.source.documentIndex, 0);
  assert.equal(fp(ordered, RATE), fp(reordered, RATE));
  assert.deepEqual(results(applyUserDecisions(reordered, [confirm(ordered, RATE, 16.2)])), [['dec-1', 'applied', null]]);
});

// ---------------------------------------------------------------------------------------------
// §19 - fingerprint identity tests
// ---------------------------------------------------------------------------------------------

test('P3 S3 §19.1/19.2: the order of candidates and of excluded evidence does not change the fingerprint', () => {
  const p = resolve('2026-09-15', [...a2Documents(), payslip(3, 'u-old', 16.2, period('2026-08-24', '2026-08-30')), payslip(4, 'u-new', 16.5, period('2026-09-14', '2026-09-20'))]);
  const f = p.employment.hourlyRate;
  assert.ok(f.candidates.length >= 3 && f.excluded.length >= 2);
  const shuffled = { ...f, candidates: [...f.candidates].reverse(), excluded: [...f.excluded].reverse() };
  assert.equal(evidenceFingerprint(RATE, shuffled, p.documents), evidenceFingerprint(RATE, f, p.documents));
  assert.notEqual(evidenceFingerprint(RATE, { ...f, candidates: f.candidates.slice(1) }, p.documents), evidenceFingerprint(RATE, f, p.documents), 'control: dropping a candidate does change it');
});

test('P3 S3 §19.3-19.5: the overlay never feeds back into the documentary fingerprint; decidedAt and decisionId do not affect it', () => {
  const documentary = resolve('2026-09-15', a2Documents());
  const documentaryFp = fp(documentary, RATE);
  const once = applyUserDecisions(documentary, [confirm(documentary, RATE, 16.2, 'id-a', '2026-10-05T10:00:00Z')]);
  const overlaid = once.profile.employment.hourlyRate;
  assert.equal(evidenceFingerprint(RATE, overlaid, once.profile.documents), documentaryFp, 'an applied decision does not change the fingerprint of its field');
  // Re-sending the same decision on the next resolve (the stateless model) applies it again, identically.
  const again = applyUserDecisions(resolve('2026-09-15', a2Documents()), [confirm(documentary, RATE, 16.2, 'id-a', '2026-10-05T10:00:00Z')]);
  assert.equal(JSON.stringify(again.profile), JSON.stringify(once.profile));
  const otherMeta = applyUserDecisions(documentary, [confirm(documentary, RATE, 16.2, 'id-b', '2027-01-01')]).profile.employment.hourlyRate;
  assert.equal(otherMeta.resolution?.evidenceFingerprint, documentaryFp);
  assert.deepEqual({ ...otherMeta, sources: [], resolution: null }, { ...overlaid, sources: [], resolution: null }, 'only the decision id and date differ');
  assert.deepEqual([otherMeta.resolution?.decisionId, otherMeta.resolution?.decidedAt], ['id-b', '2027-01-01']);
});

test('P3 S3 §19.6: the same label with different stable documentIds is a different identity', () => {
  const two = (rateA: number, rateB: number) => resolve('2026-06-01', [
    payslip(0, 'id-A', rateA, period('2026-03-02', '2026-03-08'), {}, [1], 'pasek.pdf'),
    payslip(1, 'id-B', rateB, period('2026-03-09', '2026-03-15'), {}, [1], 'pasek.pdf'),
  ]);
  const ab = two(16.2, 16.5);
  assert.equal(fp(ab, RATE), fp(two(16.2, 16.5), RATE));
  // Same labels, same periods per document... but which identity carries which value is part of the evidence.
  const swappedIds = resolve('2026-06-01', [
    payslip(0, 'id-B', 16.2, period('2026-03-02', '2026-03-08'), {}, [1], 'pasek.pdf'),
    payslip(1, 'id-A', 16.5, period('2026-03-09', '2026-03-15'), {}, [1], 'pasek.pdf'),
  ]);
  assert.notEqual(fp(ab, RATE), fp(swappedIds, RATE));
});

test('P3 S3 §19.7: without ids the fallback key is role + label + ordinal - deterministic, never the request index, never colliding with an id', () => {
  const docs = (order: 'ab' | 'ba') => {
    const a = payslip(0, null, 16.2, period('2026-03-02', '2026-03-08'), {}, [1], 'pasek-a.pdf');
    const b = payslip(1, null, 16.5, period('2026-03-09', '2026-03-15'), {}, [1], 'pasek-b.pdf');
    return resolve('2026-06-01', (order === 'ab' ? [a, b] : [b, a]).map((d, index) => ({ ...d, index })));
  };
  assert.equal(fp(docs('ab'), RATE), fp(docs('ab'), RATE));
  assert.equal(fp(docs('ab'), RATE), fp(docs('ba'), RATE), 'distinct labels: reordering is still harmless');
  const keys = documentKeys([
    { index: 0, documentId: null, label: 'pasek.pdf', role: 'payslip', effectiveDate: null, payPeriod: null },
    { index: 1, documentId: null, label: 'pasek.pdf', role: 'payslip', effectiveDate: null, payPeriod: null },
    { index: 2, documentId: null, label: 'pasek.pdf', role: 'contract_base', effectiveDate: null, payPeriod: null },
    { index: 3, documentId: '["fallback","payslip","pasek.pdf",0]', label: 'x.pdf', role: 'payslip', effectiveDate: null, payPeriod: null },
  ]);
  assert.deepEqual([...keys.values()], ['["fallback","payslip","pasek.pdf",0]', '["fallback","payslip","pasek.pdf",1]', '["fallback","contract_base","pasek.pdf",0]', '["id","[\\"fallback\\",\\"payslip\\",\\"pasek.pdf\\",0]"]']);
  assert.equal(new Set(keys.values()).size, 4, 'an id shaped like a fallback key still has its own identity');
});

test('P3 S3 §19.8: duplicate documentIds are refused before any fingerprint exists', () => {
  const documentary = resolve('2026-06-01', [base(0, 'same', rate(16.2)), payslip(1, 'same', 16.5, period('2026-03-02', '2026-03-08'))]);
  assert.throws(() => documentKeys(documentary.documents), /duplicate documentId/);
  assert.throws(() => profileFieldFingerprint(documentary, RATE), /duplicate documentId/);
  assert.throws(() => applyUserDecisions(documentary, []), /duplicate documentId/, 'not even an empty decision list is evaluated over an ambiguous identity');
});

// ---------------------------------------------------------------------------------------------
// Focused
// ---------------------------------------------------------------------------------------------

test('P3 S3: field paths - only the three canonical shapes are targetable; calibration, observed premiums and facts are not', () => {
  for (const ok of ['employment.hourlyRate', 'payroll.periodType', 'recurringItems.netDeductions.net_deduction:housing:huisvesting', 'recurringItems.surcharges.surcharge:irregular:toeslag 25.5%']) assert.ok(isProfileFieldPath(ok), ok);
  for (const bad of ['employment.nope', 'payroll.', 'calibrationOnly.payslips.0', 'observedOvertimePremiums.fields.0', 'recurringItems.netDeductions', 'recurringItems.netDeductions.', 'recurringItems.notACollection.x', 'contract.hourlyRate', 'hourlyRate', '', `employment.${'x'.repeat(300)}`]) assert.ok(!isProfileFieldPath(bad), bad);
  const p = resolve('2026-06-01', [payslip(0, 'u', 16.2, period('2026-03-02', '2026-03-08'), { net_lines: [housing(95)] })]);
  assert.equal(findProfileField(p, HOUSING)?.value, 95);
  assert.equal(findProfileField(p, 'recurringItems.netDeductions.net_deduction:housing:other'), null);
});

test('P3 S3: the fingerprint is 16 lower-case hex characters over canonical JSON; it keeps printed pay-period dates exactly as given (an inverted period is not swapped)', () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }] }), '{"a":[{"c":"x","d":null}],"b":1}');
  const at = (start: string, end: string) => resolve('2026-06-01', [payslip(0, 'u', 16.2, period(start, end))]);
  assert.match(fp(at('2026-03-02', '2026-03-08'), RATE), /^[0-9a-f]{16}$/);
  assert.notEqual(fp(at('2026-03-08', '2026-03-02'), RATE), fp(at('2026-03-02', '2026-03-08'), RATE), 'the inverted printed period is fingerprinted as printed (unchanged follow-up)');
});

test('P3 S3: the regime identity is part of the fingerprint - a moved regime end (future annex date) changes it even when no candidate or exclusion does', () => {
  const at = (futureDate: string) => resolve('2026-06-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', futureDate, rate(16.8))]);
  const september = at('2026-09-01');
  const october = at('2026-10-01');
  const a = september.employment.hourlyRate;
  const b = october.employment.hourlyRate;
  assert.deepEqual([a.state, a.value, a.candidates, a.excluded], [b.state, b.value, b.candidates, b.excluded]);
  assert.deepEqual([a.regime?.end, b.regime?.end], ['2026-09-01', '2026-10-01']);
  assert.notEqual(fp(september, RATE), fp(october, RATE));
});
