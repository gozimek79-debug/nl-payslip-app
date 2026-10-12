import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConversationTurn, type TurnRequest } from './conversation-turn.js';
import { guardModelPatch } from './support-guard.js';
import { analyzeMessage, parseHoursStatement } from './message-evidence.js';
import { selectNextQuestion } from './next-question.js';
import type { ConversationTurnResult } from './conversation-types.js';
import type { PatchOp } from './scenario-patch.js';
import { evaluateScenario } from '../scenario/scenario-evaluate.js';
import type { ScenarioV1 } from '../scenario/scenario-types.js';
import { canonicalJson } from '../scenario/scenario-util.js';
import { RATES_2026, known, out, readyScenario, scenario, scriptedAgent, type ScriptedAgent } from '../test-support/conversation-fixtures.js';

/**
 * Cursor re-review of R2 fix iteration 2 (RAPORT-CURSOR-REREVIEW-R2-FIX-ITERATION-2.md): I1 and I2.
 *   I1 - "świetnie" ("great") was holiday evidence: "40 godzin świetnie" stored 40 public-holiday hours.
 *   I2 - after "40 hours thanks" to the hourly-rate question a bad model could write a DIFFERENT number
 *        (rate 99, payout 2055.43): only the stated, contradicted 40 was withheld.
 * Scripted models only - no network, no paid call.
 */

const run = (req: TurnRequest, agent: ScriptedAgent | null) => runConversationTurn(req, { agent, rates: RATES_2026, newId: () => 'fixed' });
const set = (field: string, value: number): PatchOp => ({ op: 'set', field, value });
const bad = (...ops: PatchOp[]) => scriptedAgent([out('provide_information', ops)]);
const codes = (r: ConversationTurnResult) => r.patchNotes.map((n) => n.code);
const currentFor = (s: ScenarioV1) => selectNextQuestion({ scenario: s, evaluation: evaluateScenario(s, RATES_2026) });
const categories = (message: string) => analyzeMessage(message).categories.map((m) => `${m.negated ? '!' : ''}${m.category}`);
function noPayout(r: ConversationTurnResult, label: string) {
  assert.notEqual(r.evaluation?.status, 'computed', `${label}: no result`);
  assert.ok(!('figures' in (r.evaluation ?? {})), `${label}: no payout`);
}

const rateQuestion = () => ({ ...readyScenario(), pay: {} }) as ScenarioV1;
const sundayPremiumQuestion = () => ({ ...readyScenario(), work: { regularWeekdayHours: known(40), sundayHours: known(6) } }) as ScenarioV1;
const saturdayPremiumQuestion = () => ({ ...readyScenario(), work: { regularWeekdayHours: known(32), saturdayHours: known(8) } }) as ScenarioV1;
const weekdayQuestion = () => ({ ...readyScenario(), work: { regularWeekdayHours: { state: 'unknown' } } }) as ScenarioV1;
const saturdayHoursQuestion = () => ({ ...readyScenario(), work: { regularWeekdayHours: known(32), saturdayHours: { state: 'unknown' } } }) as ScenarioV1;

// =============================================================================================
// I1 - Polish holiday evidence
// =============================================================================================

test('I1 domain: "świetnie / świetny / świetna" are not holiday words; the forms of "święto" and "świąteczny" are', () => {
  for (const great of ['40 godzin świetnie', 'świetny tydzień', 'świetna praca', 'świetne', 'świetnego dnia', 'Świetnie!']) assert.deepEqual(categories(great), [], great);
  for (const holiday of ['w święto', 'w święta', 'po świętach', 'przed świętami', 'święto państwowe', 'pracy świątecznej', 'dni świąteczne', 'public holiday', 'on a holiday', 'feestdag']) assert.deepEqual(categories(holiday), ['holiday'], holiday);
  assert.deepEqual(categories('nie pracowałem w święto'), ['!holiday']);
});

test('I1 #1-#3 / #7: "40 godzin świetnie", "40 godzin, świetnie", "świetna praca, 8 godzin" -> no public-holiday hours, no invented category (model absent or bad)', async () => {
  for (const [message, value] of [['40 godzin świetnie', 40], ['40 godzin, świetnie', 40], ['świetna praca, 8 godzin', 8]] as const) {
    assert.equal(parseHoursStatement(message), null, `${message}: not an hours statement the deterministic layer classifies`);
    const none = await run({ message, locale: 'pl' }, null);
    assert.deepEqual(none.scenario.work, {}, `${message} (no model; was: publicHolidayHours ${value}, source user)`);
    const agent = bad(set('work.publicHolidayHours', value));
    const r = await run({ message, locale: 'pl' }, agent);
    assert.equal(agent.calls, 1);
    assert.deepEqual(r.scenario.work, {}, `${message}: the bad model's holiday ${value} is withheld before application`);
    assert.deepEqual(codes(r), ['hours_withheld']);
    assert.equal(r.nextQuestion?.field, 'work.hours', 'the hours question stays open');
    assert.equal(r.nextQuestion?.prompt.params.statedWeeklyTotal, value);
    noPayout(r, message);
    // the guard on its own
    assert.deepEqual(guardModelPatch({ version: 1, ops: [set('work.publicHolidayHours', value)] }, message, currentFor(scenario())).patch.ops, []);
  }
});

test('I1 #4 / #5: genuine holiday wording still records holiday hours', async () => {
  for (const message of ['8 godzin w święto', '8 godzin w święta', 'w święto 8 godzin', 'holiday 4 hours', '4 uur feestdag']) {
    const agent = bad(set('work.publicHolidayHours', 99));
    const r = await run({ message, locale: 'pl' }, agent);
    assert.equal(agent.calls, 0, `${message}: deterministic`);
    const expected = message.startsWith('holiday') || message.startsWith('4') ? 4 : 8;
    assert.deepEqual(r.scenario.work, { publicHolidayHours: { source: 'user', state: 'known', value: expected } }, message);
  }
  // "pracy świątecznej" is holiday evidence; the word "pracy" is outside the short deterministic grammar, so it is
  // read by the model - and the guard keeps the supported holiday 8. With no model nothing (and no wrong field) is written.
  const message = '8 godzin pracy świątecznej';
  assert.equal(parseHoursStatement(message), null);
  assert.deepEqual((await run({ message, locale: 'pl' }, null)).scenario.work, {});
  const viaModel = await run({ message, locale: 'pl' }, bad(set('work.publicHolidayHours', 8)));
  assert.deepEqual(viaModel.scenario.work, { publicHolidayHours: { source: 'user', state: 'known', value: 8 } });
  assert.deepEqual(codes(viaModel), []);
});

test('I1 #6: a denied holiday is never positive holiday hours', async () => {
  for (const message of ['nie pracowałem w święto', 'nie pracowałem w święto, tylko 8 godzin', 'bez świąt i bez świetnych zmian']) {
    const r = await run({ message, locale: 'pl' }, bad(set('work.publicHolidayHours', 8)));
    assert.equal(r.scenario.work.publicHolidayHours, undefined, message);
  }
});

test('I1 #8: weekday, Saturday, Sunday and overtime phrases are unchanged', async () => {
  const cases: Array<[string, Record<string, number>]> = [
    ['40 godzin od poniedziałku do piątku', { regularWeekdayHours: 40 }], ['40 hours Monday to Friday', { regularWeekdayHours: 40 }],
    ['8 godzin w sobotę', { saturdayHours: 8 }], ['Sunday 6 hours', { sundayHours: 6 }], ['6 godzin w niedzielę', { sundayHours: 6 }],
    ['5 nadgodzin', { overtimeHours: 5 }], ['32 hours Monday to Friday and 8 on Saturday', { regularWeekdayHours: 32, saturdayHours: 8 }],
  ];
  for (const [message, expected] of cases) {
    const r = await run({ message, locale: 'pl' }, null);
    assert.deepEqual(r.scenario.work, Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, { source: 'user', state: 'known', value: v }])), message);
  }
});

// =============================================================================================
// I2 - a model cannot supply a number of its own
// =============================================================================================

test('I2 #1-#3: rate question + "40 hours thanks" - a bad model writing rate 40, 99 or 16.80 is withheld; no payout', async () => {
  const cases: Array<[number, string]> = [[40, 'unit_mismatch_withheld'], [99, 'value_not_stated_withheld'], [16.8, 'value_not_stated_withheld']];
  for (const message of ['40 hours thanks', '40 godzin, dzięki', 'it is 40 hours, thank you']) {
    for (const [value, note] of cases) {
      const agent = bad(set('pay.hourlyRate', value));
      const r = await run({ scenario: rateQuestion(), message, locale: 'en' }, agent);
      assert.equal(agent.calls, 1, message);
      assert.equal(r.status, 'unchanged');
      assert.equal(r.scenario.pay.hourlyRate, undefined, `${message} + rate ${value} (was: applied, rate 99 paid 2055.43)`);
      assert.equal(canonicalJson(r.scenario), canonicalJson(rateQuestion()), 'zero mutation');
      assert.deepEqual(codes(r), [note], `${message} + ${value}`);
      assert.equal(r.nextQuestion?.field, 'pay.hourlyRate', 'the same question is asked again');
      noPayout(r, `${message} + ${value}`);
    }
  }
});

test('I2 #4: "40 hours" on the rate question stays deterministic - zero model calls, no rate', async () => {
  const agent = bad(set('pay.hourlyRate', 99));
  const r = await run({ scenario: rateQuestion(), message: '40 hours', locale: 'en' }, agent);
  assert.equal(agent.calls, 0);
  assert.equal(r.scenario.pay.hourlyRate, undefined);
  noPayout(r, '40 hours');
});

test('I2 #5: "I earn €16.80 per hour and work 40 hours a week" - the stated rate is applied, a guessed weekday 40 is not', async () => {
  const message = 'I earn €16.80 per hour and work 40 hours a week.';
  // opening question: one composition clarification for the unclassified 40
  const fresh = await run({ message, locale: 'en' }, bad(set('pay.hourlyRate', 16.8), set('work.regularWeekdayHours', 40)));
  assert.deepEqual(fresh.scenario.pay.hourlyRate, { source: 'user', state: 'known', value: 16.8 });
  assert.deepEqual(fresh.scenario.work, {});
  assert.deepEqual(codes(fresh), ['weekday_hours_withheld']);
  assert.equal(fresh.nextQuestion?.kind, 'clarify_hours_composition');
  assert.equal(fresh.nextQuestion?.prompt.params.statedWeeklyTotal, 40);
  // a real rate question (hours already known as 32): the rate is applied, the guessed 40 does not replace 32
  const asked = { ...rateQuestion(), work: { regularWeekdayHours: known(32) } } as ScenarioV1;
  const r = await run({ scenario: asked, message, locale: 'en' }, bad(set('pay.hourlyRate', 16.8), set('work.regularWeekdayHours', 40)));
  assert.deepEqual(r.scenario.pay.hourlyRate, { source: 'user', state: 'known', value: 16.8 });
  assert.deepEqual(r.scenario.work, { regularWeekdayHours: { source: 'user', state: 'known', value: 32 } });
  assert.deepEqual(codes(r), ['weekday_hours_withheld']);
});

test('I2 #6: valid rate answers still apply ("€16.80 per hour", "16.80", and through the model)', async () => {
  for (const message of ['€16.80 per hour', '16.80', '16,80', '€16.80/hour']) {
    const r = await run({ scenario: rateQuestion(), message, locale: 'en' }, null);
    assert.deepEqual(r.scenario.pay.hourlyRate, { source: 'user', state: 'known', value: 16.8 }, message);
    assert.equal(r.evaluation?.status, 'computed');
  }
  const r = await run({ scenario: rateQuestion(), message: 'my rate is €16.80 per hour now', locale: 'en' }, bad(set('pay.hourlyRate', 16.8)));
  assert.deepEqual(r.scenario.pay.hourlyRate, { source: 'user', state: 'known', value: 16.8 });
  assert.deepEqual(codes(r), []);
});

test('I2 #7: a percent or hours question with one contradictory unit - a different model number for the field is withheld', async () => {
  const sunday = await run({ scenario: sundayPremiumQuestion(), message: '50 hours thanks', locale: 'en' }, bad(set('pay.sundayPremiumPercent', 75)));
  assert.equal(sunday.scenario.pay.sundayPremiumPercent, undefined, 'was: Sunday premium 75, payout 675.36');
  noPayout(sunday, 'sunday');
  const hours = await run({ scenario: weekdayQuestion(), message: '€16.80 thanks', locale: 'en' }, bad(set('work.regularWeekdayHours', 38)));
  assert.deepEqual(hours.scenario.work.regularWeekdayHours, { state: 'unknown' });
  const hoursSame = await run({ scenario: weekdayQuestion(), message: '€16.80 thanks', locale: 'en' }, bad(set('work.regularWeekdayHours', 16.8)));
  assert.deepEqual(hoursSame.scenario.work.regularWeekdayHours, { state: 'unknown' });
  // the contradicted number is not laundered into a field whose unit it happens to fit ("8 hours" -> overtime threshold 8)
  const laundered = await run({ scenario: rateQuestion(), message: '8 hours thanks', locale: 'en' }, bad(set('pay.overtime.thresholdHoursPerDay', 8)));
  assert.equal(laundered.scenario.pay.overtime, undefined);
  assert.deepEqual(codes(laundered), ['unit_mismatch_withheld']);
});

test('I2 #8: a bare contextual "8" on a real Saturday-hours question still records Saturday 8', async () => {
  const agent = bad(set('work.saturdayHours', 99));
  const r = await run({ scenario: saturdayHoursQuestion(), message: '8', locale: 'en' }, agent);
  assert.equal(agent.calls, 0);
  assert.deepEqual(r.scenario.work.saturdayHours, { source: 'user', state: 'known', value: 8 });
});

test('I2 #9: two separately classified numbers are not rejected wholesale', async () => {
  const agent = bad(set('work.regularWeekdayHours', 40), set('pay.hourlyRate', 16.8));
  const r = await run({ message: 'I work 40 hours Monday to Friday and earn €16.80 per hour', locale: 'en' }, agent);
  assert.deepEqual(codes(r), []);
  assert.deepEqual(r.scenario.work, { regularWeekdayHours: { source: 'user', state: 'known', value: 40 } });
  assert.deepEqual(r.scenario.pay, { hourlyRate: { source: 'user', state: 'known', value: 16.8 } });
  const complete = await run({ scenario: { ...rateQuestion(), work: {} } as ScenarioV1, message: 'I work 40 hours Monday to Friday and earn €16.80 per hour', locale: 'en' }, bad(set('work.regularWeekdayHours', 40), set('pay.hourlyRate', 16.8)));
  assert.equal(complete.evaluation?.status, 'computed', 'both supported values complete the Scenario');
});

test('I2 #10: off-topic, provider failure and "nie wiem" carry no invented numbers', async () => {
  // a model that claims "provide_information" on an off-topic message cannot slip a rate in
  const sneaky = await run({ scenario: rateQuestion(), message: 'what is the capital of Peru?', locale: 'en' }, bad(set('pay.hourlyRate', 99)));
  assert.equal(sneaky.scenario.pay.hourlyRate, undefined);
  assert.deepEqual(codes(sneaky), ['value_not_stated_withheld']);
  const offTopic = await run({ scenario: rateQuestion(), message: 'what is the capital of Peru?', locale: 'en' }, scriptedAgent([out('off_topic', [set('pay.hourlyRate', 99)])]));
  assert.equal(offTopic.agentStatus, 'invalid_output');
  assert.equal(offTopic.scenario.pay.hourlyRate, undefined);
  for (const failure of [{ status: 'provider_error' as const }, { status: 'timeout' as const }, { status: 'invalid_output' as const }]) {
    const r = await run({ scenario: rateQuestion(), message: '40 hours thanks', locale: 'en' }, scriptedAgent([failure]));
    assert.equal(r.status, 'unchanged');
    assert.equal(r.scenario.pay.hourlyRate, undefined);
  }
  const dk = await run({ scenario: rateQuestion(), message: 'nie wiem', locale: 'pl' }, bad(set('pay.hourlyRate', 99)));
  assert.equal(dk.agentStatus, 'not_needed');
  assert.deepEqual(dk.scenario.pay.hourlyRate, { state: 'unknown' }, 'unknown - never a number');
});

test('I2: the model cannot do arithmetic or read number words into a rate; the documented premium convention still works', async () => {
  // a computed rate (672 / 40) or a spelled-out number is not a stated value -> withheld, the question stays
  for (const message of ['I get €672 for 40 hours', 'sixteen eighty an hour']) {
    const r = await run({ scenario: rateQuestion(), message, locale: 'en' }, bad(set('pay.hourlyRate', 16.8)));
    assert.equal(r.scenario.pay.hourlyRate, undefined, message);
    assert.deepEqual(codes(r), ['value_not_stated_withheld'], message);
  }
  // "150%" states the premium above base (50); an unrelated 75 is still the model's own number
  const kept = await run({ scenario: saturdayPremiumQuestion(), message: 'I get 150% on Saturdays', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 50)));
  assert.deepEqual(kept.scenario.pay.saturdayPremiumPercent, { source: 'user', state: 'known', value: 50 });
  const other = await run({ scenario: saturdayPremiumQuestion(), message: 'I get 150% on Saturdays', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 75)));
  assert.equal(other.scenario.pay.saturdayPremiumPercent, undefined);
  // ranges: both ends must be stated
  const range = await run({ scenario: rateQuestion(), message: 'somewhere between 16 and 17 an hour', locale: 'en' }, bad({ op: 'set_range', field: 'pay.hourlyRate', low: 16, high: 17 }));
  assert.deepEqual(range.scenario.pay.hourlyRate, { high: 17, low: 16, source: 'user', state: 'range' });
  const invented = await run({ scenario: rateQuestion(), message: 'somewhere between 16 and 17 an hour', locale: 'en' }, bad({ op: 'set_range', field: 'pay.hourlyRate', low: 16, high: 99 }));
  assert.equal(invented.scenario.pay.hourlyRate, undefined);
});

test('I2: a provenance claim is not silently filtered - the authority guard still rejects the WHOLE patch (RT-001)', async () => {
  const message = 'I earn €16.80 per hour and work 40 hours a week.';
  for (const op of [{ ...set('extras.travelAllowance', 99), source: 'document' }, { ...set('work.regularWeekdayHours', 40), source: 'cao_rule' }] as PatchOp[]) {
    const r = await run({ message, locale: 'en' }, bad(set('pay.hourlyRate', 16.8), op));
    assert.equal(r.status, 'rejected', JSON.stringify(op));
    assert.deepEqual(r.patchIssues.map((i) => i.code), ['untrusted_provenance_elevation']);
    assert.deepEqual(r.scenario.pay, {}, 'the legitimate rate beside it is not applied either');
  }
  // an explicit source "user" is not a claim - an invented value with it is still withheld
  const asUser = await run({ scenario: rateQuestion(), message: '40 hours thanks', locale: 'en' }, bad({ ...set('pay.hourlyRate', 99), source: 'user' } as PatchOp));
  assert.equal(asUser.scenario.pay.hourlyRate, undefined);
});

test('I2 domain: the guard alone withholds every unsupported number in a contradicted reply, and keeps supported ones', () => {
  const current = currentFor(rateQuestion());
  const g = guardModelPatch({ version: 1, ops: [set('pay.hourlyRate', 99), set('pay.sundayPremiumPercent', 40), set('extras.travelAllowance', 12), set('work.overtimeHours', 40), { op: 'set_conflict', field: 'pay.hourlyRate', candidates: [{ value: 16.8 }, { value: 17 }] }] }, '40 hours thanks', current);
  assert.deepEqual(g.patch.ops, []);
  assert.deepEqual(g.notes.map((n) => n.code), ['value_not_stated_withheld', 'unit_mismatch_withheld', 'value_not_stated_withheld', 'unit_mismatch_withheld', 'value_not_stated_withheld']);
  const ok = guardModelPatch({ version: 1, ops: [set('pay.hourlyRate', 16.8), { op: 'set', field: 'tax.loonheffingskorting', value: 'applied' }, { op: 'remove', field: 'extras.travelAllowance' }] }, 'I earn €16.80 per hour', current);
  assert.equal(ok.patch.ops.length, 3, 'stated numbers, choices and non-value ops pass to the authority guard');
});
