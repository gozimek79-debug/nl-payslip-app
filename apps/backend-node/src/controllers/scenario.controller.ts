import express from 'express';
import { z } from 'zod';
import { fetchRates } from './tier-a.controller.js';
import { SCENARIO_VALUE_SOURCES } from '../scenario/scenario-types.js';
import { evaluateScenario } from '../scenario/scenario-evaluate.js';
import { compareEvaluations } from '../scenario/scenario-compare.js';

/**
 * R1 backend boundary: `POST /api/scenario/evaluate` - deterministic Scenario Core only. No LLM, no
 * Gemini, no raw document, no persistence, no session state. The request carries a Scenario V1 (and
 * optionally a second one to compare); the response is the Scenario Evaluation Result (+ comparison).
 *
 * The schema below checks SHAPE only (types / required keys) so a malformed request is a 400. Domain
 * problems with well-formed data - a negative number of hours, an impossible percentage, an unresolved
 * conflict - are NOT 400s: they are returned as `status: 'invalid' | 'blocked' | 'unsupported'` with
 * structured codes by the Scenario Core (the single place that decides them).
 */

const router = express.Router();

const origin = { source: z.enum(SCENARIO_VALUE_SOURCES), ref: z.string().max(200).optional() };

const knownOf = <T extends z.ZodType>(value: T) => z.strictObject({ state: z.literal('known'), value, ...origin });
const unknownValue = z.strictObject({ state: z.literal('unknown') });
const conflictOf = <T extends z.ZodType>(value: T) =>
  z.strictObject({ state: z.literal('conflict'), candidates: z.array(z.strictObject({ value, ...origin })).max(10) });

const numberValue = z.discriminatedUnion('state', [
  knownOf(z.number()),
  z.strictObject({ state: z.literal('range'), low: z.number(), high: z.number(), ...origin }),
  conflictOf(z.number()),
  unknownValue,
]);

function choiceValue<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('state', [
    knownOf(value),
    z.strictObject({ state: z.literal('alternatives'), options: z.array(value).max(10), ...origin }),
    conflictOf(value),
    unknownValue,
  ]);
}

const distribution = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('even'), days: z.number() }),
  z.strictObject({ kind: z.literal('explicit'), byDay: z.strictObject({ mon: z.number(), tue: z.number(), wed: z.number(), thu: z.number(), fri: z.number() }) }),
]);

const scenarioSchema = z.strictObject({
  schemaVersion: z.number(),
  scenarioId: z.string().max(200),
  label: z.string().max(200).optional(),
  periodType: z.string().max(40),
  work: z.strictObject({
    regularWeekdayHours: numberValue.optional(),
    overtimeHours: numberValue.optional(),
    overtimeDistribution: choiceValue(distribution).optional(),
    saturdayHours: numberValue.optional(),
    sundayHours: numberValue.optional(),
    publicHolidayHours: numberValue.optional(),
  }),
  pay: z.strictObject({
    hourlyRate: numberValue.optional(),
    saturdayPremiumPercent: numberValue.optional(),
    sundayPremiumPercent: numberValue.optional(),
    publicHolidayPremiumPercent: numberValue.optional(),
    overtime: z
      .strictObject({ thresholdHoursPerDay: numberValue.optional(), tier1Percent: numberValue.optional(), tier2Percent: numberValue.optional() })
      .optional(),
  }),
  tax: z.strictObject({ loonheffingskorting: choiceValue(z.string().max(40)).optional() }),
  deductions: z
    .strictObject({
      mode: choiceValue(z.string().max(40)).optional(),
      entered: z
        .strictObject({ pension: numberValue.optional(), paww: numberValue.optional(), sectorPremium: numberValue.optional(), postTaxOther: numberValue.optional() })
        .optional(),
    })
    .optional(),
  extras: z
    .strictObject({
      travelAllowance: numberValue.optional(),
      vakantiegeld: z.strictObject({ mode: choiceValue(z.string().max(40)).optional(), percent: numberValue.optional() }).optional(),
    })
    .optional(),
  requestedConcepts: z.array(z.strictObject({ concept: z.string().max(80), ...origin })).max(20).optional(),
});

const requestSchema = z.strictObject({
  scenario: scenarioSchema,
  /** Optional second Scenario V1 - at most two variants in R1. */
  compareTo: scenarioSchema.optional(),
});

router.post('/evaluate', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error_code: 'invalid_input', details: parsed.error.flatten() });
  }

  const fetched = await fetchRates('week');
  if (!fetched) {
    return res.status(503).json({ error_code: 'tax_rates_unavailable' });
  }

  const evaluation = evaluateScenario(parsed.data.scenario, fetched.rates);
  const comparison = parsed.data.compareTo ? compareEvaluations(evaluation, evaluateScenario(parsed.data.compareTo, fetched.rates)) : undefined;

  return res.json({ evaluation, ...(comparison ? { comparison } : {}), taxRatesSource: fetched.source });
});

export default router;
