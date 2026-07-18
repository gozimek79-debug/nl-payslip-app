export type PeriodType = 'week' | '4-wekelijks' | 'maand';

export interface SalarisRecord {
  id: string;
  user_id: string;
  employer_id: string;
  period_start: string;
  period_end: string;
  period_type: PeriodType;
  cumulative_totals: {
    ytd_gross: number;
    ytd_loonheffing: number;
    ytd_arbeidskorting: number;
    ytd_algemene_heffingskorting: number;
    ytd_net: number;
    remaining_to_higher_bracket: number;
  };
  gross_components: {
    normal_hours: number;
    normal_rate: number;
    gross_base: number;
    overtime_hours: number;
    overtime_rate: number;
    gross_overtime: number;
    gross_allowances: number;
    reserveringen_paid: number;
  };
  taxes: {
    loonheffing_base: number;
    bijzonder_tarief_tax: number;
    applied_heffingskorting: boolean;
    arbeidskorting_applied: number;
    algemene_heffingskorting_applied: number;
  };
  net_components: {
    net_additions: {
      etk_tax_free: number;
      reiskosten: number;
    };
    net_deductions: {
      zorgverzekering: number;
      huisvesting: number;
    };
  };
  totals: {
    total_gross: number;
    te_betalen_ocr: number;
    te_betalen_calculated: number;
    variance: number;
  };
  meta: {
    ocr_confidence: number;
    manual_corrections: boolean;
    verified_by_user: boolean;
    tax_table_version: string;
  };
}

export interface TaxConfig {
  id: string;
  year: number;
  minimum_wage_adult: number;
  period_tables: any;
  loonheffing_brackets: Array<{ min: number; max: number; rate: number }>;
  bijzonder_tarief_rate: number;
  heffingskortingen: {
    algemene_heffingskorting: { max_amount: number; phaseout_start: number; phaseout_rate: number };
    arbeidskorting: { max_amount: number; phaseout_start: number; phaseout_rate: number };
  };
}

export interface ValidationResult {
  isValid: boolean;
  expectedNet: number;
  actualNet: number;
  variance: number;
  discrepancies: string[];
  wmlViolation?: { type: string; details: string };
}
