import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScenarioPatch as applyGuarded, authorizePatch } from './patch-authority.js';
import { parseScenarioPatch, type PatchOp, type ScenarioPatchV1 } from './scenario-patch.js';
import { getAt } from '../scenario/scenario-util.js';
import { known, readyScenario, scenario } from '../test-support/conversation-fixtures.js';
import type { ScenarioFieldPath, ScenarioV1 } from '../scenario/scenario-types.js';
/** F4: the guard needs to know which assumption the server is offering. These tests offer none unless they
 * are about accepting one, in which case the offered field is passed explicitly. */
const applyScenarioPatch = (s: ScenarioV1, p: ScenarioPatchV1, offeredAssumption: ScenarioFieldPath | null = null) => applyGuarded(s, p, { offeredAssumption });


/** R2 §19 - ScenarioPatch V1: closed schema, field-table-bound ops, atomic and pure application. */

const patch = (...ops: PatchOp[]): ScenarioPatchV1 => ({ version: 1, ops });
function applied(s: ScenarioV1, p: ScenarioPatchV1, offered: ScenarioFieldPath | null = null): ScenarioV1 {
  const r = applyScenarioPatch(s, p, offered);
  assert.equal(r.status, 'applied', JSON.stringify(r));
  return r.scenario;
}
function rejected(s: ScenarioV1, p: ScenarioPatchV1) {
  const r = applyScenarioPatch(s, p);
  assert.equal(r.status, 'rejected', JSON.stringify(r));
  assert.ok(r.status === 'rejected');
  assert.deepEqual(r.scenario, s, 'a rejected patch returns the Scenario unchanged');
  return r.issues;
}

test('R2 patch #1: set the hourly rate from a user statement -> a user value', () => {
  const s = applied(scenario(), patch({ op: 'set', field: 'pay.hourlyRate', value: 16.8 }));
  assert.deepEqual(s.pay.hourlyRate, { state: 'known', value: 16.8, source: 'user' });
});

test('R2 patch #2-#5: weekday, Saturday, Sunday and public-holiday hours', () => {
  const s = applied(scenario(), patch(
    { op: 'set', field: 'work.regularWeekdayHours', value: 40 },
    { op: 'set', field: 'work.saturdayHours', value: 8 },
    { op: 'set', field: 'work.sundayHours', value: 6 },
    { op: 'set', field: 'work.publicHolidayHours', value: 8 },
  ));
  assert.deepEqual(s.work, {
    regularWeekdayHours: { state: 'known', value: 40, source: 'user' },
    saturdayHours: { state: 'known', value: 8, source: 'user' },
    sundayHours: { state: 'known', value: 6, source: 'user' },
    publicHolidayHours: { state: 'known', value: 8, source: 'user' },
  });
});

test('R2 patch #6: overtime - hours, distribution and tier inputs', () => {
  const s = applied(scenario({ work: { regularWeekdayHours: known(40) } }), patch(
    { op: 'set', field: 'work.overtimeHours', value: 6 },
    { op: 'set', field: 'work.overtimeDistribution', value: { kind: 'even', days: 2 } },
    { op: 'set', field: 'pay.overtime.thresholdHoursPerDay', value: 2 },
    { op: 'set', field: 'pay.overtime.tier1Percent', value: 25 },
    { op: 'set', field: 'pay.overtime.tier2Percent', value: 50 },
  ));
  assert.deepEqual(getAt(s, 'work.overtimeDistribution'), { state: 'known', value: { kind: 'even', days: 2 }, source: 'user' });
  assert.deepEqual(getAt(s, 'pay.overtime.tier2Percent'), { state: 'known', value: 50, source: 'user' });
});

test('R2 patch #7: tax-credit state', () => {
  assert.deepEqual(applied(scenario(), patch({ op: 'set', field: 'tax.loonheffingskorting', value: 'not_applied' })).tax.loonheffingskorting, { state: 'known', value: 'not_applied', source: 'user' });
  assert.deepEqual(rejected(scenario(), patch({ op: 'set', field: 'tax.loonheffingskorting', value: 'maybe' })).map((i) => i.code), ['choice_not_allowed']);
});

test('R2 patch #8: an explicit Loonto assumption comes only from the catalogue and is marked as one', () => {
  const s = applied(scenario({ work: { saturdayHours: known(8) } }), patch({ op: 'accept_assumption', field: 'pay.saturdayPremiumPercent' }), 'pay.saturdayPremiumPercent');
  assert.deepEqual(s.pay.saturdayPremiumPercent, { state: 'known', value: 50, source: 'loonto_assumption' });
  const both = applied(scenario(), patch({ op: 'accept_assumption', field: 'tax.loonheffingskorting' }), 'tax.loonheffingskorting');
  assert.deepEqual(both.tax.loonheffingskorting, { state: 'alternatives', options: ['applied', 'not_applied'], source: 'loonto_assumption' });
});

test('R2 patch #9-#12: unknown, range, alternatives and conflict states', () => {
  assert.deepEqual(applied(scenario(), patch({ op: 'set_unknown', field: 'pay.sundayPremiumPercent' })).pay.sundayPremiumPercent, { state: 'unknown' });
  assert.deepEqual(applied(scenario(), patch({ op: 'set_range', field: 'pay.hourlyRate', low: 16, high: 17 })).pay.hourlyRate, { state: 'range', low: 16, high: 17, source: 'user' });
  assert.deepEqual(applied(scenario(), patch({ op: 'set_alternatives', field: 'tax.loonheffingskorting', options: ['applied', 'not_applied'] })).tax.loonheffingskorting, { state: 'alternatives', options: ['applied', 'not_applied'], source: 'user' });
  assert.deepEqual(
    applied(scenario(), patch({ op: 'set_conflict', field: 'pay.hourlyRate', candidates: [{ value: 16.8 }, { value: 17.2 }] })).pay.hourlyRate,
    { state: 'conflict', candidates: [{ value: 16.8, source: 'user' }, { value: 17.2, source: 'user' }] },
  );
  assert.deepEqual(rejected(scenario(), patch({ op: 'set_range', field: 'tax.loonheffingskorting', low: 0, high: 1 })).map((i) => i.code), ['range_not_allowed_for_choice']);
  assert.deepEqual(rejected(scenario(), patch({ op: 'set_alternatives', field: 'pay.hourlyRate', options: [16, 17] })).map((i) => i.code), ['alternatives_not_allowed_for_number']);
});

test('R2 patch #13: an invalid field path is rejected', () => {
  for (const field of ['pay.salary', 'work/regularWeekdayHours', '/work/regularWeekdayHours', 'work[0]', 'pay..hourlyRate', 'payout', 'constructor', '__proto__']) {
    const issues = rejected(scenario(), patch({ op: 'set', field, value: 1 }));
    assert.ok(['unknown_field', 'engine_field_forbidden'].includes(issues[0]?.code ?? ''), `${field}: ${JSON.stringify(issues)}`);
  }
});

test('R2 patch #14: a Tier A-only / engine field is rejected', () => {
  for (const field of ['hourly_rate', 'week_grids', 'hour_lines', 'engineInput', 'engineResult', 'saturday_percent', 'apply_loonheffingskorting', 'payout_amount', 'pay.hourly_rate']) {
    assert.deepEqual(rejected(scenario(), patch({ op: 'set', field, value: 1 })).map((i) => i.code), ['engine_field_forbidden'], field);
  }
});

test('R2 patch #15: an arbitrary nested key / extra property / unknown op is rejected', () => {
  for (const field of ['pay.hourlyRate.value', 'pay.overtime', 'work', 'deductions.entered']) {
    assert.equal(rejected(scenario(), patch({ op: 'set', field, value: 1 }))[0]?.code, 'unknown_field', field);
  }
  // The schema itself is closed: no extra keys, no merge op, no pointer op.
  assert.equal(parseScenarioPatch({ version: 1, ops: [{ op: 'set', field: 'pay.hourlyRate', value: 16, extra: 1 }] }).ok, false);
  assert.equal(parseScenarioPatch({ version: 1, ops: [{ op: 'merge', value: { pay: {} } }] }).ok, false);
  assert.equal(parseScenarioPatch({ version: 1, ops: [{ op: 'replace', path: '/pay/hourlyRate', value: 1 }] }).ok, false);
  assert.equal(parseScenarioPatch({ version: 1, ops: [{ op: 'set', field: 'pay.hourlyRate', value: { state: 'known', value: 1, source: 'document' } }] }).ok, false, 'a value cannot smuggle a node');
  assert.equal(parseScenarioPatch({ version: 2, ops: [] }).ok, false);
  assert.equal(parseScenarioPatch({ version: 1, ops: [], scenario: {} }).ok, false);
});

test('R2 patch #16: mixed valid + invalid operations are atomic - nothing is applied', () => {
  const before = readyScenario();
  const issues = rejected(before, patch(
    { op: 'set', field: 'pay.hourlyRate', value: 18 },
    { op: 'set', field: 'work.sundayHours', value: 6 },
    { op: 'set', field: 'week_grids', value: 1 },
  ));
  assert.deepEqual(issues.map((i) => [i.code, i.opIndex]), [['engine_field_forbidden', 2]]);
});

test('R2 patch #17: same patch + same Scenario -> byte-equivalent result', () => {
  const p = patch({ op: 'set', field: 'work.saturdayHours', value: 8 }, { op: 'accept_assumption', field: 'pay.saturdayPremiumPercent' }, { op: 'set_label', label: '  week 41  ' });
  assert.equal(JSON.stringify(applied(readyScenario(), p, 'pay.saturdayPremiumPercent')), JSON.stringify(applied(readyScenario(), p, 'pay.saturdayPremiumPercent')));
});

test('R2 patch #18: applying a patch does not mutate the input Scenario or the patch', () => {
  const s = readyScenario();
  const p = patch({ op: 'set', field: 'pay.hourlyRate', value: 18 }, { op: 'remove', field: 'deductions.mode' });
  const sBefore = JSON.stringify(s);
  const pBefore = JSON.stringify(p);
  applyScenarioPatch(s, p);
  assert.equal(JSON.stringify(s), sBefore);
  assert.equal(JSON.stringify(p), pBefore);
});

test('R2 patch #19: remove / reset - explicit removal deletes and prunes; set_unknown resets without erasing the field', () => {
  const s = applied(readyScenario(), patch({ op: 'remove', field: 'deductions.mode' }));
  assert.equal(s.deductions, undefined, 'an emptied optional section is pruned');
  const reset = applied(readyScenario(), patch({ op: 'set_unknown', field: 'pay.hourlyRate' }));
  assert.deepEqual(reset.pay.hourlyRate, { state: 'unknown' });
  assert.equal(applyScenarioPatch(readyScenario(), patch({ op: 'remove', field: 'pay.sundayPremiumPercent' })).status, 'unchanged', 'removing an absent field is a no-op');
  const withoutWorkValue = applied(readyScenario(), patch({ op: 'remove', field: 'work.regularWeekdayHours' }));
  assert.deepEqual(withoutWorkValue.work, {}, 'a required section is kept even when empty');
});

test('R2 patch #20: a patch preserves every unrelated Scenario value', () => {
  const before = readyScenario();
  const after = applied(before, patch({ op: 'set', field: 'work.saturdayHours', value: 8 }));
  assert.deepEqual({ ...after, work: { ...after.work, saturdayHours: undefined } }, { ...before, work: { ...before.work, saturdayHours: undefined } });
});

test('R2 patch: duplicates, too many ops, wrong value types, unknown concepts', () => {
  assert.deepEqual(rejected(scenario(), patch({ op: 'set', field: 'pay.hourlyRate', value: 16 }, { op: 'set', field: 'pay.hourlyRate', value: 17 })).map((i) => i.code), ['duplicate_field_in_patch']);
  const many = Array.from({ length: 13 }, (_, i) => ({ op: 'set_label', label: `l${i}` }) as PatchOp);
  assert.deepEqual(authorizePatch(patch(...many), scenario(), { offeredAssumption: null }), { status: 'rejected', issues: [{ code: 'too_many_ops', params: { count: 13, max: 12 } }] });
  assert.deepEqual(rejected(scenario(), patch({ op: 'set', field: 'pay.hourlyRate', value: '16' })).map((i) => i.code), ['value_type_mismatch']);
  assert.deepEqual(rejected(scenario(), patch({ op: 'set', field: 'work.overtimeDistribution', value: 3 })).map((i) => i.code), ['value_type_mismatch']);
  assert.deepEqual(rejected(scenario(), patch({ op: 'request_concept', concept: 'free_money' })).map((i) => i.code), ['unknown_concept']);
});

test('R2 patch: a patch that would make the Scenario newly invalid is rejected with R1\'s own codes', () => {
  const issues = rejected(readyScenario(), patch({ op: 'set', field: 'work.regularWeekdayHours', value: -5 }));
  assert.deepEqual(issues.map((i) => [i.code, i.field, i.params?.issue]), [['scenario_validation_failed', 'work.regularWeekdayHours', 'negative_hours']]);
  const pct = rejected(readyScenario(), patch({ op: 'set', field: 'pay.sundayPremiumPercent', value: 900 }));
  assert.equal(pct[0]?.params?.issue, 'percent_out_of_range');
});

test('R2 patch: unsupported concepts are requested / withdrawn explicitly, and labels set', () => {
  const s = applied(readyScenario(), patch({ op: 'request_concept', concept: 'night_premium' }, { op: 'set_label', label: 'Week 41' }));
  assert.deepEqual(s.requestedConcepts, [{ concept: 'night_premium', source: 'user' }]);
  assert.equal(s.label, 'Week 41');
  const back = applied(s, patch({ op: 'withdraw_concept', concept: 'night_premium' }));
  assert.equal(back.requestedConcepts, undefined);
});
