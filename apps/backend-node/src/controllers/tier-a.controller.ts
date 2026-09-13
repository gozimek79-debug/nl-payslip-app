import express from 'express';
import { z } from 'zod';
import { getCurrentRule } from '../rules-repository.js';
import { isCompleteTaxRatesFile, loadStaticTaxRatesAt, type TaxRatesFile } from '../payroll-engine/calculator.js';
import { computeTierAResult, checkTierASanity, type TierAInput } from '../payroll-engine/tier-a.js';
import { periodMultiplierFor, type PayslipComputationRates } from '../payroll-engine/payslip-model.js';

const router = express.Router();

const dayHoursSchema = z.object({
  regular_hours: z.number().min(0).max(24),
  overtime_hours: z.number().min(0).max(24),
  is_public_holiday: z.boolean(),
});

const hourGridSchema = z.object({
  mon: dayHoursSchema,
  tue: dayHoursSchema,
  wed: dayHoursSchema,
  thu: dayHoursSchema,
  fri: dayHoursSchema,
  sat: dayHoursSchema,
  sun: dayHoursSchema,
});

const surchargeLineSchema = z.object({
  description: z.string().min(1).max(200),
  hours: z.number().min(0).max(400),
  percent: z.number().min(-100).max(500),
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
  hourly_rate: z.number().min(0).max(1000),
  // CD/CX2a: one grid per week - length 1 (week) up to 5 (a long month), never zero.
  week_grids: z.array(hourGridSchema).min(1).max(5),
  overtime_tier_threshold_hours: z.number().min(0).max(24).nullable(),
  overtime_tier_1_percent: z.number().min(-100).max(500).nullable(),
  overtime_tier_2_percent: z.number().min(-100).max(500).nullable(),
  saturday_percent: z.number().min(-100).max(500).nullable(),
  sunday_percent: z.number().min(-100).max(500).nullable(),
  holiday_percent: z.number().min(-100).max(500).nullable(),
  surcharge_lines: z.array(surchargeLineSchema).max(20),
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
      period_multiplier: periodMultiplierFor(periodType),
    },
    source: dbRates ? 'database' : 'static',
  };
}

router.post('/calculate', async (req, res) => {
  // CX2d/CONVENTIONS.md: an error_code + optional params, never a prebaked sentence - the frontend
  // resolves it through translations[lang] (BN's own pattern, applied to Tier A's controller as
  // directed - CX2d supersedes BN2's earlier "defer behind Tier C" note; a failure is exactly when a
  // clear message matters most, and an English-speaking user was getting Polish prose here).
  const parsed = tierAInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error_code: 'invalid_input', details: parsed.error.flatten() });
  }
  const input = parsed.data as TierAInput;

  const fetched = await fetchRates(input.period_type);
  if (!fetched) {
    // Same "genuinely out of range" refusal as calculator.ts (audit S1) - never silently compute
    // with the wrong year's rates when neither the DB nor the static file can answer for today.
    return res.status(503).json({ error_code: 'tax_rates_unavailable' });
  }

  const result = computeTierAResult(input, fetched.rates);

  if (result.status === 'blocked') {
    // CX2a: a stated gap in the hour grid itself (unknown overtime threshold, or an unstated
    // Saturday/Sunday/holiday percent) - not a 400 (the request was well-formed) and not the engine's
    // own 'incomplete' outcome (that's about unknown deductions, a different gap). 200 with a
    // structured body the frontend renders as "we need one more thing from you", per CV3/CV4's own
    // pattern for the (separate, not-yet-built) confirmation-question mechanism.
    return res.json({ status: 'blocked', reason: result.reason, ...('days_affected' in result ? { days_affected: result.days_affected } : { categories: result.categories }) });
  }

  const warnings = checkTierASanity(result.outcome, input);

  return res.json({
    status: 'computed',
    period: result.period,
    outcome: result.outcome,
    sector_premium_estimate: result.sector_premium_estimate ?? null,
    net_range: result.net_range ?? null,
    payout_range: result.payout_range ?? null,
    warnings,
    taxRatesSource: fetched.source,
  });
});

export default router;
