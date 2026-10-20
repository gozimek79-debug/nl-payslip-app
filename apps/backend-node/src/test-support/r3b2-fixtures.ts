import { found, hourLine, payslipBatch, rawPayslip } from './fact-fixtures.js';
import { mergePayslipBatches, type PayslipFactsBatch } from '../payroll-engine/document-facts.js';
import { resolvePayrollProfile, type PayrollProfile, type ProfileDocumentInput } from '../payroll-engine/payroll-profile.js';

/**
 * Test-only (R3-B.2): the synthetic week-41 payslip of the task - printed with DOT decimals, a header "Uurloon", a
 * regular wage line, a separate ADV surcharge line, net, an untaxed travel reimbursement and the transferred payout.
 * Built through the REAL reader mapping (fact-fixtures.ts). No real document, no person: the only name is
 * "Synthetic Uitzend B.V." and there is no BSN, address, account number or employee number anywhere.
 */

export const LINE_REGULAR = 'W 41 Loon normaal 36.00 x 15.55 559.80';
export const LINE_ADV = 'ADV toeslag 1.54 % 36.00 x 15.55 8.62';

export function rawPayslipWeek41(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawPayslip({
    period_label: found('week 41/2026', 'Periode: week 41/2026', 1, 'Periode'),
    period_start: found('2026-10-05', '05-10-2026', 1, 'Periode'),
    period_end: found('2026-10-11', 't/m 11-10-2026', 1, 'Periode'),
    payment_date: found('2026-10-16', '16-10-2026', 1, 'Betaaldatum'),
    period_type: found('week', 'Week 41', 1, 'Periode'),
    hourly_rate: found(15.55, 'Uurloon: 15.55', 1, 'Uurloon'),
    hour_lines: [
      hourLine({ description: 'Loon normaal', kind: 'regular', hours: 36, rate: 15.55, amount: 559.8, raw: LINE_REGULAR }),
      hourLine({ description: 'ADV toeslag', kind: 'adv_compensation', adds_hours: 'no', hours: 36, rate: 15.55, percent: 1.54, amount: 8.62, raw: LINE_ADV }),
    ],
    printed_net: found(509.92, 'Totaal netto 509.92', 1, 'Totaal netto'),
    net_lines: [{ description: 'Onb. Reiskosten', category: 'reimbursement', amount: 75, raw: 'Onb. Reiskosten 75.00', page: 1, unclear_fields: [] }],
    printed_payout: found(584.92, 'Overgemaakt 584.92', 1, 'Overgemaakt'),
    ...overrides,
  });
}

export const week41Batch = (overrides: Record<string, unknown> = {}): PayslipFactsBatch => payslipBatch(rawPayslipWeek41(overrides));

export function week41Document(overrides: Record<string, unknown> = {}, index = 0, documentId = 'r3b2-slip-41'): ProfileDocumentInput {
  return { index, documentId, label: 'payslip-41', role: 'payslip', effectiveDate: null, facts: mergePayslipBatches([week41Batch(overrides)]) };
}

export function profileOf(documents: ProfileDocumentInput[], asOfDate = '2026-10-19'): PayrollProfile {
  return resolvePayrollProfile({ asOfDate, documents });
}
