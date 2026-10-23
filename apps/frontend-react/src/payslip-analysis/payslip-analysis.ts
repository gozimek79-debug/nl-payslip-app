import type { DocumentCoverage, DocumentReadOutcome, FactReaderKind } from '../document-facts-reader.ts';
import { resolveProfile, type PrintedFactView } from '../pro-profile-prefill.ts';
import { checkFile, type FileRejection } from '../r3b/r3b-documents.ts';
import type { ConsistencyIssue, Discrepancy, Outcome, TierCPeriodResponse } from '../tier-c-shared.ts';

/**
 * FIN-02 Payslip Analysis (Analiza dokumentów -> Paski wypłat). ONE payslip, three existing server steps, no new
 * pipeline:
 *   1. read     the existing reader adapter -> POST /api/pro/payslip-facts (Gemini; only on the user's explicit read).
 *               Each batch is kept SERVER-side for this browser session; the client receives an opaque `batchRef`.
 *   2. facts    POST /api/profile/resolve BY REFERENCE -> the Document Knowledge (typed, PII-screened printed facts)
 *               plus a `documentContext` reference - the one the PRO advisor already accepts (hand-off, no copy).
 *   3. checks   POST /api/pro/payslip-replay BY REFERENCE (no AI): the existing replay - the payslip's own arithmetic
 *               (`needsConfirmation`) and Loonto's calculation vs the printed figures (`discrepancies`).
 * Client JSON is never the source: without server references the analysis does not run. Everything here is about the
 * PRINTED document of one past period - never a forecast, never a legal or CAO verdict.
 */

// ---------------------------------------------------------------------------------------------
// The printed facts (Document Knowledge) as the screen shows them
// ---------------------------------------------------------------------------------------------

export interface PrintedLine {
  label: string | null;
  value: number;
  page: number | null;
}

export interface PayLine {
  label: string | null;
  hours: number | null;
  amount: number | null;
  page: number | null;
}

export interface PrintedSummary {
  period: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** Distinct printed hourly rates - more than one is a conflict Loonto does not resolve. */
  rates: PrintedLine[];
  regularHours: number | null;
  overtimeHours: number | null;
  /** Printed totals, each kept apart; null = not read from the payslip (never zero). */
  gross: PrintedLine | null;
  net: PrintedLine | null;
  payout: PrintedLine | null;
  payLines: PayLine[];
  surcharges: Array<{ label: string | null; percent: number; page: number | null }>;
  deductions: PrintedLine[];
  tax: PrintedLine[];
  reimbursements: PrintedLine[];
}

const num = (f: PrintedFactView) => (typeof f.value === 'number' ? f.value : null);
const line = (f: PrintedFactView): PrintedLine | null => (typeof f.value === 'number' ? { label: f.label, value: f.value, page: f.page } : null);
const first = (facts: PrintedFactView[], key: string) => facts.find((f) => f.key === key);

export function printedSummary(facts: readonly PrintedFactView[]): PrintedSummary {
  const payslip = facts.filter((f) => f.role === 'payslip');
  const text = (key: string) => {
    const f = first(payslip, key);
    return f && typeof f.value === 'string' ? f.value : null;
  };
  const lines = (key: string) => payslip.filter((f) => f.key === key).map(line).filter((l): l is PrintedLine => l !== null);
  const sum = (key: string) => {
    const values = payslip.filter((f) => f.key === key).map(num).filter((v): v is number => v !== null);
    return values.length > 0 ? Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100 : null;
  };
  const single = (key: string) => {
    const f = first(payslip, key);
    return f ? line(f) : null;
  };
  // A wage line is printed once with its hours and its amount: the reader gives them as two facts with the same label.
  const payLines: PayLine[] = [];
  for (const f of payslip.filter((x) => x.key === 'wage_line_amount' || x.key === 'regular_hours' || x.key === 'overtime_hours')) {
    const existing = payLines.find((p) => p.label === f.label && p.page === f.page && (f.key === 'wage_line_amount' ? p.amount === null : p.hours === null));
    const target = existing ?? { label: f.label, hours: null, amount: null, page: f.page };
    if (f.key === 'wage_line_amount') target.amount = num(f);
    else target.hours = num(f);
    if (!existing) payLines.push(target);
  }
  const rates: PrintedLine[] = [];
  for (const f of facts.filter((x) => x.key === 'hourly_rate')) {
    const l = line(f);
    if (l && !rates.some((r) => Math.abs(r.value - l.value) < 0.005)) rates.push(l);
  }
  return {
    period: text('period_label'), periodStart: text('period_start'), periodEnd: text('period_end'),
    rates, regularHours: sum('regular_hours'), overtimeHours: sum('overtime_hours'),
    gross: single('gross_total'), net: single('net'), payout: single('payout'),
    payLines,
    surcharges: payslip.filter((f) => f.key === 'surcharge_percent' && typeof f.value === 'number').map((f) => ({ label: f.label, percent: f.value as number, page: f.page })),
    deductions: [...lines('deduction'), ...lines('net_deduction')],
    tax: [...lines('tax'), ...lines('tax_special')],
    reimbursements: lines('reimbursement'),
  };
}

// ---------------------------------------------------------------------------------------------
// The checks (existing replay) - what may be said, and what may not
// ---------------------------------------------------------------------------------------------

export interface ReplayView {
  status: 'ok' | 'unavailable';
  reason?: string;
  period: TierCPeriodResponse;
  outcome?: Outcome;
  discrepancies?: Discrepancy[];
  needsConfirmation?: ConsistencyIssue[];
  taxRatesSource?: 'database' | 'static';
  coverage?: { totalPages: number; processedPages: number[]; notProcessedPages: number[] };
  source?: 'server_reference' | 'client_echo';
}

/** The payslip's OWN figures do not add up (printed vs printed / read lines) - a reason to look, maybe a misread. */
export const ARITHMETIC_CODES = [
  'gross_lines_do_not_reconcile', 'pre_tax_does_not_reconcile', 'net_does_not_reconcile', 'totals_do_not_reconcile_net',
  'totals_do_not_reconcile_payout', 'printed_tax_bases_do_not_reconcile', 'et_reduction_reimbursement_mismatch', 'anchors_inverted',
] as const;
/** Inputs Loonto's own calculation needs and does not have - with any of these, no computed-vs-printed comparison is shown. */
export const INPUT_GAP_CODES = ['printed_tax_unknown', 'pre_tax_unknown', 'pre_tax_not_confirmed', 'period_type_unknown', 'et_exchange_amount_unknown', 'amount_unreadable'] as const;

export interface IssueGroups {
  arithmetic: ConsistencyIssue[];
  gaps: ConsistencyIssue[];
  uncertain: ConsistencyIssue[];
}

export function groupIssues(issues: readonly ConsistencyIssue[]): IssueGroups {
  const groups: IssueGroups = { arithmetic: [], gaps: [], uncertain: [] };
  for (const issue of issues) {
    if ((ARITHMETIC_CODES as readonly string[]).includes(issue.code)) groups.arithmetic.push(issue);
    else if ((INPUT_GAP_CODES as readonly string[]).includes(issue.code)) groups.gaps.push(issue);
    else groups.uncertain.push(issue);
  }
  return groups;
}

/**
 * When Loonto's calculation may be compared with the printed figures:
 *   substantiated  the replay is complete and no input is missing -> the existing discrepancy list, with its tolerances
 *   limited        inputs are missing or uncertain, or a page was not read -> the comparison is NOT shown; the screen
 *                  says what is missing (items on an unread page could explain any difference)
 *   unavailable    the replay could not run at all (e.g. the period type is not printed)
 */
export type ComparisonState =
  | { kind: 'substantiated'; discrepancies: Discrepancy[] }
  | { kind: 'limited'; gaps: ConsistencyIssue[]; pagesNotRead: number[] }
  | { kind: 'unavailable'; reason: string };

export function comparisonState(replay: ReplayView): ComparisonState {
  if (replay.status !== 'ok' || !replay.outcome) return { kind: 'unavailable', reason: replay.reason ?? 'unknown' };
  const groups = groupIssues(replay.needsConfirmation ?? []);
  const pagesNotRead = replay.coverage?.notProcessedPages ?? [];
  if (replay.outcome.status !== 'complete' || groups.gaps.length > 0 || pagesNotRead.length > 0) return { kind: 'limited', gaps: groups.gaps, pagesNotRead };
  return { kind: 'substantiated', discrepancies: replay.discrepancies ?? [] };
}

// ---------------------------------------------------------------------------------------------
// The screen's state
// ---------------------------------------------------------------------------------------------

export type AnalysisError =
  /** The reader route's own codes (vision_unavailable, reader_timeout, ...) or the adapter's (network_error, ...). */
  | { stage: 'read'; code: string }
  /** The server could not keep the read for this session - without a server reference nothing is analysed. */
  | { stage: 'reference'; code: 'server_reference_unavailable' }
  | { stage: 'facts'; code: 'analysis_failed' };

export type ReplayProblem = 'document_expired' | 'tax_rates_unavailable' | 'replay_failed' | null;

export interface PayslipAnalysisState {
  file: File | null;
  fileName: string | null;
  fileError: FileRejection | null;
  /** null = unknown; false = this host has no reader (e.g. a Preview without the Gemini key). */
  readerAvailable: boolean | null;
  phase: 'empty' | 'selected' | 'reading' | 'analysing' | 'done';
  error: AnalysisError | null;
  coverage: DocumentCoverage | null;
  facts: PrintedFactView[] | null;
  /** The server-held document context - the PRO advisor can use THIS reference (same session) for questions. */
  contextRef: string | null;
  replay: ReplayView | null;
  replayProblem: ReplayProblem;
  batchRefs: string[] | null;
}

export interface PayslipAnalysisDeps {
  fetchImpl: typeof fetch;
  readFacts: (file: File, kind: FactReaderKind) => Promise<DocumentReadOutcome>;
  readerStatus: () => Promise<boolean | null>;
  today: () => string;
}

export const initialPayslipState = (): PayslipAnalysisState => ({
  file: null, fileName: null, fileError: null, readerAvailable: null, phase: 'empty', error: null, coverage: null, facts: null, contextRef: null, replay: null,
  replayProblem: null, batchRefs: null,
});

export type PayslipAnalysisStore = ReturnType<typeof createPayslipAnalysisStore>;

export function createPayslipAnalysisStore(deps: PayslipAnalysisDeps) {
  let state = initialPayslipState();
  const listeners = new Set<() => void>();
  const patch = (p: Partial<PayslipAnalysisState>) => { state = { ...state, ...p }; for (const l of listeners) l(); };
  const busy = () => state.phase === 'reading' || state.phase === 'analysing';

  async function replay(batchRefs: string[]): Promise<{ replay: ReplayView | null; problem: ReplayProblem }> {
    try {
      const res = await deps.fetchImpl('/api/pro/payslip-replay', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchRefs }) });
      const data = (await res.json()) as ReplayView & { error_code?: string };
      if (res.status === 409) return { replay: null, problem: 'document_expired' };
      if (res.status === 503 && data.error_code === 'tax_rates_unavailable') return { replay: null, problem: 'tax_rates_unavailable' };
      if (!res.ok || (data.status !== 'ok' && data.status !== 'unavailable') || !data.period) return { replay: null, problem: 'replay_failed' };
      return { replay: data, problem: null };
    } catch {
      return { replay: null, problem: 'replay_failed' };
    }
  }

  async function analyse(batchRefs: string[]) {
    patch({ phase: 'analysing', error: null });
    const resolved = await resolveProfile(deps.today(), [{ index: 0, documentId: 'doc-1', label: 'payslip-1', role: 'payslip', effectiveDate: null, batchRefs }], deps.fetchImpl);
    if (!resolved?.documentContext) {
      patch({ phase: 'done', error: { stage: 'facts', code: 'analysis_failed' } });
      return;
    }
    const checks = await replay(batchRefs);
    patch({ phase: 'done', facts: resolved.documentContext.knowledge.facts, contextRef: resolved.documentContext.ref, replay: checks.replay, replayProblem: checks.problem });
  }

  const store = {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async checkReader() {
      const available = await deps.readerStatus().catch(() => null);
      patch({ readerAvailable: available });
    },
    selectFile(file: File) {
      if (busy()) return;
      const rejection = checkFile(file);
      if (rejection) {
        patch({ fileError: rejection });
        return;
      }
      patch({ ...initialPayslipState(), readerAvailable: state.readerAvailable, file, fileName: file.name, phase: 'selected' });
    },
    removeFile() {
      if (busy()) return;
      patch({ ...initialPayslipState(), readerAvailable: state.readerAvailable });
    },
    /** The ONLY action that sends the document anywhere - after the consent shown next to the button. */
    async read() {
      const file = state.file;
      if (!file || busy() || state.readerAvailable === false) return;
      patch({ phase: 'reading', error: null, facts: null, contextRef: null, replay: null, replayProblem: null, batchRefs: null, coverage: null });
      let outcome: DocumentReadOutcome;
      try {
        outcome = await deps.readFacts(file, 'payslip');
      } catch {
        outcome = { status: 'error', errorCode: 'file_unreadable' };
      }
      if (outcome.status !== 'done') {
        patch({ phase: 'selected', error: { stage: 'read', code: outcome.errorCode ?? 'unknown' } });
        return;
      }
      if (!outcome.batchRefs || outcome.batchRefs.length === 0) {
        patch({ phase: 'selected', error: { stage: 'reference', code: 'server_reference_unavailable' }, coverage: outcome.coverage });
        return;
      }
      patch({ coverage: outcome.coverage, batchRefs: outcome.batchRefs });
      await analyse(outcome.batchRefs);
    },
    /** Facts or checks failed after a good read: analyse the SAME server-held read again (no new provider call). */
    async retryAnalysis() {
      if (!state.batchRefs || busy()) return;
      await analyse(state.batchRefs);
    },
    reset() { patch({ ...initialPayslipState(), readerAvailable: state.readerAvailable }); },
  };
  return store;
}
