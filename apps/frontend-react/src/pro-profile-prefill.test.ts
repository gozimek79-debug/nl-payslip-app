import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { profilePrefill, unreadableFieldPathsFor, isUsableField, resolveProfile, isResolvableAsOfDate, type PayrollProfileView, type ProfileFieldView, type ProfileRequestDocument, type EvidenceState } from './pro-profile-prefill.ts';
import { translations } from './translations.ts';

/**
 * P1 (ZADANIE-P1-LOONTO-PRO.md §P1.8 #13-#15): the live PRO prefill now reads the backend Payroll
 * Profile. These tests pin (a) the pure profile -> prefill mapping (usable states only, never a
 * picked candidate, never a default) and (b) by reading ProDocuments.tsx's own source - this project
 * has no DOM test runner, and the repo already pins cross-file wiring this way (2f.9) - that the live
 * component calls the profile endpoint and no longer imports or calls the old whole-payslip gate.
 */

function field(key: string, state: EvidenceState, value: ProfileFieldView['value'], labels: string[] = ['umowa.pdf']): ProfileFieldView {
  return {
    key, meaning: key, unit: 'eur_per_hour', value, state,
    sources: labels.map((documentLabel, i) => ({ sourceType: 'document', role: 'contract_base', documentIndex: i, documentLabel, effectiveDate: null, payPeriod: null, printedLabel: null, page: null, line: null })),
    candidates: [], excluded: [], reason: state === 'unknown' ? { code: 'not_on_documents' } : state === 'conflict' ? { code: 'sources_disagree' } : null,
  };
}

function profile(employment: Record<string, ProfileFieldView>, payroll: Record<string, ProfileFieldView>, observed: ProfileFieldView[] = []): PayrollProfileView {
  return { version: 1, asOfDate: '2026-06-01', employment, payroll, recurringItems: {}, observedOvertimePremiums: { fields: observed, excluded: [] } };
}

const badge = (f: ProfileFieldView) => `${f.state}:${f.sources.map((s) => s.documentLabel).join('+')}`;

test('P1.8 #13/#14: document_exact and corroborated values prefill; conflict and unknown leave the input empty', () => {
  const prefill = profilePrefill(
    profile(
      {
        hourlyRate: field('hourlyRate', 'conflict', null, ['umowa.pdf', 'pasek.pdf']),
        hoursPerWeek: field('hoursPerWeek', 'document_exact', 40),
        overtimeThresholdHours: field('overtimeThresholdHours', 'unknown', null, []),
      },
      {
        overtimeTier1Premium: field('overtimeTier1Premium', 'corroborated', 50, ['a.pdf', 'b.pdf']),
        overtimeTier2Premium: field('overtimeTier2Premium', 'unknown', null, []),
      },
    ),
    badge,
  );
  assert.equal(prefill.hourly_rate, undefined, 'a conflict must never become a prefilled value - no candidate is picked');
  assert.equal(prefill.overtime_tier_threshold_hours, undefined);
  assert.equal(prefill.overtime_tier_2_percent, undefined);
  assert.equal(prefill.hours_per_week, 40);
  assert.equal(prefill.overtime_tier_1_percent, 50);
  assert.deepEqual(prefill.sourceLabels, { hoursPerWeek: 'document_exact:umowa.pdf', tier1Percent: 'corroborated:a.pdf+b.pdf' });
});

test('P1.8 #14: a usable state with no value is still not prefilled - and an empty profile prefills nothing at all', () => {
  assert.equal(isUsableField(field('x', 'document_exact', null)), false);
  const empty = profilePrefill(profile({}, {}), badge);
  assert.deepEqual(empty, { sourceLabels: {} }, 'no field -> no value and no badge, never a Basic default');
});

test('P1.4: unreadable paths are taken field-by-field from the issues that name them - nothing else', () => {
  assert.deepEqual(
    unreadableFieldPathsFor([
      { code: 'amount_unreadable', field: 'net_additions[0].amount' },
      { code: 'et_exchange_amount_unknown' },
      { code: 'period_length_mismatch', period_type: 'week', implied_days: 14, expected_min_days: 6, expected_max_days: 8 },
      { code: 'totals_do_not_reconcile_payout', implied_payout: 1, printed_payout: 2, residual: 1 },
    ]),
    ['net_additions[0].amount', 'et.et_exchange_amount'],
  );
});

const here = path.dirname(fileURLToPath(import.meta.url));
const proDocumentsSource = readFileSync(path.join(here, 'ProDocuments.tsx'), 'utf-8');
/** Source without comments - the file's own history comments still NAME the retired functions. */
const proDocumentsCode = proDocumentsSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

test('P1.8 #13: live ProDocuments no longer imports or calls the old whole-payslip sourcing gate', () => {
  for (const retired of ['selectMostRecentReproducedPayslip', 'derivePayslipOvertimePercents', 'isPayslipFullyReproduced', 'ReproducedPayslipCandidate', 'isFullyReproduced', 'payslipEligibleForProjection']) {
    assert.ok(!proDocumentsCode.includes(retired), `ProDocuments.tsx still references ${retired} outside comments`);
  }
  assert.ok(!/from '\.\/pro-parameter-sourcing\.ts'/.test(proDocumentsCode), 'ProDocuments.tsx must not import the old sourcing module at all');
});

test('P1.8 #13: live ProDocuments sources the projection prefill from the backend profile', () => {
  // P1.1: the endpoint call itself lives in resolveProfile (pro-profile-prefill.ts, tested above);
  // ProDocuments must reach it with the documents it just read.
  assert.ok(proDocumentsCode.includes('resolveProfile(asOfDate, profileDocuments)'), 'submitAll resolves the profile from the documents it read');
  assert.ok(/const contractPrefill[^;]*=[^;]*profilePrefill\(profile,/.test(proDocumentsCode), 'contractPrefill is built from profilePrefill(profile, ...) only');
  assert.ok(/contractPrefill=\{contractPrefill\}/.test(proDocumentsCode), 'that prefill is what the PRO calculator receives');
  // The audit state that used to unlock parameters is not part of the profile request.
  const requestBlock = proDocumentsCode.slice(proDocumentsCode.indexOf('const profileDocuments'), proDocumentsCode.indexOf('resolveProfile(asOfDate, profileDocuments)'));
  for (const auditState of ['confirmedIssueKeys', 'discrepancies', 'openNeedsConfirmation', 'visibleNeedsConfirmation']) {
    assert.ok(!requestBlock.includes(auditState), `the profile request must not carry ${auditState}`);
  }
});

test('P1.8 #15: every new profile label exists in both PL and EN', () => {
  const keys = ['profileTitle', 'profileLead', 'profileGroupEmployment', 'profileGroupPayroll', 'profileGroupRecurring', 'profileColField', 'profileColValue', 'profileColState', 'profileColSources', 'profileColReason', 'profileConflict', 'profileUnknown', 'profileEffectiveFrom', 'profileExcluded', 'profileSourceLabel', 'profileError', 'projectionFromProfile', 'projectionObservedOvertime', 'profileGroupObservedOvertime', 'profileObservedOvertimeExcluded', 'profileResolving'] as const;
  for (const key of keys) {
    assert.ok(key in translations.pl.proDocuments, `pl.proDocuments.${key} missing`);
    assert.ok(key in translations.en.proDocuments, `en.proDocuments.${key} missing`);
    assert.notEqual(String(translations.pl.proDocuments[key]), String(translations.en.proDocuments[key]), `${key} is not actually translated`);
  }
});

// --- P1.1 -------------------------------------------------------------------------------------

test('P1.1 #1/#4: observed overtime premiums never fill a tier input - tier inputs come only from the tier fields', () => {
  const tierUnknown = (key: string): ProfileFieldView => ({ ...field(key, 'unknown', null, []), reason: { code: 'tier_identity_not_evidenced' } });
  const prefill = profilePrefill(
    profile({}, { overtimeTier1Premium: tierUnknown('overtimeTier1Premium'), overtimeTier2Premium: tierUnknown('overtimeTier2Premium') }, [
      { ...field('observed_overtime_premium:25', 'document_exact', 25, ['b.pdf']), unit: 'premium_percent' },
      { ...field('observed_overtime_premium:50', 'corroborated', 50, ['a.pdf', 'b.pdf']), unit: 'premium_percent' },
    ]),
    badge,
  );
  assert.equal(prefill.overtime_tier_1_percent, undefined);
  assert.equal(prefill.overtime_tier_2_percent, undefined);
  assert.equal(prefill.sourceLabels.tier1Percent, undefined);
  assert.equal(prefill.sourceLabels.tier2Percent, undefined);
});

test('P1.1: the prefill module does not read observedOvertimePremiums at all', () => {
  const here2 = path.dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(path.join(here2, 'pro-profile-prefill.ts'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const body = code.slice(code.indexOf('export function profilePrefill'), code.indexOf('export function unreadableFieldPathsFor'));
  assert.ok(body.length > 0);
  assert.ok(!body.includes('observedOvertimePremiums'), 'profilePrefill must not map an observed premium into a tier');
});

const cachedDocuments: ProfileRequestDocument[] = [
  { index: 0, label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, contractExtraction: { hourlyRate: 15.55 } },
  { index: 1, label: 'pasek.pdf', role: 'payslip', effectiveDate: null, payslip: { period: { period_label: 'week 10/2026' }, unreadableFieldPaths: [] } },
];

test('P1.1 #9: re-resolving for a new as-of date calls only the pure profile endpoint, with the cached facts and the new date', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ profile: { ...profile({}, {}), asOfDate: '2026-10-01' } }), { status: 200 });
  }) as typeof fetch;
  const resolved = await resolveProfile('2026-10-01', cachedDocuments, fakeFetch);
  assert.deepEqual(calls.map((c) => c.url), ['/api/profile/resolve'], 'exactly one call, to the pure resolver - no document-reading endpoint');
  assert.deepEqual(calls[0]?.body, { asOfDate: '2026-10-01', documents: cachedDocuments }, 'the already-read facts are sent unchanged, with the new date');
  assert.equal(resolved?.asOfDate, '2026-10-01');
});

test('P1.1 #9: a failed re-resolve returns null (the caller shows an error, never the old profile)', async () => {
  const failing = (async () => new Response(JSON.stringify({ error_code: 'invalid_input' }), { status: 400 })) as unknown as typeof fetch;
  assert.equal(await resolveProfile('2026-10-01', cachedDocuments, failing), null);
  const throwing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  assert.equal(await resolveProfile('2026-10-01', cachedDocuments, throwing), null);
  assert.equal(isResolvableAsOfDate('2026-10-01'), true);
  assert.equal(isResolvableAsOfDate(''), false);
  assert.equal(isResolvableAsOfDate('2026-10'), false);
});

test('P1.1 #9: live ProDocuments re-resolves on an as-of date change from cached facts, never re-reading documents', () => {
  const handler = proDocumentsCode.slice(proDocumentsCode.indexOf('function changeAsOfDate'), proDocumentsCode.indexOf('async function correctNeedsConfirmationIssue'));
  assert.ok(handler.includes('resolveProfile(value, resolvedDocuments)'), 'the handler re-resolves from the cached document facts with the new date');
  assert.ok(handler.includes('setProfile(null)'), 'the old profile is cleared at once - never shown under the new date');
  assert.ok(/setSubmitCount/.test(handler), 'the calculator remounts so its prefill follows the new profile');
  for (const reread of ['processPayslip', 'processContract', 'renderPageImages', 'extractTextItems', '/api/tier-c/analyze', '/api/contracts/analyze']) {
    assert.ok(!handler.includes(reread), `the date handler must not re-read documents (${reread})`);
  }
  assert.ok(/type="date" value=\{asOfDate\} disabled=\{submitting\} onChange=\{\(event\) => changeAsOfDate\(event\.target\.value\)\}/.test(proDocumentsCode), 'the as-of date input goes through changeAsOfDate and is locked while documents are being read');
  assert.ok(proDocumentsCode.includes('setResolvedDocuments(profileDocuments)'), 'submitAll caches the facts it resolved');
  assert.ok(proDocumentsCode.includes('hasSubmitted && !resolvingProfile'), 'the calculator is not shown while a re-resolution is in flight');
});
