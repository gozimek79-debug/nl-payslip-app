import type { PayrollProfile, ProfileDocumentInput, ProfileField } from '../payroll-engine/payroll-profile.js';
import type { FactUnit, PayrollFact, PayslipDocumentFacts, ContractDocumentFacts } from '../payroll-engine/document-facts.js';

/**
 * R3-B.2 Document Knowledge: what the documents THIS server read actually print, as a small typed list - the context
 * the conversation answers from ("Na pasku widzę...") and the only document context the language model ever sees.
 *
 * Built only from server-held facts (Gemini batches stored by the reader route, merged and resolved here) - never
 * from client JSON. A whitelist of non-identifying payroll facts: rate, hours, period, wage-line amounts, printed
 * gross / net / payout, reimbursements, deductions and printed tax. Never names, employer, addresses, BSN, IBAN,
 * dates of birth, raw text fragments or page images. Every value is a READING of the document - printed, not checked
 * or recalculated - and a value the documents print differently is kept as a conflict with each version listed.
 */

export const DOCUMENT_TOPICS = ['summary', 'hourly_rate', 'hours', 'period', 'gross', 'net', 'payout', 'reimbursement', 'deductions'] as const;
export type DocumentTopic = (typeof DOCUMENT_TOPICS)[number];
export type FactTopic = Exclude<DocumentTopic, 'summary'>;
export type KnowledgeUnit = 'eur' | 'eur_per_hour' | 'hours' | 'hours_per_week' | 'percent' | 'text' | 'date' | 'period_type';

export interface KnowledgeFact {
  topic: FactTopic;
  /** What the value is: hourly_rate, regular_hours, overtime_hours, contract_hours_per_week, period_label, period_start,
   * period_end, period_type, wage_line_amount, surcharge_percent, gross_total, net, payout, reimbursement, deduction,
   * net_deduction, tax, tax_special. */
  key: string;
  /** The printed label (already personal-data screened by the reader mapping), shortened. */
  label: string | null;
  value: number | string;
  unit: KnowledgeUnit;
  /** A reading of the document; `conflict` when the documents print different values for the same thing. */
  status: 'document_reading' | 'conflict';
  documentIndex: number;
  documentId: string | null;
  role: 'payslip' | 'contract_base' | 'contract_annex';
  page: number | null;
  periodLabel: string | null;
}

export interface DocumentKnowledge {
  version: 1;
  facts: KnowledgeFact[];
}

const MAX_LABEL = 60;
const label = (text: string | null | undefined): string | null => (typeof text === 'string' && text.trim() ? text.trim().slice(0, MAX_LABEL) : null);

function exactValue(occurrences: PayrollFact[] | undefined): { fact: PayrollFact; value: number | string } | null {
  for (const f of occurrences ?? []) if (f.status === 'exact' && f.value !== null) return { fact: f, value: f.value };
  return null;
}

const unitOf = (unit: FactUnit): KnowledgeUnit =>
  unit === 'eur_per_hour' ? 'eur_per_hour' : unit.startsWith('eur') ? 'eur' : unit === 'hours_per_week' ? 'hours_per_week' : unit === 'hours' ? 'hours'
    : unit === 'percent' ? 'percent' : unit === 'date' ? 'date' : unit === 'period_type' ? 'period_type' : 'text';

function payslipFacts(doc: ProfileDocumentInput, facts: PayslipDocumentFacts): KnowledgeFact[] {
  const out: KnowledgeFact[] = [];
  const periodLabel = exactValue(facts.scalars.periodLabel);
  const base = { documentIndex: doc.index, documentId: doc.documentId ?? null, role: 'payslip' as const, periodLabel: periodLabel ? String(periodLabel.value).slice(0, 40) : null };
  const scalar = (topic: FactTopic, key: string, occurrences: PayrollFact[] | undefined) => {
    const found = exactValue(occurrences);
    if (found) out.push({ ...base, topic, key, label: label(found.fact.evidence.printedLabel), value: found.value, unit: unitOf(found.fact.unit), status: 'document_reading', page: found.fact.evidence.page });
  };
  scalar('period', 'period_label', facts.scalars.periodLabel);
  scalar('period', 'period_start', facts.scalars.periodStart);
  scalar('period', 'period_end', facts.scalars.periodEnd);
  scalar('period', 'period_type', facts.scalars.periodType);
  for (const line of facts.hourLines) {
    const at = { ...base, label: label(line.evidence.printedLabel), status: 'document_reading' as const, page: line.evidence.page };
    if (line.kind === 'regular' && line.hours !== null) out.push({ ...at, topic: 'hours', key: 'regular_hours', value: line.hours, unit: 'hours' });
    if (line.kind === 'overtime' && line.hours !== null) out.push({ ...at, topic: 'hours', key: 'overtime_hours', value: line.hours, unit: 'hours' });
    if ((line.kind === 'adv_compensation' || line.kind === 'irregular_surcharge') && line.percent !== null) out.push({ ...at, topic: 'gross', key: 'surcharge_percent', value: line.percent, unit: 'percent' });
    if (line.amount !== null) out.push({ ...at, topic: 'gross', key: 'wage_line_amount', value: Math.abs(line.amount), unit: 'eur' });
  }
  scalar('gross', 'gross_total', facts.scalars.printedGrossTotal);
  scalar('net', 'net', facts.scalars.printedNet);
  scalar('payout', 'payout', facts.scalars.printedPayout);
  for (const line of facts.netLines) {
    if (line.amount === null) continue;
    const reimbursement = line.category === 'reimbursement';
    out.push({ ...base, topic: reimbursement ? 'reimbursement' : 'deductions', key: reimbursement ? 'reimbursement' : 'net_deduction', label: label(line.evidence.printedLabel), value: Math.abs(line.amount), unit: 'eur', status: 'document_reading', page: line.evidence.page });
  }
  for (const line of facts.etReimbursementLines) {
    if (line.amount !== null) out.push({ ...base, topic: 'reimbursement', key: 'reimbursement', label: label(line.evidence.printedLabel), value: Math.abs(line.amount), unit: 'eur', status: 'document_reading', page: line.evidence.page });
  }
  for (const line of facts.deductionLines) {
    if (line.amount !== null) out.push({ ...base, topic: 'deductions', key: 'deduction', label: label(line.evidence.printedLabel), value: Math.abs(line.amount), unit: 'eur', status: 'document_reading', page: line.evidence.page });
  }
  scalar('deductions', 'tax', facts.scalars.printedTableTax);
  scalar('deductions', 'tax_special', facts.scalars.printedBtTax);
  return out;
}

function contractFacts(doc: ProfileDocumentInput, facts: ContractDocumentFacts): KnowledgeFact[] {
  const found = exactValue(facts.scalars.hoursPerWeek);
  if (!found) return [];
  return [{ topic: 'hours', key: 'contract_hours_per_week', label: label(found.fact.evidence.printedLabel), value: found.value, unit: 'hours_per_week', status: 'document_reading', documentIndex: doc.index, documentId: doc.documentId ?? null, role: doc.role, page: found.fact.evidence.page, periodLabel: null }];
}

/** The hourly rate exactly as the Payroll Profile resolved it: every candidate with its own source; distinct values = conflict. */
function rateFacts(field: ProfileField | undefined, documents: ProfileDocumentInput[]): KnowledgeFact[] {
  if (!field) return [];
  const all = field.candidates.filter((c) => typeof c.value === 'number' && c.source.sourceType === 'document');
  const distinct = new Set(all.map((c) => Math.round((c.value as number) * 100)));
  // One document printing the same rate twice (header "Uurloon" + the regular wage line) is ONE reading of it.
  const seen = new Set<string>();
  const candidates = all.filter((c) => {
    const k = `${c.source.documentIndex}:${Math.round((c.value as number) * 100)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return candidates.map((c) => {
    const doc = documents.find((d) => d.index === c.source.documentIndex);
    return {
      topic: 'hourly_rate' as const, key: 'hourly_rate', label: label(c.source.printedLabel), value: c.value as number, unit: 'eur_per_hour' as const,
      status: distinct.size > 1 ? ('conflict' as const) : ('document_reading' as const),
      documentIndex: c.source.documentIndex ?? -1, documentId: c.source.documentId ?? null,
      role: (doc?.role ?? (c.source.role === 'payslip' || c.source.role === 'contract_annex' ? c.source.role : 'contract_base')) as KnowledgeFact['role'],
      page: c.source.page, periodLabel: c.source.payPeriod?.label?.slice(0, 40) ?? null,
    };
  });
}

export function buildDocumentKnowledge(documents: ProfileDocumentInput[], profile: PayrollProfile): DocumentKnowledge {
  const facts: KnowledgeFact[] = [...rateFacts(profile.employment.hourlyRate, documents)];
  for (const doc of documents) {
    facts.push(...(doc.role === 'payslip' ? payslipFacts(doc, doc.facts as PayslipDocumentFacts) : contractFacts(doc, doc.facts as ContractDocumentFacts)));
  }
  return { version: 1, facts };
}

const SUMMARY_KEYS = new Set(['hourly_rate', 'regular_hours', 'overtime_hours', 'period_label', 'gross_total', 'net', 'payout', 'reimbursement']);
const TOPIC_EXTRA: Partial<Record<FactTopic, FactTopic[]>> = {
  // "Why is the net lower?" needs the printed path from gross to net.
  deductions: ['gross', 'net'],
  // A payout is explained by what it consists of.
  payout: ['net', 'reimbursement'],
};

/** The facts that answer these topics - document readings only, nothing computed. */
export function answerFacts(knowledge: DocumentKnowledge | null, topics: readonly DocumentTopic[]): KnowledgeFact[] {
  if (!knowledge) return [];
  if (topics.includes('summary')) return knowledge.facts.filter((f) => SUMMARY_KEYS.has(f.key));
  const asked = new Set(topics.filter((t): t is FactTopic => t !== 'summary'));
  const wanted = new Set<FactTopic>(asked);
  for (const t of asked) for (const extra of TOPIC_EXTRA[t] ?? []) wanted.add(extra);
  // Wage lines only when gross itself was asked - or, for a deductions question, when no gross total is printed: the
  // printed wage lines are then the only printed starting point. Readings side by side, never a computed difference.
  const grossTotalPrinted = knowledge.facts.some((f) => f.key === 'gross_total');
  const wageLines = asked.has('gross') || (asked.has('deductions') && !grossTotalPrinted);
  return knowledge.facts.filter((f) => wanted.has(f.topic) && (f.topic !== 'gross' || wageLines || f.key === 'gross_total'));
}

/** The model's view: the minimum to understand a question about the document - typed keys and values only. No ids,
 * pages, period labels or printed labels: a label is free text printed in the document, so it could carry personal
 * data or an instruction-looking string, and the model does not need it to recognise what the user asks about. */
export function agentDocumentDigest(knowledge: DocumentKnowledge | null): Array<{ topic: FactTopic; key: string; value: number | string; unit: KnowledgeUnit; status: KnowledgeFact['status'] }> {
  if (!knowledge) return [];
  return knowledge.facts
    .filter((f) => typeof f.value === 'number' || f.unit === 'date' || f.unit === 'period_type')
    .slice(0, 40)
    .map((f) => ({ topic: f.topic, key: f.key, value: f.value, unit: f.unit, status: f.status }));
}
