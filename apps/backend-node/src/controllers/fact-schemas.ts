import { z } from 'zod';
import {
  PAYSLIP_SCALAR_KEYS, CONTRACT_SCALAR_KEYS,
  type PayslipFactsBatch, type ContractFactsBatch, type PayslipScalarKey, type ContractScalarKey,
} from '../payroll-engine/document-facts.js';

/**
 * P2: shape validation for document-fact batches echoed back by the client (to /api/pro/payslip-replay
 * and /api/profile/resolve). The batches were produced by this server's own mapping moments earlier;
 * the client is still untrusted, so every echo is checked against the exact typed shape and capped.
 */

const MAX_TEXT = 2000;
const text = z.string().max(MAX_TEXT);
const nullableText = text.nullable();
const page = z.number().int().min(1).max(1000);

const reasonCode = z.enum([
  'reader_marked_ambiguous', 'raw_value_mismatch', 'value_not_normalizable', 'unrecognized_code', 'invalid_date', 'out_of_range',
  'exceeds_physical_hours_per_week', 'exceeds_plausible_hourly_rate', 'exceeds_legal_hours_per_week', 'exceeds_daily_hours',
  'percent_out_of_range', 'percent_unit_confusion', 'same_document_contradiction', 'pii_redacted',
]);

const evidence = z.object({ page: page.nullable(), line: z.null(), printedLabel: nullableText, rawValue: nullableText });

const fact = z.object({
  key: z.string().max(100),
  unit: z.enum(['text', 'date', 'period_type', 'eur_per_hour', 'eur_per_month', 'eur_per_year', 'eur_per_period', 'hours_per_week', 'hours', 'weeks', 'percent']),
  value: z.union([z.number().finite(), text]).nullable(),
  status: z.enum(['exact', 'ambiguous', 'absent', 'implausible']),
  reason: reasonCode.nullable(),
  evidence,
});

const lineIssue = z.object({
  field: z.enum(['hours', 'rate', 'percent', 'amount', 'base', 'accrued', 'paidOut']),
  status: z.enum(['ambiguous', 'implausible']),
  reason: reasonCode,
});

const maybeNumber = z.number().finite().nullable();

const hourLine = z.object({
  kind: z.enum(['regular', 'irregular_surcharge', 'overtime', 'adv_compensation', 'other']),
  addsHours: z.boolean().nullable(),
  taxTreatment: z.enum(['table', 'bt', 'unknown']),
  employerIndex: z.number().int().min(0).max(20),
  hours: maybeNumber, rate: maybeNumber, percent: maybeNumber, amount: maybeNumber,
  explicitTier: z.union([z.literal(1), z.literal(2)]).nullable(),
  tierWording: nullableText,
  issues: z.array(lineIssue).max(10),
  evidence,
});

const deductionLine = z.object({
  placement: z.enum(['pre_tax', 'post_tax']),
  category: z.enum(['pension', 'paww', 'ziektewet', 'wga_gat', 'wga', 'gediff_wga', 'whk', 'other']),
  percent: maybeNumber, base: maybeNumber, amount: maybeNumber,
  issues: z.array(lineIssue).max(10),
  evidence,
});

const netLine = z.object({
  category: z.enum(['reimbursement', 'loan', 'housing', 'transport', 'health_insurance', 'union', 'other']),
  amount: maybeNumber,
  issues: z.array(lineIssue).max(10),
  evidence,
});

const amountLine = z.object({ amount: maybeNumber, issues: z.array(lineIssue).max(10), evidence });

const reservationLine = z.object({
  type: z.enum(['vakantiegeld', 'vakantiedagen', 'vakantiedagen_bovenwettelijk', 'verlofuren', 'other']),
  accrued: maybeNumber, paidOut: maybeNumber,
  issues: z.array(lineIssue).max(10),
  evidence,
});

const MAX_LINES = 200;
const MAX_OCCURRENCES = 50;

function scalarsSchema<K extends string>(keys: readonly K[]) {
  return z.object(Object.fromEntries(keys.map((k) => [k, z.array(fact).max(MAX_OCCURRENCES)])) as Record<K, z.ZodArray<typeof fact>>);
}

const batchPages = z.array(page).min(1).max(60);

export const payslipFactsBatchSchema = z.object({
  kind: z.literal('payslip'),
  pages: batchPages,
  totalPages: page,
  scalars: scalarsSchema<PayslipScalarKey>(PAYSLIP_SCALAR_KEYS),
  employerNames: z.array(fact).max(MAX_OCCURRENCES),
  hourLines: z.array(hourLine).max(MAX_LINES),
  deductionLines: z.array(deductionLine).max(MAX_LINES),
  netLines: z.array(netLine).max(MAX_LINES),
  etReimbursementLines: z.array(amountLine).max(MAX_LINES),
  payoutAdjustmentLines: z.array(amountLine).max(MAX_LINES),
  reservationLines: z.array(reservationLine).max(MAX_LINES),
  redactedFields: z.array(z.string().max(200)).max(500),
});

const premium = z.object({
  category: z.enum(['overtime', 'irregular_hours', 'saturday', 'sunday', 'public_holiday', 'other']),
  percent: maybeNumber,
  semantics: z.enum(['total_multiplier', 'premium_above_base', 'unclear']),
  explicitTier: z.union([z.literal(1), z.literal(2)]).nullable(),
  tierWording: nullableText,
  condition: nullableText,
  status: z.enum(['exact', 'ambiguous', 'absent', 'implausible']),
  reason: reasonCode.nullable(),
  evidence,
});

export const contractFactsBatchSchema = z.object({
  kind: z.literal('contract'),
  pages: batchPages,
  totalPages: page,
  scalars: scalarsSchema<ContractScalarKey>(CONTRACT_SCALAR_KEYS),
  premiums: z.array(premium).max(MAX_LINES),
  redactedFields: z.array(z.string().max(200)).max(500),
});

/** Batches of ONE document: all of one kind, consistent page counts, no page read twice. */
export function consistentBatches(batches: Array<{ pages: number[]; totalPages: number }>): boolean {
  if (batches.length === 0) return false;
  const total = batches[0]?.totalPages;
  const seen = new Set<number>();
  for (const b of batches) {
    if (b.totalPages !== total) return false;
    for (const p of b.pages) {
      if (p > b.totalPages || seen.has(p)) return false;
      seen.add(p);
    }
  }
  return true;
}

export const MAX_BATCHES_PER_DOCUMENT = 20;

export function parsePayslipBatches(value: unknown): PayslipFactsBatch[] | null {
  const parsed = z.array(payslipFactsBatchSchema).min(1).max(MAX_BATCHES_PER_DOCUMENT).safeParse(value);
  if (!parsed.success || !consistentBatches(parsed.data)) return null;
  return parsed.data as PayslipFactsBatch[];
}

export function parseContractBatches(value: unknown): ContractFactsBatch[] | null {
  const parsed = z.array(contractFactsBatchSchema).min(1).max(MAX_BATCHES_PER_DOCUMENT).safeParse(value);
  if (!parsed.success || !consistentBatches(parsed.data)) return null;
  return parsed.data as ContractFactsBatch[];
}
