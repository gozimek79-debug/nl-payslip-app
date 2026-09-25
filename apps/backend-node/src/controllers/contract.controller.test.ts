import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

/**
 * Stage 3.0 (audit v40, §3.0.4): the HTTP boundary for the new `/api/contracts/resolve-timeline`
 * route - no existing test file covered `contract.controller.ts` at the HTTP level at all (2n's own
 * survey confirmed this). This route needs no vision call and no AI rate limit (a pure recombination
 * of already-extracted data, the same shape as tier-c's own `/recompute`), so - unlike
 * `tier-c.controller.test.ts` - no module mocking is needed here at all; the real app can be
 * imported directly.
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

function blankExtraction(overrides: Record<string, unknown> = {}) {
  return {
    contractType: null, employerName: null, functionTitle: null, startDate: null, endDate: null,
    hoursPerWeek: null, hourlyRate: null, monthlySalary: null, caoName: null, pensionFund: null,
    probationPeriodWeeks: null, noticePeriodWeeks: null, thirtyPercentRuling: false,
    overtimeTierThresholdHours: null, guaranteedHours: null, guaranteedHoursPeriodWeeks: null,
    redactedFields: [],
    ...overrides,
  };
}

test('3.0.4: POST /api/contracts/resolve-timeline merges a base contract and an overriding annex correctly over real HTTP', async () => {
  const res = await fetch(`${baseUrl}/api/contracts/resolve-timeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asOfDate: '2026-06-01',
      documents: [
        { role: 'base', effectiveDate: null, label: 'base contract', extraction: blankExtraction({ hourlyRate: 15.55, hoursPerWeek: 40 }) },
        { role: 'annex', effectiveDate: '2026-03-01', label: 'annex 1', extraction: blankExtraction({ hourlyRate: 16.20 }) },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { effectiveContract?: Record<string, { value: unknown; source: { label: string } | null; reason: unknown }> };
  assert.equal(body.effectiveContract?.hourlyRate?.value, 16.20, `expected the annex to win on hourlyRate, got ${JSON.stringify(body.effectiveContract?.hourlyRate)}`);
  assert.equal(body.effectiveContract?.hourlyRate?.source?.label, 'annex 1');
  assert.equal(body.effectiveContract?.hoursPerWeek?.value, 40, `expected the untouched base value to carry over, got ${JSON.stringify(body.effectiveContract?.hoursPerWeek)}`);
});

test('3.0.4: POST /api/contracts/resolve-timeline reports a genuine disagreement as unknown with a reason, over real HTTP', async () => {
  const res = await fetch(`${baseUrl}/api/contracts/resolve-timeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      asOfDate: '2026-06-01',
      documents: [
        { role: 'base', effectiveDate: null, label: 'base contract', extraction: blankExtraction({ hourlyRate: 15.55 }) },
        { role: 'annex', effectiveDate: '2026-03-01', label: 'annex A', extraction: blankExtraction({ hourlyRate: 16.00 }) },
        { role: 'annex', effectiveDate: '2026-03-01', label: 'annex B', extraction: blankExtraction({ hourlyRate: 16.50 }) },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { effectiveContract?: Record<string, { value: unknown; reason: { code: string; documentLabels: string[] } | null }> };
  assert.equal(body.effectiveContract?.hourlyRate?.value, null);
  assert.equal(body.effectiveContract?.hourlyRate?.reason?.code, 'disagreement');
  assert.deepEqual(body.effectiveContract?.hourlyRate?.reason?.documentLabels, ['annex A', 'annex B']);
});

test('3.0.4: POST /api/contracts/resolve-timeline answers 400 invalid_input on a malformed body (missing extraction fields), never a 500 crash', async () => {
  const res = await fetch(`${baseUrl}/api/contracts/resolve-timeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asOfDate: '2026-06-01', documents: [{ role: 'base', effectiveDate: null, label: 'x', extraction: { hourlyRate: 15.55 } }] }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error_code?: string };
  assert.equal(body.error_code, 'invalid_input');
});

test('3.0.4: POST /api/contracts/resolve-timeline answers 400 invalid_input on an empty documents array', async () => {
  const res = await fetch(`${baseUrl}/api/contracts/resolve-timeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ asOfDate: '2026-06-01', documents: [] }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error_code?: string };
  assert.equal(body.error_code, 'invalid_input');
});
