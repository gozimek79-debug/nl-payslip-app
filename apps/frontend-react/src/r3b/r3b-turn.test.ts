import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUT_OF_GOAL_FIELDS, ambiguousTotalPercent, buildTurnRequest, nextDeferred, percentMeaningMessage, plHours, postTurn, serverDeferrals, suggestionsFor, withUserValue, type NextQuestionView, type TurnResultView } from './r3b-turn.ts';
import { projectProfile, DOCUMENT_FIELD_TO_SCENARIO } from './r3b-profile-projection.ts';
import { asOfForChoice, asOfNeed, checkFile, profileDocuments, type R3BDocument } from './r3b-documents.ts';
import type { ResolvedProfileView } from '../pro-profile-prefill.ts';
import { fixtures, response } from './r3b-test-support.ts';

/** R3-B pure pieces: the R2 client, the Profile projection and the document rules. */

test('R3-B turn: the out-of-goal list is the one the backend generator used', () => {
  assert.deepEqual([...OUT_OF_GOAL_FIELDS], fixtures.outOfGoalFields);
});

test('R3-B turn: every example reply offered for a recorded question context is answered by R2 without a model', () => {
  const contexts = new Map<string, NextQuestionView | null>();
  // The question each probe context was asked, rebuilt from the recorded flows (same R2 output the probes started from).
  const flows = Object.values(fixtures.turns).flat().map((r) => (r.response as TurnResultView).nextQuestion).filter((q): q is NextQuestionView => q !== null);
  for (const q of flows) contexts.set(`${q.kind}:${q.field}:${q.reasonCode}:${String(q.prompt.params.statedWeeklyTotal ?? '')}`, q);
  let checked = 0;
  for (const locale of ['pl', 'en'] as const) {
    const sendable = (q: NextQuestionView | null, started: boolean) => suggestionsFor(q, started, locale).filter((s) => ambiguousTotalPercent(s, q?.field) === null);
    const deterministic = (context: string) => new Set(fixtures.probes.filter((p) => p.locale === locale && p.context === context && p.agentStatus === 'not_needed').map((p) => p.message));
    const covers = (context: string, replies: string[]) => {
      const known = deterministic(context);
      for (const reply of replies) { assert.ok(known.has(reply), `${locale}/${context}: "${reply}" is not a recorded deterministic reply`); checked++; }
    };
    covers('opening', sendable(null, false));
    for (const q of contexts.values()) {
      if (q.kind === 'clarify_hours_composition' && q.prompt.params.statedWeeklyTotal === 40) covers('clarify_40', sendable(q, true));
      if (q.field === 'work.hours' && q.reasonCode === 'hours_include_other_categories' && q.prompt.params.statedWeeklyTotal === 40) covers('split_40', sendable(q, true));
      if (q.field === 'work.hours' && q.kind === 'provide_value' && q.reasonCode === 'missing') covers('opening', sendable(q, true));
      if (q.field === 'pay.hourlyRate' && q.kind === 'provide_value') covers('rate', sendable(q, true));
      if (q.field === 'pay.saturdayPremiumPercent' && q.kind === 'provide_value') covers('saturday_premium', [...sendable(q, true), percentMeaningMessage('total', 150, locale), percentMeaningMessage('above', 150, locale)]);
      if (q.kind === 'offer_assumption') covers('offer_saturday', sendable(q, true));
    }
  }
  assert.ok(checked >= 28, `checked ${checked}`);
});

test('R3-B turn: a percentage of 100+ on a premium question is intercepted (P1 open) - nowhere else', () => {
  const sat = 'pay.saturdayPremiumPercent';
  for (const m of ['150%', '150', '150 %', '150 procent', '150% za sobotę', '200%', '+150%', '125,5%']) assert.notEqual(ambiguousTotalPercent(m, sat), null, m);
  for (const m of ['50%', '50', 'dodatek 50%', '150 euro', '16,80', 'nie wiem']) assert.equal(ambiguousTotalPercent(m, sat), null, m);
  assert.equal(ambiguousTotalPercent('150%', 'pay.hourlyRate'), null);
  assert.equal(ambiguousTotalPercent('150%', null), null);
  assert.equal(percentMeaningMessage('total', 150, 'pl'), '50%');
  assert.equal(percentMeaningMessage('above', 150, 'pl'), '150%');
  assert.equal(percentMeaningMessage('total', 137.5, 'pl'), '37,5%');
  assert.equal(percentMeaningMessage('unknown', 150, 'en'), "I don't know");
});

test('R3-B turn: deferral keeps the server order and the user\'s "nie wiem", and drops a document deferral that no longer holds', () => {
  assert.deepEqual(nextDeferred([], [], ['pay.hourlyRate', 'tax.loonheffingskorting']), ['pay.hourlyRate', 'tax.loonheffingskorting']);
  assert.deepEqual(nextDeferred(['tax.loonheffingskorting', 'pay.hourlyRate', 'work.hours'], ['work.hours'], ['tax.loonheffingskorting']), ['tax.loonheffingskorting', 'work.hours'], 'the removed document no longer defers the rate');
  assert.deepEqual(serverDeferrals(['a', 'b'], ['a', 'b', 'pay.hourlyRate']), ['pay.hourlyRate']);
  const body = buildTurnRequest({ scenario: null, message: 'x', locale: 'pl', digest: null, deferredFields: ['pay.hourlyRate'] });
  assert.deepEqual(body, { message: 'x', locale: 'pl', conversation: { deferredFields: ['pay.hourlyRate'] } });
});

test('R3-B turn: network failures are reported, never treated as an answer', async () => {
  const fail = (status: number) => (async () => response(status, { error_code: 'x' })) as unknown as typeof fetch;
  assert.deepEqual(await postTurn(buildTurnRequest({ scenario: null, message: 'x', locale: 'pl', digest: null, deferredFields: [] }), fail(429)), { ok: false, reason: 'rate_limited' });
  assert.deepEqual(await postTurn(buildTurnRequest({ scenario: null, message: 'x', locale: 'pl', digest: null, deferredFields: [] }), fail(503)), { ok: false, reason: 'unavailable' });
  const throws = (async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
  assert.deepEqual(await postTurn(buildTurnRequest({ scenario: null, message: 'x', locale: 'pl', digest: null, deferredFields: [] }), throws), { ok: false, reason: 'network' });
  const slow = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch;
  assert.deepEqual(await postTurn(buildTurnRequest({ scenario: null, message: 'x', locale: 'pl', digest: null, deferredFields: [] }), slow, 20), { ok: false, reason: 'timeout' });
});

test('R3-B turn: an edit writes a user value - never a document source', () => {
  const s = withUserValue(null, 'pay.overtime.tier1Percent', 25);
  assert.deepEqual(s.pay, { overtime: { tier1Percent: { state: 'known', value: 25, source: 'user' } } });
  assert.equal(plHours(1), 'godzina');
  assert.deepEqual([2, 4, 5, 12, 22, 25, 32, 40, 37.5].map(plHours), ['godziny', 'godziny', 'godzin', 'godzin', 'godziny', 'godzin', 'godziny', 'godzin', 'godziny']);
});

// ---------------------------------------------------------------------------------------------

const profile = (id: string) => (fixtures.profiles[id]?.response) as ResolvedProfileView;

test('R3-B projection: a readable rate defers only the rate question; contract hours per week never defers the hours question', () => {
  const payslip = projectProfile(profile('payslip_only'));
  assert.deepEqual(payslip.deferrableFields, ['pay.hourlyRate']);
  assert.deepEqual(payslip.facts.map((f) => [f.path, f.status]), [['employment.hourlyRate', 'document_reading'], ['payroll.periodType', 'document_reading']]);
  const noRate = projectProfile(profile('contract_no_rate'));
  assert.deepEqual(noRate.deferrableFields, [], 'no document rate -> the rate is asked; 40 h/week in the contract is not this week');
  assert.deepEqual(noRate.facts.map((f) => [f.path, f.status, f.defersQuestion]), [['employment.hourlyRate', 'unknown', false], ['employment.hoursPerWeek', 'document_reading', false]]);
  assert.ok(!Object.keys(DOCUMENT_FIELD_TO_SCENARIO).includes('employment.hoursPerWeek'));
});

test('R3-B projection: a conflict carries every candidate with its own source and defers nothing; a user choice is a user state', () => {
  const conflict = projectProfile(profile('contract_payslip_conflict'));
  const rate = conflict.facts.find((f) => f.path === 'employment.hourlyRate');
  assert.equal(rate?.status, 'conflict');
  assert.equal(rate?.defersQuestion, false);
  assert.ok(conflict.rateConflict);
  assert.deepEqual(rate?.candidates.map((c) => [typeof c.candidateId, c.value, c.sources.map((s) => s.role)]), [['string', 17.2, ['contract_base']], ['string', 16.8, ['payslip']]]);
  const chosen = projectProfile(profile('contract_payslip_conflict_payslip_chosen'));
  const c = chosen.facts.find((f) => f.path === 'employment.hourlyRate');
  assert.deepEqual([c?.status, c?.value, c?.decidedAt, c?.defersQuestion], ['user_confirmed', 16.8, '2026-10-18T10:00:00.000Z', true]);
  assert.equal(chosen.rateConflict, null);
});

test('R3-B projection: readings of another period are shown apart - never as a conflict', () => {
  const from = projectProfile(profile('annex_week_from')).facts.find((f) => f.path === 'employment.hourlyRate');
  assert.equal(from?.status, 'document_reading');
  assert.ok(from?.otherPeriods.every((o) => o.reason === 'superseded_by_later_document'));
  assert.ok(from?.otherPeriods.some((o) => o.value === 16.8 && o.source.role === 'payslip' && o.source.period?.end === '2026-08-16'));
  const before = projectProfile(profile('annex_week_before')).facts.find((f) => f.path === 'employment.hourlyRate');
  assert.deepEqual([before?.status, before?.value, before?.sources.map((s) => s.role)], ['documents_agree', 16.8, ['contract_base', 'payslip']]);
});

test('R3-B projection: malformed or empty profiles project to nothing - no invented fact', () => {
  assert.deepEqual(projectProfile({ profile: {} as never, extractionTable: [], decisionResults: [], issues: [], readiness: null }).facts, []);
  assert.deepEqual(projectProfile({ profile: { employment: { hourlyRate: { state: 'bogus' } } } as never, extractionTable: [], decisionResults: [], issues: [], readiness: null }).facts, []);
});

// ---------------------------------------------------------------------------------------------

const doc = (p: Partial<R3BDocument>): R3BDocument => ({ id: 'doc-1', documentType: 'payslip', effectiveDate: null, file: null, fileName: 'x.pdf', size: 1, status: 'read', factBatches: [{}], ...p });

test('R3-B documents: the as-of date is asked only when a dated annex makes the profile depend on it', () => {
  assert.deepEqual(asOfNeed([doc({}), doc({ id: 'doc-2', documentType: 'contract_base' })]), { kind: 'independent' });
  assert.deepEqual(asOfNeed([doc({ documentType: 'contract_annex', effectiveDate: '2026-09-01' })]), { kind: 'ask', boundaries: ['2026-09-01'] });
  assert.deepEqual(asOfNeed([doc({ documentType: 'contract_annex', effectiveDate: '2026-09-01', status: 'failed' })]), { kind: 'independent' }, 'an unread annex changes nothing');
  assert.equal(asOfForChoice({ kind: 'before', date: '2026-09-01' }), '2026-08-31');
  assert.equal(asOfForChoice({ kind: 'before', date: '2026-03-01' }), '2026-02-28');
  assert.equal(asOfForChoice({ kind: 'from', date: '2026-09-01' }), '2026-09-01');
  assert.equal(asOfForChoice({ kind: 'day', date: '2026-13-01' }), null);
});

test('R3-B documents: only read documents reach the profile, with technical labels - never the file name', () => {
  const sent = profileDocuments([doc({ fileName: 'Jan Kowalski loonstrook.pdf' }), doc({ id: 'doc-2', status: 'failed', factBatches: undefined }), doc({ id: 'doc-3', documentType: 'contract_annex', effectiveDate: '2026-09-01' })]);
  assert.deepEqual(sent.map((d) => [d.index, d.documentId, d.label, d.role, d.effectiveDate]), [[0, 'doc-1', 'payslip-1', 'payslip', null], [1, 'doc-3', 'contract_annex-2', 'contract_annex', '2026-09-01']]);
  assert.ok(!JSON.stringify(sent).includes('Kowalski'));
  assert.equal(checkFile({ type: 'image/png', size: 10 }), null);
  assert.equal(checkFile({ type: 'image/gif', size: 10 }), 'type');
});
