import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolvePayrollProfile, type ProfileDocumentInput, type PayrollProfile, type ProfileField, type ProfileUnit } from './payroll-profile.js';
import {
  applyUserDecisions, profileFieldFingerprint, UNIT_RULES, PROFILE_UNITS,
  type ProfileFieldPath, type UserProfileDecision, type ConfirmCandidateDecision, type CorrectValueDecision,
} from './profile-decisions.js';
import {
  buildProfileIssues, evaluateReadiness, calculationReadiness, normalizeActiveGroups, candidateIdOf, inputFor, enumerateProfileFields,
  REQUIREMENT_GROUPS, REQUIREMENT_GROUP_IDS, DEFAULT_ACTIVE_GROUPS, UNIT_INPUTS,
  type RequirementGroupId, type RequirementGroupTable, type ProfileIssue,
} from './profile-readiness.js';
import { mergePayslipBatches, mergeContractBatches } from './document-facts.js';
import { payslipBatch, contractBatch, rawPayslip, rawContract, found, ambiguous, absent, hourLine, overtimeLine } from '../test-support/fact-fixtures.js';

/**
 * P3.1 S4 (LOONTO-PRO-P3-DECISION-LOCK.md decisions D, E; ZADANIE-P3.1-S4-READINESS.md): requirement groups,
 * issue severity, the issue payload and calculation readiness. Synthetic reader responses only, mapped by
 * the production mapper; decisions and fingerprints are the real S3 ones - nothing here is faked.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fmt = (n: number) => n.toFixed(2).replace('.', ',');

const RATE: ProfileFieldPath = 'employment.hourlyRate';
const PERIOD_TYPE: ProfileFieldPath = 'payroll.periodType';
const HOURS: ProfileFieldPath = 'employment.hoursPerWeek';
const PENSION: ProfileFieldPath = 'payroll.pensionEmployeePercent';
const HOUSING: ProfileFieldPath = 'recurringItems.netDeductions.net_deduction:housing:huisvesting';
const LHK: ProfileFieldPath = 'payroll.loonheffingskorting';
const TIER1: ProfileFieldPath = 'payroll.overtimeTier1Premium';
const TIER2: ProfileFieldPath = 'payroll.overtimeTier2Premium';
const OT_THRESHOLD: ProfileFieldPath = 'employment.overtimeThresholdHours';
const SATURDAY: ProfileFieldPath = 'payroll.saturdayPremium';

function rateLine(rate: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const amount = Math.round(40 * rate * 100) / 100;
  return hourLine({ rate, amount, raw: `Uren normaal 40,00 ${fmt(rate)} ${fmt(amount)}`, ...extra });
}
function period(start: string | null, end: string | null): Record<string, unknown> {
  return { period_start: start ? found(start, `van ${start}`, 1, 'Periode') : absent, period_end: end ? found(end, `t/m ${end}`, 1, 'Periode') : absent };
}
const pension = (percent: number) => ({ description: 'Pensioen StiPP', placement: 'pre_tax', category: 'pension', percent, base: 648, amount: Math.round(648 * percent) / 100, raw: `Pensioen StiPP ${fmt(percent)}% 648,00 ${fmt(Math.round(648 * percent) / 100)}`, page: 1, unclear_fields: [] });
const housing = (amount: number) => ({ description: 'Huisvesting', category: 'housing', amount, raw: `Huisvesting ${fmt(amount)}`, page: 1, unclear_fields: [] });

function payslip(index: number, id: string | null, rate: number, when: Record<string, unknown>, extra: Record<string, unknown> = {}, pages = [1]): ProfileDocumentInput {
  return { index, ...(id ? { documentId: id } : {}), label: `pasek-${id ?? index}.pdf`, role: 'payslip', effectiveDate: null, facts: mergePayslipBatches([payslipBatch(rawPayslip({ ...when, hour_lines: [rateLine(rate)], ...extra }), pages)]) };
}
function base(index: number, id: string | null, raw: Record<string, unknown>, pages = [1]): ProfileDocumentInput {
  return { index, ...(id ? { documentId: id } : {}), label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, facts: mergeContractBatches([contractBatch(rawContract(raw), pages)]) };
}
function annex(index: number, id: string | null, date: string | null, raw: Record<string, unknown>): ProfileDocumentInput {
  return { index, ...(id ? { documentId: id } : {}), label: 'aneks.pdf', role: 'contract_annex', effectiveDate: date, facts: mergeContractBatches([contractBatch(rawContract(raw))]) };
}
const rate = (v: number, raw = `Uurloon € ${fmt(v)}`, page = 1, label = 'Uurloon') => ({ hourly_rate: found(v, raw, page, label) });
/** A base contract that settles every optional core_pay field: only what a test varies stays open. */
const coreBase = (rateValue: number) => base(0, 'u-base', {
  ...rate(rateValue), hours_per_week: found(40, '40 uur per week', 1, 'Arbeidsduur'),
  guaranteed_hours: found(64, '64 uur per 4 weken', 1, 'Garantie'), guaranteed_hours_period_weeks: found(4, '4 weken', 1, 'Garantie'),
});

const resolve = (asOfDate: string, documents: ProfileDocumentInput[]): PayrollProfile => resolvePayrollProfile({ asOfDate, documents });
const fp = (profile: PayrollProfile, p: ProfileFieldPath): string => profileFieldFingerprint(profile, p) as string;
const DECIDED_AT = '2026-10-05T10:00:00Z';
const confirm = (profile: PayrollProfile, fieldPath: ProfileFieldPath, value: number | string | boolean, decisionId = 'dec-1'): ConfirmCandidateDecision => ({ kind: 'confirm_candidate', decisionId, fieldPath, value, evidenceFingerprint: fp(profile, fieldPath), decidedAt: DECIDED_AT });
const correct = (profile: PayrollProfile, fieldPath: ProfileFieldPath, value: number | string | boolean, unit: ProfileUnit, decisionId = 'dec-1'): CorrectValueDecision => ({ kind: 'correct_value', decisionId, fieldPath, value, unit, evidenceFingerprint: fp(profile, fieldPath), decidedAt: DECIDED_AT });

const evaluate = (profile: PayrollProfile, groups?: RequirementGroupId[]) => evaluateReadiness(profile, groups ? { groups } : {});
const find = (issues: ProfileIssue[], p: ProfileFieldPath) => issues.find((i) => i.fieldPath === p);
const sev = (issues: ProfileIssue[], p: ProfileFieldPath) => find(issues, p)?.severity ?? null;
const paths = (issues: ProfileIssue[], severity?: string) => issues.filter((i) => !severity || i.severity === severity).map((i) => i.fieldPath);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

/** Core pay resolved; a two-payslip net-deduction conflict (95 vs 96) and a pension conflict (7.5 vs 7.9). */
const richDocuments = (): ProfileDocumentInput[] => [
  coreBase(16.2),
  payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'), { deduction_lines: [pension(7.5)], net_lines: [housing(95)], hour_lines: [rateLine(16.2), overtimeLine(150)] }),
  payslip(2, 'u-b', 16.2, period('2026-03-09', '2026-03-15'), { deduction_lines: [pension(7.9)], net_lines: [housing(96)] }),
];
/** Base 15.55 against payslips at 16.20: a core_pay conflict (hourlyRate). */
const rateConflictDocuments = (): ProfileDocumentInput[] => [coreBase(15.55), payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'))];

// ---------------------------------------------------------------------------------------------
// Canonical matrix
// ---------------------------------------------------------------------------------------------

test('P3 #11: an unresolved field that no active group requires does not block - ready, zero blocking, the conflict stays a visible optional issue', () => {
  const profile = resolve('2026-06-01', [coreBase(16.2), payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'), { net_lines: [housing(95)] }), payslip(2, 'u-b', 16.2, period('2026-03-09', '2026-03-15'), { net_lines: [housing(96)] })]);
  assert.equal(profile.recurringItems.netDeductions[0]?.state, 'conflict');
  const { issues, readiness } = evaluate(profile);
  assert.deepEqual([sev(issues, HOUSING), find(issues, HOUSING)?.groups], ['optional', ['net_items']]);
  assert.deepEqual(readiness, { activeGroups: ['core_pay'], ready: true, blockingCount: 0, optionalCount: 1 });
  assert.deepEqual(paths(issues, 'blocking'), []);
  // With net_items active the same conflict is still optional (net_items has no required field).
  const withNet = evaluate(profile, ['core_pay', 'net_items']);
  assert.deepEqual([sev(withNet.issues, HOUSING), withNet.readiness.ready, withNet.readiness.blockingCount], ['optional', true, 0]);
});

test('P3 #12: a required unresolved field blocks (core_pay hourlyRate conflict); resolving it with an S3 decision removes the issue and readies the profile', () => {
  const documentary = resolve('2026-06-01', rateConflictDocuments());
  assert.equal(documentary.employment.hourlyRate.state, 'conflict');
  const before = evaluate(documentary);
  assert.deepEqual([sev(before.issues, RATE), before.readiness.ready, before.readiness.blockingCount], ['blocking', false, 1]);
  assert.deepEqual(paths(before.issues, 'blocking'), [RATE]);
  const decision = confirm(documentary, RATE, 16.2);
  const out = applyUserDecisions(documentary, [decision]);
  const after = evaluateReadiness(out.profile, { groups: ['core_pay'], decisions: [decision], decisionResults: out.decisionResults });
  assert.equal(out.profile.employment.hourlyRate.state, 'user_confirmed');
  assert.equal(find(after.issues, RATE), undefined, 'a user-resolved field is not an issue');
  assert.deepEqual(after.readiness, { activeGroups: ['core_pay'], ready: true, blockingCount: 0, optionalCount: 0 });
});

test('P3 #13: no global payslip gate - issues are field-level, nothing per payslip or from the replay enters readiness', () => {
  const profile = resolve('2026-06-01', rateConflictDocuments());
  const issue = find(evaluate(profile).issues, RATE) as ProfileIssue;
  assert.deepEqual(Object.keys(issue).sort(), ['actions', 'candidates', 'evidenceFingerprint', 'excluded', 'fieldPath', 'groups', 'hints', 'impact', 'input', 'key', 'meaning', 'previousDecision', 'reason', 'severity', 'state', 'unit']);
  assert.deepEqual(Object.keys(evaluate(profile).readiness).sort(), ['activeGroups', 'blockingCount', 'optionalCount', 'ready']);
  // The module takes a profile and requirement groups (and S3 decisions): its source imports no replay, no
  // consistency or needsConfirmation helper, and mentions no per-payslip confirmation.
  const source = readFileSync(path.join(here, 'profile-readiness.js'), 'utf-8');
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./payroll-profile.js', './profile-decisions.js', 'node:crypto']);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const gate of ['needsConfirmation', 'discrepanc', 'replay', 'fullyReproduced', 'confirmedIssueKeys', 'payslipAnalysis']) assert.ok(!code.includes(gate), `readiness code must not mention ${gate}`);
  // Two payslips, one of them with a blocking problem of its own, still yield only field issues.
  assert.ok(evaluate(profile).issues.every((i) => /^(employment|payroll|recurringItems)\./.test(i.fieldPath)));
});

test('P3 #31: default and activation - no requirements means core_pay (hourlyRate and periodType may block); overtime blocks only once activated; [] blocks nothing', () => {
  assert.deepEqual([...DEFAULT_ACTIVE_GROUPS], ['core_pay']);
  assert.deepEqual(normalizeActiveGroups(undefined), ['core_pay']);
  // A rate conflict and no payslip at all (periodType unknown): both core_pay requirements block.
  const profile = resolve('2026-06-01', [coreBase(15.55), payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'), { period_type: absent })]);
  assert.equal(profile.payroll.periodType.state, 'unknown');
  const byDefault = evaluate(profile);
  assert.deepEqual([byDefault.readiness.activeGroups, paths(byDefault.issues, 'blocking')], [['core_pay'], [RATE, PERIOD_TYPE]]);
  assert.deepEqual([sev(byDefault.issues, OT_THRESHOLD), sev(byDefault.issues, TIER1), sev(byDefault.issues, TIER2), sev(byDefault.issues, SATURDAY)], ['informational', 'informational', 'informational', 'informational'], 'overtime / saturday never block by default');
  const withOvertime = evaluate(profile, ['core_pay', 'overtime']);
  assert.deepEqual(paths(withOvertime.issues, 'blocking'), [RATE, PERIOD_TYPE, OT_THRESHOLD, TIER1, TIER2]);
  assert.deepEqual([withOvertime.readiness.ready, withOvertime.readiness.blockingCount], [false, 5]);
  const none = evaluate(profile, []);
  assert.deepEqual(none.readiness, { activeGroups: [], ready: true, blockingCount: 0, optionalCount: 1 });
  assert.deepEqual([sev(none.issues, RATE), sev(none.issues, PERIOD_TYPE)], ['optional', 'informational'], 'no requirement-derived blocking: the conflict stays optional, the unknown informational');
  assert.deepEqual(none.issues.filter((i) => i.severity === 'blocking'), []);
});

test('P3 #32: outside the active groups a conflict is optional and an unknown informational', () => {
  const profile = resolve('2026-06-01', richDocuments());
  const { issues } = evaluate(profile);
  assert.equal(profile.payroll.pensionEmployeePercent.state, 'conflict');
  assert.deepEqual([sev(issues, PENSION), find(issues, PENSION)?.groups], ['optional', ['employee_deductions']], 'a conflict outside every active group');
  assert.equal(profile.payroll.saturdayPremium.state, 'unknown');
  assert.deepEqual([sev(issues, SATURDAY), sev(issues, 'employment.caoName'), sev(issues, 'payroll.bijzonderTariefPrintedPercent')], ['informational', 'informational', 'informational']);
  assert.deepEqual(find(issues, 'employment.caoName')?.groups, [], 'a field in no group has no groups');
  // Inside an ACTIVE group the same unknown / conflict is judged by that group.
  const active = evaluate(profile, ['core_pay', 'saturday', 'employee_deductions']).issues;
  assert.deepEqual([sev(active, SATURDAY), sev(active, PENSION)], ['blocking', 'optional']);
  assert.equal(sev(active, 'payroll.pawwEmployeePercent'), 'optional', 'an unknown that an active group lists as optional is optional, not informational');
});

test('P3 #33: loonheffingskorting blocks only when tax_settings is active; otherwise it is an informational unknown', () => {
  const profile = resolve('2026-06-01', [coreBase(16.2), payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'))]);
  assert.deepEqual([profile.payroll.loonheffingskorting.state, profile.payroll.loonheffingskorting.reason], ['unknown', { code: 'no_evidence_source' }], 'no document source, and none is invented');
  for (const groups of [undefined, ['core_pay'], [], ['core_pay', 'net_items']] as Array<RequirementGroupId[] | undefined>) {
    const { issues, readiness } = evaluate(profile, groups);
    assert.deepEqual([sev(issues, LHK), readiness.ready], ['informational', true], JSON.stringify(groups));
  }
  assert.equal(sev(evaluate(profile, ['core_pay', 'overtime']).issues, LHK), 'informational', 'other active groups do not make it required');
  const active = evaluate(profile, ['tax_settings']);
  assert.deepEqual([sev(active.issues, LHK), active.readiness.ready, active.readiness.blockingCount, find(active.issues, LHK)?.groups], ['blocking', false, 1, ['tax_settings']]);
  assert.deepEqual([find(active.issues, LHK)?.input, find(active.issues, LHK)?.actions], [{ kind: 'boolean' }, ['enter_value']]);
  // The user states it (S3 correction): ready.
  const decision = correct(profile, LHK, true, 'boolean');
  const out = applyUserDecisions(profile, [decision]);
  assert.deepEqual(evaluateReadiness(out.profile, { groups: ['tax_settings'], decisions: [decision], decisionResults: out.decisionResults }).readiness.ready, true);
});

// ---------------------------------------------------------------------------------------------
// §23 additional tests
// ---------------------------------------------------------------------------------------------

test('P3 S4 §23.1/23.2/23.20: user_confirmed and user_corrected fields produce no issue; counts are unique-field counts', () => {
  const documentary = resolve('2026-06-01', richDocuments());
  const decisions: UserProfileDecision[] = [confirm(documentary, PENSION, 7.5, 'd-pension'), correct(documentary, HOUSING, 90, 'eur_per_period', 'd-housing')];
  const out = applyUserDecisions(documentary, decisions);
  assert.deepEqual(out.decisionResults.map((r) => r.status), ['applied', 'applied']);
  assert.deepEqual([out.profile.payroll.pensionEmployeePercent.state, out.profile.recurringItems.netDeductions[0]?.state], ['user_confirmed', 'user_corrected']);
  const before = evaluate(documentary, ['core_pay', 'employee_deductions', 'net_items']);
  const after = evaluateReadiness(out.profile, { groups: ['core_pay', 'employee_deductions', 'net_items'], decisions, decisionResults: out.decisionResults });
  assert.ok(find(before.issues, PENSION) && find(before.issues, HOUSING));
  assert.deepEqual([find(after.issues, PENSION), find(after.issues, HOUSING)], [undefined, undefined]);
  assert.equal(after.readiness.optionalCount, before.readiness.optionalCount - 2);
  assert.equal(after.issues.length, new Set(after.issues.map((i) => i.fieldPath)).size, 'one issue per field');
  assert.deepEqual([after.readiness.blockingCount, after.readiness.optionalCount], [after.issues.filter((i) => i.severity === 'blocking').length, after.issues.filter((i) => i.severity === 'optional').length]);
});

test('P3 S4 §23.3: a stale decision restores the documentary issue and exposes it as previousDecision; the field is never silently resolved', () => {
  const a2 = [coreBase(16.2), payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'))];
  const old = resolve('2026-06-01', [coreBase(15.55), ...a2.slice(1)]);
  const decisions: UserProfileDecision[] = [confirm(old, RATE, 16.2, 'd-rate'), { ...correct(old, RATE, 90, 'eur_per_period', 'd-gone'), fieldPath: HOUSING, evidenceFingerprint: '0000000000000000' }];
  // New evidence: another payslip with yet another rate.
  const changed = resolve('2026-06-01', [coreBase(15.55), payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08')), payslip(2, 'u-new', 16.5, period('2026-03-09', '2026-03-15'))]);
  const out = applyUserDecisions(changed, decisions);
  assert.deepEqual(out.decisionResults.map((r) => [r.decisionId, r.status, r.problem]), [['d-rate', 'stale', 'evidence_changed'], ['d-gone', 'stale', 'field_not_found']]);
  const { issues } = evaluateReadiness(out.profile, { groups: ['core_pay'], decisions, decisionResults: out.decisionResults });
  const issue = find(issues, RATE) as ProfileIssue;
  assert.deepEqual([issue.state, issue.severity, issue.previousDecision], ['conflict', 'blocking', { kind: 'confirm_candidate', value: 16.2 }]);
  assert.equal(issue.evidenceFingerprint, fp(changed, RATE), 'the issue carries the CURRENT documentary fingerprint, so a re-decision is valid');
  assert.notEqual(issue.evidenceFingerprint, decisions[0]?.evidenceFingerprint);
  assert.equal(find(issues, HOUSING), undefined, 'a field that no longer exists has no issue - its result stays in decisionResults');
  // A confirmation of a value that is not a candidate is stale / candidate_not_present: it is previous too.
  const notCandidate = confirm(changed, RATE, 99, 'd-nc');
  const r1 = applyUserDecisions(changed, [notCandidate]);
  assert.deepEqual(r1.decisionResults.map((x) => [x.status, x.problem]), [['stale', 'candidate_not_present']]);
  assert.deepEqual(find(evaluateReadiness(r1.profile, { groups: ['core_pay'], decisions: [notCandidate], decisionResults: r1.decisionResults }).issues, RATE)?.previousDecision, { kind: 'confirm_candidate', value: 99 });
  // An APPLIED decision leaves no issue at all (and therefore no previousDecision).
  const corrected = correct(changed, RATE, 17.1, 'eur_per_hour', 'd-fix');
  const r2 = applyUserDecisions(changed, [corrected]);
  assert.equal(r2.decisionResults[0]?.status, 'applied');
  assert.equal(find(evaluateReadiness(r2.profile, { groups: ['core_pay'], decisions: [corrected], decisionResults: r2.decisionResults }).issues, RATE), undefined);
});

test('P3 S4 §23.3 (candidate_not_present, correction stale): previousDecision follows the last stale decision of the field', () => {
  const documentary = resolve('2026-06-01', rateConflictDocuments());
  const stale = { ...correct(documentary, RATE, 17.1, 'eur_per_hour', 'd-1'), evidenceFingerprint: '0123456789abcdef' };
  const out = applyUserDecisions(documentary, [stale]);
  assert.deepEqual(out.decisionResults.map((r) => r.problem), ['evidence_changed']);
  const issue = find(evaluateReadiness(out.profile, { decisions: [stale], decisionResults: out.decisionResults }).issues, RATE);
  assert.deepEqual(issue?.previousDecision, { kind: 'correct_value', value: 17.1 });
  // S3 returns the documentary field unchanged for a stale decision, so the issue is exactly the documentary one.
  assert.equal(issue?.evidenceFingerprint, fp(documentary, RATE));
  // Evaluate the candidate_not_present branch for real: confirm a value that is only excluded evidence.
  const a1 = resolve('2026-09-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', rate(16.8)), payslip(2, 'u-in', 16.5, period('2026-09-07', '2026-09-13'))]);
  const nc = confirm(a1, RATE, 16.2, 'd-nc');
  const r = applyUserDecisions(a1, [nc]);
  assert.deepEqual(r.decisionResults.map((x) => [x.status, x.problem]), [['stale', 'candidate_not_present']]);
  assert.deepEqual(find(evaluateReadiness(r.profile, { decisions: [nc], decisionResults: r.decisionResults }).issues, RATE)?.previousDecision, { kind: 'confirm_candidate', value: 16.2 });
});

test('P3 S4 §23.4: a rejected decision (invalid, wrong unit, duplicate) never becomes previousDecision', () => {
  const documentary = resolve('2026-06-01', rateConflictDocuments());
  const invalid = correct(documentary, RATE, 999, 'eur_per_hour', 'd-invalid');
  const wrongUnit = correct(documentary, RATE, 17, 'eur_per_month', 'd-unit');
  const earlier = correct(documentary, RATE, 17, 'eur_per_hour', 'd-dup');
  for (const decisions of [[invalid], [wrongUnit], [earlier, invalid]] as UserProfileDecision[][]) {
    const out = applyUserDecisions(documentary, decisions);
    assert.ok(out.decisionResults.every((r) => r.status === 'rejected'));
    assert.equal(find(evaluateReadiness(out.profile, { decisions, decisionResults: out.decisionResults }).issues, RATE)?.previousDecision, null);
  }
  // A duplicate does not hide the last decision: earlier rejected, last stale -> the LAST one is previous.
  const staleLast = { ...correct(documentary, RATE, 17.1, 'eur_per_hour', 'd-last'), evidenceFingerprint: 'ffffffffffffffff' };
  const decisions = [earlier, staleLast];
  const out = applyUserDecisions(documentary, decisions);
  assert.deepEqual(out.decisionResults.map((r) => [r.decisionId, r.status]), [['d-dup', 'rejected'], ['d-last', 'stale']]);
  assert.deepEqual(find(evaluateReadiness(out.profile, { decisions, decisionResults: out.decisionResults }).issues, RATE)?.previousDecision, { kind: 'correct_value', value: 17.1 });
  assert.throws(() => evaluateReadiness(documentary, { decisions: [invalid], decisionResults: [] }), /aligned/, 'misaligned decisions and results are refused loudly');
});

test('P3 S4 §23.5: candidate grouping - one issue candidate per value group, every source kept, contractual when any source is a contract, no winner', () => {
  const documentary = resolve('2026-06-01', [coreBase(16.2), payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08')), payslip(2, 'u-b', 16.5, period('2026-03-09', '2026-03-15')), payslip(3, 'u-c', 16.5, period('2026-03-16', '2026-03-22'))]);
  const issue = find(evaluate(documentary).issues, RATE) as ProfileIssue;
  assert.equal(documentary.employment.hourlyRate.candidates.length, 4);
  assert.deepEqual(issue.candidates.map((c) => [c.value, c.basis, c.sources.map((s) => s.documentLabel)]), [
    [16.2, 'contractual', ['umowa.pdf', 'pasek-u-a.pdf']],
    [16.5, 'employer_applied', ['pasek-u-b.pdf', 'pasek-u-c.pdf']],
  ]);
  assert.deepEqual(issue.candidates.flatMap((c) => c.sources).length, 4, 'no source is lost');
  assert.deepEqual([issue.state, issue.reason], ['conflict', { code: 'sources_disagree' }]);
  // The group value is the documentary value (not a client number) and the field's candidates are untouched.
  assert.deepEqual(issue.excluded, documentary.employment.hourlyRate.excluded);
});

test('P3 S4 §23.6/23.7: candidate ids are stable under page / raw / printed-label changes and under candidate order - and are neither random nor the fingerprint', () => {
  const plain = resolve('2026-06-01', [base(0, 'u-base', rate(15.55)), payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'))]);
  const reworded = resolve('2026-06-01', [
    base(0, 'u-base', rate(15.55, 'uurloon:   €15,55 bruto per uur', 2, 'Bruto uurloon'), [1, 2]),
    payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'), { hour_lines: [rateLine(16.2, { page: 2, raw: 'Normale uren  40,00 x 16,20 = 648,00', description: 'Normale uren' })] }, [1, 2]),
  ]);
  const ids = (p: PayrollProfile) => (find(evaluate(p).issues, RATE) as ProfileIssue).candidates.map((c) => c.candidateId);
  assert.deepEqual(ids(plain), ids(reworded));
  assert.notDeepEqual(plain.employment.hourlyRate.sources.map((s) => [s.page, s.rawValue]), reworded.employment.hourlyRate.sources.map((s) => [s.page, s.rawValue]), 'the noise really differs');
  // Reordered candidates (and reversed document list) give the same issue, byte for byte.
  const f = plain.employment.hourlyRate;
  const flipped: PayrollProfile = { ...plain, employment: { ...plain.employment, hourlyRate: { ...f, candidates: [...f.candidates].reverse() } } };
  assert.equal(JSON.stringify(find(evaluate(flipped).issues, RATE)), JSON.stringify(find(evaluate(plain).issues, RATE)));
  // Shape and identity: 16 hex, deterministic, different per value and per field, not the evidence fingerprint.
  const [a, b] = ids(plain) as [string, string];
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, b);
  assert.equal(candidateIdOf(RATE, 15.55), candidateIdOf(RATE, 15.55));
  assert.notEqual(candidateIdOf(RATE, 15.55), candidateIdOf(HOURS, 15.55));
  assert.ok(![a, b].includes(fp(plain, RATE)));
  assert.ok(!JSON.stringify(ids(plain)).includes('Uurloon'), 'no raw text inside an id');
});

test('P3 S4 §23.8/23.9: hints - superseded, unplaceable-matching, excluded values and observed premiums; unreadable facts give no hint; hints are never candidates', () => {
  // superseded: base 16.20 and an August payslip at 16.20 are history behind an annex that disagrees with an in-regime payslip.
  const a1 = resolve('2026-09-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', rate(16.8)), payslip(2, 'u-old', 16.2, period('2026-08-24', '2026-08-30')), payslip(3, 'u-in', 16.5, period('2026-09-07', '2026-09-13'))]);
  const superseded = find(evaluate(a1).issues, RATE) as ProfileIssue;
  assert.deepEqual(superseded.hints.map((h) => [h.kind, h.value, h.sources[0]?.role]), [['superseded_value', 16.2, 'contract_base'], ['superseded_value', 16.2, 'payslip']]);
  assert.deepEqual(superseded.candidates.map((c) => c.value), [16.8, 16.5]);
  // unplaceable matching: an undated payslip equal to the in-force annex value is shown, never counted.
  const a3b = resolve('2026-09-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', rate(16.8)), payslip(2, 'u-und', 16.8, period(null, null)), payslip(3, 'u-in', 16.5, period('2026-09-07', '2026-09-13'))]);
  const unplaceable = find(evaluate(a3b).issues, RATE) as ProfileIssue;
  assert.ok(unplaceable.hints.some((h) => h.kind === 'unplaceable_matching_value' && h.value === 16.8 && h.sources[0]?.documentLabel === 'pasek-u-und.pdf'));
  // other excluded value: an undated annex's rate.
  const undated = resolve('2026-06-01', [...rateConflictDocuments(), annex(2, 'u-und', null, rate(17))]);
  const excludedValue = find(evaluate(undated).issues, RATE) as ProfileIssue;
  assert.deepEqual(excludedValue.hints.map((h) => [h.kind, h.value]), [['excluded_value', 17]]);
  assert.equal(excludedValue.excluded[0]?.reason, 'annex_effective_date_missing');
  // an ambiguous fact has no value: it stays in `excluded`, and gives no fake hint.
  const a4 = resolve('2026-09-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', { hourly_rate: ambiguous('Uurloon € 1?,80', 1, 'Uurloon') })]);
  const unclear = find(evaluate(a4).issues, RATE) as ProfileIssue;
  assert.deepEqual([unclear.reason.code, unclear.hints, unclear.excluded.map((x) => x.reason)], ['later_document_unclear', [], ['ambiguous_on_document']]);
  // observed premium: a hint on both tier fields, never a candidate.
  const ot = resolve('2026-06-01', richDocuments());
  const { issues } = evaluate(ot, ['core_pay', 'overtime']);
  for (const tier of [TIER1, TIER2]) {
    const issue = find(issues, tier) as ProfileIssue;
    assert.deepEqual([issue.hints.map((h) => [h.kind, h.value]), issue.candidates], [[['observed_premium', 50]], []]);
  }
  assert.deepEqual(find(issues, OT_THRESHOLD)?.hints, [], 'an observed premium is a hint only on the two tier fields');
  // Never selectable: no hint value is offered as a candidate, and `select_candidate` needs a candidate.
  // (An unplaceable-matching hint equals the in-force contract value by definition - so the guarantee is
  // that hints add no candidate and no source to one: the candidates are exactly the field's own.)
  const profiles = new Map<string, PayrollProfile>([['superseded', a1], ['unplaceable', a3b], ['excluded', undated], ['unclear', a4]]);
  const sourceKey = (s: ProfileIssue['candidates'][number]['sources'][number]) => JSON.stringify([s.role, s.documentIndex, s.page, s.rawValue]);
  for (const [name, issue] of [['superseded', superseded], ['unplaceable', unplaceable], ['excluded', excludedValue], ['unclear', unclear]] as const) {
    const field = (profiles.get(name) as PayrollProfile).employment.hourlyRate;
    assert.deepEqual(issue.candidates.flatMap((c) => c.sources).map(sourceKey).sort(), field.candidates.map((c) => sourceKey(c.source)).sort(), `${name}: candidates are exactly the field's own`);
    const candidateSources = new Set(issue.candidates.flatMap((c) => c.sources).map(sourceKey));
    for (const h of issue.hints) for (const s of h.sources) assert.ok(!candidateSources.has(sourceKey(s)), `${name}: a hint's source is never a candidate source`);
    assert.equal(issue.actions.includes('select_candidate'), issue.candidates.length > 0);
  }
  for (const tier of [TIER1, TIER2]) {
    const issue = find(issues, tier) as ProfileIssue;
    assert.deepEqual([issue.candidates, issue.actions.includes('select_candidate')], [[], false]);
    assert.ok(!issue.candidates.some((c) => c.candidateId === candidateIdOf(tier, 50)));
  }
  // The hint-only values (16.2 superseded, 17 excluded) are not selectable in their issues.
  assert.ok(!superseded.candidates.some((c) => c.value === 16.2) && !excludedValue.candidates.some((c) => c.value === 17));
});

test('P3 S4 §23.8: hints are deduplicated by kind, value and source identity - presentation does not make a second hint', () => {
  const a1 = resolve('2026-09-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', rate(16.8)), payslip(3, 'u-in', 16.5, period('2026-09-07', '2026-09-13'))]);
  const f = a1.employment.hourlyRate;
  const [x] = f.excluded;
  assert.equal(x?.reason, 'superseded_by_later_document');
  const dup = { ...x!, source: { ...x!.source, page: 7, rawValue: 'Uurloon (kopie)', printedLabel: 'Kopie' } };
  const doubled: PayrollProfile = { ...a1, employment: { ...a1.employment, hourlyRate: { ...f, excluded: [x!, dup, x!] } } };
  assert.equal((find(evaluate(doubled).issues, RATE) as ProfileIssue).hints.length, 1);
  assert.equal((find(evaluate(doubled).issues, RATE) as ProfileIssue).excluded.length, 3, 'the evidence itself is passed through untouched');
});

test('P3 S4 §23.10/23.11/23.12: actions - optional issues may be left unresolved, blocking ones may not, an unknown without candidates cannot select', () => {
  const profile = resolve('2026-06-01', [...rateConflictDocuments().slice(0, 1), payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'), { period_type: absent, net_lines: [housing(95)] }), payslip(2, 'u-b', 16.2, period('2026-03-09', '2026-03-15'), { period_type: absent, net_lines: [housing(96)] })]);
  const { issues } = evaluate(profile, ['core_pay', 'tax_settings']);
  assert.deepEqual([find(issues, RATE)?.severity, find(issues, RATE)?.actions], ['blocking', ['select_candidate', 'enter_value']]);
  assert.deepEqual([find(issues, PERIOD_TYPE)?.severity, find(issues, PERIOD_TYPE)?.state, find(issues, PERIOD_TYPE)?.actions], ['blocking', 'unknown', ['enter_value']]);
  assert.deepEqual([find(issues, HOUSING)?.severity, find(issues, HOUSING)?.actions], ['optional', ['select_candidate', 'enter_value', 'leave_unresolved']]);
  assert.deepEqual([find(issues, 'employment.caoName')?.severity, find(issues, 'employment.caoName')?.actions], ['informational', ['enter_value', 'leave_unresolved']]);
  assert.deepEqual([find(issues, LHK)?.actions], [['enter_value']], 'a blocking unknown: no select, no leave');
  for (const issue of issues) {
    assert.equal(issue.actions.includes('leave_unresolved'), issue.severity !== 'blocking', issue.fieldPath);
    assert.equal(issue.actions.includes('select_candidate'), issue.candidates.length > 0, issue.fieldPath);
    assert.ok(issue.actions.includes('enter_value'), issue.fieldPath);
    assert.ok(issue.state === 'unknown' ? issue.candidates.length === 0 : true, issue.fieldPath);
  }
});

test('P3 S4 §23.13: input metadata is exactly what S3 validates - every bound and enum value, per unit', () => {
  assert.deepEqual(Object.keys(UNIT_INPUTS).sort(), [...PROFILE_UNITS].sort(), 'every unit has an input, and no extra');
  for (const unit of PROFILE_UNITS) {
    const input = inputFor(unit);
    const valid = (v: number | string | boolean) => UNIT_RULES[unit](v);
    if (input.kind === 'number') {
      const { min, max, step } = input as Required<Pick<typeof input, 'min' | 'step'>> & { max?: number };
      assert.ok(min !== undefined && step !== undefined && step > 0, unit);
      assert.ok(valid(min), `${unit}: min ${min} is accepted`);
      assert.ok(!valid(Math.round((min - step) * 100) / 100), `${unit}: below min is rejected`);
      assert.ok(valid(Math.round((min + step) * 100) / 100) || max === min, `${unit}: min + step is accepted`);
      if (max !== undefined) {
        assert.ok(valid(max), `${unit}: max ${max} is accepted`);
        assert.ok(!valid(Math.round((max + step) * 100) / 100), `${unit}: above max is rejected`);
      } else assert.ok(valid(1_000_000_000), `${unit}: no upper bound`);
    } else if (input.kind === 'enum') {
      assert.deepEqual(input.enumValues, ['week', '4-weekly', 'month']);
      for (const v of input.enumValues ?? []) assert.ok(valid(v), `${unit}: ${v}`);
      assert.ok(!valid('daily') && !valid(''), `${unit}: anything else is rejected`);
    } else if (input.kind === 'boolean') assert.ok(valid(true) && valid(false) && !valid('true'), unit);
    else if (input.kind === 'date') assert.ok(valid('2026-02-28') && !valid('2026-02-30') && !valid('28-02-2026'), unit);
    else {
      assert.deepEqual([input.min, input.max], [1, 200]);
      assert.ok(valid('x') && valid('x'.repeat(200)) && !valid('') && !valid('x'.repeat(201)), unit);
    }
  }
  assert.deepEqual([inputFor('eur_per_hour'), inputFor('weeks'), inputFor('percent')], [{ kind: 'number', min: 0.01, max: 200, step: 0.01 }, { kind: 'number', min: 1, max: 52, step: 1 }, { kind: 'number', min: 0, max: 100, step: 0.01 }]);
  assert.throws(() => inputFor('bogus' as ProfileUnit), /no input metadata/, 'an unmapped unit fails loudly');
  const copy = inputFor('period_type');
  copy.enumValues?.push('x');
  assert.deepEqual(inputFor('period_type').enumValues, ['week', '4-weekly', 'month'], 'callers cannot mutate the shared table');
  // Every issue's input is the one for its unit.
  for (const issue of evaluate(resolve('2026-06-01', richDocuments())).issues) assert.deepEqual(issue.input, inputFor(issue.unit), issue.fieldPath);
});

test('P3 S4 §23.14/23.15: requested groups are deduplicated, normalised to canonical order, and their order never changes the output', () => {
  assert.deepEqual(normalizeActiveGroups(['tax_settings', 'overtime', 'core_pay', 'overtime', 'tax_settings']), ['core_pay', 'overtime', 'tax_settings']);
  assert.deepEqual(normalizeActiveGroups([]), []);
  assert.throws(() => normalizeActiveGroups(['core_pay', 'payroll']), /unknown requirement group/);
  const profile = resolve('2026-06-01', richDocuments());
  const reference = evaluate(profile, ['core_pay', 'overtime', 'net_items', 'tax_settings']);
  for (const groups of [['tax_settings', 'net_items', 'overtime', 'core_pay'], ['overtime', 'core_pay', 'tax_settings', 'net_items', 'core_pay', 'overtime'], ['net_items', 'tax_settings', 'core_pay', 'overtime']] as RequirementGroupId[][]) {
    assert.equal(JSON.stringify(evaluate(profile, groups)), JSON.stringify(reference), JSON.stringify(groups));
  }
  assert.deepEqual(reference.readiness.activeGroups, ['core_pay', 'overtime', 'net_items', 'tax_settings']);
  assert.deepEqual([...REQUIREMENT_GROUP_IDS], ['core_pay', 'overtime', 'saturday', 'sunday', 'public_holiday', 'surcharges', 'employee_deductions', 'net_items', 'tax_settings']);
});

test('P3 S4 §23.17/23.18: an issue carries the S3 documentary fingerprint - and a user overlay (or a stale/rejected decision) never changes it', () => {
  const documentary = resolve('2026-06-01', richDocuments());
  const groups: RequirementGroupId[] = ['core_pay', 'overtime', 'net_items', 'employee_deductions'];
  const plain = evaluate(documentary, groups);
  assert.ok(plain.issues.length > 5);
  for (const issue of plain.issues) assert.equal(issue.evidenceFingerprint, profileFieldFingerprint(documentary, issue.fieldPath), issue.fieldPath);
  // Overlay: an applied decision on another field, a stale one and a rejected one on the issue fields.
  const decisions: UserProfileDecision[] = [
    confirm(documentary, PENSION, 7.5, 'd-applied'),
    { ...correct(documentary, HOUSING, 90, 'eur_per_period', 'd-stale'), evidenceFingerprint: '0000000000000000' },
    correct(documentary, TIER1, 999, 'premium_percent', 'd-rejected'),
  ];
  const out = applyUserDecisions(documentary, decisions);
  assert.deepEqual(out.decisionResults.map((r) => r.status), ['applied', 'stale', 'rejected']);
  const overlaid = evaluateReadiness(out.profile, { groups, decisions, decisionResults: out.decisionResults });
  for (const issue of overlaid.issues) {
    assert.equal(issue.evidenceFingerprint, profileFieldFingerprint(documentary, issue.fieldPath), `${issue.fieldPath}: still the documentary fingerprint`);
    assert.equal(issue.evidenceFingerprint, find(plain.issues, issue.fieldPath)?.evidenceFingerprint);
  }
  assert.equal(find(overlaid.issues, PENSION), undefined);
});

test('P3 S4 §23.19/23.20/23.21: a field in several groups is one issue; counts are unique fields; informational issues are not optional', () => {
  const profile = resolve('2026-06-01', rateConflictDocuments());
  // A synthetic table (the real one lists each field once): hourlyRate is required in two groups and optional in a third.
  const table: RequirementGroupTable = {
    ...REQUIREMENT_GROUPS,
    overtime: { required: ['employment.hourlyRate'], optional: [] },
    saturday: { required: [], optional: ['employment.hourlyRate', 'payroll.saturdayPremium'] },
  };
  const issues = buildProfileIssues(profile, { groups: ['core_pay', 'overtime', 'saturday'], table });
  assert.equal(issues.filter((i) => i.fieldPath === RATE).length, 1, 'one field, one issue');
  assert.deepEqual([find(issues, RATE)?.severity, find(issues, RATE)?.groups], ['blocking', ['core_pay', 'overtime', 'saturday']], 'every referencing group, canonical order, no duplicates');
  const readiness = calculationReadiness(['core_pay', 'overtime', 'saturday'], issues);
  assert.equal(readiness.blockingCount, issues.filter((i) => i.severity === 'blocking').length);
  assert.deepEqual(paths(issues, 'blocking').filter((p) => p === RATE), [RATE]);
  // Only an inactive membership: the group list still names it.
  const inactive = buildProfileIssues(profile, { groups: ['core_pay'], table });
  assert.deepEqual(find(inactive, RATE)?.groups, ['core_pay', 'overtime', 'saturday']);
  // Informational issues are listed but never counted as optional.
  const real = evaluate(resolve('2026-06-01', richDocuments()));
  const informational = real.issues.filter((i) => i.severity === 'informational');
  assert.ok(informational.length > 10);
  assert.equal(real.readiness.optionalCount, real.issues.filter((i) => i.severity === 'optional').length);
  assert.equal(real.readiness.optionalCount + real.readiness.blockingCount + informational.length, real.issues.length);
  assert.deepEqual(real.issues.map((i) => i.fieldPath).length, new Set(real.issues.map((i) => i.fieldPath)).size);
  assert.deepEqual(calculationReadiness(['core_pay', 'core_pay', 'overtime'], []), { activeGroups: ['core_pay', 'overtime'], ready: true, blockingCount: 0, optionalCount: 0 });
});

test('P3 S4 §19: issue order is blocking, optional, informational; by first relevant group, then profile order, then path - never request order', () => {
  const profile = resolve('2026-06-01', richDocuments());
  const { issues } = evaluate(profile, ['core_pay', 'overtime', 'net_items']);
  const severities = issues.map((i) => i.severity);
  assert.deepEqual(severities, [...severities].sort((a, b) => ['blocking', 'optional', 'informational'].indexOf(a) - ['blocking', 'optional', 'informational'].indexOf(b)));
  assert.deepEqual(paths(issues, 'blocking'), [OT_THRESHOLD, TIER1, TIER2], 'overtime group; employment before payroll');
  assert.deepEqual(paths(issues, 'optional'), [PENSION, 'payroll.etExchangeAmount', HOUSING], 'pension (employee_deductions, inactive) before the net_items fields; payroll before recurring items');
  // The informational block follows the profile's own order.
  const info = paths(issues, 'informational');
  const order = enumerateProfileFields(profile).map((e) => e.path);
  assert.deepEqual(info, order.filter((p) => info.includes(p)));
  // Reversed documents (new request indices): the same field order.
  const reversed = resolve('2026-06-01', [...richDocuments()].reverse().map((d, index) => ({ ...d, index })));
  assert.deepEqual(paths(evaluate(reversed, ['core_pay', 'overtime', 'net_items']).issues), paths(issues));
});

test('P3 S4 §19 (oracle): over several profiles and group sets the WHOLE issue sequence equals an independent reference ordering', () => {
  const rank = { blocking: 0, optional: 1, informational: 2 };
  const SECTION = (p: string) => (p.startsWith('employment.') ? 0 : p.startsWith('payroll.') ? 1 : 2);
  const POSITION = (profile: PayrollProfile, p: string) => enumerateProfileFields(profile).findIndex((e) => e.path === p);
  const COLLECTIONS = ['surcharges', 'otherPreTaxDeductions', 'otherPostTaxDeductions', 'netAdditions', 'netDeductions'];
  const profiles = [resolve('2026-06-01', richDocuments()), resolve('2026-06-01', rateConflictDocuments()), resolve('2026-06-01', [payslip(0, 'u-a', 16.2, period(null, null), { period_type: absent })])];
  const groupSets: RequirementGroupId[][] = [[], ['core_pay'], ['overtime', 'core_pay', 'net_items'], [...REQUIREMENT_GROUP_IDS]];
  let compared = 0;
  for (const profile of profiles) {
    for (const groups of groupSets) {
      const active = new Set(normalizeActiveGroups(groups));
      const issues = buildProfileIssues(profile, { groups });
      const groupRank = (i: ProfileIssue) => { const inActive = i.groups.find((g) => active.has(g)) ?? i.groups[0]; return inActive ? REQUIREMENT_GROUP_IDS.indexOf(inActive) : REQUIREMENT_GROUP_IDS.length; };
      const subPosition = (i: ProfileIssue) => (SECTION(i.fieldPath) === 2 ? COLLECTIONS.indexOf(i.fieldPath.split('.')[1] as string) : POSITION(profile, i.fieldPath));
      const expected = [...issues].sort((a, b) =>
        rank[a.severity] - rank[b.severity]
        || (a.severity === 'informational' ? 0 : groupRank(a) - groupRank(b))
        || SECTION(a.fieldPath) - SECTION(b.fieldPath) || subPosition(a) - subPosition(b)
        || (a.fieldPath < b.fieldPath ? -1 : a.fieldPath > b.fieldPath ? 1 : 0));
      assert.deepEqual(issues.map((i) => i.fieldPath), expected.map((i) => i.fieldPath), `groups ${JSON.stringify(groups)}`);
      compared += issues.length;
    }
  }
  assert.ok(compared > 100);
});

test('P3 S4 §19: two recurring issues of one collection are ordered by path, whatever order the documents listed them in', () => {
  const lines = (order: 'hu-first' | 'un-first') => {
    const hu = (amount: number) => ({ description: 'Huisvesting', category: 'housing', amount, raw: `Huisvesting ${fmt(amount)}`, page: 1, unclear_fields: [] });
    const un = (amount: number) => ({ description: 'Vakbond', category: 'union', amount, raw: `Vakbond ${fmt(amount)}`, page: 1, unclear_fields: [] });
    return (a: number, b: number) => (order === 'hu-first' ? [hu(a), un(a)] : [un(b), hu(b)]);
  };
  const run = (order: 'hu-first' | 'un-first') => resolve('2026-06-01', [
    coreBase(16.2),
    payslip(1, 'u-a', 16.2, period('2026-03-02', '2026-03-08'), { net_lines: lines(order)(95, 95) }),
    payslip(2, 'u-b', 16.2, period('2026-03-09', '2026-03-15'), { net_lines: lines(order)(96, 96) }),
  ]);
  const a = paths(evaluate(run('hu-first'), ['net_items']).issues, 'optional').filter((p) => p.startsWith('recurringItems.'));
  const b = paths(evaluate(run('un-first'), ['net_items']).issues, 'optional').filter((p) => p.startsWith('recurringItems.'));
  assert.deepEqual(a, ['recurringItems.netDeductions.net_deduction:housing:huisvesting', 'recurringItems.netDeductions.net_deduction:union:vakbond']);
  assert.deepEqual(b, a, 'the profile lists the recurring fields in document order; the issues do not');
  assert.notDeepEqual(run('un-first').recurringItems.netDeductions.map((f) => f.key), run('hu-first').recurringItems.netDeductions.map((f) => f.key), 'the profile\'s own order really differs');
});

test('P3 S4 §23.22/23.23: identical input gives byte-identical issues and readiness; the readiness builder does not mutate the profile', () => {
  const run = () => evaluate(resolve('2026-06-01', richDocuments()), ['core_pay', 'overtime', 'net_items', 'employee_deductions']);
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
  const frozen = deepFreeze(resolve('2026-06-01', richDocuments()));
  const snapshot = JSON.stringify(frozen);
  const first = evaluate(frozen, ['core_pay', 'overtime', 'net_items']);
  assert.equal(JSON.stringify(frozen), snapshot, 'the profile is untouched');
  assert.ok(first.issues.length > 0, 'it ran against a deeply frozen profile (any write would have thrown)');
  // Returned issues are new objects: changing one cannot change the profile.
  const issue = find(first.issues, PENSION) as ProfileIssue;
  issue.candidates.length = 0;
  assert.equal(frozen.payroll.pensionEmployeePercent.candidates.length, 2);
});

test('P3 S4: only conflict and unknown fields are issues - resolved, superseded and excluded-only evidence never is; impact is always null', () => {
  const profile = resolve('2026-09-15', [base(0, 'u-base', rate(16.2)), annex(1, 'u-annex', '2026-09-01', rate(16.8)), payslip(2, 'u-old', 16.2, period('2026-08-24', '2026-08-30'))]);
  assert.equal(profile.employment.hourlyRate.state, 'document_exact');
  assert.equal(profile.employment.hourlyRate.excluded.length, 2, 'superseded evidence exists');
  const { issues } = evaluate(profile, [...REQUIREMENT_GROUP_IDS]);
  assert.equal(find(issues, RATE), undefined, 'superseded evidence alone is not an issue');
  for (const entry of enumerateProfileFields(profile)) {
    const isIssue = find(issues, entry.path) !== undefined;
    assert.equal(isIssue, entry.field.state === 'conflict' || entry.field.state === 'unknown', entry.path);
  }
  assert.ok(issues.every((i) => i.impact === null && (i.state === 'conflict' || i.state === 'unknown') && i.reason !== null));
  // Every group names only real, targetable fields (a typo would make a requirement silently never apply).
  const allPaths = new Set<string>(enumerateProfileFields(profile).map((e) => e.path));
  for (const group of REQUIREMENT_GROUP_IDS) {
    for (const member of [...REQUIREMENT_GROUPS[group].required, ...REQUIREMENT_GROUPS[group].optional]) if (typeof member === 'string') assert.ok(allPaths.has(member), `${group}: ${member}`);
  }
  assert.deepEqual(REQUIREMENT_GROUPS.core_pay.required, ['employment.hourlyRate', 'payroll.periodType']);
  assert.deepEqual(REQUIREMENT_GROUPS.tax_settings.required, ['payroll.loonheffingskorting']);
  assert.ok(REQUIREMENT_GROUP_IDS.every((g) => ['surcharges', 'employee_deductions', 'net_items'].includes(g) ? REQUIREMENT_GROUPS[g].required.length === 0 : REQUIREMENT_GROUPS[g].required.length >= 1));
});

test('P3 S4 §24 (P1.1 overtime safety): observed premiums are hints only - the user can assert a tier only by an S3 correction', () => {
  const documentary = resolve('2026-06-01', richDocuments());
  assert.equal(documentary.observedOvertimePremiums.fields[0]?.value, 50);
  const issue = find(evaluate(documentary, ['core_pay', 'overtime']).issues, TIER1) as ProfileIssue;
  assert.deepEqual([issue.severity, issue.state, issue.candidates, issue.actions], ['blocking', 'unknown', [], ['enter_value']]);
  assert.deepEqual(issue.hints.map((h) => [h.kind, h.value]), [['observed_premium', 50]]);
  assert.equal(documentary.payroll.overtimeTier1Premium.candidates.length, 0, 'the profile itself never gained a tier candidate');
  const decision = correct(documentary, TIER1, 50, 'premium_percent');
  const out = applyUserDecisions(documentary, [decision]);
  assert.equal(out.profile.payroll.overtimeTier1Premium.state, 'user_corrected');
  const after = evaluateReadiness(out.profile, { groups: ['core_pay', 'overtime'], decisions: [decision], decisionResults: out.decisionResults });
  assert.deepEqual([find(after.issues, TIER1), sev(after.issues, TIER2)], [undefined, 'blocking'], 'tier 2 stays open: one assertion never resolves another tier');
});

test('P3 S4: a ProfileField of every issue state has a reason and the issue passes the field through unchanged', () => {
  const profile = resolve('2026-06-01', richDocuments());
  const { issues } = evaluate(profile, ['core_pay']);
  for (const issue of issues) {
    const field = enumerateProfileFields(profile).find((e) => e.path === issue.fieldPath)?.field as ProfileField;
    assert.deepEqual([issue.key, issue.meaning, issue.unit, issue.state, issue.reason, issue.excluded], [field.key, field.meaning, field.unit, field.state, field.reason, field.excluded], issue.fieldPath);
  }
});
