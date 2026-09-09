import express from 'express';
import { z } from 'zod';
import { PayrollCalculator } from '../payroll-engine/calculator.js';
import { explainCalculatorResult } from '../ai-service/ai-client.js';
import { isGroqConfigured } from '../ai-service/groq.js';
import { ipRateLimit } from '../rate-limiter.js';

const router = express.Router();
const calculator = new PayrollCalculator();
const aiRateLimit = ipRateLimit('calculator-ai', 10, 300);

const hoursSchema = z.object({
  normal: z.number().min(0).max(400),
  saturday: z.number().min(0).max(400),
  sunday: z.number().min(0).max(400),
  holiday: z.number().min(0).max(400),
  night: z.number().min(0).max(400),
});

const overtimeTierSchema = z.object({
  hours: z.number().min(0).max(200),
  multiplier: z.number().min(1).max(3),
});

const advancedSchema = z.object({
  enabled: z.boolean(),
  pensionMode: z.enum(['none', 'percent', 'stipp']).default('none'),
  pensionPremiumPercent: z.number().min(0).max(100),
  pawwPercent: z.number().min(0).max(100),
  sicknessInsurancePercent: z.number().min(0).max(100),
  wgaPremiumPercent: z.number().min(0).max(100),
  travelAllowance: z.number().min(0).max(100_000),
  otherDeductions: z.number().min(0).max(100_000),
  applyBijzonderTarief: z.boolean(),
});

const calculateSchema = z.object({
  periodType: z.enum(['week', '4-wekelijks', 'maand']),
  baseHourlyRate: z.number().min(0).max(1000),
  hours: hoursSchema,
  toeslagPercentages: z.object({
    saturday: z.number().min(0).max(300),
    sunday: z.number().min(0).max(300),
    holiday: z.number().min(0).max(300),
    night: z.number().min(0).max(300),
  }),
  overtime: z.object({ tier1: overtimeTierSchema, tier2: overtimeTierSchema }),
  includeVakantiegeld: z.boolean(),
  applyThirtyPercentRuling: z.boolean(),
  applyLoonheffingskorting: z.boolean(),
  advanced: advancedSchema,
});

router.post('/calculate', async (req, res) => {
  const parsed = calculateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Nieprawidłowe dane wejściowe.', details: parsed.error.flatten() });
  }
  const result = await calculator.calculate(parsed.data);
  return res.json(result);
});

const explainSchema = calculateSchema.extend({ language: z.enum(['pl', 'en']).optional() });

router.post('/explain', aiRateLimit, async (req, res) => {
  if (!isGroqConfigured()) {
    return res.status(503).json({ error: 'Interpretacja AI nie jest skonfigurowana (brak GROQ_API_KEY).' });
  }
  const parsed = explainSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Nieprawidłowe dane wejściowe.', details: parsed.error.flatten() });
  }
  const { language, ...calculatorInput } = parsed.data;
  const result = await calculator.calculate(calculatorInput);
  try {
    const explanation = await explainCalculatorResult(calculatorInput, result, language ?? 'pl');
    return res.json({ explanation });
  } catch (error) {
    console.error('Groq explain error', error);
    return res.status(502).json({ error: 'Nie udało się uzyskać interpretacji AI. Spróbuj ponownie.' });
  }
});

export default router;
