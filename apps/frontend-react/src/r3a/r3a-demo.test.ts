import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableChoices, experienceStates, initialState, parseEditedNumber, reduce, resultView, type ChoiceId, type DemoAction, type DemoState, type ExperienceState } from './r3a-demo.ts';

/**
 * R3-A demo state machine (ZADANIE-LOONTO-R3-A-CONVERSATIONAL-UI-FOUNDATION.md §3, §4, §6). The view only renders
 * this state, so the journey, honesty and safety rules are proven here without a DOM.
 */

const run = (actions: DemoAction[], from: DemoState = initialState()) => actions.reduce(reduce, from);
const pick = (...choices: ChoiceId[]): DemoAction[] => choices.map((choice) => ({ type: 'choose', choice }));
const rowOf = (s: DemoState, id: string) => s.rows.find((r) => r.id === id);

test('R3-A: the start is conversation-first and needs no document', () => {
  const s = initialState();
  assert.equal(s.step, 'goal');
  assert.deepEqual(s.messages, [{ id: 1, from: 'loonto', key: 'opening' }]);
  assert.deepEqual(s.rows, []);
  assert.equal(s.sampleDocument, false);
  assert.deepEqual(availableChoices(s), ['goal_40h', 'sample_document', 'how_it_works'], 'the document example is optional, not a gate');
  assert.deepEqual(experienceStates(s), ['CONVERSATION', 'RESULT']);
});

test('R3-A: the no-document journey - one follow-up at a time, example values with a visible source, no result', () => {
  let s = initialState();
  const steps: Array<[ChoiceId, string]> = [['goal_40h', 'hours_kind'], ['hours_weekdays', 'rate'], ['rate_1680', 'extras'], ['extras_none', 'done']];
  for (const [choice, step] of steps) {
    const before = s.messages.length;
    s = reduce(s, { type: 'choose', choice });
    assert.equal(s.step, step, choice);
    const added = s.messages.slice(before);
    assert.equal(added[0]?.from, 'user', `${choice}: the picked answer is shown`);
    assert.equal(added.filter((m) => m.from === 'loonto').length, 1, `${choice}: exactly one follow-up`);
  }
  assert.deepEqual(s.rows.map((r) => [r.id, r.value, r.source, r.status]), [['weekday_hours', 40, 'user_example', 'given'], ['hourly_rate', 16.8, 'user_example', 'given']]);
  assert.equal(s.sampleDocument, false);
  const result = resultView(s);
  assert.equal(result.status, 'unavailable');
  assert.ok(result.reasons.includes('demo_engine_not_connected') && result.reasons.includes('tax_and_deductions_not_asked'));
  assert.ok(!('payout' in result) && !('amount' in result) && !('net' in result), 'the result has no amount field at all');
});

test('R3-A: free text is shown as typed but never interpreted - no step, row or result change', () => {
  const base = run(pick('goal_40h'));
  for (const text of ['40 godzin od poniedziałku do piątku', 'Ile dostanę netto?', 'stawka 99 euro', '<script>alert(1)</script>']) {
    const s = reduce(base, { type: 'free_text', text });
    assert.equal(s.step, base.step, text);
    assert.deepEqual(s.rows, base.rows, `${text}: the scenario is unchanged`);
    assert.deepEqual(resultView(s), resultView(base));
    assert.deepEqual(s.messages.slice(-2).map((m) => ('text' in m ? m.text : 'key' in m ? m.key : m.choice)), [text, 'free_text_not_connected']);
    assert.deepEqual(availableChoices(s), availableChoices(base), 'the same example answers stay available');
  }
  assert.equal(reduce(base, { type: 'free_text', text: '   ' }), base, 'an empty message is ignored');
});

test('R3-A: "Nie wiem" never becomes 0 - hours, split, Saturday premium and rate stay unknown', () => {
  const hours = run(pick('goal_40h', 'hours_dont_know'));
  assert.deepEqual(rowOf(hours, 'total_hours'), { id: 'total_hours', value: 40, unit: 'hours', source: 'user_example', status: 'to_classify' });
  assert.equal(hours.step, 'hours_kind', 'the question stays open, nothing assumed');
  const split = run(pick('goal_40h', 'hours_with_saturday', 'split_dont_know'));
  assert.equal(rowOf(split, 'weekday_hours'), undefined, 'no guessed 32');
  assert.equal(rowOf(split, 'saturday_hours'), undefined, 'no guessed 8');
  const sat = run(pick('goal_40h', 'hours_with_saturday', 'split_32_8', 'sat_dont_know'));
  assert.equal(rowOf(sat, 'saturday_premium')?.value, null);
  assert.equal(rowOf(sat, 'saturday_premium')?.status, 'unknown');
  assert.equal(sat.assumptionInfo, true, 'only an explanatory, display-only card');
  assert.ok(resultView(sat).reasons.includes('saturday_premium_unknown'));
  const rate = run(pick('goal_40h', 'hours_weekdays', 'rate_dont_know'));
  assert.equal(rowOf(rate, 'hourly_rate')?.value, null);
  assert.ok(resultView(rate).reasons.includes('rate_unknown'));
  assert.equal(resultView(rate).status, 'needs_clarification');
  for (const s of [hours, split, sat, rate]) assert.ok(s.rows.every((r) => r.value !== 0), 'no row is ever 0');
});

test('R3-A / R2 P1: an ambiguous 150% premium is never converted silently and blocks any result', () => {
  const s = run(pick('goal_40h', 'hours_with_saturday', 'split_32_8', 'sat_150'));
  assert.deepEqual(rowOf(s, 'saturday_premium'), { id: 'saturday_premium', value: 150, unit: 'percent_as_said', source: 'user_example', status: 'needs_clarification' });
  assert.equal(s.step, 'clarify_150');
  assert.deepEqual(availableChoices(s), ['clarify_150_plus_50', 'clarify_150_plus_150', 'sat_dont_know']);
  assert.equal(resultView(s).status, 'needs_clarification');
  assert.ok(resultView(s).reasons.includes('premium_150_ambiguous'));
  // only the user's explicit choice sets a meaning
  assert.deepEqual(rowOf(reduce(s, { type: 'choose', choice: 'clarify_150_plus_50' }), 'saturday_premium')?.value, 50);
  assert.deepEqual(rowOf(reduce(s, { type: 'choose', choice: 'clarify_150_plus_150' }), 'saturday_premium')?.value, 150);
  // free text does not resolve it either
  assert.equal(rowOf(reduce(s, { type: 'free_text', text: 'chodziło o +50%' }), 'saturday_premium')?.status, 'needs_clarification');
});

test('R3-A / R2 L1: a night / shift allowance is unsupported and never becomes a weekend premium', () => {
  const s = run(pick('goal_40h', 'hours_weekdays', 'rate_1680', 'extras_night'));
  assert.deepEqual(rowOf(s, 'night_allowance'), { id: 'night_allowance', value: null, unit: 'none', source: 'user_example', status: 'unsupported' });
  assert.equal(rowOf(s, 'saturday_premium'), undefined);
  assert.ok(resultView(s).reasons.includes('allowance_unsupported'));
  assert.equal(resultView(s).status, 'needs_clarification');
});

test('R3-A: the sample document is fictitious, unverified, and spares a repeated question (READ + SUMMARY)', () => {
  const s = run(pick('sample_document'));
  assert.equal(s.sampleDocument, true);
  assert.deepEqual(s.messages.slice(-3).map((m) => ('key' in m ? m.key : '')), ['doc_read', 'doc_summary', 'goal_after_doc']);
  assert.ok(s.rows.every((r) => r.source === 'sample_document' && r.status === 'unverified_example'), 'never a verified document fact');
  assert.deepEqual(availableChoices(s), ['goal_40h', 'how_it_works'], 'the example is shown once');
  const next = run(pick('goal_40h', 'hours_weekdays'), s);
  assert.equal(next.step, 'extras', 'the rate is not asked again');
  assert.deepEqual(next.messages.slice(-2).map((m) => ('key' in m ? m.key : '')), ['rate_from_document', 'ask_extras']);
  assert.ok(resultView(next).reasons.includes('rate_unverified_example'));
  assert.deepEqual(experienceStates(next).slice(0, 2), ['READ', 'SUMMARY']);
});

test('R3-A: all six experience states are reachable in one coherent journey', () => {
  const seen = new Set<ExperienceState>();
  let s = initialState();
  for (const action of [...pick('sample_document', 'goal_40h', 'hours_weekdays', 'extras_none', 'why_no_result')]) {
    s = reduce(s, action);
    for (const state of experienceStates(s)) seen.add(state);
  }
  assert.deepEqual([...seen].sort(), ['CONVERSATION', 'EXPLAIN', 'READ', 'RESULT', 'SCENARIO', 'SUMMARY']);
});

test('R3-A: demo edits change only that example value, keep the earlier source and never restart the conversation', () => {
  const s = run(pick('goal_40h', 'hours_weekdays', 'rate_1680'));
  const edited = reduce(s, { type: 'edit_row', id: 'hourly_rate', raw: '17,50' });
  assert.deepEqual(edited.rows.find((r) => r.id === 'hourly_rate'), { id: 'hourly_rate', value: 17.5, unit: 'eur_per_hour', source: 'user_edit_example', previousSource: 'user_example', status: 'given' });
  assert.deepEqual(edited.messages, s.messages, 'no new question');
  assert.equal(edited.step, s.step);
  assert.deepEqual(edited.rows.find((r) => r.id === 'weekday_hours'), s.rows.find((r) => r.id === 'weekday_hours'));
  const again = reduce(edited, { type: 'edit_row', id: 'hourly_rate', raw: '18' });
  assert.equal(again.rows.find((r) => r.id === 'hourly_rate')?.previousSource, 'user_example', 'the original source stays visible');
  // errors leave the value untouched
  for (const [raw, error] of [['abc', 'invalid_number'], ['0', 'must_be_positive'], ['', 'invalid_number']] as const) {
    const bad = reduce(s, { type: 'edit_row', id: 'hourly_rate', raw });
    assert.equal(bad.editErrors.hourly_rate, error, raw);
    assert.deepEqual(bad.rows, s.rows, `${raw}: no change`);
  }
  assert.equal(reduce(s, { type: 'edit_row', id: 'weekday_hours', raw: '200' }).editErrors.weekday_hours, 'hours_out_of_range');
  // a sample-document value edited by the user keeps "sample document" as the earlier source
  const doc = reduce(run(pick('sample_document')), { type: 'edit_row', id: 'hourly_rate', raw: '€ 17.20' });
  assert.deepEqual(doc.rows.find((r) => r.id === 'hourly_rate'), { id: 'hourly_rate', value: 17.2, unit: 'eur_per_hour', source: 'user_edit_example', previousSource: 'sample_document', status: 'given' });
  assert.equal(reduce(s, { type: 'edit_row', id: 'pay_period', raw: '2' }), s, 'non-editable rows are ignored');
});

test('R3-A: panel, details, Analyzer and reset behave and keep the conversation', () => {
  const s = run([...pick('goal_40h'), { type: 'free_text', text: 'moja wiadomość' }]);
  const open = reduce(s, { type: 'set_panel', open: true });
  assert.equal(open.panelOpen, true);
  assert.deepEqual(open.messages, s.messages, 'opening the panel keeps the conversation');
  assert.deepEqual(reduce(open, { type: 'set_panel', open: false }).messages, s.messages);
  const analyzer = reduce(s, { type: 'analyzer' });
  assert.equal(analyzer.analyzerNotice, true);
  assert.equal(analyzer.step, s.step, 'the Analyzer goes nowhere');
  assert.deepEqual(analyzer.messages, s.messages);
  assert.deepEqual(reduce(s, { type: 'reset' }), initialState());
  const done = run(pick('goal_40h', 'hours_weekdays', 'rate_1680', 'extras_none', 'show_scenario'));
  assert.equal(done.panelOpen, true);
  assert.deepEqual(run(pick('start_over'), done).rows, []);
  const ignored = initialState();
  assert.equal(reduce(ignored, { type: 'choose', choice: 'rate_1680' }), ignored, 'an answer not offered now is ignored');
});

test('R3-A: edited numbers are parsed strictly', () => {
  assert.equal(parseEditedNumber('16,80'), 16.8);
  assert.equal(parseEditedNumber('€ 16.80'), 16.8);
  assert.equal(parseEditedNumber('36 h'), 36);
  for (const raw of ['', 'abc', '16,80,1', '-5', '1e3', '12 13']) assert.equal(parseEditedNumber(raw), null, raw);
});
