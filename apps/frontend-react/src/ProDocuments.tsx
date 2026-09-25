import { useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { renderPageImages, extractTextItems } from './local-ocr.ts';
import { translations, type Lang } from './translations.ts';
import { addDocument, removeDocument, setDocumentType, setEffectiveDate, routeForDocument, isReadyToSubmit, type ProDocumentType } from './pro-documents-policy.ts';

/**
 * Stage 3.0 (audit v40, "PRO accepts several documents"): the shell that replaces PRO's old
 * single-file upload. Not the projection itself (3.0a, later) - this round adds, lists, routes and
 * extracts several documents together, and shows the contract TIMELINE (base + annexes) resolved as
 * of a given date. A payslip goes through the existing, unchanged Tier C `/analyze` (its own full
 * discrepancy panel is deliberately NOT reproduced here - that is TierCFlow.tsx's own job, and
 * pulling it apart to embed here would be a bigger, riskier change than this round's own scope; a
 * payslip entry shows a compact status line only). A contract/annex goes through the existing,
 * unchanged `/api/contracts/analyze`; once every contract/annex entry has an extraction, they are
 * sent together to the new `/api/contracts/resolve-timeline`, whose response is what "the values in
 * force on that date" (§2.12) actually looks like on screen.
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
  payslipSummary?: { ok: true; net: number | null } | { ok: false };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ProDocuments({ lang }: { lang: Lang }) {
  const t = translations[lang].proDocuments;
  const inputRef = useRef<HTMLInputElement>(null);
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
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
    try { documentText = await extractTextItems(entry.file); } catch { /* falls back to image-only, same as TierCFlow */ }
    const { images, renderStep } = await renderPageImages(entry.file, documentText.length > 0);
    const res = await fetch('/api/tier-c/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, documentText, renderStep }),
    });
    const data = await res.json() as { status?: 'ok' | 'unreliable'; outcome?: { status: string; result?: { payout_amount: number } }; error_code?: string };
    if (!res.ok || !data.status) return { status: 'error', errorMessage: translateErrorCode(data.error_code) };
    if (data.status === 'unreliable') return { status: 'done', payslipSummary: { ok: false } };
    const net = data.outcome?.status === 'complete' ? data.outcome.result?.payout_amount ?? null : null;
    return { status: 'done', payslipSummary: { ok: true, net } };
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
    </section>
  );
}
