import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { translations } from './translations.ts';
import type { PayrollProfileView, ProfileDecisionView, ProfileIssueView, ProfileRequestDocument } from './pro-profile-prefill.ts';
import {
  visibleIssues, chooseCandidate, enterManual, skipIssue, withoutField, parseManualValue, buildPendingDecisions, mergeDecisionSet, removeDecision, planApply, canApply,
  settleDecisions, settlePending, resolveWithDecisions, resolvedByYou, suggestionFor, effectiveChoice, acceptSuggestion, newDecisionId, issueTitle, reasonText,
  excludedReasonText, hintText, formatValue, formatDate, sourceChip, inputUnitLabel, valuesMatch,
} from './pro-profile-questions.ts';

/**
 * P3.1 S5 (ZADANIE-P3.1-S5-RESOLUTION-UI.md): the decision logic behind the panel, the Apply / Undo /
 * re-resolve flow against a fake backend, the translation drift guards, and source-level wiring checks
 * (this project has no DOM runner; the rendered markup is tested in profile-questions.render.test.ts).
 * Issue payloads are REAL S4 output captured from the backend.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => readFileSync(path.join(here, ...p), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const F = JSON.parse(read('pro-profile-questions.fixtures.json')) as {
  a2: { issues: ProfileIssueView[] }; rich: { issues: ProfileIssueView[] };
  stale: Record<'confirmMatching' | 'correction' | 'confirmGone' | 'confirmNotCandidate', { issue: ProfileIssueView }>;
  resolved: { profile: PayrollProfileView; decisionResults: Array<{ status: string }>; issues: ProfileIssueView[] };
};
const q = translations.pl.proDocuments.questions;
const qEn = translations.en.proDocuments.questions;

const issueAt = (issues: ProfileIssueView[], fieldPath: string) => issues.find((i) => i.fieldPath === fieldPath) as ProfileIssueView;
const RATE = issueAt(F.a2.issues, 'employment.hourlyRate');
const PENSION = issueAt(F.rich.issues, 'payroll.pensionEmployeePercent');
const HOUSING = issueAt(F.rich.issues, 'recurringItems.netDeductions.net_deduction:housing:huisvesting');
const TIER1 = issueAt(F.rich.issues, 'payroll.overtimeTier1Premium');
const LHK = issueAt(F.rich.issues, 'payroll.loonheffingskorting');
const sequentialIds = () => { let n = 0; return () => `id-${++n}`; };
const NOW = '2026-10-06T09:00:00.000Z';

// ---------------------------------------------------------------------------------------------
// Which issues, in which order
// ---------------------------------------------------------------------------------------------

test('S5 §5/§31.1/31.2: only blocking and optional issues are questions, in exactly the backend order (nothing is re-sorted)', () => {
  const all = F.rich.issues;
  const visible = visibleIssues(all);
  assert.deepEqual(visible.map((i) => i.fieldPath), all.filter((i) => i.severity !== 'informational').map((i) => i.fieldPath));
  assert.equal(visible.length, 7);
  assert.ok(visible.every((i) => i.severity === 'blocking' || i.severity === 'optional'));
  assert.ok(all.filter((i) => i.severity === 'informational').length >= 20 && !visible.some((i) => i.severity === 'informational'));
  const reversed = [...all].reverse();
  assert.deepEqual(visibleIssues(reversed).map((i) => i.fieldPath), reversed.filter((i) => i.severity !== 'informational').map((i) => i.fieldPath), 'whatever order the backend sends is the order shown');
  assert.deepEqual(visibleIssues([]), []);
  const before = JSON.stringify(all);
  visibleIssues(all);
  assert.equal(JSON.stringify(all), before, 'the input is not mutated');
});

// ---------------------------------------------------------------------------------------------
// Pending choices
// ---------------------------------------------------------------------------------------------

test('S5 §17/§31.14: one pending choice per field - candidate and manual replace each other, Skip clears, other fields are untouched', () => {
  const none = {};
  const candidate = chooseCandidate(none, 'employment.hourlyRate', 'cand-1');
  assert.deepEqual(candidate, { 'employment.hourlyRate': { kind: 'candidate', candidateId: 'cand-1' } });
  const manual = enterManual(candidate, 'employment.hourlyRate', '17');
  assert.deepEqual(manual, { 'employment.hourlyRate': { kind: 'manual', raw: '17' } }, 'manual replaces the candidate');
  const back = chooseCandidate(manual, 'employment.hourlyRate', 'cand-2');
  assert.deepEqual(back, { 'employment.hourlyRate': { kind: 'candidate', candidateId: 'cand-2' } }, 'a candidate replaces the manual value');
  assert.deepEqual(Object.keys(back), ['employment.hourlyRate'], 'never two entries for one field');
  const two = enterManual(back, 'payroll.periodType', 'week');
  assert.deepEqual(Object.keys(two).sort(), ['employment.hourlyRate', 'payroll.periodType']);
  assert.deepEqual(skipIssue(two, 'employment.hourlyRate'), { 'employment.hourlyRate': { kind: 'skip' }, 'payroll.periodType': { kind: 'manual', raw: 'week' } });
  assert.deepEqual(withoutField(two, 'payroll.periodType'), { 'employment.hourlyRate': { kind: 'candidate', candidateId: 'cand-2' } });
  assert.deepEqual(none, {}, 'reducers do not mutate');
});

test('S5 §12/§31.8-31.12: manual input becomes an exact domain value - -95 stays -95, enum/boolean/date/text follow the issue input', () => {
  const number = { kind: 'number' as const, min: 0, step: 0.01 };
  const parse = (input: ProfileIssueView['input'], raw: string) => parseManualValue(input, raw);
  assert.deepEqual(parse(number, '-95'), { ok: true, value: -95 }, 'a negative amount is NOT normalised (the backend rejects it)');
  assert.deepEqual(parse(number, '95'), { ok: true, value: 95 });
  assert.deepEqual(parse(number, ' 16,2 '), { ok: true, value: 16.2 }, 'comma decimal, trimmed');
  assert.deepEqual(parse(number, '+5'), { ok: true, value: 5 });
  assert.deepEqual(parse(number, '12.'), { ok: true, value: 12 });
  assert.deepEqual(parse(number, '-0.5'), { ok: true, value: -0.5 });
  for (const bad of ['', '  ', 'abc', '1e3', '1,2,3', '--5', '5-', '∞', 'NaN', '0x10']) assert.deepEqual(parse(number, bad), { ok: false }, JSON.stringify(bad));
  const periodType = { kind: 'enum' as const, enumValues: ['week', '4-weekly', 'month'] };
  assert.deepEqual(parse(periodType, '4-weekly'), { ok: true, value: '4-weekly' });
  for (const bad of ['', 'daily', 'WEEK', ' week']) assert.deepEqual(parse(periodType, bad), { ok: false }, `enum ${JSON.stringify(bad)}`);
  assert.deepEqual(parse({ kind: 'enum' }, 'week'), { ok: false }, 'an enum with no backend values accepts nothing');
  assert.deepEqual([parse({ kind: 'boolean' }, 'true'), parse({ kind: 'boolean' }, 'false'), parse({ kind: 'boolean' }, ''), parse({ kind: 'boolean' }, 'yes')], [{ ok: true, value: true }, { ok: true, value: false }, { ok: false }, { ok: false }]);
  assert.deepEqual([parse({ kind: 'date' }, '2026-02-28'), parse({ kind: 'date' }, '28.02.2026'), parse({ kind: 'date' }, '')], [{ ok: true, value: '2026-02-28' }, { ok: false }, { ok: false }]);
  assert.deepEqual([parse({ kind: 'text', min: 1, max: 200 }, 'ABU-cao'), parse({ kind: 'text' }, '   '), parse({ kind: 'text' }, ' x ')], [{ ok: true, value: 'ABU-cao' }, { ok: false }, { ok: true, value: ' x ' }], 'text is sent as typed');
});

// ---------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------

test('S5 #37 §10/§12/§18: a candidate becomes confirm_candidate with its own domain value, a manual value correct_value with the issue unit - each with ITS issue fingerprint, in issue order', () => {
  const visible = visibleIssues(F.rich.issues);
  const pending = {
    [HOUSING.fieldPath]: { kind: 'manual' as const, raw: '90' },
    [PENSION.fieldPath]: { kind: 'candidate' as const, candidateId: (PENSION.candidates[1] as { candidateId: string }).candidateId },
    [TIER1.fieldPath]: { kind: 'manual' as const, raw: '50' },
    [LHK.fieldPath]: { kind: 'manual' as const, raw: 'true' },
  };
  const decisions = buildPendingDecisions(visible, pending, sequentialIds(), NOW);
  assert.deepEqual(decisions.map((d) => d.fieldPath), visible.map((i) => i.fieldPath).filter((p) => p in pending), 'the order of the visible issues, not the order choices were made');
  const by = (p: string) => decisions.find((d) => d.fieldPath === p) as ProfileDecisionView;
  assert.deepEqual(by(PENSION.fieldPath), { kind: 'confirm_candidate', decisionId: by(PENSION.fieldPath).decisionId, fieldPath: PENSION.fieldPath, value: (PENSION.candidates[1] as { value: number }).value, evidenceFingerprint: PENSION.evidenceFingerprint, decidedAt: NOW });
  assert.deepEqual(by(HOUSING.fieldPath), { kind: 'correct_value', decisionId: by(HOUSING.fieldPath).decisionId, fieldPath: HOUSING.fieldPath, value: 90, unit: 'eur_per_period', evidenceFingerprint: HOUSING.evidenceFingerprint, decidedAt: NOW });
  assert.deepEqual([by(TIER1.fieldPath).kind, (by(TIER1.fieldPath) as { value: unknown }).value, (by(TIER1.fieldPath) as { unit: string }).unit], ['correct_value', 50, 'premium_percent'], 'the tier is asserted by the user as a correction (P1.1)');
  assert.deepEqual([(by(LHK.fieldPath) as { value: unknown }).value, (by(LHK.fieldPath) as { unit: string }).unit], [true, 'boolean']);
  for (const d of decisions) assert.equal(d.evidenceFingerprint, visible.find((i) => i.fieldPath === d.fieldPath)?.evidenceFingerprint, `${d.fieldPath}: the fingerprint of its own issue`);
  assert.equal(new Set(decisions.map((d) => d.decisionId)).size, decisions.length, 'distinct ids');
  const cids = new Set(visible.flatMap((i) => i.candidates.map((c) => c.candidateId)));
  assert.ok(decisions.every((d) => !cids.has(d.decisionId) && !d.decisionId.includes(d.evidenceFingerprint)), 'a decision id is not a candidate id or evidence');
  // Choices that cannot form a decision form none.
  const nothing = buildPendingDecisions(visible, {
    [HOUSING.fieldPath]: { kind: 'manual', raw: '' }, [PENSION.fieldPath]: { kind: 'candidate', candidateId: 'no-such-candidate' }, [TIER1.fieldPath]: { kind: 'skip' }, [LHK.fieldPath]: { kind: 'manual', raw: 'maybe' }, 'payroll.unknownThing': { kind: 'manual', raw: '1' },
  });
  assert.deepEqual(nothing, []);
});

test('S5 §31.13: canApply is false for nothing / invalid / skipped / unknown-candidate choices, true for a valid one', () => {
  const visible = visibleIssues(F.a2.issues);
  assert.equal(canApply(visible, {}), false);
  assert.equal(canApply(visible, { [RATE.fieldPath]: { kind: 'manual', raw: '' } }), false);
  assert.equal(canApply(visible, { [RATE.fieldPath]: { kind: 'manual', raw: 'x' } }), false);
  assert.equal(canApply(visible, { [RATE.fieldPath]: { kind: 'skip' } }), false);
  assert.equal(canApply(visible, { [RATE.fieldPath]: { kind: 'candidate', candidateId: 'nope' } }), false);
  assert.equal(canApply(visible, { [RATE.fieldPath]: { kind: 'candidate', candidateId: (RATE.candidates[0] as { candidateId: string }).candidateId } }), true);
  assert.equal(canApply(visible, { [RATE.fieldPath]: { kind: 'manual', raw: '-95' } }), true, '-95 is a typed number: it is sent as is, the backend rejects it');
  assert.equal(canApply([], { [RATE.fieldPath]: { kind: 'manual', raw: '17' } }), false, 'no longer an open question');
});

test('S5 §20: one decision per field in the set - a new decision replaces a stale one; Undo removes only its own field', () => {
  const stale: ProfileDecisionView = { kind: 'confirm_candidate', decisionId: 'old', fieldPath: RATE.fieldPath, value: 16.2, evidenceFingerprint: 'ffffffffffffffff', decidedAt: NOW };
  const other: ProfileDecisionView = { kind: 'correct_value', decisionId: 'other', fieldPath: HOUSING.fieldPath, value: 90, unit: 'eur_per_period', evidenceFingerprint: HOUSING.evidenceFingerprint, decidedAt: NOW };
  const fresh = buildPendingDecisions(visibleIssues(F.a2.issues), { [RATE.fieldPath]: { kind: 'manual', raw: '17' } }, sequentialIds(), NOW);
  const plan = planApply(visibleIssues(F.a2.issues), { [RATE.fieldPath]: { kind: 'manual', raw: '17' } }, [stale, other], sequentialIds(), NOW);
  assert.deepEqual(plan.added, fresh);
  assert.deepEqual(plan.sent.map((d) => d.decisionId), ['other', 'id-1'], 'the stale decision for the field is replaced; the unrelated one is kept');
  assert.deepEqual(mergeDecisionSet([stale, other], []), [stale, other]);
  assert.deepEqual(removeDecision([stale, other], RATE.fieldPath), [other]);
  assert.deepEqual(removeDecision([other], RATE.fieldPath), [other], 'removing an absent field is a no-op');
  // Nothing pending: the set is resubmitted unchanged (a copy), nothing added.
  const idle = planApply(visibleIssues(F.a2.issues), {}, [stale, other]);
  assert.deepEqual([idle.added, idle.sent], [[], [stale, other]]);
  assert.notEqual(idle.sent, [stale, other]);
});

test('S5 §29: decision ids are opaque, client-generated and unique (UUID-based, <= 64 chars)', () => {
  const ids = Array.from({ length: 50 }, () => newDecisionId());
  assert.equal(new Set(ids).size, 50);
  assert.ok(ids.every((id) => id.length <= 64 && id.startsWith('d-') && /^[A-Za-z0-9-]+$/.test(id)));
});

// ---------------------------------------------------------------------------------------------
// Stale previous decisions
// ---------------------------------------------------------------------------------------------

test('S5 #37 §16/§31.15-31.17: a stale previous choice is a SUGGESTION - preselected, prefilled or manual - never submitted; Apply after it uses the CURRENT fingerprint', () => {
  const matching = F.stale.confirmMatching.issue;
  const correction = F.stale.correction.issue;
  const notCandidate = F.stale.confirmNotCandidate.issue;
  const candidateIdOf16_2 = (matching.candidates.find((c) => c.value === 16.2) as { candidateId: string }).candidateId;
  assert.deepEqual(suggestionFor(matching), { kind: 'candidate', candidateId: candidateIdOf16_2 }, 'confirm_candidate whose value is still a candidate: pre-select it');
  assert.deepEqual(suggestionFor(correction), { kind: 'manual', raw: '17.1' }, 'correct_value: prefill the manual input');
  assert.deepEqual(suggestionFor(notCandidate), { kind: 'manual', raw: '99' }, 'confirm_candidate no longer among the candidates: the manual view, prefilled');
  assert.ok(!notCandidate.candidates.some((c) => c.value === 99) && !correction.candidates.some((c) => c.value === 17.1), 'no candidate is fabricated');
  assert.equal(suggestionFor(RATE), null, 'no previous decision, no suggestion');
  // The effective selection shows the suggestion until the user acts.
  assert.deepEqual(effectiveChoice(matching, {}), { choice: { kind: 'candidate', candidateId: candidateIdOf16_2 }, suggested: true });
  assert.deepEqual(effectiveChoice(matching, { [matching.fieldPath]: { kind: 'manual', raw: '16.5' } }), { choice: { kind: 'manual', raw: '16.5' }, suggested: false });
  assert.deepEqual(effectiveChoice(matching, { [matching.fieldPath]: { kind: 'skip' } }), { choice: null, suggested: false }, 'Skip dismisses the suggestion');
  assert.deepEqual(effectiveChoice(RATE, {}), { choice: null, suggested: false });
  // NEVER auto-applied: a suggestion produces no decision, and does not enable Apply.
  for (const issue of [matching, correction, notCandidate]) {
    assert.deepEqual(buildPendingDecisions([issue], {}, sequentialIds(), NOW), [], 'nothing is submitted for a suggestion');
    assert.equal(canApply([issue], {}), false);
  }
  // The user accepts it explicitly -> a real pending choice -> a decision with the issue's CURRENT fingerprint.
  const accepted = acceptSuggestion({}, matching);
  assert.deepEqual(accepted, { [matching.fieldPath]: { kind: 'candidate', candidateId: candidateIdOf16_2 } });
  const [decision] = buildPendingDecisions([matching], accepted, sequentialIds(), NOW) as [ProfileDecisionView];
  assert.deepEqual([decision.kind, decision.value, decision.evidenceFingerprint], ['confirm_candidate', 16.2, matching.evidenceFingerprint]);
  const [fixed] = buildPendingDecisions([correction], acceptSuggestion({}, correction), sequentialIds(), NOW) as [ProfileDecisionView & { unit: string }];
  assert.deepEqual([fixed.kind, fixed.value, fixed.unit, fixed.evidenceFingerprint], ['correct_value', 17.1, 'eur_per_hour', correction.evidenceFingerprint]);
  assert.deepEqual(acceptSuggestion({}, RATE), {}, 'nothing to accept');
  // The recognition rule mirrors the backend's value equality (printed cent), only to find the candidate.
  assert.equal(valuesMatch(16.2, 16.204), true);
  assert.equal(valuesMatch(16.2, 16.21), false);
  assert.equal(valuesMatch(' ABU ', 'ABU'), true);
  assert.equal(valuesMatch(true, true) && !valuesMatch(true, 'true'), true);
});

// ---------------------------------------------------------------------------------------------
// The single re-resolve path (fake backend)
// ---------------------------------------------------------------------------------------------

const documents: ProfileRequestDocument[] = [
  { index: 0, documentId: 'u-base', label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, factBatches: [{ kind: 'contract' }] },
  { index: 1, documentId: 'u-slip', label: 'pasek.pdf', role: 'payslip', effectiveDate: null, factBatches: [{ kind: 'payslip' }] },
];
const emptyProfile = { version: 2, asOfDate: '2026-06-01', employment: {}, payroll: {}, recurringItems: {}, observedOvertimePremiums: { fields: [], excluded: [] }, contractContext: { annexDates: [] } };
type Body = { asOfDate: string; documents: unknown; decisions?: ProfileDecisionView[]; requirements?: unknown };
function backend(statusFor: (d: ProfileDecisionView, i: number) => 'applied' | 'satisfied_by_documents' | 'stale' | 'rejected' = () => 'applied') {
  const calls: Body[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push(body);
    const decisions = body.decisions ?? [];
    return new Response(JSON.stringify({
      profile: emptyProfile, extractionTable: [], issues: [], readiness: { activeGroups: ['core_pay'], ready: true, blockingCount: 0, optionalCount: 0 },
      decisionResults: decisions.map((d, i) => ({ decisionId: d.decisionId, fieldPath: d.fieldPath, status: statusFor(d, i), problem: statusFor(d, i) === 'rejected' ? 'invalid_value' : statusFor(d, i) === 'stale' ? 'evidence_changed' : null })),
    }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test('S5 #37 §18: Apply = ONE resolve request with the same documents, as-of date and ALL pending decisions (no per-card request, no requirements)', async () => {
  const visible = visibleIssues(F.rich.issues);
  const pending = {
    [HOUSING.fieldPath]: { kind: 'manual' as const, raw: '90' },
    [PENSION.fieldPath]: { kind: 'candidate' as const, candidateId: (PENSION.candidates[0] as { candidateId: string }).candidateId },
    [TIER1.fieldPath]: { kind: 'manual' as const, raw: '50' },
  };
  const { added, sent } = planApply(visible, pending, [], sequentialIds(), NOW);
  assert.equal(added.length, 3);
  const { calls, fetchImpl } = backend();
  const outcome = await resolveWithDecisions('2026-06-01', documents, sent, fetchImpl);
  assert.equal(calls.length, 1, 'ONE request for three pending decisions');
  assert.deepEqual(Object.keys(calls[0] as object).sort(), ['asOfDate', 'decisions', 'documents'], 'no requirements: the backend default (core_pay) applies');
  assert.deepEqual(calls[0]?.documents, documents);
  assert.equal(calls[0]?.asOfDate, '2026-06-01');
  assert.deepEqual(calls[0]?.decisions?.map((d) => [d.kind, d.fieldPath, d.evidenceFingerprint]), added.map((d) => [d.kind, d.fieldPath, d.evidenceFingerprint]));
  assert.deepEqual(outcome?.decisions, sent, 'every applied decision stays in the set');
  assert.deepEqual(outcome?.problems, {});
  assert.deepEqual(outcome?.resolved.decisionResults.map((r) => r.status), ['applied', 'applied', 'applied'], 'decisionResults are kept');
});

test('S5 #37 §19: Undo = one re-resolve with the remaining decisions only - and with none left no decisions key is sent', async () => {
  const a: ProfileDecisionView = { kind: 'correct_value', decisionId: 'a', fieldPath: HOUSING.fieldPath, value: 90, unit: 'eur_per_period', evidenceFingerprint: HOUSING.evidenceFingerprint, decidedAt: NOW };
  const b: ProfileDecisionView = { kind: 'confirm_candidate', decisionId: 'b', fieldPath: PENSION.fieldPath, value: 7.5, evidenceFingerprint: PENSION.evidenceFingerprint, decidedAt: NOW };
  const { calls, fetchImpl } = backend();
  const first = await resolveWithDecisions('2026-06-01', documents, removeDecision([a, b], HOUSING.fieldPath), fetchImpl);
  assert.deepEqual(calls[0]?.decisions?.map((d) => d.decisionId), ['b'], 'only the remaining decision is sent - the undone one is gone');
  assert.deepEqual(first?.decisions.map((d) => d.decisionId), ['b']);
  await resolveWithDecisions('2026-06-01', documents, removeDecision([b], PENSION.fieldPath), fetchImpl);
  assert.equal(calls.length, 2);
  assert.ok(!('decisions' in (calls[1] as object)), 'an empty set: the request is exactly the documents-only one');
  assert.equal(first?.resolved.profile, first?.resolved.profile);
});

test('S5 §20/§31.24: a document re-read or a new as-of date resubmits the CURRENT decision set - stale decisions are kept, never dropped client-side', async () => {
  const set: ProfileDecisionView[] = [
    { kind: 'confirm_candidate', decisionId: 'applied-1', fieldPath: PENSION.fieldPath, value: 7.5, evidenceFingerprint: PENSION.evidenceFingerprint, decidedAt: NOW },
    { kind: 'correct_value', decisionId: 'stale-1', fieldPath: RATE.fieldPath, value: 17.1, unit: 'eur_per_hour', evidenceFingerprint: 'ffffffffffffffff', decidedAt: NOW },
  ];
  const { calls, fetchImpl } = backend((d) => (d.decisionId === 'stale-1' ? 'stale' : 'applied'));
  const outcome = await resolveWithDecisions('2026-10-01', documents, set, fetchImpl);
  assert.deepEqual(calls[0]?.decisions, set, 'the whole set goes with the new date / documents, unmodified');
  assert.deepEqual(outcome?.decisions, set, 'a stale result keeps the decision in the set (the backend sees it again; it returns as previousDecision)');
  assert.deepEqual(outcome?.problems, {});
  assert.deepEqual(outcome?.resolved.decisionResults.map((r) => r.status), ['applied', 'stale']);
});

test('S5 §20/§36: a rejected decision leaves the set and is reported per field; pending is settled accordingly; a failed request keeps everything', async () => {
  const good: ProfileDecisionView = { kind: 'confirm_candidate', decisionId: 'good', fieldPath: PENSION.fieldPath, value: 7.5, evidenceFingerprint: PENSION.evidenceFingerprint, decidedAt: NOW };
  const bad: ProfileDecisionView = { kind: 'correct_value', decisionId: 'bad', fieldPath: HOUSING.fieldPath, value: -95, unit: 'eur_per_period', evidenceFingerprint: HOUSING.evidenceFingerprint, decidedAt: NOW };
  const { fetchImpl } = backend((d) => (d.decisionId === 'bad' ? 'rejected' : 'applied'));
  const outcome = await resolveWithDecisions('2026-06-01', documents, [good, bad], fetchImpl);
  assert.deepEqual(outcome?.decisions, [good], 'the rejected -95 correction is not kept');
  assert.deepEqual(outcome?.problems, { [HOUSING.fieldPath]: 'invalid_value' });
  const pending = { [PENSION.fieldPath]: { kind: 'candidate' as const, candidateId: 'x' }, [HOUSING.fieldPath]: { kind: 'manual' as const, raw: '-95' }, [TIER1.fieldPath]: { kind: 'skip' as const }, 'payroll.gone': { kind: 'manual' as const, raw: '1' } };
  const visibleAfter = visibleIssues(F.rich.issues).filter((i) => i.fieldPath !== PENSION.fieldPath);
  assert.deepEqual(settlePending(pending, [good, bad], outcome?.problems ?? {}, visibleAfter), {
    [HOUSING.fieldPath]: { kind: 'manual', raw: '-95' },
    [TIER1.fieldPath]: { kind: 'skip' },
  }, 'the applied choice and the choice for a vanished question are dropped; the rejected one stays so it can be fixed');
  // A sent choice is dropped from pending even when the question stays open (the backend answered "stale"
  // and the issue is still there): the choice now lives in the decision set and returns as a suggestion.
  const stillOpenAfterStale = visibleIssues(F.rich.issues);
  assert.ok(stillOpenAfterStale.some((i) => i.fieldPath === PENSION.fieldPath));
  assert.deepEqual(settlePending({ [PENSION.fieldPath]: { kind: 'candidate', candidateId: 'x' } }, [good], {}, stillOpenAfterStale), {}, 'sent and not rejected: no longer pending, though still open');
  assert.deepEqual(settlePending({ [PENSION.fieldPath]: { kind: 'candidate', candidateId: 'x' } }, [], {}, stillOpenAfterStale), { [PENSION.fieldPath]: { kind: 'candidate', candidateId: 'x' } }, 'not sent: kept');
  // Statuses other than rejected all stay.
  assert.deepEqual(settleDecisions([good, bad], ['applied', 'satisfied_by_documents'].map((status, i) => ({ decisionId: [good, bad][i]?.decisionId as string, fieldPath: [good, bad][i]?.fieldPath as string, status: status as 'applied', problem: null }))).decisions, [good, bad]);
  assert.deepEqual(settleDecisions([good, bad], []).decisions, [good, bad], 'results that cannot be matched: nothing dropped, nothing claimed');
  // Failure: null - the caller keeps its profile, issues, pending and decisions (the arrays are untouched).
  const set = [good, bad];
  const failing = (async () => new Response(JSON.stringify({ error_code: 'invalid_input' }), { status: 400 })) as unknown as typeof fetch;
  const throwing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  assert.equal(await resolveWithDecisions('2026-06-01', documents, set, failing), null);
  assert.equal(await resolveWithDecisions('2026-06-01', documents, set, throwing), null);
  assert.deepEqual(set, [good, bad]);
});

test('S5 §31.25: nothing is simulated locally - the profile, issues and readiness come back exactly as the backend sent them', async () => {
  const marker = { ...emptyProfile, asOfDate: '2099-01-01' };
  const issue = { ...RATE, evidenceFingerprint: 'abcdefabcdefabcd' };
  const fetchImpl = (async () => new Response(JSON.stringify({ profile: marker, extractionTable: [], decisionResults: [], issues: [issue], readiness: { activeGroups: ['core_pay'], ready: false, blockingCount: 1, optionalCount: 0 } }), { status: 200 })) as unknown as typeof fetch;
  const outcome = await resolveWithDecisions('2026-06-01', documents, [], fetchImpl);
  assert.deepEqual(outcome?.resolved.profile, marker);
  assert.deepEqual(outcome?.resolved.issues, [issue]);
  assert.deepEqual(outcome?.resolved.readiness, { activeGroups: ['core_pay'], ready: false, blockingCount: 1, optionalCount: 0 });
});

// ---------------------------------------------------------------------------------------------
// Resolved by you
// ---------------------------------------------------------------------------------------------

test('S5 §19/§31.21/31.22: "Resolved by you" is exactly the user_confirmed / user_corrected fields; a field the documents satisfy is not listed', () => {
  const profile = F.resolved.profile;
  assert.deepEqual(F.resolved.decisionResults.map((r) => r.status), ['applied', 'applied', 'satisfied_by_documents'], 'the real backend: the third decision was satisfied by the documents');
  assert.equal(profile.employment.hourlyRate?.state, 'corroborated');
  const entries = resolvedByYou(profile);
  assert.deepEqual(entries.map((e) => [e.fieldPath, e.kind, e.value]), [
    ['payroll.pensionEmployeePercent', 'confirm_candidate', 7.5],
    ['recurringItems.netDeductions.net_deduction:housing:huisvesting', 'correct_value', 90],
  ]);
  assert.ok(!entries.some((e) => e.fieldPath === 'employment.hourlyRate'), 'satisfied_by_documents is documentary, not "resolved by you"');
  assert.deepEqual(resolvedByYou(null), []);
  const mutated = JSON.parse(JSON.stringify(profile)) as PayrollProfileView;
  (mutated.employment.hourlyRate as { state: string }).state = 'document_exact';
  assert.equal(resolvedByYou(mutated).length, 2);
  for (const state of ['document_exact', 'corroborated', 'conflict', 'unknown'] as const) {
    const copy = JSON.parse(JSON.stringify(profile)) as PayrollProfileView;
    (copy.payroll.pensionEmployeePercent as { state: string }).state = state;
    assert.ok(!resolvedByYou(copy).some((e) => e.fieldPath === 'payroll.pensionEmployeePercent'), state);
  }
});

// ---------------------------------------------------------------------------------------------
// Wording, values, sources
// ---------------------------------------------------------------------------------------------

test('S5 §8/§9/§25: titles, reasons and values are wording - fallbacks never leak a code; values are formatted for display only', () => {
  assert.equal(issueTitle(RATE, q), 'Stawka godzinowa brutto');
  assert.equal(issueTitle(RATE, qEn), 'Gross hourly rate');
  assert.equal(issueTitle(HOUSING, q), 'Stałe potrącenie netto: huisvesting', 'a recurring line adds the description printed on the documents');
  assert.equal(issueTitle({ fieldPath: 'recurringItems.surcharges.surcharge:irregular:toeslag: 25%', key: 'surcharge:irregular:toeslag: 25%', meaning: 'surcharge_on_hours_already_counted' }, q), 'Dodatek procentowy do już policzonych godzin: toeslag: 25%');
  assert.equal(issueTitle({ fieldPath: 'employment.mystery', key: 'mystery', meaning: 'some_future_meaning' }, q), 'Inny parametr płacowy', 'an unmapped meaning is a generic translated label');
  assert.equal(reasonText({ code: 'a_future_reason' }, q), 'Ten parametr wymaga Twojej uwagi.');
  assert.equal(excludedReasonText('a_future_exclusion', q), 'dane pominięte');
  assert.equal(hintText('observed_premium', q), q.hintObservedPremium);
  assert.deepEqual(['unplaceable_matching_value', 'superseded_value', 'excluded_value'].map((k) => hintText(k as 'excluded_value', q)), [q.hintUnplaceableMatching, q.hintSuperseded, q.hintExcluded]);
  const f = (unit: string, value: number | string | boolean, lang: 'pl' | 'en' = 'pl') => formatValue(unit, value, lang === 'pl' ? q : qEn, lang);
  assert.deepEqual(f('eur_per_hour', 16.8), { value: '16,80 €', unit: '/ godz.' }, 'pl-PL currency uses a non-breaking space');
  assert.deepEqual(f('eur_per_hour', 16.8, 'en'), { value: '€16.80', unit: '/ hour' });
  assert.deepEqual(f('percent_of_printed_base', 7.5), { value: '7,5%', unit: '' });
  assert.deepEqual(f('premium_percent', 50), { value: '+50%', unit: '' });
  assert.deepEqual(f('hours_per_week', 40), { value: '40', unit: 'godz. / tydzień' });
  assert.deepEqual(f('weeks', 4, 'en'), { value: '4', unit: 'weeks' });
  assert.deepEqual(f('boolean', true), { value: 'Tak', unit: '' });
  assert.deepEqual(f('boolean', false, 'en'), { value: 'No', unit: '' });
  assert.deepEqual([f('period_type', '4-weekly').value, f('period_type', 'month', 'en').value], ['4 tygodnie', 'month']);
  assert.deepEqual([f('date', '2026-09-01').value, f('date', '2026-09-01', 'en').value, formatDate('x', 'pl')], ['01.09.2026', '2026-09-01', 'x']);
  assert.equal(f('eur_per_period', -95).value.includes('95') && f('eur_per_period', -95).value.includes('-'), true, 'a negative amount is displayed as it is');
  assert.deepEqual([inputUnitLabel('eur_per_hour', q), inputUnitLabel('percent', q), inputUnitLabel('weeks', qEn), inputUnitLabel('text', q)], ['€ / godz.', '%', 'weeks', '']);
});

test('S5 #36 §11/§31.18/31.19: source chips tell contract, annex and payslip apart; an undated payslip is flagged; details carry page, label and raw text', () => {
  const rate = RATE;
  const annexSource = (rate.candidates[0] as { sources: ProfileIssueView['candidates'][number]['sources'] }).sources[0] as ProfileIssueView['candidates'][number]['sources'][number];
  const slipSource = (rate.candidates[1] as { sources: ProfileIssueView['candidates'][number]['sources'] }).sources[0] as ProfileIssueView['candidates'][number]['sources'][number];
  const annex = sourceChip(annexSource, q, 'pl');
  assert.deepEqual([annex.kind, annex.text, annex.document, annex.periodUnknown], ['annex', 'Aneks od 01.09.2026', 'aneks.pdf', false]);
  assert.deepEqual(annex.details.map((d) => d.label), ['Dokument', 'str. 1', 'Etykieta na dokumencie', 'Fragment dokumentu']);
  const slip = sourceChip(slipSource, q, 'pl');
  assert.deepEqual([slip.kind, slip.text, slip.periodUnknown], ['payslip', 'Pasek: 07.09.2026 – 13.09.2026', false]);
  const contract = sourceChip({ ...annexSource, role: 'contract_base', effectiveDate: null }, qEn, 'en');
  assert.deepEqual([contract.kind, contract.text], ['contract', 'Contract']);
  assert.equal(sourceChip({ ...annexSource, effectiveDate: null }, qEn, 'en').text, 'Annex', 'an annex with no date');
  const undated = sourceChip({ ...slipSource, payPeriod: { label: 'week 36', startDate: null, endDate: null, periodType: 'week' } }, q, 'pl');
  assert.deepEqual([undated.kind, undated.text, undated.periodUnknown], ['payslip', 'Pasek', true], 'a label alone does not place a payslip - the backend cannot, so the chip says the period is unknown');
  assert.equal(sourceChip({ ...slipSource, payPeriod: { label: null, startDate: '2026-09-07', endDate: '2026-09-07', periodType: null } }, qEn, 'en').text, 'Payslip: 2026-09-07', 'one printed date is one date');
  assert.equal(sourceChip({ ...slipSource, payPeriod: null }, q, 'pl').periodUnknown, true);
  const user = sourceChip({ sourceType: 'user', role: 'user', documentIndex: null, documentLabel: null, effectiveDate: null, payPeriod: null, printedLabel: null, page: null, line: null, decisionId: 'd-1' }, q, 'pl');
  assert.deepEqual([user.kind, user.text, user.document, user.details], ['user', 'Twoja decyzja', null, []]);
});

// ---------------------------------------------------------------------------------------------
// Translations (PL/EN only - O1) and drift guards against the backend
// ---------------------------------------------------------------------------------------------

function leaves(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (value !== null && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  return [[prefix, value]];
}
const backendProfileSource = stripComments(readFileSync(path.join(here, '..', '..', 'backend-node', 'src', 'payroll-engine', 'payroll-profile.ts'), 'utf-8'));
const quoted = (block: string) => [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1] as string);
const typeBlock = (name: string) => (new RegExp(`export type ${name} =([\\s\\S]*?);\\n`).exec(backendProfileSource)?.[1] ?? '');

test('S5 #19 §22/§27: PL/EN parity for every S5 key - only pl and en exist (no NL), keys match, and no Polish string is an English copy', () => {
  assert.deepEqual(Object.keys(translations).sort(), ['en', 'pl'], 'no NL in P3');
  const pl = leaves(translations.pl.proDocuments.questions);
  const en = leaves(translations.en.proDocuments.questions);
  assert.deepEqual(pl.map(([k]) => k), en.map(([k]) => k), 'identical key sets');
  assert.equal(pl.length, 127, 'the S5 copy: 127 keys per language');
  const sampleArgs: Record<string, unknown[]> = { chooseLegend: ['X'], manualInputLabel: ['X'], readinessCounts: [2, 3], undoAria: ['X'], excludedTitle: [3], sourceAnnexFrom: ['01.09.2026'], sourcePayslipPeriod: ['P'], detailPage: [4] };
  const identical: string[] = [];
  for (const [i, [key, plValue]] of pl.entries()) {
    const enValue = en[i]?.[1];
    assert.equal(typeof plValue, typeof enValue, key);
    const call = (v: unknown) => (typeof v === 'function' ? (v as (...a: unknown[]) => string)(...(sampleArgs[key] ?? [])) : v);
    assert.ok(typeof call(plValue) === 'string' && String(call(plValue)).length > 0 && String(call(enValue)).length > 0, `${key} is a non-empty string in both`);
    if (call(plValue) === call(enValue)) identical.push(key);
  }
  assert.deepEqual(identical, [], 'a Polish string identical to its English one is an untranslated fallback');
});

test('S5 §8/§9: every field meaning, reason and excluded-reason the backend can emit has a PL and EN wording (drift guard against payroll-profile.ts)', () => {
  const meanings = new Set<string>();
  for (const m of backendProfileSource.matchAll(/(?:\bF|percentField)\('[A-Za-z0-9]+', '([a-z0-9_]+)'/g)) meanings.add(m[1] as string);
  for (const m of backendProfileSource.matchAll(/grouped(?:Percent|Amount)Fields\('[a-z_]+', '([a-z0-9_]+)'/g)) meanings.add(m[1] as string);
  assert.ok(meanings.size >= 36, `found ${meanings.size} meanings`);
  for (const meaning of meanings) for (const copy of [q, qEn]) assert.ok(typeof (copy.fields as Record<string, unknown>)[meaning] === 'string', `no label for field meaning "${meaning}"`);
  const reasonCodes = new Set([...quoted(typeBlock('UnknownReasonCode')), ...[...typeBlock('ProfileReason').matchAll(/code: '([a-z_]+)'/g)].map((m) => m[1] as string)]);
  assert.ok(reasonCodes.has('sources_disagree') && reasonCodes.has('later_document_unclear') && reasonCodes.has('no_evidence_source') && reasonCodes.size >= 16, `found ${reasonCodes.size} reasons`);
  for (const code of reasonCodes) for (const copy of [q, qEn]) assert.ok(typeof (copy.reasons as Record<string, unknown>)[code] === 'string', `no wording for reason "${code}"`);
  const excluded = quoted(typeBlock('ExcludedReasonCode'));
  assert.ok(excluded.length >= 14 && excluded.includes('payslip_period_unplaceable'));
  for (const code of excluded) for (const copy of [q, qEn]) assert.ok(typeof (copy.excludedReasons as Record<string, unknown>)[code] === 'string', `no wording for excluded reason "${code}"`);
  for (const value of ['week', '4-weekly', 'month']) for (const copy of [q, qEn]) assert.ok(typeof (copy.periodTypes as Record<string, unknown>)[value] === 'string', value);
});

test('S5 §9/§10/§16/§19: the spec wording is exact in both languages', () => {
  const exact: Array<[unknown, unknown]> = [
    [q.title, 'Do uzupełnienia'], [qEn.title, 'To resolve'],
    [q.enterOther, 'Wpisz inną wartość'], [qEn.enterOther, 'Enter another value'],
    [q.skip, 'Pomiń na razie'], [qEn.skip, 'Skip for now'], [q.apply, 'Zastosuj'], [qEn.apply, 'Apply'], [q.undo, 'Cofnij'], [qEn.undo, 'Undo'],
    [q.resolvedTitle, 'Rozstrzygnięte przez Ciebie'], [qEn.resolvedTitle, 'Resolved by you'],
    [q.hintsTitle, 'Wcześniejsze lub dodatkowe dane'], [qEn.hintsTitle, 'Earlier or additional evidence'],
    [q.basisContractual, 'Umowa / aneks'], [qEn.basisContractual, 'Contract / annex'], [q.basisEmployerApplied, 'Zastosowane przez pracodawcę'], [qEn.basisEmployerApplied, 'Applied by employer'],
    [q.staleWarning, 'Dokumenty się zmieniły. Sprawdź poprzedni wybór ponownie.'], [qEn.staleWarning, 'The documents changed. Please review your previous choice again.'],
    [q.reasons.sources_disagree, 'Dokumenty pokazują różne wartości dla tego parametru.'], [qEn.reasons.sources_disagree, 'The documents show different values for this parameter.'],
    [q.reasons.payslip_period_unplaceable, 'Nie można ustalić, do którego okresu umowy należy ten pasek wynagrodzenia.'], [qEn.reasons.payslip_period_unplaceable, 'The payslip cannot be reliably assigned to the relevant contract period.'],
    [q.reasons.later_document_unclear, 'Nowszy dokument dotyczy tego parametru, ale jego wartość nie jest wystarczająco czytelna.'], [qEn.reasons.later_document_unclear, 'A newer document covers this parameter, but its value is not clear enough.'],
    [q.reasons.annex_effective_date_disputed, 'Data wejścia aneksu w życie nie jest jednoznaczna, więc wynik zależy od przyjętej daty.'], [qEn.reasons.annex_effective_date_disputed, 'The annex effective date is uncertain, so the result depends on which date applies.'],
    [q.reasons.no_evidence_source, 'Dokumenty nie zawierają wystarczającej informacji o tym parametrze.'], [qEn.reasons.no_evidence_source, 'The documents do not provide enough information for this parameter.'],
    [q.readinessReady, 'Profil jest gotowy; poniższe dane są opcjonalne.'], [qEn.readinessReady, 'The profile is ready; the items below are optional.'],
    [q.readinessBlocking, 'Profil wymaga uzupełnienia przed obliczeniem.'], [qEn.readinessBlocking, 'The profile needs input before calculation.'],
    [q.sourceContract, 'Umowa'], [qEn.sourceContract, 'Contract'], [q.sourcePeriodUnknown, 'Okres nieznany'], [qEn.sourcePeriodUnknown, 'Period unknown'],
    [q.sourceAnnexFrom('X'), 'Aneks od X'], [qEn.sourceAnnexFrom('X'), 'Annex from X'], [q.sourcePayslipPeriod('X'), 'Pasek: X'], [qEn.sourcePayslipPeriod('X'), 'Payslip: X'],
  ];
  for (const [actual, expected] of exact) assert.equal(actual, expected);
});

// ---------------------------------------------------------------------------------------------
// Source-level wiring (#38, #25, #30, §26, mobile)
// ---------------------------------------------------------------------------------------------

const questionsComponent = stripComments(read('ProfileQuestions.tsx'));
const questionsLogic = stripComments(read('pro-profile-questions.ts'));
const proDocuments = stripComments(read('ProDocuments.tsx'));
const importsOf = (code: string) => [...code.matchAll(/^import [\s\S]*? from '([^']+)';/gm)].map((m) => m[1]).sort();

test('S5 #38 §30: the P3 question flow is its own model - it imports no replay, needsConfirmation, discrepancy or tier-c helper', () => {
  assert.deepEqual(importsOf(questionsComponent), ['./pro-profile-prefill.ts', './pro-profile-questions.ts', './translations.ts', 'lucide-react']);
  assert.deepEqual(importsOf(questionsLogic), ['./pro-profile-prefill.ts', './translations.ts']);
  for (const [name, code] of [['ProfileQuestions.tsx', questionsComponent], ['pro-profile-questions.ts', questionsLogic]] as const) {
    for (const legacy of ['needsConfirmation', 'NeedsConfirmation', 'openNeedsConfirmation', 'tier-c-shared', 'replay', 'Discrepancy', 'discrepanc', 'confirmedIssueKeys', 'payslipAnalysis', 'recomputeWithPathCorrection']) {
      assert.ok(!code.includes(legacy), `${name} must not mention ${legacy}`);
    }
    assert.ok(!/\bfetch\s*\(/.test(code.replace(/fetchImpl: typeof fetch = fetch/g, '')), `${name} makes no request of its own`);
  }
  assert.ok(!/\.sort\(|\.reverse\(/.test(questionsComponent + questionsLogic.replace(/\[\.\.\.[^\]]*\]\.sort/g, '')), 'no client-side re-ordering of issues');
});

test('S5 #38 §21: the legacy replay confirm/correct controls are out of the normal flow - only inside the developer diagnostics section - and the replay logic remains', () => {
  const row = proDocuments.slice(proDocuments.indexOf('<li key={entry.id} className="pro-document-row">'), proDocuments.indexOf('</li>', proDocuments.indexOf('<li key={entry.id} className="pro-document-row">')));
  assert.ok(row.length > 500);
  for (const legacy of ['pro-payslip-confirmation', 'renderLegacyReplayCard', 'confirmNeedsConfirmationIssue', 'correctNeedsConfirmationIssue', 'tc.confirmYes', 'tc.correctSubmit', 'setCorrectionInput', 'payslipSummaryNeedsConfirmation']) {
    assert.ok(!row.includes(legacy), `the document row (normal flow) must not contain ${legacy}`);
  }
  const calls = [...proDocuments.matchAll(/renderLegacyReplayCard\(/g)].length;
  assert.equal(calls, 2, 'the definition and exactly one use');
  const diagnostics = proDocuments.slice(proDocuments.indexOf('<details className="pro-developer-diagnostics pro-legacy-replay">'));
  assert.ok(diagnostics.includes('renderLegacyReplayCard(entry)') && diagnostics.includes('</details>'), 'the card is rendered inside the collapsed developer details');
  assert.ok(proDocuments.indexOf('renderLegacyReplayCard(entry)') > proDocuments.indexOf('pro-developer-diagnostics'));
  // The replay itself is unchanged and still wired.
  for (const kept of ['async function replayPayslip', "fetch('/api/pro/payslip-replay'", 'recomputeWithPathCorrection(', 'openNeedsConfirmation(', 'async function correctNeedsConfirmationIssue', 'function confirmNeedsConfirmationIssue', 'visibleNeedsConfirmation', 'payslipSummaryComputedDiffers']) {
    assert.ok(proDocuments.includes(kept), `replay logic must remain: ${kept}`);
  }
  assert.ok(proDocuments.includes('t.payslipSummaryRead(') && !/isProvisional\s*\?\s*t\.payslipSummaryNeedsConfirmation/.test(proDocuments), 'the normal row no longer announces a second to-confirm workflow');
});

test('S5 §20/§31.24/31.25/31.30: ProDocuments has ONE resolve path carrying the decision set; the profile is only ever what the backend returned; the reading path is untouched', () => {
  assert.ok(!/\bresolveProfile\b/.test(proDocuments), 'no direct resolveProfile call - everything goes through resolveWithDecisions');
  const calls = [...proDocuments.matchAll(/resolveWithDecisions\(([^)]*)\)/g)].map((m) => (m[1] ?? '').replace(/\s+/g, ' '));
  assert.deepEqual(calls, ['asOfDate, profileDocuments, sent', 'value, resolvedDocuments, sent', 'profile.asOfDate, resolvedDocuments, sent'], 'submit, as-of change, Apply/Undo - each with the decision set');
  assert.equal([...proDocuments.matchAll(/const sent = decisionsRef\.current;/g)].length, 2, 'a re-read and a new date resubmit the current set');
  // Only backend-returned data is ever stored.
  for (const [setter, allowed] of [['setProfile', ['null', 'resolved.profile']], ['setIssues', ['[]', 'resolved.issues']], ['setReadiness', ['null', 'resolved.readiness']], ['setDecisionResults', ['resolved.decisionResults']]] as const) {
    const args = [...proDocuments.matchAll(new RegExp(`${setter}\\(([^)]*)\\)`, 'g'))].map((m) => m[1]);
    assert.ok(args.length > 0 && args.every((a) => (allowed as readonly string[]).includes(a as string)), `${setter} only receives ${allowed.join(' / ')}: ${JSON.stringify(args)}`);
  }
  // Apply is one call into the set path - no loop of requests - and Undo removes the decision first.
  const apply = proDocuments.slice(proDocuments.indexOf('function applyPendingDecisions'), proDocuments.indexOf('function undoUserDecision'));
  assert.ok(apply.includes('planApply(') && apply.includes('resolveDecisionSet(sent)') && !/for \(|\.map\(|forEach/.test(apply), 'Apply is a single resolve');
  const undo = proDocuments.slice(proDocuments.indexOf('function undoUserDecision'), proDocuments.indexOf('function touchField'));
  assert.ok(undo.includes('resolveDecisionSet(removeDecision(decisionsRef.current, fieldPath))'));
  // A failed Apply/Undo keeps everything: nothing is cleared before the backend answered.
  const flow = proDocuments.slice(proDocuments.indexOf('async function resolveDecisionSet'), proDocuments.indexOf('function applyPendingDecisions'));
  assert.ok(flow.indexOf('if (!outcome) { setGlobalError(t.profileError); return; }') < flow.indexOf('applyOutcome(outcome, sent)'), 'on failure: the error, and return before anything is replaced');
  assert.ok(!/setProfile|setIssues|setPending|decisionsRef\.current =/.test(flow.slice(0, flow.indexOf('applyOutcome'))), 'no state is touched before the result lands');
  // The reading / batching path is unchanged and knows nothing about decisions.
  const reading = proDocuments.slice(proDocuments.indexOf('async function readDocument'), proDocuments.indexOf('async function submitAll'));
  for (const kept of ['planDocumentBatches(source)', 'readDocumentSource(entry.file)', '/api/pro/${kind}-facts', 'failedPages.push(...batch.pages)']) assert.ok(reading.includes(kept), kept);
  assert.ok(!/resolveWithDecisions|decisionsRef|pending|issues/.test(reading), 'reading documents is independent of decisions');
  assert.ok(proDocuments.includes('<TierACalculator key={submitCount}'), 'the calculator still remounts with the profile');
});

test('S5 §4/§5/§34: the panel sits below the submit area and above the developer profile table; it gets all issues (the component filters); there is no group selector', () => {
  const submitRow = proDocuments.indexOf('pro-document-submit-row');
  const panel = proDocuments.indexOf('<ProfileQuestions');
  const developerTable = proDocuments.indexOf('pro-effective-contract pro-payroll-profile');
  const projection = proDocuments.indexOf('<div className="pro-projection">');
  assert.ok(submitRow > 0 && submitRow < panel && panel < developerTable && developerTable < projection, 'document/submit area -> To resolve -> developer table -> projection');
  assert.ok(proDocuments.includes('issues={issues}') && !/issues=\{visibleIssues/.test(proDocuments), 'ProDocuments does not pre-filter or re-sort');
  assert.ok(proDocuments.includes('readiness={readiness}'), 'the backend readiness is shown as is');
  assert.ok(!/requirements|REQUIREMENT_GROUP|groups:/.test(proDocuments), 'no requirement-group selector (backend default core_pay)');
  assert.ok(!/<(?:dialog|Modal)|role="dialog"/.test(questionsComponent + proDocuments), 'not a modal');
});

test('S5 §12: the component never rewrites what the user typed - every input hands its raw value to the callback (-95 stays -95 until the backend judges it)', () => {
  assert.ok(!/\.replace\(|Math\.abs|Math\.round|parseFloat|parseInt|Number\(|toFixed|\.trim\(\)|\.toLowerCase\(/.test(questionsComponent), 'no normalisation of user input in the component');
  const handlers = [...questionsComponent.matchAll(/onChange=\{\(event\) => onChange\(([^)]*)\)\}/g)].map((m) => m[1]);
  assert.equal(handlers.length, 4, 'select (enum and boolean), number, date and text inputs');
  assert.ok(handlers.every((h) => h === 'event.target.value'), `every input passes event.target.value unchanged: ${JSON.stringify(handlers)}`);
  assert.ok(questionsComponent.includes('onChange={(raw) => props.onManualChange(issue.fieldPath, raw)}'), 'and the card forwards it as typed');
});

test('S5 §26: no raw backend code is ever rendered as text - reason codes, excluded-reason codes, hint kinds, states and field paths only pass through translators', () => {
  assert.ok(!/>\s*\{\s*(?:issue|x|h|entry|c)\.(?:reason|reason\.code|code|meaning|state|kind|fieldPath|key|factReason|severity|basis)\s*\}/.test(questionsComponent), 'no raw field printed as a JSX child (an attribute such as key={...} is not text)');
  assert.ok(!/>\s*\{[^}]*fieldPath[^}]*\}\s*</.test(questionsComponent), 'a field path is never a text child');
  for (const translator of ['reasonText(issue.reason, q)', 'excludedReasonText(x.reason, q)', 'hintText(h.kind, q)', 'issueTitle(issue, q)', 'severityText(issue.severity, q)', 'basisText(c.basis, q)']) assert.ok(questionsComponent.includes(translator), translator);
  assert.ok(!/\bid=\{[^}]*fieldPath|name=\{[^}]*fieldPath|data-[a-z-]+=\{[^}]*fieldPath/.test(questionsComponent), 'field paths are not even in attributes: ids and names are index-based');
});

test('S5 §23/§31.26: mobile - one column, wrapping chips, full-width rows, no fixed widths, 44px targets, collapsed details', () => {
  const css = read('styles.css');
  const marker = css.indexOf('P3.1 S5');
  assert.ok(marker > 0);
  const start = css.lastIndexOf('/*', marker);
  const block = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...block.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
  const rule = (sel: string) => rules.find((r) => r.selector === sel)?.body ?? '';
  assert.ok(/display:grid/.test(rule('.pq-list')), 'cards stack in a single column');
  assert.ok(/flex-wrap:wrap/.test(rule('.pq-chips')) && /overflow-wrap:anywhere/.test(rule('.pq-chip')), 'source chips wrap, long file names break');
  assert.ok(/width:100%/.test(rule('.pq-candidate,.pq-manual')) && /box-sizing:border-box/.test(rule('.pq-candidate,.pq-manual')), 'full-width candidate rows');
  assert.ok(/min-width:0/.test(rule('.pq-manual-field')) && /width:100%/.test(rule('.pq-manual-field input,.pq-manual-field select')), 'full-width manual input');
  assert.ok(/min-height:44px/.test(rule('.pq-small')) && /min-height:44px/.test(rule('.pq-skip')), 'touch targets');
  assert.ok(/overflow-wrap:anywhere/.test(rule('.pq-card-head h3')) && /min-width:0/.test(rule('.profile-questions')) && /min-width:0/.test(rule('.pq-card')));
  assert.ok(rules.some((r) => /max-width:520px/.test(r.selector) || /@media\(max-width:520px\)/.test(block)));
  for (const r of rules) {
    if (!/\.(?:pq-|profile-questions|pro-developer-diagnostics)/.test(r.selector)) continue;
    assert.ok(!/(?:^|[;{\s])(?:min-)?width:\s*\d+(?:\.\d+)?(?:px|rem|em)/.test(r.body), `${r.selector}: no fixed width (${r.body})`);
    assert.ok(!/white-space:\s*nowrap/.test(r.body) || r.selector === '.pq-sr', `${r.selector}: no nowrap`);
    assert.ok(!/overflow-x:\s*(?:scroll|auto)/.test(r.body), `${r.selector}: no horizontal scroller`);
  }
  assert.ok(!questionsComponent.includes('<table'), 'cards, not a wide table');
  assert.ok(/pq-severity-blocking::before\{content:'! '/.test(block.replace(/\s+/g, '')) || block.includes("pq-severity-blocking::before{content:'! '"), 'blocking carries a glyph, not just a colour');
  assert.equal([...questionsComponent.matchAll(/<details/g)].length, 3);
  assert.ok(![...questionsComponent.matchAll(/<details[^>]*\sopen/g)].length, 'evidence is collapsed by default');
});
