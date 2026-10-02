import express from 'express';
import { z } from 'zod';
import { resolvePayrollProfile, type ProfileDocumentInput } from '../payroll-engine/payroll-profile.js';
import { mergePayslipBatches, mergeContractBatches, type DocumentFacts } from '../payroll-engine/document-facts.js';
import { buildExtractionTable } from '../payroll-engine/fact-table.js';
import { parsePayslipBatches, parseContractBatches } from './fact-schemas.js';

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
 */
const router = express.Router();

const MAX_DOCUMENTS = 30;

const documentSchema = z.object({
  index: z.number().int().min(0),
  label: z.string().min(1).max(300),
  role: z.enum(['contract_base', 'contract_annex', 'payslip']),
  effectiveDate: z.string().max(40).nullable(),
  factBatches: z.unknown(),
});

const resolveProfileSchema = z.object({
  asOfDate: z.string().min(1).max(40),
  documents: z.array(documentSchema).max(MAX_DOCUMENTS),
});

router.post('/resolve', (req, res) => {
  const parsed = resolveProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error_code: 'invalid_input', details: parsed.error.flatten() });

  const seen = new Set<number>();
  const documents: ProfileDocumentInput[] = [];
  for (const d of parsed.data.documents) {
    if (seen.has(d.index)) return res.status(400).json({ error_code: 'invalid_input' });
    seen.add(d.index);
    let facts: DocumentFacts;
    if (d.role === 'payslip') {
      const batches = parsePayslipBatches(d.factBatches);
      if (!batches) return res.status(400).json({ error_code: 'invalid_input' });
      facts = mergePayslipBatches(batches);
    } else {
      const batches = parseContractBatches(d.factBatches);
      if (!batches) return res.status(400).json({ error_code: 'invalid_input' });
      facts = mergeContractBatches(batches);
    }
    documents.push({ index: d.index, label: d.label, role: d.role, effectiveDate: d.role === 'contract_annex' ? d.effectiveDate : null, facts });
  }

  const profile = resolvePayrollProfile({ asOfDate: parsed.data.asOfDate, documents });
  const extractionTable = buildExtractionTable(documents.map((d) => ({ documentIndex: d.index, documentLabel: d.label, role: d.role, facts: d.facts })));
  const coverage = documents.map((d) => ({ index: d.index, ...d.facts.coverage }));
  return res.json({ profile, extractionTable, coverage });
});

export default router;
