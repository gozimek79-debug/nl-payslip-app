import express from 'express';
import { getCurrentRule, getMinimumWageAt } from '../rules-repository.js';
import { isCompleteTaxRatesFile, loadStaticTaxRatesAt, type TaxRatesFile } from '../payroll-engine/calculator.js';
import { computePayslipPeriod, periodMultiplierFor, type PayslipComputationRates } from '../payroll-engine/payslip-model.js';
import { comparePeriodToDocument } from '../payroll-engine/discrepancy.js';
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
 * diverging applies equally to two extraction paths. This round ships the backend
 * (mapping/computation/discrepancy, fully tested against all four reference fixtures) and this
 * route; wiring App.tsx's PRO card to call it, and then deleting the old path, is the next round's
 * first task - not left implicit, stated here so the decision survives past this round's own report.
 */
const router = express.Router();
const aiRateLimit = ipRateLimit('tier-c-ai', 10, 300, 'deny');

/**
 * Same fetch-rates logic as tier-a.controller.ts's own fetchRates() (audit AF2's whole-row
 * completeness check, then the date-range-aware static fallback) - NOT yet promoted to one shared
 * module. Flagged as a real, small duplication in this round's audit reply rather than refactored
 * here, since nothing has caught a bug from it yet (unlike periodMultiplierFor, which a Tier C test
 * in this same round DID catch drifting) - a candidate for consolidation, not an urgent one.
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
  if (!isVisionConfigured()) {
    return res.status(503).json({ error: 'Pełna analiza AI jest chwilowo niedostępna (brak modelu wizyjnego u dostawcy).' });
  }
  const images = Array.isArray(req.body?.images) ? (req.body.images as unknown[]) : [];
  if (images.length === 0 || images.length > 5 || !images.every((i) => typeof i === 'string')) {
    return res.status(400).json({ error: 'Nieprawidłowe dane obrazu.' });
  }

  try {
    const extraction = await extractTierCPayslip(images as string[]);
    const referenceDate = resolveReferenceDate(extraction.period_end_date);
    const applicableMinimumWage = await getMinimumWageAt(referenceDate);
    const period = mapExtractionToPeriod(extraction, applicableMinimumWage);

    const fetched = await fetchRates(extraction.period_type);
    if (!fetched) {
      return res.status(503).json({ error: 'Brak dostępnych stawek podatkowych dla bieżącej daty (baza niedostępna, a plik statyczny jej nie obejmuje).' });
    }

    const outcome = computePayslipPeriod(period, fetched.rates, true);
    const discrepancies = comparePeriodToDocument(period, outcome);

    return res.json({
      period,
      outcome,
      discrepancies,
      truncated: extraction.truncated,
      redactedFields: extraction.redacted_fields,
      taxRatesSource: fetched.source,
    });
  } catch (error) {
    console.error('Tier C analyze error', error);
    return res.status(502).json({ error: 'Nie udało się odczytać dokumentu przez AI. Spróbuj ponownie.' });
  }
});

export default router;
