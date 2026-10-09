import { evaluateScenario, type ScenarioEvaluationResult, type ScenarioFigures } from './scenario-evaluate.js';
import type { PayslipComputationRates } from '../payroll-engine/payslip-model.js';

/**
 * Minimal two-variant comparison (§10). Pure: it evaluates (or receives) exactly two Scenario V1
 * evaluations and subtracts engine figures that the engine already produced. It adds no payroll maths,
 * no third variant and no UI.
 */

type Computed = Extract<ScenarioEvaluationResult, { status: 'computed' }>;

/** B minus A, field by field, on the representative engine figures. */
export type ScenarioFiguresDelta = { [K in keyof ScenarioFigures]: number };

export interface NotComparableSide {
  side: 'a' | 'b';
  status: Exclude<ScenarioEvaluationResult['status'], 'computed'>;
}

export type ScenarioComparison =
  | {
      status: 'comparable';
      a: Computed;
      b: Computed;
      delta: ScenarioFiguresDelta;
      /** True when either side carries a material range - the delta then compares representative (central) runs only. */
      rangeInvolved: boolean;
    }
  | { status: 'not_comparable'; a: ScenarioEvaluationResult; b: ScenarioEvaluationResult; reasons: NotComparableSide[] };

function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function compareEvaluations(a: ScenarioEvaluationResult, b: ScenarioEvaluationResult): ScenarioComparison {
  const reasons: NotComparableSide[] = [];
  if (a.status !== 'computed') reasons.push({ side: 'a', status: a.status });
  if (b.status !== 'computed') reasons.push({ side: 'b', status: b.status });
  if (a.status !== 'computed' || b.status !== 'computed') return { status: 'not_comparable', a, b, reasons };

  const delta: ScenarioFiguresDelta = {
    payoutAmount: round2(b.figures.payoutAmount - a.figures.payoutAmount),
    wageNet: round2(b.figures.wageNet - a.figures.wageNet),
    grossTotal: round2(b.figures.grossTotal - a.figures.grossTotal),
    totalTax: round2(b.figures.totalTax - a.figures.totalTax),
    hoursWorked: round2(b.figures.hoursWorked - a.figures.hoursWorked),
  };
  return { status: 'comparable', a, b, delta, rangeInvolved: a.range !== null || b.range !== null };
}

export function compareScenarios(a: unknown, b: unknown, rates: PayslipComputationRates): ScenarioComparison {
  return compareEvaluations(evaluateScenario(a, rates), evaluateScenario(b, rates));
}
