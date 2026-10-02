import express from 'express';
import { z } from 'zod';
import { isGeminiConfigured, extractPayslipFacts, extractContractFacts, type FactReadRequest } from '../ai-service/gemini-client.js';
import { ipRateLimit } from '../rate-limiter.js';
import { getMinimumWageAt } from '../rules-repository.js';
import { mergePayslipBatches, payslipFactsToTierCExtraction } from '../payroll-engine/document-facts.js';
import { computePayslipPeriod } from '../payroll-engine/payslip-model.js';
import { comparePeriodToDocument } from '../payroll-engine/discrepancy.js';
import { checkExtractionConsistency, resolveNetPosition, type ConsistencyIssue } from '../payroll-engine/extraction-consistency.js';
import { mapExtractionToPeriod, resolveEtExchangeAmountFromExtraction, remapUnreadableFieldToPeriodPath } from '../payroll-engine/tier-c.js';
import { fetchRates, resolveReferenceDate } from './tier-c.controller.js';
import { parsePayslipBatches } from './fact-schemas.js';

/**
 * P2 (ZADANIE-P2-LOONTO-PRO.md §P2.3-§P2.9): the PRO document-fact boundary.
 *
 *   POST /api/pro/payslip-facts   one Gemini read of one page batch of a payslip  -> { batch }
 *   POST /api/pro/contract-facts  one Gemini read of one page batch of a contract/annex -> { batch }
 *   POST /api/pro/payslip-replay  NO AI - the historical replay/audit of an already-read payslip,
 *                                 from its fact batches (internal diagnostic only)
 *
 * Fact extraction never depends on replay: a fact route returns every fact it could read whatever
 * the payslip's period type or audit status. The replay keeps its own hard requirement (a confirmed
 * period type) inside its own route, where it can only ever affect the diagnostic panel (§P2.4).
 * Neither fact route calls Groq (§P2.12): canonical facts come from the Gemini read only.
 */
const router = express.Router();
const payslipFactsRateLimit = ipRateLimit('pro-payslip-facts-ai', 10, 300, 'deny');
const contractFactsRateLimit = ipRateLimit('pro-contract-facts-ai', 10, 300, 'deny');

/** The batch budget the client plans against (document-batches.ts mirrors these; the server is the
 * boundary that enforces them). Images: 3 per call is the measured budget under Vercel's 4.5 MB
 * request-body limit (render-step-policy.ts). Text: generous for whole text-layer contracts, still
 * far below the body limit. */
export const MAX_IMAGES_PER_CALL = 3;
export const MAX_PAGES_PER_CALL = 20;
export const MAX_TEXT_LINES_PER_CALL = 6000;
export const MAX_TEXT_CHARS_PER_CALL = 200_000;

const imageDataUrl = z.string().min(50).max(16_000_000).regex(/^data:image\/(png|jpe?g);base64,/);
const pageNumber = z.number().int().min(1).max(1000);

const factReadSchema = z.object({
  pages: z.array(pageNumber).min(1).max(MAX_PAGES_PER_CALL),
  totalPages: pageNumber,
  images: z.array(imageDataUrl).max(MAX_IMAGES_PER_CALL),
  imagePages: z.array(pageNumber).max(MAX_IMAGES_PER_CALL),
  textLines: z.array(z.object({ page: pageNumber, text: z.string().max(1000) })).max(MAX_TEXT_LINES_PER_CALL),
});

type FactReadError = 'invalid_input' | 'text_layer_too_large';

/** Structural checks beyond the zod shape: every page is a real page of the document and is read in
 * this call; images and text only for pages of this call; something to read at all. */
export function validateFactRead(body: unknown): { ok: true; req: FactReadRequest } | { ok: false; error: FactReadError } {
  const parsed = factReadSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: 'invalid_input' };
  const { pages, totalPages, images, imagePages, textLines } = parsed.data;
  const pageSet = new Set(pages);
  if (pageSet.size !== pages.length || pages.some((p) => p > totalPages)) return { ok: false, error: 'invalid_input' };
  if (images.length !== imagePages.length || imagePages.some((p) => !pageSet.has(p)) || new Set(imagePages).size !== imagePages.length) return { ok: false, error: 'invalid_input' };
  if (textLines.some((l) => !pageSet.has(l.page))) return { ok: false, error: 'invalid_input' };
  if (images.length === 0 && textLines.length === 0) return { ok: false, error: 'invalid_input' };
  // Never silently cut text (§P2.9): an over-budget text layer is refused with a reason, so the client
  // re-plans smaller batches instead of the reader seeing a tail-less document.
  if (textLines.reduce((sum, l) => sum + l.text.length, 0) > MAX_TEXT_CHARS_PER_CALL) return { ok: false, error: 'text_layer_too_large' };
  return { ok: true, req: { pages, totalPages, images, imagePages, textLines } };
}

function factRoute(read: (req: FactReadRequest) => Promise<unknown>) {
  return async (req: express.Request, res: express.Response) => {
    if (!isGeminiConfigured()) return res.status(503).json({ error_code: 'vision_unavailable' });
    const validated = validateFactRead(req.body);
    if (!validated.ok) return res.status(400).json({ error_code: validated.error });
    try {
      const batch = await read(validated.req);
      return res.json({ batch });
    } catch (error) {
      // Never log the reader's content (personal data) - the error class only.
      console.error('PRO fact read error', error instanceof Error ? error.name : 'unknown');
      return res.status(502).json({ error_code: 'extraction_failed' });
    }
  };
}

router.post('/payslip-facts', payslipFactsRateLimit, factRoute(extractPayslipFacts));
router.post('/contract-facts', contractFactsRateLimit, factRoute(extractContractFacts));

/**
 * The historical replay, now fed by document facts instead of a second reader call. Same steps and
 * same response vocabulary as /api/tier-c/analyze after its read (so the existing diagnostic panel and
 * /api/tier-c/recompute keep working), but it can only ever answer for the diagnostic: a period type
 * the facts do not establish makes the replay `unavailable` - the facts themselves were already
 * returned by the fact route and already feed the profile.
 */
router.post('/payslip-replay', async (req, res) => {
  const batches = parsePayslipBatches(req.body?.batches);
  if (!batches) return res.status(400).json({ error_code: 'invalid_input' });
  try {
    const facts = mergePayslipBatches(batches);
    const extraction = payslipFactsToTierCExtraction(facts);
    const applicableMinimumWage = await getMinimumWageAt(resolveReferenceDate(extraction.period_end_date));
    const period = mapExtractionToPeriod(extraction, applicableMinimumWage);
    if (extraction.period_type === null) {
      return res.json({ status: 'unavailable', reason: 'period_type_unknown', period });
    }
    const fetched = await fetchRates(extraction.period_type);
    if (!fetched) return res.status(503).json({ error_code: 'tax_rates_unavailable' });
    const outcome = computePayslipPeriod(period, fetched.rates, true);
    const needsConfirmation: ConsistencyIssue[] = [];
    if (extraction.et_reimbursement_lines.length > 0 && resolveEtExchangeAmountFromExtraction(extraction) === null) {
      needsConfirmation.push({ code: 'et_exchange_amount_unknown' });
    }
    for (const field of extraction.unreadable_amount_fields) {
      needsConfirmation.push({ code: 'amount_unreadable', field: remapUnreadableFieldToPeriodPath(field, extraction) });
    }
    needsConfirmation.push(...checkExtractionConsistency(extraction.payment_date, period, outcome));
    return res.json({
      status: 'ok',
      period,
      outcome,
      discrepancies: comparePeriodToDocument(period, outcome),
      net_position: resolveNetPosition(period, outcome),
      needsConfirmation,
      technicalDetails: {
        text_items_sent: 0,
        text_layer_status: 'none' as const,
        request_size_kb: 0,
        request_size_source: 'measured' as const,
        render_step: 'facts',
        text_layer_source: 'none' as const,
      },
      taxRatesSource: fetched.source,
      coverage: facts.coverage,
    });
  } catch (error) {
    console.error('PRO payslip replay error', error instanceof Error ? error.name : 'unknown');
    return res.status(502).json({ error_code: 'recompute_failed' });
  }
});

export default router;
