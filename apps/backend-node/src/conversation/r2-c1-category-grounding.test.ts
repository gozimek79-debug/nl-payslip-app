import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConversationTurn, type TurnRequest } from './conversation-turn.js';
import { guardModelPatch } from './support-guard.js';
import { analyzeMessage, FIELD_COMPONENT, isHoursBucket, mentionsForField } from './message-evidence.js';
import { selectNextQuestion } from './next-question.js';
import type { ConversationTurnResult } from './conversation-types.js';
import type { PatchOp } from './scenario-patch.js';
import { evaluateScenario } from '../scenario/scenario-evaluate.js';
import { toPublicEvaluation } from '../scenario/scenario-public.js';
import { SCENARIO_FIELDS, SCENARIO_FIELD_PATHS, type ScenarioFieldPath, type ScenarioV1 } from '../scenario/scenario-types.js';
import { canonicalJson, getAt } from '../scenario/scenario-util.js';
import { RATES_2026, known, out, scenario, scriptedAgent, type ScriptedAgent } from '../test-support/conversation-fixtures.js';

/**
 * C1 (RAPORT-CURSOR-FINAL-REVIEW-LOONTO-R2-I1-I2-CATEGORY-GROUNDING.md): a model wrote a number the user DID state
 * into a different pay component ("Za niedzielę 50%" -> Saturday premium 50, payout 613.76; "€50 travel" -> hourly
 * rate 50, payout 1185.15). A model value must be supported by the user's statement in value, unit AND component.
 * Every "bad model" is scripted - no network, no paid call - and every case runs against the question the server
 * itself selects for that Scenario.
 */

const run = (req: TurnRequest, agent: ScriptedAgent | null) => runConversationTurn(req, { agent, rates: RATES_2026, newId: () => 'fixed' });
const set = (field: string, value: number): PatchOp => ({ op: 'set', field, value });
const bad = (...ops: PatchOp[]) => scriptedAgent([out('provide_information', ops)]);
const codes = (r: ConversationTurnResult) => r.patchNotes.map((n) => n.code);
const valueAt = (s: ScenarioV1, field: string) => (getAt(s, field) as { value?: unknown } | undefined)?.value;
const asked = (s: ScenarioV1) => selectNextQuestion({ scenario: s, evaluation: evaluateScenario(s, RATES_2026) });

/** 16.80/h, tax credit applied, deductions estimate; hours and any extra pay given. */
const base = (work: Record<string, unknown>, pay: Record<string, unknown> = {}, extras?: Record<string, unknown>) =>
  scenario({ work, pay: { hourlyRate: known(16.8), ...pay }, tax: { loonheffingskorting: known('applied') }, deductions: { mode: known('estimate', 'loonto_assumption') }, ...(extras ? { extras } : {}) });
const Q = {
  saturdayPremium: () => base({ regularWeekdayHours: known(32), saturdayHours: known(8) }),
  sundayPremium: () => base({ regularWeekdayHours: known(40), sundayHours: known(6) }),
  holidayPremium: () => base({ regularWeekdayHours: known(36), publicHolidayHours: known(4) }),
  bothPremiums: () => base({ regularWeekdayHours: known(32), saturdayHours: known(8), sundayHours: known(6) }),
  hourlyRate: () => scenario({ work: { regularWeekdayHours: known(40) }, tax: { loonheffingskorting: known('applied') }, deductions: { mode: known('estimate', 'loonto_assumption') } }),
  tier1: () => base({ regularWeekdayHours: known(40), overtimeHours: known(5), overtimeDistribution: known({ kind: 'even', days: 5 }) }, { overtime: { thresholdHoursPerDay: known(2) } }),
  saturdayHours: () => base({ regularWeekdayHours: known(32), saturdayHours: { state: 'unknown' } }),
  travel: () => base({ regularWeekdayHours: known(40) }, {}, { travelAllowance: { state: 'unknown' } }),
};
type QName = keyof typeof Q;

// =============================================================================================
// A. A value stated for one component is never written to another
// =============================================================================================

const WRONG: Array<[QName, string, PatchOp[], ScenarioFieldPath[]]> = [
  ['saturdayPremium', 'Za niedzielę otrzymuję dodatek 50%.', [set('pay.saturdayPremiumPercent', 50)], ['pay.saturdayPremiumPercent']],
  ['saturdayPremium', 'Za niedzielę 50%', [set('pay.saturdayPremiumPercent', 50)], ['pay.saturdayPremiumPercent']],
  ['saturdayPremium', '50%, for Sunday', [set('pay.saturdayPremiumPercent', 50)], ['pay.saturdayPremiumPercent']],
  ['sundayPremium', 'Saturday premium is 50%', [set('pay.sundayPremiumPercent', 50)], ['pay.sundayPremiumPercent']],
  ['sundayPremium', 'W święta dostaję +100%', [set('pay.sundayPremiumPercent', 100)], ['pay.sundayPremiumPercent']],
  ['holidayPremium', 'Sunday premium is 100%', [set('pay.publicHolidayPremiumPercent', 100)], ['pay.publicHolidayPremiumPercent']],
  ['sundayPremium', 'I get 150% on Saturdays', [set('pay.sundayPremiumPercent', 50)], ['pay.sundayPremiumPercent']],
  ['sundayPremium', 'Sunday premium is 100%', [set('pay.overtime.tier1Percent', 100)], ['pay.overtime.tier1Percent']],
  ['tier1', 'Sunday premium is 100%', [set('pay.overtime.tier1Percent', 100)], ['pay.overtime.tier1Percent']],
  ['tier1', 'overtime is paid 50% extra', [set('pay.overtime.tier1Percent', 50)], ['pay.overtime.tier1Percent']],
  ['hourlyRate', 'I receive €50 travel reimbursement', [set('pay.hourlyRate', 50)], ['pay.hourlyRate']],
  ['hourlyRate', 'I receive €50 travel reimbursement', [set('deductions.entered.sectorPremium', 50)], ['deductions.entered.sectorPremium']],
  ['hourlyRate', 'I receive €50 travel reimbursement', [set('deductions.entered.pension', 50)], ['deductions.entered.pension']],
  ['hourlyRate', 'My wage is €16.80', [set('extras.travelAllowance', 16.8)], ['extras.travelAllowance']],
  ['hourlyRate', 'overtime rate €25 per hour', [set('pay.hourlyRate', 25)], ['pay.hourlyRate']],
  ['bothPremiums', 'Saturday +50%, Sunday +100%', [set('pay.saturdayPremiumPercent', 100), set('pay.sundayPremiumPercent', 50)], ['pay.saturdayPremiumPercent', 'pay.sundayPremiumPercent']],
  ['bothPremiums', 'Sunday premium 50%, travel reimbursement €50', [set('pay.saturdayPremiumPercent', 50), set('pay.hourlyRate', 50)], ['pay.saturdayPremiumPercent', 'pay.hourlyRate']],
];

test('C1 A: a number stated for one pay component is withheld from every other component - on the real server question', async () => {
  for (const [qname, message, ops, withheld] of WRONG) {
    const s = Q[qname]();
    const agent = bad(...ops);
    const r = await run({ scenario: s, message, locale: 'en' }, agent);
    const label = `${qname}: "${message}" + ${ops.map((o) => ('field' in o ? o.field : o.op)).join(', ')}`;
    assert.equal(agent.calls, 1, label);
    assert.equal(r.status, 'unchanged', label);
    assert.equal(canonicalJson(r.scenario), canonicalJson(s), `${label}: zero mutation`);
    assert.deepEqual(codes(r), withheld.map(() => 'component_mismatch_withheld'), label);
    for (const field of withheld) assert.equal(valueAt(r.scenario, field), valueAt(s, field), `${label}: ${field} unchanged`);
    assert.deepEqual(r.evaluation, toPublicEvaluation(evaluateScenario({ ...s, scenarioId: 'conv-test' }, RATES_2026)), `${label}: no payout from the misassigned value`);
  }
});

test('C1 A: the exact review reproduction - Sunday 50% is not the Saturday premium (was: payout 613.76 instead of a blocked Saturday question)', async () => {
  const s = Q.saturdayPremium();
  assert.equal(asked(s)?.field, 'pay.saturdayPremiumPercent');
  const r = await run({ scenario: s, message: 'Za niedzielę otrzymuję dodatek 50%.', locale: 'pl' }, bad(set('pay.saturdayPremiumPercent', 50)));
  assert.equal(r.scenario.pay.saturdayPremiumPercent, undefined);
  assert.equal(r.evaluation?.status, 'blocked');
  assert.equal(r.nextQuestion?.field, 'pay.saturdayPremiumPercent', 'the Saturday question is asked again');
  // the named component wins: the same sentence may fill the SUNDAY premium, while the Saturday question stays open
  const named = await run({ scenario: Q.bothPremiums(), message: 'Za niedzielę otrzymuję dodatek 50%.', locale: 'pl' }, bad(set('pay.sundayPremiumPercent', 50)));
  assert.deepEqual(named.scenario.pay.sundayPremiumPercent, { source: 'user', state: 'known', value: 50 });
  assert.equal(named.scenario.pay.saturdayPremiumPercent, undefined);
  assert.equal(named.nextQuestion?.field, 'pay.saturdayPremiumPercent');
});

test('C1 A: paired values - the correct pairing is kept (also with the same number twice), a swap never computes', async () => {
  const s = Q.bothPremiums();
  const paired = await run({ scenario: s, message: 'Saturday +50%, Sunday +100%', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 50), set('pay.sundayPremiumPercent', 100)));
  assert.deepEqual(codes(paired), []);
  const expected = { ...s, pay: { ...s.pay, saturdayPremiumPercent: known(50), sundayPremiumPercent: known(100) } } as ScenarioV1;
  assert.deepEqual(paired.evaluation, toPublicEvaluation(evaluateScenario(expected, RATES_2026)), 'exactly the R1 result of the correct pair');
  assert.ok(paired.evaluation?.status === 'computed' && paired.evaluation.figures.payoutAmount === 722.8, 'the correct pair pays 722.80');
  const swapped = await run({ scenario: s, message: 'Saturday +50%, Sunday +100%', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 100), set('pay.sundayPremiumPercent', 50)));
  assert.notEqual(swapped.evaluation?.status, 'computed', 'was: payout 730.49');
  const same = await run({ scenario: s, message: 'Saturday +50%, Sunday +50%', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 50), set('pay.sundayPremiumPercent', 50)));
  assert.deepEqual(codes(same), [], 'the same number may belong to two named clauses');
  assert.equal(same.evaluation?.status, 'computed');
  for (const message of ['Za sobotę 50%, za niedzielę 100%', '50% w soboty i 100% w niedziele', 'Saturday premium 50% and Sunday premium 100%']) {
    const r = await run({ scenario: s, message, locale: 'pl' }, bad(set('pay.saturdayPremiumPercent', 50), set('pay.sundayPremiumPercent', 100)));
    assert.deepEqual(codes(r), [], message);
    const sw = await run({ scenario: s, message, locale: 'pl' }, bad(set('pay.saturdayPremiumPercent', 100), set('pay.sundayPremiumPercent', 50)));
    assert.deepEqual(codes(sw), ['component_mismatch_withheld', 'component_mismatch_withheld'], message);
  }
});

// =============================================================================================
// B. Valid contextual answers survive
// =============================================================================================

test('C1 B: bare answers to the real server question are deterministic and unchanged', async () => {
  const cases: Array<[QName, string, string, number]> = [
    ['saturdayPremium', '50%', 'pay.saturdayPremiumPercent', 50], ['sundayPremium', '50%', 'pay.sundayPremiumPercent', 50],
    ['hourlyRate', '16.80', 'pay.hourlyRate', 16.8], ['hourlyRate', '€16.80', 'pay.hourlyRate', 16.8],
    ['travel', '€50', 'extras.travelAllowance', 50], ['travel', '50', 'extras.travelAllowance', 50],
    ['saturdayHours', '8', 'work.saturdayHours', 8], ['tier1', '25%', 'pay.overtime.tier1Percent', 25],
  ];
  for (const [qname, message, field, value] of cases) {
    const agent = bad(set(field, 99));
    const r = await run({ scenario: Q[qname](), message, locale: 'en' }, agent);
    assert.equal(agent.calls, 0, `${qname} "${message}": no model`);
    assert.equal(valueAt(r.scenario, field), value, `${qname} "${message}"`);
  }
});

test('C1 B: a pure quantity with words still answers the question asked; "150% on Saturdays" fills only Saturday', async () => {
  const pure = await run({ scenario: Q.saturdayPremium(), message: '50 percent I think', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 50)));
  assert.deepEqual(pure.scenario.pay.saturdayPremiumPercent, { source: 'user', state: 'known', value: 50 });
  const convention = await run({ scenario: Q.saturdayPremium(), message: 'I get 150% on Saturdays', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 50)));
  assert.deepEqual(convention.scenario.pay.saturdayPremiumPercent, { source: 'user', state: 'known', value: 50 });
  const bare150 = await run({ scenario: Q.saturdayPremium(), message: '150% I think', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 50)));
  assert.deepEqual(bare150.scenario.pay.saturdayPremiumPercent, { source: 'user', state: 'known', value: 50 }, 'a bare 150% on the real premium question');
  // a pure quantity does NOT fill a field the server is not asking
  const other = await run({ scenario: Q.saturdayPremium(), message: '50 percent I think', locale: 'en' }, bad(set('pay.sundayPremiumPercent', 50)));
  assert.equal(other.scenario.pay.sundayPremiumPercent, undefined);
  assert.deepEqual(codes(other), ['component_mismatch_withheld']);
});

test('C1 B: mixed statements keep every correctly grounded value and withhold only the wrong ones', async () => {
  const weekdayRate = await run({ message: 'I work 40 hours Monday to Friday and earn €16.80 per hour', locale: 'en' }, bad(set('work.regularWeekdayHours', 40), set('pay.hourlyRate', 16.8)));
  assert.deepEqual(codes(weekdayRate), []);
  assert.equal(valueAt(weekdayRate.scenario, 'work.regularWeekdayHours'), 40);
  assert.equal(valueAt(weekdayRate.scenario, 'pay.hourlyRate'), 16.8);
  const s = Q.bothPremiums();
  const mixed = await run({ scenario: s, message: 'Saturday +50%, Sunday +100%, travel €12 a week', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 50), set('pay.sundayPremiumPercent', 100), set('extras.travelAllowance', 12), set('deductions.entered.pension', 12)));
  assert.deepEqual(codes(mixed), ['component_mismatch_withheld'], 'only the pension 12 is withheld');
  assert.equal(valueAt(mixed.scenario, 'pay.saturdayPremiumPercent'), 50);
  assert.equal(valueAt(mixed.scenario, 'pay.sundayPremiumPercent'), 100);
  assert.equal(valueAt(mixed.scenario, 'extras.travelAllowance'), 12);
  // "nie wiem" stays category-neutral and never a number
  const dk = await run({ scenario: Q.saturdayPremium(), message: 'nie wiem', locale: 'pl' }, bad(set('pay.saturdayPremiumPercent', 0)));
  assert.deepEqual(dk.scenario.pay.saturdayPremiumPercent, { state: 'unknown' });
  assert.equal(dk.agentStatus, 'not_needed');
});

// =============================================================================================
// C. Ambiguity, negation, tiers, holiday allowance
// =============================================================================================

test('C1 C: a named component without a number, a denied component, or an untiered overtime percent supports nothing', async () => {
  const noNumber = await run({ scenario: Q.sundayPremium(), message: 'the Sunday premium applies too', locale: 'en' }, bad(set('pay.sundayPremiumPercent', 50)));
  assert.deepEqual(codes(noNumber), ['value_not_stated_withheld']);
  for (const message of ['nie w sobotę, 50%', 'not on Saturday, 50%', 'bez soboty 50%']) {
    const r = await run({ scenario: Q.saturdayPremium(), message, locale: 'pl' }, bad(set('pay.saturdayPremiumPercent', 50)));
    assert.equal(r.scenario.pay.saturdayPremiumPercent, undefined, message);
  }
  // a component the message denies anywhere supports nothing, even where another clause names it
  for (const message of ['Saturday 50%, no wait, not Saturday', 'w sobotę 50%, a właściwie nie w sobotę']) {
    const r = await run({ scenario: Q.saturdayPremium(), message, locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 50)));
    assert.equal(r.scenario.pay.saturdayPremiumPercent, undefined, message);
  }
  const otherDay = await run({ scenario: Q.bothPremiums(), message: 'not Saturday, Sunday 50%', locale: 'en' }, bad(set('pay.saturdayPremiumPercent', 50), set('pay.sundayPremiumPercent', 50)));
  assert.equal(otherDay.scenario.pay.saturdayPremiumPercent, undefined);
  assert.equal(valueAt(otherDay.scenario, 'pay.sundayPremiumPercent'), 50);
  // tiers only when the user names the tier
  const t = Q.tier1();
  for (const [message, ops, kept] of [
    ['overtime first tier 25%', [set('pay.overtime.tier1Percent', 25)], true],
    ['tier 1 is 25%, tier 2 is 50%', [set('pay.overtime.tier1Percent', 25), set('pay.overtime.tier2Percent', 50)], true],
    ['tier 1 is 25%, tier 2 is 50%', [set('pay.overtime.tier1Percent', 50), set('pay.overtime.tier2Percent', 25)], false],
    ['pierwszy próg nadgodzin 25%', [set('pay.overtime.tier1Percent', 25)], true],
    ['overtime 50%', [set('pay.overtime.tier1Percent', 50)], false],
  ] as Array<[string, PatchOp[], boolean]>) {
    const r = await run({ scenario: t, message, locale: 'en' }, bad(...ops));
    assert.equal(codes(r).length === 0, kept, `${message}: ${JSON.stringify(codes(r))}`);
  }
});

test('C1 C: holiday ALLOWANCE (vakantiegeld) is not a public-holiday premium; I1 stays closed', () => {
  const current = asked(Q.holidayPremium());
  const allowance = guardModelPatch({ version: 1, ops: [set('pay.publicHolidayPremiumPercent', 8)] }, 'holiday pay is 8%', current);
  assert.deepEqual(allowance.notes.map((n) => n.code), ['component_mismatch_withheld']);
  const vg = guardModelPatch({ version: 1, ops: [set('extras.vakantiegeld.percent', 8)] }, 'vakantiegeld 8%', current);
  assert.equal(vg.patch.ops.length, 1);
  const great = guardModelPatch({ version: 1, ops: [set('pay.publicHolidayPremiumPercent', 100)] }, 'świetnie, 100%', current);
  assert.equal(great.patch.ops.length, 1, 'no holiday named, so a pure quantity answers the holiday question asked');
  const notAsked = guardModelPatch({ version: 1, ops: [set('pay.publicHolidayPremiumPercent', 100)] }, 'świetnie, 100%', asked(Q.sundayPremium()));
  assert.deepEqual(notAsked.notes.map((n) => n.code), ['component_mismatch_withheld'], '"świetnie" never names the holiday');
});

test('C1 C: model arithmetic and invented numbers remain withheld (I2)', async () => {
  const r = await run({ scenario: Q.hourlyRate(), message: 'I get €672 for 40 hours', locale: 'en' }, bad(set('pay.hourlyRate', 16.8)));
  assert.deepEqual(codes(r), ['value_not_stated_withheld']);
  const thanks = await run({ scenario: Q.hourlyRate(), message: '40 hours thanks', locale: 'en' }, bad(set('pay.hourlyRate', 99)));
  assert.equal(thanks.scenario.pay.hourlyRate, undefined);
});

// =============================================================================================
// Op forms, authority order, multi-turn, call count, coverage
// =============================================================================================

test('C1: every op form that can carry a number is bound to the component (set, set_range, set_alternatives, set_conflict)', () => {
  const current = asked(Q.bothPremiums());
  const message = 'Saturday premium 40-50%, Sunday +100%';
  const wrong: PatchOp[] = [
    { op: 'set_range', field: 'pay.sundayPremiumPercent', low: 40, high: 50 },
    { op: 'set_alternatives', field: 'pay.sundayPremiumPercent', options: [40, 50] },
    { op: 'set_conflict', field: 'pay.saturdayPremiumPercent', candidates: [{ value: 50 }, { value: 100 }] },
    set('pay.saturdayPremiumPercent', 100),
  ];
  for (const op of wrong) {
    const g = guardModelPatch({ version: 1, ops: [op] }, message, current);
    assert.deepEqual(g.patch.ops, [], JSON.stringify(op));
    assert.deepEqual(g.notes.map((n) => n.code), ['component_mismatch_withheld'], JSON.stringify(op));
  }
  const right = guardModelPatch({ version: 1, ops: [{ op: 'set_range', field: 'pay.saturdayPremiumPercent', low: 40, high: 50 }, set('pay.sundayPremiumPercent', 100)] }, message, current);
  assert.equal(right.patch.ops.length, 2);
});

test('C1 / RT-001: a provenance claim beside a legitimate value rejects the WHOLE patch - in either op order', async () => {
  const s = Q.bothPremiums();
  const legit = set('pay.sundayPremiumPercent', 100);
  const claim = { ...set('pay.saturdayPremiumPercent', 50), source: 'document' } as PatchOp;
  for (const ops of [[legit, claim], [claim, legit]]) {
    const r = await run({ scenario: s, message: 'Saturday +50%, Sunday +100%', locale: 'en' }, bad(...ops));
    assert.equal(r.status, 'rejected');
    assert.deepEqual(r.patchIssues.map((i) => i.code), ['untrusted_provenance_elevation']);
    assert.equal(canonicalJson(r.scenario), canonicalJson(s), 'the legitimate Sunday 100 is not partially applied');
  }
  // a forged catalogue assumption is still rejected before the model runs (F3)
  const agent = bad(legit);
  const forged = await run({ scenario: { ...s, pay: { ...s.pay, saturdayPremiumPercent: known(25, 'loonto_assumption') } } as ScenarioV1, message: 'Sunday +100%', locale: 'en' }, agent);
  assert.equal(forged.status, 'rejected');
  assert.equal(agent.calls, 0);
});

test('C1: multi-turn - a Sunday statement never silently fills Saturday before a real Saturday answer', async () => {
  const s = Q.bothPremiums();
  const first = await run({ scenario: s, message: 'Za niedzielę otrzymuję dodatek 50%.', locale: 'pl' }, bad(set('pay.saturdayPremiumPercent', 50)));
  assert.equal(first.scenario.pay.saturdayPremiumPercent, undefined);
  assert.equal(first.nextQuestion?.field, 'pay.saturdayPremiumPercent');
  // the bare "50%" now answers the Saturday question really being asked; Sunday is still open -> no payout yet
  const second = await run({ scenario: first.scenario, message: '50%', locale: 'pl', conversation: first.conversation }, null);
  assert.equal(valueAt(second.scenario, 'pay.saturdayPremiumPercent'), 50);
  assert.equal(second.scenario.pay.sundayPremiumPercent, undefined);
  assert.equal(second.nextQuestion?.field, 'pay.sundayPremiumPercent');
  assert.notEqual(second.evaluation?.status, 'computed', 'was: payout 697.86 from a Saturday value never stated for Saturday');
});

test('C1: at most one model call per turn and no second judge', async () => {
  for (const [qname, message, ops] of WRONG) {
    const agent = scriptedAgent([out('provide_information', ops), out('provide_information', ops)]);
    await run({ scenario: Q[qname](), message, locale: 'en' }, agent);
    assert.equal(agent.calls, 1, message);
  }
});

test('C1 domain: every non-hours numeric Scenario field has exactly one pay component; numbers bind per clause', () => {
  for (const path of SCENARIO_FIELD_PATHS) {
    const spec = SCENARIO_FIELDS[path];
    if (spec.kind === 'number' && !isHoursBucket(path)) assert.ok(FIELD_COMPONENT[path], `${path} has a component`);
  }
  const e = analyzeMessage('Saturday +50%, Sunday +100%');
  assert.deepEqual(mentionsForField(e, 'pay.saturdayPremiumPercent', null).map((n) => n.value), [50]);
  assert.deepEqual(mentionsForField(e, 'pay.sundayPremiumPercent', null).map((n) => n.value), [100]);
  assert.deepEqual(mentionsForField(e, 'pay.publicHolidayPremiumPercent', null), []);
  const travel = analyzeMessage('I receive €50 travel reimbursement');
  assert.deepEqual(mentionsForField(travel, 'extras.travelAllowance', null).map((n) => n.value), [50]);
  assert.deepEqual(mentionsForField(travel, 'pay.hourlyRate', 'pay.hourlyRate'), [], 'naming travel overrides the rate question');
  assert.deepEqual(mentionsForField(analyzeMessage('50%'), 'pay.saturdayPremiumPercent', 'pay.saturdayPremiumPercent').map((n) => n.value), [50]);
  assert.deepEqual(mentionsForField(analyzeMessage('50%'), 'pay.saturdayPremiumPercent', 'pay.sundayPremiumPercent'), []);
});
