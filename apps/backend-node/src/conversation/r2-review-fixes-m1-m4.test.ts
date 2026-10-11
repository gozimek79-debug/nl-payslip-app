import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConversationTurn, type TurnRequest } from './conversation-turn.js';
import { guardModelPatch } from './support-guard.js';
import { analyzeMessage, parseHoursStatement, statesWeekdaySemantics, supportsHoursQuantity, unclassifiedHoursTotal } from './message-evidence.js';
import { selectNextQuestion } from './next-question.js';
import type { ConversationTurnResult } from './conversation-types.js';
import type { PatchOp } from './scenario-patch.js';
import { evaluateScenario } from '../scenario/scenario-evaluate.js';
import { toPublicEvaluation } from '../scenario/scenario-public.js';
import type { ScenarioV1 } from '../scenario/scenario-types.js';
import { canonicalJson } from '../scenario/scenario-util.js';
import { RATES_2026, known, out, readyScenario, scenario, scriptedAgent, type ScriptedAgent } from '../test-support/conversation-fixtures.js';

/**
 * Cursor re-review of the F1-F5 fixes (RAPORT-CURSOR-REREVIEW-R2-F1-F5.md): M1-M4 and m1.
 *
 * Invariant under test: a number is not a classified payroll fact until the user's PRESENT statement supports
 * both its value and its category. "Bad" models are scripted - no network, no paid call. Where a phrase is now
 * resolved deterministically (the model is not even called), a second phrase that DOES reach the model, and
 * the guard on its own, prove the post-model layer too.
 */

const run = (req: TurnRequest, agent: ScriptedAgent | null) => runConversationTurn(req, { agent, rates: RATES_2026, newId: () => 'fixed' });
const set = (field: string, value: number): PatchOp => ({ op: 'set', field, value });
const bad = (...ops: PatchOp[]) => scriptedAgent([out('provide_information', ops)]);
const codes = (r: ConversationTurnResult) => r.patchNotes.map((n) => n.code);
const hoursKeys = (s: ScenarioV1) => Object.keys(s.work).sort();
const strip = (r: ConversationTurnResult) => ({ ...r, turnId: 0 });
function noPayout(r: ConversationTurnResult, label = '') {
  assert.notEqual(r.evaluation?.status, 'computed', `${label}: no result`);
  assert.ok(!('figures' in (r.evaluation ?? {})), `${label}: no payout`);
}
const currentFor = (s: ScenarioV1) => selectNextQuestion({ scenario: s, evaluation: evaluateScenario(s, RATES_2026) });

const rateQuestion = () => ({ ...readyScenario(), pay: {} }) as ScenarioV1;
const weekdayQuestion = () => ({ ...readyScenario(), work: { regularWeekdayHours: { state: 'unknown' } } }) as ScenarioV1;
const sundayPremiumQuestion = () => ({ ...readyScenario(), work: { regularWeekdayHours: known(40), sundayHours: known(6) } }) as ScenarioV1;
/** A model that classifies everything it can: weekday 40, Saturday 8, Sunday 6, holiday 4, overtime 5. */
const inventor = () => bad(set('work.regularWeekdayHours', 40), set('work.saturdayHours', 8), set('work.sundayHours', 6), set('work.publicHolidayHours', 4), set('work.overtimeHours', 5));

// =============================================================================================
// M1 - the opening hours gap stays virtual; a later weekly total is never weekday hours
// =============================================================================================

test('M1 #1: empty Scenario + "I don\'t know" / "nie wiem" (model absent or malicious) -> no hours write, no model call, actionable fallback', async () => {
  for (const [message, locale] of [["I don't know", 'en'], ['nie wiem', 'pl']] as const) {
    for (const agent of [null, bad({ op: 'set_unknown', field: 'work.regularWeekdayHours' }, set('work.regularWeekdayHours', 0))]) {
      const r = await run({ message, locale }, agent);
      if (agent) assert.equal(agent.calls, 0, `${message}: no model call`);
      assert.equal(r.agentStatus, 'not_needed');
      assert.equal(r.status, 'unchanged');
      assert.equal(r.patchApplied, null);
      assert.deepEqual(r.scenario.work, {}, `${message}: no unknown weekday node, no zero, no category`);
      assert.equal(r.nextQuestion?.field, 'work.hours');
      assert.equal(r.nextQuestion?.answerMode, 'hours_by_category');
      assert.deepEqual(r.nextQuestion?.fallbackOptions, ['split_hours', 'give_range']);
      assert.deepEqual(r.responseHint, { code: 'user_does_not_know' });
      assert.ok(r.evaluation?.status === 'blocked' && r.evaluation.requirements.some((q) => q.field === 'work.hours'), 'the virtual hours requirement stays');
      noPayout(r, message);
    }
  }
  // a longer "don't know" reaches the model: a model set_unknown on weekday hours is a category decision -> withheld
  const agent = bad({ op: 'set_unknown', field: 'work.regularWeekdayHours' });
  const r = await run({ message: 'honestly I have no idea how many hours I do', locale: 'en' }, agent);
  assert.equal(agent.calls, 1);
  assert.deepEqual(r.scenario.work, {});
  assert.deepEqual(codes(r), ['weekday_hours_withheld']);
});

test('M1 #2: "I don\'t know" then "40 hours a week" / "40 godzin tygodniowo" with NO model -> weekday not set, one clarification (PL = EN)', async () => {
  const results = [];
  for (const [dontKnow, total, locale] of [["I don't know", '40 hours a week', 'en'], ['nie wiem', '40 godzin tygodniowo', 'pl']] as const) {
    const dk = await run({ message: dontKnow, locale }, null);
    const r = await run({ scenario: dk.scenario, message: total, locale, conversation: dk.conversation }, null);
    assert.equal(r.agentStatus, 'not_needed', `${total}: deterministic`);
    assert.deepEqual(r.scenario.work, {}, `${total}: NOT weekday hours (was: weekday 40)`);
    assert.equal(r.nextQuestion?.kind, 'clarify_hours_composition');
    assert.equal(r.nextQuestion?.prompt.params.statedWeeklyTotal, 40);
    assert.deepEqual(r.conversation.hoursClarification, { statedWeeklyTotal: 40 });
    noPayout(r, total);
    results.push(r);
  }
  assert.deepEqual(strip(results[0] as ConversationTurnResult), strip(results[1] as ConversationTurnResult), 'PL / EN parity');
});

test('M1 #3: "I don\'t know" then weekend-inclusive / varying totals (model absent or malicious) -> no hours category written', async () => {
  const dk = await run({ message: "I don't know", locale: 'en' }, null);
  for (const message of ['40 hours including weekends', '40 hours, shifts vary', '40 godzin łącznie z weekendami', '40 godzin, zmiany się zmieniają']) {
    for (const agent of [null, inventor()]) {
      const r = await run({ scenario: dk.scenario, message, locale: 'en', conversation: dk.conversation }, agent);
      if (agent) assert.equal(agent.calls, 0, `${message}: deterministic`);
      assert.deepEqual(hoursKeys(r.scenario), [], message);
      assert.equal(r.nextQuestion?.field, 'work.hours');
      assert.equal(r.nextQuestion?.prompt.params.statedWeeklyTotal, 40);
      noPayout(r, message);
    }
  }
  // phrasings the deterministic layer does not read reach the malicious model - every invented split is withheld
  for (const message of ["I'd say about 40 hours, including the weekends", 'roughly 40 hours, my shifts vary a lot']) {
    const agent = inventor();
    const r = await run({ scenario: dk.scenario, message, locale: 'en', conversation: dk.conversation }, agent);
    assert.equal(agent.calls, 1, message);
    assert.deepEqual(hoursKeys(r.scenario), [], `${message}: weekday, Saturday, Sunday, holiday, overtime all withheld`);
    assert.deepEqual(codes(r), ['weekday_hours_withheld', 'hours_withheld', 'hours_withheld', 'hours_withheld', 'hours_withheld']);
    assert.equal(r.nextQuestion?.field, 'work.hours');
    assert.equal(r.nextQuestion?.prompt.params.statedWeeklyTotal, 40, 'the one clarification shows the total from THIS message');
    noPayout(r, message);
  }
});

test('M1 #4: repeated "nie wiem" (2-3x) -> never a category, never zero; the fallback stays useful and non-empty', async () => {
  for (const agent of [null, bad(set('work.regularWeekdayHours', 0))]) {
    let r = await run({ message: 'nie wiem', locale: 'pl' }, agent);
    for (let i = 0; i < 3; i++) {
      r = await run({ scenario: r.scenario, message: i === 1 ? "I don't know" : 'nie wiem', locale: 'pl', conversation: r.conversation }, agent);
      assert.equal(r.status, 'unchanged');
      assert.deepEqual(r.scenario.work, {});
      assert.equal(r.nextQuestion?.field, 'work.hours');
      assert.deepEqual(r.nextQuestion?.fallbackOptions, ['split_hours', 'give_range']);
      assert.deepEqual(r.responseHint, { code: 'user_does_not_know' });
    }
    if (agent) assert.equal(agent.calls, 0);
  }
});

test('M1 #5: explicit weekday wording writes weekday hours (deterministic and through the model)', async () => {
  for (const message of ['40 hours Monday to Friday', '40 weekday regular hours', '40 godzin regularnie od poniedziałku do piątku', 'I work Monday to Friday, 40 hours', '40 godzin pon-pt']) {
    const r = await run({ message, locale: 'en' }, null);
    assert.equal(r.agentStatus, 'not_needed', message);
    assert.deepEqual(r.scenario.work, { regularWeekdayHours: { source: 'user', state: 'known', value: 40 } }, message);
  }
  const agent = bad(set('work.regularWeekdayHours', 40));
  const r = await run({ message: 'I usually do 40 hours from Monday to Friday', locale: 'en' }, agent);
  assert.equal(agent.calls, 1);
  assert.deepEqual(r.scenario.work, { regularWeekdayHours: { source: 'user', state: 'known', value: 40 } });
  assert.deepEqual(codes(r), []);
});

test('M1 #6: on a true weekday question "40" / "40 hours" / "40 weekday hours" are written; weekly totals, weekends and varying shifts are not', async () => {
  for (const message of ['40', '40 hours', '40 weekday hours', '40 godzin']) {
    const agent = inventor();
    const r = await run({ scenario: weekdayQuestion(), message, locale: 'en' }, agent);
    assert.equal(agent.calls, 0, message);
    assert.deepEqual(r.scenario.work, { regularWeekdayHours: { source: 'user', state: 'known', value: 40 } }, message);
  }
  for (const message of ['40 hours a week', '40 hours including weekends', '40 hours, shifts vary', '40 godzin tygodniowo', '40 godzin łącznie z weekendami']) {
    for (const agent of [null, inventor()]) {
      const r = await run({ scenario: weekdayQuestion(), message, locale: 'en' }, agent);
      if (agent) assert.equal(agent.calls, 0, `${message}: deterministic`);
      assert.deepEqual(r.scenario.work, { regularWeekdayHours: { state: 'unknown' } }, `${message}: not committed by the question context (was: weekday 40)`);
      assert.deepEqual(r.responseHint, { code: 'answer_not_applied', params: { reason: 'weekly_total_not_category' } });
      assert.equal(r.nextQuestion?.field, 'work.regularWeekdayHours');
      noPayout(r, message);
    }
  }
  // the old blanket exemption is gone for the model too
  const agent = inventor();
  const r = await run({ scenario: weekdayQuestion(), message: "I'd say 40 hours, including the weekends", locale: 'en' }, agent);
  assert.equal(agent.calls, 1);
  assert.deepEqual(r.scenario.work, { regularWeekdayHours: { state: 'unknown' } });
});

test('M1 #7: full multi-turn flow with no model, EN and PL - nothing classified until the user says it; same result as a direct R1 evaluation', async () => {
  const flows = [
    { locale: 'en' as const, messages: ["I don't know", '40 hours a week', 'yes', '40 hours Monday to Friday', '16.80', 'yes', "I don't know", 'yes'] },
    { locale: 'pl' as const, messages: ['nie wiem', '40 godzin tygodniowo', 'tak', '40 godzin od poniedziałku do piątku', '16,80', 'tak', 'nie wiem', 'tak'] },
  ];
  const finals: ConversationTurnResult[] = [];
  for (const { locale, messages } of flows) {
    let r: ConversationTurnResult | null = null;
    const trail: string[] = [];
    for (const message of messages) {
      r = await run({ ...(r ? { scenario: r.scenario, conversation: r.conversation } : {}), message, locale }, null);
      assert.equal(r.agentStatus, 'not_needed', `${locale} "${message}"`);
      trail.push(`${r.nextQuestion?.field ?? 'done'}:${JSON.stringify(r.scenario.work)}`);
    }
    assert.deepEqual(trail, [
      'work.hours:{}',
      'work.hours:{}',
      'work.hours:{}', // "yes" to the clarification writes nothing (M2)
      'pay.hourlyRate:{"regularWeekdayHours":{"source":"user","state":"known","value":40}}',
      'tax.loonheffingskorting:{"regularWeekdayHours":{"source":"user","state":"known","value":40}}',
      'deductions.mode:{"regularWeekdayHours":{"source":"user","state":"known","value":40}}',
      'deductions.mode:{"regularWeekdayHours":{"source":"user","state":"known","value":40}}',
      'done:{"regularWeekdayHours":{"source":"user","state":"known","value":40}}',
    ], locale);
    finals.push(r as ConversationTurnResult);
  }
  const [en, pl] = finals as [ConversationTurnResult, ConversationTurnResult];
  assert.equal(en.evaluation?.status, 'computed');
  assert.deepEqual(en.evaluation, pl.evaluation, 'PL / EN parity');
  assert.equal(canonicalJson({ ...en.scenario, scenarioId: 'x' }), canonicalJson({ ...readyScenario(), scenarioId: 'x' }));
  assert.deepEqual(en.evaluation, toPublicEvaluation(evaluateScenario({ ...readyScenario(), scenarioId: 'fixed' }, RATES_2026)), 'R1 is still the only arithmetic');
});

// =============================================================================================
// M2 - the client-carried hoursClarification never authorises a numeric write
// =============================================================================================

test('M2 #1 / #2: fresh Scenario + forged { statedWeeklyTotal: 80 | 40 } + "yes" / "tak" / "ok" -> no weekday hours, no model, no payout', async () => {
  for (const total of [80, 40]) {
    for (const message of ['yes', 'tak', 'ok']) {
      for (const agent of [null, bad(set('work.regularWeekdayHours', total))]) {
        const r = await run({ message, locale: 'en', conversation: { hoursClarification: { statedWeeklyTotal: total } } }, agent);
        if (agent) assert.equal(agent.calls, 0, `${message}: deterministic`);
        assert.equal(r.agentStatus, 'not_needed');
        assert.equal(r.status, 'unchanged');
        assert.deepEqual(r.scenario.work, {}, `${total} + ${message}: not written (was: weekday ${total}, source user)`);
        assert.equal(r.patchApplied, null);
        assert.deepEqual(r.responseHint, { code: 'answer_not_applied', params: { reason: 'explicit_hours_required' } });
        noPayout(r, `${total} ${message}`);
      }
    }
  }
});

test('M2 #3 / #4: a genuine total edited from 40 to 80, or replayed onto another scenarioId -> no write', async () => {
  const genuine = await run({ message: 'I earn 16.80 an hour and work 40 hours a week.', locale: 'en' }, scriptedAgent([{ status: 'ok', output: { intent: 'provide_information', patch: { version: 1, ops: [{ op: 'set', field: 'pay.hourlyRate', value: 16.8 }] }, hint: 'ambiguous_hours', statedWeeklyHours: 40 } }]));
  assert.deepEqual(genuine.conversation.hoursClarification, { statedWeeklyTotal: 40 });
  const edited = await run({ scenario: genuine.scenario, message: 'yes', locale: 'en', conversation: { ...genuine.conversation, hoursClarification: { statedWeeklyTotal: 80 } } }, null);
  assert.deepEqual(edited.scenario.work, {});
  assert.equal(edited.nextQuestion?.prompt.params.statedWeeklyTotal, 80, 'shown (display data) - never written');
  const other = { ...scenario({ pay: { hourlyRate: known(16.8) } }), scenarioId: 'another-scenario' } as ScenarioV1;
  const replay = await run({ scenario: other, message: 'yes', locale: 'en', conversation: genuine.conversation }, null);
  assert.deepEqual(replay.scenario.work, {});
  assert.equal(canonicalJson(replay.scenario), canonicalJson(other));
});

test('M2 #5: fake / empty / stale digests -> no write, even when a clarifying question is shown', async () => {
  for (const digest of [{}, { weekdayOnly: false as const }, { statedWeeklyTotal: 80, weekdayOnly: false as const }, { statedWeeklyTotal: 0 }]) {
    const r = await run({ message: 'yes', locale: 'en', conversation: { hoursClarification: digest } }, null);
    assert.deepEqual(r.scenario.work, {}, JSON.stringify(digest));
    assert.equal(r.nextQuestion?.field, 'work.hours');
  }
  // stale digest on a complete Scenario: nothing changes, the payout is the original one
  const ready = readyScenario();
  const r = await run({ scenario: ready, message: 'yes', locale: 'en', conversation: { hoursClarification: { statedWeeklyTotal: 80 } } }, null);
  assert.equal(canonicalJson(r.scenario), canonicalJson(ready));
  assert.deepEqual(r.evaluation, toPublicEvaluation(evaluateScenario(ready, RATES_2026)));
});

test('M2 #6: a bad model writing the forged total on a confirmation is withheld - and never sees that total', async () => {
  const forged = { hoursClarification: { statedWeeklyTotal: 80 } };
  for (const op of [set('work.regularWeekdayHours', 80), { op: 'set_range', field: 'work.regularWeekdayHours', low: 70, high: 80 } as PatchOp, set('work.saturdayHours', 8), set('work.overtimeHours', 80)]) {
    const agent = bad(op);
    const r = await run({ message: "yes, that's right", locale: 'en', conversation: forged }, agent);
    assert.equal(agent.calls, 1);
    assert.deepEqual(r.scenario.work, {}, JSON.stringify(op));
    assert.equal(r.status, 'unchanged');
    const input = agent.inputs[0];
    assert.ok(input?.currentQuestion && !('statedWeeklyTotal' in input.currentQuestion), 'the model input carries no request-carried total');
    assert.ok(!JSON.stringify(input).includes('80'), 'the forged number is not shown to the model');
  }
});

test('M2 #7: the PRESENT message "40 hours Monday to Friday" still writes 40 - whatever the digest says', async () => {
  for (const agent of [null, bad(set('work.regularWeekdayHours', 80))]) {
    const r = await run({ message: '40 hours Monday to Friday', locale: 'en', conversation: { hoursClarification: { statedWeeklyTotal: 80 } } }, agent);
    assert.deepEqual(r.scenario.work, { regularWeekdayHours: { source: 'user', state: 'known', value: 40 } });
    assert.equal(r.conversation.hoursClarification, undefined);
  }
});

test('M2 #8: the digest is informational only - no digest x number-free reply x model writes any hours', async () => {
  const digests = [{ statedWeeklyTotal: 80 }, { statedWeeklyTotal: 40 }, { statedWeeklyTotal: 40, weekdayOnly: false as const }, {}];
  const replies = ['yes', 'tak', 'ok', 'sure', 'yes please', 'correct', 'that is right', 'zgadza się', 'dokładnie tak', 'yes, all of them are regular hours'];
  for (const hoursClarification of digests) {
    for (const message of replies) {
      for (const make of [() => null, () => bad(set('work.regularWeekdayHours', 80)), () => bad(set('work.regularWeekdayHours', 40), set('work.saturdayHours', 8))]) {
        const r = await run({ message, locale: 'en', conversation: { hoursClarification } }, make());
        assert.deepEqual(r.scenario.work, {}, `${JSON.stringify(hoursClarification)} + "${message}"`);
      }
    }
  }
});

// =============================================================================================
// M3 - a known unit contradiction survives the model fallthrough
// =============================================================================================

async function contradiction(s: ScenarioV1, message: string, op: PatchOp, reason = 'unit_mismatch') {
  const agent = bad(op);
  const r = await run({ scenario: s, message, locale: 'en' }, agent);
  assert.equal(agent.calls, 0, `${message}: no model call on a known contradiction`);
  assert.equal(r.status, 'unchanged');
  assert.equal(canonicalJson(r.scenario), canonicalJson(s), `${message}: zero mutation`);
  assert.deepEqual(r.responseHint, { code: 'answer_not_applied', params: { reason } });
  assert.deepEqual(r.nextQuestion, currentFor(s), `${message}: the same question stays`);
  noPayout(r, message);
  // the post-model guard on its own (deterministic layer bypassed) withholds the same op
  const guarded = guardModelPatch({ version: 1, ops: [op] }, message, currentFor(s));
  assert.deepEqual(guarded.patch.ops, [], `${message}: guard alone`);
  assert.deepEqual(guarded.notes.map((n) => n.code), ['unit_mismatch_withheld']);
  return r;
}

test('M3 #1: rate question + "40 hours" + bad model rate 40 -> no rate, no payout (was: rate 40, payout 1022.45)', async () => {
  const r = await contradiction(rateQuestion(), '40 hours', set('pay.hourlyRate', 40));
  assert.equal(r.scenario.pay.hourlyRate, undefined);
});

test('M3 #2: weekday-hours question + "€16.80" + bad model weekday 16.8 -> no write (was: payout 267.22)', async () => {
  const r = await contradiction(weekdayQuestion(), '€16.80', set('work.regularWeekdayHours', 16.8));
  assert.deepEqual(r.scenario.work.regularWeekdayHours, { state: 'unknown' });
});

test('M3 #3: Sunday-premium question + "50 hours" + bad model premium 50 -> no write (was: payout 661.86)', async () => {
  const r = await contradiction(sundayPremiumQuestion(), '50 hours', set('pay.sundayPremiumPercent', 50));
  assert.equal(r.scenario.pay.sundayPremiumPercent, undefined);
});

test('M3 #4: PL equivalents', async () => {
  await contradiction(rateQuestion(), '40 godzin', set('pay.hourlyRate', 40));
  await contradiction(weekdayQuestion(), '€16,80 za godzinę', set('work.regularWeekdayHours', 16.8));
  await contradiction(weekdayQuestion(), '50 procent', set('work.regularWeekdayHours', 50));
  await contradiction(sundayPremiumQuestion(), '50 godzin', set('pay.sundayPremiumPercent', 50));
});

test('M3 #5: valid bare / dressed rates still apply to the rate question', async () => {
  const expected = toPublicEvaluation(evaluateScenario(readyScenario(), RATES_2026));
  for (const message of ['16.80', '€16.80/hour', '16,80 € za godzinę', '€16.80']) {
    const r = await run({ scenario: rateQuestion(), message, locale: 'en' }, null);
    assert.deepEqual(r.scenario.pay.hourlyRate, { source: 'user', state: 'known', value: 16.8 }, message);
    assert.deepEqual(r.evaluation, expected, `${message}: R1 result unchanged`);
  }
});

test('M3 #6: "40 hours" answers a genuine weekday question; "40 hours a week" does not', async () => {
  const yes = await run({ scenario: weekdayQuestion(), message: '40 hours', locale: 'en' }, null);
  assert.deepEqual(yes.scenario.work.regularWeekdayHours, { source: 'user', state: 'known', value: 40 });
  assert.equal(yes.evaluation?.status, 'computed');
  await contradiction(weekdayQuestion(), '40 hours a week', set('work.regularWeekdayHours', 40), 'weekly_total_not_category');
});

test('M3 #7: a mixed sentence keeps the defensible rate and invents no weekday split; a swapped model is fully withheld', async () => {
  for (const message of ['I work 40 hours and earn €16.80 per hour', '16,80 euro na godzinę i 40 godzin tygodniowo']) {
    const cases: Array<[ScriptedAgent, number | undefined]> = [
      [scriptedAgent([{ status: 'ok', output: { intent: 'provide_information', patch: { version: 1, ops: [set('pay.hourlyRate', 16.8)] }, hint: 'ambiguous_hours', statedWeeklyHours: 40 } }]), 16.8],
      [bad(set('pay.hourlyRate', 16.8), set('work.regularWeekdayHours', 40)), 16.8],
      [bad(set('pay.hourlyRate', 40), set('work.regularWeekdayHours', 16.8)), undefined],
    ];
    for (const [agent, rate] of cases) {
      const r = await run({ message, locale: 'en' }, agent);
      assert.equal(agent.calls, 1);
      assert.equal((r.scenario.pay.hourlyRate as { value?: number } | undefined)?.value, rate, message);
      assert.deepEqual(hoursKeys(r.scenario), [], `${message}: no weekday split`);
      assert.equal(r.nextQuestion?.kind, 'clarify_hours_composition');
      assert.equal(r.nextQuestion?.prompt.params.statedWeeklyTotal, 40);
      noPayout(r, message);
    }
  }
});

test('M3 #8: a mismatched op next to a legitimate one - only the supported op survives, and the authority guard still applies atomically', async () => {
  const message = 'I work 40 hours and earn €16.80 per hour';
  const laundering = bad(set('pay.sundayPremiumPercent', 40), set('pay.hourlyRate', 16.8));
  const r = await run({ message, locale: 'en' }, laundering);
  assert.equal(r.status, 'updated');
  assert.deepEqual(r.scenario.pay, { hourlyRate: { source: 'user', state: 'known', value: 16.8 } });
  assert.deepEqual(codes(r), ['unit_mismatch_withheld']);
  assert.deepEqual(r.patchApplied?.map((a) => ('field' in a ? a.field : a.op)), ['pay.hourlyRate']);
  // the remaining patch is still all-or-nothing: an illegal op left in it rejects the WHOLE patch - no partial apply
  const mixed = bad(set('pay.sundayPremiumPercent', 40), set('pay.hourlyRate', 16.8), { op: 'accept_assumption', field: 'pay.saturdayPremiumPercent' });
  const rejected = await run({ message, locale: 'en' }, mixed);
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(rejected.patchIssues.map((i) => i.code), ['assumption_not_offered']);
  assert.deepEqual(rejected.scenario.pay, {}, 'the legitimate rate is NOT partially applied');
});

test('M3: the guard alone stops a contradicted number being laundered into another field', () => {
  const current = currentFor(rateQuestion());
  for (const op of [set('pay.overtime.thresholdHoursPerDay', 40), set('extras.travelAllowance', 40), set('work.overtimeHours', 40), set('pay.sundayPremiumPercent', 40), { op: 'set_range', field: 'pay.hourlyRate', low: 40, high: 41 } as PatchOp]) {
    const g = guardModelPatch({ version: 1, ops: [op] }, '40 hours', current);
    assert.deepEqual(g.patch.ops, [], JSON.stringify(op));
    assert.deepEqual(g.notes.map((n) => n.code), ['unit_mismatch_withheld'], JSON.stringify(op));
  }
  // a fitting number is untouched by the unit rule
  assert.deepEqual(guardModelPatch({ version: 1, ops: [set('pay.hourlyRate', 16.8)] }, '€16.80', current).patch.ops, [set('pay.hourlyRate', 16.8)]);
});

// =============================================================================================
// M4 - no invented Saturday / Sunday / holiday / overtime hours
// =============================================================================================

const RATE_AND_TOTAL = 'I earn 16.80 an hour and work 40 hours a week';

test('M4 #1: "40 hours a week" + bad model Saturday 8 -> Saturday NOT stored; one composition clarification', async () => {
  const det = bad(set('work.saturdayHours', 8));
  const r = await run({ message: '40 hours a week', locale: 'en' }, det);
  assert.equal(det.calls, 0);
  assert.deepEqual(hoursKeys(r.scenario), []);
  assert.equal(r.nextQuestion?.kind, 'clarify_hours_composition');
  // the same through the model
  const agent = bad(set('pay.hourlyRate', 16.8), set('work.saturdayHours', 8));
  const viaModel = await run({ message: RATE_AND_TOTAL, locale: 'en' }, agent);
  assert.equal(agent.calls, 1);
  assert.deepEqual(hoursKeys(viaModel.scenario), [], 'was: Saturday 8, source user, and the composition question lost');
  assert.deepEqual(viaModel.scenario.pay.hourlyRate, { source: 'user', state: 'known', value: 16.8 });
  assert.deepEqual(codes(viaModel), ['hours_withheld']);
  assert.equal(viaModel.nextQuestion?.kind, 'clarify_hours_composition');
  assert.equal(viaModel.nextQuestion?.prompt.params.statedWeeklyTotal, 40);
});

test('M4 #2: "40 hours, shifts vary" + bad model overtime 5 -> overtime NOT stored', async () => {
  for (const message of ['40 hours, shifts vary', 'roughly 40 hours, my shifts vary a lot']) {
    const agent = bad(set('work.overtimeHours', 5));
    const r = await run({ message, locale: 'en' }, agent);
    assert.deepEqual(hoursKeys(r.scenario), [], message);
    assert.equal(r.nextQuestion?.field, 'work.hours');
    assert.equal(r.nextQuestion?.prompt.params.statedWeeklyTotal, 40);
  }
});

test('M4 #3: "40 hours a week" + bad model Sunday 6 / holiday 4 -> neither stored', async () => {
  for (const ops of [[set('work.sundayHours', 6)], [set('work.publicHolidayHours', 4)], [set('work.sundayHours', 6), set('work.publicHolidayHours', 4)]]) {
    const r = await run({ message: '40 hours a week', locale: 'en' }, bad(...ops));
    assert.deepEqual(hoursKeys(r.scenario), []);
    const agent = bad(set('pay.hourlyRate', 16.8), ...ops);
    const viaModel = await run({ message: RATE_AND_TOTAL, locale: 'en' }, agent);
    assert.equal(agent.calls, 1);
    assert.deepEqual(hoursKeys(viaModel.scenario), [], JSON.stringify(ops));
    assert.equal(viaModel.scenario.pay.hourlyRate !== undefined, true, 'the independent rate is kept');
  }
});

test('M4 #4: "I sometimes work Saturdays" + bad model Saturday 8 -> not stored (kind named, quantity absent)', async () => {
  for (const message of ['I sometimes work Saturdays', 'czasem pracuję w soboty']) {
    const agent = bad(set('work.saturdayHours', 8));
    const r = await run({ message, locale: 'en' }, agent);
    assert.equal(agent.calls, 1);
    assert.deepEqual(hoursKeys(r.scenario), [], message);
    assert.deepEqual(codes(r), ['hours_withheld']);
    assert.equal(r.nextQuestion?.field, 'work.hours', 'the hours question stays open');
  }
});

test('M4 #5 / #6: explicit "Saturday 8 hours", "5 overtime hours", "Sunday 6 hours", "holiday 4 hours" are stored', async () => {
  const cases: Array<[string, string, number]> = [
    ['I worked Saturday 8 hours', 'saturdayHours', 8], ['Saturday 8 hours', 'saturdayHours', 8], ['8 godzin w sobotę', 'saturdayHours', 8],
    ['I worked 5 overtime hours', 'overtimeHours', 5], ['5 overtime hours Monday to Friday', 'overtimeHours', 5], ['5 nadgodzin', 'overtimeHours', 5],
    ['Sunday 6 hours', 'sundayHours', 6], ['holiday 4 hours', 'publicHolidayHours', 4],
  ];
  for (const [message, field, value] of cases) {
    const agent = bad(set(`work.${field}`, value));
    const r = await run({ message, locale: 'en' }, agent);
    assert.equal(agent.calls, 0, `${message}: deterministic`);
    assert.deepEqual(r.scenario.work, { [field]: { source: 'user', state: 'known', value } }, message);
  }
  // through the model: kind and quantity in the same clause -> kept
  const agent = bad(set('work.saturdayHours', 8));
  const r = await run({ message: 'on Saturday I worked a long 8 hour day', locale: 'en' }, agent);
  assert.equal(agent.calls, 1);
  assert.deepEqual(r.scenario.work, { saturdayHours: { source: 'user', state: 'known', value: 8 } });
  assert.deepEqual(codes(r), []);
});

test('M4 #7: "40 hours total, including 8 Saturday" -> no guessed weekday 32; the unresolved composition stays visible until answered', async () => {
  for (const [message, agent] of [['40 hours total, including 8 Saturday', null], ['40 hours total, including 8 on Saturday', bad(set('work.saturdayHours', 8), set('work.regularWeekdayHours', 32))], ['honestly 40 hours in total, including 8 on Saturday', bad(set('work.saturdayHours', 8), set('work.regularWeekdayHours', 32))]] as const) {
    const r = await run({ message, locale: 'en' }, agent);
    assert.equal(r.scenario.work.regularWeekdayHours, undefined, `${message}: no weekday 32`);
    // Saturday 8 MAY be stored; this implementation keeps the whole message's hours uncommitted while its total is
    // unresolved, so R1 itself keeps the hours requirement open - it cannot be lost by a client dropping the digest
    assert.deepEqual(hoursKeys(r.scenario), [], message);
    assert.ok(r.evaluation?.status === 'blocked' && r.evaluation.requirements.some((q) => q.field === 'work.hours'));
    assert.equal(r.nextQuestion?.field, 'work.hours');
    assert.equal(r.nextQuestion?.reasonCode, 'hours_include_other_categories', 'asks for the split of the 40');
    assert.equal(r.nextQuestion?.prompt.params.statedWeeklyTotal, 40);
    // the explicit split resolves it
    const split = await run({ scenario: r.scenario, message: '32 hours Monday to Friday and 8 on Saturday', locale: 'en', conversation: r.conversation }, null);
    assert.deepEqual(split.scenario.work, { regularWeekdayHours: { source: 'user', state: 'known', value: 32 }, saturdayHours: { source: 'user', state: 'known', value: 8 } });
    assert.equal(split.nextQuestion?.field, 'pay.hourlyRate');
  }
});

test('M4 #8: ranges, alternatives, conflicts, set_unknown and the overtime distribution cannot bypass the bucket rule', async () => {
  const agent = bad(
    set('pay.hourlyRate', 16.8),
    { op: 'set_range', field: 'work.saturdayHours', low: 6, high: 8 },
    { op: 'set_alternatives', field: 'work.sundayHours', options: [4, 6] },
    { op: 'set_conflict', field: 'work.publicHolidayHours', candidates: [{ value: 4 }, { value: 6 }] },
    { op: 'set_unknown', field: 'work.overtimeHours' },
    { op: 'set', field: 'work.overtimeDistribution', value: { kind: 'even', days: 5 } },
  );
  const r = await run({ message: RATE_AND_TOTAL, locale: 'en' }, agent);
  assert.equal(r.status, 'updated');
  assert.deepEqual(hoursKeys(r.scenario), []);
  assert.deepEqual(r.scenario.pay, { hourlyRate: { source: 'user', state: 'known', value: 16.8 } });
  assert.deepEqual(codes(r), ['hours_withheld', 'hours_withheld', 'hours_withheld', 'hours_withheld', 'hours_withheld']);
  // overtime stated, distribution not described -> the distribution is asked, not invented
  const ot = await run({ message: 'I did 5 overtime hours this week I think', locale: 'en' }, bad(set('work.overtimeHours', 5), { op: 'set', field: 'work.overtimeDistribution', value: { kind: 'even', days: 5 } }));
  assert.deepEqual(ot.scenario.work, { overtimeHours: { source: 'user', state: 'known', value: 5 } });
  assert.deepEqual(codes(ot), ['hours_withheld']);
  // ... and kept when the user describes it
  const described = await run({ message: 'I did 5 overtime hours this week, 1 each day', locale: 'en' }, bad(set('work.overtimeHours', 5), { op: 'set', field: 'work.overtimeDistribution', value: { kind: 'even', days: 5 } }));
  assert.deepEqual(described.scenario.work.overtimeDistribution, { source: 'user', state: 'known', value: { days: 5, kind: 'even' } });
});

// =============================================================================================
// m1 - negated weekday wording
// =============================================================================================

test('m1: a denied weekday is never weekday evidence (domain)', () => {
  for (const affirmative of ['40 hours Monday to Friday', 'weekdays', 'w dni robocze', 'od poniedziałku do piątku', 'No, 40 hours Monday to Friday', '40 hours Monday to Friday, no weekends']) assert.ok(statesWeekdaySemantics(affirmative), affirmative);
  for (const negated of ['40 hours, not weekdays', 'I do not work weekdays, 40 hours', '40 hours, no weekdays', '40 godzin, nie w dni robocze', "I don't work Monday to Friday", 'never on weekdays', 'bez dni roboczych', 'weekdays not included']) assert.ok(!statesWeekdaySemantics(negated), negated);
  // "I don't know" negates knowing, not the category
  assert.ok(statesWeekdaySemantics("I don't know my weekday hours"));
});

test('m1: negated weekday wording -> no weekday write; explicit Saturday 8 next to it -> only Saturday 8', async () => {
  for (const message of ['40 hours, not weekdays', 'I do not work weekdays, 40 hours', '40 hours, no weekdays', '40 godzin, nie w dni robocze', 'honestly I do not work weekdays, 40 hours']) {
    const agent = bad(set('work.regularWeekdayHours', 40));
    const r = await run({ message, locale: 'en' }, agent);
    assert.equal(r.scenario.work.regularWeekdayHours, undefined, `${message} (was: weekday 40)`);
    assert.equal(r.nextQuestion?.field, 'work.hours');
  }
  const positive = await run({ message: '40 hours Monday to Friday', locale: 'en' }, bad(set('work.regularWeekdayHours', 40)));
  assert.deepEqual(positive.scenario.work.regularWeekdayHours, { source: 'user', state: 'known', value: 40 });
  for (const message of ["I don't work weekdays, only 8 hours on Saturday", "honestly I don't work weekdays, only 8 hours on Saturday"]) {
    const r = await run({ message, locale: 'en' }, bad(set('work.saturdayHours', 8), set('work.regularWeekdayHours', 8)));
    assert.deepEqual(r.scenario.work, { saturdayHours: { source: 'user', state: 'known', value: 8 } }, message);
  }
});

// =============================================================================================
// Evidence layer (domain)
// =============================================================================================

test('evidence: hours statements are classified only by the user\'s own words', () => {
  assert.deepEqual(parseHoursStatement('40 hours a week'), { kind: 'total', total: 40, otherCategories: false });
  assert.deepEqual(parseHoursStatement('40 hours including weekends'), { kind: 'total', total: 40, otherCategories: true });
  assert.deepEqual(parseHoursStatement('40 hours total, including 8 Saturday'), { kind: 'total', total: 40, otherCategories: true });
  assert.deepEqual(parseHoursStatement('32 hours Monday to Friday and 8 on Saturday'), { kind: 'categorized', values: [{ field: 'work.regularWeekdayHours', value: 32, high: null }, { field: 'work.saturdayHours', value: 8, high: null }] });
  assert.deepEqual(parseHoursStatement('between 30 and 40 hours Monday to Friday'), { kind: 'categorized', values: [{ field: 'work.regularWeekdayHours', value: 30, high: 40 }] });
  for (const other of ['I sometimes work Saturdays', 'I earn 16.80 an hour', '8 hours on the weekend', 'I work 8 hours a day', '40', 'between 30 and 40', 'Saturday premium 50%', 'yes']) assert.equal(parseHoursStatement(other), null, other);
  const e = analyzeMessage('I earn 16.80 an hour and work 40 hours a week');
  assert.equal(unclassifiedHoursTotal(e), 40);
  assert.ok(!supportsHoursQuantity(e, 'weekday', 40, null));
  assert.ok(supportsHoursQuantity(analyzeMessage('I worked 8 hours on Saturday and 32 on weekdays'), 'saturday', 8, null));
  assert.ok(supportsHoursQuantity(analyzeMessage('I worked 8 hours on Saturday and 32 on weekdays'), 'weekday', 32, null));
  assert.ok(!supportsHoursQuantity(analyzeMessage('I worked 8 hours on Saturday and 32 on weekdays'), 'saturday', 32, null), 'a number belongs to its own clause');
  assert.ok(!supportsHoursQuantity(analyzeMessage('Saturday premium 50%'), 'saturday', 50, null), 'a percentage is not hours');
});

// =============================================================================================
// Regression: ordinary entry still works and R1 still does all the arithmetic
// =============================================================================================

test('regression: hours, weekend hours, rate and assumption acceptance still lead to the R1 result (no model)', async () => {
  const steps = ['32 hours Monday to Friday and 8 on Saturday', '16,80', 'nie wiem', 'tak', 'tak', 'nie wiem', 'tak'];
  let r: ConversationTurnResult | null = null;
  for (const message of steps) {
    r = await run({ ...(r ? { scenario: r.scenario, conversation: r.conversation } : {}), message, locale: 'pl' }, null);
    assert.notEqual(r.status, 'rejected', message);
  }
  const final = r as ConversationTurnResult;
  assert.equal(final.evaluation?.status, 'computed');
  const expected = scenario({
    work: { regularWeekdayHours: known(32), saturdayHours: known(8) },
    pay: { hourlyRate: known(16.8), saturdayPremiumPercent: known(50, 'loonto_assumption') },
    tax: { loonheffingskorting: known('applied') },
    deductions: { mode: known('estimate', 'loonto_assumption') },
  });
  assert.equal(canonicalJson({ ...final.scenario, scenarioId: 'x' }), canonicalJson({ ...expected, scenarioId: 'x' }));
  assert.deepEqual(final.evaluation, toPublicEvaluation(evaluateScenario({ ...expected, scenarioId: 'fixed' }, RATES_2026)));
  // a compliant model with a fully explicit sentence: every stated value kept
  const agent = bad(set('pay.hourlyRate', 16.8), set('work.regularWeekdayHours', 32), set('work.saturdayHours', 8));
  const once = await run({ message: 'I earn 16.80 an hour, I work 32 hours Monday to Friday and 8 hours on Saturday', locale: 'en' }, agent);
  assert.equal(agent.calls, 1);
  assert.deepEqual(codes(once), []);
  assert.deepEqual(hoursKeys(once.scenario), ['regularWeekdayHours', 'saturdayHours']);
});
