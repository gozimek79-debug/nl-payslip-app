import { SalarisRecord, ValidationResult } from '@shared-types';

export function prepareAIContext(validationResult: ValidationResult, record: SalarisRecord) {
  return {
    context: "Wygeneruj wyjaśnienie wypłaty dla użytkownika.",
    validated_data: {
      period: `${record.period_start} - ${record.period_end}`,
      actualNet: validationResult.actualNet,
      expectedNet: validationResult.expectedNet,
      variance: validationResult.variance,
      discrepancies: validationResult.discrepancies,
      gross_breakdown: {
        base_salary: record.gross_components.gross_base,
        overtime: record.gross_components.gross_overtime,
        allowances: record.gross_components.gross_allowances,
        reservations: record.gross_components.reserveringen_paid
      },
      net_components: {
        additions: record.net_components.net_additions,
        deductions: record.net_components.net_deductions
      },
      highlights: generateHighlights(record)
    }
  };
}

function generateHighlights(record: SalarisRecord): string[] {
  const highlights: string[] = [];
  if (record.gross_components.overtime_hours > 0) {
    highlights.push(`Nadgodziny (${record.gross_components.overtime_hours}h) opodatkowane według bijzonder tarief (49.5%)`);
  }
  if (record.net_components.net_deductions.huisvesting > 0) {
    highlights.push(`Potrącenie za zakwaterowanie (huisvesting): €${record.net_components.net_deductions.huisvesting}`);
  }
  return highlights;
}
