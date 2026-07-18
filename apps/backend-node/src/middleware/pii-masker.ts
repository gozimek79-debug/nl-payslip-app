import { SalarisRecord, ValidationResult } from '@shared-types';

export class PIIMasker {
  private readonly SENSITIVE_FIELDS = [
    'bsn', 'burgerservicenummer', 'address', 'adres', 'naam', 'name',
    'full_name', 'geboortedatum', 'birth_date', 'phone', 'telefoon', 'email'
  ];

  maskPII(data: any): any {
    if (typeof data !== 'object' || data === null) return data;
    if (Array.isArray(data)) return data.map(item => this.maskPII(item));
    const masked: any = {};
    for (const [key, value] of Object.entries(data)) {
      if (this.isSensitiveField(key)) {
        masked[key] = this.maskValue(value);
      } else if (typeof value === 'object' && value !== null) {
        masked[key] = this.maskPII(value);
      } else {
        masked[key] = value;
      }
    }
    return masked;
  }

  private isSensitiveField(fieldName: string): boolean {
    const lowerField = fieldName.toLowerCase();
    return this.SENSITIVE_FIELDS.some(sensitive => lowerField.includes(sensitive));
  }

  private maskValue(value: any): string {
    if (typeof value === 'number') {
      if (value.toString().length === 9) return '*****' + value.toString().slice(-4);
      return '**REDACTED**';
    }
    if (typeof value === 'string') {
      if (value.length <= 4) return '****';
      return value.slice(0, 1) + '***' + value.slice(-1);
    }
    return '**REDACTED**';
  }

  prepareSafeAIContext(record: SalarisRecord, validationResult: ValidationResult) {
    const safeRecord = this.maskPII(record);
    return {
      context: "Wygeneruj wyjaśnienie wypłaty dla użytkownika.",
      validated_data: {
        period: `${safeRecord.period_start} - ${safeRecord.period_end}`,
        period_type: safeRecord.period_type,
        actualNet: validationResult.actualNet,
        expectedNet: validationResult.expectedNet,
        variance: validationResult.variance,
        discrepancies: validationResult.discrepancies,
        gross_breakdown: {
          base_salary: safeRecord.gross_components.gross_base,
          overtime: safeRecord.gross_components.gross_overtime,
          hourly_rate: safeRecord.gross_components.normal_rate,
          total_hours: safeRecord.gross_components.normal_hours + safeRecord.gross_components.overtime_hours
        },
        cumulative_warning: safeRecord.cumulative_totals?.remaining_to_higher_bracket < 5000 
          ? `Zbliżasz się do progu podatkowego. Pozostało: €${safeRecord.cumulative_totals.remaining_to_higher_bracket}`
          : null
      },
      meta: { tax_year: 2026, wml_applied: true }
    };
  }
}
