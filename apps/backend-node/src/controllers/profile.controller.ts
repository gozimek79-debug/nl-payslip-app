import express from 'express';
import { z } from 'zod';
import { resolvePayrollProfile, type ProfileDocumentInput } from '../payroll-engine/payroll-profile.js';
import {
  applyUserDecisions, duplicateDocumentIds, isProfileFieldPath, MAX_DECISIONS, MAX_FIELD_PATH_LENGTH, PROFILE_UNITS,
  type UserProfileDecision,
} from '../payroll-engine/profile-decisions.js';
import { evaluateReadiness, normalizeActiveGroups, REQUIREMENT_GROUP_IDS, type RequirementGroupId } from '../payroll-engine/profile-readiness.js';
import { mergePayslipBatches, mergeContractBatches, type DocumentFacts } from '../payroll-engine/document-facts.js';
import { buildExtractionTable } from '../payroll-engine/fact-table.js';
import { parsePayslipBatches, parseContractBatches } from './fact-schemas.js';
import { readSessionHash } from '../document-context/session.js';
import { DOCUMENT_REF, getRecord, putRecord } from '../document-context/store.js';
import { buildDocumentKnowledge } from '../document-context/knowledge.js';

/**
 * P1 (§P1.2/§P1.5): the Payroll Profile's HTTP boundary - request-scoped, no storage, no AI call.
 *
 * P2 (§P2.13): documents now arrive as the document-fact batches the client received from
 * /api/pro/payslip-facts and /api/pro/contract-facts (each re-validated against the exact typed shape).
 * The batches of one document are merged here, deterministically (document-facts.ts), and the merged
 * facts are what the unchanged resolver consumes. The response also carries the developer extraction
 * table (§P2.14) built from those same merged facts.
 *
 * Deliberately absent from the request: discrepancies, needsConfirmation, any "fully reproduced"
 * flag, any replay result. Unknown keys are stripped by the schema.
 *
 * P3.1 S2: each document may carry an optional `documentId` - the client's per-upload `DocEntry.id`,
 * an opaque non-empty string of at most 64 characters (no format is imposed, nothing reads meaning
 * into it). It is carried into the profile's provenance; older requests without it stay valid.
 *
 * P3.1 S3: two documents with the same `documentId` are rejected (400) before anything is resolved or
 * fingerprinted - document identity must be unambiguous. The request may carry up to 200 field-level
 * `decisions` (default none); the response profile is the documentary profile with those decisions
 * overlaid (profile-decisions.ts, stateless - nothing is stored), plus one `decisionResults` entry per
 * decision in request order.
 *
 * P3.1 S4: the request may name the active requirement `groups` (default `core_pay`, O4). The response
 * adds `issues` - one per unresolved field with a severity (blocking only when required in an active
 * group), candidates, hints, actions, a typed input and the documentary evidence fingerprint - and
 * `readiness` (profile-readiness.ts). Pure and stateless; no replay or per-payslip confirmation state
 * enters it (unknown request keys, including the legacy ones, are stripped).
 *
 * R3-B.2: a document may instead name `batchRefs` - references to batches THIS server's reader route stored for this
 * browser session (document-context/store.ts). When EVERY document comes by reference, the response also carries a
 * `documentContext` { ref, knowledge }: the resolved profile and its Document Knowledge kept server-side, the only
 * way a conversation turn gets trusted document facts. Echoed `factBatches` keep working exactly as before and
 * never produce a document context (client JSON is never trusted as a document). An unknown, expired or
 * other-session reference is refused with 409 `document_reference_invalid`.
 */
const router = express.Router();

const MAX_DOCUMENTS = 30;

const documentSchema = z.object({
  index: z.number().int().min(0),
  documentId: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(300),
  role: z.enum(['contract_base', 'contract_annex', 'payslip']),
  effectiveDate: z.string().max(40).nullable(),
  factBatches: z.unknown().optional(),
  batchRefs: z.array(z.string().regex(DOCUMENT_REF)).min(1).max(20).optional(),
}).refine((d) => (d.factBatches !== undefined) !== (d.batchRefs !== undefined), { message: 'exactly one of factBatches / batchRefs' });

/** ISO calendar date or date-time; echoed only. */
const ISO_DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const decisionCommon = {
  decisionId: z.string().min(1).max(64),
  fieldPath: z.string().min(1).max(MAX_FIELD_PATH_LENGTH).refine(isProfileFieldPath),
  // Shape only; the value's range for the field's unit is judged by the overlay (rejected/invalid_value).
  value: z.union([z.number(), z.string().max(1000), z.boolean(), z.array(z.number()).max(50)]),
  evidenceFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  decidedAt: z.string().max(40).regex(ISO_DATE_OR_DATETIME),
};

const decisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('confirm_candidate'), ...decisionCommon }),
  z.object({ kind: z.literal('correct_value'), ...decisionCommon, unit: z.enum(PROFILE_UNITS as [string, ...string[]]) }),
]);

const resolveProfileSchema = z.object({
  asOfDate: z.string().min(1).max(40),
  documents: z.array(documentSchema).max(MAX_DOCUMENTS),
  decisions: z.array(decisionSchema).max(MAX_DECISIONS).optional(),
  // P3.1 S4: which requirement groups are active. Omitted = the O4 default ['core_pay']; [] is allowed.
  // Unknown ids are rejected; repeats are harmless (deduplicated). There is no scenario input here.
  requirements: z.object({ groups: z.array(z.enum(REQUIREMENT_GROUP_IDS)).max(REQUIREMENT_GROUP_IDS.length * 4) }).optional(),
});

router.post('/resolve', async (req, res) => {
  const parsed = resolveProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error_code: 'invalid_input', details: parsed.error.flatten() });
  if (duplicateDocumentIds(parsed.data.documents).length > 0) return res.status(400).json({ error_code: 'invalid_input' });

  const seen = new Set<number>();
  const documents: ProfileDocumentInput[] = [];
  const sessionHash = readSessionHash(req);
  const byReference = parsed.data.documents.length > 0 && parsed.data.documents.every((d) => d.batchRefs !== undefined);
  for (const d of parsed.data.documents) {
    if (seen.has(d.index)) return res.status(400).json({ error_code: 'invalid_input' });
    seen.add(d.index);
    let rawBatches: unknown = d.factBatches;
    if (d.batchRefs) {
      const expected = d.role === 'payslip' ? 'payslip' : 'contract';
      const stored = await Promise.all(d.batchRefs.map((ref) => getRecord(ref, sessionHash, 'batch')));
      if (stored.some((r) => r === null || r.documentKind !== expected)) return res.status(409).json({ error_code: 'document_reference_invalid' });
      rawBatches = stored.map((r) => r?.batch);
    }
    let facts: DocumentFacts;
    if (d.role === 'payslip') {
      const batches = parsePayslipBatches(rawBatches);
      if (!batches) return res.status(400).json({ error_code: 'invalid_input' });
      facts = mergePayslipBatches(batches);
    } else {
      const batches = parseContractBatches(rawBatches);
      if (!batches) return res.status(400).json({ error_code: 'invalid_input' });
      facts = mergeContractBatches(batches);
    }
    documents.push({ index: d.index, documentId: d.documentId ?? null, label: d.label, role: d.role, effectiveDate: d.role === 'contract_annex' ? d.effectiveDate : null, facts });
  }

  const documentary = resolvePayrollProfile({ asOfDate: parsed.data.asOfDate, documents });
  const decisions = (parsed.data.decisions ?? []) as UserProfileDecision[];
  const { profile, decisionResults } = applyUserDecisions(documentary, decisions);
  const groups: RequirementGroupId[] = normalizeActiveGroups(parsed.data.requirements?.groups);
  const { issues, readiness } = evaluateReadiness(profile, { groups, decisions, decisionResults });
  const extractionTable = buildExtractionTable(documents.map((d) => ({ documentIndex: d.index, documentLabel: d.label, role: d.role, facts: d.facts })));
  const coverage = documents.map((d) => ({ index: d.index, ...d.facts.coverage }));
  let documentContext: { ref: string; knowledge: ReturnType<typeof buildDocumentKnowledge> } | null = null;
  // The context holds the DOCUMENTARY profile: user decisions never become document trust.
  if (byReference && sessionHash) {
    const knowledge = buildDocumentKnowledge(documents, documentary);
    const ref = await putRecord(sessionHash, { kind: 'context', profile: documentary, knowledge });
    if (ref) documentContext = { ref, knowledge };
  }
  return res.json({ profile, extractionTable, coverage, decisionResults, issues, readiness, documentContext });
});

export default router;
