import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { profilePrefill, unreadableFieldPathsFor, isUsableField, type PayrollProfileView, type ProfileFieldView, type EvidenceState } from './pro-profile-prefill.ts';
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

function profile(employment: Record<string, ProfileFieldView>, payroll: Record<string, ProfileFieldView>): PayrollProfileView {
  return { version: 1, asOfDate: '2026-06-01', employment, payroll, recurringItems: {} };
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
  assert.ok(proDocumentsCode.includes("fetch('/api/profile/resolve'"), 'the profile endpoint is called');
  assert.ok(/const contractPrefill[^;]*=[^;]*profilePrefill\(profile,/.test(proDocumentsCode), 'contractPrefill is built from profilePrefill(profile, ...) only');
  assert.ok(/contractPrefill=\{contractPrefill\}/.test(proDocumentsCode), 'that prefill is what the PRO calculator receives');
  // The audit state that used to unlock parameters is not part of the profile request.
  const requestBlock = proDocumentsCode.slice(proDocumentsCode.indexOf('const profileDocuments'), proDocumentsCode.indexOf("fetch('/api/profile/resolve'"));
  for (const auditState of ['confirmedIssueKeys', 'discrepancies', 'openNeedsConfirmation', 'visibleNeedsConfirmation']) {
    assert.ok(!requestBlock.includes(auditState), `the profile request must not carry ${auditState}`);
  }
});

test('P1.8 #15: every new profile label exists in both PL and EN', () => {
  const keys = ['profileTitle', 'profileLead', 'profileGroupEmployment', 'profileGroupPayroll', 'profileGroupRecurring', 'profileColField', 'profileColValue', 'profileColState', 'profileColSources', 'profileColReason', 'profileConflict', 'profileUnknown', 'profileEffectiveFrom', 'profileExcluded', 'profileSourceLabel', 'profileError', 'projectionFromProfile', 'projectionAdditionalTiers'] as const;
  for (const key of keys) {
    assert.ok(key in translations.pl.proDocuments, `pl.proDocuments.${key} missing`);
    assert.ok(key in translations.en.proDocuments, `en.proDocuments.${key} missing`);
    assert.notEqual(String(translations.pl.proDocuments[key]), String(translations.en.proDocuments[key]), `${key} is not actually translated`);
  }
});
