import type { ProDocumentType } from '../pro-documents-policy.ts';
import type { DocumentReadOutcome, FactReaderKind } from '../document-facts-reader.ts';
import { resolveProfile } from '../pro-profile-prefill.ts';
import { addFile, checkFile, profileDocuments, readerKind, removeFile, toRead, type FileRejection, type R3BDocument } from '../r3b/r3b-documents.ts';
import { fetchAvailability, postAdvisorTurn, type AdvisorFailure, type AdvisorLocale, type NavigationOffer, type OrientationView } from './advisor-client.ts';

/**
 * AI-001 AI Advisor (Calculator PRO) - the state behind the screen, free of React so node tests drive it exactly as the
 * interface does. The conversation itself lives on the server (opaque `conversationRef`); this store keeps the visible
 * thread, the two opaque references and the user's documents (in memory only, never in storage).
 *
 * There is no scripted dialogue here: every advisor message is the text the server returned from the model. When the
 * advisor cannot answer, the thread shows an error notice (interface chrome) - never a substitute answer and never the
 * old questionnaire.
 */

export type ThreadItem =
  | { id: number; from: 'user'; text: string }
  | { id: number; from: 'advisor'; text: string; tools: Array<{ name: string; status: string }>; orientation: OrientationView | null; navigation: NavigationOffer[]; model: string }
  | { id: number; from: 'notice'; kind: 'error'; failure: AdvisorFailure }
  | { id: number; from: 'notice'; kind: 'info'; info: 'conversation_restarted' | 'document_expired' | 'document_read' | 'document_failed' | 'document_partial' | 'document_from_analysis' };

export interface AdvisorState {
  lang: AdvisorLocale;
  thread: ThreadItem[];
  nextId: number;
  busy: boolean;
  reading: boolean;
  conversationRef: string | null;
  documentContextRef: string | null;
  docs: R3BDocument[];
  nextDocId: number;
  fileErrors: Array<{ name: string; reason: FileRejection }>;
  /** null = unknown; false = this host cannot (e.g. a Preview without model / reader keys). */
  advisorAvailable: boolean | null;
  readerAvailable: boolean | null;
  lastFailedMessage: string | null;
}

export interface AdvisorDeps {
  fetchImpl: typeof fetch;
  readFacts: (file: File, kind: FactReaderKind) => Promise<DocumentReadOutcome>;
  today: () => string;
  turnTimeoutMs?: number;
}

export function initialAdvisorState(lang: AdvisorLocale = 'pl'): AdvisorState {
  return {
    lang, thread: [], nextId: 1, busy: false, reading: false, conversationRef: null, documentContextRef: null, docs: [], nextDocId: 1, fileErrors: [],
    advisorAvailable: null, readerAvailable: null, lastFailedMessage: null,
  };
}

export type AdvisorStore = ReturnType<typeof createAdvisorStore>;

/**
 * FIN-02: `documentContextRef` - a document context another module (Payslip Analysis) already built for THIS browser
 * session. Only the opaque server reference is passed; the server checks it against the session on every turn.
 */
export function createAdvisorStore(deps: AdvisorDeps, lang: AdvisorLocale = 'pl', initial: { documentContextRef?: string | null } = {}) {
  let state = initialAdvisorState(lang);
  const listeners = new Set<() => void>();
  const set = (next: AdvisorState) => { state = next; for (const l of listeners) l(); };
  const patch = (p: Partial<AdvisorState>) => set({ ...state, ...p });
  const push = (item: DistributiveOmit<ThreadItem, 'id'>) => set({ ...state, thread: [...state.thread, { ...item, id: state.nextId } as ThreadItem], nextId: state.nextId + 1 });
  if (initial.documentContextRef) {
    state = { ...state, documentContextRef: initial.documentContextRef };
    push({ from: 'notice', kind: 'info', info: 'document_from_analysis' });
  }

  async function exchange(message: string, retried: boolean): Promise<void> {
    const res = await postAdvisorTurn({
      message, locale: state.lang,
      ...(state.conversationRef ? { conversationRef: state.conversationRef } : {}),
      ...(state.documentContextRef ? { documentContextRef: state.documentContextRef } : {}),
    }, deps.fetchImpl, deps.turnTimeoutMs);
    if (res.ok) {
      const r = res.result;
      patch({ conversationRef: r.conversationRef, busy: false, lastFailedMessage: null });
      push({ from: 'advisor', text: r.answer.text, tools: r.meta.tools, orientation: r.orientation, navigation: r.navigation, model: r.meta.model });
      return;
    }
    // The server no longer has this conversation / document (they expire after 2 hours): say so, start fresh, ask once more.
    if (!retried && res.reason === 'conversation_invalid') {
      patch({ conversationRef: null });
      push({ from: 'notice', kind: 'info', info: 'conversation_restarted' });
      return exchange(message, true);
    }
    if (!retried && res.reason === 'document_context_invalid') {
      patch({ documentContextRef: null, docs: state.docs.map((d) => (d.status === 'read' && d.file ? { ...d, status: 'selected' as const, batchRefs: null } : d)) });
      push({ from: 'notice', kind: 'info', info: 'document_expired' });
      return exchange(message, true);
    }
    if (res.reason === 'advisor_not_configured') patch({ advisorAvailable: false });
    patch({ busy: false, lastFailedMessage: message });
    push({ from: 'notice', kind: 'error', failure: res.reason });
  }

  const store = {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setLang(next: AdvisorLocale) { patch({ lang: next }); },

    async checkAvailability() {
      const a = await fetchAvailability(deps.fetchImpl);
      patch({ advisorAvailable: a.advisor, readerAvailable: a.reader });
    },

    async send(text: string) {
      const message = text.trim();
      if (!message || state.busy || state.reading || message.length > 1000 || state.advisorAvailable === false) return;
      push({ from: 'user', text: message });
      patch({ busy: true });
      await exchange(message, false);
    },

    async retry() {
      const message = state.lastFailedMessage;
      if (!message || state.busy) return;
      patch({ busy: true });
      await exchange(message, false);
    },

    addFiles(files: readonly File[], documentType: ProDocumentType) {
      if (state.busy || state.reading) return;
      let docs = state.docs;
      let nextDocId = state.nextDocId;
      const fileErrors: AdvisorState['fileErrors'] = [];
      for (const file of files) {
        const rejection = checkFile(file);
        if (rejection) fileErrors.push({ name: file.name, reason: rejection });
        else docs = addFile(docs, file, documentType, `doc-${nextDocId++}`);
      }
      patch({ docs, fileErrors, nextDocId });
    },

    removeDocument(id: string) {
      if (state.busy || state.reading) return;
      const docs = removeFile(state.docs, id);
      // A removed document leaves the advisor's context; the remaining ones are read again on the next explicit read.
      patch({ docs, documentContextRef: docs.some((d) => d.status === 'read') ? state.documentContextRef : null });
    },

    /** The ONLY call that sends document content anywhere - an explicit user action. */
    async read() {
      const pending = toRead(state.docs);
      if (state.busy || state.reading || pending.length === 0 || state.readerAvailable === false) return;
      patch({ reading: true, docs: state.docs.map((d) => (pending.includes(d) ? { ...d, status: 'reading' as const, errorCode: undefined } : d)) });
      let anyFailed = false;
      let anyPartial = false;
      for (const doc of pending) {
        let outcome: DocumentReadOutcome;
        try {
          outcome = await deps.readFacts(doc.file as File, readerKind(doc.documentType));
        } catch {
          outcome = { status: 'error', errorCode: 'file_unreadable' };
        }
        if (outcome.status === 'done') {
          anyPartial ||= outcome.coverage.notProcessedPages.length > 0;
          patch({ docs: state.docs.map((d) => (d.id === doc.id ? { ...d, status: 'read' as const, factBatches: outcome.factBatches, batchRefs: outcome.batchRefs ?? null, coverage: outcome.coverage, errorCode: undefined } : d)) });
        } else {
          anyFailed = true;
          patch({ docs: state.docs.map((d) => (d.id === doc.id ? { ...d, status: 'failed' as const, errorCode: outcome.errorCode ?? 'unknown', factBatches: undefined, batchRefs: null } : d)) });
        }
      }
      // The advisor uses documents ONLY through a server-held context, i.e. read in this session and sent by reference.
      const resolved = await resolveProfile(deps.today(), profileDocuments(state.docs), deps.fetchImpl).catch(() => null);
      const contextRef = resolved?.documentContext?.ref ?? null;
      patch({ reading: false, documentContextRef: contextRef });
      push({ from: 'notice', kind: 'info', info: contextRef ? (anyPartial ? 'document_partial' : 'document_read') : 'document_failed' });
      if (anyFailed && contextRef) push({ from: 'notice', kind: 'info', info: 'document_failed' });
    },

    /** Everything is dropped - the documents included. Availability is kept (it describes the host, not the session). */
    reset() { set({ ...initialAdvisorState(state.lang), advisorAvailable: state.advisorAvailable, readerAvailable: state.readerAvailable }); },
  };
  return store;
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
