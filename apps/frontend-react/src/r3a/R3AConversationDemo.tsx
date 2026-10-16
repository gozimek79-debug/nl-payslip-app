import { useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { Clock, FileText, Info, ListChecks, RotateCcw, Send } from 'lucide-react';
import { availableChoices, EDITABLE_ROWS, initialState, reduce, resultView, validateEdit, type ChoiceId, type DemoState, type RowId, type ScenarioRow } from './r3a-demo.ts';
import { DEMO_COPY, formatRowValue, type DemoCopy, type DemoLang } from './r3a-copy.ts';
import './r3a.css';

/**
 * R3-A Conversational UI Foundation - a mobile-first, conversation-centred SHELL on synthetic data, reachable only via
 * `/?r3a=1` on the feature branch (owner review; the URL flag is a convenience switch, not a security boundary).
 *
 * Conversation first; scenario and result are a secondary panel (a toggle on narrow screens, a side column on wide
 * ones); details on request. Loonto's replies are a transparent script advanced only by the example answers - typed
 * text is never interpreted, nothing is sent anywhere (no fetch, no /api) and nothing is ever calculated. The six
 * experience states are marked with `data-state` (READ, SUMMARY, CONVERSATION, SCENARIO, RESULT, EXPLAIN).
 */

function readStoredLang(): DemoLang {
  try {
    const stored = localStorage.getItem('loonto-lang');
    if (stored === 'pl' || stored === 'en') return stored;
  } catch { /* no storage (private mode, server render) */ }
  return 'pl';
}

export interface R3AConversationDemoProps {
  /** For tests and screenshots: start from a given demo state instead of the opening. */
  initial?: DemoState;
  initialLang?: DemoLang;
}

export function R3AConversationDemo({ initial, initialLang }: R3AConversationDemoProps) {
  const [lang, setLang] = useState<DemoLang>(() => initialLang ?? readStoredLang());
  const [state, dispatch] = useReducer(reduce, initial, (given: DemoState | undefined) => given ?? initialState());
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: RowId; raw: string } | null>(null);
  const copy = DEMO_COPY[lang];
  const choices = availableChoices(state);
  const result = resultView(state);

  const threadRef = useRef<HTMLOListElement>(null);
  const choicesRef = useRef<HTMLFieldSetElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scenarioHeadingRef = useRef<HTMLHeadingElement>(null);
  const lastInput = useRef<'choice' | 'text' | null>(null);
  const messageCount = useRef(state.messages.length);
  const panelRequested = useRef(false);

  useEffect(() => {
    document.title = copy.pageTitle;
    document.documentElement.lang = lang;
    try { localStorage.setItem('loonto-lang', lang); } catch { /* ignore */ }
  }, [lang, copy.pageTitle]);

  // New message: bring it into view; after an example answer, move focus to the next example answers.
  useEffect(() => {
    if (state.messages.length === messageCount.current) return;
    messageCount.current = state.messages.length;
    const last = threadRef.current?.lastElementChild as HTMLElement | null;
    last?.scrollIntoView?.({ block: 'nearest' });
    if (lastInput.current === 'choice') (choicesRef.current?.querySelector('button') ?? inputRef.current)?.focus({ preventScroll: true });
  }, [state.messages.length]);

  // Asking for the scenario moves focus to it - above the conversation on narrow screens, the side column on wide ones.
  useEffect(() => {
    if (state.panelOpen && panelRequested.current) scenarioHeadingRef.current?.focus();
    panelRequested.current = false;
  }, [state.panelOpen]);

  function onChoose(choice: ChoiceId) {
    lastInput.current = 'choice';
    if (choice === 'show_scenario') panelRequested.current = true;
    if (choice === 'start_over') { setDraft(''); setEditing(null); }
    dispatch({ type: 'choose', choice });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    lastInput.current = 'text';
    dispatch({ type: 'free_text', text: draft });
    setDraft('');
  }

  function onTogglePanel() {
    panelRequested.current = !state.panelOpen;
    dispatch({ type: 'set_panel', open: !state.panelOpen });
  }

  function onSaveEdit(event: FormEvent, row: ScenarioRow) {
    event.preventDefault();
    if (!editing) return;
    dispatch({ type: 'edit_row', id: row.id, raw: editing.raw });
    if (!validateEdit(row, editing.raw)) setEditing(null);
  }

  function onReset() {
    lastInput.current = null;
    setDraft('');
    setEditing(null);
    dispatch({ type: 'reset' });
  }

  return (
    <div className="app-shell r3a-shell">
      <header className="r3a-header">
        <div className="r3a-header-brand">
          <a className="r3a-brand" href="/"><span className="brand-mark">L</span>loonto</a>
          <span className="r3a-badge">{copy.badge}</span>
        </div>
        <div className="r3a-header-actions">
          <div className="r3a-lang" role="group" aria-label={copy.langLabel}>
            <button type="button" aria-pressed={lang === 'pl'} className={lang === 'pl' ? 'active' : ''} onClick={() => setLang('pl')}>PL</button>
            <button type="button" aria-pressed={lang === 'en'} className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
          </div>
          <button type="button" className="r3a-panel-toggle" aria-expanded={state.panelOpen} aria-controls="r3a-panel" onClick={onTogglePanel}>
            <ListChecks size={16} aria-hidden="true"/>{copy.panelToggle(state.rows.length)}
          </button>
        </div>
      </header>

      <p className="r3a-banner" role="note"><Info size={16} aria-hidden="true"/><span>{copy.banner} <a href="/">{copy.backToCurrent}</a></span></p>

      <div className="r3a-layout">
        <main className="r3a-main" aria-labelledby="r3a-title">
          <div className={`r3a-hero${state.messages.length > 1 ? ' is-compact' : ''}`}>
            <h1 id="r3a-title">{copy.title}</h1>
            <p>{copy.lead}</p>
          </div>

          <ol className="r3a-thread" ref={threadRef} role="log" aria-live="polite" aria-label={copy.threadLabel} data-state="CONVERSATION">
            {state.messages.map((message) => (
              <li key={message.id} className={`r3a-msg r3a-msg-${message.from}`}>
                {message.from === 'loonto' ? (
                  <div className="r3a-bubble">
                    <p className="r3a-msg-meta"><span>{copy.loontoName}</span><span className="r3a-tag">{copy.exampleTag}</span></p>
                    <p>{copy.messages[message.key]}</p>
                    {message.key === 'doc_read' && <DocumentReadCard copy={copy}/>}
                    {message.key === 'doc_summary' && <DocumentSummaryCard copy={copy}/>}
                  </div>
                ) : (
                  <div className="r3a-bubble">
                    <p className="r3a-msg-meta"><span>{copy.youName}</span></p>
                    <p>{'choice' in message ? copy.choices[message.choice] : message.text}</p>
                  </div>
                )}
              </li>
            ))}
          </ol>

          <form className="r3a-composer" onSubmit={onSubmit}>
            <fieldset className="r3a-choices" ref={choicesRef}>
              <legend>{copy.choicesLegend}</legend>
              <div className="r3a-chip-row">
                {choices.map((choice) => (
                  <button key={choice} type="button" className="r3a-chip" onClick={() => onChoose(choice)}>{copy.choices[choice]}</button>
                ))}
              </div>
            </fieldset>
            <div className="r3a-input-row">
              <label htmlFor="r3a-input" className="r3a-sr-only">{copy.inputLabel}</label>
              <input id="r3a-input" ref={inputRef} type="text" value={draft} maxLength={500} autoComplete="off" placeholder={copy.inputPlaceholder} aria-describedby="r3a-input-note" onChange={(event) => setDraft(event.target.value)}/>
              <button type="submit" className="r3a-send" disabled={!draft.trim()} aria-label={copy.send}><Send size={18} aria-hidden="true"/></button>
            </div>
            <p id="r3a-input-note" className="r3a-input-note">{copy.inputNote}</p>
          </form>
        </main>

        <aside id="r3a-panel" className={`r3a-panel${state.panelOpen ? ' is-open' : ''}`} aria-label={copy.panelToggle(state.rows.length)}>
          <section className="r3a-card" data-state="SCENARIO" aria-labelledby="r3a-scenario-title">
            <div className="r3a-card-head">
              <h2 id="r3a-scenario-title" ref={scenarioHeadingRef} tabIndex={-1}>{copy.scenario.title}</h2>
              <span className="r3a-tag">{copy.scenario.tag}</span>
            </div>
            {state.rows.length === 0 ? <p className="r3a-empty">{copy.scenario.empty}</p> : (
              <ul className="r3a-rows">
                {state.rows.map((row) => (
                  <ScenarioRowView key={row.id} row={row} copy={copy} lang={lang} error={state.editErrors[row.id]} editing={editing?.id === row.id ? editing.raw : null}
                    onEdit={() => { dispatch({ type: 'clear_edit_error', id: row.id }); setEditing({ id: row.id, raw: row.value === null ? '' : String(row.value).replace('.', lang === 'pl' ? ',' : '.') }); }}
                    onChange={(raw) => setEditing({ id: row.id, raw })}
                    onCancel={() => { dispatch({ type: 'clear_edit_error', id: row.id }); setEditing(null); }}
                    onSave={(event) => onSaveEdit(event, row)}/>
                ))}
              </ul>
            )}
            {state.assumptionInfo && (
              <div className="r3a-assumption" role="note">
                <h3>{copy.assumption.title}</h3>
                <p>{copy.assumption.body}</p>
              </div>
            )}
          </section>

          <section className="r3a-card r3a-result" data-state="RESULT" aria-labelledby="r3a-result-title">
            <div className="r3a-card-head">
              <h2 id="r3a-result-title">{copy.result.title}</h2>
              <span className={`r3a-status r3a-status-${result.status}`}>{result.status === 'needs_clarification' ? copy.result.needsClarification : copy.result.unavailable}</span>
            </div>
            <p className="r3a-result-lead">{copy.result.lead}</p>
            <h3 className="r3a-subhead">{copy.result.reasonsTitle}</h3>
            <ul className="r3a-reasons">
              {result.reasons.map((reason) => <li key={reason}>{copy.result.reasons[reason]}</li>)}
            </ul>
            <details className="r3a-explain" data-state="EXPLAIN" open={state.explainOpen} onToggle={(event) => { const open = event.currentTarget.open; if (open !== state.explainOpen) dispatch({ type: 'set_explain', open }); }}>
              <summary>{copy.result.explainSummary}</summary>
              <p>{copy.result.explainBody}</p>
            </details>
          </section>

          <section className="r3a-card r3a-analyzer" aria-label={copy.analyzer.button}>
            <button type="button" className="r3a-analyzer-button" aria-disabled="true" aria-describedby="r3a-analyzer-body" onClick={() => dispatch({ type: 'analyzer' })}>
              <Clock size={16} aria-hidden="true"/>{copy.analyzer.button}
            </button>
            <p id="r3a-analyzer-body">{copy.analyzer.body}</p>
            {state.analyzerNotice && <p className="r3a-notice" role="status">{copy.analyzer.notice}</p>}
          </section>

          <button type="button" className="r3a-reset" onClick={onReset}><RotateCcw size={16} aria-hidden="true"/>{copy.reset}</button>
        </aside>
      </div>
    </div>
  );
}

function DocumentReadCard({ copy }: { copy: DemoCopy }) {
  return (
    <div className="r3a-doc-card" data-state="READ">
      <FileText size={20} aria-hidden="true"/>
      <div>
        <p className="r3a-doc-title">{copy.docRead.title}</p>
        <p className="r3a-doc-file">{copy.docRead.file}</p>
        <p className="r3a-doc-body">{copy.docRead.body}</p>
      </div>
    </div>
  );
}

function DocumentSummaryCard({ copy }: { copy: DemoCopy }) {
  return (
    <div className="r3a-summary-card" data-state="SUMMARY">
      <ul>
        {copy.docSummary.facts.map((fact) => <li key={fact}><span>{fact}</span><span className="r3a-tag">{copy.docSummary.tag}</span></li>)}
      </ul>
      <p className="r3a-summary-note">{copy.docSummary.note}</p>
    </div>
  );
}

interface RowViewProps {
  row: ScenarioRow;
  copy: DemoCopy;
  lang: DemoLang;
  error: string | undefined;
  editing: string | null;
  onEdit: () => void;
  onChange: (raw: string) => void;
  onCancel: () => void;
  onSave: (event: FormEvent) => void;
}

function ScenarioRowView({ row, copy, lang, error, editing, onEdit, onChange, onCancel, onSave }: RowViewProps) {
  const label = copy.scenario.labels[row.id];
  const inputId = `r3a-edit-${row.id}`;
  return (
    <li className="r3a-row">
      <div className="r3a-row-main">
        <span className="r3a-row-label">{label}</span>
        <span className={`r3a-row-value${row.value === null ? ' is-unknown' : ''}`}>{formatRowValue(copy, lang, row.value, row.unit, row.status)}</span>
      </div>
      <div className="r3a-row-meta">
        <span className={`r3a-source r3a-source-${row.source}`}>{copy.scenario.sources[row.source]}</span>
        <span className={`r3a-rowstatus r3a-rowstatus-${row.status}`}>{copy.scenario.statuses[row.status]}</span>
      </div>
      {row.previousSource && <p className="r3a-previous">{copy.scenario.previous(copy.scenario.sources[row.previousSource])}</p>}
      <details className="r3a-row-details">
        <summary>{copy.scenario.details}</summary>
        <p>{copy.scenario.why(row.source, row.status)}</p>
      </details>
      {EDITABLE_ROWS.has(row.id) && (editing === null ? (
        <button type="button" className="r3a-edit-button" onClick={onEdit} aria-label={`${copy.scenario.edit}: ${label}`}>{copy.scenario.edit}</button>
      ) : (
        <form className="r3a-edit" onSubmit={onSave} noValidate>
          <label htmlFor={inputId}>{copy.scenario.newValue(label)}</label>
          <input id={inputId} type="text" inputMode="decimal" value={editing} autoFocus aria-invalid={Boolean(error)} aria-describedby={`${inputId}-note${error ? ` ${inputId}-error` : ''}`} onChange={(event) => onChange(event.target.value)}/>
          {error && <p id={`${inputId}-error`} className="r3a-error" role="alert">{copy.scenario.errors[error as keyof DemoCopy['scenario']['errors']]}</p>}
          <p id={`${inputId}-note`} className="r3a-edit-note">{copy.scenario.editNote}</p>
          <div className="r3a-edit-actions">
            <button type="submit" className="r3a-save">{copy.scenario.save}</button>
            <button type="button" className="r3a-cancel" onClick={onCancel}>{copy.scenario.cancel}</button>
          </div>
        </form>
      ))}
    </li>
  );
}
