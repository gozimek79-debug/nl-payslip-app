import type { PayslipPeriod, PayslipComputationOutcome } from './payslip-model.js';
import type { Discrepancy } from './discrepancy.js';
import { matchesPii } from '../ocr-service/pii-patterns.js';

/**
 * Stage 2c (audit "CONSOLIDATED ASSIGNMENT" v15): the boundary between what the READING model sees
 * (a document image, read in the EU by Mistral) and what an eventual ANALYSIS model sees (Gemini,
 * US-hosted, per the owner's split - reading vs interpretation are different tasks with different
 * demands, so different models; see document-vision-provider.ts). Gemini must never receive a
 * document image, and never a name, address, date of birth, IBAN or employee number - only extracted
 * figures and line names.
 *
 * Mirrors the three-layer protection already built for contracts (ai-client.ts's explainContract):
 * (1) the extraction schema itself never captures identity fields - PayslipPeriod/TierCExtraction
 * have no name/address/DOB/IBAN field to leak in the first place (payslip-model.ts, tier-c.ts);
 * (2) pii-patterns.ts's regex net already ran once at extraction time, nulling any free-text field
 * that matched a BSN/IBAN/email/phone pattern; (3) here - the actual boundary before anything leaves
 * the EU. Payslips need a THIRD layer contracts don't: PayslipPeriod's free-text surface (potentially
 * dozens of hour_line/deduction descriptions across two employers) is far larger than a contract's
 * handful of fields, so this builds an explicit ALLOWLIST of what crosses the boundary rather than
 * forwarding the object wholesale - and re-runs the same regex net independently, right here, rather
 * than trusting a check that already ran once upstream. A name or address is NOT something either
 * regex net can catch (there is no reliable pattern for "a person's name") - that residual risk is
 * real and is not something this layer can close; it is bounded instead by never sending anything
 * beyond a line's category/label/amount, and by the schema never capturing identity fields at all.
 *
 * No analysis module calls this yet - Modules 2/3 (spec §3c) have not been built. This exists so the
 * boundary is decided, typed and tested BEFORE that code exists, per the owner's explicit
 * instruction. A future Gemini-calling function should accept ONLY a PayslipAnalysisPayload, never a
 * raw PayslipPeriod - so the type system, not a reviewer's memory, enforces the boundary.
 */
export interface PayslipAnalysisLine {
  category: string;
  /** As-printed label / description, already passed through pii-patterns.ts once at extraction and
   * again here - never a name, only a payslip line's own terminology. */
  label: string;
  amount: number | null;
  provenance: string;
}

export interface PayslipAnalysisPayload {
  period_label: string | null;
  period_type: PayslipPeriod['period_type'];
  /** Business names only (the employer/hirer companies) - never the employee's own identity, which
   * PayslipPeriod has no field for to begin with. */
  employers: string[];
  hirer: string | null;
  hour_lines: PayslipAnalysisLine[];
  pre_tax_deductions: PayslipAnalysisLine[];
  post_tax_social: PayslipAnalysisLine[];
  net_additions: PayslipAnalysisLine[];
  net_deductions: PayslipAnalysisLine[];
  reservations: Array<{ type: string; accrued: number; paid_out: number }>;
  outcome: {
    status: PayslipComputationOutcome['status'];
    gross_total: number;
    taxable_base: number;
    table_tax_after_korting: number;
    bt_tax: number;
    total_tax: number;
    wage_net: number | null;
    payout_amount: number | null;
  };
  discrepancies: Array<{ code: Discrepancy['code']; status: Discrepancy['status']; residual: number | null }>;
}

/** Second, independent pass of the same regex net pii-patterns.ts applies at extraction time - never
 * assumed to have already been done correctly upstream. Returns '' (not the original text) on a
 * match, and records which line, so a caller can log/report it exactly like extraction's own
 * redactedFields already does. */
function safeLabel(text: string, fieldName: string, redacted: string[]): string {
  if (!text) return '';
  if (matchesPii(text)) {
    redacted.push(fieldName);
    return '';
  }
  return text;
}

export function buildPayslipAnalysisPayload(
  period: PayslipPeriod,
  outcome: PayslipComputationOutcome,
  discrepancies: Discrepancy[],
): { payload: PayslipAnalysisPayload; redactedFields: string[] } {
  const redacted: string[] = [];

  const mapLines = (
    lines: Array<{ description: string; amount: number | { value: number | null; provenance: string }; category: string }>,
    keyPrefix: string,
  ): PayslipAnalysisLine[] =>
    lines.map((l, i) => {
      const isField = typeof l.amount === 'object';
      return {
        category: l.category,
        label: safeLabel(l.description, `${keyPrefix}[${i}].description`, redacted),
        amount: isField ? (l.amount as { value: number | null }).value : (l.amount as number),
        provenance: isField ? (l.amount as { provenance: string }).provenance : 'payslip_extracted',
      };
    });

  const outcomeSummary: PayslipAnalysisPayload['outcome'] =
    outcome.status === 'complete'
      ? {
          status: 'complete',
          gross_total: outcome.result.gross_total,
          taxable_base: outcome.result.taxable_base,
          table_tax_after_korting: outcome.result.table_tax_after_korting,
          bt_tax: outcome.result.bt_tax,
          total_tax: outcome.result.total_tax,
          wage_net: outcome.result.wage_net,
          payout_amount: outcome.result.payout_amount,
        }
      : {
          status: 'incomplete',
          gross_total: outcome.gross_total,
          taxable_base: outcome.taxable_base,
          table_tax_after_korting: outcome.table_tax_after_korting,
          bt_tax: outcome.bt_tax,
          total_tax: outcome.total_tax,
          wage_net: null,
          payout_amount: null,
        };

  const payload: PayslipAnalysisPayload = {
    period_label: period.period_label,
    period_type: period.period_type,
    employers: period.employers.map((e) => e.name).filter((n): n is string => !!n),
    hirer: period.hirer?.name ?? null,
    hour_lines: mapLines(period.hour_lines, 'hour_lines'),
    pre_tax_deductions: mapLines(period.pre_tax_deductions, 'pre_tax_deductions'),
    post_tax_social: mapLines(period.post_tax_social, 'post_tax_social'),
    net_additions: mapLines(period.net_additions, 'net_additions'),
    net_deductions: mapLines(period.net_deductions, 'net_deductions'),
    reservations: period.reservations.map((r) => ({ type: r.type, accrued: r.opgebouwd_this_period, paid_out: r.paid_out_this_period })),
    outcome: outcomeSummary,
    discrepancies: discrepancies.map((d) => ({ code: d.code, status: d.status, residual: d.residual })),
  };

  return { payload, redactedFields: redacted };
}
