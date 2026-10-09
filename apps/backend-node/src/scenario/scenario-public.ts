import type { ScenarioComparison, ScenarioFiguresDelta, NotComparableSide } from './scenario-compare.js';
import type {
  EngineRun,
  ScenarioAssumptionUse,
  ScenarioEvaluationResult,
  ScenarioFigures,
  ScenarioProvenanceEntry,
  ScenarioRange,
} from './scenario-evaluate.js';
import type { NormalizedScenario, ScenarioIssue, ScenarioRequirement, ScenarioWarning, UnsupportedReason } from './scenario-types.js';

/**
 * F3 (Cursor review): the PUBLIC projection of an evaluation.
 *
 * The domain evaluator (`evaluateScenario`) keeps its full internal detail - the exact Tier A `engineInput`,
 * the engine's complete result, the per-field consumption table, the input digest - because backend tests
 * and replay need it. None of that may leave the process: it would bind every client (and the R2
 * Conversation Agent) to Tier A's internal structures. This module is the only place that turns an internal
 * result into what the HTTP boundary returns.
 *
 * It is an explicit ALLOW-LIST: each public object is built field by field, so a field added to the
 * internal result later is NOT exposed unless someone adds it here on purpose. There is deliberately no
 * flag, query parameter, header or environment switch that returns the internal form - replay is a
 * domain/test capability (call `evaluateScenario` directly), not an endpoint.
 */

/** One evaluated variant, without the engine structures: which uncertain values it resolved and what the
 * engine's headline figures were. `range.lowVariant` / `highVariant` index into `variants`. */
export interface PublicScenarioVariant {
  kind: EngineRun['kind'];
  assignments: Record<string, unknown>;
  figures: ScenarioFigures;
}

export interface PublicScenarioRange {
  basis: ScenarioRange['basis'];
  low: number;
  high: number;
  swing: number;
  threshold: number;
  referencePayout: number;
  lowVariant: number;
  highVariant: number;
  uncertainFields: string[];
}

export type PublicScenarioEvaluation =
  | {
      status: 'computed';
      scenario: NormalizedScenario;
      figures: ScenarioFigures;
      range: PublicScenarioRange | null;
      variants: PublicScenarioVariant[];
      assumptionsUsed: ScenarioAssumptionUse[];
      provenance: ScenarioProvenanceEntry[];
      warnings: ScenarioWarning[];
    }
  | { status: 'blocked'; scenario: NormalizedScenario; requirements: ScenarioRequirement[]; warnings: ScenarioWarning[] }
  | { status: 'invalid'; scenario: NormalizedScenario; issues: ScenarioIssue[] }
  | { status: 'unsupported'; scenario: NormalizedScenario; unsupported: UnsupportedReason[] };

type PublicComputed = Extract<PublicScenarioEvaluation, { status: 'computed' }>;

export type PublicScenarioComparison =
  | { status: 'comparable'; a: PublicComputed; b: PublicComputed; delta: ScenarioFiguresDelta; rangeInvolved: boolean }
  | { status: 'not_comparable'; a: PublicScenarioEvaluation; b: PublicScenarioEvaluation; reasons: NotComparableSide[] };

function publicFigures(f: ScenarioFigures): ScenarioFigures {
  return { payoutAmount: f.payoutAmount, wageNet: f.wageNet, grossTotal: f.grossTotal, totalTax: f.totalTax, hoursWorked: f.hoursWorked };
}

function publicRange(r: ScenarioRange | null): PublicScenarioRange | null {
  if (!r) return null;
  return {
    basis: r.basis,
    low: r.low,
    high: r.high,
    swing: r.swing,
    threshold: r.threshold,
    referencePayout: r.referencePayout,
    lowVariant: r.lowRun,
    highVariant: r.highRun,
    uncertainFields: [...r.uncertainFields],
  };
}

export function toPublicEvaluation(result: ScenarioEvaluationResult): PublicScenarioEvaluation {
  switch (result.status) {
    case 'computed':
      return {
        status: 'computed',
        scenario: result.scenario,
        figures: publicFigures(result.figures),
        range: publicRange(result.range),
        variants: result.runs.map((run) => ({ kind: run.kind, assignments: run.assignments, figures: publicFigures(run.figures) })),
        assumptionsUsed: result.assumptionsUsed,
        provenance: result.provenance,
        warnings: result.warnings,
      };
    case 'blocked':
      return { status: 'blocked', scenario: result.scenario, requirements: result.requirements, warnings: result.warnings };
    case 'invalid':
      return { status: 'invalid', scenario: result.scenario, issues: result.issues };
    case 'unsupported':
      return { status: 'unsupported', scenario: result.scenario, unsupported: result.unsupported };
  }
}

function toPublicComputed(result: Extract<ScenarioEvaluationResult, { status: 'computed' }>): PublicComputed {
  return toPublicEvaluation(result) as PublicComputed;
}

export function toPublicComparison(comparison: ScenarioComparison): PublicScenarioComparison {
  if (comparison.status === 'comparable') {
    return {
      status: 'comparable',
      a: toPublicComputed(comparison.a),
      b: toPublicComputed(comparison.b),
      delta: { ...comparison.delta },
      rangeInvolved: comparison.rangeInvolved,
    };
  }
  return { status: 'not_comparable', a: toPublicEvaluation(comparison.a), b: toPublicEvaluation(comparison.b), reasons: comparison.reasons.map((r) => ({ ...r })) };
}
