export interface PayslipLineItem {
  section: string;
  description: string;
  quantity: number | null;
  rate: number | null;
  payment: number | null;
  deduction: number | null;
}

export interface FullPayslipExtraction {
  period: string | null;
  /** ISO date (YYYY-MM-DD) for the last day of the period, inferred by the AI from the period
   * label - used to pick the statutory minimum wage that actually applied on that date (audit N4),
   * since the printed period label alone ("week 36", "2026-8") isn't a date the rules DB can use. */
  periodEndDate: string | null;
  hourlyRate: number | null;
  /** Minimum wage as PRINTED on the document - informational only. Audit N4: a real payslip can
   * print a stale figure (e.g. the January rate still showing in a September payslip); comparing
   * the employee's rate against this instead of the statutory rate for the period would clear an
   * underpaid employee as compliant. Never used for the actual violation check - see
   * `minimumWageApplicable` in FullPayslipValidation, resolved from the rules DB by the caller. */
  minimumWage: number | null;
  hoursPerWeek: number | null;
  contractType: string | null;
  thirtyPercentRuling: boolean;
  lineItems: PayslipLineItem[];
  reportedTotalGross: number | null;
  reportedTotalNet: number | null;
  reportedNetPaid: number | null;
  /** true, gdy odpowiedź modelu została obcięta przez limit tokenów i mogła pominąć pozycje. */
  truncated: boolean;
  /** Line-item text fields (section/description) blanked by the server-side regex safety net
   * because they matched a BSN/IBAN/email/phone pattern - audit R7/J3. Mirrors the same mechanism
   * already used on the contract path (contract-client.ts's sanitizeText); the payslip extraction
   * schema never asks for employee name/address in the first place (no such fields exist here), but
   * free-text line descriptions have no schema-level protection, so this is the only safety net for
   * those specifically. Format: "lineItems[<index>].description" or "...section". */
  redactedFields: string[];
}

export interface FullPayslipValidation {
  totalPayments: number;
  totalDeductions: number;
  computedNet: number;
  reportedNet: number | null;
  variance: number | null;
  isConsistent: boolean;
  wmlViolation: boolean;
  /** The statutory minimum wage actually applied for the check, resolved by the caller from the
   * rules DB for the payslip's period (audit N4) - never the value printed on the document. */
  minimumWageApplicable: number | null;
  /** Set only when the document's printed minimum-wage figure differs from minimumWageApplicable.
   * Informational - a mismatch here is a staleness signal about the payslip's own printout, never
   * itself a violation and never mixed into `discrepancies`. */
  minimumWageNote: string | null;
  discrepancies: string[];
  incomplete: boolean;
}

const OVERTIME_PATTERN = /(\d+(?:[.,]\d+)?)\s*%/;

function round(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * `applicableMinimumWage` must come from the rules DB for the payslip's own period (audit N4) -
 * never from `extraction.minimumWage`, which is whatever figure happens to be printed on the
 * document and can be stale (a payslip issued after a 1 January/1 July WML increase sometimes
 * still shows the old rate, confirmed on a real September 2026 payslip printing the January value).
 */
export function validateFullPayslip(extraction: FullPayslipExtraction, applicableMinimumWage: number | null): FullPayslipValidation {
  const discrepancies: string[] = [];
  let hasHardIssue = false;

  const totalPayments = round(extraction.lineItems.reduce((sum, item) => sum + (item.payment ?? 0), 0));
  const totalDeductions = round(extraction.lineItems.reduce((sum, item) => sum + (item.deduction ?? 0), 0));
  const computedNet = round(totalPayments - totalDeductions);

  // Three-tier tolerance (audit N2), calibrated against the Olympia and Randstad reference
  // payslips: reconstructing Belastingdienst's stepwise period tax tables from an annual model
  // reproduces the printed tax to within ~0.21-0.35 EUR/week, which is expected table-rounding
  // noise, not a discrepancy. A flat cutoff either flags that noise (too tight) or hides a real
  // multi-euro mismatch (too loose) - this doesn't try to pick one number for both.
  const NET_MATCH_EUR = 1;
  const NET_REVIEW_EUR = 10;

  const reportedNet = extraction.reportedTotalNet ?? extraction.reportedNetPaid ?? null;
  let variance: number | null = null;
  if (reportedNet !== null) {
    variance = round(computedNet - reportedNet);
    const absVariance = Math.abs(variance);
    if (absVariance <= NET_MATCH_EUR) {
      // Within table-rounding noise - not worth a discrepancy line at all.
    } else if (extraction.truncated) {
      discrepancies.push(`Odczyt AI mógł zostać obcięty (limit modelu) i pominąć część pozycji — suma pozycji (${computedNet}) różni się od podanej kwoty netto (${reportedNet}), ale to może wynikać z niepełnego odczytu, nie z błędu na pasku.`);
    } else if (absVariance <= NET_REVIEW_EUR) {
      discrepancies.push(`Suma pozycji (${computedNet}) różni się od podanej kwoty netto (${reportedNet}) o ${variance} — niewielka różnica, możliwe zaokrąglenie tabeli podatkowej. Warto zweryfikować ręcznie, to jeszcze nie jest twarda niezgodność.`);
    } else {
      discrepancies.push(`Suma pozycji (${computedNet}) różni się od podanej kwoty netto (${reportedNet}) o ${variance}.`);
      hasHardIssue = true;
    }
  }

  let wmlViolation = false;
  if (extraction.hourlyRate !== null && applicableMinimumWage !== null && extraction.hourlyRate < applicableMinimumWage) {
    wmlViolation = true;
    hasHardIssue = true;
    discrepancies.push(`Stawka godzinowa (${extraction.hourlyRate}) jest poniżej wettelijk minimumloon (€${applicableMinimumWage}).`);
  }

  let minimumWageNote: string | null = null;
  if (extraction.minimumWage !== null && applicableMinimumWage !== null && Math.abs(extraction.minimumWage - applicableMinimumWage) > 0.005) {
    minimumWageNote = `Minimumloon wydrukowane na pasku (€${extraction.minimumWage}) różni się od stawki obowiązującej w tym okresie (€${applicableMinimumWage}) — informacja, nie naruszenie. Może oznaczać, że system kadrowy nie zaktualizował jeszcze stawki po zmianie ustawowej.`;
  }

  if (extraction.hourlyRate !== null) {
    for (const item of extraction.lineItems) {
      const match = item.description.match(OVERTIME_PATTERN);
      if (!match || !match[1] || item.rate === null) continue;
      const multiplier = Number(match[1].replace(',', '.')) / 100;
      const expectedRate = round(extraction.hourlyRate * multiplier);
      if (Math.abs(expectedRate - item.rate) > 0.05) {
        discrepancies.push(`"${item.description}": oczekiwana stawka ${expectedRate}, w dokumencie ${item.rate}.`);
        hasHardIssue = true;
      }
      if (item.quantity !== null && item.rate !== null && item.payment !== null) {
        const expectedPayment = round(item.quantity * item.rate);
        if (Math.abs(expectedPayment - item.payment) > 0.05) {
          discrepancies.push(`"${item.description}": ${item.quantity} x ${item.rate} = ${expectedPayment}, ale wypłacono ${item.payment}.`);
          hasHardIssue = true;
        }
      }
    }
  }

  return {
    totalPayments,
    totalDeductions,
    computedNet,
    reportedNet,
    variance,
    isConsistent: !hasHardIssue,
    wmlViolation,
    minimumWageApplicable: applicableMinimumWage,
    minimumWageNote,
    discrepancies,
    incomplete: extraction.truncated,
  };
}
