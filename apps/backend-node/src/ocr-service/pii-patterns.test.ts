import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeText } from './pii-patterns.js';

test('sanitizeText passes through ordinary payslip line descriptions', () => {
  const redacted: string[] = [];
  assert.equal(sanitizeText('Loon onregelm. uren 100%', 'lineItems[0].description', redacted), 'Loon onregelm. uren 100%');
  assert.equal(redacted.length, 0);
});

test('sanitizeText redacts a BSN-shaped 9-digit number embedded in free text (audit R7/J3)', () => {
  const redacted: string[] = [];
  const result = sanitizeText('BSN 123456789 correctie', 'lineItems[2].description', redacted);
  assert.equal(result, null);
  assert.deepEqual(redacted, ['lineItems[2].description']);
});

test('sanitizeText redacts an IBAN', () => {
  const redacted: string[] = [];
  assert.equal(sanitizeText('Uitbetaald op NL12INGB0114368236', 'lineItems[5].description', redacted), null);
  assert.deepEqual(redacted, ['lineItems[5].description']);
});

test('sanitizeText redacts an email address', () => {
  const redacted: string[] = [];
  assert.equal(sanitizeText('Contact: jan.kowalski@example.com', 'lineItems[1].section', redacted), null);
  assert.deepEqual(redacted, ['lineItems[1].section']);
});

test('sanitizeText redacts an NL mobile number', () => {
  const redacted: string[] = [];
  assert.equal(sanitizeText('bel 06-12345678', 'lineItems[3].description', redacted), null);
  assert.deepEqual(redacted, ['lineItems[3].description']);
});
