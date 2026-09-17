import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapHourCategory, mapTaxTreatment, mapPreTaxCategory, mapPostTaxCategory, mapNetCategory, mapReservationType, mapPeriodType, normalizeCode } from './ocr-client.js';

/**
 * v17 (audit): the live Olympia run on Mistral found "AZW werknemer" recognised as ziektewet by
 * extraction-consistency.ts's own keyword backstop, yet mapped to category "other" by extraction
 * itself. The prompt already asks for "AZW"->"ziektewet" explicitly; a strict `===` match against a
 * lowercase literal is exactly the kind of place a model returning "Ziektewet" (correct meaning,
 * different casing) would silently fall through to "other" with no trace. These tests prove the
 * mapping layer now tolerates that, and that it still correctly rejects a genuinely wrong/unknown
 * value rather than becoming permissive to the point of guessing.
 */

test('2c/v17: normalizeCode trims and lowercases; non-strings and empty values become null', () => {
  assert.equal(normalizeCode('Ziektewet'), 'ziektewet');
  assert.equal(normalizeCode('  ziektewet  '), 'ziektewet');
  assert.equal(normalizeCode('ZIEKTEWET'), 'ziektewet');
  assert.equal(normalizeCode(null), null);
  assert.equal(normalizeCode(undefined), null);
  assert.equal(normalizeCode(42), null);
});

test('2c/v17: mapPreTaxCategory tolerates case/whitespace variance - the actual Olympia failure', () => {
  assert.equal(mapPreTaxCategory('ziektewet'), 'ziektewet');
  assert.equal(mapPreTaxCategory('Ziektewet'), 'ziektewet');
  assert.equal(mapPreTaxCategory(' ZIEKTEWET '), 'ziektewet');
  assert.equal(mapPreTaxCategory('Pension'), 'pension');
  assert.equal(mapPreTaxCategory('PAWW'), 'paww');
  assert.equal(mapPreTaxCategory('Wga_Gat'), 'wga_gat');
});

test('2c/v17: mapPreTaxCategory still falls back to "other" for a genuinely unrecognized value - not permissive to the point of guessing', () => {
  assert.equal(mapPreTaxCategory('something-else'), 'other');
  assert.equal(mapPreTaxCategory(null), 'other');
  assert.equal(mapPreTaxCategory(undefined), 'other');
  assert.equal(mapPreTaxCategory(''), 'other');
});

test('2c/v17: mapPostTaxCategory tolerates case variance', () => {
  assert.equal(mapPostTaxCategory('WHK'), 'whk');
  assert.equal(mapPostTaxCategory('Gediff_Wga'), 'gediff_wga');
  assert.equal(mapPostTaxCategory('wga'), 'wga');
  assert.equal(mapPostTaxCategory('unknown-thing'), 'other');
});

test('2c/v17: mapHourCategory and mapTaxTreatment tolerate case variance', () => {
  assert.equal(mapHourCategory('Overtime'), 'overtime');
  assert.equal(mapHourCategory('IRREGULAR_SURCHARGE'), 'irregular_surcharge');
  assert.equal(mapHourCategory('nonsense'), 'other');
  assert.equal(mapTaxTreatment('Table'), 'table');
  assert.equal(mapTaxTreatment('BT'), 'bt');
  assert.equal(mapTaxTreatment('nonsense'), 'unknown');
});

test('2c/v17: mapNetCategory and mapReservationType tolerate case variance', () => {
  assert.equal(mapNetCategory('Reimbursement'), 'reimbursement');
  assert.equal(mapNetCategory('HEALTH_INSURANCE'), 'health_insurance');
  assert.equal(mapNetCategory('nonsense'), 'other');
  assert.equal(mapReservationType('Vakantiegeld'), 'vakantiegeld');
  assert.equal(mapReservationType('VAKANTIEDAGEN_BOVENWETTELIJK'), 'vakantiedagen_bovenwettelijk');
  assert.equal(mapReservationType('nonsense'), 'other');
});

test('2c/v17: mapPeriodType tolerates case variance and rejects unknown values as null (never a guessed default)', () => {
  assert.equal(mapPeriodType('Week'), 'week');
  assert.equal(mapPeriodType('4-WEEKLY'), '4-weekly');
  assert.equal(mapPeriodType('Month'), 'month');
  assert.equal(mapPeriodType('nonsense'), null);
  assert.equal(mapPeriodType(null), null);
});
