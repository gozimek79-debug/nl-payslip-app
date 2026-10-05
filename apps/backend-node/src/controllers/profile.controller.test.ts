import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { contractBatch, payslipBatch, rawContract, rawPayslip, found, hourLine, overtimeLine } from '../test-support/fact-fixtures.js';

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
