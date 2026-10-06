import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { profilePrefill, isUsableField, resolveProfile, isResolvableAsOfDate, type PayrollProfileView, type ProfileFieldView, type ProfileRequestDocument, type EvidenceState, type ProfileDecisionView, type ProfileIssueView, type CalculationReadinessView, type RequirementsView, REQUIREMENT_GROUP_IDS_VIEW } from './pro-profile-prefill.ts';
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
  return { version: 2, asOfDate: '2026-06-01', employment, payroll, recurringItems: {}, observedOvertimePremiums: { fields: observed, excluded: [] }, contractContext: { annexDates: [] } };
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
  const keys = ['profileTitle', 'profileLead', 'profileGroupEmployment', 'profileGroupPayroll', 'profileGroupRecurring', 'profileColField', 'profileColValue', 'profileColState', 'profileColSources', 'profileColReason', 'profileConflict', 'profileUnknown', 'profileEffectiveFrom', 'profileExcluded', 'profileSourceLabel', 'profileError', 'projectionFromProfile', 'projectionObservedOvertime', 'profileGroupObservedOvertime', 'profileObservedOvertimeExcluded', 'profileResolving', 'pagesNotProcessed', 'pagesReasonTooLong', 'pagesReasonBatchFailed', 'payslipReplayUnavailable', 'profilePage', 'annexDateLine', 'extractionTableTitle', 'extractionColDocument', 'extractionColKey', 'extractionColValue', 'extractionColRaw', 'extractionColPage', 'extractionColLabel', 'extractionColStatus', 'extractionColDestination'] as const;
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
  const body = code.slice(code.indexOf('export function profilePrefill'), code.indexOf('export function isResolvableAsOfDate'));
  assert.ok(body.length > 0);
  assert.ok(!body.includes('observedOvertimePremiums'), 'profilePrefill must not map an observed premium into a tier');
});

// P2: the cached facts are each document's fact batches, exactly as /api/pro/*-facts returned them.
const cachedDocuments: ProfileRequestDocument[] = [
  { index: 0, label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, factBatches: [{ kind: 'contract', pages: [1], totalPages: 1 }] },
  { index: 1, label: 'pasek.pdf', role: 'payslip', effectiveDate: null, factBatches: [{ kind: 'payslip', pages: [1], totalPages: 1 }] },
];

test('P1.1 #9: re-resolving for a new as-of date calls only the pure profile endpoint, with the cached facts and the new date', async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ profile: { ...profile({}, {}), asOfDate: '2026-10-01' }, extractionTable: [{ key: 'contract.hourlyRate' }] }), { status: 200 });
  }) as typeof fetch;
  const resolved = await resolveProfile('2026-10-01', cachedDocuments, fakeFetch);
  assert.deepEqual(calls.map((c) => c.url), ['/api/profile/resolve'], 'exactly one call, to the pure resolver - no document-reading endpoint');
  assert.deepEqual(calls[0]?.body, { asOfDate: '2026-10-01', documents: cachedDocuments }, 'the already-read facts are sent unchanged, with the new date');
  assert.equal(resolved?.profile.asOfDate, '2026-10-01');
  assert.equal(resolved?.extractionTable.length, 1, 'P2: the extraction table comes back with the profile');
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
  for (const reread of ['readDocument', 'renderPageImages', 'readDocumentSource', '/api/pro/', '/api/tier-c/analyze', '/api/contracts/analyze']) {
    assert.ok(!handler.includes(reread), `the date handler must not re-read documents (${reread})`);
  }
  assert.ok(/type="date" value=\{asOfDate\} disabled=\{submitting\} onChange=\{\(event\) => changeAsOfDate\(event\.target\.value\)\}/.test(proDocumentsCode), 'the as-of date input goes through changeAsOfDate and is locked while documents are being read');
  assert.ok(proDocumentsCode.includes('setResolvedDocuments(profileDocuments)'), 'submitAll caches the facts it resolved');
  assert.ok(proDocumentsCode.includes('hasSubmitted && !resolvingProfile'), 'the calculator is not shown while a re-resolution is in flight');
});

// --- P2 ---------------------------------------------------------------------------------------

test('P2.17 #18/#3: the live PRO read path uses the fact routes only - no Tier C reader, no contract-analysis (Groq) route', () => {
  assert.ok(proDocumentsCode.includes('/api/pro/${kind}-facts'), 'documents are read through the PRO fact routes');
  assert.ok(proDocumentsCode.includes('planDocumentBatches(source)'), 'every document is planned into page batches');
  assert.ok(!proDocumentsCode.includes('/api/tier-c/analyze'), 'the whole-payslip reader is no longer on the PRO path');
  assert.ok(!proDocumentsCode.includes('/api/contracts/analyze'), 'the contract route that adds Groq translation/explanation is no longer on the PRO path');
  assert.ok(proDocumentsCode.includes("fetch('/api/pro/payslip-replay'"), 'the diagnostic replay is computed from the same facts, without a second read');
});

test('P2.4: a payslip whose replay is unavailable is still sent to the profile - only read status and its own facts decide', () => {
  const block = proDocumentsCode.slice(proDocumentsCode.indexOf('const profileDocuments'), proDocumentsCode.indexOf('resolveProfile(asOfDate, profileDocuments)'));
  assert.ok(block.includes("e.status !== 'done' || !e.factBatches"), 'membership depends only on the document having been read');
  for (const auditOrReplay of ['payslipBlocked', 'payslipAnalysis', 'discrepancies', 'needsConfirmation', 'confirmedIssueKeys']) {
    assert.ok(!block.includes(auditOrReplay), `the profile request must not depend on ${auditOrReplay}`);
  }
  assert.ok(block.includes('factBatches: e.factBatches'));
});

test('P2.17 #15: local-ocr reads every page of a document; the old three-page cap applies only to callers that pass no pages', () => {
  const ocr = readFileSync(path.join(here, 'local-ocr.ts'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const source = ocr.slice(ocr.indexOf('export async function readDocumentSource'), ocr.indexOf('export async function photoWithinBudget'));
  assert.ok(source.includes('pageNumber <= pdf.numPages'), 'text/page discovery covers every page');
  assert.ok(!source.includes('Math.min(pdf.numPages, 3)'));
  assert.ok(/const wanted = pageNumbers \?\? /.test(ocr), 'an explicit page list (PRO batches) is rendered as given');
  assert.ok(proDocumentsCode.includes('renderPageImages(entry.file, hasTextLayer, batch.imagePages)'), 'PRO always passes the batch pages explicitly');
});

// --- P3.1 S2 ----------------------------------------------------------------------------------

test('P3.1 S2: each profile request document carries its per-upload DocEntry.id as an opaque documentId, forwarded unchanged', async () => {
  const block = proDocumentsCode.slice(proDocumentsCode.indexOf('const profileDocuments'), proDocumentsCode.indexOf('resolveProfile(asOfDate, profileDocuments)'));
  assert.ok(block.includes('documentId: e.id'), 'the request identifies each document by its DocEntry.id, not by its position');
  assert.ok(block.includes('index,'), 'the display index is still sent alongside it (backward compatible)');
  const withIds: ProfileRequestDocument[] = cachedDocuments.map((d, i) => ({ ...d, documentId: `upload-${i}` }));
  const bodies: Array<{ documents: ProfileRequestDocument[] }> = [];
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ profile: profile({}, {}), extractionTable: [] }), { status: 200 });
  }) as typeof fetch;
  const resolved = await resolveProfile('2026-10-01', withIds, fakeFetch);
  assert.deepEqual(bodies[0]?.documents.map((d) => d.documentId), ['upload-0', 'upload-1']);
  assert.equal(resolved?.profile.version, 2);
});

// --- P3.1 S3 ----------------------------------------------------------------------------------

test('P3.1 S3: resolveProfile sends field-level decisions only when given and returns decisionResults; ProDocuments has no decision flow yet', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ profile: profile({}, {}), extractionTable: [], decisionResults: [{ decisionId: 'd-1', fieldPath: 'employment.hourlyRate', status: 'applied', problem: null }] }), { status: 200 });
  }) as typeof fetch;
  const decision: ProfileDecisionView = { kind: 'confirm_candidate', decisionId: 'd-1', fieldPath: 'employment.hourlyRate', value: 16.2, evidenceFingerprint: '0123456789abcdef', decidedAt: '2026-10-05T10:00:00Z' };
  const resolved = await resolveProfile('2026-10-01', cachedDocuments, fakeFetch, [decision]);
  assert.deepEqual(bodies[0], { asOfDate: '2026-10-01', documents: cachedDocuments, decisions: [decision] });
  assert.deepEqual(resolved?.decisionResults, [{ decisionId: 'd-1', fieldPath: 'employment.hourlyRate', status: 'applied', problem: null }]);
  await resolveProfile('2026-10-01', cachedDocuments, fakeFetch);
  assert.deepEqual(bodies[1], { asOfDate: '2026-10-01', documents: cachedDocuments }, 'without decisions the request body is exactly as before');
  for (const marker of ['confirm_candidate', 'correct_value', 'decisionResults', 'ProfileDecisionView']) {
    assert.ok(!proDocumentsCode.includes(marker), `ProDocuments does not implement ${marker} in S3`);
  }
});

test('P3.1 S3: an applied user_confirmed or user_corrected field is usable by the existing prefill; a conflict still is not', () => {
  const userField = (state: EvidenceState, value: number): ProfileFieldView => ({
    ...field('hourlyRate', state, value, []),
    sources: [{ sourceType: 'user', role: 'user', documentIndex: null, documentLabel: null, effectiveDate: null, payPeriod: null, printedLabel: null, page: null, line: null, decisionId: 'd-1' }],
  });
  for (const state of ['user_confirmed', 'user_corrected'] as const) {
    assert.equal(profilePrefill(profile({ hourlyRate: userField(state, 17.1) }, {}), badge).hourly_rate, 17.1, state);
  }
  assert.equal(profilePrefill(profile({ hourlyRate: field('hourlyRate', 'conflict', null) }, {}), badge).hourly_rate, undefined);
});

// --- P3.1 S4 ----------------------------------------------------------------------------------

test('P3.1 S4: resolveProfile sends requirements only when given, returns issues and readiness, and keeps the earlier request shapes byte for byte', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const issue: ProfileIssueView = {
    fieldPath: 'employment.hourlyRate', key: 'hourlyRate', meaning: 'gross_base_hourly_wage', unit: 'eur_per_hour', state: 'conflict', reason: { code: 'sources_disagree' },
    severity: 'blocking', groups: ['core_pay'], candidates: [{ candidateId: '0123456789abcdef', value: 16.2, sources: [], basis: 'employer_applied' }], hints: [], excluded: [],
    actions: ['select_candidate', 'enter_value'], input: { kind: 'number', min: 0.01, max: 200, step: 0.01 }, evidenceFingerprint: 'fedcba9876543210', previousDecision: null, impact: null,
  };
  const readiness: CalculationReadinessView = { activeGroups: ['core_pay'], ready: false, blockingCount: 1, optionalCount: 0 };
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ profile: profile({}, {}), extractionTable: [], decisionResults: [], issues: [issue], readiness }), { status: 200 });
  }) as typeof fetch;
  const resolved = await resolveProfile('2026-10-01', cachedDocuments, fakeFetch);
  assert.deepEqual(bodies[0], { asOfDate: '2026-10-01', documents: cachedDocuments }, 'no requirements: the backend default (core_pay) applies');
  assert.deepEqual([resolved?.issues, resolved?.readiness], [[issue], readiness]);
  const requirements: RequirementsView = { groups: ['core_pay', 'overtime'] };
  await resolveProfile('2026-10-01', cachedDocuments, fakeFetch, [], requirements);
  assert.deepEqual(bodies[1], { asOfDate: '2026-10-01', documents: cachedDocuments, requirements });
  const decision: ProfileDecisionView = { kind: 'confirm_candidate', decisionId: 'd-1', fieldPath: 'employment.hourlyRate', value: 16.2, evidenceFingerprint: issue.evidenceFingerprint, decidedAt: '2026-10-06T09:00:00Z' };
  await resolveProfile('2026-10-01', cachedDocuments, fakeFetch, [decision], requirements);
  assert.deepEqual(bodies[2], { asOfDate: '2026-10-01', documents: cachedDocuments, decisions: [decision], requirements });
  // An older backend (no issues / readiness): empty issues, and no readiness is invented.
  const older = (async () => new Response(JSON.stringify({ profile: profile({}, {}), extractionTable: [] }), { status: 200 })) as unknown as typeof fetch;
  const fallback = await resolveProfile('2026-10-01', cachedDocuments, older);
  assert.deepEqual([fallback?.issues, fallback?.readiness], [[], null]);
});

test('P3.1 S4: the frontend group list mirrors the backend canonical list, and ProDocuments still renders no issues or readiness (no S4 UI)', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const backend = readFileSync(path.join(dir, '..', '..', 'backend-node', 'src', 'payroll-engine', 'profile-readiness.ts'), 'utf-8');
  const listed = /REQUIREMENT_GROUP_IDS = \[([^\]]+)\] as const/.exec(backend)?.[1]?.match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1));
  assert.deepEqual([...REQUIREMENT_GROUP_IDS_VIEW], listed, 'same ids, same canonical order');
  for (const marker of ['readiness', 'ProfileIssueView', 'CalculationReadinessView', 'REQUIREMENT_GROUP', 'resolved.issues', 'RequirementsView']) {
    assert.ok(!proDocumentsCode.includes(marker), `ProDocuments does not use ${marker} in S4`);
  }
});
