import { AlertTriangle } from 'lucide-react';
import { translations, type Lang } from './translations.ts';
import type { CalculationReadinessView, ProfileIssueView } from './pro-profile-prefill.ts';
import {
  basisText, canApply, effectiveChoice, excludedReasonText, formatValue, hintText, inputUnitLabel, issueTitle, problemText, reasonText,
  readinessSummary, severityText, sourceChip, visibleIssues,
  type DecisionProblem, type PendingMap, type QuestionsCopy, type ResolvedEntry, type SourceChip,
} from './pro-profile-questions.ts';

/**
 * P3.1 S5 (decision G): the compact "Do uzupełnienia / To resolve" panel - ONE confirmation model, the
 * field-level issues from the backend Payroll Profile. Presentation only: it renders what `issues` and
 * `readiness` say (backend order, informational issues filtered out), reports what the user does through
 * callbacks, and decides nothing. No decision state, no network, no replay or `needsConfirmation` helper
 * lives here (ProDocuments orchestrates; pro-profile-questions.ts holds the logic).
 *
 * What a normal user sees is translated wording only: no reason code, excluded-reason code, field path or
 * evidence state. Index-based ids/names keep field paths out of the markup altogether.
 */

export interface ProfileQuestionsProps {
  lang: Lang;
  /** Every backend issue (informational ones included); the panel filters. */
  issues: readonly ProfileIssueView[];
  readiness: CalculationReadinessView | null;
  pending: PendingMap;
  resolved: readonly ResolvedEntry[];
  problems: Readonly<Record<string, DecisionProblem>>;
  busy: boolean;
  onChooseCandidate: (fieldPath: string, candidateId: string) => void;
  onManualChange: (fieldPath: string, raw: string) => void;
  onSkip: (fieldPath: string) => void;
  onUseSuggestion: (fieldPath: string) => void;
  onApply: () => void;
  onUndo: (fieldPath: string) => void;
}

function Chips({ sources, q, lang }: { sources: ProfileIssueView['candidates'][number]['sources']; q: QuestionsCopy; lang: Lang }) {
  return (
    <span className="pq-chips">
      {sources.map((source, i) => {
        const chip: SourceChip = sourceChip(source, q, lang);
        return (
          <span key={i} className="pq-chip-group">
            <span className={`pq-chip pq-chip-${chip.kind}`}>{chip.document ? `${chip.document} · ${chip.text}` : chip.text}</span>
            {chip.periodUnknown && <span className="pq-chip pq-chip-warn">{q.sourcePeriodUnknown}</span>}
          </span>
        );
      })}
    </span>
  );
}

function SourceDetails({ sources, q, lang }: { sources: ProfileIssueView['candidates'][number]['sources']; q: QuestionsCopy; lang: Lang }) {
  return (
    <ul className="pq-detail-list">
      {sources.map((source, i) => {
        const chip = sourceChip(source, q, lang);
        return (
          <li key={i}>
            <strong>{chip.text}</strong>
            {chip.details.map((d, j) => <span key={j} className="pq-detail">{d.value ? `${d.label}: ${d.value}` : d.label}</span>)}
          </li>
        );
      })}
    </ul>
  );
}

function ManualInput({ issue, id, raw, onChange, q, lang }: { issue: ProfileIssueView; id: string; raw: string; onChange: (raw: string) => void; q: QuestionsCopy; lang: Lang }) {
  const input = issue.input;
  if (input.kind === 'enum' || input.kind === 'boolean') {
    const options = input.kind === 'boolean' ? ['true', 'false'] : (input.enumValues ?? []);
    const label = (v: string) => (input.kind === 'boolean' ? (v === 'true' ? q.boolYes : q.boolNo) : formatValue(issue.unit, v, q, lang).value);
    return (
      <select id={id} value={raw} onChange={(event) => onChange(event.target.value)}>
        <option value="">{q.selectPlaceholder}</option>
        {options.map((v) => <option key={v} value={v}>{label(v)}</option>)}
      </select>
    );
  }
  if (input.kind === 'number') {
    return <input id={id} type="number" inputMode="decimal" step={input.step} min={input.min} max={input.max} value={raw} onChange={(event) => onChange(event.target.value)}/>;
  }
  if (input.kind === 'date') return <input id={id} type="date" value={raw} onChange={(event) => onChange(event.target.value)}/>;
  return <input id={id} type="text" maxLength={input.max} value={raw} onChange={(event) => onChange(event.target.value)}/>;
}

export function ProfileQuestions(props: ProfileQuestionsProps) {
  const { lang, issues, readiness, pending, resolved, problems, busy } = props;
  const q = translations[lang].proDocuments.questions;
  const visible = visibleIssues(issues);
  if (visible.length === 0 && resolved.length === 0) return null;
  const summary = readiness ? readinessSummary(readiness, q) : null;
  const applicable = canApply(visible, pending);

  return (
    <section className="profile-questions" aria-labelledby="pq-title" aria-busy={busy}>
      <h2 id="pq-title">{q.title}</h2>
      {summary && (
        <p className={`pq-summary${readiness && readiness.blockingCount > 0 ? ' pq-summary-blocking' : ''}`} role="status">
          <strong>{summary.message}</strong> <span className="pq-counts">{summary.counts}</span>
        </p>
      )}

      {visible.length > 0 && (
        <ol className="pq-list">
          {visible.map((issue, n) => {
            const title = issueTitle(issue, q);
            const { choice, suggested } = effectiveChoice(issue, pending);
            const problem = problems[issue.fieldPath];
            const groupName = `pq-choice-${n}`;
            const titleId = `pq-title-${n}`;
            const whyId = `pq-why-${n}`;
            const manualId = `pq-manual-${n}`;
            const manualRaw = choice?.kind === 'manual' ? choice.raw : '';
            const hasCandidates = issue.candidates.length > 0;
            const candidateSources = issue.candidates.flatMap((c) => c.sources);
            return (
              <li key={issue.fieldPath} className="pq-card" aria-labelledby={titleId}>
                <div className="pq-card-head">
                  <h3 id={titleId}>{title}</h3>
                  <span className={`pq-severity pq-severity-${issue.severity}`}>{severityText(issue.severity, q)}</span>
                </div>
                <p id={whyId} className="pq-why">{reasonText(issue.reason, q)}</p>

                {issue.previousDecision && (
                  <div className="pq-stale" role="status">
                    <AlertTriangle size={16} aria-hidden="true"/>
                    <span>{q.staleWarning}</span>
                    {suggested && <button type="button" className="secondary pq-small" onClick={() => props.onUseSuggestion(issue.fieldPath)}>{q.useSuggestion}</button>}
                  </div>
                )}

                <fieldset className="pq-choices" aria-describedby={whyId}>
                  <legend className="pq-sr">{q.chooseLegend(title)}</legend>
                  {issue.candidates.map((c) => {
                    const fv = formatValue(issue.unit, c.value, q, lang);
                    const chosen = choice?.kind === 'candidate' && choice.candidateId === c.candidateId;
                    const choose = () => props.onChooseCandidate(issue.fieldPath, c.candidateId);
                    return (
                      <label key={c.candidateId} className={`pq-candidate${chosen ? ' pq-candidate-chosen' : ''}`}>
                        <input type="radio" name={groupName} value={c.candidateId} checked={chosen} onChange={choose} onClick={choose}/>
                        <span className="pq-candidate-body">
                          <span className="pq-value"><strong>{fv.value}</strong>{fv.unit && <span className="pq-unit"> {fv.unit}</span>}</span>
                          <span className="pq-basis">{basisText(c.basis, q)}</span>
                          <Chips sources={c.sources} q={q} lang={lang}/>
                        </span>
                      </label>
                    );
                  })}
                  <div className={`pq-manual${choice?.kind === 'manual' ? ' pq-manual-chosen' : ''}`}>
                    {hasCandidates ? (
                      <label className="pq-manual-radio">
                        <input type="radio" name={groupName} value="manual" checked={choice?.kind === 'manual'} onChange={() => props.onManualChange(issue.fieldPath, manualRaw)} onClick={() => props.onManualChange(issue.fieldPath, manualRaw)}/>
                        <span>{q.enterOther}</span>
                      </label>
                    ) : <label className="pq-manual-label" htmlFor={manualId}>{q.enterOther}</label>}
                    {hasCandidates && <label className="pq-sr" htmlFor={manualId}>{q.manualInputLabel(title)}</label>}
                    <span className="pq-manual-field">
                      <ManualInput issue={issue} id={manualId} raw={manualRaw} onChange={(raw) => props.onManualChange(issue.fieldPath, raw)} q={q} lang={lang}/>
                      {inputUnitLabel(issue.unit, q) && <span className="pq-unit">{inputUnitLabel(issue.unit, q)}</span>}
                    </span>
                  </div>
                </fieldset>
                {problem && <p className="pq-problem" role="alert">{problemText(problem, q)}</p>}

                {candidateSources.length > 0 && (
                  <details className="pq-details">
                    <summary>{q.sourcesDetails}</summary>
                    <SourceDetails sources={candidateSources} q={q} lang={lang}/>
                  </details>
                )}
                {issue.hints.length > 0 && (
                  <details className="pq-hints">
                    <summary>{q.hintsTitle}</summary>
                    <ul className="pq-evidence-list">
                      {issue.hints.map((h, i) => {
                        const fv = formatValue(issue.unit, h.value, q, lang);
                        return (
                          <li key={i}>
                            <strong>{fv.value}{fv.unit ? ` ${fv.unit}` : ''}</strong> <span>{hintText(h.kind, q)}</span>
                            <Chips sources={h.sources} q={q} lang={lang}/>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
                {issue.excluded.length > 0 && (
                  <details className="pq-excluded">
                    <summary>{q.excludedTitle(issue.excluded.length)}</summary>
                    <ul className="pq-evidence-list">
                      {issue.excluded.map((x, i) => {
                        const fv = x.value === null ? null : formatValue(issue.unit, x.value, q, lang);
                        return (
                          <li key={i}>
                            {fv && <strong>{fv.value}{fv.unit ? ` ${fv.unit}` : ''} </strong>}
                            <span>{excludedReasonText(x.reason, q)}</span>
                            <Chips sources={[x.source]} q={q} lang={lang}/>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
                {issue.actions.includes('leave_unresolved') && (
                  <button type="button" className="plain-button pq-skip" onClick={() => props.onSkip(issue.fieldPath)}>{q.skip}</button>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {visible.length > 0 && (
        <div className="pq-actions">
          <button type="button" className="primary" disabled={!applicable || busy} onClick={props.onApply}>{busy ? q.applying : q.apply}</button>
        </div>
      )}

      {resolved.length > 0 && (
        <section className="pq-resolved" aria-labelledby="pq-resolved-title">
          <h3 id="pq-resolved-title">{q.resolvedTitle}</h3>
          <ul className="pq-resolved-list">
            {resolved.map((entry) => {
              const title = issueTitle(entry, q);
              const fv = formatValue(entry.unit, entry.value, q, lang);
              return (
                <li key={entry.fieldPath}>
                  <span className="pq-resolved-text">
                    <strong>{title}</strong>: {fv.value}{fv.unit ? ` ${fv.unit}` : ''}{' '}
                    <small>({entry.kind === 'confirm_candidate' ? q.resolvedChosen : q.resolvedEntered})</small>
                  </span>
                  <button type="button" className="secondary pq-small" disabled={busy} aria-label={q.undoAria(title)} onClick={() => props.onUndo(entry.fieldPath)}>{q.undo}</button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </section>
  );
}
