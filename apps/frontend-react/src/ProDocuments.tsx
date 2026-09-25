import { useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { renderPageImages, extractTextItems } from './local-ocr.ts';
import { translations, type Lang } from './translations.ts';
import { addDocument, removeDocument, setDocumentType, setEffectiveDate, routeForDocument, isReadyToSubmit, type ProDocumentType } from './pro-documents-policy.ts';
import { derivePayslipOvertimePercents, selectMostRecentReproducedPayslip, type ReproducedPayslipCandidate } from './pro-parameter-sourcing.ts';
import { TierACalculator, type TierAContractPrefill } from './TierACalculator.tsx';

/**
 * Stage 3.0 (audit v40, "PRO accepts several documents"): the shell that replaces PRO's old
 * single-file upload - adds, lists, routes and extracts several documents together, and shows the
 * contract TIMELINE (base + annexes) resolved as of a given date. A payslip goes through the
 * existing, unchanged Tier C `/analyze` (its own full discrepancy panel is deliberately NOT
 * reproduced here - that is TierCFlow.tsx's own job; a payslip entry shows a compact status line
 * only). A contract/annex goes through the existing, unchanged `/api/contracts/analyze`; once every
 * contract/annex entry has an extraction, they are sent together to `/api/contracts/resolve-timeline`,
 * whose response is what "the values in force on that date" (§2.12) actually looks like on screen.
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

interface PayslipHourLineForSummary { category: string; percent: number | null }

/** Stage 3.0a: everything the parameter-sourcing layer needs from a processed payslip, beyond the
 * compact status line 3.0 already showed. `fullyReproduced` is this file's own operational reading of
 * spec §5's "a payslip the engine could fully reproduce": the Tier C consistency gate passed
 * (`status: 'ok'`) AND the discrepancy list is genuinely empty - not merely every entry being an
 * unconfirmed 'confirm'-band question, since a question is not yet a verified fact (stage 1's own
 * three-band model). */
interface PayslipSummary {
  ok: boolean;
  net: number | null;
  periodLabel: string | null;
  periodEndDate: string | null;
  fullyReproduced: boolean;
  hourLines: PayslipHourLineForSummary[];
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
  payslipSummary?: PayslipSummary;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ProDocuments({ lang, onNavigateToDictionary }: { lang: Lang; onNavigateToDictionary: () => void }) {
  const t = translations[lang].proDocuments;
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
  const [reproducedPayslip, setReproducedPayslip] = useState<ReproducedPayslipCandidate | null>(null);
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
    try { documentText = await extractTextItems(entry.file); } catch { /* falls back to image-only, same as TierCFlow */ }
    const { images, renderStep } = await renderPageImages(entry.file, documentText.length > 0);
    const res = await fetch('/api/tier-c/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, documentText, renderStep }),
    });
    const data = await res.json() as {
      status?: 'ok' | 'unreliable';
      outcome?: { status: string; result?: { payout_amount: number } };
      discrepancies?: unknown[];
      period?: { period_label: string | null; period_end_date: string | null; hour_lines?: PayslipHourLineForSummary[] };
      error_code?: string;
    };
    if (!res.ok || !data.status) return { status: 'error', errorMessage: translateErrorCode(data.error_code) };
    const periodLabel = data.period?.period_label ?? null;
    const periodEndDate = data.period?.period_end_date ?? null;
    const hourLines = data.period?.hour_lines ?? [];
    if (data.status === 'unreliable') {
      return { status: 'done', payslipSummary: { ok: false, net: null, periodLabel, periodEndDate, fullyReproduced: false, hourLines } };
    }
    const net = data.outcome?.status === 'complete' ? data.outcome.result?.payout_amount ?? null : null;
    const fullyReproduced = (data.discrepancies?.length ?? 0) === 0;
    return { status: 'done', payslipSummary: { ok: true, net, periodLabel, periodEndDate, fullyReproduced, hourLines } };
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

    // Stage 3.0a.2: "from the most recent payslip the engine could fully reproduce" - spec's own
    // rule, applied via the shared, tested selector (never re-decided inline here).
    const payslipEntries = processed.filter((e) => routeForDocument(e.documentType) === 'tier_c' && e.payslipSummary);
    const candidates: ReproducedPayslipCandidate[] = payslipEntries.map((e) => ({
      label: e.label,
      periodLabel: e.payslipSummary?.periodLabel ?? null,
      periodEndDate: e.payslipSummary?.periodEndDate ?? null,
      fullyReproduced: e.payslipSummary?.fullyReproduced ?? false,
      hourLines: e.payslipSummary?.hourLines ?? [],
    }));
    setReproducedPayslip(selectMostRecentReproducedPayslip(candidates));

    setSubmitting(false);
    setHasSubmitted(true);
    setSubmitCount((n) => n + 1);
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

  // Stage 3.0a.2/3.0a.3: the projection's own prefill - rate/hours/threshold from the resolved
  // timeline (reused as-is, no new resolver), the two overtime tier percentages from the most
  // recent fully-reproduced payslip (derived via the shared, tested function - never re-decided
  // inline). Undefined fields stay genuinely blank in the calculator, never defaulted - exactly the
  // same "unknown, never guessed" discipline every other resolver in this codebase already follows.
  const derivedPercents = reproducedPayslip ? derivePayslipOvertimePercents(reproducedPayslip.hourLines) : { tier1: null, tier2: null };
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
          {docs.map((entry) => (
            <li key={entry.id} className="pro-document-row">
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
                {entry.status === 'done' && entry.payslipSummary && (entry.payslipSummary.ok
                  ? t.payslipSummaryOk(entry.payslipSummary.net !== null ? `€${entry.payslipSummary.net.toFixed(2)}` : '—')
                  : t.payslipSummaryUnreliable)}
                {entry.status === 'done' && entry.contractExtraction && t.statusDone}
              </span>
              <button type="button" className="plain-button" disabled={submitting} aria-label={t.remove}
                onClick={() => setDocs((current) => removeDocument(current, entry.id))}>
                <Trash2 size={16}/>
              </button>
            </li>
          ))}
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
          <TierACalculator key={submitCount} lang={lang} tierMode="PRO" contractPrefill={contractPrefill} onNavigateToDictionary={onNavigateToDictionary}/>
        </div>
      )}
    </section>
  );
}
