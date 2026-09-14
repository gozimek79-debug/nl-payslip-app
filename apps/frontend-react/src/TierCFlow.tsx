import { useRef, useState } from 'react';
import { AlertTriangle, HelpCircle, ShieldCheck, Upload } from 'lucide-react';
import { renderPageImages } from './local-ocr.ts';
import { StepProgress } from './StepProgress.tsx';
import { translations, type Lang } from './translations.ts';

/**
 * Tier C - "PRO" (SPEC-loonto-architecture.md §5, audit "CONSOLIDATED ASSIGNMENT" round, Stage 2 -
 * "wire the engine, build the panel"). Replaces App.tsx's entire old PRO flow (upload / manual-OCR
 * review / arithmetic-only result / "full analysis" result) - all of it retired this round, along
 * with the /api/payslips/analyze-full route, full-payslip.ts, and PayslipUploader.tsx.
 *
 * This is the FIRST real consumer of payslip-model.ts's actual engine + discrepancy.ts's Stage 1
 * classifier for a live payslip upload. It is verification only - Tier C's forward-projection
 * promise (spec §5's "if I work 60 hours next week...") is Stage 3, not built here. What ships this
 * round: upload a real payslip, get the full computed chain (same shape Tier A renders), the
 * discrepancy list with Stage 1's three-band classification, and the confirm/correct interaction
 * that classification implies.
 */

type UploadState = 'idle' | 'uploading' | 'error';

interface Field<T> { provenance: string; value: T | null }
interface TierCHourLineResponse { description: string; hours: number | null; rate: number | null; percent: number | null; amount: number; category: string; tax_treatment: string }
interface TierCDeductionResponse { category: string; description: string; amount: Field<number>; base: number | null; percent: number | null }
interface TierCPostTaxResponse { category: string; description: string; amount: Field<number>; percent: number | null }
interface TierCNetLineResponse { category: string; description: string; amount: number }
interface TierCReservationResponse { type: string; opgebouwd_this_period: number; paid_out_this_period: number }
interface EmployerResponse { name: string | null; franchise_bearing: boolean | 'unknown' }

interface TierCPeriodResponse {
  period_label: string | null;
  period_type: 'week' | '4-weekly' | 'month';
  employers: EmployerResponse[];
  hirer: { name: string | null } | null;
  hour_lines: TierCHourLineResponse[];
  pre_tax_deductions: TierCDeductionResponse[];
  post_tax_social: TierCPostTaxResponse[];
  net_additions: TierCNetLineResponse[];
  net_deductions: TierCNetLineResponse[];
  reservations: TierCReservationResponse[];
  wml_printed: number | null;
  wml_applicable: number | null;
  printed_table_tax: number | null;
  printed_bt_tax: number | null;
  printed_algemene_heffingskorting: number | null;
  printed_arbeidskorting: number | null;
  printed_net: number | null;
  printed_payout: number | null;
}

interface CompleteResult {
  gross_total: number; loon_voor_heffingen: number; taxable_base: number;
  table_tax_after_korting: number; bt_tax: number; total_tax: number;
  wage_net: number; net_additions_total: number; net_deductions_total: number;
  period_net: number; payout_amount: number;
}
type Outcome = { status: 'complete'; result: CompleteResult } | { status: 'incomplete'; missing_fields: string[]; tax_is_upper_bound: boolean; gross_total: number; taxable_base: number; table_tax_after_korting: number; bt_tax: number; total_tax: number };

type DiscrepancyCode = 'table_tax_mismatch' | 'bt_tax_mismatch' | 'algemene_heffingskorting_mismatch' | 'arbeidskorting_mismatch' | 'net_mismatch' | 'payout_mismatch' | 'minimum_wage_stale_on_document' | 'minimum_wage_violation';
interface Discrepancy { code: DiscrepancyCode; computed: number | null; printed: number; residual: number | null; tolerance: number; confirmation_upper: number; status: 'confirm' | 'finding' }

interface AnalyzeResponse {
  period: TierCPeriodResponse;
  outcome: Outcome;
  discrepancies: Discrepancy[];
  truncated: boolean;
  redactedFields: string[];
  taxRatesSource: 'database' | 'static';
}

/** Stage 1's confirm/correct/unanswered state machine, tracked client-side per discrepancy code
 * (each code appears at most once in one period's discrepancy list). 'confirmed': the user verified
 * the printed figure was read correctly - the divergence is real, promoted to a finding on screen,
 * no backend call needed (nothing about the computation changed, only how it is DISPLAYED).
 * 'corrected': the user supplied a different printed value - this DOES call /recompute, since the
 * period's own printed_* field changes and the whole outcome/discrepancy list must be re-derived. */
type Disposition = { kind: 'unanswered' } | { kind: 'confirmed' } | { kind: 'corrected'; correctedTo: number };

type TierCCopy = (typeof translations)['pl']['tierC'];

function money(value: number): string {
  return `€${value.toFixed(2)}`;
}

/** The six discrepancy codes are aggregate, whole-document reference figures (a payslip's own
 * "Loonheffing" / "Netto" summary lines), not one specific hour_line/deduction with its own captured
 * as-printed label - TierCExtraction captures the printed VALUE for these but not the printed LABEL
 * text itself (a real, separate gap, not papered over here - see this round's NEW FINDINGS). These
 * are translated generic terms, not a claim that this is what the document itself prints. */
function discrepancyLabel(t: TierCCopy, code: DiscrepancyCode): string {
  return {
    table_tax_mismatch: t.codeTableTax,
    bt_tax_mismatch: t.codeBtTax,
    algemene_heffingskorting_mismatch: t.codeAlgemeneHeffingskorting,
    arbeidskorting_mismatch: t.codeArbeidskorting,
    net_mismatch: t.codeNet,
    payout_mismatch: t.codePayout,
    minimum_wage_stale_on_document: t.codeMinimumWage,
    minimum_wage_violation: t.codeMinimumWage,
  }[code];
}

function provenanceLabel(t: TierCCopy, provenance: string): string {
  if (provenance === 'payslip_extracted' || provenance === 'user_entered') return t.provenancePayslip;
  if (provenance === 'estimated') return t.provenanceEstimated;
  return provenance;
}

export function TierCFlow({ lang, onNavigateToDictionary }: { lang: Lang; onNavigateToDictionary: () => void }) {
  const t = translations[lang].tierC;
  const progressLabels = translations[lang].progress;
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [isDragOver, setIsDragOver] = useState(false);
  const [message, setMessage] = useState('');
  const [response, setResponse] = useState<AnalyzeResponse | null>(null);
  const [dispositions, setDispositions] = useState<Record<string, Disposition>>({});
  const [correctionInputs, setCorrectionInputs] = useState<Record<string, string>>({});
  const [recomputing, setRecomputing] = useState<string | null>(null);

  async function uploadFile(file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setUploadState('error'); setMessage(lang === 'pl' ? 'Plik jest większy niż 10 MB.' : 'The file is larger than 10 MB.'); return; }
    setUploadState('uploading'); setMessage(t.analyzing);
    try {
      const images = await renderPageImages(file);
      const res = await fetch('/api/tier-c/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images }),
      });
      const data = await res.json() as AnalyzeResponse & { error_code?: string };
      if (!res.ok) {
        const code = data.error_code;
        const translated = code === 'vision_unavailable' ? t.errorVisionUnavailable
          : code === 'invalid_input' ? t.errorInvalidInput
          : code === 'extraction_failed' ? t.errorExtractionFailed
          : code === 'rate_limit_unknown' ? t.errorRateLimitUnknown
          : code === 'rate_limit_exceeded' ? t.errorRateLimitExceeded
          : t.error;
        throw new Error(translated);
      }
      setResponse(data);
      setDispositions({});
      setUploadState('idle'); setMessage('');
    } catch (error) {
      setUploadState('error'); setMessage(error instanceof Error ? error.message : t.error);
    }
  }

  function confirmDiscrepancy(code: string) {
    setDispositions(current => ({ ...current, [code]: { kind: 'confirmed' } }));
  }

  async function correctDiscrepancy(code: DiscrepancyCode) {
    if (!response) return;
    const raw = correctionInputs[code];
    const value = Number((raw ?? '').trim().replace(',', '.'));
    if (!Number.isFinite(value)) return;

    const fieldByCode: Record<DiscrepancyCode, keyof TierCPeriodResponse | null> = {
      table_tax_mismatch: 'printed_table_tax',
      bt_tax_mismatch: 'printed_bt_tax',
      algemene_heffingskorting_mismatch: 'printed_algemene_heffingskorting',
      arbeidskorting_mismatch: 'printed_arbeidskorting',
      net_mismatch: 'printed_net',
      payout_mismatch: 'printed_payout',
      minimum_wage_stale_on_document: 'wml_printed',
      minimum_wage_violation: null,
    };
    const field = fieldByCode[code];
    if (!field) return;

    setRecomputing(code);
    const correctedPeriod = { ...response.period, [field]: value };
    try {
      const res = await fetch('/api/tier-c/recompute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ period: correctedPeriod }),
      });
      const data = await res.json() as { outcome?: Outcome; discrepancies?: Discrepancy[]; error_code?: string };
      if (!res.ok || !data.outcome || !data.discrepancies) throw new Error(t.error);
      setResponse({ ...response, period: correctedPeriod, outcome: data.outcome, discrepancies: data.discrepancies });
      setDispositions(current => ({ ...current, [code]: { kind: 'corrected', correctedTo: value } }));
    } catch {
      setMessage(t.error);
    } finally {
      setRecomputing(null);
    }
  }

  if (!response) {
    return (
      <section className="flow-page">
        <div className="flow-heading">
          <span className="step">Tier C</span>
          <h1>{t.title}</h1>
          <p>{t.lead}</p>
        </div>
        <div className="notice-card contract-privacy-card">
          <ShieldCheck/>
          <div><h3>{t.aboutTitle}</h3><p>{t.aboutBody}</p></div>
        </div>
        <div className="upload-card contract-upload-card">
          <StepProgress current={uploadState === 'uploading' ? 2 : 1} labels={[progressLabels.document, progressLabels.analysis]}/>
          <h2>{t.uploadTitle}</h2>
          <p>{t.uploadLead}</p>
          <input ref={inputRef} className="hidden" type="file" accept="application/pdf,image/jpeg,image/png" onChange={event => void uploadFile(event.target.files?.[0])} aria-label={t.choose}/>
          <button
            className={`drop ${uploadState} ${isDragOver ? 'drag-over' : ''}`}
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploadState === 'uploading'}
            onDragOver={event => { event.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={event => { event.preventDefault(); setIsDragOver(false); void uploadFile(event.dataTransfer.files?.[0]); }}
          >
            <span className="upload-icon"><Upload/></span>
            <strong>{uploadState === 'uploading' ? t.analyzing : isDragOver ? t.dropHere : t.dragTitle}</strong>
            {uploadState !== 'uploading' && <span className="drop-or">{t.dragOr} <u>{t.choose}</u></span>}
            <small>{t.types}</small>
          </button>
          {message && <div className={`status ${uploadState}`} role="status">{message}</div>}
        </div>
      </section>
    );
  }

  const { period, outcome, discrepancies } = response;
  const employerNames = period.employers.map(e => e.name).filter((n): n is string => !!n).join(', ');
  const heldForLaterTotal = period.reservations.reduce((sum, r) => sum + r.opgebouwd_this_period, 0);

  // Stage 1's "never counted as a finding while unanswered" rule: effective status per code, so an
  // unanswered confirm-band item never contributes to a findings count or renders as an accusation.
  function effectiveStatus(d: Discrepancy): 'confirm' | 'finding' {
    const disposition = dispositions[d.code];
    if (disposition?.kind === 'confirmed') return 'finding';
    return d.status;
  }
  const visibleDiscrepancies = discrepancies.filter(d => dispositions[d.code]?.kind !== 'corrected');
  const findingsCount = visibleDiscrepancies.filter(d => effectiveStatus(d) === 'finding').length;

  return (
    <section className="flow-page">
      <div className="flow-heading">
        <span className="step">Tier C</span>
        <h1>{t.resultTitle}</h1>
        {period.period_label && <p>{period.period_label}{employerNames ? ` · ${employerNames}` : ''}{period.hirer?.name ? ` · ${period.hirer.name}` : ''}</p>}
      </div>

      {response.redactedFields.length > 0 && <div className="status error"><AlertTriangle size={16}/> {t.redactedNotice}</div>}
      {response.truncated && <div className="status error"><AlertTriangle size={16}/> {t.truncatedNotice}</div>}

      <div className="result-grid">
        <article><span>{t.grossTotal}</span><strong>{money(period.hour_lines.reduce((s, l) => s + l.amount, 0))}</strong></article>
        <article><span>{t.taxTable}</span><strong>{money(outcome.status === 'complete' ? outcome.result.table_tax_after_korting : outcome.table_tax_after_korting)}</strong></article>
        {(outcome.status === 'complete' ? outcome.result.bt_tax : outcome.bt_tax) > 0 && (
          <article><span>{t.taxBt}</span><strong>{money(outcome.status === 'complete' ? outcome.result.bt_tax : outcome.bt_tax)}</strong></article>
        )}
      </div>

      {period.pre_tax_deductions.length > 0 && (
        <div className="notice-card">
          <ShieldCheck/>
          <div>
            <h3>{t.preTaxDeductions}</h3>
            {period.pre_tax_deductions.map((d, i) => (
              <p key={i}>
                {d.category} <span className="form-note nl-term">({t.dutchTerm(d.description)})</span>:{' '}
                <strong>{d.amount.value === null ? '—' : money(d.amount.value)}</strong>{' '}
                <span className="form-note">({provenanceLabel(t, d.amount.provenance)})</span>
              </p>
            ))}
          </div>
        </div>
      )}

      {outcome.status === 'incomplete' ? (
        <div className="notice-card">
          <AlertTriangle/>
          <div>
            <h3>{t.incompleteTitle}</h3>
            <p>{t.incompleteBody}</p>
            <ul>{outcome.missing_fields.map((f, i) => <li key={i}>{f}</li>)}</ul>
          </div>
        </div>
      ) : (
        <div className="notice-card">
          <ShieldCheck/>
          <div>
            <h3>{t.wageNet}</h3>
            <p><strong>{money(outcome.result.wage_net)}</strong></p>
            {outcome.result.net_additions_total > 0 && <p>{t.netAdditions}: <strong>+{money(outcome.result.net_additions_total)}</strong></p>}
            <p>{t.payoutAmount}: <strong>{money(outcome.result.payout_amount)}</strong></p>
          </div>
        </div>
      )}

      {/* 3-group block (§6a), mention-only exactly as Tier A's - "gone for good" reuses the same
          gross-minus-wage_net derivation; no sector-premium range exists here since nothing is
          estimated in Tier C (§9's own promise: "deductions as printed -> net as a figure"). */}
      {outcome.status === 'complete' && (
        <div className="notice-card three-groups">
          <div>
            <h3>{t.threeGroupsTitle}</h3>
            <p><strong>{t.paidNowLabel}</strong>: {money(outcome.result.payout_amount)} <span className="form-note">({t.paidNowHint})</span></p>
            <p><strong>{t.goneForGoodLabel}</strong>: {money(period.hour_lines.reduce((s, l) => s + l.amount, 0) - outcome.result.wage_net)} <span className="form-note">({t.goneForGoodHint})</span></p>
            {heldForLaterTotal > 0 && (
              <>
                <p><strong>{t.heldForLaterLabel}</strong>: {money(heldForLaterTotal)} <span className="form-note">({t.heldForLaterHint})</span></p>
                <p className="form-note">{t.heldForLaterNote}</p>
                <button type="button" className="secondary" onClick={onNavigateToDictionary}>{t.heldForLaterLink}</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Stage 1's classifier, Stage 2's interaction: silent items never reached this list at all
          (comparePeriodToDocument already filtered them server-side). 'confirm' renders as a
          question; confirming promotes it to 'finding' on screen without a server round trip;
          correcting calls /recompute and the item then disappears from this list entirely (the next
          discrepancy computation may or may not still flag it). */}
      {visibleDiscrepancies.length > 0 && (
        <div className="notice-card discrepancy-card">
          <HelpCircle/>
          <div>
            <h3>{t.discrepanciesTitle}</h3>
            <p className="form-note">{t.discrepanciesFindingsCount(findingsCount)}</p>
            {visibleDiscrepancies.map(d => {
              const status = effectiveStatus(d);
              const disposition = dispositions[d.code] ?? { kind: 'unanswered' as const };
              return (
                <div key={d.code} className={`discrepancy-item ${status}`}>
                  <p>
                    <strong>{discrepancyLabel(t, d.code)}</strong>{' '}
                    <span className="form-note">({t.weRead(money(d.printed))})</span>
                  </p>
                  {status === 'confirm' && disposition.kind === 'unanswered' ? (
                    <>
                      <p>{t.confirmQuestion(money(d.printed))}</p>
                      <div className="calc-toggles">
                        <button type="button" className="secondary" onClick={() => confirmDiscrepancy(d.code)}>{t.confirmYes}</button>
                      </div>
                      <label>{t.correctionLabel}
                        <div className="money-input">
                          <span>€</span>
                          <input inputMode="decimal" value={correctionInputs[d.code] ?? ''} onChange={event => setCorrectionInputs(c => ({ ...c, [d.code]: event.target.value.replace(/[^0-9.,-]/g, '') }))}/>
                        </div>
                      </label>
                      <button type="button" className="secondary" disabled={recomputing === d.code} onClick={() => void correctDiscrepancy(d.code)}>
                        {recomputing === d.code ? t.recomputing : t.correctSubmit}
                      </button>
                    </>
                  ) : (
                    <p className="form-note">{t.findingBody(money(d.computed ?? 0), money(d.printed))}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="form-note calc-reliability-note">{t.reliabilityNoteC}</p>
      <p className="form-note calc-reliability-note">{t.permanentLimitationNote}</p>
    </section>
  );
}
