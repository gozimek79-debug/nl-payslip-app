import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConversationTurn, type TurnRequest } from './conversation-turn.js';
import { parseNumericAnswer, statesWeekdaySemantics } from './deterministic-interpreter.js';
import { assumptionNode, ASSUMPTION_CATALOG } from './assumption-catalog.js';
import { authorizePatch } from './patch-authority.js';
import type { AgentOutcome } from './conversation-agent.js';
import type { ScenarioV1 } from '../scenario/scenario-types.js';
import { canonicalJson } from '../scenario/scenario-util.js';
import { RATES_2026, known, out, readyScenario, scenario, scriptedAgent, type ScriptedAgent } from '../test-support/conversation-fixtures.js';

/**
 * Cursor R2 review findings F1-F5 (RAPORT-CURSOR-REVIEW-R2-CONVERSATION-CORE.md). Each block proves the OLD
 * behaviour now fails: model call counts, Scenario byte-equality, next-question identity, no evaluation and
 * no payout are asserted where they matter - not only the final status.
 */

const run = (req: TurnRequest, agent: ScriptedAgent | null) => runConversationTurn(req, { agent, rates: RATES_2026, newId: () => 'fixed' });
const bytes = (s: unknown) => JSON.stringify(s);
const hoursKeys = (s: ScenarioV1) => Object.keys(s.work).sort();

// =============================================================================================
// F1 - no hidden weekly-total -> weekday-hours default
// =============================================================================================

/** A model that (wrongly) classifies any weekly total as weekday hours - the backstop must stop it. */
const weekdayWriter = (hours = 40, extra: AgentOutcome[] = []) => scriptedAgent([out('provide_information', [{ op: 'set', field: 'work.regularWeekdayHours', value: hours }]), ...extra]);

test('F1 #1 / #2 / #7: explicit Monday-Friday / weekday wording may set weekday hours (EN + PL)', async () => {
  for (const message of ['40 hours Monday to Friday', '40 weekday hours', 'I work 40 hours mon-fri', '40 godzin od poniedziałku do piątku', '40 godzin pon-pt', '40 godzin w dni robocze']) {
    const r = await run({ scenario: scenario(), message, locale: 'en' }, weekdayWriter());
    assert.deepEqual(r.scenario.work.regularWeekdayHours, { source: 'user', state: 'known', value: 40 }, message);
    assert.ok(!r.patchNotes.some((n) => n.code === 'weekday_hours_withheld'), message);
  }
});

test('F1 #3 / #5 / #6 / #7: an unqualified, weekend-inclusive or varying weekly total is NEVER written as weekday hours', async () => {
  for (const message of ['40 hours a week', 'I work 40 hours', '40 hours including weekends', '40 hours, shifts vary', '40 godzin tygodniowo', 'pracuję 40 godzin', '40 godzin łącznie z weekendami', '40 godzin, zmiany się zmieniają']) {
    const agent = weekdayWriter();
    const r = await run({ scenario: scenario(), message, locale: 'en' }, agent);
    assert.equal(agent.calls, 1, message);
    assert.equal(r.scenario.work.regularWeekdayHours, undefined, `${message}: weekday hours must not be written`);
    assert.deepEqual(hoursKeys(r.scenario), [], `${message}: no split invented`);
    assert.deepEqual(r.patchNotes.map((n) => n.code), ['weekday_hours_withheld'], message);
    // exactly ONE clarification about the composition of the stated total
    assert.equal(r.nextQuestion?.kind, 'clarify_hours_composition', message);
    assert.equal(r.nextQuestion?.field, 'work.hours');
    assert.equal(r.nextQuestion?.reasonCode, 'ambiguous_hours');
    assert.equal(r.nextQuestion?.prompt.params.statedWeeklyTotal, 40);
    assert.deepEqual(r.nextQuestion?.options, ['weekday_regular_only', 'includes_other_categories']);
    assert.deepEqual(r.conversation.hoursClarification, { statedWeeklyTotal: 40 });
    assert.equal(r.evaluation?.status, 'blocked');
    assert.ok(!('figures' in (r.evaluation ?? {})), 'no payout');
  }
});

test('F1 #4: "I earn 16.80 an hour and work 40 hours a week" -> rate as user, weekday NOT written, one clarification', async () => {
  const message = 'I earn 16.80 an hour and work 40 hours a week.';
  // (a) a model that wrongly classifies the 40 h: the backstop withholds it, the rate is kept
  const wrong = scriptedAgent([out('provide_information', [{ op: 'set', field: 'pay.hourlyRate', value: 16.8 }, { op: 'set', field: 'work.regularWeekdayHours', value: 40 }])]);
  // (b) a model following the new prompt: no hours op, the total only as statedWeeklyHours
  const right = scriptedAgent([{ status: 'ok', output: { intent: 'provide_information', patch: { version: 1, ops: [{ op: 'set', field: 'pay.hourlyRate', value: 16.8 }] }, hint: 'ambiguous_hours', statedWeeklyHours: 40 } }]);
  for (const agent of [wrong, right]) {
    const r = await run({ message, locale: 'en' }, agent);
    assert.equal(agent.calls, 1);
    assert.equal(r.status, 'updated');
    assert.deepEqual(r.scenario.pay.hourlyRate, { source: 'user', state: 'known', value: 16.8 });
    assert.equal(r.scenario.work.regularWeekdayHours, undefined);
    assert.deepEqual(hoursKeys(r.scenario), [], 'no weekend / holiday / overtime hours invented (#9)');
    assert.equal(r.nextQuestion?.kind, 'clarify_hours_composition');
    assert.equal(r.nextQuestion?.prompt.params.statedWeeklyTotal, 40);
    assert.ok(!bytes(r.scenario).includes('loonto_assumption'), 'no assumption inserted (#8)');
    assert.ok(r.evaluation?.status === 'blocked' && r.evaluation.requirements.some((q) => q.field === 'work.hours'));
  }
});

test('F1: the clarification resolves only on an explicit answer - "tak" commits the total as weekday hours, "nie" asks for a split', async () => {
  const first = await run({ message: 'I earn 16.80 an hour and work 40 hours a week.', locale: 'en' }, scriptedAgent([{ status: 'ok', output: { intent: 'provide_information', patch: { version: 1, ops: [{ op: 'set', field: 'pay.hourlyRate', value: 16.8 }] }, hint: 'ambiguous_hours', statedWeeklyHours: 40 } }]));
  // "tak" - deterministic, no model
  const yesAgent = scriptedAgent([]);
  const yes = await run({ scenario: first.scenario, message: 'tak', locale: 'pl', conversation: first.conversation }, yesAgent);
  assert.equal(yesAgent.calls, 0);
  assert.deepEqual(yes.scenario.work.regularWeekdayHours, { source: 'user', state: 'known', value: 40 });
  assert.equal(yes.conversation.hoursClarification, undefined, 'the clarification is dropped once hours exist');
  // "nie" - nothing written, the next question asks for the hours split by kind
  const no = await run({ scenario: first.scenario, message: 'no', locale: 'en', conversation: first.conversation }, scriptedAgent([]));
  assert.equal(no.status, 'unchanged');
  assert.deepEqual(hoursKeys(no.scenario), []);
  assert.equal(no.nextQuestion?.kind, 'provide_value');
  assert.equal(no.nextQuestion?.field, 'work.hours');
  assert.equal(no.nextQuestion?.reasonCode, 'hours_include_other_categories');
  assert.deepEqual(no.nextQuestion?.fallbackOptions, ['split_hours', 'give_range']);
  assert.deepEqual(no.conversation.hoursClarification, { statedWeeklyTotal: 40, weekdayOnly: false });
  // a model answer to the clarification is allowed only when the user confirms weekday-only
  const confirm = await run({ scenario: first.scenario, message: 'yes, those are all regular hours', locale: 'en', conversation: first.conversation }, weekdayWriter());
  assert.deepEqual(confirm.scenario.work.regularWeekdayHours, { source: 'user', state: 'known', value: 40 });
  const denies = await run({ scenario: first.scenario, message: 'no, that includes Saturdays', locale: 'en', conversation: first.conversation }, weekdayWriter());
  assert.equal(denies.scenario.work.regularWeekdayHours, undefined, 'a denial is never turned into weekday hours');
});

test('F1: answering the weekday-hours question itself may set weekday hours; ranges are withheld like single values', async () => {
  const asked = { ...readyScenario(), work: { regularWeekdayHours: { state: 'unknown' } } } as ScenarioV1;
  const r = await run({ scenario: asked, message: 'around forty, I think', locale: 'en' }, weekdayWriter());
  assert.deepEqual(r.scenario.work.regularWeekdayHours, { source: 'user', state: 'known', value: 40 });
  const ranged = await run({ scenario: scenario(), message: 'between 36 and 40 hours a week', locale: 'en' }, scriptedAgent([out('provide_information', [{ op: 'set_range', field: 'work.regularWeekdayHours', low: 36, high: 40 }])]));
  assert.equal(ranged.scenario.work.regularWeekdayHours, undefined);
  assert.equal(ranged.nextQuestion?.kind, 'clarify_hours_composition');
});

test('F1: weekday-evidence detection (EN / PL)', () => {
  for (const yes of ['Monday to Friday', 'mon-fri', 'monday through friday', 'weekdays', 'on working days', 'od poniedziałku do piątku', 'pon-pt', 'w dni robocze', 'dni powszednie']) assert.ok(statesWeekdaySemantics(yes), yes);
  for (const no of ['40 hours a week', 'weekends', 'including the weekend', 'tygodniowo', 'w tygodniu', 'shifts vary', 'zmiany']) assert.ok(!statesWeekdaySemantics(no), no);
});

// =============================================================================================
// F2 - unit-aware bare-number shortcut
// =============================================================================================

const rateQuestion = () => ({ ...readyScenario(), pay: {} }) as ScenarioV1;
const hoursQuestion = () => ({ ...readyScenario(), work: { regularWeekdayHours: { state: 'unknown' } } }) as ScenarioV1;
const percentQuestion = () => ({ ...readyScenario(), work: { regularWeekdayHours: known(40), sundayHours: known(6) } }) as ScenarioV1;

async function accepted(s: ScenarioV1, message: string, path: [keyof ScenarioV1, string], value: number) {
  const agent = scriptedAgent([]);
  const r = await run({ scenario: s, message, locale: 'en' }, agent);
  assert.equal(agent.calls, 0, `${message}: deterministic`);
  assert.deepEqual((r.scenario[path[0]] as Record<string, unknown>)[path[1]], { source: 'user', state: 'known', value }, message);
}
async function notApplied(s: ScenarioV1, message: string) {
  const none = await run({ scenario: s, message, locale: 'en' }, null);
  assert.equal(none.status, 'unchanged', `${message} (no model)`);
  assert.equal(canonicalJson(none.scenario), canonicalJson(s), `${message}: Scenario unchanged (zero mutation)`);
  assert.equal(none.patchApplied, null);
  // with a model it falls through to the model (one call) instead of writing the wrong field
  const agent = scriptedAgent([out('unclear', [])]);
  const withModel = await run({ scenario: s, message, locale: 'en' }, agent);
  assert.equal(agent.calls, 1, `${message}: falls through to the model`);
  assert.equal(withModel.status, 'unchanged');
  return none;
}

test('F2 #1-#3 / #11: the rate question accepts plain, EUR and per-hour numbers (EN + PL)', async () => {
  for (const message of ['16.80', '16,80', '€16.80', '16.80 €', '16.80 per hour', '16,80 € za godzinę', '16.80/h', '16,80 euro na godzinę', '16.80 an hour']) {
    await accepted(rateQuestion(), message, ['pay', 'hourlyRate'], 16.8);
  }
});

test('F2 #4: "40 hours" on the rate question is NEVER the hourly rate (old: rate 40, payout 1022.45)', async () => {
  for (const message of ['40 hours', '40 h', '40 godzin', '50%', '16.80 a week']) {
    const r = await notApplied(rateQuestion(), message);
    assert.equal(r.scenario.pay.hourlyRate, undefined, message);
    assert.equal(r.evaluation?.status, 'blocked', `${message}: no payout`);
  }
});

test('F2 #5-#7 / #11: the hours question accepts plain and hour-unit numbers, never a percentage', async () => {
  for (const message of ['40', '40 hours', '40 h', '40 godzin', '40 hours a week']) await accepted(hoursQuestion(), message, ['work', 'regularWeekdayHours'], 40);
  for (const message of ['50%', '50 procent', '16.80 €', '16.80 per hour']) {
    const r = await notApplied(hoursQuestion(), message);
    assert.deepEqual(r.scenario.work.regularWeekdayHours, { state: 'unknown' }, message);
  }
});

test('F2 #8-#10 / #11: the percent question accepts plain and %-numbers, never hours', async () => {
  for (const message of ['50', '50%', '50 %', '50 procent', '50 percent']) await accepted(percentQuestion(), message, ['pay', 'sundayPremiumPercent'], 50);
  for (const message of ['50 hours', '50 godzin', '€50']) {
    const r = await notApplied(percentQuestion(), message);
    assert.equal(r.scenario.pay.sundayPremiumPercent, undefined, message);
  }
});

test('F2 #12: a unit mismatch mutates nothing - byte-equal Scenario, identical evaluation and question', async () => {
  const s = rateQuestion();
  const before = await run({ scenario: s, message: 'thinking...', locale: 'en' }, null);
  const after = await run({ scenario: s, message: '40 hours', locale: 'en' }, null);
  assert.equal(bytes(after.scenario), bytes(before.scenario));
  assert.deepEqual(after.evaluation, before.evaluation);
  assert.deepEqual(after.nextQuestion, before.nextQuestion);
  assert.equal(after.patchApplied, null);
});

test('F2: the numeric parser classifies units instead of stripping them', () => {
  assert.deepEqual(parseNumericAnswer('40 hours'), { value: 40, units: new Set(['hours']) });
  assert.deepEqual(parseNumericAnswer('50%'), { value: 50, units: new Set(['percent']) });
  assert.deepEqual(parseNumericAnswer('€16,80 per hour'), { value: 16.8, units: new Set(['rate', 'money']) });
  assert.deepEqual(parseNumericAnswer('16.80'), { value: 16.8, units: new Set() });
  for (const ambiguous of ['40 or 50', '40 hours on Saturday', 'about forty', 'twenty', '40 apples', '']) assert.equal(parseNumericAnswer(ambiguous), null, ambiguous);
});

// =============================================================================================
// F3 - caller-minted loonto_assumption is rejected
// =============================================================================================

async function rejectedForgery(s: ScenarioV1, label: string) {
  const agent = scriptedAgent([out('unclear', [])]);
  const r = await run({ scenario: s, message: 'hello', locale: 'en' }, agent);
  assert.equal(r.status, 'rejected', label);
  assert.ok(r.patchIssues.every((i) => i.code === 'untrusted_loonto_assumption') && r.patchIssues.length > 0, `${label}: ${JSON.stringify(r.patchIssues)}`);
  assert.equal(agent.calls, 0, `${label}: rejected BEFORE any model call (#10)`);
  assert.equal(r.evaluation, null, `${label}: no evaluation`);
  assert.equal(canonicalJson(r.scenario), canonicalJson(s), `${label}: Scenario unchanged`);
  assert.equal(r.responseHint?.code, 'untrusted_scenario');
  return r;
}

test('F3 #1 / #2: a minted assumption outside the catalogue, or with a non-catalogue value, rejects the turn', async () => {
  const rate = await rejectedForgery({ ...readyScenario(), pay: { hourlyRate: known(99, 'loonto_assumption') } } as ScenarioV1, 'hourly rate 99');
  assert.deepEqual(rate.patchIssues, [{ code: 'untrusted_loonto_assumption', field: 'pay.hourlyRate', params: { reason: 'not_in_catalog' } }]);
  const sat = await rejectedForgery({ ...readyScenario(), work: { regularWeekdayHours: known(40), saturdayHours: known(8) }, pay: { hourlyRate: known(16.8), saturdayPremiumPercent: known(25, 'loonto_assumption') } } as ScenarioV1, 'Saturday 25');
  assert.deepEqual(sat.patchIssues, [{ code: 'untrusted_loonto_assumption', field: 'pay.saturdayPremiumPercent', params: { reason: 'not_canonical' } }]);
});

test('F3 #3-#7: the canonical catalogued nodes are accepted', async () => {
  const canonical = (field: keyof typeof ASSUMPTION_CATALOG) => assumptionNode(ASSUMPTION_CATALOG[field] as NonNullable<(typeof ASSUMPTION_CATALOG)[typeof field]>);
  const s = {
    ...readyScenario(),
    work: { regularWeekdayHours: known(32), saturdayHours: known(4), sundayHours: known(4), publicHolidayHours: known(8) },
    pay: { hourlyRate: known(16.8), saturdayPremiumPercent: canonical('pay.saturdayPremiumPercent'), sundayPremiumPercent: canonical('pay.sundayPremiumPercent'), publicHolidayPremiumPercent: canonical('pay.publicHolidayPremiumPercent') },
    tax: { loonheffingskorting: canonical('tax.loonheffingskorting') },
    deductions: { mode: canonical('deductions.mode') },
  } as unknown as ScenarioV1;
  const agent = scriptedAgent([out('unclear', [])]);
  const r = await run({ scenario: s, message: 'ok then', locale: 'en' }, agent);
  assert.notEqual(r.status, 'rejected');
  assert.equal(r.evaluation?.status, 'computed');
  assert.ok(r.evaluation?.status === 'computed' && r.evaluation.assumptionsUsed.length === 5);
});

test('F3 #8 / #9: same value but a different shape, order, extra ref or option is rejected', async () => {
  const base = { ...readyScenario(), work: { regularWeekdayHours: known(40), saturdayHours: known(8) }, pay: { hourlyRate: known(16.8) } } as ScenarioV1;
  const forgeries: Array<[string, Record<string, unknown>]> = [
    ['range 50-50', { pay: { ...base.pay, saturdayPremiumPercent: { state: 'range', low: 50, high: 50, source: 'loonto_assumption' } } }],
    ['extra ref', { pay: { ...base.pay, saturdayPremiumPercent: { state: 'known', value: 50, source: 'loonto_assumption', ref: 'catalog' } } }],
    ['string value', { pay: { ...base.pay, saturdayPremiumPercent: { state: 'known', value: '50', source: 'loonto_assumption' } } }],
    ['tax options reversed', { tax: { loonheffingskorting: { state: 'alternatives', options: ['not_applied', 'applied'], source: 'loonto_assumption' } } }],
    ['tax known applied', { tax: { loonheffingskorting: { state: 'known', value: 'applied', source: 'loonto_assumption' } } }],
    ['deductions enter', { deductions: { mode: { state: 'known', value: 'enter', source: 'loonto_assumption' } } }],
    ['conflict candidate', { pay: { ...base.pay, saturdayPremiumPercent: { state: 'conflict', candidates: [{ value: 50, source: 'loonto_assumption' }, { value: 60, source: 'user' }] } } }],
    ['requested concept', { requestedConcepts: [{ concept: 'night_premium', source: 'loonto_assumption' }] }],
  ];
  for (const [label, override] of forgeries) await rejectedForgery({ ...base, ...override } as ScenarioV1, label);
});

// =============================================================================================
// F4 - accept_assumption only against the live offer for the same field
// =============================================================================================

const saturdayAsked = () => ({ ...readyScenario(), work: { regularWeekdayHours: known(40), saturdayHours: known(8) } }) as ScenarioV1;
const saturdayOffered = () => ({ ...saturdayAsked(), pay: { hourlyRate: known(16.8), saturdayPremiumPercent: { state: 'unknown' } } }) as ScenarioV1;
const acceptBy = (field: string) => scriptedAgent([out('accept_assumption', [{ op: 'accept_assumption', field }])]);

async function notOffered(s: ScenarioV1, field: string, label: string) {
  const r = await run({ scenario: s, message: 'use your own best guess', locale: 'en' }, acceptBy(field));
  assert.equal(r.status, 'rejected', label);
  assert.equal(r.patchIssues[0]?.code, 'assumption_not_offered', label);
  assert.equal(canonicalJson(r.scenario), canonicalJson(s), `${label}: byte-equivalent to the input (#9)`);
  return r;
}

test('F4 #1 / #8: current provide_value + model accept_assumption ("use your own best guess") is rejected', async () => {
  const r = await notOffered(saturdayAsked(), 'pay.saturdayPremiumPercent', 'provide_value');
  assert.equal(r.scenario.pay.saturdayPremiumPercent, undefined, 'no +50% written (old behaviour)');
});

test('F4 #2 / #3: current correct_value or resolve_conflict + model accept_assumption is rejected', async () => {
  const invalid = { ...saturdayAsked(), work: { regularWeekdayHours: known(-5), saturdayHours: known(8) } } as ScenarioV1;
  await notOffered(invalid, 'pay.saturdayPremiumPercent', 'correct_value');
  const conflict = { ...saturdayAsked(), pay: { hourlyRate: { state: 'conflict', candidates: [{ value: 16, source: 'user' }, { value: 17, source: 'user' }] } } } as ScenarioV1;
  await notOffered(conflict, 'pay.saturdayPremiumPercent', 'resolve_conflict');
});

test('F4 #4 / #5 / #6: the live offer for Saturday accepts Saturday only - not Sunday, not a stale client-side offer', async () => {
  const ok = await run({ scenario: saturdayOffered(), message: 'please assume it', locale: 'en' }, acceptBy('pay.saturdayPremiumPercent'));
  assert.equal(ok.status, 'updated');
  assert.deepEqual(ok.scenario.pay.saturdayPremiumPercent, { source: 'loonto_assumption', state: 'known', value: 50 });
  const sunday = { ...saturdayOffered(), work: { regularWeekdayHours: known(40), saturdayHours: known(8), sundayHours: known(6) }, pay: { hourlyRate: known(16.8), saturdayPremiumPercent: { state: 'unknown' }, sundayPremiumPercent: { state: 'unknown' } } } as ScenarioV1;
  await notOffered(sunday, 'pay.sundayPremiumPercent', 'offer is Saturday, accept is Sunday');
  // a client claiming an older offer for Sunday does not create one - the server recomputes the offer
  const stale = await run({ scenario: sunday, message: 'yes the sunday one', locale: 'en', conversation: { pendingQuestion: { field: 'pay.sundayPremiumPercent', kind: 'offer_assumption' } } }, acceptBy('pay.sundayPremiumPercent'));
  assert.equal(stale.patchIssues[0]?.code, 'assumption_not_offered');
});

test('F4 #7: the deterministic "yes" accepts only a live matching offer', async () => {
  const offered = await run({ scenario: saturdayOffered(), message: 'yes', locale: 'en' }, null);
  assert.deepEqual(offered.scenario.pay.saturdayPremiumPercent, { source: 'loonto_assumption', state: 'known', value: 50 });
  const notOfferedYes = await run({ scenario: saturdayAsked(), message: 'yes', locale: 'en' }, null);
  assert.equal(notOfferedYes.status, 'unchanged');
  assert.equal(notOfferedYes.scenario.pay.saturdayPremiumPercent, undefined);
});

test('F4: the guard itself is offer-bound (domain level)', () => {
  const p = { version: 1 as const, ops: [{ op: 'accept_assumption' as const, field: 'pay.saturdayPremiumPercent' }] };
  assert.deepEqual(authorizePatch(p, saturdayOffered(), { offeredAssumption: null }), { status: 'rejected', issues: [{ code: 'assumption_not_offered', opIndex: 0, field: 'pay.saturdayPremiumPercent' }] });
  assert.equal(authorizePatch(p, saturdayOffered(), { offeredAssumption: 'pay.sundayPremiumPercent' }).status, 'rejected');
  assert.equal(authorizePatch(p, saturdayOffered(), { offeredAssumption: 'pay.saturdayPremiumPercent' }).status, 'authorized');
});

// =============================================================================================
// F5 - "I don't know" on the opening hours question must not dead-end
// =============================================================================================

test('F5 #1-#6 / #10: empty Scenario + "nie wiem" / "I don\'t know" -> no model call, no zero, no assumption, a concrete next question with fallbacks', async () => {
  const opening = await run({ message: 'hello there', locale: 'en' }, null);
  assert.equal(opening.nextQuestion?.field, 'work.hours');
  assert.deepEqual(opening.nextQuestion?.fallbackOptions, ['split_hours', 'give_range'], 'even the opening question is never empty');
  const results = [];
  for (const [message, locale] of [['nie wiem', 'pl'], ["I don't know", 'en'], ['Nie mam pojęcia.', 'pl'], ['no idea', 'en']] as const) {
    const agent = scriptedAgent([]);
    const r = await run({ message, locale }, agent);
    assert.equal(agent.calls, 0, `${message}: no model call`);
    assert.equal(r.agentStatus, 'not_needed');
    assert.deepEqual(r.scenario.work, { regularWeekdayHours: { state: 'unknown' } }, `${message}: recorded as unknown - never 0, nothing invented`);
    assert.ok(!bytes(r.scenario).includes('loonto_assumption'), `${message}: no hidden assumption`);
    assert.notEqual(r.nextQuestion?.field, 'work.hours', `${message}: not the same dead end`);
    assert.equal(r.nextQuestion?.field, 'work.regularWeekdayHours');
    assert.equal(r.nextQuestion?.reasonCode, 'user_does_not_know');
    assert.equal(r.nextQuestion?.prompt.params.hoursScope, 'weekday_regular_only', 'asks specifically about weekday REGULAR hours');
    assert.deepEqual(r.nextQuestion?.fallbackOptions, ['give_range', 'split_hours']);
    assert.ok(!('figures' in (r.evaluation ?? {})));
    results.push(r);
  }
  // PL / EN parity
  assert.deepEqual({ ...results[0], turnId: 0 }, { ...results[1], turnId: 0 });
});

test('F5 #7: repeating "nie wiem" does not loop on an empty fallback (and changes nothing)', async () => {
  let r = await run({ message: 'nie wiem', locale: 'pl' }, null);
  for (let i = 0; i < 3; i++) {
    r = await run({ scenario: r.scenario, message: 'nie wiem', locale: 'pl', conversation: r.conversation }, null);
    assert.equal(r.status, 'unchanged');
    assert.equal(r.nextQuestion?.field, 'work.regularWeekdayHours');
    assert.ok((r.nextQuestion?.fallbackOptions.length ?? 0) > 0);
  }
  // and a range moves it forward
  const range = await run({ scenario: r.scenario, message: 'between 30 and 40', locale: 'en' }, scriptedAgent([out('provide_information', [{ op: 'set_range', field: 'work.regularWeekdayHours', low: 30, high: 40 }])]));
  assert.deepEqual(range.scenario.work.regularWeekdayHours, { high: 40, low: 30, source: 'user', state: 'range' });
});

test('F5 #8 / #9: with no provider or a failing provider the opening still progresses deterministically', async () => {
  for (const agent of [null, scriptedAgent([{ status: 'provider_error' }]), scriptedAgent([{ status: 'timeout' }])]) {
    const r = await run({ message: 'nie wiem', locale: 'pl' }, agent);
    assert.equal(r.status, 'updated');
    assert.equal(r.nextQuestion?.field, 'work.regularWeekdayHours');
    if (agent) assert.equal(agent.calls, 0, 'the provider is not even needed');
  }
  // an unreadable message with a failing provider: unchanged, but the opening question still has ways forward
  const failing = scriptedAgent([{ status: 'provider_error' }]);
  const r = await run({ message: 'hmm, complicated week', locale: 'en' }, failing);
  assert.equal(failing.calls, 1);
  assert.equal(r.status, 'unchanged');
  assert.deepEqual(r.nextQuestion?.fallbackOptions, ['split_hours', 'give_range']);
});
