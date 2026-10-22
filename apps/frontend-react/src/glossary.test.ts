import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOSSARY_TERMS, filterGlossary, normalizeGlossary } from './glossary-data.ts';

test('glossary: distinct terms, multilingual labels and safe general definitions', () => {
  assert.ok(GLOSSARY_TERMS.length >= 20);
  assert.equal(new Set(GLOSSARY_TERMS.map(t => t.id)).size, GLOSSARY_TERMS.length);
  for (const term of GLOSSARY_TERMS) {
    assert.ok(term.nl.length > 1 && term.pl.length > 1 && term.en.length > 1);
    assert.ok(term.descriptionPl.length > 30 && term.descriptionEn.length > 30);
    assert.ok(['pay', 'tax', 'leave', 'contract', 'extras'].includes(term.category));
  }
});

test('glossary: search Dutch, Polish and English (case and accent insensitive)', () => {
  assert.ok(filterGlossary('loonheffing').some(t => t.nl === 'loonheffing'));
  assert.ok(filterGlossary('POTRACENIA').some(t => t.pl.includes('potrącenia')));
  assert.ok(filterGlossary('HOLIDAY allowance').some(t => t.nl === 'vakantiegeld'));
  assert.equal(normalizeGlossary('PRÓBA'), 'proba');
});

test('glossary: category filters and empty results are predictable', () => {
  assert.ok(filterGlossary('', 'tax').every(t => t.category === 'tax'));
  assert.equal(filterGlossary('not-a-real-payroll-phrase').length, 0);
  assert.ok(filterGlossary('').length >= filterGlossary('', 'pay').length);
});
