import express from 'express';
import { z } from 'zod';
import { contractExtractionSchema } from './contract.controller.js';
import { isValidPayslipPeriodShape } from './tier-c.controller.js';
import { resolvePayrollProfile, type ProfileDocumentInput } from '../payroll-engine/payroll-profile.js';
import { normalizePeriodSigns } from '../payroll-engine/sign-policy.js';

/**
 * P1 (§P1.2/§P1.5): the Payroll Profile's HTTP boundary. Takes documents the client ALREADY has
 * (each contract's `canonicalExtraction` from /api/contracts/analyze, each payslip's `period` from
 * /api/tier-c/analyze) and returns the resolved profile - no AI call, no rules lookup, no storage
 * (owner decision 6: request-scoped only), same shape as /api/contracts/resolve-timeline.
 *
 * Deliberately absent from the request: discrepancies, needsConfirmation, any "fully reproduced"
 * flag. A payslip's only audit-derived input is the field-level `unreadableFieldPaths` list, which
 * excludes exactly those amounts and nothing else.
 */
const router = express.Router();

const MAX_DOCUMENTS = 30;

const documentSchema = z.object({
  index: z.number().int().min(0),
  label: z.string().min(1).max(300),
  role: z.enum(['contract_base', 'contract_annex', 'payslip']),
  effectiveDate: z.string().nullable(),
  contractExtraction: contractExtractionSchema.optional(),
  payslip: z
    .object({
      // Shape-checked below with the SAME validator /api/tier-c/recompute uses for a client-echoed period.
      period: z.unknown(),
      unreadableFieldPaths: z.array(z.string().max(200)).max(200),
    })
    .optional(),
});

const resolveProfileSchema = z.object({
  asOfDate: z.string().min(1),
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
    if (d.role === 'payslip') {
      if (!d.payslip || !isValidPayslipPeriodShape(d.payslip.period)) return res.status(400).json({ error_code: 'invalid_input' });
      documents.push({
        index: d.index,
        label: d.label,
        role: d.role,
        effectiveDate: null,
        payslip: { period: normalizePeriodSigns(d.payslip.period), unreadableFieldPaths: d.payslip.unreadableFieldPaths },
      });
    } else {
      if (!d.contractExtraction) return res.status(400).json({ error_code: 'invalid_input' });
      documents.push({ index: d.index, label: d.label, role: d.role, effectiveDate: d.effectiveDate, contractExtraction: d.contractExtraction });
    }
  }

  return res.json({ profile: resolvePayrollProfile({ asOfDate: parsed.data.asOfDate, documents }) });
});

export default router;
