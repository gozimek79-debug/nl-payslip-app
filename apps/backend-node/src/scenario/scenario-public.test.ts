import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScenario } from './scenario-evaluate.js';
import { compareEvaluations } from './scenario-compare.js';
import { toPublicComparison, toPublicEvaluation } from './scenario-public.js';
import { RATES_2026, alternatives, num, range, weekdayScenario } from '../test-support/scenario-fixtures.js';

/**
 * F3 (Cursor review): the public projection of an evaluation. The domain result keeps the engine input /
 * result for replay; the projection is an explicit allow-list that drops them.
 */

const FORBIDDEN = ['engineInput', 'engineResult', 'engineInputDigest', 'consumption', 'estimate', 'runs', 'lowRun', 'highRun'];

function keysDeep(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, into));
  else if (typeof value === 'object' && value !== null) for (const [k, v] of Object.entries(value)) { into.add(k); keysDeep(v, into); }
  return into;
}

const ev = (s: unknown) => evaluateScenario(s, RATES_2026);

test('F3: the domain result keeps replay detail; the public projection has none of it', () => {
  const internal = ev(weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } }));
  assert.ok(internal.status === 'computed');
  const internalKeys = keysDeep(internal);
  assert.ok(internalKeys.has('engineInput') && internalKeys.has('engineResult'), 'the domain still has what replay tests need');

  const pub = toPublicEvaluation(internal);
  const publicKeys = keysDeep(pub);
  for (const forbidden of FORBIDDEN) assert.ok(!publicKeys.has(forbidden), `public result must not contain ${forbidden}`);
  for (const engineKey of ['week_grids', 'hour_lines', 'hourly_rate', 'pre_tax_deductions', 'gross_total', 'payout_amount', 'wage_net']) {
    assert.ok(!publicKeys.has(engineKey), `no Tier A field name (${engineKey})`);
  }
});

test('F3: the projection is an explicit allow-list - a field added to the internal result later is NOT exposed', () => {
  const internal = ev(weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } }));
  assert.ok(internal.status === 'computed');
  // Simulate a future internal field at every level.
  const tainted = structuredClone(internal) as typeof internal & Record<string, unknown>;
  tainted.secretTopLevel = 'x';
  (tainted.figures as unknown as Record<string, unknown>).secretFigure = 1;
  if (tainted.range) (tainted.range as unknown as Record<string, unknown>).secretRange = 1;
  (tainted.runs[0] as unknown as Record<string, unknown>).secretRun = { engineInput: 'x' };
  const pub = toPublicEvaluation(tainted);
  const keys = keysDeep(pub);
  for (const leaked of ['secretTopLevel', 'secretFigure', 'secretRange', 'secretRun']) assert.ok(!keys.has(leaked), leaked);
  assert.deepEqual(Object.keys(pub).sort(), ['assumptionsUsed', 'figures', 'provenance', 'range', 'scenario', 'status', 'variants', 'warnings']);
});

test('F3: the public computed result keeps everything R2 needs - figures, range, variants, provenance, assumptions, warnings', () => {
  const internal = ev(weekdayScenario({ work: { regularWeekdayHours: num(40), sundayHours: num(8) }, pay: { hourlyRate: num(16.8, 'document', 'doc-1'), sundayPremiumPercent: range(50, 100, 'loonto_assumption') } }));
  assert.ok(internal.status === 'computed');
  const pub = toPublicEvaluation(internal);
  assert.ok(pub.status === 'computed');
  assert.deepEqual(pub.figures, internal.figures);
  assert.equal(pub.variants.length, internal.runs.length);
  pub.variants.forEach((v, i) => {
    assert.equal(v.kind, internal.runs[i]?.kind);
    assert.deepEqual(v.assignments, internal.runs[i]?.assignments);
    assert.deepEqual(v.figures, internal.runs[i]?.figures);
  });
  assert.ok(pub.range && internal.range);
  assert.equal(pub.range.low, internal.range.low);
  assert.equal(pub.range.high, internal.range.high);
  assert.equal(pub.range.lowVariant, internal.range.lowRun);
  assert.equal(pub.range.highVariant, internal.range.highRun);
  assert.equal(pub.variants[pub.range.lowVariant]?.figures.payoutAmount, pub.range.low, 'endpoints still resolve to evaluated variants');
  assert.deepEqual(pub.assumptionsUsed, internal.assumptionsUsed);
  assert.deepEqual(pub.provenance, internal.provenance);
  assert.deepEqual(pub.warnings, internal.warnings);
  assert.deepEqual(pub.scenario, internal.scenario);
});

test('F3: the projection does not alias or mutate the internal result', () => {
  const internal = ev(weekdayScenario({ tax: { loonheffingskorting: alternatives(['applied', 'not_applied'] as const) } }));
  assert.ok(internal.status === 'computed');
  const snapshot = JSON.stringify(internal);
  const pub = toPublicEvaluation(internal);
  assert.equal(JSON.stringify(internal), snapshot);
  assert.ok(pub.status === 'computed');
  pub.figures.payoutAmount = -1;
  assert.notEqual(internal.figures.payoutAmount, -1);
  if (pub.range) pub.range.uncertainFields.push('x');
  assert.ok(!internal.range?.uncertainFields.includes('x'));
});

test('F3-C: blocked / invalid / unsupported pass through unchanged and carry no engine data', () => {
  for (const scenario of [weekdayScenario({ pay: {} }), weekdayScenario({ work: { regularWeekdayHours: num(-1) } }), weekdayScenario({ requestedConcepts: [{ concept: 'et_exchange', source: 'user' }] })]) {
    const internal = ev(scenario);
    assert.notEqual(internal.status, 'computed');
    assert.deepEqual(toPublicEvaluation(internal), internal, 'identical content: these results never held engine structures');
    assert.deepEqual(toPublicEvaluation(internal), toPublicEvaluation(ev(scenario)), 'deterministic');
  }
});

test('F3-B: comparison projections (comparable / not comparable) drop engine structures and keep the delta', () => {
  const a = ev(weekdayScenario({ scenarioId: 'a' }));
  const b = ev(weekdayScenario({ scenarioId: 'b', work: { regularWeekdayHours: num(45) } }));
  const comparable = compareEvaluations(a, b);
  assert.ok(comparable.status === 'comparable');
  const pubComparable = toPublicComparison(comparable);
  assert.ok(pubComparable.status === 'comparable');
  assert.deepEqual(pubComparable.delta, comparable.delta);
  assert.equal(pubComparable.a.figures.payoutAmount, comparable.a.figures.payoutAmount);
  for (const forbidden of FORBIDDEN) assert.ok(!keysDeep(pubComparable).has(forbidden), forbidden);

  const notComparable = compareEvaluations(a, ev(weekdayScenario({ scenarioId: 'c', pay: {} })));
  const pubNot = toPublicComparison(notComparable);
  assert.equal(pubNot.status, 'not_comparable');
  for (const forbidden of FORBIDDEN) assert.ok(!keysDeep(pubNot).has(forbidden), forbidden);
  assert.ok(pubNot.status === 'not_comparable' && pubNot.a.status === 'computed' && pubNot.b.status === 'blocked');
});
