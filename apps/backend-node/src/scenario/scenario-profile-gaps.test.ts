import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPLOYMENT_FIELD_KEYS, PAYROLL_FIELD_KEYS, resolvePayrollProfile } from '../payroll-engine/payroll-profile.js';
import { EMPLOYMENT_FIELD_ENGINE, PAYROLL_FIELD_ENGINE, RECURRING_ITEM_ENGINE } from './scenario-profile-gaps.js';
import { SCENARIO_FIELDS } from './scenario-types.js';

/**
 * Drift guard: every Payroll Profile field is classified as consumed / hint / gap / not-calculation, so a
 * new profile field cannot appear without someone deciding whether the Tier A engine can read it. The
 * Scenario never claims support for a profile concept the engine does not consume (§12).
 */

test('R1 gaps: every profile employment and payroll field is classified exactly once (drift guard)', () => {
  assert.deepEqual(Object.keys(EMPLOYMENT_FIELD_ENGINE).sort(), [...EMPLOYMENT_FIELD_KEYS].sort());
  assert.deepEqual(Object.keys(PAYROLL_FIELD_ENGINE).sort(), [...PAYROLL_FIELD_KEYS].sort());
});

test('R1 gaps: a "consumed" profile field names a real Scenario field; a "gap" names its reason and no Scenario field', () => {
  for (const table of [EMPLOYMENT_FIELD_ENGINE, PAYROLL_FIELD_ENGINE, RECURRING_ITEM_ENGINE]) {
    for (const [key, c] of Object.entries(table)) {
      if (c.status === 'consumed') assert.ok(c.scenarioField && c.scenarioField in SCENARIO_FIELDS, key);
      if (c.status === 'gap') assert.ok(c.gap && /^[a-z0-9_]+$/.test(c.gap) && !c.scenarioField, key);
    }
  }
});

test('R1 gaps: the known mapping gaps are exactly the ones the report names', () => {
  const gaps = (t: Record<string, { status: string }>) => Object.entries(t).filter(([, c]) => c.status === 'gap').map(([k]) => k).sort();
  assert.deepEqual(gaps(EMPLOYMENT_FIELD_ENGINE), ['guaranteedHours', 'guaranteedHoursPeriodWeeks', 'monthlySalary']);
  assert.deepEqual(gaps(PAYROLL_FIELD_ENGINE), [
    'bijzonderTariefPrintedPercent', 'etExchangeAmount', 'gediffWgaEmployeePercent', 'jaarloonBt', 'pawwEmployeePercent',
    'pensionEmployeePercent', 'sectorPremiumPercent', 'wgaEmployeePercent', 'wgaGatEmployeePercent', 'whkEmployeePercent',
  ]);
  assert.deepEqual(gaps(RECURRING_ITEM_ENGINE), ['netAdditions', 'netDeductions', 'otherPostTaxDeductions', 'otherPreTaxDeductions', 'surcharges']);
});

test('R1 gaps: every recurring-item family of a real resolved profile is classified (drift guard)', () => {
  const profile = resolvePayrollProfile({ asOfDate: '2026-06-01', documents: [] });
  assert.deepEqual(Object.keys(profile.recurringItems).sort(), Object.keys(RECURRING_ITEM_ENGINE).sort());
});
