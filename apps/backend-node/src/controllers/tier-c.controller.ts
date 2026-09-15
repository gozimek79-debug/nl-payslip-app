import express from 'express';
import { getCurrentRule, getMinimumWageAt } from '../rules-repository.js';
import { isCompleteTaxRatesFile, loadStaticTaxRatesAt, type TaxRatesFile } from '../payroll-engine/calculator.js';
import { computePayslipPeriod, periodMultiplierFor, type PayslipComputationRates, type PayslipPeriod } from '../payroll-engine/payslip-model.js';
import { comparePeriodToDocument } from '../payroll-engine/discrepancy.js';
import { checkExtractionConsistency } from '../payroll-engine/extraction-consistency.js';
import { mapExtractionToPeriod, type TierCExtraction } from '../payroll-engine/tier-c.js';
import { isVisionConfigured } from '../ai-service/groq.js';
import { extractTierCPayslip } from '../ocr-service/ocr-client.js';
import { ipRateLimit } from '../rate-limiter.js';

/**
 * BP1.5 (audit round): the PRO bridge's fate is decided as RETIRE, not migrate-and-keep-both -
 * once a frontend consumes this endpoint, `/api/payslips/analyze-full` and its
 * full-payslip.ts/ocr-client.ts's extractFullPayslip() (the pre-Tier-C interim path App.tsx's PRO
 * card currently opens, labelled "interim version" since the language-regression round) are to be
 * removed, not left running alongside this one - spec §2's own warning against two engines
 * diverging applies equally to two extraction paths.
 *
 * Stage 2 (audit "CONSOLIDATED ASSIGNMENT" round, Tier C - "wire the engine, build the panel"):
 * that retirement is done this round - full-payslip.ts, extractFullPayslip, explainFullPayslip and
 * the /analyze-full route are deleted, in the same commit as TierCFlow.tsx replacing App.tsx's old
 * PRO flow.
 */
const router = express.Router();
const aiRateLimit = ipRateLimit('tier-c-ai', 10, 300, 'deny');

/**
 * Same fetch-rates logic as tier-a.controller.ts's own fetchRates() (audit AF2's whole-row
 * completeness check, then the date-range-aware static fallback) - NOT yet promoted to one shared
 * module. Flagged as a real, small duplication in an earlier round's audit reply rather than
 * refactored here, since nothing has caught a bug from it yet (unlike periodMultiplierFor, which a
 * Tier C test DID catch drifting) - a candidate for consolidation, not an urgent one.
 */
async function fetchRates(periodType: TierCExtraction['period_type']): Promise<{ rates: PayslipComputationRates; source: 'database' | 'static' } | null> {
  const rawDbRates = await getCurrentRule<TaxRatesFile>('loonheffing_nl');
  const dbRates = rawDbRates && isCompleteTaxRatesFile(rawDbRates) ? rawDbRates : null;
  const staticRates = dbRates ? null : loadStaticTaxRatesAt(new Date());
  const taxRatesFile = dbRates ?? staticRates;
  if (!taxRatesFile) return null;
  return {
    rates: {
      loonheffing_brackets: taxRatesFile.loonheffing_brackets,
      heffingskortingen: taxRatesFile.heffingskortingen,
      period_multiplier: periodMultiplierFor(periodType ?? 'week'),
    },
    source: dbRates ? 'database' : 'static',
  };
}

// Resolves the payslip's own reference date for the minimum-wage rules-DB lookup (audit BP1 point
// 4/N4) - falls back to today only when the extraction could not read a usable period-end date.
function resolveReferenceDate(periodEndDate: string | null): Date {
  if (periodEndDate) {
    const parsed = new Date(periodEndDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

router.post('/analyze', aiRateLimit, async (req, res) => {
  // §2.6/CONVENTIONS.md: error_code + params, never a prebaked sentence - this controller had the
  // same pre-existing defect as tier-a/contract had before those were fixed; wiring this route to a
  // real frontend this round (Stage 2) is exactly when it stops being a theoretical gap.
  if (!isVisionConfigured()) {
    return res.status(503).json({ error_code: 'vision_unavailable' });
  }
  const images = Array.isArray(req.body?.images) ? (req.body.images as unknown[]) : [];
  if (images.length === 0 || images.length > 5 || !images.every((i) => typeof i === 'string')) {
    return res.status(400).json({ error_code: 'invalid_input' });
  }

  try {
    const extraction = await extractTierCPayslip(images as string[]);
    const referenceDate = resolveReferenceDate(extraction.period_end_date);
    const applicableMinimumWage = await getMinimumWageAt(referenceDate);
    const period = mapExtractionToPeriod(extraction, applicableMinimumWage);

    const fetched = await fetchRates(extraction.period_type);
    if (!fetched) {
      return res.status(503).json({ error_code: 'tax_rates_unavailable' });
    }

    const outcome = computePayslipPeriod(period, fetched.rates, true);

    // Stage 2b (audit v12, §Stage 2b): the §Stage 2a live test showed three "discrepancies" that were
    // entirely OUR extraction's own errors, presented exactly as a real employer violation would be -
    // the three-band classifier separates noise from findings BY MAGNITUDE, and a systematic
    // extraction failure also produces large residuals. This gate runs BEFORE comparePeriodToDocument
    // and, if the extraction fails its own internal-consistency checks, short-circuits to a distinct
    // response shape that never reaches a discrepancy list at all.
    const consistencyIssues = checkExtractionConsistency(extraction.payment_date, period, outcome);
    if (consistencyIssues.length > 0) {
      return res.json({
        status: 'unreliable',
        issues: consistencyIssues,
        period,
        truncated: extraction.truncated,
        redactedFields: extraction.redacted_fields,
      });
    }

    const discrepancies = comparePeriodToDocument(period, outcome);

    return res.json({
      status: 'ok',
      period,
      outcome,
      discrepancies,
      truncated: extraction.truncated,
      redactedFields: extraction.redacted_fields,
      taxRatesSource: fetched.source,
    });
  } catch (error) {
    console.error('Tier C analyze error', error);
    return res.status(502).json({ error_code: 'extraction_failed' });
  }
});

/**
 * Stage 2's "correction path": the result panel lets a user confirm or correct any `confirm`-status
 * discrepancy (Stage 1). Correcting means the user is stating a different PRINTED value than what
 * extraction read - not a new document, not a new AI call. This route re-runs the SAME
 * computation/comparison the analyze route already ran, against a period the client already has (it
 * came from THIS server moments earlier) with one `printed_*` field edited. No new extraction, no
 * AI cost - purely payslip-model.ts + discrepancy.ts, both already fully tested elsewhere.
 *
 * Minimal validation, deliberately: the only caller is our own frontend echoing back a period this
 * same endpoint (via /analyze) produced, with a single numeric field changed - not an arbitrary
 * public input shape. Full structural validation of the entire nested PayslipPeriod type is a
 * reasonable hardening item for later, not a blocker for this round's panel to function correctly.
 */
router.post('/recompute', async (req, res) => {
  const period = req.body?.period as PayslipPeriod | undefined;
  if (!period || typeof period !== 'object' || !Array.isArray(period.hour_lines) || typeof period.period_type !== 'string') {
    return res.status(400).json({ error_code: 'invalid_input' });
  }

  const fetched = await fetchRates(period.period_type as TierCExtraction['period_type']);
  if (!fetched) {
    return res.status(503).json({ error_code: 'tax_rates_unavailable' });
  }

  const outcome = computePayslipPeriod(period, fetched.rates, true);

  // Same gate as /analyze (Stage 2b): a correction to one printed_* field does not itself prove the
  // rest of the extraction is trustworthy. No payment_date travels with a bare PayslipPeriod (it is
  // extraction-only, per tier-c.ts), so the year-mismatch check simply does not re-fire here - the
  // checks that DO still apply (zero-tax, period length from the label, category, both totals
  // reconciliations) are exactly the ones a single-field correction can newly satisfy or newly break.
  const consistencyIssues = checkExtractionConsistency(null, period, outcome);
  if (consistencyIssues.length > 0) {
    return res.json({ status: 'unreliable', issues: consistencyIssues });
  }

  const discrepancies = comparePeriodToDocument(period, outcome);
  return res.json({ status: 'ok', outcome, discrepancies, taxRatesSource: fetched.source });
});

export default router;
