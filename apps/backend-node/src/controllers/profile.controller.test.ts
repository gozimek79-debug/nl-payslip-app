import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

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

/** The exact JSON shape /api/tier-c/analyze returns as `period` (every PayslipPeriod key present). */
function periodJson(overrides: Record<string, unknown> = {}) {
  return {
    period_label: 'week 10/2026', period_type: 'week', period_type_confirmed: true, period_end_date: '2026-03-08',
    is_correction: false, version: 1, employers: [{ name: 'Synthetic Uitzend B.V.', franchise_bearing: true }], hirer: null,
    contract_hours: null,
    hour_lines: [
      { employer_index: 0, description: 'Uren', hours: 40, rate: 16.2, percent: null, amount: 648, category: 'regular', tax_treatment: 'table', adds_hours: true },
      { employer_index: 0, description: 'Overwerk 150%', hours: 10, rate: 16.2, percent: 150, amount: 243, category: 'overtime', adds_hours: true },
    ],
    pre_tax_deductions: [],
    bijzonder_tarief: { jaarloon_bt: null, bt_state: 'not_applicable', tarief_bt: { printed: null, computed: null } },
    et: null, post_tax_social: [], net_additions: [], net_deductions: [], payout_adjustments: [], reservations: [],
    wml_printed: null, wml_applicable: null,
    printed_table_tax: null, printed_bt_tax: null, printed_algemene_heffingskorting: null, printed_arbeidskorting: null,
    printed_net: null, printed_payout: null, printed_gross_total: null, printed_loon_voor_heffingen: null,
    printed_taxable_base_normal: null, printed_taxable_base_special: null,
    printed_table_tax_label: null, printed_bt_tax_label: null, printed_algemene_heffingskorting_label: null,
    printed_arbeidskorting_label: null, printed_net_label: null, printed_payout_label: null,
    ...overrides,
  };
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
      { index: 0, label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, contractExtraction: blankExtraction({ hourlyRate: 16.2, hoursPerWeek: 40 }) },
      { index: 1, label: 'pasek.pdf', role: 'payslip', effectiveDate: null, payslip: { period: periodJson(), unreadableFieldPaths: [] } },
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
  const documents = [{ index: 0, label: 'pasek.pdf', role: 'payslip', effectiveDate: null, payslip: { period: periodJson(), unreadableFieldPaths: [] } }];
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

test('P1: a malformed payslip period or a contract entry without an extraction is rejected with invalid_input', async () => {
  const badPeriod = await post({ asOfDate: '2026-06-01', documents: [{ index: 0, label: 'p.pdf', role: 'payslip', effectiveDate: null, payslip: { period: { hour_lines: [] }, unreadableFieldPaths: [] } }] });
  assert.equal(badPeriod.status, 400);
  assert.deepEqual(await badPeriod.json(), { error_code: 'invalid_input' });
  const noExtraction = await post({ asOfDate: '2026-06-01', documents: [{ index: 0, label: 'u.pdf', role: 'contract_base', effectiveDate: null }] });
  assert.equal(noExtraction.status, 400);
  const duplicateIndex = await post({
    asOfDate: '2026-06-01',
    documents: [
      { index: 0, label: 'u.pdf', role: 'contract_base', effectiveDate: null, contractExtraction: blankExtraction() },
      { index: 0, label: 'u2.pdf', role: 'contract_base', effectiveDate: null, contractExtraction: blankExtraction() },
    ],
  });
  assert.equal(duplicateIndex.status, 400);
});
