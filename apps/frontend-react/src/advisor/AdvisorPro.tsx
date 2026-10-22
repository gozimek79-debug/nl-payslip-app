import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AlertTriangle, Bot, Calculator, FileText, Info, RotateCcw, Send, Trash2, Upload } from 'lucide-react';
import type { ProDocumentType } from '../pro-documents-policy.ts';
import { browserReaderDeps, readDocumentFacts } from '../document-facts-reader.ts';
import { ACCEPT_ATTRIBUTE, documentOrdinal } from '../r3b/r3b-documents.ts';
import type { AdvisorLocale, NavigationOffer } from './advisor-client.ts';
import { ADVISOR_COPY, orientationFigures, type AdvisorCopy } from './advisor-copy.ts';
import { createAdvisorStore, type AdvisorDeps, type AdvisorState, type AdvisorStore, type ThreadItem } from './advisor-store.ts';
import { textBlocks } from './advisor-text.ts';
import '../r3a/r3a.css';
import '../r3b/r3b.css';
import './advisor.css';

/**
 * AI-001 Kalkulator PRO - the model-led AI advisor, inside the Loonto module shell (App.tsx). The user writes; the
 * server's advisor (a real model with typed, server-side tools) writes every answer shown here. This screen adds only
 * chrome: the documents box (the existing reader, by explicit action), tool chips, the structured orientation card
 * (a server tool result, never parsed out of the model's text), module links and honest error notices.
 */

const todayIso = () => new Date().toISOString().slice(0, 10);

/** The real browser dependencies: local-ocr.ts (pdf.js / canvas) is loaded only when the user asks for a read. */
export function browserAdvisorDeps(): AdvisorDeps {
  return {
    fetchImpl: (input, init) => fetch(input, init),
    readFacts: async (file, kind) => readDocumentFacts(file, kind, browserReaderDeps(await import('../local-ocr.ts'))),
    today: todayIso,
  };
}

export interface AdvisorProProps {
  lang: AdvisorLocale;
  store?: AdvisorStore;
  onNavigate: (target: NavigationOffer['target']) => void;
  onOpenDocumentsPro: () => void;
  /** FIN-02: a document context Payslip Analysis built for this session - the advisor starts with it. */
  initialDocumentContextRef?: string | null;
}

export function AdvisorPro({ lang, store: injected, onNavigate, onOpenDocumentsPro, initialDocumentContextRef }: AdvisorProProps) {
  const store = useMemo(() => injected ?? createAdvisorStore(browserAdvisorDeps(), lang, { documentContextRef: initialDocumentContextRef ?? null }), [injected]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  // The shell owns the language; the store follows it (it sends the locale with each question).
  const c = ADVISOR_COPY[lang];
  const [draft, setDraft] = useState('');
  const threadEnd = useRef<HTMLLIElement>(null);

  useEffect(() => { if (store.getState().lang !== lang) store.setLang(lang); }, [lang, store]);
  useEffect(() => { if (store.getState().advisorAvailable === null) void store.checkAvailability(); }, [store]);
  useEffect(() => {
    if (state.thread.length > 0) threadEnd.current?.scrollIntoView?.({ block: 'nearest' });
  }, [state.thread.length, state.busy]);

  const unavailable = state.advisorAvailable === false;
  const inputDisabled = state.busy || state.reading || unavailable;
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft;
    if (!text.trim() || inputDisabled) return;
    setDraft('');
    await store.send(text);
  }

  const lastId = state.thread[state.thread.length - 1]?.id;
  return (
    <section className="flow-page advisor-page" data-advisor="ai-001" aria-labelledby="advisor-title">
      <div className="advisor-heading">
        <h1 id="advisor-title">{c.title}</h1>
        <span className="r3a-badge advisor-badge">{c.badge}</span>
        <p>{c.lead}</p>
      </div>

      {/* When this host cannot run the advisor, that is the first thing the user reads - before any note or input. */}
      {unavailable && (
        <div className="advisor-unavailable" role="alert" data-advisor-unavailable="true">
          <h2>{c.unavailableTitle}</h2>
          <p>{c.unavailableBody}</p>
          <div className="advisor-actions">
            <button type="button" className="advisor-link-button" onClick={() => onNavigate('calculator_free')}><Calculator size={16} aria-hidden="true" /> {c.navigation.targets.calculator_free}</button>
            <button type="button" className="advisor-link-button" onClick={onOpenDocumentsPro}>{c.fallback.documentsPro}</button>
          </div>
        </div>
      )}
      <div className="advisor-notes" role="note">
        <p><AlertTriangle size={16} aria-hidden="true" /> <span><strong>{c.alphaNote}</strong> {c.privacyNote}</span></p>
      </div>

      {state.advisorAvailable === null && <p className="advisor-checking">{c.checking}</p>}

      <Documents state={state} store={store} copy={c} />

      <ol className="r3a-thread advisor-thread" role="log" aria-live="polite" aria-label={c.threadLabel}>
        {state.thread.length === 0 && !unavailable && <li className="advisor-empty">{c.emptyThread}</li>}
        {state.thread.map((item) => <ThreadEntry key={item.id} item={item} state={state} store={store} copy={c} lang={lang} last={item.id === lastId} onNavigate={onNavigate} />)}
        {state.busy && <li className="r3a-msg r3a-msg-loonto"><div className="r3a-bubble r3b-typing"><p>{c.composer.busy}</p></div></li>}
        <li ref={threadEnd} aria-hidden="true" className="r3b-thread-end" />
      </ol>

      <form className={`r3a-composer advisor-composer${unavailable ? ' is-locked' : ''}`} onSubmit={(e) => void submit(e)}>
        <div className="r3a-input-row">
          <label className="r3a-sr-only" htmlFor="advisor-input">{c.composer.inputLabel}</label>
          <input id="advisor-input" value={draft} maxLength={1000} disabled={inputDisabled} placeholder={c.composer.placeholder} autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="r3a-send" disabled={inputDisabled || draft.trim().length === 0} aria-label={c.composer.send}><Send size={20} aria-hidden="true" /></button>
        </div>
        <p className="r3a-input-note">{c.scopeNote}</p>
      </form>

      <div className="advisor-footer">
        <button type="button" className="r3a-reset" disabled={state.busy || state.reading} onClick={() => { setDraft(''); store.reset(); }}><RotateCcw size={16} aria-hidden="true" /> {c.reset}</button>
        <nav className="advisor-fallback" aria-label={c.fallback.title}>
          <span>{c.fallback.title}:</span>
          <button type="button" className="advisor-text-link" onClick={onOpenDocumentsPro}>{c.fallback.documentsPro}</button>
          <a className="advisor-text-link" href="/?r3b=1">{c.fallback.r3b}</a>
        </nav>
      </div>
    </section>
  );
}

function ThreadEntry({ item, state, store, copy, lang, last, onNavigate }: { item: ThreadItem; state: AdvisorState; store: AdvisorStore; copy: AdvisorCopy; lang: AdvisorLocale; last: boolean; onNavigate: AdvisorProProps['onNavigate'] }) {
  if (item.from === 'user') {
    return <li className="r3a-msg r3a-msg-user"><div className="r3a-bubble"><p className="r3a-msg-meta">{copy.youName}</p><p>{item.text}</p></div></li>;
  }
  if (item.from === 'notice') {
    if (item.kind === 'info') return <li className="advisor-notice advisor-notice-info" role="status"><Info size={16} aria-hidden="true" /> <span>{copy.info[item.info]}</span></li>;
    const canRetry = last && state.lastFailedMessage !== null && !['advisor_not_configured', 'invalid'].includes(item.failure);
    return (
      <li className="advisor-notice advisor-notice-error" role="alert" data-failure={item.failure}>
        <AlertTriangle size={16} aria-hidden="true" /> <span>{copy.failures[item.failure]}</span>
        {canRetry && <button type="button" className="advisor-retry" disabled={state.busy} onClick={() => void store.retry()}>{copy.retry}</button>}
      </li>
    );
  }
  const used = item.tools.filter((t) => t.status === 'ok' || t.status === 'refused');
  return (
    <li className="r3a-msg r3a-msg-loonto">
      <div className="r3a-bubble advisor-answer" data-author="model">
        <p className="r3a-msg-meta"><Bot size={14} aria-hidden="true" /> {copy.advisorName}</p>
        {textBlocks(item.text).map((block, i) => (block.kind === 'p'
          ? <p key={i}>{block.text}</p>
          : block.kind === 'ul'
            ? <ul key={i}>{block.items.map((line, j) => <li key={j}>{line}</li>)}</ul>
            : <ol key={i}>{block.items.map((line, j) => <li key={j}>{line}</li>)}</ol>))}
        {item.orientation && <Orientation item={item} lang={lang} copy={copy} />}
        {item.navigation.length > 0 && <Navigation offers={item.navigation} copy={copy} onNavigate={onNavigate} />}
        {used.length > 0 && (
          <p className="advisor-tools"><span>{copy.tools.label}</span> {used.map((t, i) => <span key={i} className={`advisor-tool advisor-tool-${t.status}`}>{copy.tools.names[t.name] ?? t.name}{t.status === 'refused' ? ` (${copy.tools.refused})` : ''}</span>)}</p>
        )}
        <p className="advisor-model">{copy.modelLabel(item.model)}</p>
      </div>
    </li>
  );
}

function Orientation({ item, lang, copy }: { item: Extract<ThreadItem, { from: 'advisor' }>; lang: AdvisorLocale; copy: AdvisorCopy }) {
  const o = item.orientation;
  if (!o) return null;
  const f = orientationFigures(o, lang);
  return (
    <div className="advisor-orientation" data-result-type={o.resultType}>
      <p className="advisor-orientation-title">{copy.orientation.title}</p>
      <p className="advisor-orientation-formula">{copy.orientation.formula(f.hours, f.rate, f.amount)}</p>
      <p>{copy.orientation.basis(o.hoursBasis)}</p>
      <p>{copy.orientation.rateSource(o.rateSource)}</p>
      <p className="advisor-orientation-excl">{copy.orientation.excludesTitle}</p>
      <ul>{o.excludes.map((e) => <li key={e}>{copy.orientation.excludes[e] ?? e}</li>)}</ul>
      <p className="advisor-orientation-note">{copy.orientation.note}</p>
    </div>
  );
}

function Navigation({ offers, copy, onNavigate }: { offers: NavigationOffer[]; copy: AdvisorCopy; onNavigate: AdvisorProProps['onNavigate'] }) {
  return (
    <div className="advisor-nav" role="group" aria-label={copy.navigation.title}>
      {offers.map((o) => {
        const label = copy.navigation.targets[o.target];
        // A module that is not live is shown as such - never as a working link. PRO is the page the user is on.
        if (o.status === 'coming_soon' || o.target === 'calculator_pro') {
          return <span key={o.target} className={`advisor-nav-chip advisor-nav-${o.status}`} data-target={o.target}>{label} · {copy.navigation.status[o.status]}</span>;
        }
        return <button key={o.target} type="button" className="advisor-nav-button" data-target={o.target} onClick={() => onNavigate(o.target)}>{copy.navigation.open(label)}{o.status === 'alpha' ? ` · ${copy.navigation.status.alpha}` : ''}</button>;
      })}
    </div>
  );
}

function Documents({ state, store, copy }: { state: AdvisorState; store: AdvisorStore; copy: AdvisorCopy }) {
  const inputs = { payslip: useRef<HTMLInputElement>(null), contract_base: useRef<HTMLInputElement>(null) };
  const editable = !state.busy && !state.reading;
  const unread = state.docs.filter((d) => d.file && (d.status === 'selected' || d.status === 'failed'));
  const r = copy.r3b;
  const onFiles = (type: 'payslip' | 'contract_base', files: FileList | null) => {
    if (files && files.length > 0) store.addFiles(Array.from(files), type as ProDocumentType);
    const input = inputs[type].current;
    if (input) input.value = '';
  };
  const add: Array<['payslip' | 'contract_base', string]> = [['payslip', copy.documents.addPayslip], ['contract_base', copy.documents.addContract]];
  return (
    <details className="r3b-offer advisor-docs" open={state.docs.length > 0 || undefined}>
      <summary className="r3b-offer-title"><FileText size={18} aria-hidden="true" /> {copy.documents.title}{state.documentContextRef ? ` · ${copy.documents.inContext}` : ''}</summary>
      <p className="advisor-docs-lead">{copy.documents.lead}</p>
      <div className="r3b-offer-actions advisor-docs-actions">
        {add.map(([type, label]) => (
          <span key={type} className="r3b-add">
            <input ref={inputs[type]} className="r3a-sr-only" type="file" tabIndex={-1} aria-hidden="true" accept={ACCEPT_ATTRIBUTE} multiple onChange={(e) => onFiles(type, e.target.files)} data-doc-input={type} />
            <button type="button" className="r3b-add-button" disabled={!editable} onClick={() => inputs[type].current?.click()}><Upload size={18} aria-hidden="true" /> {label}</button>
          </span>
        ))}
      </div>
      <p className="r3b-types">{r.offer.types}</p>
      {state.readerAvailable === false && <p className="r3b-reader-unavailable" role="alert">{copy.documents.readerUnavailable}</p>}
      {state.fileErrors.length > 0 && <ul className="r3b-file-errors" role="alert">{state.fileErrors.map((e, i) => <li key={i}>{r.offer.rejected[e.reason](e.name)}</li>)}</ul>}
      {state.docs.length > 0 && (
        <ul className="r3b-doc-list" aria-label={r.offer.listLabel}>
          {state.docs.map((d) => {
            const ordinal = documentOrdinal(state.docs, d.id);
            const name = ordinal ? r.docName(ordinal.documentType, ordinal.n) : r.roles[d.documentType];
            return (
              <li key={d.id} className={`r3b-doc r3b-doc-${d.status}`}>
                <div className="r3b-doc-main">
                  <span className="r3b-doc-name">{name}</span>
                  <span className="r3b-doc-file">{d.fileName} · {r.offer.size(d.size)}</span>
                  <span className={`r3b-doc-status r3b-doc-status-${d.status}`}>{r.offer.status[d.status]}</span>
                  {d.status === 'failed' && d.errorCode && <span className="r3b-doc-error">{r.readReport.errors[d.errorCode] ?? r.readReport.errors.unknown}</span>}
                </div>
                <button type="button" className="r3b-remove" disabled={!editable} aria-label={r.offer.remove(`${name} (${d.fileName})`)} onClick={() => store.removeDocument(d.id)}>
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {unread.length > 0 && (
        <div className="r3b-consent" role="group" aria-labelledby="advisor-consent-title">
          <h3 id="advisor-consent-title"><Info size={16} aria-hidden="true" /> {r.offer.consentTitle}</h3>
          <p id="advisor-consent-text">{r.offer.consent}</p>
          <button type="button" className="r3b-read" aria-describedby="advisor-consent-text" disabled={!editable || state.readerAvailable === false} onClick={() => void store.read()}>{state.reading ? copy.documents.reading : copy.documents.read(unread.length)}</button>
        </div>
      )}
    </details>
  );
}
