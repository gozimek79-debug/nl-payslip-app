import type { ContractExtraction } from './contract.js';

/**
 * Stage 3.0 (audit v40, §3.0.3): "the base contract and each annex are separate documents, each
 * with an effective date; for a given pay period the engine takes the values in force on that
 * date... an annex that changes part of the terms leaves the rest as it was." This is the resolver
 * - one function, field by field, never a whole-document replacement (a base contract's own
 * `hourlyRate` can stand while an annex's `hoursPerWeek` overrides it, in the same pass).
 *
 * The base contract is always a candidate for every field it sets, regardless of date - there is
 * nothing before it to have overridden it yet. Only an ANNEX needs an effective date to be
 * considered at all: without one, its own values cannot be placed in the timeline, so they never
 * silently win over a value the base contract (or an earlier, dated annex) already supplies (§2.3 -
 * never invent an ordering the document didn't state). When more than one dated annex sets the same
 * field, the one with the LATEST effective date on or before the asked-about date wins; two annexes
 * at the exact same effective date with DIFFERENT values are a genuine disagreement, never resolved
 * by guessing - reported as an explicit gap with both documents named, exactly like a genuinely
 * absent value (§2.1: unknown is never treated as zero, and disagreement is its own kind of unknown).
 */
export type ContractDocumentRole = 'base' | 'annex';

export interface ContractDocumentEntry {
  role: ContractDocumentRole;
  /** ISO date string ("YYYY-MM-DD") this document takes effect from, or null when unread/not
   * applicable. Ignored for `role: 'base'` (see the module doc comment) - required for an annex to
   * ever win a field. */
  effectiveDate: string | null;
  extraction: ContractExtraction;
  /** As-printed or user-given name for this document, shown wherever a `source` or `reason` needs
   * to name it (§2.1's provenance discipline - a value's source is not just "which role", but which
   * actual document). */
  label: string;
}

export interface EffectiveFieldSource {
  documentIndex: number;
  role: ContractDocumentRole;
  label: string;
  effectiveDate: string | null;
}

export interface EffectiveField<T> {
  value: T | null;
  source: EffectiveFieldSource | null;
  /** Non-null only when `value` is null AND the gap is more specific than "no document sets this
   * at all" - a genuine disagreement between two documents, or a document whose own effective date
   * could not be read so it cannot be placed in the timeline. Structured enough to build a sentence
   * from (§2.6), not a prebaked one. */
  reason: { code: 'disagreement'; documentLabels: string[]; asOfDate: string } | { code: 'undated_document'; documentLabel: string } | null;
}

// Deliberately excludes `thirtyPercentRuling` (a non-nullable boolean - "absent" has no
// representation to resolve) and `redactedFields` (a per-extraction diagnostic list, not a fact
// about the job). Every other ContractExtraction field is a genuine job fact that can come from
// either the base contract or an annex, so every other field is resolved the same way.
const CONTRACT_FIELD_KEYS = [
  'contractType', 'employerName', 'functionTitle', 'startDate', 'endDate', 'hoursPerWeek',
  'hourlyRate', 'monthlySalary', 'caoName', 'pensionFund', 'probationPeriodWeeks',
  'noticePeriodWeeks', 'overtimeTierThresholdHours', 'guaranteedHours', 'guaranteedHoursPeriodWeeks',
] as const satisfies readonly Exclude<keyof ContractExtraction, 'thirtyPercentRuling' | 'redactedFields'>[];

type ContractFieldKey = (typeof CONTRACT_FIELD_KEYS)[number];

export type EffectiveContract = { [K in ContractFieldKey]: EffectiveField<ContractExtraction[K]> };

// Untyped at the per-field level deliberately: looping over the field-key union and assigning into
// a precisely-typed EffectiveContract slot can't both be generic AND satisfy the compiler per
// iteration (a well-known mapped-type-loop limitation, not a laxity here) - `resolveEffectiveContract`
// below is what keeps the PUBLIC shape fully typed per field; this helper stays internal.
// Stage 3.0.5 (audit v41): "an annex whose effectiveDate is '' is not null, so it is not caught by
// the undated branch." Confirmed live by Cursor (RAPORT-cursor-3.0.md): base 15.55, a blank-dated
// annex at 99, asked as of 2026-06-01 -> hourlyRate came back `disagreement` between the base and
// the blank annex - a known real value discarded for "unknown," worse than either candidate alone.
// A blank string reaches here because the date `<input>` (ProDocuments.tsx) writes
// `event.target.value`, which is `''` (not `null`) once a filled date is cleared - `''` also happens
// to satisfy `'' <= asOfDate` (the lexicographic minimum), so the old `!== null` check waved it
// straight through as if it were a real, very-early date. One predicate, used everywhere an
// annex's own date is tested, so "does this document have a usable date" can never again be
// answered two different ways in two different branches.
function hasUsableEffectiveDate(doc: ContractDocumentEntry): boolean {
  return doc.effectiveDate !== null && doc.effectiveDate !== '';
}

function resolveFieldUntyped(field: ContractFieldKey, documents: ContractDocumentEntry[], asOfDate: string): EffectiveField<unknown> {
  const withValue = documents
    .map((doc, documentIndex) => ({ doc, documentIndex, value: doc.extraction[field] as unknown }))
    .filter((c) => c.value !== null);

  // A candidate is "in force as of asOfDate" when it is the base contract (always available - see
  // the module doc comment) or an annex with a USABLE effective date that has arrived.
  const applicable = withValue.filter((c) => c.doc.role === 'base' || (hasUsableEffectiveDate(c.doc) && (c.doc.effectiveDate as string) <= asOfDate));
  // An annex that DOES set this field but whose own effective date is unread (null) OR unusable
  // (blank) - never silently dropped without a trace, never silently trusted either.
  const undated = withValue.filter((c) => c.doc.role === 'annex' && !hasUsableEffectiveDate(c.doc));

  if (applicable.length === 0) {
    const firstUndated = undated[0];
    if (firstUndated) {
      return { value: null, source: null, reason: { code: 'undated_document', documentLabel: firstUndated.doc.label } };
    }
    return { value: null, source: null, reason: null }; // no document at all sets this field - an ordinary, silent gap (§2.1)
  }

  // Base sorts before every annex (it is the layer everything else overrides); among annexes, the
  // one with the latest effective date on or before asOfDate wins. `BASE_SORT_KEY` is the
  // lexicographic minimum of every possible ISO date string, so it sorts below any real annex date
  // by construction - and, since `hasUsableEffectiveDate` above has already excluded every
  // blank/null annex from `applicable` entirely, no annex reaching this comparison can ever equal
  // it either. The only tie this can ever produce from here on is two real annexes sharing the
  // same real, on-or-before date - never base-vs-annex.
  const BASE_SORT_KEY = '';
  const sortKey = (c: (typeof applicable)[number]) => (c.doc.role === 'base' ? BASE_SORT_KEY : (c.doc.effectiveDate as string));
  const maxKey = applicable.reduce((max, c) => (sortKey(c) > max ? sortKey(c) : max), BASE_SORT_KEY);
  const atMax = applicable.filter((c) => sortKey(c) === maxKey);

  if (atMax.length > 1) {
    const distinctValues = new Set(atMax.map((c) => JSON.stringify(c.value)));
    if (distinctValues.size > 1) {
      return { value: null, source: null, reason: { code: 'disagreement', documentLabels: atMax.map((c) => c.doc.label), asOfDate } };
    }
  }

  const winner = atMax[0];
  if (!winner) return { value: null, source: null, reason: null }; // unreachable (atMax is a non-empty subset of the non-empty applicable), guarded for the compiler only
  return {
    value: winner.value,
    source: { documentIndex: winner.documentIndex, role: winner.doc.role, label: winner.doc.label, effectiveDate: winner.doc.effectiveDate },
    reason: null,
  };
}

export function resolveEffectiveContract(documents: ContractDocumentEntry[], asOfDate: string): EffectiveContract {
  const result = {} as Record<ContractFieldKey, EffectiveField<unknown>>;
  for (const field of CONTRACT_FIELD_KEYS) {
    result[field] = resolveFieldUntyped(field, documents, asOfDate);
  }
  return result as unknown as EffectiveContract;
}
