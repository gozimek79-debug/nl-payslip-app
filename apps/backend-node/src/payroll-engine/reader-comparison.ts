import type { TierCExtraction } from './tier-c.js';
import { stripDiacritics } from './extraction-consistency.js';

/**
 * Stage 2s (audit v51, §2s.2): "a field on which both readings agree to the cent is confirmed; a
 * field on which they disagree is flagged with a new issue code that names the field and both values;
 * neither value is chosen (§2.3); a line one reading has and the other does not is flagged the same
 * way; there is no rule that removes the check when many fields disagree." This is the whole
 * mechanism: no threshold, no fallback, no fewer-than-N-disagreements-so-trust-it-anyway rule like the
 * old bag-of-numbers guard had (2i.0a's `TEXT_LAYER_MISMATCH_RATIO`/`FLOOR`) - that rule existed to
 * decide whether a garbled TEXT LAYER was still worth trusting; two independent READERS disagreeing is
 * a different, stronger signal that does not get weaker the more it repeats.
 */
export type ReaderComparisonIssue =
  | { code: 'reader_field_disagreement'; field: string; value_a: string | number | boolean | null; value_b: string | number | boolean | null }
  | { code: 'reader_line_disagreement'; list: string; line_key: string; index: number; field: string; value_a: string | number | boolean | null; value_b: string | number | boolean | null }
  | { code: 'reader_line_only_in_a'; list: string; line_key: string; count: number }
  | { code: 'reader_line_only_in_b'; list: string; line_key: string; count: number }
  | { code: 'reader_line_ambiguous_alignment'; list: string; line_key: string; count_a: number; count_b: number };

const CENT_EPSILON = 0.005;

function normalizedString(value: string): string {
  return stripDiacritics(value.trim());
}

/** Two independent transcriptions of the same document rarely differ only in whitespace/diacritics/
 * case - when they do, that is reader noise, not a disagreement about what the document says. */
function scalarsAgree(a: unknown, b: unknown): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= CENT_EPSILON;
  if (typeof a === 'string' && typeof b === 'string') return normalizedString(a) === normalizedString(b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  return a === b;
}

function asIssueValue(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

function compareScalarField(field: string, a: unknown, b: unknown, out: ReaderComparisonIssue[]): void {
  if (!scalarsAgree(a, b)) out.push({ code: 'reader_field_disagreement', field, value_a: asIssueValue(a), value_b: asIssueValue(b) });
}

/** `employer_names` is the one array field that is a set of facts, not a list of lines with their own
 * per-entry amounts - compared as a normalized, order-independent set rather than aligned like the
 * line lists below (there is no meaningful "category" to align two employer names by). */
function compareEmployerNames(a: string[], b: string[], out: ReaderComparisonIssue[]): void {
  const normalize = (list: string[]) => [...list.map(normalizedString)].sort();
  const na = normalize(a);
  const nb = normalize(b);
  if (na.length !== nb.length || na.some((v, i) => v !== nb[i])) {
    out.push({ code: 'reader_field_disagreement', field: 'employer_names', value_a: a.join('; ') || null, value_b: b.join('; ') || null });
  }
}

interface LineWithCategory {
  description: string;
  category?: string;
  type?: string;
}

/**
 * Stage 2s (§2s.2): "lines are aligned by what they are (category, description, order on the page),
 * not by amount... where alignment is ambiguous... flag it; do not guess." Lines are grouped by
 * (category or type, normalized description) - the two facts that identify what a line IS, independent
 * of any amount either reader may have misread. Within one key, equal counts on both sides pair
 * positionally (order on the page, per the task's own instruction) and each pair's OTHER fields are
 * compared field-by-field; unequal counts are the genuinely ambiguous shape (a split/merged line, or a
 * line one reader missed) and are flagged rather than guessed at - `only_in_a`/`only_in_b` when one
 * side is exactly zero (a clean "this reader didn't see it"), `ambiguous_alignment` when both sides are
 * non-zero but differ (neither "missing" nor "extra" describes it honestly).
 */
function compareLineList<T extends LineWithCategory>(listName: string, a: T[], b: T[], compareFields: string[], out: ReaderComparisonIssue[]): void {
  const asRecord = (line: T): Record<string, unknown> => line as unknown as Record<string, unknown>;
  const keyOf = (line: T): string => `${(line.category ?? line.type ?? '').toString().toLowerCase()}::${normalizedString(line.description ?? '')}`;
  const groupBy = (lines: T[]): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const line of lines) {
      const key = keyOf(line);
      const group = map.get(key) ?? [];
      group.push(line);
      map.set(key, group);
    }
    return map;
  };
  const groupsA = groupBy(a);
  const groupsB = groupBy(b);
  const allKeys = new Set([...groupsA.keys(), ...groupsB.keys()]);
  for (const key of allKeys) {
    const linesA = groupsA.get(key) ?? [];
    const linesB = groupsB.get(key) ?? [];
    if (linesA.length === 0) {
      out.push({ code: 'reader_line_only_in_b', list: listName, line_key: key, count: linesB.length });
      continue;
    }
    if (linesB.length === 0) {
      out.push({ code: 'reader_line_only_in_a', list: listName, line_key: key, count: linesA.length });
      continue;
    }
    if (linesA.length !== linesB.length) {
      out.push({ code: 'reader_line_ambiguous_alignment', list: listName, line_key: key, count_a: linesA.length, count_b: linesB.length });
      continue;
    }
    for (let i = 0; i < linesA.length; i += 1) {
      const lineA = asRecord(linesA[i]!);
      const lineB = asRecord(linesB[i]!);
      for (const field of compareFields) {
        if (!scalarsAgree(lineA[field], lineB[field])) {
          out.push({ code: 'reader_line_disagreement', list: listName, line_key: key, index: i, field, value_a: asIssueValue(lineA[field]), value_b: asIssueValue(lineB[field]) });
        }
      }
    }
  }
}

/**
 * Stage 2s (§2s.2): the full comparison, every field of `TierCExtraction` (never a subset chosen for
 * convenience) - `truncated`/`redacted_fields`/`unreadable_amount_fields` are per-reader technical
 * metadata about HOW each reader answered, not document content, and are deliberately excluded: they
 * describe the reading, not a disagreement about what is printed.
 */
export function compareReaderExtractions(a: TierCExtraction, b: TierCExtraction): ReaderComparisonIssue[] {
  const issues: ReaderComparisonIssue[] = [];

  compareScalarField('period_label', a.period_label, b.period_label, issues);
  compareScalarField('period_end_date', a.period_end_date, b.period_end_date, issues);
  compareScalarField('payment_date', a.payment_date, b.payment_date, issues);
  compareScalarField('period_type', a.period_type, b.period_type, issues);
  compareScalarField('is_correction', a.is_correction, b.is_correction, issues);
  compareScalarField('version', a.version, b.version, issues);
  compareEmployerNames(a.employer_names, b.employer_names, issues);
  compareScalarField('hirer_name', a.hirer_name, b.hirer_name, issues);
  compareScalarField('hours_per_week', a.hours_per_week, b.hours_per_week, issues);
  compareScalarField('minimum_wage_printed', a.minimum_wage_printed, b.minimum_wage_printed, issues);
  compareScalarField('bijzonder_tarief_printed_percent', a.bijzonder_tarief_printed_percent, b.bijzonder_tarief_printed_percent, issues);
  compareScalarField('bijzonder_tarief_jaarloon', a.bijzonder_tarief_jaarloon, b.bijzonder_tarief_jaarloon, issues);
  compareScalarField('et_exchange_amount', a.et_exchange_amount, b.et_exchange_amount, issues);
  compareScalarField('printed_table_tax', a.printed_table_tax, b.printed_table_tax, issues);
  compareScalarField('printed_bt_tax', a.printed_bt_tax, b.printed_bt_tax, issues);
  compareScalarField('printed_algemene_heffingskorting', a.printed_algemene_heffingskorting, b.printed_algemene_heffingskorting, issues);
  compareScalarField('printed_arbeidskorting', a.printed_arbeidskorting, b.printed_arbeidskorting, issues);
  compareScalarField('printed_gross_total', a.printed_gross_total, b.printed_gross_total, issues);
  compareScalarField('printed_loon_voor_heffingen', a.printed_loon_voor_heffingen, b.printed_loon_voor_heffingen, issues);
  compareScalarField('printed_taxable_base_normal', a.printed_taxable_base_normal, b.printed_taxable_base_normal, issues);
  compareScalarField('printed_taxable_base_special', a.printed_taxable_base_special, b.printed_taxable_base_special, issues);
  compareScalarField('reported_total_net', a.reported_total_net, b.reported_total_net, issues);
  compareScalarField('reported_net_paid', a.reported_net_paid, b.reported_net_paid, issues);
  compareScalarField('printed_table_tax_label', a.printed_table_tax_label, b.printed_table_tax_label, issues);
  compareScalarField('printed_bt_tax_label', a.printed_bt_tax_label, b.printed_bt_tax_label, issues);
  compareScalarField('printed_algemene_heffingskorting_label', a.printed_algemene_heffingskorting_label, b.printed_algemene_heffingskorting_label, issues);
  compareScalarField('printed_arbeidskorting_label', a.printed_arbeidskorting_label, b.printed_arbeidskorting_label, issues);
  compareScalarField('printed_net_label', a.printed_net_label, b.printed_net_label, issues);
  compareScalarField('printed_payout_label', a.printed_payout_label, b.printed_payout_label, issues);

  compareLineList('hour_lines', a.hour_lines, b.hour_lines, ['hours', 'rate', 'percent', 'amount', 'tax_treatment', 'adds_hours', 'employer_index'], issues);
  compareLineList('pre_tax_deduction_lines', a.pre_tax_deduction_lines, b.pre_tax_deduction_lines, ['amount', 'base', 'percent'], issues);
  compareLineList('post_tax_deduction_lines', a.post_tax_deduction_lines, b.post_tax_deduction_lines, ['amount', 'percent'], issues);
  compareLineList('et_reimbursement_lines', a.et_reimbursement_lines, b.et_reimbursement_lines, ['amount'], issues);
  compareLineList('net_lines', a.net_lines, b.net_lines, ['amount'], issues);
  compareLineList(
    'payout_adjustment_lines',
    a.payout_adjustment_lines.map((l) => ({ ...l, category: 'payout_adjustment' })),
    b.payout_adjustment_lines.map((l) => ({ ...l, category: 'payout_adjustment' })),
    ['amount'],
    issues,
  );
  compareLineList(
    'reservation_lines',
    a.reservation_lines.map((l) => ({ ...l, description: l.type })),
    b.reservation_lines.map((l) => ({ ...l, description: l.type })),
    ['opgebouwd', 'paid_out'],
    issues,
  );

  return issues;
}
