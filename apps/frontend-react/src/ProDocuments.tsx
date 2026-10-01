import { useRef, useState } from 'react';
import { Trash2, Upload, AlertTriangle } from 'lucide-react';
import { renderPageImages, extractTextItems } from './local-ocr.ts';
import { translations, type Lang } from './translations.ts';
import { addDocument, removeDocument, setDocumentType, setEffectiveDate, routeForDocument, isReadyToSubmit, type ProDocumentType } from './pro-documents-policy.ts';
import { isUsableField, profilePrefill, sourceDocumentLabels, unreadableFieldPathsFor, type PayrollProfileView, type ProfileFieldView, type ProfileSourceView } from './pro-profile-prefill.ts';
import { TierACalculator, type TierAContractPrefill } from './TierACalculator.tsx';
import {
  issueKey, issueMessage, correctableFieldPath, correctableLineLabel, correctablePrintedLabel,
  correctableReadValue, correctableExpectedValue, outstandingAmountUnreadablePaths, recomputeWithPathCorrection,
  openNeedsConfirmation,
  money, type TierCPeriodResponse, type Outcome, type Discrepancy, type NetPosition, type TechnicalDetails, type ConsistencyIssue,
} from './tier-c-shared.ts';

/**
 * Stage 3.0 (audit v40, "PRO accepts several documents"): the shell that replaces PRO's old
 * single-file upload - adds, lists, routes and extracts several documents together, and shows the
 * contract TIMELINE (base + annexes) resolved as of a given date. A payslip goes through the
 * existing, unchanged Tier C `/analyze`.
 *
 * Stage 2u (audit v53 — auditor ruling): the ORIGINAL plan routed a payslip's full discrepancy panel
 * and confirm/correct interaction through `TierCFlow.tsx`. Direct inspection of the import graph
 * showed that file is unreachable from the running app - `App.tsx`'s own routing mounts THIS
 * component for the 'pro' tier and never imports `TierCFlow`, confirmed by its own doc comment
 * ("TierCFlow.tsx itself is untouched and unimported here"). Per the auditor's own ruling: this file
 * is therefore the actual, only live PRO surface, and Stage 2u's provisional-result/confirm/correct
 * requirements are implemented HERE, not in the unreachable file - reusing the pure logic
 * (`tier-c-shared.ts`) `TierCFlow.tsx` already had, never a second, independent implementation of it.
 *
 * Stage 3.0a (audit v42): the actual point of PRO (spec §5) - the projection. Rate, hours per week,
 * the overtime threshold, and guaranteed hours come from the resolved timeline above (no new
 * resolver, reused as-is). Overtime tier percentages come from the most recent payslip the Tier C
 * gate could FULLY reproduce (`pro-parameter-sourcing.ts`'s own `selectMostRecentReproducedPayslip`
 * - "a payslip that failed verification is never used as a parameter source, however recent", spec
 * §5's own exact rule). Saturday/Sunday/holiday percentages are never sourced this round - no
 * reference document labels a line by weekday (checked directly against FIXTURES-paski-referencyjne.md,
 * not assumed), so there is no evidence to source them from; they stay unknown, same as a genuinely
 * absent value anywhere else in this codebase. `TierACalculator` itself is reused unchanged as the
 * projection surface (spec §5b: "the model does not change"), mounted with `tierMode="PRO"` once at
 * least one document has been analyzed.
 *
 * P1 (ZADANIE-P1-LOONTO-PRO.md §P1.5/§P1.7): the paragraph above describes the RETIRED sourcing
 * chain. The projection's prefill no longer comes from "the most recent fully-reproduced payslip":
 * after every document is read, the whole set goes to the backend Payroll Profile
 * (`POST /api/profile/resolve`), which resolves each parameter independently (document_exact /
 * corroborated / conflict / unknown), and `profilePrefill` copies only usable values into the
 * calculator. The needsConfirmation panel below is kept as a diagnostic: confirming or correcting an
 * item there no longer unlocks, blocks or changes any profile parameter.
 */

interface ContractExtraction {
  contractType: string | null; employerName: string | null; functionTitle: string | null;
  startDate: string | null; endDate: string | null; hoursPerWeek: number | null; hourlyRate: number | null;
  monthlySalary: number | null; caoName: string | null; pensionFund: string | null;
  probationPeriodWeeks: number | null; noticePeriodWeeks: number | null; thirtyPercentRuling: boolean;
  overtimeTierThresholdHours: number | null; guaranteedHours: number | null; guaranteedHoursPeriodWeeks: number | null;
  redactedFields: string[];
}

type DocStatus = 'pending' | 'processing' | 'done' | 'error';

/**
 * Stage 2u (audit v53): the full `/analyze`('ok')-shaped result for a payslip entry, replacing the
 * old, reduced `PayslipSummary` - kept so a needsConfirmation item can actually be corrected (the
 * correction needs the whole `period` to apply a field-path edit to and resubmit to /recompute), not
 * only displayed.
 */
interface PayslipAnalysis {
  period: TierCPeriodResponse;
  outcome: Outcome;
  discrepancies: Discrepancy[];
  net_position: NetPosition;
  technicalDetails: TechnicalDetails;
  needsConfirmation: ConsistencyIssue[];
  taxRatesSource: 'database' | 'static';
}

interface DocEntry {
  id: string;
  file: File;
  label: string;
  documentType: ProDocumentType;
  effectiveDate: string | null;
  status: DocStatus;
  errorMessage?: string;
  // Populated once status === 'done'. P1 (§P1.3): the CANONICAL extraction (the document's own raw
  // values) - never the display-translated `extraction` the same response also carries.
  contractExtraction?: ContractExtraction;
  /** Present only for a payslip whose read COMPUTED (status 'ok', possibly with needsConfirmation). */
  payslipAnalysis?: PayslipAnalysis;
  /** True for the one payslip hard-block left (period_type_unknown) - no analysis exists to show or
   * correct at all (§2.3: there is no period to compute against without a period type). */
  payslipBlocked?: boolean;
  // Stage 2u: per-entry confirm/correct UI state - a client-side "confirmed" set (no recompute; see
  // `confirmNeedsConfirmationIssue` below), the in-progress numeric correction inputs, and which
  // issue (if any) is mid-recompute, all keyed by `issueKey()` so `amount_unreadable`'s several
  // possible instances never collide with each other.
  confirmedIssueKeys?: Set<string>;
  correctionInputs?: Record<string, string>;
  recomputingKey?: string | null;
}

/** P1: one document in a `POST /api/profile/resolve` request (profile.controller.ts's own schema). */
type ProfileRequestDocument =
  | { index: number; label: string; role: 'contract_base' | 'contract_annex'; effectiveDate: string | null; contractExtraction: ContractExtraction }
  | { index: number; label: string; role: 'payslip'; effectiveDate: null; payslip: { period: TierCPeriodResponse; unreadableFieldPaths: string[] } };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Stage 2u (audit v53, §2u.1): thin, entry-shaped wrapper around the shared, pure, tested
 * `openNeedsConfirmation` (tier-c-shared.ts). P1: drives the diagnostic panel's wording only - it no
 * longer decides whether a payslip may feed the projection. */
function visibleNeedsConfirmation(entry: DocEntry): ConsistencyIssue[] {
  if (!entry.payslipAnalysis) return [];
  return openNeedsConfirmation(entry.payslipAnalysis.needsConfirmation, entry.confirmedIssueKeys ?? new Set());
}

export function ProDocuments({ lang, onNavigateToDictionary }: { lang: Lang; onNavigateToDictionary: () => void }) {
  const t = translations[lang].proDocuments;
  const tc = translations[lang].tierC;
  const inputRef = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  // Stage 3.0a: `TierACalculator`'s own prefill only reads `contractPrefill` at MOUNT (a lazy
  // `useState` initializer, matching Tier B's own existing, unchanged behaviour) - bumped on every
  // completed submission so a second submit (a new payslip added, a later as-of-date) remounts the
  // calculator with fresh values instead of silently keeping the first submission's stale prefill.
  const [submitCount, setSubmitCount] = useState(0);
  const [asOfDate, setAsOfDate] = useState(todayIso());
  // P1: the backend Payroll Profile for the last submission - the projection's only parameter source.
  const [profile, setProfile] = useState<PayrollProfileView | null>(null);
  const [globalError, setGlobalError] = useState('');

  function handleFilesAdded(files: FileList | null) {
    if (!files || files.length === 0) return;
    setDocs((current) => {
      let next = current;
      for (const file of Array.from(files)) {
        next = addDocument(next, { id: newId(), file, label: file.name, documentType: 'payslip', effectiveDate: null, status: 'pending' });
      }
      return next;
    });
    if (inputRef.current) inputRef.current.value = '';
  }

  function translateErrorCode(code: string | undefined): string {
    return code === 'vision_unavailable' ? t.errorVisionUnavailable
      : code === 'invalid_input' ? t.errorInvalidInput
      : code === 'extraction_failed' ? t.errorExtractionFailed
      : code === 'rate_limit_unknown' ? t.errorRateLimitUnknown
      : code === 'rate_limit_exceeded' ? t.errorRateLimitExceeded
      : t.error;
  }

  async function processPayslip(entry: DocEntry): Promise<Partial<DocEntry>> {
    let documentText: Awaited<ReturnType<typeof extractTextItems>> = [];
    try { documentText = await extractTextItems(entry.file); } catch { /* falls back to image-only */ }
    const { images, renderStep } = await renderPageImages(entry.file, documentText.length > 0);
    const res = await fetch('/api/tier-c/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, documentText, renderStep }),
    });
    const data = await res.json() as {
      status?: 'ok' | 'unreliable';
      outcome?: Outcome;
      discrepancies?: Discrepancy[];
      needsConfirmation?: ConsistencyIssue[];
      period?: TierCPeriodResponse;
      net_position?: NetPosition;
      technicalDetails?: TechnicalDetails;
      taxRatesSource?: 'database' | 'static';
      error_code?: string;
    };
    if (!res.ok || !data.status) return { status: 'error', errorMessage: translateErrorCode(data.error_code) };
    if (data.status === 'unreliable') {
      return { status: 'done', payslipBlocked: true };
    }
    if (!data.period || !data.outcome || !data.discrepancies || !data.net_position || !data.technicalDetails || !data.taxRatesSource) {
      return { status: 'error', errorMessage: t.error };
    }
    return {
      status: 'done',
      payslipAnalysis: {
        period: data.period, outcome: data.outcome, discrepancies: data.discrepancies,
        net_position: data.net_position, technicalDetails: data.technicalDetails,
        needsConfirmation: data.needsConfirmation ?? [], taxRatesSource: data.taxRatesSource,
      },
      confirmedIssueKeys: new Set(),
      correctionInputs: {},
      recomputingKey: null,
    };
  }

  async function processContract(entry: DocEntry): Promise<Partial<DocEntry>> {
    const { images } = await renderPageImages(entry.file, true);
    const res = await fetch('/api/contracts/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, language: lang }),
    });
    // P1 (§P1.3): `canonicalExtraction` (raw document values), never `extraction` (whose four string
    // fields are display-translated) - a translation must never become a profile value.
    const data = await res.json() as { canonicalExtraction?: ContractExtraction; error_code?: string };
    if (!res.ok || !data.canonicalExtraction) return { status: 'error', errorMessage: translateErrorCode(data.error_code) };
    return { status: 'done', contractExtraction: data.canonicalExtraction };
  }

  async function submitAll() {
    if (!isReadyToSubmit(docs)) { setGlobalError(t.effectiveDateRequired); return; }
    setGlobalError(''); setSubmitting(true); setProfile(null);
    setDocs((current) => current.map((e) => ({ ...e, status: 'processing' as const })));

    const processed = await Promise.all(docs.map(async (entry) => {
      const route = routeForDocument(entry.documentType);
      try {
        const patch = route === 'tier_c' ? await processPayslip(entry) : await processContract(entry);
        return { ...entry, ...patch };
      } catch (error) {
        return { ...entry, status: 'error' as const, errorMessage: error instanceof Error ? error.message : t.error };
      }
    }));
    setDocs(processed);

    // P1 (§P1.5): every successfully read document goes to the backend Payroll Profile as one set -
    // contracts/annexes with their canonical extraction (the backend runs the unchanged contract
    // timeline itself), payslips with their read `period`. Nothing about a payslip's audit state is
    // sent: no discrepancies, no needsConfirmation list, no confirmed keys - only the field-level paths
    // of amounts the read itself could not read. A payslip whose period type could not be read at all
    // (`payslipBlocked`) has no analysed period here and is not sent (see the P1 report).
    const profileDocuments = processed.flatMap((e, index): ProfileRequestDocument[] => {
      if (routeForDocument(e.documentType) === 'contract' && e.contractExtraction) {
        return [{ index, label: e.label, role: e.documentType === 'contract_annex' ? 'contract_annex' : 'contract_base', effectiveDate: e.effectiveDate, contractExtraction: e.contractExtraction }];
      }
      if (routeForDocument(e.documentType) === 'tier_c' && e.payslipAnalysis) {
        return [{ index, label: e.label, role: 'payslip', effectiveDate: null, payslip: { period: e.payslipAnalysis.period, unreadableFieldPaths: unreadableFieldPathsFor(e.payslipAnalysis.needsConfirmation) } }];
      }
      return [];
    });
    try {
      const res = await fetch('/api/profile/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asOfDate, documents: profileDocuments }),
      });
      const data = await res.json() as { profile?: PayrollProfileView };
      if (res.ok && data.profile) setProfile(data.profile);
      else setGlobalError(t.profileError);
    } catch {
      setGlobalError(t.profileError);
    }

    setSubmitting(false);
    setHasSubmitted(true);
    setSubmitCount((n) => n + 1);
  }

  /** Stage 2u (§2u.2): the restored field-specific correction path, now living on the actual live PRO
   * surface - reuses `recomputeWithPathCorrection` (tier-c-shared.ts), the SAME function a future
   * TierCFlow reconnect would use, so the two can never diverge into separate correction logic. */
  async function correctNeedsConfirmationIssue(entryId: string, issue: ConsistencyIssue) {
    const entry = docs.find((e) => e.id === entryId);
    if (!entry?.payslipAnalysis) return;
    const path = correctableFieldPath(issue);
    const key = issueKey(issue);
    const raw = entry.correctionInputs?.[key];
    const value = Number((raw ?? '').trim().replace(',', '.'));
    if (!path || !Number.isFinite(value)) return;

    const analysis = entry.payslipAnalysis;
    const except = issue.code === 'amount_unreadable' ? issue.field : undefined;
    const flaggedFieldPaths = outstandingAmountUnreadablePaths(analysis.needsConfirmation, except);

    setDocs((current) => current.map((e) => (e.id === entryId ? { ...e, recomputingKey: key } : e)));
    try {
      const result = await recomputeWithPathCorrection(analysis.period, path, value, flaggedFieldPaths);
      if (result.status === 'unreliable') {
        // Expected when another amount_unreadable field is still outstanding elsewhere in the SAME
        // document (2m.1/2p.5's own discipline, carried forward - §2u.2) - the correction itself is
        // not lost (applied to `period` below), only the recompute is deferred until that field too
        // is resolved via its own correction. This one issue is dropped from the locally-shown list;
        // every other one stays exactly as before.
        setDocs((current) => current.map((e) => (e.id !== entryId ? e : {
          ...e,
          payslipAnalysis: { ...analysis, period: result.period, needsConfirmation: analysis.needsConfirmation.filter((i) => i !== issue) },
          recomputingKey: null,
        })));
        return;
      }
      setDocs((current) => current.map((e) => (e.id !== entryId ? e : {
        ...e,
        payslipAnalysis: {
          period: result.period, outcome: result.outcome, discrepancies: result.discrepancies,
          net_position: result.net_position, technicalDetails: result.technicalDetails,
          needsConfirmation: result.needsConfirmation, taxRatesSource: result.taxRatesSource,
        },
        confirmedIssueKeys: new Set(),
        correctionInputs: { ...(e.correctionInputs ?? {}), [key]: '' },
        recomputingKey: null,
      })));
    } catch {
      setGlobalError(t.error);
      setDocs((current) => current.map((e) => (e.id === entryId ? { ...e, recomputingKey: null } : e)));
    }
  }

  /** Stage 2u (§2u.2): "provide Confirm when the read value is visible" - client-side only, matching
   * Stage 1's own `confirmDiscrepancy` pattern exactly: nothing about the computation changes, only
   * that the user has looked at the printed figure and says it is correct. Only ever offered for the
   * two codes `correctableReadValue` returns non-null for (see the render site below). */
  function confirmNeedsConfirmationIssue(entryId: string, issue: ConsistencyIssue) {
    setDocs((current) => current.map((e) => {
      if (e.id !== entryId) return e;
      const next = new Set(e.confirmedIssueKeys ?? []);
      next.add(issueKey(issue));
      return { ...e, confirmedIssueKeys: next };
    }));
  }

  function setCorrectionInput(entryId: string, key: string, value: string) {
    setDocs((current) => current.map((e) => (e.id === entryId ? { ...e, correctionInputs: { ...(e.correctionInputs ?? {}), [key]: value } } : e)));
  }

  // P1 (§P1.5): the projection's prefill is read off the backend Payroll Profile - only fields in a
  // usable evidence state (document_exact / corroborated) ever reach the calculator; a conflict or
  // unknown leaves the input empty (never a picked candidate, never a Basic default). Built once per
  // submission, exactly like the calculator's own mount-time prefill (`key={submitCount}` below).
  function profileBadge(field: ProfileFieldView): string {
    return t.profileSourceLabel(field.state, sourceDocumentLabels(field).join(' + '));
  }
  const contractPrefill: TierAContractPrefill | undefined = hasSubmitted && profile ? profilePrefill(profile, profileBadge) : undefined;
  const additionalTierField = profile?.payroll.overtimeAdditionalTierPremiums;
  const additionalTierPremiums: number[] = isUsableField(additionalTierField) && Array.isArray(additionalTierField.value) ? additionalTierField.value : [];

  // P1 (§P1.6): minimal developer-facing inspection rows - every profile field, grouped, with its own
  // state, sources and reason exactly as the backend resolved them (nothing re-decided here).
  const profileRows: Array<{ group: string; field: ProfileFieldView }> = profile
    ? [
        ...Object.values(profile.employment).map((field) => ({ group: t.profileGroupEmployment, field })),
        ...Object.values(profile.payroll).map((field) => ({ group: t.profileGroupPayroll, field })),
        ...Object.values(profile.recurringItems).flat().map((field) => ({ group: t.profileGroupRecurring, field })),
      ]
    : [];
  function formatProfileValue(value: unknown): string {
    return Array.isArray(value) ? value.join(', ') : String(value);
  }
  function describeSource(source: ProfileSourceView): string {
    const parts = [source.documentLabel ?? source.role];
    if (source.effectiveDate) parts.push(t.profileEffectiveFrom(source.effectiveDate));
    if (source.payPeriod?.label) parts.push(source.payPeriod.label);
    return parts.join(' · ');
  }
  function describeValue(field: ProfileFieldView): string {
    if (field.state === 'conflict') {
      return `${t.profileConflict}: ${field.candidates.map((c) => `${formatProfileValue(c.value)} (${describeSource(c.source)})`).join('; ')}`;
    }
    if (field.value === null) return t.profileUnknown;
    return formatProfileValue(field.value);
  }

  return (
    <section className="flow-page">
      <div className="flow-heading"><h1>{t.title}</h1><p>{t.lead}</p></div>

      <div className="upload-box">
        <input ref={inputRef} className="hidden" type="file" accept="application/pdf,image/jpeg,image/png" multiple
          onChange={(event) => handleFilesAdded(event.target.files)} aria-label={t.addFile}/>
        <button type="button" className="secondary" onClick={() => inputRef.current?.click()}><Upload size={16}/> {t.addFile}</button>
        <small className="form-note">{t.types}</small>
      </div>

      {docs.length > 0 && (
        <ul className="pro-document-list">
          {docs.map((entry) => {
            const openIssues = visibleNeedsConfirmation(entry);
            const isProvisional = openIssues.length > 0;
            // Stage 2t (§2t.5): the DOCUMENT's own printed payout/net figure - never the engine's own
            // computed one (see the doc comment on the "computed differs" note below for why).
            const printedAmount = entry.payslipAnalysis ? entry.payslipAnalysis.period.printed_payout ?? entry.payslipAnalysis.period.printed_net : null;
            return (
            <li key={entry.id} className="pro-document-row">
              <div className="pro-document-row-main">
                <span className="pro-document-name">{entry.label}</span>
                <select
                  value={entry.documentType}
                  disabled={submitting}
                  onChange={(event) => setDocs((current) => setDocumentType(current, entry.id, event.target.value as ProDocumentType))}
                >
                  <option value="payslip">{t.typePayslip}</option>
                  <option value="contract_base">{t.typeContractBase}</option>
                  <option value="contract_annex">{t.typeContractAnnex}</option>
                </select>
                {entry.documentType === 'contract_annex' && (
                  <label className="pro-document-date">
                    {t.effectiveDateLabel}
                    <input type="date" required disabled={submitting} value={entry.effectiveDate ?? ''}
                      onChange={(event) => setDocs((current) => setEffectiveDate(current, entry.id, event.target.value))}/>
                  </label>
                )}
                <span className={`pro-document-status pro-document-status-${entry.status}`}>
                  {entry.status === 'pending' && t.statusPending}
                  {entry.status === 'processing' && t.statusProcessing}
                  {entry.status === 'error' && (entry.errorMessage ?? t.statusError)}
                  {/* Stage 2u (audit v53, §2u.1): "must not present the engine payout using clean-success
                      wording or styling" while provisional - a distinct phrase/status class from the
                      clean case, never the bare euro figure alone. */}
                  {entry.status === 'done' && entry.payslipAnalysis && (
                    isProvisional
                      ? t.payslipSummaryNeedsConfirmation(printedAmount !== null ? money(printedAmount) : '—')
                      : t.payslipSummaryOk(printedAmount !== null ? money(printedAmount) : '—')
                  )}
                  {entry.status === 'done' && entry.payslipBlocked && t.payslipSummaryUnreliable}
                  {/* Stage 2t (§2t.5): "the engine's own discrepancy explicitly shown separately when it
                      differs" - never folded into the headline figure above, which is always the
                      document's own printed one. Stage 2u: only shown for a CLEAN (non-provisional)
                      read - while provisional, the engine figure is already shown, clearly labelled, in
                      the confirmation panel below, so repeating it here would be confusing, not helpful. */}
                  {entry.status === 'done' && entry.payslipAnalysis && !isProvisional
                    && entry.payslipAnalysis.outcome.status === 'complete'
                    && printedAmount !== null
                    && Math.abs(entry.payslipAnalysis.outcome.result.payout_amount - printedAmount) > 0.005 && (
                    <span className="pro-document-computed-note">
                      {t.payslipSummaryComputedDiffers(money(entry.payslipAnalysis.outcome.result.payout_amount))}
                    </span>
                  )}
                  {entry.status === 'done' && entry.contractExtraction && t.statusDone}
                </span>
                <button type="button" className="plain-button" disabled={submitting} aria-label={t.remove}
                  onClick={() => setDocs((current) => removeDocument(current, entry.id))}>
                  <Trash2 size={16}/>
                </button>
              </div>

              {/* Stage 2u (§2u.1/§2u.2): the inline provisional/confirmation panel - "the specific
                  lines requiring confirmation must appear before or visually above any provisional
                  computed amount" is satisfied by rendering this BEFORE the calculator/projection
                  section further down uses this entry as a parameter source, and by stating plainly,
                  right here, that the figure above is not yet confirmed. */}
              {entry.status === 'done' && entry.payslipAnalysis && isProvisional && (
                <div className="notice-card pro-payslip-confirmation">
                  <AlertTriangle size={16}/>
                  <div>
                    <h3>{tc.provisionalResultTitle}</h3>
                    <p>{tc.provisionalResultBody}</p>
                    {/* Stage 2u (§2u.1): "the specific lines requiring confirmation must appear
                        before or visually above any provisional computed amount" - confirmed by a
                        live production check that this order matters: the issue list below must
                        render BEFORE the provisional euro figure further down, never after it. */}
                    <p className="form-note">{tc.needsConfirmationIntro}</p>
                    {openIssues.map((issue) => {
                      const key = issueKey(issue);
                      const path = correctableFieldPath(issue);
                      const readValue = correctableReadValue(issue);
                      const expectedValue = correctableExpectedValue(issue);
                      const printedLabel = entry.payslipAnalysis && path ? correctablePrintedLabel(entry.payslipAnalysis.period, issue) : null;
                      const recomputing = entry.recomputingKey === key;
                      return (
                        <div key={key} className="discrepancy-item confirm">
                          <p>{issueMessage(tc, issue)}</p>
                          {path && entry.payslipAnalysis && (
                            <>
                              <p className="form-note">
                                <strong>{correctableLineLabel(tc, entry.payslipAnalysis.period, issue)}</strong>{' '}
                                {printedLabel && <span className="nl-term">({tc.dutchTerm(printedLabel)})</span>}
                              </p>
                              {readValue !== null
                                ? <p className="form-note">{tc.weRead(money(readValue))}</p>
                                : <p className="form-note">{tc.notReadAtAll}</p>}
                              {expectedValue !== null && <p className="form-note">{tc.expectedValue(money(expectedValue))}</p>}
                              {readValue !== null && (
                                <div className="calc-toggles">
                                  <button type="button" className="secondary" onClick={() => confirmNeedsConfirmationIssue(entry.id, issue)}>{tc.confirmYes}</button>
                                </div>
                              )}
                              <label>{tc.correctionLabel}
                                <div className="money-input">
                                  <span>€</span>
                                  <input inputMode="decimal" value={entry.correctionInputs?.[key] ?? ''}
                                    onChange={(event) => setCorrectionInput(entry.id, key, event.target.value.replace(/[^0-9.,-]/g, ''))}/>
                                </div>
                              </label>
                              <button type="button" className="secondary" disabled={recomputing} onClick={() => void correctNeedsConfirmationIssue(entry.id, issue)}>
                                {recomputing ? tc.recomputing : tc.correctSubmit}
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                    {/* The provisional euro figure itself - deliberately AFTER the specific issue(s)
                        above, and labelled as provisional, never with "Amount payable"/"Paid now"
                        wording (§2u.1). */}
                    {entry.payslipAnalysis.outcome.status === 'complete' && (
                      <p>{tc.provisionalPayoutLabel}: <strong>{money(entry.payslipAnalysis.outcome.result.payout_amount)}</strong></p>
                    )}
                    <p className="form-note">{tc.provisionalNote}</p>
                  </div>
                </div>
              )}
            </li>
            );
          })}
        </ul>
      )}

      {docs.length > 0 && (
        <div className="pro-document-submit-row">
          <label className="pro-document-date">
            {t.asOfDateLabel}
            <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)}/>
          </label>
          <button type="button" className="primary" disabled={submitting} onClick={() => void submitAll()}>
            {submitting ? t.submitting : t.submit}
          </button>
        </div>
      )}

      {globalError && <div className="status error">{globalError}</div>}

      {/* P1 (§P1.6): developer-facing profile inspection - replaces the old contract-timeline table
          (the timeline still runs, inside the backend profile, and its sources/dates show here). */}
      {profile && (
        <div className="pro-effective-contract pro-payroll-profile">
          <h2>{t.profileTitle(profile.asOfDate)}</h2>
          <p className="form-note">{t.profileLead}</p>
          <table>
            <thead>
              <tr>
                <th scope="col">{t.profileColField}</th>
                <th scope="col">{t.profileColValue}</th>
                <th scope="col">{t.profileColState}</th>
                <th scope="col">{t.profileColSources}</th>
                <th scope="col">{t.profileColReason}</th>
              </tr>
            </thead>
            <tbody>
              {profileRows.map(({ group, field }) => (
                <tr key={field.key}>
                  <th scope="row"><small className="form-note">{group}</small> <code>{field.key}</code></th>
                  <td>{describeValue(field)}</td>
                  <td><code>{field.state}</code></td>
                  <td>{field.sources.map(describeSource).join('; ') || '—'}</td>
                  <td>
                    {field.reason ? <code>{field.reason.code}</code> : '—'}
                    {field.excluded.length > 0 && (
                      <small className="form-note"> ({t.profileExcluded(field.excluded.map((x) => `${x.reason}: ${describeSource(x.source)}`).join('; '))})</small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasSubmitted && (
        <div className="pro-projection">
          <h2>{t.projectionTitle}</h2>
          {/* P1 (§P1.5): no single payslip is "the" source any more - each prefilled field names its
              own document(s) in the calculator's badge, from the profile above. */}
          <p className="form-note">{t.projectionFromProfile}</p>
          {/* Stage 3.0a.5 (§Fix 3), now from the profile: an overtime tier the grid has no slot for -
              named, never silently dropped. */}
          {additionalTierPremiums.length > 0 && (
            <p className="form-note">{t.projectionAdditionalTiers(additionalTierPremiums.join(', '))}</p>
          )}
          <TierACalculator key={submitCount} lang={lang} tierMode="PRO" contractPrefill={contractPrefill} onNavigateToDictionary={onNavigateToDictionary}/>
        </div>
      )}
    </section>
  );
}
