import { useRef, useState } from 'react';
import { Trash2, Upload, AlertTriangle } from 'lucide-react';
import { renderPageImages, extractTextItems } from './local-ocr.ts';
import { translations, type Lang } from './translations.ts';
import { addDocument, removeDocument, setDocumentType, setEffectiveDate, routeForDocument, isReadyToSubmit, type ProDocumentType } from './pro-documents-policy.ts';
import { derivePayslipOvertimePercents, selectMostRecentReproducedPayslip, type ReproducedPayslipCandidate } from './pro-parameter-sourcing.ts';
import { TierACalculator, type TierAContractPrefill } from './TierACalculator.tsx';
import {
  issueKey, issueMessage, correctableFieldPath, correctableLineLabel, correctablePrintedLabel,
  correctableReadValue, correctableExpectedValue, outstandingAmountUnreadablePaths, recomputeWithPathCorrection,
  openNeedsConfirmation, isPayslipFullyReproduced,
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
 */

interface ContractExtraction {
  contractType: string | null; employerName: string | null; functionTitle: string | null;
  startDate: string | null; endDate: string | null; hoursPerWeek: number | null; hourlyRate: number | null;
  monthlySalary: number | null; caoName: string | null; pensionFund: string | null;
  probationPeriodWeeks: number | null; noticePeriodWeeks: number | null; thirtyPercentRuling: boolean;
  overtimeTierThresholdHours: number | null; guaranteedHours: number | null; guaranteedHoursPeriodWeeks: number | null;
  redactedFields: string[];
}

type EffectiveFieldReason = { code: 'disagreement'; documentLabels: string[]; asOfDate: string } | { code: 'undated_document'; documentLabel: string } | null;
interface EffectiveField<T> { value: T | null; source: { documentIndex: number; role: 'base' | 'annex'; label: string; effectiveDate: string | null } | null; reason: EffectiveFieldReason }
interface EffectiveContract {
  contractType: EffectiveField<string>; employerName: EffectiveField<string>; functionTitle: EffectiveField<string>;
  startDate: EffectiveField<string>; endDate: EffectiveField<string>; hoursPerWeek: EffectiveField<number>;
  hourlyRate: EffectiveField<number>; monthlySalary: EffectiveField<number>; caoName: EffectiveField<string>;
  pensionFund: EffectiveField<string>; probationPeriodWeeks: EffectiveField<number>; noticePeriodWeeks: EffectiveField<number>;
  overtimeTierThresholdHours: EffectiveField<number>; guaranteedHours: EffectiveField<number>; guaranteedHoursPeriodWeeks: EffectiveField<number>;
}

const EFFECTIVE_CONTRACT_FIELDS = [
  'contractType', 'employerName', 'functionTitle', 'startDate', 'endDate', 'hoursPerWeek', 'hourlyRate',
  'monthlySalary', 'caoName', 'pensionFund', 'probationPeriodWeeks', 'noticePeriodWeeks',
  'overtimeTierThresholdHours', 'guaranteedHours', 'guaranteedHoursPeriodWeeks',
] as const satisfies readonly (keyof EffectiveContract)[];

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
  // Populated once status === 'done'.
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Stage 2u (audit v53, §2u.1/§2u.3): thin, entry-shaped wrappers around the shared, pure, tested
 * `openNeedsConfirmation`/`isPayslipFullyReproduced` (tier-c-shared.ts) - see that module for why the
 * two must never be computed differently in two places. */
function visibleNeedsConfirmation(entry: DocEntry): ConsistencyIssue[] {
  if (!entry.payslipAnalysis) return [];
  return openNeedsConfirmation(entry.payslipAnalysis.needsConfirmation, entry.confirmedIssueKeys ?? new Set());
}

function isFullyReproduced(entry: DocEntry): boolean {
  if (!entry.payslipAnalysis) return false;
  return isPayslipFullyReproduced(entry.payslipAnalysis.discrepancies.length, entry.payslipAnalysis.needsConfirmation, entry.confirmedIssueKeys ?? new Set());
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
  const [effectiveContract, setEffectiveContract] = useState<EffectiveContract | null>(null);
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
    const data = await res.json() as { extraction?: ContractExtraction; error_code?: string };
    if (!res.ok || !data.extraction) return { status: 'error', errorMessage: translateErrorCode(data.error_code) };
    return { status: 'done', contractExtraction: data.extraction };
  }

  async function submitAll() {
    if (!isReadyToSubmit(docs)) { setGlobalError(t.effectiveDateRequired); return; }
    setGlobalError(''); setSubmitting(true); setEffectiveContract(null);
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

    // Stage 3.0 (§3.0.3): once every contract/annex entry has an extraction, resolve the timeline -
    // a base contract with no annexes still goes through this (a one-document timeline is a valid,
    // trivial case of the same resolver).
    const contractEntries = processed.filter((e) => routeForDocument(e.documentType) === 'contract' && e.contractExtraction);
    if (contractEntries.length > 0) {
      try {
        const res = await fetch('/api/contracts/resolve-timeline', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            asOfDate,
            documents: contractEntries.map((e) => ({
              role: e.documentType === 'contract_base' ? 'base' : 'annex',
              effectiveDate: e.effectiveDate,
              label: e.label,
              extraction: e.contractExtraction,
            })),
          }),
        });
        const data = await res.json() as { effectiveContract?: EffectiveContract };
        if (res.ok && data.effectiveContract) setEffectiveContract(data.effectiveContract);
        else setGlobalError(t.error);
      } catch {
        setGlobalError(t.error);
      }
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

  function fieldLabel(field: keyof EffectiveContract): string {
    const map: Record<keyof EffectiveContract, string> = {
      contractType: t.fieldContractType, employerName: t.fieldEmployerName, functionTitle: t.fieldFunctionTitle,
      startDate: t.fieldStartDate, endDate: t.fieldEndDate, hoursPerWeek: t.fieldHoursPerWeek,
      hourlyRate: t.fieldHourlyRate, monthlySalary: t.fieldMonthlySalary, caoName: t.fieldCaoName,
      pensionFund: t.fieldPensionFund, probationPeriodWeeks: t.fieldProbationPeriodWeeks,
      noticePeriodWeeks: t.fieldNoticePeriodWeeks, overtimeTierThresholdHours: t.fieldOvertimeTierThresholdHours,
      guaranteedHours: t.fieldGuaranteedHours, guaranteedHoursPeriodWeeks: t.fieldGuaranteedHoursPeriodWeeks,
    };
    return map[field];
  }

  function reasonText(reason: EffectiveFieldReason): string | null {
    if (!reason) return null;
    if (reason.code === 'disagreement') return t.reasonDisagreement(reason.documentLabels.join(' / '));
    return t.reasonUndated(reason.documentLabel);
  }

  // Stage 2u: recomputed fresh from `docs` on every render (not a snapshot taken once in submitAll) -
  // so a correction applied AFTER submission (via the panel below) immediately re-evaluates PRO
  // eligibility too, never leaving a stale "fully reproduced" verdict from before the correction.
  const payslipEntries = docs.filter((e) => routeForDocument(e.documentType) === 'tier_c' && e.payslipAnalysis);
  const candidates: ReproducedPayslipCandidate[] = payslipEntries.map((e) => ({
    label: e.label,
    periodLabel: e.payslipAnalysis?.period.period_label ?? null,
    periodEndDate: e.payslipAnalysis?.period.period_end_date ?? null,
    fullyReproduced: isFullyReproduced(e),
    hourLines: e.payslipAnalysis?.period.hour_lines ?? [],
  }));
  const reproducedPayslip = selectMostRecentReproducedPayslip(candidates);

  // Stage 3.0a.2/3.0a.3: the projection's own prefill - rate/hours/threshold from the resolved
  // timeline (reused as-is, no new resolver), the two overtime tier percentages from the most
  // recent fully-reproduced payslip (derived via the shared, tested function - never re-decided
  // inline). Undefined fields stay genuinely blank in the calculator, never defaulted - exactly the
  // same "unknown, never guessed" discipline every other resolver in this codebase already follows.
  const derivedPercents = reproducedPayslip ? derivePayslipOvertimePercents(reproducedPayslip.hourLines) : { tier1: null, tier2: null, excludedPercents: [] as number[] };
  function contractField(field: keyof EffectiveContract): number | undefined {
    const value = effectiveContract?.[field]?.value;
    return typeof value === 'number' ? value : undefined;
  }
  function contractSourceLabel(field: keyof EffectiveContract): string | undefined {
    const source = effectiveContract?.[field]?.source;
    return source ? t.sourceLabel(source.label) : undefined;
  }
  const payslipSourceLabel = reproducedPayslip ? t.payslipSourceLabel(reproducedPayslip.label, reproducedPayslip.periodLabel ?? '—') : undefined;
  const contractPrefill: TierAContractPrefill | undefined = hasSubmitted
    ? {
        hourly_rate: contractField('hourlyRate'),
        hours_per_week: contractField('hoursPerWeek'),
        overtime_tier_threshold_hours: contractField('overtimeTierThresholdHours'),
        overtime_tier_1_percent: derivedPercents.tier1 ?? undefined,
        overtime_tier_2_percent: derivedPercents.tier2 ?? undefined,
        sourceLabels: {
          hourlyRate: contractSourceLabel('hourlyRate'),
          hoursPerWeek: contractSourceLabel('hoursPerWeek'),
          threshold: contractSourceLabel('overtimeTierThresholdHours'),
          tier1Percent: derivedPercents.tier1 !== null ? payslipSourceLabel : undefined,
          tier2Percent: derivedPercents.tier2 !== null ? payslipSourceLabel : undefined,
        },
      }
    : undefined;

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
            const fullyReproduced = isFullyReproduced(entry);
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
              {/* Stage 2u (§2u.3): a fully-resolved payslip becomes eligible as a PRO parameter source
                  silently (no special notice needed) - but a CLEAN read that was never provisional at
                  all gets no confirmation panel, matching the pre-2u compact behaviour exactly. This
                  plain note only fires for the fully-reproduced case, so the user can tell the
                  projection may now use this document. */}
              {entry.status === 'done' && entry.payslipAnalysis && fullyReproduced && reproducedPayslip?.label === entry.label && (
                <p className="form-note pro-payslip-eligible-note">{t.payslipEligibleForProjection}</p>
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

      {effectiveContract && (
        <div className="pro-effective-contract">
          <h2>{t.effectiveContractTitle} {asOfDate}</h2>
          <table>
            <tbody>
              {EFFECTIVE_CONTRACT_FIELDS.map((field) => {
                const f = effectiveContract[field];
                const reason = reasonText(f.reason);
                return (
                  <tr key={field}>
                    <th scope="row">{fieldLabel(field)}</th>
                    <td>
                      {f.value !== null ? String(f.value) : '—'}
                      {f.source && <small className="form-note"> ({t.sourceLabel(f.source.label)})</small>}
                      {reason && <small className="form-note pro-effective-reason"> {reason}</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasSubmitted && (
        <div className="pro-projection">
          <h2>{t.projectionTitle}</h2>
          {/* Spec §5's own "Parameter source when several payslips exist" - silent selection is not
              acceptable, so which payslip supplied the overtime percentages (if any did) is stated
              plainly here, not left implicit in the calculator's own badges alone. */}
          {reproducedPayslip
            ? <p className="form-note">{t.projectionPayslipUsed(reproducedPayslip.label, reproducedPayslip.periodLabel ?? '—')}</p>
            : <p className="form-note">{t.projectionNoPayslip}</p>}
          {/* Stage 3.0a.5 (§Fix 3): a genuine third overtime tier the grid has no slot for - named,
              never silently dropped (§2.1/§2.3). */}
          {derivedPercents.excludedPercents.length > 0 && (
            <p className="form-note">{t.projectionExcludedPercent(derivedPercents.excludedPercents.join(', '))}</p>
          )}
          <TierACalculator key={submitCount} lang={lang} tierMode="PRO" contractPrefill={contractPrefill} onNavigateToDictionary={onNavigateToDictionary}/>
        </div>
      )}
    </section>
  );
}
