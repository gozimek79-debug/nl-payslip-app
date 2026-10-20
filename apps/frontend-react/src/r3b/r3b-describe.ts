import { documentOrdinal, type R3BDocument } from './r3b-documents.ts';
import type { FactSource, KnownFact } from './r3b-profile-projection.ts';
import { PREMIUM_FIELDS, nodeAt, type DocumentAnswerView, type NextQuestionView, type TurnResultView } from './r3b-turn.ts';
import type { PrintedFactView } from '../pro-profile-prefill.ts';
import type { Block, ChoiceRef, ReadReportItem, TurnContext } from './r3b-flow.ts';
import { fieldLabel, formatDate, formatValue, money, scenarioUnit, type R3BCopy, type R3BLang } from './r3b-copy.ts';

/**
 * R3-B: the words for each conversation block - pure functions of the block and the document list, so the same
 * sentences are rendered on screen and asserted in tests. Values come only from the backend's data (profile, R2).
 */

const IN_GOAL = /^(work\.|pay\.)/;

export function documentName(docs: readonly R3BDocument[], id: string | null, role: FactSource['role'], copy: R3BCopy): string {
  const ordinal = id ? documentOrdinal(docs, id) : null;
  if (ordinal) return copy.docName(ordinal.documentType, ordinal.n);
  return copy.roles[role] ?? role;
}

export function periodText(source: FactSource, lang: R3BLang): string | null {
  const p = source.period;
  if (!p) return null;
  if (p.start && p.end && p.start !== p.end) return `${formatDate(p.start, lang)}–${formatDate(p.end, lang)}`;
  if (p.end || p.start) return formatDate(p.end ?? p.start, lang);
  return p.label;
}

/** "Pasek wypłaty 1 (10.08.2026–16.08.2026)" / "Umowa 1" / "Aneks do umowy 1 (od 01.09.2026)". */
export function sourceWhere(source: FactSource, docs: readonly R3BDocument[], copy: R3BCopy, lang: R3BLang): string {
  const name = documentName(docs, source.documentId, source.role, copy);
  const period = periodText(source, lang);
  if (period) return `${name} (${period})`;
  return source.effectiveDate ? `${name} (${copy.summary.detailEffective(formatDate(source.effectiveDate, lang))})` : name;
}

/** The accessible "how I know" lines of one source - only what the document actually carries. */
export function sourceDetails(source: FactSource, docs: readonly R3BDocument[], copy: R3BCopy, lang: R3BLang): string[] {
  const lines = [copy.summary.detailDoc(`${documentName(docs, source.documentId, source.role, copy)}${source.documentId ? ` · ID ${source.documentId}` : ''}`)];
  const period = periodText(source, lang);
  if (period) lines.push(copy.summary.detailPeriod(period));
  if (source.effectiveDate) lines.push(copy.summary.detailEffective(formatDate(source.effectiveDate, lang)));
  if (source.page !== null) lines.push(copy.summary.detailPage(source.page));
  const printed = source.rawValue ?? source.printedLabel;
  if (printed) lines.push(copy.summary.detailPrinted(printed.length > 160 ? `${printed.slice(0, 157)}…` : printed));
  return lines;
}

export function factValue(fact: KnownFact, copy: R3BCopy, lang: R3BLang): string {
  if (fact.status === 'conflict') return copy.summary.conflict;
  if (fact.value === null) return fact.path === 'employment.hourlyRate' ? copy.summary.rateNotFound : copy.summary.statuses.unknown;
  return formatValue(fact.unit, fact.value, lang);
}

export function choiceLabel(choice: ChoiceRef, docs: readonly R3BDocument[], copy: R3BCopy, lang: R3BLang): string {
  switch (choice.kind) {
    case 'read': return copy.offer.read(choice.count);
    case 'continue_without': return copy.offer.continueWithout;
    case 'period':
      if (choice.choice === 'unknown') return copy.period.unknown;
      if (choice.choice.kind === 'before') return copy.period.before(formatDate(choice.choice.date, lang));
      if (choice.choice.kind === 'from') return copy.period.from(formatDate(choice.choice.date, lang));
      return formatDate(choice.choice.date, lang);
    case 'conflict_candidate': return copy.conflict.candidate(`${money(choice.value, lang)}/h`, choice.sources.map((s) => sourceWhere(s, docs, copy, lang)).join(', '));
    case 'conflict_unknown': return copy.conflict.dontKnow;
    case 'percent': return choice.meaning === 'total' ? copy.percent.total(choice.value) : choice.meaning === 'above' ? copy.percent.above(choice.value) : copy.percent.dontKnow;
  }
}

export function readReportLines(items: readonly ReadReportItem[], anyRead: boolean, docs: readonly R3BDocument[], copy: R3BCopy): string[] {
  const lines = items.map((item) => {
    const doc = docs.find((d) => d.id === item.docId);
    const name = doc ? documentName(docs, doc.id, doc.documentType, copy) : item.docId;
    if (item.outcome === 'failed') return copy.readReport.failed(name, copy.readReport.errors[item.errorCode ?? 'unknown'] ?? copy.readReport.errors.unknown as string);
    if (item.outcome === 'partial') return copy.readReport.partial(name, item.notProcessedPages.join(', '), item.totalPages, item.tooLong);
    return copy.readReport.ok(name);
  });
  if (!items.some((i) => i.outcome !== 'failed')) lines.push(anyRead ? copy.readReport.next : copy.readReport.noneRead);
  return lines;
}

/** ONE question, in words, aware of what the documents did or did not show. */
export function questionText(q: NextQuestionView, ctx: TurnContext, copy: R3BCopy, lang: R3BLang): string {
  const label = fieldLabel(q.field, lang);
  const total = typeof q.prompt.params.statedWeeklyTotal === 'number' ? q.prompt.params.statedWeeklyTotal : null;
  switch (q.kind) {
    case 'clarify_hours_composition': return copy.questions.clarify(total);
    case 'offer_assumption': {
      const v = q.suggestedAssumption?.value;
      return copy.questions.offer(label, typeof v === 'number' ? formatValue(scenarioUnit(q.field), v, lang) : String(v ?? ''));
    }
    case 'resolve_conflict': return copy.questions.conflict(label);
    case 'correct_value': return copy.questions.correct(label);
    case 'provide_value': break;
  }
  if (q.field === 'work.hours') return q.reasonCode === 'hours_include_other_categories' ? copy.questions.split(total) : copy.questions.opening(ctx.contractHours);
  if (q.field === 'work.overtimeDistribution') return copy.questions.distribution;
  if (q.field.startsWith('work.')) return copy.questions.hours(label);
  if (q.field === 'pay.hourlyRate') return ctx.conflictFields.includes(q.field) ? copy.questions.conflict(label) : copy.questions.rate(ctx.docsRead && !ctx.rateFoundInDocs);
  if (q.field === 'pay.overtime.thresholdHoursPerDay') return copy.questions.threshold;
  if ((PREMIUM_FIELDS as readonly string[]).includes(q.field)) return copy.questions.premium(label, ctx.docsRead && !ctx.premiumsInDocs.includes(q.field));
  return copy.questions.generic(label);
}

/** R3-B.2: one printed fact in words - "Stawka godzinowa: €15,55/h („Uurloon”) — Pasek wypłaty 1, week 41/2026". */
export function printedFactLine(fact: PrintedFactView, docs: readonly R3BDocument[], copy: R3BCopy, lang: R3BLang): string {
  const value = fact.unit === 'percent' && typeof fact.value === 'number' ? `${formatValue('percent', fact.value, lang)}%`
    : fact.unit === 'date' ? formatDate(String(fact.value), lang) : formatValue(fact.unit, fact.value, lang);
  const printed = fact.label ? ` („${fact.label}”)` : '';
  const where = [documentName(docs, fact.documentId, fact.role, copy), fact.key === 'period_label' ? null : fact.periodLabel].filter(Boolean).join(', ');
  return `${copy.answer.keys[fact.key] ?? fact.key}: ${value}${printed} — ${where}${fact.status === 'conflict' ? ` (${copy.answer.conflict})` : ''}`;
}

/** R3-B.2: the answer to a question about the document, from its printed facts only. */
export function documentAnswerLines(answer: DocumentAnswerView, docs: readonly R3BDocument[], copy: R3BCopy, lang: R3BLang): { intro: string | null; items: string[]; notes: string[] } {
  if (!answer.available) return { intro: null, items: [], notes: [copy.answer.noContext] };
  if (answer.items.length === 0) return { intro: null, items: [], notes: [copy.answer.notFound] };
  const notes = [copy.answer.note];
  if (answer.topics.includes('deductions')) notes.push(copy.answer.whyNet);
  return { intro: copy.answer.intro, items: answer.items.map((f) => printedFactLine(f, docs, copy, lang)), notes };
}

const HIDDEN_HINTS = new Set(['needs_information', 'cannot_calculate_without_inputs', 'result_ready', 'document_answer']);

/** What one R2 turn did, what it asks next, and - when nothing is left to ask - what stays open. */
export function describeTurn(block: Extract<Block, { kind: 'turn' }>, copy: R3BCopy, lang: R3BLang): { lines: string[]; question: string | null; closing: string[] } {
  const r: TurnResultView = block.result;
  const lines: string[] = [];
  const pendingField = r.conversation?.pendingQuestion?.field ?? null;
  if (r.status === 'rejected') lines.push(copy.turn.hints[r.responseHint?.code === 'untrusted_scenario' ? 'untrusted_scenario' : 'patch_rejected'] as string);
  for (const op of r.patchApplied ?? []) {
    if (op.op !== 'write' || !op.field || !op.node) continue;
    const label = fieldLabel(op.field, lang);
    if (op.node.state === 'unknown') lines.push(copy.turn.unknown(label));
    else if (op.node.state === 'known') {
      const value = formatValue(scenarioUnit(op.field), op.node.value, lang);
      lines.push(op.node.source === 'loonto_assumption' ? copy.turn.assumed(label, value) : copy.turn.saved(label, value));
    } else if (op.node.state === 'range') lines.push(copy.turn.saved(label, `${formatValue(scenarioUnit(op.field), op.node.low, lang)}–${formatValue(scenarioUnit(op.field), op.node.high, lang)}`));
  }
  for (const note of r.patchNotes ?? []) {
    const render = copy.turn.notes[note.code] ?? copy.turn.notes.other;
    lines.push((render as (label: string) => string)(fieldLabel(note.field ?? pendingField ?? '', lang)));
  }
  const hint = r.responseHint;
  if (hint && r.status !== 'rejected') {
    if (hint.code === 'answer_not_applied') lines.push(copy.turn.notApplied[String(hint.params?.reason)] ?? (copy.turn.hints.message_unclear as string));
    else if (!HIDDEN_HINTS.has(hint.code) && copy.turn.hints[hint.code]) lines.push(copy.turn.hints[hint.code] as string);
  }
  for (const f of block.deferredNow) lines.push(copy.turn.deferred(fieldLabel(f, lang)));
  if (r.intent === 'calculation_request' && r.status !== 'rejected') {
    const rate = nodeAt(r.scenario, 'pay.hourlyRate');
    if (rate?.state === 'known' && rate.source === 'document' && typeof rate.value === 'number') lines.push(copy.turn.rateFromDocument(formatValue('eur_per_hour', rate.value, lang)));
    lines.push(copy.turn.calculationGated);
  }
  const asked = r.nextQuestion ? questionText(r.nextQuestion, block.context, copy, lang) : null;
  const question = asked && r.documentAnswer ? `${copy.answer.backTo} ${asked}` : asked;
  const closing: string[] = [];
  if (!r.nextQuestion && r.status !== 'rejected') {
    const status = r.evaluation?.status;
    if (status === 'unsupported') closing.push(copy.turn.unsupported);
    else if (status === 'computed') closing.push(copy.turn.computedHidden);
    else {
      closing.push(copy.turn.done);
      const open = openAfterTurn(r, block.context, copy, lang);
      if (open.length > 0) closing.push(copy.turn.open(open.join(', ')));
    }
    closing.push(copy.turn.noResult);
  }
  return { lines, question, closing };
}

function openAfterTurn(r: TurnResultView, ctx: TurnContext, copy: R3BCopy, lang: R3BLang): string[] {
  const fields = new Set<string>();
  for (const req of r.evaluation?.requirements ?? []) if (IN_GOAL.test(req.field) || req.field === 'work.hours') fields.add(req.field);
  // A deferred field the server has since filled (e.g. the rate from a trusted document context) is not open.
  for (const f of r.conversation?.deferredFields ?? []) if ((IN_GOAL.test(f) || f === 'work.hours') && nodeAt(r.scenario, f)?.state !== 'known') fields.add(f);
  return [...fields].map((f) => {
    const label = fieldLabel(f, lang);
    if (ctx.conflictFields.includes(f)) return `${label} (${copy.summary.statuses.conflict})`;
    if (ctx.documentFields.includes(f)) return `${label} (${copy.summary.statuses.document_reading})`;
    return `${label} (${copy.panel.sources.unknown.toLowerCase()})`;
  });
}
