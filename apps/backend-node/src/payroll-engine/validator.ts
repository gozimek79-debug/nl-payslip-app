import { SalarisRecord, TaxConfig, PeriodType } from '@shared-types';

interface ValidationResult {
  isValid: boolean;
  expectedNet: number;
  actualNet: number;
  variance: number;
  discrepancies: string[];
  wmlViolation?: {
    type: 'below_minimum' | 'housing_limit_exceeded';
    details: string;
  };
}

export class DutchPayrollValidator {
  private readonly PERIOD_MULTIPLIERS: Record<PeriodType, number> = {
    'week': 52,
    '4-wekelijks': 13,
    'maand': 12
  };

  private readonly WML_HOUSING_MAX_PERCENTAGE = 0.25;

  validateSalaris(record: SalarisRecord, taxConfig: TaxConfig): ValidationResult {
    const discrepancies: string[] = [];
    const periodMultiplier = this.PERIOD_MULTIPLIERS[record.period_type];
    const periodTaxTable = this.getPeriodTaxTable(taxConfig, record.period_type);
    const expectedGrossBase = this.validateGrossComponents(record, discrepancies);
    const annualizedGross = expectedGrossBase * periodMultiplier;
    const { algemeneHeffingskorting, arbeidskorting } = 
      this.calculateHeffingskortingen(annualizedGross, taxConfig, periodMultiplier);
    const taxCalculation = this.calculatePeriodTax(
      expectedGrossBase, record, periodTaxTable,
      algemeneHeffingskorting, arbeidskorting
    );
    const wmlValidation = this.validateWMLCompliance(record, taxConfig, expectedGrossBase);
    if (wmlValidation) discrepancies.push(wmlValidation.details);
    const calculatedNet = this.calculateNetPay(expectedGrossBase, taxCalculation, record);
    const actualNet = record.totals.te_betalen_ocr;
    const variance = calculatedNet - actualNet;
    const isValid = Math.abs(variance) <= 0.10;
    if (!isValid) discrepancies.push(`Niezgodność kwoty do wypłaty (Te betalen). Różnica: €${variance.toFixed(2)}`);
    return {
      isValid,
      expectedNet: Number(calculatedNet.toFixed(2)),
      actualNet,
      variance: Number(variance.toFixed(2)),
      discrepancies,
      wmlViolation: wmlValidation || undefined
    };
  }

  private getPeriodTaxTable(taxConfig: TaxConfig, periodType: PeriodType) {
    return taxConfig.period_tables?.[periodType] || this.generatePeriodTable(taxConfig, periodType);
  }

  private generatePeriodTable(taxConfig: TaxConfig, periodType: PeriodType) {
    return { brackets: [] };
  }

  private validateGrossComponents(record: SalarisRecord, discrepancies: string[]): number {
    const { normal_hours, normal_rate, overtime_hours, overtime_rate, gross_base, gross_overtime } = record.gross_components;
    if (normal_rate < 14.45) discrepancies.push(`⚠️ Stawka godzinowa (€${normal_rate}) poniżej płacy minimalnej WML (€14.45/h)`);
    const expectedBase = normal_hours * normal_rate;
    if (Math.abs(expectedBase - gross_base) > 0.05) discrepancies.push(`Błąd Brutto Bazowego: Oczekiwano €${expectedBase.toFixed(2)}, na pasku €${gross_base.toFixed(2)}`);
    const minimumOvertimeRate = normal_rate * 1.5;
    if (overtime_rate < minimumOvertimeRate && overtime_hours > 0) discrepancies.push(`⚠️ Stawka za nadgodziny (€${overtime_rate}) poniżej ustawowego minimum (€${minimumOvertimeRate.toFixed(2)})`);
    const expectedOvertime = overtime_hours * overtime_rate;
    if (Math.abs(expectedOvertime - gross_overtime) > 0.05) discrepancies.push(`Błąd Nadgodzin: Oczekiwano €${expectedOvertime.toFixed(2)}, na pasku €${gross_overtime.toFixed(2)}`);
    return expectedBase + expectedOvertime + record.gross_components.gross_allowances + record.gross_components.reserveringen_paid;
  }

  private calculateHeffingskortingen(annualizedGross: number, taxConfig: TaxConfig, periodMultiplier: number) {
    const { algemene_heffingskorting, arbeidskorting } = taxConfig.heffingskortingen;
    let algemeneKorting = algemene_heffingskorting.max_amount;
    if (annualizedGross > algemene_heffingskorting.phaseout_start) {
      const excess = annualizedGross - algemene_heffingskorting.phaseout_start;
      algemeneKorting = Math.max(0, algemeneKorting - (excess * algemene_heffingskorting.phaseout_rate));
    }
    let arbeidskortingAmount = 0;
    if (annualizedGross <= 11000) arbeidskortingAmount = annualizedGross * 0.0842;
    else if (annualizedGross <= 25000) arbeidskortingAmount = 926 + (annualizedGross - 11000) * 0.2895;
    else if (annualizedGross <= 40000) arbeidskortingAmount = arbeidskorting.max_amount;
    else {
      const excess = annualizedGross - arbeidskorting.phaseout_start;
      arbeidskortingAmount = Math.max(0, arbeidskorting.max_amount - (excess * arbeidskorting.phaseout_rate));
    }
    return {
      algemeneHeffingskorting: algemeneKorting / periodMultiplier,
      arbeidskorting: arbeidskortingAmount / periodMultiplier
    };
  }

  private calculatePeriodTax(grossPay: number, record: SalarisRecord, periodTable: any, algemeneKorting: number, arbeidskorting: number) {
    let loonheffing = this.lookupWitteTabel(grossPay, periodTable);
    const totalKortingen = algemeneKorting + arbeidskorting;
    loonheffing = Math.max(0, loonheffing - totalKortingen);
    const bijzonderTarief = record.gross_components.gross_overtime * 0.495;
    return { loonheffing, bijzonderTarief, totalTax: loonheffing + bijzonderTarief };
  }

  private lookupWitteTabel(grossPay: number, periodTable: any): number {
    const bracket = periodTable.brackets.find((b: any) => grossPay >= b.min && grossPay <= b.max);
    return bracket ? bracket.tax_amount : 0;
  }

  private validateWMLCompliance(record: SalarisRecord, taxConfig: TaxConfig, grossPay: number) {
    const periodWML = taxConfig.minimum_wage_adult / this.PERIOD_MULTIPLIERS[record.period_type];
    const housingDeduction = record.net_components.net_deductions.huisvesting;
    if (grossPay < periodWML) return {
      type: 'below_minimum' as const,
      details: `⚠️ Wynagrodzenie brutto (€${grossPay.toFixed(2)}) poniżej WML (€${periodWML.toFixed(2)})`
    };
    const maxHousingDeduction = periodWML * this.WML_HOUSING_MAX_PERCENTAGE;
    if (housingDeduction > maxHousingDeduction) return {
      type: 'housing_limit_exceeded' as const,
      details: `⚠️ Potrącenie za huisvesting (€${housingDeduction}) przekracza limit 25% WML (€${maxHousingDeduction.toFixed(2)})`
    };
    return null;
  }

  private calculateNetPay(grossPay: number, taxCalculation: any, record: SalarisRecord): number {
    const totalNetAdditions = Object.values(record.net_components.net_additions).reduce((a: any, b: any) => a + b, 0);
    const totalNetDeductions = Object.values(record.net_components.net_deductions).reduce((a: any, b: any) => a + b, 0);
    return grossPay - taxCalculation.totalTax + totalNetAdditions - totalNetDeductions;
  }
}
