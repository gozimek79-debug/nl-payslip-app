import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AlertTriangle, Bot, CheckCircle2, FileText, Info, RotateCcw, Trash2, Upload } from 'lucide-react';
import { browserReaderDeps, readDocumentFacts } from '../document-facts-reader.ts';
import { ACCEPT_ATTRIBUTE } from '../r3b/r3b-documents.ts';
import { money } from '../r3b/r3b-copy.ts';
import { describePeriodFieldPath, issueMessage, type ConsistencyIssue, type Discrepancy } from '../tier-c-shared.ts';
import { translations, type Lang } from '../translations.ts';
import { comparisonState, createPayslipAnalysisStore, groupIssues, printedSummary, type PayslipAnalysisDeps, type PayslipAnalysisState, type PayslipAnalysisStore, type PrintedLine, type ReplayView } from './payslip-analysis.ts';
import { PAYSLIP_COPY, type PayslipCopy } from './payslip-copy.ts';
import './payslip-analysis.css';

/**
 * FIN-02: Analiza dokumentów -> Paski wypłat. One payslip: an explicit read (existing reader), the printed facts
 * (existing Document Knowledge, by server reference) and the existing replay's checks (by server reference). Evidence
 * first: printed gross / net / payout stay apart, unread values are "not read" (never 0), the payslip's own arithmetic
 * is shown with the difference, and Loonto's calculation is compared with the printed figures ONLY when every input it
 * needs was read. No AI text here; the PRO advisor is offered for questions about the same server-held reading.
 */

const todayIso = () => new Date().toISOString().slice(0, 10);

/** The real browser dependencies: local-ocr.ts (pdf.js / canvas) is loaded only when the user asks for a read. */
export function browserPayslipDeps(): PayslipAnalysisDeps {
  return {
    fetchImpl: (input, init) => fetch(input, init),
    readFacts: async (file, kind) => readDocumentFacts(file, kind, browserReaderDeps(await import('../local-ocr.ts'))),
    readerStatus: async () => {
      const res = await fetch('/api/ai/status');
      if (!res.ok) return null;
      const data = (await res.json()) as { visionAvailable?: unknown };
      return typeof data.visionAvailable === 'boolean' ? data.visionAvailable : null;
    },
    today: todayIso,
  };
}

export interface PayslipAnalysisProps {
  lang: Lang;
  store?: PayslipAnalysisStore;
  /** Opens Calculator PRO with this server-held document context (same browser session); absent = no hand-off here. */
  onAskAdvisor?: (documentContextRef: string) => void;
}

export function PayslipAnalysis({ lang, store: injected, onAskAdvisor }: PayslipAnalysisProps) {
  const store = useMemo(() => injected ?? createPayslipAnalysisStore(browserPayslipDeps()), [injected]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const c = PAYSLIP_COPY[lang];
  const input = useRef<HTMLInputElement>(null);
  const busy = state.phase === 'reading' || state.phase === 'analysing';

  useEffect(() => { if (store.getState().readerAvailable === null) void store.checkReader(); }, [store]);

  const onFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (file) store.selectFile(file);
    if (input.current) input.current.value = '';
  };

  return (
    <section className="payslip-analysis" data-module="analysis_payslip" aria-labelledby="payslip-title">
      <div className="flow-heading">
        <h1 id="payslip-title">{c.title}</h1>
        <p>{c.lead}</p>
      </div>
      <p className="payslip-note"><Info size={16} aria-hidden="true" /> <span>{c.sampleOnly} {c.oneAtATime}</span></p>

      {state.readerAvailable === false && <p className="payslip-alert" role="alert">{c.readerUnavailable}</p>}

      {state.phase !== 'done' && (
        <div className="payslip-upload">
          <input ref={input} className="payslip-sr-only" type="file" tabIndex={-1} aria-hidden="true" accept={ACCEPT_ATTRIBUTE} onChange={(e) => onFiles(e.target.files)} data-doc-input="payslip" />
          {state.file ? (
            <div className="payslip-file">
              <FileText size={18} aria-hidden="true" />
              <span className="payslip-file-name">{c.selected(state.fileName ?? '')}</span>
              <button type="button" className="payslip-icon-button" disabled={busy} aria-label={c.remove} onClick={() => store.removeFile()}><Trash2 size={18} aria-hidden="true" /></button>
            </div>
          ) : (
            <button type="button" className="payslip-select" disabled={busy} onClick={() => input.current?.click()}><Upload size={18} aria-hidden="true" /> {c.select}</button>
          )}
          {state.file && !busy && <button type="button" className="payslip-link" onClick={() => input.current?.click()}>{c.change}</button>}
          <p className="payslip-types">{c.types}</p>
          {state.fileError && <p className="payslip-alert" role="alert">{c.rejected[state.fileError](state.fileName ?? '')}</p>}
          {state.file && (
            <div className="payslip-consent" role="group" aria-labelledby="payslip-consent-title">
              <h2 id="payslip-consent-title"><Info size={16} aria-hidden="true" /> {c.consentTitle}</h2>
              <p id="payslip-consent-text">{c.consent}</p>
              <button type="button" className="payslip-read" aria-describedby="payslip-consent-text" disabled={busy || state.readerAvailable === false} onClick={() => void store.read()}>
                {state.phase === 'reading' ? c.reading : state.phase === 'analysing' ? c.analysing : c.read}
              </button>
            </div>
          )}
          {busy && <p className="payslip-progress" role="status" aria-live="polite">{state.phase === 'reading' ? c.reading : c.analysing}</p>}
          <ErrorNotice state={state} store={store} copy={c} />
        </div>
      )}

      {state.phase === 'done' && <Results state={state} store={store} copy={c} lang={lang} onAskAdvisor={onAskAdvisor} />}
    </section>
  );
}

function ErrorNotice({ state, store, copy }: { state: PayslipAnalysisState; store: PayslipAnalysisStore; copy: PayslipCopy }) {
  const e = state.error;
  if (!e) return null;
  const text = e.stage === 'read' ? copy.readError(copy.readErrors[e.code] ?? copy.readErrors.unknown ?? e.code) : e.stage === 'reference' ? copy.referenceUnavailable : copy.analysisFailed;
  return (
    <div className="payslip-alert" role="alert" data-error={e.code}>
      <p><AlertTriangle size={16} aria-hidden="true" /> {text}</p>
      {e.stage === 'facts' && state.batchRefs && <button type="button" className="payslip-secondary" onClick={() => void store.retryAnalysis()}>{copy.retryAnalysis}</button>}
      {e.stage !== 'facts' && state.file && state.readerAvailable !== false && <button type="button" className="payslip-secondary" onClick={() => void store.read()}>{copy.retryRead}</button>}
    </div>
  );
}

function Amount({ label, line, copy, lang, kind }: { label: string; line: PrintedLine | null; copy: PayslipCopy; lang: Lang; kind: string }) {
  return (
    <div className={`payslip-amount${line ? '' : ' is-unknown'}`} data-amount={kind}>
      <span className="payslip-amount-label">{label}</span>
      {line ? <strong className="payslip-amount-value">{money(line.value, lang)}</strong> : <span className="payslip-amount-value">{copy.notRead}</span>}
      {line?.label && <span className="payslip-amount-printed">{copy.asPrinted(line.label)}</span>}
    </div>
  );
}

function Results({ state, store, copy, lang, onAskAdvisor }: { state: PayslipAnalysisState; store: PayslipAnalysisStore; copy: PayslipCopy; lang: Lang; onAskAdvisor?: (ref: string) => void }) {
  if (state.error) {
    return (<div className="payslip-upload"><ErrorNotice state={state} store={store} copy={copy} /><button type="button" className="payslip-secondary" onClick={() => store.reset()}><RotateCcw size={16} aria-hidden="true" /> {copy.another}</button></div>);
  }
  const s = printedSummary(state.facts ?? []);
  const fmtHours = (h: number | null) => (h === null ? null : new Intl.NumberFormat(lang === 'pl' ? 'pl-PL' : 'en-GB', { maximumFractionDigits: 2 }).format(h));
  const payoutNetDifference = s.payout && s.net && Math.abs(s.payout.value - s.net.value) >= 0.01 ? Math.round(Math.abs(s.payout.value - s.net.value) * 100) / 100 : null;
  const coverage = state.coverage;
  return (
    <div className="payslip-results" data-phase="done">
      <section className="payslip-card" aria-labelledby="payslip-summary-title">
        <h2 id="payslip-summary-title">{copy.summaryTitle}</h2>
        <p>{s.period ? copy.period(s.period, s.periodStart, s.periodEnd) : copy.periodUnknown}</p>
        <p>{s.rates.length === 0 ? copy.rateUnknown : s.rates.length === 1 ? copy.rate(money((s.rates[0] as PrintedLine).value, lang)) : copy.rateConflict(s.rates.map((r) => money(r.value, lang)))}</p>
        <p>{s.regularHours === null && s.overtimeHours === null ? copy.hoursUnknown : copy.hours(fmtHours(s.regularHours), fmtHours(s.overtimeHours))}</p>
        {coverage && <p className={coverage.notProcessedPages.length > 0 ? 'payslip-warning' : 'payslip-muted'}>{coverage.notProcessedPages.length > 0 ? copy.coveragePartial(coverage.notProcessedPages.join(', '), coverage.totalPages) : copy.coverageFull(coverage.totalPages)}</p>}
        <div className="payslip-amounts">
          <Amount label={copy.grossLabel} line={s.gross} copy={copy} lang={lang} kind="gross" />
          <Amount label={copy.netLabel} line={s.net} copy={copy} lang={lang} kind="net" />
          <Amount label={copy.payoutLabel} line={s.payout} copy={copy} lang={lang} kind="payout" />
        </div>
        {payoutNetDifference !== null && <p>{copy.payoutVsNet(money(payoutNetDifference, lang))}</p>}
        <p className="payslip-muted">{copy.printedNote}</p>
      </section>

      <details className="payslip-card payslip-items">
        <summary>{copy.itemsTitle}</summary>
        <ItemGroup title={copy.payLinesTitle} copy={copy} rows={s.payLines.map((l) => ({ label: l.label, value: [l.hours !== null ? `${fmtHours(l.hours)} h` : null, l.amount !== null ? money(l.amount, lang) : null].filter(Boolean).join(' · '), page: l.page }))} />
        <ItemGroup title={copy.surchargesTitle} copy={copy} rows={s.surcharges.map((l) => ({ label: l.label, value: `${fmtHours(l.percent)}%`, page: l.page }))} />
        <ItemGroup title={copy.deductionsTitle} copy={copy} rows={s.deductions.map((l) => ({ label: l.label, value: money(l.value, lang), page: l.page }))} />
        <ItemGroup title={copy.taxTitle} copy={copy} rows={s.tax.map((l) => ({ label: l.label, value: money(l.value, lang), page: l.page }))} />
        <ItemGroup title={copy.reimbursementsTitle} copy={copy} rows={s.reimbursements.map((l) => ({ label: l.label, value: money(l.value, lang), page: l.page }))} />
      </details>

      <Checks state={state} store={store} copy={copy} lang={lang} />

      <section className="payslip-card payslip-limits" aria-labelledby="payslip-limits-title">
        <h2 id="payslip-limits-title">{copy.limitsTitle}</h2>
        <ul>{copy.limits.map((l) => <li key={l}>{l}</li>)}</ul>
        <p className="payslip-muted">{copy.notAdvice}</p>
      </section>

      <div className="payslip-actions">
        {state.contextRef && onAskAdvisor && (
          <div className="payslip-advisor">
            <button type="button" className="payslip-primary" onClick={() => onAskAdvisor(state.contextRef as string)}><Bot size={18} aria-hidden="true" /> {copy.askAdvisor}</button>
            <p className="payslip-muted">{copy.askAdvisorNote}</p>
          </div>
        )}
        <button type="button" className="payslip-secondary" onClick={() => store.reset()}><RotateCcw size={16} aria-hidden="true" /> {copy.another}</button>
      </div>
    </div>
  );
}

function ItemGroup({ title, rows, copy }: { title: string; rows: Array<{ label: string | null; value: string; page: number | null }>; copy: PayslipCopy }) {
  return (
    <div className="payslip-item-group">
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="payslip-muted">{copy.noItems}</p> : (
        <ul>{rows.map((r, i) => <li key={i}><span className="payslip-item-label">{r.label ?? copy.unlabelled}</span><span className="payslip-item-value">{r.value}</span>{r.page !== null && <span className="payslip-item-page">{copy.page(r.page)}</span>}</li>)}</ul>
      )}
    </div>
  );
}

function issueText(issue: ConsistencyIssue, replay: ReplayView, lang: Lang): string {
  const t = translations[lang].tierC;
  if (issue.code === 'amount_unreadable') return issueMessage(t, { ...issue, field: describePeriodFieldPath(replay.period, issue.field) ?? (lang === 'pl' ? 'pozycja paska' : 'a payslip item') });
  return issueMessage(t, issue);
}

function discrepancyLabel(d: Discrepancy, lang: Lang): string {
  const t = translations[lang].tierC;
  return ({
    table_tax_mismatch: t.codeTableTax, bt_tax_mismatch: t.codeBtTax, algemene_heffingskorting_mismatch: t.codeAlgemeneHeffingskorting,
    arbeidskorting_mismatch: t.codeArbeidskorting, net_mismatch: t.codeNet, payout_mismatch: t.codePayout,
    minimum_wage_stale_on_document: t.codeMinimumWage, minimum_wage_violation: t.codeMinimumWage,
  } as Record<Discrepancy['code'], string>)[d.code];
}

function Checks({ state, store, copy, lang }: { state: PayslipAnalysisState; store: PayslipAnalysisStore; copy: PayslipCopy; lang: Lang }) {
  const replay = state.replay;
  if (!replay) {
    return (
      <section className="payslip-card" aria-labelledby="payslip-checks-title" data-checks="unavailable">
        <h2 id="payslip-checks-title">{copy.checksTitle}</h2>
        {state.replayProblem && <p className="payslip-warning">{copy.replayProblem[state.replayProblem]}</p>}
        {state.replayProblem === 'document_expired' && state.file && <button type="button" className="payslip-secondary" onClick={() => void store.read()}>{copy.retryRead}</button>}
        {state.replayProblem === 'replay_failed' && <button type="button" className="payslip-secondary" onClick={() => void store.retryAnalysis()}>{copy.retryAnalysis}</button>}
      </section>
    );
  }
  const groups = groupIssues(replay.needsConfirmation ?? []);
  const comparison = comparisonState(replay);
  const t = translations[lang].tierC;
  return (
    <section className="payslip-card payslip-checks" aria-labelledby="payslip-checks-title" data-checks={comparison.kind}>
      <h2 id="payslip-checks-title">{copy.checksTitle}</h2>

      <h3>{copy.arithmeticTitle}</h3>
      <p className="payslip-muted">{copy.arithmeticIntro}</p>
      {replay.status !== 'ok' ? <p>{copy.comparisonUnavailable(replay.reason ?? 'unknown')}</p> : groups.arithmetic.length === 0 ? (
        <p className="payslip-ok"><CheckCircle2 size={16} aria-hidden="true" /> {copy.arithmeticNone}</p>
      ) : (
        <>
          <ul className="payslip-issues" data-issues="arithmetic">{groups.arithmetic.map((issue, i) => <li key={i} data-code={issue.code}>{issueText(issue, replay, lang)}</li>)}</ul>
          <p className="payslip-muted">{copy.arithmeticCauses}</p>
        </>
      )}

      <h3>{copy.comparisonTitle}</h3>
      <p className="payslip-muted">{copy.comparisonIntro}</p>
      {/* The reused notes point at the list: the database note says "below", the static-fallback note says "above". */}
      {comparison.kind === 'substantiated' && replay.taxRatesSource !== 'static' && <p className="payslip-muted">{t.discrepanciesRatesSourceNote}</p>}
      {comparison.kind === 'unavailable' && <p>{copy.comparisonUnavailable(comparison.reason)}</p>}
      {comparison.kind === 'limited' && (
        <>
          <p>{copy.comparisonLimited}</p>
          <ul className="payslip-issues" data-issues="gaps">
            {comparison.pagesNotRead.length > 0 && <li data-code="pages_not_read">{copy.gapPagesNotRead(comparison.pagesNotRead.join(', '))}</li>}
            {comparison.gaps.map((issue, i) => <li key={i} data-code={issue.code}>{issueText(issue, replay, lang)}</li>)}
            {comparison.gaps.length === 0 && comparison.pagesNotRead.length === 0 && <li data-code="incomplete">{copy.gapIncomplete}</li>}
          </ul>
        </>
      )}
      {comparison.kind === 'substantiated' && (comparison.discrepancies.length === 0 ? (
        <p className="payslip-ok"><CheckCircle2 size={16} aria-hidden="true" /> {copy.comparisonNone}</p>
      ) : (
        <ul className="payslip-discrepancies">
          {comparison.discrepancies.map((d) => (
            <li key={d.code} data-code={d.code} data-status={d.status}>
              <p className="payslip-discrepancy-head"><strong>{discrepancyLabel(d, lang)}</strong>{d.printed_label && <span className="payslip-muted"> ({copy.asPrinted(d.printed_label)})</span>} <span className={`payslip-status payslip-status-${d.status}`}>{d.status === 'confirm' ? copy.statusConfirm : copy.statusFinding}</span></p>
              <p>{d.computed === null || d.residual === null ? copy.discrepancyNoComputed(money(d.printed, lang)) : copy.discrepancyLine(money(d.computed, lang), money(d.printed, lang), money(Math.abs(d.residual), lang))}</p>
              <p className="payslip-muted">{copy.causesLabel} {copy.causes[d.code]}.</p>
            </li>
          ))}
        </ul>
      ))}
      {comparison.kind === 'substantiated' && replay.taxRatesSource === 'static' && <p className="payslip-muted">{t.discrepanciesRatesSourceStaticNote}</p>}

      {groups.uncertain.length > 0 && (
        <>
          <h3>{copy.uncertainTitle}</h3>
          <ul className="payslip-issues" data-issues="uncertain">{groups.uncertain.map((issue, i) => <li key={i} data-code={issue.code}>{issueText(issue, replay, lang)}</li>)}</ul>
        </>
      )}
      <p className="payslip-proof">{copy.notProof}</p>
    </section>
  );
}
