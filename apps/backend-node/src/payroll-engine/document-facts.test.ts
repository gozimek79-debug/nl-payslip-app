import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePayslipBatches, mergeContractBatches, payslipFactsToTierCExtraction, contractExtractionFromFacts } from './document-facts.js';
import { resolvePayrollProfile } from './payroll-profile.js';
import { payslipBatch, contractBatch, rawPayslip, rawContract, found, ambiguous, hourLine, overtimeLine } from '../test-support/fact-fixtures.js';

/**
 * P2 (ZADANIE-P2-LOONTO-PRO.md §P2.9/§P2.10/§P2.4): deterministic same-document batch merging, page
 * coverage, and the bridge from facts to the (internal, diagnostic) historical replay.
 */

test('P2.17 #16: the same fact read on two pages of ONE document stays one source - document_exact, never corroborated', () => {
  const first = contractBatch(rawContract({ hourly_rate: found(16.2, 'Uurloon € 16,20', 1, 'Uurloon') }), [1, 2, 3], 6);
  const second = contractBatch(rawContract({ hourly_rate: found(16.2, 'het uurloon van € 16,20', 5, 'Bijlage') }), [4, 5, 6], 6);
  const facts = mergeContractBatches([second, first]); // order of arrival must not matter
  assert.deepEqual(facts.scalars.hourlyRate.map((f) => [f.status, f.value, f.evidence.page]), [['exact', 16.2, 1], ['exact', 16.2, 5]]);
  assert.deepEqual(facts.coverage, { totalPages: 6, processedPages: [1, 2, 3, 4, 5, 6], notProcessedPages: [] });
  const profile = resolvePayrollProfile({ asOfDate: '2026-06-01', documents: [{ index: 0, label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, facts }] });
  assert.equal(profile.employment.hourlyRate.state, 'document_exact');
  assert.deepEqual(profile.employment.hourlyRate.sources.map((s) => [s.documentIndex, s.page]), [[0, 1], [0, 5]], 'both pages are kept as evidence of the one document');
});

test('P2.17 #17: two different values for one fact inside one document stay visible - a same-document conflict, no value chosen', () => {
  const facts = mergeContractBatches([
    contractBatch(rawContract({ hourly_rate: found(16.2, 'Uurloon € 16,20', 1, 'Uurloon') }), [1, 2, 3], 6),
    contractBatch(rawContract({ hourly_rate: found(16.5, 'Uurloon € 16,50', 5, 'Uurloon') }), [4, 5, 6], 6),
  ]);
  assert.deepEqual(facts.scalars.hourlyRate.map((f) => [f.status, f.reason, f.value, f.evidence.page]), [
    ['ambiguous', 'same_document_contradiction', 16.2, 1],
    ['ambiguous', 'same_document_contradiction', 16.5, 5],
  ]);
  assert.equal(contractExtractionFromFacts(facts).hourlyRate, null, 'the timeline never receives one side of a contradiction as "the" value');
  const profile = resolvePayrollProfile({ asOfDate: '2026-06-01', documents: [{ index: 0, label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, facts }] });
  const rate = profile.employment.hourlyRate;
  assert.equal(rate.state, 'conflict');
  assert.equal(rate.value, null);
  assert.deepEqual(rate.candidates.map((c) => [c.value, c.source.page]), [[16.2, 1], [16.5, 5]]);
});

test('P2.17 #15: pages no batch read are reported, never hidden - coverage is derived from the batches themselves', () => {
  const facts = mergePayslipBatches([payslipBatch(rawPayslip(), [1, 2, 3], 8), payslipBatch(rawPayslip({ period_label: found('week 10/2026', 'week 10/2026', 4) }), [4, 5, 6], 8)]);
  assert.deepEqual(facts.coverage, { totalPages: 8, processedPages: [1, 2, 3, 4, 5, 6], notProcessedPages: [7, 8] });
  assert.equal(payslipFactsToTierCExtraction(facts).truncated, true, 'the replay is told the read is incomplete');
});

test('P2.4: the replay bridge carries every readable fact; an unknown period type only makes the replay itself impossible', () => {
  const facts = mergePayslipBatches([payslipBatch(rawPayslip({
    period_type: ambiguous('Periode 10'),
    hour_lines: [hourLine(), overtimeLine(150, { unclear_fields: ['amount'] })],
    deduction_lines: [{ description: 'Pensioen StiPP', placement: 'pre_tax', category: 'other', percent: 7.5, base: 295.06, amount: 22.13, raw: 'Pensioen StiPP 7,50% 295,06 22,13', page: 1, unclear_fields: [] }],
    printed_net: found(512.34, 'Netto loon 512,34', 1, 'Netto loon'),
  }))]);
  const extraction = payslipFactsToTierCExtraction(facts);
  assert.equal(extraction.period_type, null);
  assert.equal(extraction.hour_lines.length, 2);
  assert.equal(extraction.hour_lines[0]?.rate, 16.2);
  assert.deepEqual(extraction.unreadable_amount_fields, ['hour_lines[1].amount'], 'an unread amount is a known gap for the replay, never a silent zero');
  assert.equal(extraction.pre_tax_deduction_lines[0]?.category, 'pension', 'the label decides the deduction family (stage 2e rule, unchanged)');
  assert.deepEqual([extraction.reported_total_net, extraction.printed_net_label], [512.34, 'Netto loon']);
  assert.deepEqual(extraction.employer_names, ['Synthetic Uitzend B.V.']);
});
