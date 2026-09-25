/**
 * Stage 3.0 (audit v40, §3.0.2/§3.0.4): the multi-document add/list/remove DECISION logic, pulled
 * out of the actual `ProDocuments.tsx` component the same way `render-step-policy.ts` pulled the
 * render-step decision out of `local-ocr.ts` - no DOM, no `File` object, so it can be tested with
 * this project's existing `node --test` frontend runner instead of needing a new DOM-testing
 * framework for one component. `ProDocuments.tsx` imports these functions and calls them, rather
 * than re-deciding the same thing inline - the tested logic and the real UI logic are the same code.
 */

export type ProDocumentType = 'payslip' | 'contract_base' | 'contract_annex';

/** The one thing every entry needs for the pure list operations below - the real component's own
 * entry type also carries a `File` object and extraction results, neither of which these functions
 * need to touch. */
export interface ProDocumentMeta {
  id: string;
  documentType: ProDocumentType;
  /** Required (non-null) only for `contract_annex` once the user is ready to submit - see
   * `isReadyToSubmit`. Always null for `payslip`/`contract_base` (there is nothing to date against a
   * timeline for those - a payslip is its own period, and the base contract needs no date at all,
   * per contract-timeline.ts's own resolver). */
  effectiveDate: string | null;
}

export function addDocument<T extends ProDocumentMeta>(list: T[], entry: T): T[] {
  return [...list, entry];
}

export function removeDocument<T extends ProDocumentMeta>(list: T[], id: string): T[] {
  return list.filter((e) => e.id !== id);
}

export function setDocumentType<T extends ProDocumentMeta>(list: T[], id: string, documentType: ProDocumentType): T[] {
  // Stage 3.0 (§3.0.3): only an annex is dated in this UI (the base contract needs no effective date
  // - contract-timeline.ts's own resolver treats it as always in force). Switching AWAY from
  // 'contract_annex' clears any date the user had entered, so a stale date never survives a type
  // change the user made to correct a mistake.
  return list.map((e) => (e.id === id ? { ...e, documentType, effectiveDate: documentType === 'contract_annex' ? e.effectiveDate : null } : e));
}

export function setEffectiveDate<T extends ProDocumentMeta>(list: T[], id: string, effectiveDate: string): T[] {
  return list.map((e) => (e.id === id ? { ...e, effectiveDate } : e));
}

/** Stage 3.0 (§3.0.3): "a payslip goes through the existing, unchanged Tier C pipeline. A contract
 * or annex goes through [the contract extractor]." The one routing decision this stage adds -
 * tested here in isolation so it can never silently drift from what the component actually does. */
export type ProDocumentRoute = 'tier_c' | 'contract';

export function routeForDocument(documentType: ProDocumentType): ProDocumentRoute {
  return documentType === 'payslip' ? 'tier_c' : 'contract';
}

/** Stage 3.0 (§3.0.4): "the multi-add/remove UI" exit criterion includes not letting a submission
 * go out half-specified - an annex with no effective date at all cannot be placed in
 * contract-timeline.ts's own resolver (it would just report `undated_document` for everything it
 * sets), so the UI refuses to submit rather than send something the backend can only partially use.
 *
 * Stage 3.0.5 (audit v41): "a cleared date should put the entry back into 'not ready'." The date
 * `<input>`'s own `onChange` writes `event.target.value`, which is `''` (not `null`) once a filled
 * date is cleared - a bare `!== null` check here let that blank-but-present string through as
 * "ready," reaching the resolver as if it were a real date (RAPORT-cursor-3.0.md's own finding, the
 * exact live reproduction: a known base value silently replaced by "disagreement"). Checked the
 * same way `contract-timeline.ts`'s own `hasUsableEffectiveDate` does, so the two layers can never
 * disagree about what counts as "no date." */
export function isReadyToSubmit(list: ProDocumentMeta[]): boolean {
  return list.length > 0 && list.every((e) => e.documentType !== 'contract_annex' || (e.effectiveDate !== null && e.effectiveDate !== ''));
}
