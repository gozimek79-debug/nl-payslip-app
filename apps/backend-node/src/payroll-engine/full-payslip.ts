export interface PayslipLineItem {
  section: string;
  description: string;
  quantity: number | null;
  rate: number | null;
  payment: number | null;
  deduction: number | null;
}

export interface FullPayslipExtraction {
  employer: string | null;
  employeeName: string | null;
  period: string | null;
  hourlyRate: number | null;
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
}

export interface FullPayslipValidation {
  totalPayments: number;
  totalDeductions: number;
  computedNet: number;
  reportedNet: number | null;
  variance: number | null;
  isConsistent: boolean;
  wmlViolation: boolean;
  discrepancies: string[];
  incomplete: boolean;
}

const OVERTIME_PATTERN = /(\d+(?:[.,]\d+)?)\s*%/;

function round(value: number): number {
  return Number(value.toFixed(2));
}

export function validateFullPayslip(extraction: FullPayslipExtraction): FullPayslipValidation {
  const discrepancies: string[] = [];
  let hasHardIssue = false;

  const totalPayments = round(extraction.lineItems.reduce((sum, item) => sum + (item.payment ?? 0), 0));
  const totalDeductions = round(extraction.lineItems.reduce((sum, item) => sum + (item.deduction ?? 0), 0));
  const computedNet = round(totalPayments - totalDeductions);

  const reportedNet = extraction.reportedTotalNet ?? extraction.reportedNetPaid ?? null;
  let variance: number | null = null;
  if (reportedNet !== null) {
    variance = round(computedNet - reportedNet);
    const netMismatch = Math.abs(variance) > 1;
    if (netMismatch && extraction.truncated) {
      discrepancies.push(`Odczyt AI mógł zostać obcięty (limit modelu) i pominąć część pozycji — suma pozycji (${computedNet}) różni się od podanej kwoty netto (${reportedNet}), ale to może wynikać z niepełnego odczytu, nie z błędu na pasku.`);
    } else if (netMismatch) {
      discrepancies.push(`Suma pozycji (${computedNet}) różni się od podanej kwoty netto (${reportedNet}) o ${variance}.`);
      hasHardIssue = true;
    }
  }

  let wmlViolation = false;
  if (extraction.hourlyRate !== null && extraction.minimumWage !== null && extraction.hourlyRate < extraction.minimumWage) {
    wmlViolation = true;
    hasHardIssue = true;
    discrepancies.push(`Stawka godzinowa (${extraction.hourlyRate}) jest poniżej wettelijk minimumloon (${extraction.minimumWage}).`);
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
    discrepancies,
    incomplete: extraction.truncated,
  };
}
