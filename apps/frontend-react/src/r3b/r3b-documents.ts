import { addDocument, isReadyToSubmit, removeDocument, routeForDocument, setEffectiveDate, type ProDocumentType } from '../pro-documents-policy.ts';
import type { ProfileRequestDocument } from '../pro-profile-prefill.ts';
import type { DocumentCoverage, FactReaderKind } from '../document-facts-reader.ts';

/**
 * R3-B documents: the selected files, their reading state and what is sent on to the Payroll Profile. The list
 * operations and the annex rule are the existing PRO policy (pro-documents-policy.ts); reading is the existing reader
 * adapter (document-facts-reader.ts). Files live in memory only - never in storage - and are dropped on removal/reset.
 */

/** Exactly the file types the existing reader takes (ProDocuments' file input; the fact routes accept PNG/JPEG images). */
export const ACCEPTED_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const ACCEPT_ATTRIBUTE = ACCEPTED_FILE_TYPES.join(',');
/** R3-B client guard - the reader had no raw-file limit (its page / image / text budgets still apply after this). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export type R3BDocStatus = 'selected' | 'reading' | 'read' | 'failed';

export interface R3BDocument {
  /** Opaque `doc-N` - sent as the profile's `documentId`; never derived from the file. */
  id: string;
  documentType: ProDocumentType;
  /** Annex only: the date it takes effect (required before reading, as in PRO). */
  effectiveDate: string | null;
  file: File | null;
  /** Shown to the user only. Never sent anywhere: the profile receives a technical label instead. */
  fileName: string;
  size: number;
  status: R3BDocStatus;
  /** The reader route's error code, or `file_unreadable` when the file could not be opened at all. */
  errorCode?: string;
  factBatches?: unknown[];
  /** R3-B.2: the reader's server-held references to `factBatches` (null once the server no longer has them). */
  batchRefs?: string[] | null;
  coverage?: DocumentCoverage;
}

export type FileRejection = 'type' | 'size' | 'empty';

export function checkFile(file: { type: string; size: number }): FileRejection | null {
  if (!(ACCEPTED_FILE_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (file.size === 0) return 'empty';
  return file.size > MAX_FILE_BYTES ? 'size' : null;
}

export function addFile(list: R3BDocument[], file: File, documentType: ProDocumentType, id: string): R3BDocument[] {
  return addDocument(list, { id, documentType, effectiveDate: null, file, fileName: file.name, size: file.size, status: 'selected' });
}

export const removeFile = (list: R3BDocument[], id: string): R3BDocument[] => removeDocument(list, id);
export const setAnnexDate = (list: R3BDocument[], id: string, date: string): R3BDocument[] => setEffectiveDate(list, id, date);

export const readerKind = (documentType: ProDocumentType): FactReaderKind => (routeForDocument(documentType) === 'tier_c' ? 'payslip' : 'contract');

/** The documents a read action would send to the reader: never-read or failed ones (a read document is not re-read). */
export const toRead = (list: readonly R3BDocument[]): R3BDocument[] => list.filter((d) => d.file !== null && (d.status === 'selected' || d.status === 'failed'));

/** An annex without its effective date cannot be placed in the contract timeline - the existing PRO rule. */
export const annexDatesComplete = (list: readonly R3BDocument[]): boolean => list.length === 0 || isReadyToSubmit([...list]);

/**
 * What the profile receives: the read documents only, with technical labels (`payslip-1`), no file name. R3-B.2: a
 * document the server still holds is sent by REFERENCE (`batchRefs`) - that is what lets the server build a trusted
 * document context for the conversation; otherwise (or with `byReference: false`) its batches are echoed as before.
 */
export function profileDocuments(list: readonly R3BDocument[], options: { byReference?: boolean } = {}): ProfileRequestDocument[] {
  const byReference = options.byReference ?? true;
  return list
    .filter((d) => d.status === 'read' && d.factBatches)
    .map((d, index) => ({
      index, documentId: d.id, label: `${d.documentType}-${index + 1}`, role: d.documentType,
      effectiveDate: d.documentType === 'contract_annex' ? d.effectiveDate : null,
      ...(byReference && d.batchRefs && d.batchRefs.length > 0 ? { batchRefs: d.batchRefs } : { factBatches: d.factBatches as unknown[] }),
    }));
}

/** Whether any read document would be sent by reference. */
export const sendsReferences = (list: readonly R3BDocument[]): boolean => profileDocuments(list).some((d) => d.batchRefs !== undefined);

/**
 * Whether the calculation week must be asked before resolving (Contract v1.1 §4.2). Only a dated annex makes the
 * Payroll Profile depend on its as-of date (contract-timeline.ts); without one the resolver's result is the same for
 * every date (r3b-document-first.test.ts), so a technical date is used and each value keeps its own document period.
 */
export type AsOfNeed = { kind: 'independent' } | { kind: 'ask'; boundaries: string[] };

export function asOfNeed(list: readonly R3BDocument[]): AsOfNeed {
  const dates = [...new Set(list.filter((d) => d.status === 'read' && d.documentType === 'contract_annex' && d.effectiveDate).map((d) => d.effectiveDate as string))].sort();
  return dates.length === 0 ? { kind: 'independent' } : { kind: 'ask', boundaries: dates };
}

export type PeriodChoice = { kind: 'before'; date: string } | { kind: 'from'; date: string } | { kind: 'day'; date: string };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The as-of date for the user's choice: a week before a change is resolved on the day before it. */
export function asOfForChoice(choice: PeriodChoice): string | null {
  if (!ISO_DAY.test(choice.date)) return null;
  const day = new Date(`${choice.date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return null;
  if (choice.kind === 'before') day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** The user-facing name of a document: its type and its position among documents of that type ("Pasek wypłaty 2"). */
export function documentOrdinal(list: readonly R3BDocument[], id: string): { documentType: ProDocumentType; n: number } | null {
  const doc = list.find((d) => d.id === id);
  if (!doc) return null;
  return { documentType: doc.documentType, n: list.filter((d) => d.documentType === doc.documentType).findIndex((d) => d.id === id) + 1 };
}
