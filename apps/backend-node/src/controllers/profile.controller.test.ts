import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { contractBatch, payslipBatch, rawContract, rawPayslip, found, hourLine, overtimeLine } from '../test-support/fact-fixtures.js';
import { profileFieldFingerprint } from '../payroll-engine/profile-decisions.js';
import type { PayrollProfile } from '../payroll-engine/payroll-profile.js';

/**
 * P1 (§P1.2/§P1.5): `POST /api/profile/resolve` over real HTTP. Pure recombination of data the
 * client already holds (no AI call, no rate limit), so the real app is imported directly - same
 * approach as contract.controller.test.ts.
 */

let app: (typeof import('../app.js'))['default'];
let server: ReturnType<typeof app.listen>;
let baseUrl: string;

before(async () => {
  ({ default: app } = await import('../app.js'));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/** P2: documents now arrive as document-fact batches (built through the real reader mapping). */
function contractDocJson(index: number, label: string, overrides: Record<string, unknown> = {}) {
  return { index, label, role: 'contract_base', effectiveDate: null, factBatches: [contractBatch(rawContract(overrides))] };
}

function payslipDocJson(index: number, label: string, overrides: Record<string, unknown> = {}) {
  return { index, label, role: 'payslip', effectiveDate: null, factBatches: [payslipBatch(rawPayslip(overrides))] };
}

async function post(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/profile/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

type FieldJson = { state: string; value: unknown; sources: Array<{ role: string; documentLabel: string }> };
type ProfileJson = { employment: Record<string, FieldJson>; payroll: Record<string, FieldJson>; observedOvertimePremiums: { fields: FieldJson[] } };

test('P1: POST /api/profile/resolve builds a profile from a contract and a payslip over real HTTP', async () => {
  const res = await post({
    asOfDate: '2026-06-01',
    documents: [
      contractDocJson(0, 'umowa.pdf', { hourly_rate: found(16.2, 'Uurloon: € 16,20', 1, 'Uurloon'), hours_per_week: found(40, '40 uur per week', 1, 'Arbeidsduur') }),
      payslipDocJson(1, 'pasek.pdf', { hour_lines: [hourLine(), overtimeLine(150)] }),
    ],
  });
  assert.equal(res.status, 200);
  const { profile } = (await res.json()) as { profile: ProfileJson };
  assert.equal(profile.employment.hourlyRate?.state, 'corroborated');
  assert.equal(profile.employment.hoursPerWeek?.state, 'document_exact');
  // P1.1: a lone generic 150% line is observed +50 evidence, never a tier.
  assert.equal(profile.payroll.overtimeTier1Premium?.state, 'unknown');
  assert.equal(profile.payroll.overtimeTier1Premium?.value, null);
  assert.equal(profile.observedOvertimePremiums.fields[0]?.value, 50);
  assert.equal(profile.observedOvertimePremiums.fields[0]?.sources[0]?.documentLabel, 'pasek.pdf');
});

test('P1.7: audit state sent alongside a payslip is ignored - discrepancies/needsConfirmation/fullyReproduced cannot change the profile', async () => {
  const documents = [payslipDocJson(0, 'pasek.pdf', { hour_lines: [hourLine(), overtimeLine(150)] })];
  const plain = (await (await post({ asOfDate: '2026-06-01', documents })).json()) as { profile: unknown };
  const withAudit = await post({
    asOfDate: '2026-06-01',
    documents: documents.map((d) => ({
      ...d,
      fullyReproduced: false,
      discrepancies: [{ code: 'table_tax_mismatch', status: 'finding' }],
      needsConfirmation: [{ code: 'period_length_mismatch' }],
      confirmedIssueKeys: [],
    })),
  });
  assert.equal(withAudit.status, 200);
  assert.deepEqual(((await withAudit.json()) as { profile: unknown }).profile, plain.profile);
});

test('P1/P2: malformed fact batches, a role/kind mismatch or a missing batch list is rejected with invalid_input', async () => {
  const badBatch = await post({ asOfDate: '2026-06-01', documents: [{ index: 0, label: 'p.pdf', role: 'payslip', effectiveDate: null, factBatches: [{ kind: 'payslip', pages: [1] }] }] });
  assert.equal(badBatch.status, 400);
  assert.deepEqual(await badBatch.json(), { error_code: 'invalid_input' });
  const kindMismatch = await post({ asOfDate: '2026-06-01', documents: [{ index: 0, label: 'u.pdf', role: 'contract_base', effectiveDate: null, factBatches: [payslipBatch()] }] });
  assert.equal(kindMismatch.status, 400);
  const noBatches = await post({ asOfDate: '2026-06-01', documents: [{ index: 0, label: 'u.pdf', role: 'contract_base', effectiveDate: null }] });
  assert.equal(noBatches.status, 400);
  const samePageTwice = await post({ asOfDate: '2026-06-01', documents: [{ index: 0, label: 'p.pdf', role: 'payslip', effectiveDate: null, factBatches: [payslipBatch(), payslipBatch()] }] });
  assert.equal(samePageTwice.status, 400, 'one page read by two batches of one document is not a valid batch set');
  const duplicateIndex = await post({ asOfDate: '2026-06-01', documents: [contractDocJson(0, 'u.pdf'), contractDocJson(0, 'u2.pdf')] });
  assert.equal(duplicateIndex.status, 400);
});

test('P2.14: the response carries the extraction table and page coverage built from the same facts', async () => {
  const res = await post({ asOfDate: '2026-06-01', documents: [payslipDocJson(0, 'pasek.pdf', { hour_lines: [hourLine(), overtimeLine(150)] })] });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { extractionTable: Array<{ key: string; page: number | null; rawValue: string | null; destination: string; status: string }>; coverage: Array<{ index: number; processedPages: number[]; notProcessedPages: number[] }> };
  const overtime = body.extractionTable.find((r) => r.key === 'payslip.hourLine.overtime.percent');
  assert.deepEqual([overtime?.page, overtime?.destination, overtime?.status], [1, 'observedOvertimePremiums', 'exact']);
  assert.equal(overtime?.rawValue, 'Overwerk 150% 4,00 16,20 97,20');
  assert.ok(body.extractionTable.some((r) => r.key === 'payslip.printedNet' && r.status === 'absent' && r.destination === 'calibrationOnly'));
  assert.deepEqual(body.coverage, [{ index: 0, totalPages: 1, processedPages: [1], notProcessedPages: [] }]);
});

test('P3.1 S2: an optional opaque documentId (1-64 chars) is accepted and carried into provenance; empty, over-long or non-string is invalid_input', async () => {
  const longId = 'x'.repeat(64);
  const ok = await post({
    asOfDate: '2026-06-01',
    documents: [
      { ...contractDocJson(0, 'umowa.pdf', { hourly_rate: found(16.2, 'Uurloon: € 16,20', 1, 'Uurloon') }), documentId: longId },
      { ...payslipDocJson(1, 'pasek.pdf'), documentId: '1738000000000-ab12cd' },
    ],
  });
  assert.equal(ok.status, 200);
  const { profile } = (await ok.json()) as { profile: { version: number; documents: Array<{ documentId: string | null }>; employment: { hourlyRate: { state: string; sources: Array<{ documentId: string | null }> } } } };
  assert.equal(profile.version, 2);
  assert.deepEqual(profile.documents.map((d) => d.documentId), [longId, '1738000000000-ab12cd']);
  assert.deepEqual([profile.employment.hourlyRate.state, profile.employment.hourlyRate.sources.map((s) => s.documentId)], ['corroborated', [longId, '1738000000000-ab12cd']]);
  const legacy = await post({ asOfDate: '2026-06-01', documents: [payslipDocJson(0, 'pasek.pdf')] });
  assert.equal(legacy.status, 200, 'a request without documentId stays valid');
  const legacyProfile = ((await legacy.json()) as { profile: { documents: Array<{ documentId: string | null }> } }).profile;
  assert.deepEqual(legacyProfile.documents.map((d) => d.documentId), [null]);
  for (const bad of ['', 'x'.repeat(65), 42, null]) {
    const res = await post({ asOfDate: '2026-06-01', documents: [{ ...payslipDocJson(0, 'pasek.pdf'), documentId: bad }] });
    assert.equal(res.status, 400, `documentId ${JSON.stringify(bad)} is rejected`);
  }
});

test('P3.1 S3: decisions over real HTTP - fingerprint from the documentary profile, decision applied, decisionResults in request order, table and coverage unchanged', async () => {
  const documents = [
    { ...contractDocJson(0, 'umowa.pdf', { hourly_rate: found(15.55, 'Uurloon: € 15,55', 1, 'Uurloon') }), documentId: 'u-base' },
    { ...payslipDocJson(1, 'pasek.pdf'), documentId: 'u-slip' },
  ];
  const plain = await post({ asOfDate: '2026-06-01', documents });
  assert.equal(plain.status, 200);
  const first = (await plain.json()) as { profile: PayrollProfile; extractionTable: unknown[]; coverage: unknown[]; decisionResults: unknown[] };
  assert.deepEqual(first.decisionResults, [], 'no decisions: an empty result list');
  assert.deepEqual([first.profile.employment.hourlyRate.state, first.profile.employment.hourlyRate.resolution], ['conflict', null]);
  const evidenceFingerprint = profileFieldFingerprint(first.profile, 'employment.hourlyRate');
  const decisions = [
    { kind: 'confirm_candidate', decisionId: 'd-rate', fieldPath: 'employment.hourlyRate', value: 16.2, evidenceFingerprint, decidedAt: '2026-10-05T10:00:00Z' },
    { kind: 'correct_value', decisionId: 'd-hpw', fieldPath: 'employment.hoursPerWeek', value: -40, unit: 'hours_per_week', evidenceFingerprint, decidedAt: '2026-10-05' },
  ];
  const res = await post({ asOfDate: '2026-06-01', documents, decisions });
  assert.equal(res.status, 200);
  const body = (await res.json()) as typeof first;
  assert.deepEqual(body.decisionResults, [
    { decisionId: 'd-rate', fieldPath: 'employment.hourlyRate', status: 'applied', problem: null },
    { decisionId: 'd-hpw', fieldPath: 'employment.hoursPerWeek', status: 'rejected', problem: 'invalid_value' },
  ], 'a value problem is a per-decision result, not a request error');
  const rate = body.profile.employment.hourlyRate;
  assert.deepEqual([rate.state, rate.value, rate.sources.map((s) => s.role), rate.candidates.length], ['user_confirmed', 16.2, ['payslip', 'user'], 2]);
  assert.deepEqual([body.extractionTable, body.coverage], [first.extractionTable, first.coverage], 'facts as read are untouched by decisions');
});

test('P3.1 S3 #41: request validation - more than 200 decisions, a malformed decision or a duplicate documentId is invalid_input', async () => {
  const documents = [{ ...payslipDocJson(0, 'pasek.pdf'), documentId: 'u-slip' }];
  const decision = { kind: 'confirm_candidate', decisionId: 'd-1', fieldPath: 'employment.hourlyRate', value: 16.2, evidenceFingerprint: '0123456789abcdef', decidedAt: '2026-10-05T10:00:00Z' };
  const atLimit = await post({ asOfDate: '2026-06-01', documents, decisions: Array.from({ length: 200 }, (_, i) => ({ ...decision, decisionId: `d-${i}` })) });
  assert.equal(atLimit.status, 200, '200 decisions are allowed');
  const limitResults = ((await atLimit.json()) as { decisionResults: Array<{ problem: string | null }> }).decisionResults;
  assert.equal(limitResults.length, 200);
  assert.equal(limitResults.filter((r) => r.problem === 'duplicate_field_decision').length, 199);
  const tooMany = await post({ asOfDate: '2026-06-01', documents, decisions: Array.from({ length: 201 }, (_, i) => ({ ...decision, decisionId: `d-${i}` })) });
  assert.equal(tooMany.status, 400);
  const { unit: _noUnit, ...correctWithoutUnit } = { ...decision, kind: 'correct_value', unit: 'eur_per_hour' };
  for (const bad of [
    { ...decision, kind: 'approve' }, { ...decision, fieldPath: 'employment.nope' }, { ...decision, fieldPath: 'calibrationOnly.payslips.0' },
    { ...decision, fieldPath: 'observedOvertimePremiums.fields.0' }, { ...decision, evidenceFingerprint: 'NOT-A-FINGERPRINT' }, { ...decision, evidenceFingerprint: undefined },
    { ...decision, decisionId: '' }, { ...decision, decisionId: 'x'.repeat(65) }, { ...decision, decidedAt: 'yesterday' }, { ...decision, value: null }, { ...decision, value: { amount: 1 } },
    correctWithoutUnit, { ...decision, kind: 'correct_value', unit: 'eur' },
  ]) {
    const res = await post({ asOfDate: '2026-06-01', documents, decisions: [bad] });
    assert.equal(res.status, 400, `malformed decision ${JSON.stringify(bad)}`);
    assert.equal(((await res.json()) as { error_code: string }).error_code, 'invalid_input');
  }
  assert.equal((await post({ asOfDate: '2026-06-01', documents, decisions: decision })).status, 400, 'decisions must be a list');
  const duplicateIds = await post({ asOfDate: '2026-06-01', documents: [{ ...contractDocJson(0, 'umowa.pdf'), documentId: 'same' }, { ...payslipDocJson(1, 'pasek.pdf'), documentId: 'same' }] });
  assert.equal(duplicateIds.status, 400, 'two documents with one identity are rejected before anything is fingerprinted');
  assert.equal(((await duplicateIds.json()) as { error_code: string }).error_code, 'invalid_input');
  for (const documentId of ['', 'x'.repeat(65)]) assert.equal((await post({ asOfDate: '2026-06-01', documents: [{ ...payslipDocJson(0, 'pasek.pdf'), documentId }] })).status, 400);
  const differentIds = await post({ asOfDate: '2026-06-01', documents: [{ ...contractDocJson(0, 'pasek.pdf'), documentId: 'a' }, { ...payslipDocJson(1, 'pasek.pdf'), documentId: 'b' }] });
  assert.equal(differentIds.status, 200, 'the same label with different ids is fine');
});
