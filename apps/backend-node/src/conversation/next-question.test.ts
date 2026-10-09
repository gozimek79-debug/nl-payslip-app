import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNextQuestion, FIELD_PRIORITY } from './next-question.js';
import { evaluateScenario } from '../scenario/scenario-evaluate.js';
import { SCENARIO_FIELDS, type ScenarioV1 } from '../scenario/scenario-types.js';
import { RATES_2026, allKeys, known, readyScenario, scenario } from '../test-support/conversation-fixtures.js';

/** R2 §20 - the deterministic next-question selector. WHAT to ask is chosen by code from R1's result. */

const ask = (s: ScenarioV1, declined: string[] = []) => selectNextQuestion({ scenario: s, evaluation: evaluateScenario(s, RATES_2026), declinedAssumptions: declined });

test('R2 next #1: missing hourly rate -> the hourly-rate question', () => {
  const q = ask({ ...readyScenario(), pay: {} });
  assert.equal(q?.kind, 'provide_value');
  assert.equal(q?.field, 'pay.hourlyRate');
  assert.equal(q?.reasonCode, 'missing');
  assert.equal(q?.answerMode, 'number');
  assert.equal(q?.unit, 'eur_per_hour');
  assert.equal(q?.canUseAssumption, false, 'no assumption is ever offered for a rate');
  assert.deepEqual(q?.fallbackOptions, ['upload_document', 'give_range']);
});

test('R2 next #2: no Sunday hours -> the Sunday premium is never asked', () => {
  assert.equal(ask(readyScenario()), null, 'complete weekday scenario computes - nothing to ask');
  const partial = { ...readyScenario(), tax: {} };
  const q = ask(partial);
  assert.equal(q?.field, 'tax.loonheffingskorting');
  assert.notEqual(q?.field, 'pay.sundayPremiumPercent');
});

test('R2 next #3: Sunday hours + missing premium -> the Sunday premium is asked, with the assumption available', () => {
  const q = ask({ ...readyScenario(), work: { regularWeekdayHours: known(40), sundayHours: known(6) } });
  assert.equal(q?.kind, 'provide_value');
  assert.equal(q?.field, 'pay.sundayPremiumPercent');
  assert.equal(q?.canUseAssumption, true);
  assert.equal(q?.suggestedAssumption, undefined, 'not offered until the user says they do not know');
});

test('R2 next #4: "don\'t know" (unknown) where an assumption is allowed -> the assumption is offered, marked as one', () => {
  const q = ask({ ...readyScenario(), work: { regularWeekdayHours: known(40), sundayHours: known(6) }, pay: { hourlyRate: known(16.8), sundayPremiumPercent: { state: 'unknown' } } } as ScenarioV1);
  assert.equal(q?.kind, 'offer_assumption');
  assert.equal(q?.reasonCode, 'user_does_not_know');
  assert.deepEqual(q?.suggestedAssumption, { value: 100, source: 'loonto_assumption' });
  assert.equal(q?.answerMode, 'yes_no');
  // declined -> not offered again; the field is asked plainly, with other ways forward
  const after = ask({ ...readyScenario(), work: { regularWeekdayHours: known(40), sundayHours: known(6) }, pay: { hourlyRate: known(16.8), sundayPremiumPercent: { state: 'unknown' } } } as ScenarioV1, ['pay.sundayPremiumPercent']);
  assert.equal(after?.kind, 'provide_value');
  assert.equal(after?.reasonCode, 'user_does_not_know');
  assert.equal(after?.canUseAssumption, false);
  assert.ok(after?.fallbackOptions.includes('give_range') && after.fallbackOptions.includes('upload_document'), '"I don\'t know" never dead-ends');
  // a field without an assumption policy: "don't know" -> other ways forward, never a guess
  const rate = ask({ ...readyScenario(), pay: { hourlyRate: { state: 'unknown' } } } as ScenarioV1);
  assert.equal(rate?.kind, 'provide_value');
  assert.equal(rate?.reasonCode, 'user_does_not_know');
  assert.deepEqual(rate?.fallbackOptions, ['upload_document', 'give_range']);
  // tax credit unknown -> compute both variants (Lock §33), as an explicit assumption
  const tax = ask({ ...readyScenario(), tax: { loonheffingskorting: { state: 'unknown' } } } as ScenarioV1);
  assert.equal(tax?.kind, 'offer_assumption');
  assert.deepEqual(tax?.suggestedAssumption, { options: ['applied', 'not_applied'], source: 'loonto_assumption' });
});

test('R2 next #5: a conflict -> a clarification question listing the competing values and their sources', () => {
  const q = ask({ ...readyScenario(), pay: { hourlyRate: { state: 'conflict', candidates: [{ value: 16.2, source: 'document', ref: 'd' }, { value: 17.2, source: 'user' }] } } } as ScenarioV1);
  assert.equal(q?.kind, 'resolve_conflict');
  assert.equal(q?.answerMode, 'pick_candidate');
  assert.deepEqual(q?.candidates, [{ value: 16.2, source: 'document' }, { value: 17.2, source: 'user' }]);
});

test('R2 next #6: unsupported -> no fake missing-field question', () => {
  assert.equal(ask({ ...readyScenario(), pay: {}, requestedConcepts: [{ concept: 'night_premium', source: 'user' }] }), null);
});

test('R2 next #7: ready / computed -> no next question', () => {
  assert.equal(ask(readyScenario()), null);
});

test('R2 next #8 / #9: exactly one question, chosen by a fixed priority (conflicts > hours > rate > ... > deductions)', () => {
  const empty = scenario();
  const q = ask(empty);
  assert.equal(q?.field, 'work.hours', 'with nothing known, the goal (hours) comes first');
  assert.equal(q?.answerMode, 'hours_by_category');
  assert.ok(!Array.isArray(q), 'one question, never a list');
  // Remove things one at a time and check the order holds.
  const order: string[] = [];
  let s: ScenarioV1 = scenario({ work: { regularWeekdayHours: known(40), sundayHours: known(6) } });
  const answers: Record<string, unknown> = { 'pay.hourlyRate': known(16.8), 'pay.sundayPremiumPercent': known(100), 'tax.loonheffingskorting': known('applied'), 'deductions.mode': known('estimate', 'loonto_assumption') };
  for (let i = 0; i < 6; i++) {
    const next = ask(s);
    if (!next) break;
    order.push(next.field);
    const [section, key] = next.field.split('.') as [string, string];
    s = { ...s, [section]: { ...(s as unknown as Record<string, Record<string, unknown>>)[section], [key]: answers[next.field] } } as ScenarioV1;
  }
  assert.deepEqual(order, ['pay.hourlyRate', 'pay.sundayPremiumPercent', 'tax.loonheffingskorting', 'deductions.mode']);
  // Same input, same answer (deterministic), and a conflict outranks everything else.
  assert.deepEqual(ask(empty), ask(empty));
  const conflicted = { ...scenario(), pay: { hourlyRate: { state: 'conflict', candidates: [{ value: 1, source: 'user' }, { value: 2, source: 'user' }] } } } as ScenarioV1;
  assert.equal(ask(conflicted)?.kind, 'resolve_conflict');
  assert.ok((ask(conflicted)?.priority ?? 999) < (ask(empty)?.priority ?? 0));
});

test('R2 next #10: a value established by a trusted document is not asked again', () => {
  const s = { ...readyScenario(), pay: { hourlyRate: { state: 'known', value: 16.2, source: 'document', ref: 'doc-1' } }, tax: {} } as ScenarioV1;
  const q = ask(s);
  assert.notEqual(q?.field, 'pay.hourlyRate');
  assert.equal(q?.field, 'tax.loonheffingskorting');
});

test('R2 next #11: an invalid Scenario gets ONE actionable correction question', () => {
  const q = ask({ ...readyScenario(), work: { regularWeekdayHours: known(-5) } });
  assert.equal(q?.kind, 'correct_value');
  assert.equal(q?.field, 'work.regularWeekdayHours');
  assert.equal(q?.reasonCode, 'negative_hours');
  // a cross-check on the whole week maps to a concrete field
  const day = ask({ ...readyScenario(), work: { regularWeekdayHours: known(40), overtimeHours: known(20), overtimeDistribution: known({ kind: 'even', days: 1 }) }, pay: { hourlyRate: known(16.8), overtime: { thresholdHoursPerDay: known(2), tier1Percent: known(25), tier2Percent: known(50) } } } as ScenarioV1);
  assert.equal(day?.kind, 'correct_value');
  assert.equal(day?.field, 'work.overtimeDistribution');
  // a structural problem is not a user question
  assert.equal(ask({ ...readyScenario(), periodType: 'month' } as unknown as ScenarioV1), null);
});

test('R2 next #12: no engine-internal field ever appears in a question spec', () => {
  const engineKeys = ['engineInput', 'engineResult', 'week_grids', 'hour_lines', 'hourly_rate', 'outcome', 'period', 'saturday_percent'];
  const states: ScenarioV1[] = [
    scenario(),
    { ...readyScenario(), pay: {} },
    { ...readyScenario(), work: { regularWeekdayHours: known(40), sundayHours: known(6) } },
    { ...readyScenario(), work: { regularWeekdayHours: known(-1) } },
    { ...readyScenario(), pay: { hourlyRate: { state: 'conflict', candidates: [{ value: 1, source: 'user' }, { value: 2, source: 'user' }] } } } as ScenarioV1,
  ];
  for (const s of states) {
    const q = ask(s);
    assert.ok(q);
    const keys = allKeys(q);
    for (const k of engineKeys) assert.ok(!keys.has(k), k);
    assert.ok(q.field === 'work.hours' || Object.prototype.hasOwnProperty.call(SCENARIO_FIELDS, q.field), q.field);
  }
  // The priority table itself names only Scenario fields.
  for (const f of FIELD_PRIORITY) assert.ok(f === 'work.hours' || Object.prototype.hasOwnProperty.call(SCENARIO_FIELDS, f), f);
  assert.equal(FIELD_PRIORITY.length, Object.keys(SCENARIO_FIELDS).length + 1, 'every Scenario field has a priority');
});
