import type { ProDocumentType } from '../pro-documents-policy.ts';
import type { DocumentContextView, PrintedFactView, ProfileDecisionView, ResolvedProfileView } from '../pro-profile-prefill.ts';
import { buildPendingDecisions, chooseCandidate, mergeDecisionSet, resolveWithDecisions } from '../pro-profile-questions.ts';
import type { DocumentReadOutcome, FactReaderKind } from '../document-facts-reader.ts';
import { addFile, annexDatesComplete, asOfForChoice, asOfNeed, checkFile, profileDocuments, readerKind, removeFile, sendsReferences, setAnnexDate, toRead, type FileRejection, type PeriodChoice, type R3BDocument } from './r3b-documents.ts';
import { factFor, projectProfile, type DocumentKnowledge, type FactSource, type KnownFact } from './r3b-profile-projection.ts';
import {
  OUT_OF_GOAL_FIELDS, ambiguousTotalPercent, buildTurnRequest, nextDeferred, nodeAt, percentMeaningMessage, postTurn, serverDeferrals, unionDeferred, withUserValue, withoutDocumentValues,
  type NextQuestionView, type PublicEvaluationView, type R3BLocale, type ScenarioNodeView, type ScenarioView, type TurnDigestView, type TurnFailure, type TurnResultView,
} from './r3b-turn.ts';

/**
 * R3-B document-first conversation - the state machine behind the screen, free of React and of the browser so the
 * node tests drive it exactly as the interface does (READ -> SUMMARY -> CONVERSATION -> SCENARIO -> RESULT).
 *
 *   documents (optional) -> explicit read action (existing Gemini reader) -> [period question, only with a dated annex]
 *   -> existing Payroll Profile -> short summary -> "Co chcesz policzyć?" -> [one grounded rate-conflict question]
 *   -> R2 turns, one question at a time, with document-known / "nie wiem" / out-of-goal questions deferred.
 *
 * The interface never writes a document value into the R2 Scenario: it is shown with its source and only defers its
 * question. R3-B.2: when the documents were read by reference, the server keeps a document context for this browser
 * session and the turn names it (`documentContextRef`); the SERVER then writes the values it trusts (`source: document`)
 * and answers questions about the document from its printed facts. The interface writes user values only.
 */

export type Phase = 'documents' | 'reading' | 'period' | 'goal' | 'conflict' | 'percent' | 'conversation';

export interface TurnContext {
  docsRead: boolean;
  rateFoundInDocs: boolean;
  premiumsInDocs: string[];
  contractHours: number | null;
  /** Scenario fields a usable document reading answers (deferred, provisional). */
  documentFields: string[];
  /** Scenario fields the documents disagree on. */
  conflictFields: string[];
  /** R3-B.2: the net printed on the read payslip (a historical document reading), if the server-held context has one. */
  printedNet?: { value: number; periodLabel: string | null } | null;
}

export type ChoiceRef =
  | { kind: 'read'; count: number }
  | { kind: 'continue_without' }
  | { kind: 'period'; choice: PeriodChoice | 'unknown' }
  | { kind: 'conflict_candidate'; value: number; sources: FactSource[] }
  | { kind: 'conflict_unknown' }
  | { kind: 'percent'; meaning: 'total' | 'above' | 'unknown'; value: number };

export interface ReadReportItem {
  docId: string;
  outcome: 'read' | 'partial' | 'failed';
  notProcessedPages: number[];
  totalPages: number;
  tooLong: boolean;
  errorCode?: string;
}

export type Block =
  | { kind: 'welcome' }
  | { kind: 'user_text'; text: string }
  | { kind: 'user_choice'; choice: ChoiceRef }
  | { kind: 'read_report'; items: ReadReportItem[]; anyRead: boolean }
  | { kind: 'period_question'; boundaries: string[] }
  | { kind: 'period_chosen'; asOf: string | null }
  | { kind: 'summary'; knowledge: DocumentKnowledge | null; failed: boolean; printed?: PrintedFactView[] }
  | { kind: 'goal_question'; withDocuments: boolean }
  | { kind: 'conflict_question'; fact: KnownFact }
  | { kind: 'conflict_result'; outcome: 'left_open' | 'chosen' | 'failed'; value?: number }
  | { kind: 'percent_question'; value: number; field: string }
  | { kind: 'turn'; result: TurnResultView; deferredNow: string[]; context: TurnContext }
  | { kind: 'turn_failed'; reason: TurnFailure }
  | { kind: 'edit_saved'; field: string; value: number }
  | { kind: 'note'; note: 'unread_first' | 'too_long' | 'conflict_pick' | 'percent_pick' | 'period_pick' | 'annex_date_missing' | 'context_expired' };

export interface ThreadMessage {
  id: number;
  from: 'loonto' | 'user';
  block: Block;
}

export interface UserCorrection {
  field: string;
  value: number;
  /** When the user entered it - kept with the correction, never merged into the document. */
  enteredAt: string;
  /** The document reading it differs from, if any (shown side by side; never overwritten). */
  documentValue: number | null;
}

export interface R3BState {
  lang: R3BLocale;
  phase: Phase;
  busy: boolean;
  docs: R3BDocument[];
  fileErrors: Array<{ name: string; reason: FileRejection }>;
  messages: ThreadMessage[];
  nextMessageId: number;
  nextDocId: number;
  /** An R2 turn has been answered. */
  started: boolean;
  asOf: string | null;
  knowledge: DocumentKnowledge | null;
  /** R3-B.2: the server-held document context of the read documents (its reference and printed facts), if issued. */
  documentContext: DocumentContextView | null;
  resolved: ResolvedProfileView | null;
  decisions: ProfileDecisionView[];
  scenario: ScenarioView | null;
  digest: TurnDigestView | null;
  /** Fields the SERVER put aside (the user did not know / declined the offered assumption), accumulated. */
  userDeferred: string[];
  /** Fields the user put aside in the interface (an unresolved rate conflict). */
  deferredExtra: string[];
  nextQuestion: NextQuestionView | null;
  evaluation: PublicEvaluationView | null;
  pendingGoal: string | null;
  pendingPercent: { value: number; field: string } | null;
  corrections: UserCorrection[];
  panelOpen: boolean;
  /** P0: false = this host has no configured reader (e.g. a Preview) - reading is disabled and explained up front. */
  readerAvailable: boolean | null;
}

export interface R3BDeps {
  /** The existing reader adapter (document-facts-reader.ts) with the browser readers - stubbed in tests. */
  readFacts: (file: File, kind: FactReaderKind) => Promise<DocumentReadOutcome>;
  /** For `/api/profile/resolve` and `/api/scenario/turn`. */
  fetchImpl: typeof fetch;
  /** P0: whether THIS host has a configured document reader (`GET /api/ai/status`); null = could not tell. Optional. */
  readerStatus?: () => Promise<boolean | null>;
  /** The technical as-of date of a document set the date cannot change (see r3b-documents.ts asOfNeed). */
  today: () => string;
  now: () => string;
  newDecisionId: () => string;
  turnTimeoutMs?: number;
}

export function initialState(lang: R3BLocale = 'pl'): R3BState {
  return {
    lang, phase: 'documents', busy: false, docs: [], fileErrors: [], messages: [{ id: 1, from: 'loonto', block: { kind: 'welcome' } }], nextMessageId: 2, nextDocId: 1,
    started: false, asOf: null, knowledge: null, documentContext: null, resolved: null, decisions: [], scenario: null, digest: null, userDeferred: [], deferredExtra: [],
    nextQuestion: null, evaluation: null, pendingGoal: null, pendingPercent: null, corrections: [], panelOpen: false, readerAvailable: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Pure views for the panel
// ---------------------------------------------------------------------------------------------

/** In-goal Scenario fields, in display order (tax, deductions and extras are outside the weekly base-pay goal). */
export const ROW_ORDER = [
  'work.hours', 'work.regularWeekdayHours', 'work.saturdayHours', 'work.sundayHours', 'work.publicHolidayHours', 'work.overtimeHours', 'pay.hourlyRate',
  'pay.saturdayPremiumPercent', 'pay.sundayPremiumPercent', 'pay.publicHolidayPremiumPercent', 'pay.overtime.tier1Percent', 'pay.overtime.tier2Percent', 'pay.overtime.thresholdHoursPerDay',
] as const;

/** The R1 bounds a user edit must respect (scenario-types.ts SCENARIO_FIELDS) - R1 still validates every turn. */
const EDIT_BOUNDS: Record<string, { min: number; max: number; exclusiveMin?: boolean }> = {
  'work.regularWeekdayHours': { min: 0, max: 120 }, 'work.overtimeHours': { min: 0, max: 120 }, 'work.saturdayHours': { min: 0, max: 24 },
  'work.sundayHours': { min: 0, max: 24 }, 'work.publicHolidayHours': { min: 0, max: 168 }, 'pay.hourlyRate': { min: 0, max: 1000, exclusiveMin: true },
  'pay.saturdayPremiumPercent': { min: 0, max: 500 }, 'pay.sundayPremiumPercent': { min: 0, max: 500 }, 'pay.publicHolidayPremiumPercent': { min: 0, max: 500 },
  'pay.overtime.tier1Percent': { min: 0, max: 500 }, 'pay.overtime.tier2Percent': { min: 0, max: 500 }, 'pay.overtime.thresholdHoursPerDay': { min: 0, max: 24 },
};
export const isEditable = (field: string) => Object.prototype.hasOwnProperty.call(EDIT_BOUNDS, field);

export interface PanelRow {
  field: string;
  node: ScenarioNodeView | null;
  document: KnownFact | null;
  correction: UserCorrection | null;
  deferred: boolean;
  missing: boolean;
}

const inGoal = (field: string) => (ROW_ORDER as readonly string[]).includes(field);

export function panelRows(state: R3BState): PanelRow[] {
  const required = new Set((state.evaluation?.requirements ?? []).map((r) => r.field).filter(inGoal));
  const deferred = new Set([...state.userDeferred, ...state.deferredExtra]);
  const rows: PanelRow[] = [];
  for (const field of ROW_ORDER) {
    const node = field === 'work.hours' ? null : nodeAt(state.scenario, field);
    const document = factFor(state.knowledge, field) ?? null;
    const shown = node !== null || (document !== null && document.status !== 'unknown') || required.has(field) || deferred.has(field);
    if (!shown) continue;
    const correction = [...state.corrections].reverse().find((c) => c.field === field) ?? null;
    rows.push({ field, node, document: document && document.status !== 'unknown' ? document : null, correction, deferred: deferred.has(field), missing: required.has(field) });
  }
  return rows;
}

export type ResultReason = { key: 'documentProvisional' } | { key: 'conflict' } | { key: 'missing'; fields: string[] } | { key: 'outOfGoal' } | { key: 'gate' };

/** Why there is no amount - always "not available yet" in R3-B (Contract v1.1 §4.3; RT-001 / RT-002 / P1 / L1 open). */
export function resultReasons(state: R3BState): ResultReason[] {
  const rows = panelRows(state);
  const out: ResultReason[] = [];
  const documentNode = (r: PanelRow) => r.node?.source === 'document' || (r.node?.candidates ?? []).some((c) => c.source === 'document');
  if (rows.some((r) => (r.document && (r.document.status === 'document_reading' || r.document.status === 'documents_agree' || r.document.status === 'user_confirmed') && !r.node) || documentNode(r))) out.push({ key: 'documentProvisional' });
  if (rows.some((r) => r.document?.status === 'conflict' && !r.node)) out.push({ key: 'conflict' });
  const missing = rows.filter((r) => (r.missing || r.deferred) && !r.document?.defersQuestion && !(r.node && r.node.state === 'known')).map((r) => r.field);
  if (missing.length > 0) out.push({ key: 'missing', fields: missing });
  out.push({ key: 'outOfGoal' }, { key: 'gate' });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

const DONT_KNOW = /^(nie wiem|nie mam pojecia|i dont know|dont know|not sure|no idea)$/;
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').toLowerCase().replace(/[’'`.!?]/g, '').replace(/\s+/g, ' ').trim();

export function parseNumberInput(raw: string): number | null {
  const cleaned = raw.replace(/€|eur\b|\/\s*h\b|\bh\b|%|godz\.?|godzin\w*|hours?/gi, ' ').trim().replace(',', '.');
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
}

export type R3BStore = ReturnType<typeof createR3BStore>;

export function createR3BStore(deps: R3BDeps, lang: R3BLocale = 'pl') {
  let state = initialState(lang);
  const listeners = new Set<() => void>();
  const set = (next: R3BState) => { state = next; for (const l of listeners) l(); };
  const patch = (p: Partial<R3BState>) => set({ ...state, ...p });
  const say = (from: ThreadMessage['from'], block: Block) => set({ ...state, messages: [...state.messages, { id: state.nextMessageId, from, block }], nextMessageId: state.nextMessageId + 1 });
  const updateDoc = (id: string, p: Partial<R3BDocument>) => patch({ docs: state.docs.map((d) => (d.id === id ? { ...d, ...p } : d)) });

  function printedNet(): TurnContext['printedNet'] {
    const nets = (state.documentContext?.knowledge.facts ?? []).filter((f) => f.key === 'net' && typeof f.value === 'number');
    // Only one unambiguous printed net is quoted - several payslips print several, none is "the" net.
    return nets.length === 1 ? { value: nets[0]?.value as number, periodLabel: nets[0]?.periodLabel ?? null } : null;
  }

  function context(): TurnContext {
    const k = state.knowledge;
    const rate = factFor(k, 'pay.hourlyRate');
    const hours = k?.facts.find((f) => f.path === 'employment.hoursPerWeek');
    return {
      docsRead: state.docs.some((d) => d.status === 'read'),
      rateFoundInDocs: Boolean(rate && rate.status !== 'unknown'),
      premiumsInDocs: (k?.facts ?? []).filter((f) => f.scenarioField?.endsWith('Percent') && f.status !== 'unknown').map((f) => f.scenarioField as string),
      contractHours: hours && typeof hours.value === 'number' && hours.status !== 'conflict' ? hours.value : null,
      documentFields: k?.deferrableFields ?? [],
      conflictFields: (k?.facts ?? []).filter((f) => f.status === 'conflict' && f.scenarioField).map((f) => f.scenarioField as string),
      printedNet: printedNet(),
    };
  }

  function afterSummary() {
    if (state.started) { patch({ phase: 'conversation', busy: false }); return; }
    say('loonto', { kind: 'goal_question', withDocuments: true });
    patch({ phase: 'goal', busy: false });
  }

  /** The profile by reference first; when the server no longer holds the batches (expired), the documents are echoed -
   * the profile still resolves, but without a document context (nothing client-held is ever trusted). */
  async function resolveDocuments(asOf: string, decisions: ProfileDecisionView[]) {
    const outcome = await resolveWithDecisions(asOf, profileDocuments(state.docs), decisions, deps.fetchImpl);
    if (outcome || !sendsReferences(state.docs)) return outcome;
    patch({ docs: state.docs.map((d) => ({ ...d, batchRefs: null })), documentContext: null });
    return resolveWithDecisions(asOf, profileDocuments(state.docs, { byReference: false }), decisions, deps.fetchImpl);
  }

  async function resolveAndSummarize(asOf: string) {
    patch({ busy: true });
    const outcome = await resolveDocuments(asOf, state.decisions);
    if (!outcome) {
      patch({ knowledge: null, documentContext: null, resolved: null, asOf: null });
      say('loonto', { kind: 'summary', knowledge: null, failed: true });
    } else {
      const knowledge = projectProfile(outcome.resolved);
      const documentContext = outcome.resolved.documentContext ?? null;
      patch({ knowledge, documentContext, resolved: outcome.resolved, decisions: outcome.decisions, asOf });
      say('loonto', { kind: 'summary', knowledge, failed: false, printed: documentContext?.knowledge.facts ?? [] });
    }
    afterSummary();
  }

  async function turn(message: string) {
    const clientAdds = [...(state.knowledge?.deferrableFields ?? []), ...OUT_OF_GOAL_FIELDS, ...state.deferredExtra];
    const deferredFields = nextDeferred(state.digest?.deferredFields ?? [], state.userDeferred, clientAdds);
    const documentContextRef = state.documentContext?.ref ?? null;
    const body = buildTurnRequest({ scenario: state.scenario, message, locale: state.lang, digest: state.digest, deferredFields, documentContextRef });
    const ctx = context();
    patch({ busy: true, phase: 'conversation' });
    const res = await postTurn(body, deps.fetchImpl, deps.turnTimeoutMs);
    if (!res.ok && res.reason === 'document_context_invalid' && documentContextRef) {
      // The server no longer holds this session's document context (it expires): its values leave the Scenario, the
      // documents wait for a new explicit read, and the same message is sent once more - without the reference.
      patch({
        documentContext: null, scenario: withoutDocumentValues(state.scenario),
        docs: state.docs.map((d) => (d.status === 'read' && d.file ? { ...d, status: 'selected' as const, batchRefs: null } : d)),
      });
      say('loonto', { kind: 'note', note: 'context_expired' });
      await turn(message);
      return;
    }
    if (!res.ok) {
      say('loonto', { kind: 'turn_failed', reason: res.reason });
      patch({ busy: false, phase: state.started ? 'conversation' : 'goal' });
      return;
    }
    const r = res.result;
    const added = serverDeferrals(deferredFields, r.conversation?.deferredFields);
    patch({
      scenario: r.scenario, digest: r.conversation ?? null, nextQuestion: r.nextQuestion, evaluation: r.evaluation ?? state.evaluation,
      userDeferred: unionDeferred(state.userDeferred, added), started: true, phase: 'conversation', busy: false,
    });
    say('loonto', { kind: 'turn', result: r, deferredNow: added, context: ctx });
  }

  async function goal(message: string) {
    const conflict = state.knowledge?.rateConflict ?? null;
    const fact = factFor(state.knowledge, 'pay.hourlyRate');
    if (conflict && fact && !state.deferredExtra.includes('pay.hourlyRate')) {
      patch({ pendingGoal: message, phase: 'conflict' });
      say('loonto', { kind: 'conflict_question', fact });
      return;
    }
    await turn(message);
  }

  async function continueGoal() {
    const pending = state.pendingGoal;
    patch({ pendingGoal: null });
    if (pending) await turn(pending);
    else patch({ phase: state.started ? 'conversation' : 'goal', busy: false });
  }

  const store = {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setLang(next: R3BLocale) { patch({ lang: next }); },
    setPanel(open: boolean) { patch({ panelOpen: open }); },

    /** P0: asks the server whether this host can read documents at all, before anything is uploaded. */
    async checkReader() {
      if (!deps.readerStatus) return;
      let available: boolean | null = null;
      try { available = await deps.readerStatus(); } catch { available = null; }
      patch({ readerAvailable: available });
    },
    canEditDocuments: () => !state.busy && (state.phase === 'documents' || state.phase === 'goal' || state.phase === 'conversation'),

    addFiles(files: readonly File[], documentType: ProDocumentType) {
      if (!store.canEditDocuments()) return;
      let docs = state.docs;
      let nextDocId = state.nextDocId;
      const fileErrors: R3BState['fileErrors'] = [];
      for (const file of files) {
        const rejection = checkFile(file);
        if (rejection) fileErrors.push({ name: file.name, reason: rejection });
        else docs = addFile(docs, file, documentType, `doc-${nextDocId++}`);
      }
      patch({ docs, fileErrors, nextDocId });
    },

    setAnnexDate(id: string, date: string) { patch({ docs: setAnnexDate(state.docs, id, date) }); },

    /** Removal drops the file. A document already read leaves the profile: it is re-resolved from the others (no reader call). */
    async removeDocument(id: string) {
      if (!store.canEditDocuments()) return;
      const wasRead = state.docs.find((d) => d.id === id)?.status === 'read';
      patch({ docs: removeFile(state.docs, id), fileErrors: [] });
      if (!wasRead) return;
      const remaining = profileDocuments(state.docs);
      if (remaining.length === 0) {
        patch({ knowledge: null, documentContext: null, resolved: null, decisions: [], asOf: null });
        say('loonto', { kind: 'summary', knowledge: null, failed: false });
        return;
      }
      const need = asOfNeed(state.docs);
      await resolveAndSummarize(need.kind === 'independent' ? deps.today() : (state.asOf ?? deps.today()));
    },

    /** The ONLY call that sends document content anywhere - an explicit user action (Contract / task C1). */
    async read() {
      const pending = toRead(state.docs);
      if (state.busy || pending.length === 0 || state.readerAvailable === false) return;
      if (!annexDatesComplete(state.docs)) { say('loonto', { kind: 'note', note: 'annex_date_missing' }); return; }
      const before = state.phase;
      say('user', { kind: 'user_choice', choice: { kind: 'read', count: pending.length } });
      patch({ phase: 'reading', busy: true, docs: state.docs.map((d) => (pending.includes(d) ? { ...d, status: 'reading' as const, errorCode: undefined } : d)) });
      const items: ReadReportItem[] = [];
      for (const doc of pending) {
        let outcome: DocumentReadOutcome;
        try {
          outcome = await deps.readFacts(doc.file as File, readerKind(doc.documentType));
        } catch {
          outcome = { status: 'error', errorCode: 'file_unreadable' };
        }
        if (outcome.status === 'done') {
          updateDoc(doc.id, { status: 'read', factBatches: outcome.factBatches, batchRefs: outcome.batchRefs ?? null, coverage: outcome.coverage, errorCode: undefined });
          const missing = outcome.coverage.notProcessedPages;
          items.push({ docId: doc.id, outcome: missing.length > 0 ? 'partial' : 'read', notProcessedPages: missing, totalPages: outcome.coverage.totalPages, tooLong: outcome.coverage.reason === 'document_too_long' });
        } else {
          updateDoc(doc.id, { status: 'failed', errorCode: outcome.errorCode ?? 'unknown', factBatches: undefined, batchRefs: null, coverage: undefined });
          items.push({ docId: doc.id, outcome: 'failed', notProcessedPages: [], totalPages: 0, tooLong: false, errorCode: outcome.errorCode ?? 'unknown' });
        }
      }
      if (items.some((i) => i.errorCode === 'vision_unavailable')) patch({ readerAvailable: false });
      const anyNew = items.some((i) => i.outcome !== 'failed');
      say('loonto', { kind: 'read_report', items, anyRead: state.docs.some((d) => d.status === 'read') });
      if (!anyNew) {
        patch({ busy: false, phase: before === 'reading' ? 'documents' : before });
        return;
      }
      const need = asOfNeed(state.docs);
      if (need.kind === 'ask') {
        say('loonto', { kind: 'period_question', boundaries: need.boundaries });
        patch({ phase: 'period', busy: false });
        return;
      }
      await resolveAndSummarize(deps.today());
    },

    continueWithoutDocuments() {
      if (state.busy || state.phase !== 'documents') return;
      say('user', { kind: 'user_choice', choice: { kind: 'continue_without' } });
      say('loonto', { kind: 'goal_question', withDocuments: false });
      patch({ phase: 'goal' });
    },

    async choosePeriod(choice: PeriodChoice | 'unknown') {
      if (state.busy || state.phase !== 'period') return;
      if (choice !== 'unknown' && asOfForChoice(choice) === null) return;
      say('user', { kind: 'user_choice', choice: { kind: 'period', choice } });
      if (choice === 'unknown') {
        patch({ knowledge: null, documentContext: null, resolved: null, asOf: null });
        say('loonto', { kind: 'period_chosen', asOf: null });
        afterSummary();
        return;
      }
      const asOf = asOfForChoice(choice) as string;
      say('loonto', { kind: 'period_chosen', asOf });
      await resolveAndSummarize(asOf);
    },

    async chooseConflict(choice: string) {
      if (state.busy || state.phase !== 'conflict') return;
      const issue = state.knowledge?.rateConflict;
      if (!issue) { await continueGoal(); return; }
      if (choice === 'unknown') {
        say('user', { kind: 'user_choice', choice: { kind: 'conflict_unknown' } });
        patch({ deferredExtra: unionDeferred(state.deferredExtra, ['pay.hourlyRate']) });
        say('loonto', { kind: 'conflict_result', outcome: 'left_open' });
        await continueGoal();
        return;
      }
      const fact = factFor(state.knowledge, 'pay.hourlyRate');
      const candidate = fact?.candidates.find((c) => c.candidateId === choice);
      if (!candidate || typeof candidate.value !== 'number') return;
      say('user', { kind: 'user_choice', choice: { kind: 'conflict_candidate', value: candidate.value, sources: candidate.sources } });
      patch({ busy: true });
      // The user's choice is ONE existing Payroll Profile decision (confirm_candidate) - never a document value.
      const added = buildPendingDecisions([issue], chooseCandidate({}, issue.fieldPath, choice), deps.newDecisionId, deps.now());
      const outcome = await resolveDocuments(state.asOf ?? deps.today(), mergeDecisionSet(state.decisions, added));
      if (!outcome) {
        say('loonto', { kind: 'conflict_result', outcome: 'failed' });
        patch({ busy: false });
        return;
      }
      patch({ knowledge: projectProfile(outcome.resolved), documentContext: outcome.resolved.documentContext ?? null, resolved: outcome.resolved, decisions: outcome.decisions, busy: false });
      say('loonto', { kind: 'conflict_result', outcome: 'chosen', value: candidate.value });
      await continueGoal();
    },

    async choosePercent(meaning: 'total' | 'above' | 'unknown') {
      const pending = state.pendingPercent;
      if (state.busy || state.phase !== 'percent' || !pending) return;
      say('user', { kind: 'user_choice', choice: { kind: 'percent', meaning, value: pending.value } });
      patch({ pendingPercent: null });
      await turn(percentMeaningMessage(meaning, pending.value, state.lang));
    },

    async send(text: string) {
      const message = text.trim();
      if (message.length === 0 || state.busy) return;
      if (message.length > 1000) { say('loonto', { kind: 'note', note: 'too_long' }); return; }
      const folded = fold(message);
      switch (state.phase) {
        case 'reading':
          return;
        case 'documents':
          say('user', { kind: 'user_text', text: message });
          if (toRead(state.docs).length > 0) { say('loonto', { kind: 'note', note: 'unread_first' }); return; }
          await goal(message);
          return;
        case 'period':
          say('user', { kind: 'user_text', text: message });
          if (DONT_KNOW.test(folded)) { patch({ messages: state.messages.slice(0, -1) }); await store.choosePeriod('unknown'); return; }
          say('loonto', { kind: 'note', note: 'period_pick' });
          return;
        case 'goal':
          say('user', { kind: 'user_text', text: message });
          await goal(message);
          return;
        case 'conflict': {
          say('user', { kind: 'user_text', text: message });
          const fact = factFor(state.knowledge, 'pay.hourlyRate');
          const typed = parseNumberInput(message);
          const match = typed === null ? undefined : fact?.candidates.find((c) => typeof c.value === 'number' && Math.abs(c.value - typed) < 1e-9);
          if (DONT_KNOW.test(folded)) { patch({ messages: state.messages.slice(0, -1) }); await store.chooseConflict('unknown'); return; }
          if (match?.candidateId) { patch({ messages: state.messages.slice(0, -1) }); await store.chooseConflict(match.candidateId); return; }
          say('loonto', { kind: 'note', note: 'conflict_pick' });
          return;
        }
        case 'percent':
          say('user', { kind: 'user_text', text: message });
          if (DONT_KNOW.test(folded)) { patch({ messages: state.messages.slice(0, -1) }); await store.choosePercent('unknown'); return; }
          say('loonto', { kind: 'note', note: 'percent_pick' });
          return;
        case 'conversation': {
          say('user', { kind: 'user_text', text: message });
          const ambiguous = ambiguousTotalPercent(message, state.nextQuestion?.field);
          if (ambiguous !== null && state.nextQuestion) {
            patch({ pendingPercent: { value: ambiguous, field: state.nextQuestion.field }, phase: 'percent' });
            say('loonto', { kind: 'percent_question', value: ambiguous, field: state.nextQuestion.field });
            return;
          }
          await turn(message);
        }
      }
    },

    /** An explicit edit in the scenario: a USER value (R2's own `source: user` node). A document reading is never changed. */
    edit(field: string, raw: string): { ok: true } | { ok: false; error: 'not_a_number' | 'out_of_range' } {
      const bounds = EDIT_BOUNDS[field];
      const value = parseNumberInput(raw);
      if (!bounds || value === null) return { ok: false, error: 'not_a_number' };
      if (value > bounds.max || value < bounds.min || (bounds.exclusiveMin && value === bounds.min)) return { ok: false, error: 'out_of_range' };
      const doc = factFor(state.knowledge, field);
      const documentValue = doc && typeof doc.value === 'number' ? doc.value : null;
      patch({
        scenario: withUserValue(state.scenario, field, value),
        corrections: [...state.corrections, { field, value, enteredAt: deps.now(), documentValue }],
        userDeferred: state.userDeferred.filter((f) => f !== field),
        deferredExtra: state.deferredExtra.filter((f) => f !== field),
        nextQuestion: state.nextQuestion?.field === field ? null : state.nextQuestion,
      });
      say('loonto', { kind: 'edit_saved', field, value });
      return { ok: true };
    },

    /** Everything is dropped - files included. Only the language preference survives. */
    reset() { set({ ...initialState(state.lang), readerAvailable: state.readerAvailable }); },
  };
  return store;
}
