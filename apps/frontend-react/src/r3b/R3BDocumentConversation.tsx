import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { AlertTriangle, FileText, Info, Lock, PanelRightOpen, RotateCcw, Send, Trash2, Upload } from 'lucide-react';
import type { ProDocumentType } from '../pro-documents-policy.ts';
import { browserReaderDeps, readDocumentFacts } from '../document-facts-reader.ts';
import { newDecisionId } from '../pro-profile-questions.ts';
import { ACCEPT_ATTRIBUTE, documentOrdinal, type PeriodChoice } from './r3b-documents.ts';
import { createR3BStore, isEditable, panelRows, resultReasons, type Block, type R3BDeps, type R3BState, type R3BStore } from './r3b-flow.ts';
import { choiceLabel, describeTurn, documentName, factValue, readReportLines, sourceDetails, sourceWhere } from './r3b-describe.ts';
import { R3B_COPY, fieldLabel, formatDate, formatValue, money, scenarioUnit, type R3BCopy, type R3BLang } from './r3b-copy.ts';
import { suggestionsFor } from './r3b-turn.ts';
import type { KnownFact } from './r3b-profile-projection.ts';
import '../r3a/r3a.css';
import './r3b.css';

/**
 * R3-B owner-review screen (`/?r3a=1`): documents first (optional), the existing reader and Payroll Profile, a short
 * evidence-aware summary, then the existing R2 conversation - one question at a time. Conversation first; scenario and
 * result secondary. No pay amount is shown anywhere. Only the language preference is stored (localStorage).
 */

const LANG_KEY = 'loonto-lang';

function readLang(): R3BLang {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'pl';
  } catch {
    return 'pl';
  }
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** The real browser dependencies: local-ocr.ts (pdf.js / canvas) is loaded only when the user asks for a read. */
export function browserDeps(): R3BDeps {
  return {
    readFacts: async (file, kind) => readDocumentFacts(file, kind, browserReaderDeps(await import('../local-ocr.ts'))),
    fetchImpl: (input, init) => fetch(input, init),
    today: todayIso,
    now: () => new Date().toISOString(),
    newDecisionId,
  };
}

export function R3BDocumentConversation({ store: injected, initialLang }: { store?: R3BStore; initialLang?: R3BLang } = {}) {
  const store = useMemo(() => injected ?? createR3BStore(browserDeps(), initialLang ?? readLang()), [injected, initialLang]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const c = R3B_COPY[state.lang];
  const [draft, setDraft] = useState('');
  const threadEnd = useRef<HTMLLIElement>(null);

  useEffect(() => {
    document.title = c.pageTitle;
    document.documentElement.lang = state.lang;
    try { localStorage.setItem(LANG_KEY, state.lang); } catch { /* storage unavailable - preference not kept */ }
  }, [c.pageTitle, state.lang]);

  useEffect(() => {
    if (state.messages.length > 1) threadEnd.current?.scrollIntoView?.({ block: 'nearest' });
  }, [state.messages.length]);

  const inputDisabled = state.busy || state.phase === 'reading';
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft;
    if (!text.trim() || inputDisabled) return;
    setDraft('');
    await store.send(text);
  }

  const latestId = state.messages[state.messages.length - 1]?.id;
  return (
    <div className="r3a-shell r3b-shell" data-entry="r3b">
      <header className="r3a-header">
        <div className="r3a-header-brand">
          <a className="r3a-brand" href="/">Loonto</a>
          <span className="r3a-badge">{c.badge}</span>
        </div>
        <div className="r3a-header-actions">
          <div className="r3a-lang" role="group" aria-label={c.langLabel}>
            <button type="button" className={state.lang === 'pl' ? 'active' : ''} aria-pressed={state.lang === 'pl'} onClick={() => store.setLang('pl')}>PL</button>
            <button type="button" className={state.lang === 'en' ? 'active' : ''} aria-pressed={state.lang === 'en'} onClick={() => store.setLang('en')}>EN</button>
          </div>
          <button type="button" className="r3a-panel-toggle" aria-expanded={state.panelOpen} aria-controls="r3b-panel" onClick={() => store.setPanel(!state.panelOpen)}>
            <PanelRightOpen size={18} aria-hidden="true" /> {c.panel.toggle}
          </button>
        </div>
      </header>

      <div className="r3a-banner r3b-test-banner" role="note">
        <AlertTriangle size={18} aria-hidden="true" />
        <p><strong>{c.testBanner}</strong> <span className="r3b-banner-detail">{c.bannerDetail} <a href="/?legacy=1">{c.backToCurrent}</a></span></p>
      </div>

      <div className="r3a-layout">
        <main className="r3a-main" aria-labelledby="r3b-title">
          <section className="r3a-hero is-compact r3b-hero">
            <h1 id="r3b-title">{c.title}</h1>
            <p>{c.lead}</p>
          </section>

          <ol className="r3a-thread" role="log" aria-live="polite" aria-label={c.threadLabel}>
            {state.messages.flatMap((m) => [
              <li key={m.id} className={`r3a-msg r3a-msg-${m.from}`}>
                <div className="r3a-bubble">
                  <p className="r3a-msg-meta">{m.from === 'loonto' ? c.loontoName : c.youName}</p>
                  <BlockView block={m.block} state={state} store={store} copy={c} latest={m.id === latestId} />
                </div>
              </li>,
              // The document offer belongs to the welcome message, at full width so all its actions fit a phone screen.
              ...(m.block.kind === 'welcome' ? [<li key="offer" className="r3b-offer-item"><DocumentOffer state={state} store={store} copy={c} /></li>] : []),
            ])}
            {state.busy && (
              <li className="r3a-msg r3a-msg-loonto"><div className="r3a-bubble r3b-typing"><p>{state.phase === 'reading' ? c.offer.reading : c.composer.busy}</p></div></li>
            )}
            <li ref={threadEnd} aria-hidden="true" className="r3b-thread-end" />
          </ol>

          <form className="r3a-composer" onSubmit={(e) => void submit(e)}>
            <Choices state={state} store={store} copy={c} />
            <div className="r3a-input-row">
              <label className="r3a-sr-only" htmlFor="r3b-input">{c.composer.inputLabel}</label>
              <input id="r3b-input" value={draft} maxLength={1000} disabled={inputDisabled} placeholder={c.composer.placeholder} autoComplete="off" onChange={(e) => setDraft(e.target.value)} />
              <button type="submit" className="r3a-send" disabled={inputDisabled || draft.trim().length === 0} aria-label={c.composer.send}><Send size={20} aria-hidden="true" /></button>
            </div>
            {state.phase !== 'documents' && <p className="r3a-input-note">{c.composer.note}</p>}
          </form>
        </main>

        <aside id="r3b-panel" className={`r3a-panel${state.panelOpen ? ' is-open' : ''}`} aria-label={c.panel.toggle}>
          <ScenarioCard state={state} store={store} copy={c} />
          <ResultCard state={state} copy={c} />
          <section className="r3a-card r3a-analyzer" aria-labelledby="r3b-analyzer-title">
            <div className="r3a-card-head"><h2 id="r3b-analyzer-title">{c.panel.analyzerTitle}</h2></div>
            <button type="button" className="r3a-analyzer-button" aria-disabled="true" onClick={(e) => e.preventDefault()}><Lock size={16} aria-hidden="true" /> {c.panel.analyzerButton}</button>
            <p>{c.panel.analyzerNote}</p>
          </section>
          <button type="button" className="r3a-reset" onClick={() => { setDraft(''); store.reset(); }}><RotateCcw size={16} aria-hidden="true" /> {c.panel.reset}</button>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Conversation blocks
// ---------------------------------------------------------------------------------------------

function BlockView({ block, state, store, copy, latest }: { block: Block; state: R3BState; store: R3BStore; copy: R3BCopy; latest: boolean }) {
  const lang = state.lang;
  switch (block.kind) {
    case 'welcome':
      return <p>{copy.welcome}</p>;
    case 'user_text':
      return <p>{block.text}</p>;
    case 'user_choice':
      return <p>{choiceLabel(block.choice, state.docs, copy, lang)}</p>;
    case 'read_report':
      return <>{readReportLines(block.items, block.anyRead, state.docs, copy).map((line, i) => <p key={i}>{line}</p>)}</>;
    case 'period_question':
      return <PeriodQuestion boundaries={block.boundaries} state={state} store={store} copy={copy} active={latest && state.phase === 'period'} />;
    case 'period_chosen':
      return <p>{block.asOf ? copy.period.chosen(formatDate(block.asOf, lang)) : copy.period.unknownNote}</p>;
    case 'summary':
      return <Summary block={block} state={state} copy={copy} />;
    case 'goal_question':
      return (<><p className="r3b-question">{copy.goal.question}</p><p>{block.withDocuments ? copy.goal.lead : copy.goal.leadNoDocs}</p></>);
    case 'conflict_question': {
      const [a, b] = block.fact.candidates;
      const show = (cand: KnownFact['candidates'][number] | undefined) => (cand && typeof cand.value === 'number' ? `${money(cand.value, lang)}/h (${cand.sources.map((s) => sourceWhere(s, state.docs, copy, lang)).join(', ')})` : '');
      return <p className="r3b-question">{copy.conflict.question(show(a), show(b))}</p>;
    }
    case 'conflict_result':
      return <p>{block.outcome === 'left_open' ? copy.conflict.leftOpen : block.outcome === 'failed' ? copy.conflict.failed : copy.conflict.chosen(`${money(block.value ?? 0, lang)}/h`)}</p>;
    case 'percent_question':
      return <p className="r3b-question">{copy.percent.question(block.value, fieldLabel(block.field, lang))}</p>;
    case 'turn': {
      const d = describeTurn(block, copy, lang);
      return (
        <>
          {d.lines.map((line, i) => <p key={`l${i}`}>{line}</p>)}
          {d.question && <p className="r3b-question">{d.question}</p>}
          {d.closing.map((line, i) => <p key={`c${i}`} className={i === d.closing.length - 1 ? 'r3b-no-result' : undefined}>{line}</p>)}
        </>
      );
    }
    case 'turn_failed':
      return <p className="r3b-warn">{copy.turn.failed[block.reason]}</p>;
    case 'edit_saved':
      return <p>{copy.turn.saved(fieldLabel(block.field, lang), formatValue(scenarioUnit(block.field), block.value, lang))} {copy.panel.editNote}</p>;
    case 'note': {
      const text = block.note === 'unread_first' ? copy.offer.unreadFirst : block.note === 'too_long' ? copy.composer.tooLong : block.note === 'conflict_pick' ? copy.conflict.pick
        : block.note === 'percent_pick' ? copy.percent.pick : block.note === 'annex_date_missing' ? copy.offer.annexDateMissing : copy.period.otherDay;
      return <p className="r3b-warn">{text}</p>;
    }
  }
}

function DocumentOffer({ state, store, copy }: { state: R3BState; store: R3BStore; copy: R3BCopy }) {
  const inputs = { payslip: useRef<HTMLInputElement>(null), contract_base: useRef<HTMLInputElement>(null), contract_annex: useRef<HTMLInputElement>(null) };
  const editable = store.canEditDocuments();
  const unread = state.docs.filter((d) => d.file && (d.status === 'selected' || d.status === 'failed'));
  const pick = (type: ProDocumentType) => inputs[type].current?.click();
  const onFiles = (type: ProDocumentType, files: FileList | null) => {
    if (files && files.length > 0) store.addFiles(Array.from(files), type);
    const input = inputs[type].current;
    if (input) input.value = '';
  };
  const add: Array<[ProDocumentType, string]> = [['payslip', copy.offer.addPayslip], ['contract_base', copy.offer.addContract], ['contract_annex', copy.offer.addAnnex]];
  return (
    <section className="r3b-offer" aria-labelledby="r3b-offer-title">
      <h2 id="r3b-offer-title" className="r3b-offer-title"><FileText size={18} aria-hidden="true" /> {copy.offer.title}</h2>
      <div className="r3b-offer-actions">
        {add.map(([type, label]) => (
          <span key={type} className="r3b-add">
            <input ref={inputs[type]} className="r3a-sr-only" type="file" tabIndex={-1} aria-hidden="true" accept={ACCEPT_ATTRIBUTE} multiple onChange={(e) => onFiles(type, e.target.files)} data-doc-input={type} />
            <button type="button" className="r3b-add-button" disabled={!editable} onClick={() => pick(type)}><Upload size={18} aria-hidden="true" /> {label}</button>
          </span>
        ))}
        {state.phase === 'documents' && (
          <button type="button" className="r3b-continue" disabled={state.busy} onClick={() => store.continueWithoutDocuments()}>{copy.offer.continueWithout}</button>
        )}
      </div>
      <p className="r3b-types">{copy.offer.types}</p>
      {state.fileErrors.length > 0 && (
        <ul className="r3b-file-errors" role="alert">
          {state.fileErrors.map((e, i) => <li key={i}>{copy.offer.rejected[e.reason](e.name)}</li>)}
        </ul>
      )}
      {state.docs.length > 0 && (
        <ul className="r3b-doc-list" aria-label={copy.offer.listLabel}>
          {state.docs.map((d) => {
            const name = documentName(state.docs, d.id, d.documentType, copy);
            const ordinal = documentOrdinal(state.docs, d.id);
            return (
              <li key={d.id} className={`r3b-doc r3b-doc-${d.status}`}>
                <div className="r3b-doc-main">
                  <span className="r3b-doc-name">{name}</span>
                  <span className="r3b-doc-file">{d.fileName} · {copy.offer.size(d.size)}</span>
                  <span className={`r3b-doc-status r3b-doc-status-${d.status}`}>{copy.offer.status[d.status]}</span>
                  {d.status === 'failed' && d.errorCode && <span className="r3b-doc-error">{copy.readReport.errors[d.errorCode] ?? copy.readReport.errors.unknown}</span>}
                  {d.status === 'read' && d.coverage && d.coverage.notProcessedPages.length > 0 && (
                    <span className="r3b-doc-error">{copy.readReport.partial(name, d.coverage.notProcessedPages.join(', '), d.coverage.totalPages, d.coverage.reason === 'document_too_long')}</span>
                  )}
                </div>
                {d.documentType === 'contract_annex' && (
                  <label className="r3b-annex-date">
                    {copy.offer.annexDate}
                    <input type="date" required value={d.effectiveDate ?? ''} disabled={!editable || d.status === 'read'} onChange={(e) => store.setAnnexDate(d.id, e.target.value)} />
                  </label>
                )}
                <button type="button" className="r3b-remove" disabled={!editable} aria-label={copy.offer.remove(ordinal ? `${name} (${d.fileName})` : d.fileName)} onClick={() => void store.removeDocument(d.id)}>
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {unread.length > 0 && (
        <div className="r3b-consent" role="group" aria-labelledby="r3b-consent-title">
          <h3 id="r3b-consent-title"><Info size={16} aria-hidden="true" /> {copy.offer.consentTitle}</h3>
          <p id="r3b-consent-text">{copy.offer.consent}</p>
          <button type="button" className="r3b-read" aria-describedby="r3b-consent-text" disabled={state.busy} onClick={() => void store.read()}>{copy.offer.read(unread.length)}</button>
        </div>
      )}
    </section>
  );
}

function PeriodQuestion({ boundaries, state, store, copy, active }: { boundaries: string[]; state: R3BState; store: R3BStore; copy: R3BCopy; active: boolean }) {
  const [day, setDay] = useState('');
  const lang = state.lang;
  return (
    <>
      <p className="r3b-question">{copy.period.question(boundaries.map((d) => formatDate(d, lang)))}</p>
      {active && (
        <div className="r3b-period-day">
          <label htmlFor="r3b-period-day">{copy.period.otherDay}</label>
          <div className="r3b-period-day-row">
            <input id="r3b-period-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            <button type="button" className="r3a-edit-button" disabled={!day} onClick={() => void store.choosePeriod({ kind: 'day', date: day } satisfies PeriodChoice)}>{copy.period.useDay}</button>
          </div>
        </div>
      )}
    </>
  );
}

function Summary({ block, state, copy }: { block: Extract<Block, { kind: 'summary' }>; state: R3BState; copy: R3BCopy }) {
  const lang = state.lang;
  if (block.failed) return <p className="r3b-warn">{copy.summary.resolveFailed}</p>;
  const facts = block.knowledge?.facts ?? [];
  const useful = facts.filter((f) => f.status !== 'unknown' || f.path === 'employment.hourlyRate');
  if (!block.knowledge || useful.every((f) => f.status === 'unknown')) return <p>{copy.summary.nothing}</p>;
  return (
    <div className="r3a-summary-card r3b-summary">
      <p className="r3b-summary-title">{copy.summary.title}</p>
      <ul>
        {useful.map((fact) => (
          <li key={fact.path} className="r3b-fact" data-fact={fact.path} data-status={fact.status}>
            <div className="r3b-fact-main">
              <span className="r3b-fact-label">{copy.summary.labels[fact.path]}</span>
              <span className="r3b-fact-value">{factValue(fact, copy, lang)}</span>
            </div>
            <span className={`r3b-tag r3b-tag-${fact.status}`}>{fact.scenarioField === null && fact.path === 'employment.hoursPerWeek' ? copy.summary.contextOnly : copy.summary.statuses[fact.status]}</span>
            {fact.status === 'conflict' && (
              <ul className="r3b-candidates">
                {fact.candidates.map((cand, i) => <li key={i}>{formatValue(fact.unit, cand.value, lang)} — {cand.sources.map((s) => sourceWhere(s, state.docs, copy, lang)).join(', ')}</li>)}
              </ul>
            )}
            {fact.otherPeriods.map((o, i) => <p key={i} className="r3b-other-period">{copy.summary.otherPeriod(formatValue(fact.unit, o.value, lang), sourceWhere(o.source, state.docs, copy, lang))}</p>)}
            {(fact.sources.length > 0 || fact.candidates.length > 0) && (
              <details className="r3a-row-details">
                <summary>{copy.summary.details}</summary>
                {(fact.status === 'conflict' ? fact.candidates.flatMap((c) => c.sources) : fact.sources).filter((s) => s.role !== 'user').map((s, i) => (
                  <div key={i} className="r3b-source">{sourceDetails(s, state.docs, copy, lang).map((line, j) => <p key={j}>{line}</p>)}</div>
                ))}
                {fact.decidedAt && <p>{copy.summary.detailDecided(formatDate(fact.decidedAt, lang))}</p>}
              </details>
            )}
          </li>
        ))}
      </ul>
      <p className="r3a-summary-note">{copy.summary.notLegal}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Composer choices: example replies (sent to R2) or local choices (period / conflict / percentage meaning)
// ---------------------------------------------------------------------------------------------

function Choices({ state, store, copy }: { state: R3BState; store: R3BStore; copy: R3BCopy }) {
  const lang = state.lang;
  let legend = copy.composer.legend;
  let items: Array<{ key: string; label: string; act: () => void }> = [];
  if (state.phase === 'period') {
    legend = copy.composer.localLegend;
    const boundaries = state.messages.map((m) => m.block).filter((b): b is Extract<Block, { kind: 'period_question' }> => b.kind === 'period_question').pop()?.boundaries ?? [];
    const first = boundaries[0];
    items = [
      ...(first ? [{ key: 'before', label: copy.period.before(formatDate(first, lang)), act: () => void store.choosePeriod({ kind: 'before', date: first }) }] : []),
      ...boundaries.map((d) => ({ key: `from-${d}`, label: copy.period.from(formatDate(d, lang)), act: () => void store.choosePeriod({ kind: 'from', date: d }) })),
      { key: 'unknown', label: copy.period.unknown, act: () => void store.choosePeriod('unknown') },
    ];
  } else if (state.phase === 'conflict') {
    legend = copy.composer.localLegend;
    const fact = state.knowledge?.facts.find((f) => f.path === 'employment.hourlyRate');
    items = [
      ...(fact?.candidates ?? []).filter((cand) => cand.candidateId && typeof cand.value === 'number').map((cand) => ({
        key: cand.candidateId as string,
        label: copy.conflict.candidate(`${money(cand.value as number, lang)}/h`, cand.sources.map((s) => sourceWhere(s, state.docs, copy, lang)).join(', ')),
        act: () => void store.chooseConflict(cand.candidateId as string),
      })),
      { key: 'unknown', label: copy.conflict.dontKnow, act: () => void store.chooseConflict('unknown') },
    ];
  } else if (state.phase === 'percent' && state.pendingPercent) {
    legend = copy.composer.localLegend;
    const v = state.pendingPercent.value;
    items = [
      { key: 'total', label: copy.percent.total(v), act: () => void store.choosePercent('total') },
      { key: 'above', label: copy.percent.above(v), act: () => void store.choosePercent('above') },
      { key: 'unknown', label: copy.percent.dontKnow, act: () => void store.choosePercent('unknown') },
    ];
  } else if (state.phase === 'goal' || state.phase === 'conversation') {
    items = suggestionsFor(state.nextQuestion, state.started, lang).map((text) => ({ key: text, label: text, act: () => void store.send(text) }));
  }
  if (items.length === 0) return null;
  return (
    <fieldset className="r3a-choices" disabled={state.busy}>
      <legend>{legend}</legend>
      <div className="r3a-chip-row">
        {items.map((item) => <button key={item.key} type="button" className="r3a-chip" onClick={item.act}>{item.label}</button>)}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// Panel: scenario (sources side by side), result (never an amount)
// ---------------------------------------------------------------------------------------------

function ScenarioCard({ state, store, copy }: { state: R3BState; store: R3BStore; copy: R3BCopy }) {
  const lang = state.lang;
  const rows = panelRows(state);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<'not_a_number' | 'out_of_range' | null>(null);
  const open = (field: string) => { setEditing(field); setValue(''); setError(null); };
  return (
    <section className="r3a-card" aria-labelledby="r3b-scenario-title">
      <div className="r3a-card-head"><h2 id="r3b-scenario-title" tabIndex={-1}>{copy.panel.scenarioTitle}</h2><span className="r3a-tag">{copy.panel.scenarioTag}</span></div>
      {rows.length === 0 ? <p className="r3a-empty">{copy.panel.empty}</p> : (
        <ul className="r3a-rows">
          {rows.map((row) => {
            const label = fieldLabel(row.field, lang);
            const node = row.node;
            const known = node?.state === 'known' ? node : null;
            const valueText = known ? formatValue(scenarioUnit(row.field), known.value, lang)
              : node?.state === 'range' ? `${formatValue(scenarioUnit(row.field), node.low, lang)}–${formatValue(scenarioUnit(row.field), node.high, lang)}`
                : row.document && row.document.status !== 'conflict' ? factValue(row.document, copy, lang) : copy.panel.sources.unknown;
            const source = known ? (known.source === 'loonto_assumption' ? 'loonto_assumption' : row.correction && row.document ? 'correction' : 'user') : row.document ? row.document.status : 'unknown';
            return (
              <li key={row.field} className="r3a-row" data-field={row.field}>
                <div className="r3a-row-main">
                  <span className="r3a-row-label">{label}</span>
                  <span className={`r3a-row-value${known || row.document?.defersQuestion ? '' : ' is-unknown'}`}>{valueText}</span>
                </div>
                <div className="r3a-row-meta">
                  <span className={`r3a-source r3b-source-${source}`}>{copy.panel.sources[source as keyof R3BCopy['panel']['sources']]}</span>
                  {row.deferred && !known && <span className="r3a-rowstatus r3a-rowstatus-unknown">{copy.panel.deferredTag}</span>}
                </div>
                {known && row.document && row.document.status !== 'conflict' && (
                  <p className="r3a-previous">{copy.panel.documentLine(factValue(row.document, copy, lang), copy.summary.statuses[row.document.status])}</p>
                )}
                {row.document?.status === 'conflict' && (
                  <ul className="r3b-candidates">{row.document.candidates.map((cand, i) => <li key={i}>{formatValue(row.document?.unit ?? '', cand.value, lang)} — {cand.sources.map((s) => sourceWhere(s, state.docs, copy, lang)).join(', ')}</li>)}</ul>
                )}
                {row.correction && row.correction.documentValue !== null && known && <p className="r3a-previous">{copy.panel.correctionNote(formatDate(row.correction.enteredAt, lang))}</p>}
                {isEditable(row.field) && editing !== row.field && (
                  <button type="button" className="r3a-edit-button" onClick={() => open(row.field)}>{row.document && !known ? copy.panel.correct : copy.panel.edit}</button>
                )}
                {editing === row.field && (
                  <form className="r3a-edit" onSubmit={(e) => {
                    e.preventDefault();
                    const res = store.edit(row.field, value);
                    if (res.ok) setEditing(null);
                    else setError(res.error);
                  }}>
                    <label htmlFor={`r3b-edit-${row.field}`}>{copy.panel.editLabel(label)}</label>
                    <input id={`r3b-edit-${row.field}`} inputMode="decimal" value={value} aria-invalid={error !== null} aria-describedby={`r3b-edit-note-${row.field}`} onChange={(e) => { setValue(e.target.value); setError(null); }} />
                    {error && <p className="r3a-error" role="alert">{copy.panel.editErrors[error]}</p>}
                    <p className="r3a-edit-note" id={`r3b-edit-note-${row.field}`}>{copy.panel.editNote}</p>
                    <div className="r3a-edit-actions">
                      <button type="submit" className="r3a-save">{copy.panel.save}</button>
                      <button type="button" className="r3a-cancel" onClick={() => setEditing(null)}>{copy.panel.cancel}</button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ResultCard({ state, copy }: { state: R3BState; copy: R3BCopy }) {
  const lang = state.lang;
  const reasons = resultReasons(state);
  return (
    <section className="r3a-card r3a-result" aria-labelledby="r3b-result-title">
      <div className="r3a-card-head"><h2 id="r3b-result-title">{copy.panel.resultTitle}</h2><span className="r3a-status r3a-status-unavailable">{copy.panel.resultStatus}</span></div>
      <p className="r3a-result-lead">{copy.panel.resultLead}</p>
      <ul className="r3a-reasons">
        {reasons.map((r) => (
          <li key={r.key}>{r.key === 'missing' ? copy.panel.reasons.missing(r.fields.map((f) => fieldLabel(f, lang)).join(', ')) : copy.panel.reasons[r.key]}</li>
        ))}
      </ul>
      <details className="r3a-explain">
        <summary>{copy.panel.explainTitle}</summary>
        {copy.panel.explain.map((p, i) => <p key={i}>{p}</p>)}
      </details>
    </section>
  );
}
