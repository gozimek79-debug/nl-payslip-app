import express from 'express';
import { z } from 'zod';
import { getCurrentRule } from '../rules-repository.js';
import { isCompleteTaxRatesFile, loadStaticTaxRatesAt, type TaxRatesFile } from '../payroll-engine/calculator.js';
import { computeTierAResult, checkTierASanity, type TierAInput } from '../payroll-engine/tier-a.js';
import type { PayslipComputationRates } from '../payroll-engine/payslip-model.js';

const router = express.Router();

/** Tier A per-period multiplier, distinct from calculator.ts's own PERIOD_MULTIPLIERS map because
 * Tier A's period_type uses spec's own labels ('week'/'4-weekly'/'month'), not calculator.ts's Dutch
 * ones ('week'/'4-wekelijks'/'maand') - kept as two separate literal unions rather than forcing one
 * tier's vocabulary onto the other. */
const TIER_A_PERIOD_MULTIPLIERS: Record<TierAInput['period_type'], number> = {
  week: 52,
  '4-weekly': 13,
  month: 12,
};

const overtimeLineSchema = z.object({
  description: z.string().min(1).max(200),
  hours: z.number().min(0).max(400),
  percent: z.number().min(-100).max(500),
  adds_hours: z.boolean(),
});

const vakantiegeldSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({ mode: z.literal('accruing'), percent: z.number().min(0).max(50) }),
  z.object({ mode: z.literal('paid_now'), percent: z.number().min(0).max(50) }),
]);

const deductionsSchema = z.object({
  mode: z.enum(['enter', 'estimate', 'skip']),
  entered: z
    .object({
      pension: z.number().min(0).max(100_000).optional(),
      paww: z.number().min(0).max(100_000).optional(),
      sector_premium: z.number().min(0).max(100_000).optional(),
      post_tax_other: z.number().min(0).max(100_000).optional(),
    })
    .optional(),
});

const tierAInputSchema = z.object({
  period_type: z.enum(['week', '4-weekly', 'month']),
  hours_worked: z.number().min(0).max(744), // 744h = every hour in a 31-day month, a generous upper bound
  hourly_rate: z.number().min(0).max(1000),
  overtime_lines: z.array(overtimeLineSchema).max(20),
  apply_loonheffingskorting: z.boolean(),
  travel_allowance: z.number().min(0).max(100_000),
  vakantiegeld: vakantiegeldSchema,
  deductions: deductionsSchema,
});

/**
 * Fetches tax rates the exact same way calculator.ts's own calculate() does (audit AF2's whole-row
 * completeness check, then a date-range-aware static-file fallback) - reusing those exported
 * functions rather than a second, divergent copy of the fetch logic (spec §2's own warning: two
 * copies of the same fetch is exactly how calculator.ts and payslip-model.ts diverged once, which
 * AO2 then had to repair).
 */
async function fetchRates(periodType: TierAInput['period_type']): Promise<{ rates: PayslipComputationRates; source: 'database' | 'static' } | null> {
  const rawDbRates = await getCurrentRule<TaxRatesFile>('loonheffing_nl');
  const dbRates = rawDbRates && isCompleteTaxRatesFile(rawDbRates) ? rawDbRates : null;
  const staticRates = dbRates ? null : loadStaticTaxRatesAt(new Date());
  const taxRatesFile = dbRates ?? staticRates;
  if (!taxRatesFile) return null;
  return {
    rates: {
      loonheffing_brackets: taxRatesFile.loonheffing_brackets,
      heffingskortingen: taxRatesFile.heffingskortingen,
      period_multiplier: TIER_A_PERIOD_MULTIPLIERS[periodType],
    },
    source: dbRates ? 'database' : 'static',
  };
}

router.post('/calculate', async (req, res) => {
  const parsed = tierAInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Nieprawidłowe dane wejściowe.', details: parsed.error.flatten() });
  }
  const input = parsed.data as TierAInput;

  const fetched = await fetchRates(input.period_type);
  if (!fetched) {
    // Same "genuinely out of range" refusal as calculator.ts (audit S1) - never silently compute
    // with the wrong year's rates when neither the DB nor the static file can answer for today.
    return res.status(503).json({ error: 'Brak dostępnych stawek podatkowych dla bieżącej daty (baza niedostępna, a plik statyczny jej nie obejmuje).' });
  }

  const tierAResult = computeTierAResult(input, fetched.rates);
  const warnings = checkTierASanity(tierAResult.outcome, input);

  return res.json({
    period: tierAResult.period,
    outcome: tierAResult.outcome,
    sector_premium_estimate: tierAResult.sector_premium_estimate ?? null,
    net_range: tierAResult.net_range ?? null,
    payout_range: tierAResult.payout_range ?? null,
    warnings,
    taxRatesSource: fetched.source,
  });
});

export default router;
