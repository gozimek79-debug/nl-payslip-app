import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectiveContract, type ContractDocumentEntry } from './contract-timeline.js';
import type { ContractExtraction } from './contract.js';

/**
 * Stage 3.0 (audit v40, §3.0.4): "an annex overriding part of a base contract's terms while
 * leaving the rest; disagreement between two documents producing unknown with a reason, not a
 * guess." Tests for the timeline resolver introduced this round.
 */

function baseExtraction(overrides: Partial<ContractExtraction>): ContractExtraction {
  return {
    contractType: null, employerName: null, functionTitle: null, startDate: null, endDate: null,
    hoursPerWeek: null, hourlyRate: null, monthlySalary: null, caoName: null, pensionFund: null,
    probationPeriodWeeks: null, noticePeriodWeeks: null, thirtyPercentRuling: false,
    overtimeTierThresholdHours: null, guaranteedHours: null, guaranteedHoursPeriodWeeks: null,
    redactedFields: [],
    ...overrides,
  };
}

function doc(role: ContractDocumentEntry['role'], effectiveDate: string | null, label: string, overrides: Partial<ContractExtraction>): ContractDocumentEntry {
  return { role, effectiveDate, label, extraction: baseExtraction(overrides) };
}

test('3.0.4: a base-only contract resolves every field it sets, sourced to itself', () => {
  const base = doc('base', null, 'base contract', { hourlyRate: 15.55, hoursPerWeek: 40 });
  const effective = resolveEffectiveContract([base], '2026-06-01');
  assert.equal(effective.hourlyRate.value, 15.55);
  assert.deepEqual(effective.hourlyRate.source, { documentIndex: 0, role: 'base', label: 'base contract', effectiveDate: null });
  assert.equal(effective.hoursPerWeek.value, 40);
  assert.equal(effective.caoName.value, null, 'a field neither document sets stays null');
  assert.equal(effective.caoName.reason, null, 'an ordinary absence carries no reason - nothing disagreed or failed to place');
});

test('3.0.4: an annex overrides only the field it states, leaving the rest of the base contract as it was', () => {
  const base = doc('base', null, 'base contract', { hourlyRate: 15.55, hoursPerWeek: 40, caoName: 'ABU-CAO' });
  const annex = doc('annex', '2026-03-01', 'annex 1', { hourlyRate: 16.20 }); // only the rate changes
  const effective = resolveEffectiveContract([base, annex], '2026-06-01');
  assert.equal(effective.hourlyRate.value, 16.20, 'the annex value wins');
  assert.equal(effective.hourlyRate.source?.label, 'annex 1');
  assert.equal(effective.hoursPerWeek.value, 40, 'untouched by the annex - the base value carries over');
  assert.equal(effective.hoursPerWeek.source?.label, 'base contract');
  assert.equal(effective.caoName.value, 'ABU-CAO', 'also untouched - the annex never mentioned it');
});

test('3.0.4: an annex whose effective date is still in the future (relative to the asked-about date) does not apply yet - the base value stands', () => {
  const base = doc('base', null, 'base contract', { hourlyRate: 15.55 });
  const annex = doc('annex', '2026-09-01', 'annex 1', { hourlyRate: 16.20 });
  const effective = resolveEffectiveContract([base, annex], '2026-06-01'); // before the annex's own effective date
  assert.equal(effective.hourlyRate.value, 15.55, 'the not-yet-effective annex must not override');
  assert.equal(effective.hourlyRate.source?.label, 'base contract');
});

test('3.0.4: two annexes on the same field - the later effective date wins', () => {
  const base = doc('base', null, 'base contract', { hourlyRate: 15.55 });
  const annexOld = doc('annex', '2026-03-01', 'annex 1', { hourlyRate: 16.20 });
  const annexNew = doc('annex', '2026-05-01', 'annex 2', { hourlyRate: 17.00 });
  const effective = resolveEffectiveContract([base, annexOld, annexNew], '2026-06-01');
  assert.equal(effective.hourlyRate.value, 17.00);
  assert.equal(effective.hourlyRate.source?.label, 'annex 2');
});

test('3.0.4: two documents disagreeing at the same effective date produce unknown with a reason naming both, never a guess', () => {
  const base = doc('base', null, 'base contract', { hourlyRate: 15.55 });
  const annexA = doc('annex', '2026-03-01', 'annex A', { hourlyRate: 16.00 });
  const annexB = doc('annex', '2026-03-01', 'annex B', { hourlyRate: 16.50 }); // same date, different value
  const effective = resolveEffectiveContract([base, annexA, annexB], '2026-06-01');
  assert.equal(effective.hourlyRate.value, null, 'never guessed which of the two is right');
  assert.deepEqual(effective.hourlyRate.reason, { code: 'disagreement', documentLabels: ['annex A', 'annex B'], asOfDate: '2026-06-01' });
});

test("3.0.4: an unreadable annex effective date - 'no annex dated after 1 March' shape - falls back to the base value, with a distinct reason naming the undated annex only when nothing else sets the field", () => {
  const base = doc('base', null, 'base contract', { hourlyRate: 15.55 });
  const undatedAnnex = doc('annex', null, 'annex with unread date', { hourlyRate: 16.20 });
  const effective = resolveEffectiveContract([base, undatedAnnex], '2026-06-01');
  // hourlyRate: the base DOES set it, so the annex's unreadable date is not the only story - the
  // base value still stands (never silently discarded because ONE OTHER document had a problem).
  assert.equal(effective.hourlyRate.value, 15.55);
  assert.equal(effective.hourlyRate.source?.label, 'base contract');

  // caoName: ONLY the undated annex would have set it, and nothing else does - this is where the
  // undated-document reason actually surfaces, since there is no fallback value to report instead.
  const undatedOnlyBase = doc('base', null, 'base contract', {});
  const undatedOnlyAnnex = doc('annex', null, 'annex with unread date', { caoName: 'ABU-CAO' });
  const effectiveNoFallback = resolveEffectiveContract([undatedOnlyBase, undatedOnlyAnnex], '2026-06-01');
  assert.equal(effectiveNoFallback.caoName.value, null);
  assert.deepEqual(effectiveNoFallback.caoName.reason, { code: 'undated_document', documentLabel: 'annex with unread date' });
});

test('3.0.4: a document with no value for a field never displaces one that does, regardless of role or date', () => {
  const base = doc('base', null, 'base contract', { hourlyRate: 15.55, caoName: 'ABU-CAO' });
  const annex = doc('annex', '2026-03-01', 'annex 1', { hourlyRate: null }); // annex says nothing about the rate
  const effective = resolveEffectiveContract([base, annex], '2026-06-01');
  assert.equal(effective.hourlyRate.value, 15.55, 'a null in the annex must not be treated as an override to null');
});

/**
 * Stage 3.0.5 (audit v41): "the blank annex date gap." RAPORT-cursor-3.0.md's own live
 * reproduction: `effectiveDate === null` was the only check for "undated" - a blank string ('')
 * satisfied neither the undated branch nor a real date's ordering, so it slipped through as if it
 * were a real, very-early date, tying with (and discarding) a known base value via a false
 * "disagreement". Fixed via `hasUsableEffectiveDate`, shared by both the applicability and the
 * undated checks - these two tests mirror the existing null-date tests exactly, with '' in place
 * of null, to prove the two cases are now handled identically.
 */
test("3.0.5: an annex with effectiveDate: '' (a cleared date field, not a genuinely unread one) setting a field the base ALSO sets - the base value must survive, never a false disagreement", () => {
  const base = doc('base', null, 'base contract', { hourlyRate: 15.55 });
  const blankAnnex = doc('annex', '', 'blank date', { hourlyRate: 99 });
  const effective = resolveEffectiveContract([base, blankAnnex], '2026-06-01');
  assert.equal(effective.hourlyRate.value, 15.55, `expected the known base value to survive, got ${JSON.stringify(effective.hourlyRate)}`);
  assert.equal(effective.hourlyRate.source?.label, 'base contract');
  assert.equal(effective.hourlyRate.reason, null, 'must not be reported as a disagreement between base and a blank-dated annex');
});

test("3.0.5: an annex with effectiveDate: '' setting a field NOTHING ELSE sets - undated_document, exactly like the existing null-date case", () => {
  const base = doc('base', null, 'base contract', {});
  const blankAnnex = doc('annex', '', 'blank date', { caoName: 'ABU-CAO' });
  const effective = resolveEffectiveContract([base, blankAnnex], '2026-06-01');
  assert.equal(effective.caoName.value, null);
  assert.deepEqual(effective.caoName.reason, { code: 'undated_document', documentLabel: 'blank date' });
});
