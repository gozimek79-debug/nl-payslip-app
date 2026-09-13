import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertHourGridToLines, convertMultiEmployerHourGrid, emptyHourGrid, resolveOvertimeTierThreshold } from './hour-grid.js';

test('resolveOvertimeTierThreshold: user correction outranks both contract and reproduction', () => {
  const t = resolveOvertimeTierThreshold({ contract_stated: 8, payslip_reproduced_evidence: 6, user_entered: 5 });
  assert.deepEqual(t, { hours_before_step_up: 5, provenance: 'user_entered', disagreement: null });
});

test('resolveOvertimeTierThreshold: a stated contract term wins over reproduced evidence (CH1)', () => {
  const t = resolveOvertimeTierThreshold({ contract_stated: 8, payslip_reproduced_evidence: 8, user_entered: null });
  assert.deepEqual(t, { hours_before_step_up: 8, provenance: 'contract_stated', disagreement: null });
});

test('resolveOvertimeTierThreshold: contract and reproduction disagreeing is shown, not silently resolved (CH1)', () => {
  // Real, unresolved case from this engagement's own reference documents: nothing in PKF or
  // Randstad's tier totals states the per-day threshold outright - if a future contract for either
  // worker states one value while the payslip's own totals reproduce under a different one, that
  // disagreement is itself a finding about the employer, not a bug to paper over.
  const t = resolveOvertimeTierThreshold({ contract_stated: 8, payslip_reproduced_evidence: 6, user_entered: null });
  assert.equal(t.hours_before_step_up, 8);
  assert.equal(t.provenance, 'contract_stated');
  assert.deepEqual(t.disagreement, { contract_value: 8, payslip_reproduced_value: 6 });
});

test('resolveOvertimeTierThreshold: nothing supplied stays unknown, never defaults', () => {
  const t = resolveOvertimeTierThreshold({ contract_stated: null, payslip_reproduced_evidence: null, user_entered: null });
  assert.deepEqual(t, { hours_before_step_up: null, provenance: 'unknown', disagreement: null });
});

test('convertHourGridToLines: a day with overtime hours blocks when the threshold is unknown - never guessed', () => {
  const grid = emptyHourGrid();
  grid.wed = { regular_hours: 8, overtime_hours: 4, is_public_holiday: false };
  const unknown = resolveOvertimeTierThreshold({ contract_stated: null, payslip_reproduced_evidence: null, user_entered: null });

  const result = convertHourGridToLines(grid, unknown);
  assert.deepEqual(result, { status: 'blocked', reason: 'overtime_threshold_unknown', days_affected: ['wed'] });
});

test('convertHourGridToLines: a day with only regular hours converts cleanly even with an unknown threshold', () => {
  // A weekday with no overtime has nothing that needs the threshold to split - blocking here would be
  // over-conservative, refusing to render hours the grid already knows unambiguously.
  const grid = emptyHourGrid();
  grid.mon = { regular_hours: 8, overtime_hours: 0, is_public_holiday: false };
  const unknown = resolveOvertimeTierThreshold({ contract_stated: null, payslip_reproduced_evidence: null, user_entered: null });

  const result = convertHourGridToLines(grid, unknown);
  assert.deepEqual(result, { status: 'complete', lines: [{ day: 'mon', category: 'regular', hours: 8 }] });
});

test('convertHourGridToLines: PKF-shaped week - overtime tiers into 125%/150% buckets by the known threshold', () => {
  // Reproduces PKF's own real, printed tier totals (audit BQ) from a per-day grid: 4.00h at tier 1
  // and 18.25h at tier 2 across the period. Modeled here as concentrated on one day for the test's
  // own clarity - convertHourGridToLines operates per day regardless of how the hours are spread.
  const grid = emptyHourGrid();
  grid.thu = { regular_hours: 8, overtime_hours: 22.25, is_public_holiday: false };
  const threshold = resolveOvertimeTierThreshold({ contract_stated: 4, payslip_reproduced_evidence: null, user_entered: null });

  const result = convertHourGridToLines(grid, threshold);
  assert.equal(result.status, 'complete');
  if (result.status !== 'complete') return;
  assert.deepEqual(result.lines, [
    { day: 'thu', category: 'regular', hours: 8 },
    { day: 'thu', category: 'overtime_tier_1', hours: 4 },
    { day: 'thu', category: 'overtime_tier_2', hours: 18.25 },
  ]);
});

test('convertHourGridToLines: Saturday and Sunday hours never enter overtime tiering, regardless of the threshold', () => {
  const grid = emptyHourGrid();
  grid.sat = { regular_hours: 6, overtime_hours: 2, is_public_holiday: false };
  grid.sun = { regular_hours: 4, overtime_hours: 0, is_public_holiday: false };
  const unknownThreshold = resolveOvertimeTierThreshold({ contract_stated: null, payslip_reproduced_evidence: null, user_entered: null });

  const result = convertHourGridToLines(grid, unknownThreshold);
  // An unknown threshold does not block Saturday/Sunday hours - they were never going to be tiered.
  assert.deepEqual(result, {
    status: 'complete',
    lines: [
      { day: 'sat', category: 'saturday', hours: 8 },
      { day: 'sun', category: 'sunday', hours: 4 },
    ],
  });
});

test('convertHourGridToLines: a public holiday overrides weekend treatment, not stacked with it', () => {
  const grid = emptyHourGrid();
  grid.sat = { regular_hours: 5, overtime_hours: 0, is_public_holiday: true }; // e.g. a holiday that happens to fall on a Saturday
  grid.tue = { regular_hours: 8, overtime_hours: 3, is_public_holiday: true }; // a midweek public holiday
  const threshold = resolveOvertimeTierThreshold({ contract_stated: 2, payslip_reproduced_evidence: null, user_entered: null });

  const result = convertHourGridToLines(grid, threshold);
  assert.deepEqual(result, {
    status: 'complete',
    lines: [
      { day: 'tue', category: 'holiday', hours: 11 },
      { day: 'sat', category: 'holiday', hours: 5 },
    ],
  });
});

test('CO2: convertMultiEmployerHourGrid applies each employer\'s own threshold independently - never pooled', () => {
  // CO2's own example: 5 hours at employer A and 4 at employer B is nine hours worked and no overtime
  // anywhere - each contract counts its own day. Employer A's grid alone has no overtime hours at
  // all (5 regular), employer B's alone has none either (4 regular) - pooling would be the only way
  // to manufacture overtime here, and this function must not do that.
  const gridA = emptyHourGrid();
  gridA.mon = { regular_hours: 5, overtime_hours: 0, is_public_holiday: false };
  const gridB = emptyHourGrid();
  gridB.mon = { regular_hours: 4, overtime_hours: 0, is_public_holiday: false };

  const thresholdA = resolveOvertimeTierThreshold({ contract_stated: 8, payslip_reproduced_evidence: null, user_entered: null });
  const thresholdB = resolveOvertimeTierThreshold({ contract_stated: 4, payslip_reproduced_evidence: null, user_entered: null });

  const result = convertMultiEmployerHourGrid({ A: gridA, B: gridB }, { A: thresholdA, B: thresholdB });

  assert.deepEqual(result.per_employer.A, { status: 'complete', lines: [{ day: 'mon', category: 'regular', hours: 5 }] });
  assert.deepEqual(result.per_employer.B, { status: 'complete', lines: [{ day: 'mon', category: 'regular', hours: 4 }] });
  // The combined view is display-only hours-by-category - 9 regular hours total, still zero overtime.
  assert.equal(result.combined_hours_by_category.regular, 9);
  assert.equal(result.combined_hours_by_category.overtime_tier_1, 0);
  assert.equal(result.combined_hours_by_category.overtime_tier_2, 0);
});

test('CO2: each employer uses its OWN threshold, not another employer\'s, even for identical hour totals', () => {
  const gridA = emptyHourGrid();
  gridA.tue = { regular_hours: 8, overtime_hours: 6, is_public_holiday: false };
  const gridB = emptyHourGrid();
  gridB.tue = { regular_hours: 8, overtime_hours: 6, is_public_holiday: false };

  const thresholdA = resolveOvertimeTierThreshold({ contract_stated: 2, payslip_reproduced_evidence: null, user_entered: null });
  const thresholdB = resolveOvertimeTierThreshold({ contract_stated: 4, payslip_reproduced_evidence: null, user_entered: null });

  const result = convertMultiEmployerHourGrid({ A: gridA, B: gridB }, { A: thresholdA, B: thresholdB });

  assert.deepEqual(result.per_employer.A, {
    status: 'complete',
    lines: [
      { day: 'tue', category: 'regular', hours: 8 },
      { day: 'tue', category: 'overtime_tier_1', hours: 2 },
      { day: 'tue', category: 'overtime_tier_2', hours: 4 },
    ],
  });
  assert.deepEqual(result.per_employer.B, {
    status: 'complete',
    lines: [
      { day: 'tue', category: 'regular', hours: 8 },
      { day: 'tue', category: 'overtime_tier_1', hours: 4 },
      { day: 'tue', category: 'overtime_tier_2', hours: 2 },
    ],
  });
});

test('convertMultiEmployerHourGrid: one employer blocked on an unknown threshold does not block or contaminate the other', () => {
  const gridA = emptyHourGrid();
  gridA.wed = { regular_hours: 8, overtime_hours: 3, is_public_holiday: false };
  const gridB = emptyHourGrid();
  gridB.wed = { regular_hours: 8, overtime_hours: 0, is_public_holiday: false };

  const unknownThreshold = resolveOvertimeTierThreshold({ contract_stated: null, payslip_reproduced_evidence: null, user_entered: null });
  const knownThreshold = resolveOvertimeTierThreshold({ contract_stated: 4, payslip_reproduced_evidence: null, user_entered: null });

  const result = convertMultiEmployerHourGrid({ A: gridA, B: gridB }, { A: unknownThreshold, B: knownThreshold });

  assert.deepEqual(result.per_employer.A, { status: 'blocked', reason: 'overtime_threshold_unknown', days_affected: ['wed'] });
  assert.deepEqual(result.per_employer.B, { status: 'complete', lines: [{ day: 'wed', category: 'regular', hours: 8 }] });
  // Combined summary only reflects employers that actually resolved - A's blocked hours are not
  // silently counted as zero (spec §1: unknown != 0), they're just absent from this rollup, same as
  // A's own tab would show the gap rather than a wrong number.
  assert.equal(result.combined_hours_by_category.regular, 8);
});
