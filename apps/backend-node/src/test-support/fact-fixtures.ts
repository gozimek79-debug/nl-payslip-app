import { mapPayslipFactsResponse, mapContractFactsResponse } from '../ocr-service/fact-extraction.js';
import type { PayslipFactsBatch, ContractFactsBatch } from '../payroll-engine/document-facts.js';

/**
 * Test-only (P2): synthetic reader responses in the exact JSON shape the Gemini fact schemas ask for,
 * turned into batches through the REAL production mapping (`map*FactsResponse`) - so tests exercise the
 * same normalisation and sense checks a live read goes through. No real document, no owner data.
 */

export type RawScalar = { status: string; value: string | number | null; raw: string | null; page: number | null; label: string | null };

export const absent: RawScalar = { status: 'absent', value: null, raw: null, page: null, label: null };

export function found(value: string | number, raw: string, page: number | null = 1, label: string | null = null): RawScalar {
  return { status: 'found', value, raw, page, label };
}

export function ambiguous(raw: string | null, page: number | null = 1, label: string | null = null): RawScalar {
  return { status: 'ambiguous', value: null, raw, page, label };
}

const PAYSLIP_SCALARS = [
  'period_label', 'period_start', 'period_end', 'payment_date', 'period_type', 'hirer_name', 'hours_per_week',
  'bijzonder_tarief_percent', 'jaarloon_bt', 'et_exchange_amount', 'minimum_wage_printed', 'printed_table_tax',
  'printed_bt_tax', 'printed_algemene_heffingskorting', 'printed_arbeidskorting', 'printed_gross_total',
  'printed_loon_voor_heffingen', 'printed_taxable_base_normal', 'printed_taxable_base_special', 'printed_net', 'printed_payout',
];

const CONTRACT_SCALARS = [
  'employer_name', 'hirer_name', 'contract_type', 'function_title', 'cao_name', 'cao_phase', 'pension_fund', 'start_date',
  'end_date', 'effective_date', 'hourly_rate', 'monthly_salary', 'hours_per_week', 'guaranteed_hours',
  'guaranteed_hours_period_weeks', 'overtime_threshold_hours',
];

export function hourLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: 'Uren normaal', kind: 'regular', adds_hours: 'yes', tax_treatment: 'table', employer_index: 0,
    hours: 40, rate: 16.2, percent: null, amount: 648, explicit_tier: null, tier_wording: null,
    raw: 'Uren normaal 40,00 16,20 648,00', page: 1, unclear_fields: [], ...overrides,
  };
}

export function overtimeLine(percent: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const amount = Math.round(4 * 16.2 * percent) / 100;
  return hourLine({
    description: `Overwerk ${percent}%`, kind: 'overtime', hours: 4, rate: 16.2, percent, amount,
    raw: `Overwerk ${percent}% 4,00 16,20 ${amount.toFixed(2).replace('.', ',')}`, ...overrides,
  });
}

/** A clean one-page weekly payslip reading with regular hours; override any key. */
export function rawPayslip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = Object.fromEntries(PAYSLIP_SCALARS.map((k) => [k, absent]));
  return {
    ...base,
    period_label: found('week 10/2026', 'Periode: week 10/2026', 1, 'Periode'),
    period_end: found('2026-03-08', 't/m 08-03-2026', 1, 'Periode'),
    payment_date: found('2026-03-13', '13-03-2026', 1, 'Betaaldatum'),
    period_type: found('week', 'Week 10', 1, 'Periode'),
    employer_names: [found('Synthetic Uitzend B.V.', 'Synthetic Uitzend B.V.', 1, 'Werkgever')],
    hour_lines: [hourLine()],
    deduction_lines: [],
    net_lines: [],
    et_reimbursement_lines: [],
    payout_adjustment_lines: [],
    reservation_lines: [],
    ...overrides,
  };
}

/** A clean one-page base contract reading; override any key. */
export function rawContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = Object.fromEntries(CONTRACT_SCALARS.map((k) => [k, absent]));
  return { ...base, premiums: [], ...overrides };
}

export function payslipBatch(raw: Record<string, unknown> = rawPayslip(), pages: number[] = [1], totalPages = pages.length): PayslipFactsBatch {
  return mapPayslipFactsResponse(raw, pages, totalPages);
}

export function contractBatch(raw: Record<string, unknown> = rawContract(), pages: number[] = [1], totalPages = pages.length): ContractFactsBatch {
  return mapContractFactsResponse(raw, pages, totalPages);
}
