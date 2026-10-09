import { checkTierASanity, computeTierAResult, type TierAInput, type TierASectorPremiumEstimate } from '../payroll-engine/tier-a.js';
import type { HourGridLineCategory } from '../payroll-engine/hour-grid.js';
import type { PayslipComputationRates, PayslipComputationResult } from '../payroll-engine/payslip-model.js';
import { MAX_VARIANT_RUNS, rangeMaterialityThreshold } from './scenario-config.js';
import { findUnsupported, mapScenarioToEngine, type FieldConsumption } from './scenario-map.js';
import {
  SCENARIO_FIELD_PATHS,
  type NormalizedScenario,
  type ScenarioFieldPath,
  type ScenarioIssue,
  type ScenarioLifecycle,
  type ScenarioRequirement,
  type ScenarioV1,
  type ScenarioValueSource,
  type ScenarioWarning,
  type UnsupportedReason,
} from './scenario-types.js';
import { canonicalJson, canonicalize, digestOf, getAt, isRecord, withValueAt } from './scenario-util.js';
import { validateScenario } from './scenario-validate.js';

/**
 * Scenario evaluation (§8, §9): Scenario V1 -> validator -> mapper -> the EXISTING Tier A engine ->
 * a stable, JSON-serialisable ScenarioEvaluationResult. The engine is the only arithmetic authority:
 * every money figure here is copied out of a `computeTierAResult` run. The only numbers this module
 * computes itself are the midpoint of a producer-supplied range (to choose the central VARIANT, not a
 * payroll figure), the swing between payouts the engine produced, and the materiality threshold.
 */

// ---------------------------------------------------------------------------------------------
// Result contract
// ---------------------------------------------------------------------------------------------

/** The headline figures of one engine run - copied from the engine's own result, never recomputed. */
export interface ScenarioFigures {
  payoutAmount: number;
  wageNet: number;
  grossTotal: number;
  totalTax: number;
  hoursWorked: number;
}

/** The engine's own estimate-mode extras (sourced population defaults, disclosed as a range) - present
 * only when deductions.mode === 'estimate'. */
export interface EngineEstimate {
  sectorPremium: TierASectorPremiumEstimate;
  netRange: { low: number; high: number };
  payoutRange: { low: number; high: number };
}

export interface EngineRun {
  /** `single` - no uncertainty; `central` - midpoint / first-option variant; `variant` - one combination of endpoints. */
  kind: 'single' | 'central' | 'variant';
  /** The uncertain fields this run resolved, path -> the concrete value it used. */
  assignments: Record<string, unknown>;
  /** The exact input handed to the existing engine; replayable through POST /api/tier-a/calculate. */
  engineInput: TierAInput;
  engineInputDigest: string;
  consumption: FieldConsumption[];
  figures: ScenarioFigures;
  /** The engine's complete result (every line of the chain the engine computed). */
  engineResult: PayslipComputationResult;
  estimate: EngineEstimate | null;
}

export interface ScenarioRange {
  basis: 'payout_amount';
  low: number;
  high: number;
  /** high - low, from the engine runs. */
  swing: number;
  /** The materiality threshold that was applied (the larger of EUR 5 and 1% of the reference payout). */
  threshold: number;
  referencePayout: number;
  /** Indexes into `runs` of the engine runs that produced the endpoints. A run's own estimate range may
   * produce an endpoint (engine-provided sector-premium range). */
  lowRun: number;
  highRun: number;
  uncertainFields: string[];
}

export interface ScenarioProvenanceEntry {
  path: string;
  state: 'known' | 'range' | 'alternatives';
  source: ScenarioValueSource;
  ref?: string;
  consumedByEngine: boolean;
}

export interface ScenarioAssumptionUse {
  path: string;
  state: 'known' | 'range' | 'alternatives';
  ref?: string;
}

export type ScenarioEvaluationResult =
  | {
      status: 'computed';
      scenario: NormalizedScenario;
      /** The representative engine run (`runs[0]`): the single run, or the central variant. */
      figures: ScenarioFigures;
      /** Non-null ONLY when the swing between engine runs is material (§10). */
      range: ScenarioRange | null;
      runs: EngineRun[];
      /** Loonto assumptions that the engine actually consumed - never presented as verified facts. */
      assumptionsUsed: ScenarioAssumptionUse[];
      provenance: ScenarioProvenanceEntry[];
      warnings: ScenarioWarning[];
    }
  | { status: 'blocked'; scenario: NormalizedScenario; requirements: ScenarioRequirement[]; warnings: ScenarioWarning[] }
  | { status: 'invalid'; scenario: NormalizedScenario; issues: ScenarioIssue[] }
  | { status: 'unsupported'; scenario: NormalizedScenario; unsupported: UnsupportedReason[] };

// ---------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------

/** Canonical key order, trimmed label, plus the code-derived lifecycle status. */
export function normalizeScenario(input: unknown, status: ScenarioLifecycle): NormalizedScenario {
  const base = isRecord(input) ? (canonicalize(input) as Record<string, unknown>) : {};
  if (typeof base.label === 'string') {
    const trimmed = base.label.trim();
    if (trimmed === '') delete base.label;
    else base.label = trimmed;
  }
  return { ...(base as unknown as ScenarioV1), status };
}

// ---------------------------------------------------------------------------------------------
// Variants (deterministic ranges, §9)
// ---------------------------------------------------------------------------------------------

interface Uncertain {
  path: ScenarioFieldPath;
  /** Candidate concrete values in deterministic order (range: [low, high]; alternatives: producer order). */
  candidates: unknown[];
  central: unknown;
  origin: { source: ScenarioValueSource; ref?: string };
}

function collectUncertain(scenario: ScenarioV1): Uncertain[] {
  const out: Uncertain[] = [];
  for (const path of SCENARIO_FIELD_PATHS) {
    const node = getAt(scenario, path);
    if (!isRecord(node)) continue;
    const origin = { source: node.source as ScenarioValueSource, ...(typeof node.ref === 'string' ? { ref: node.ref } : {}) };
    if (node.state === 'range') {
      const low = node.low as number;
      const high = node.high as number;
      out.push({ path, candidates: [low, high], central: Math.round(((low + high) / 2) * 1e6) / 1e6, origin });
    } else if (node.state === 'alternatives' && Array.isArray(node.options)) {
      out.push({ path, candidates: node.options, central: node.options[0], origin });
    }
  }
  return out;
}

function resolveWith(scenario: ScenarioV1, uncertain: Uncertain[], pick: (u: Uncertain) => unknown): { scenario: ScenarioV1; assignments: Record<string, unknown> } {
  let resolved = scenario;
  const assignments: Record<string, unknown> = {};
  for (const u of uncertain) {
    const value = pick(u);
    assignments[u.path] = value;
    resolved = withValueAt(resolved, u.path, { state: 'known', value, ...u.origin });
  }
  return { scenario: resolved, assignments };
}

/**
 * F1 (Cursor review): the number of engine runs must be decided BEFORE any combination is built.
 *
 * `planVariantRuns` takes ONLY the number of candidates of each uncertain dimension - never the
 * candidates themselves - so it cannot enumerate or allocate anything. It multiplies with an early exit:
 * the moment the planned run count (1 central run + the product of all counts) exceeds the cap it stops
 * and reports a lower bound. The running product is therefore never larger than
 * MAX_VARIANT_RUNS * (largest single count), so there is no overflow and no unbounded loop.
 */
export type VariantPlan =
  | { status: 'within_cap'; totalRuns: number }
  | { status: 'over_cap'; atLeastRuns: number };

export function planVariantRuns(candidateCounts: readonly number[], maxRuns: number = MAX_VARIANT_RUNS): VariantPlan {
  if (candidateCounts.length === 0) return { status: 'within_cap', totalRuns: 1 };
  let product = 1;
  for (const count of candidateCounts) {
    product *= Math.max(1, count);
    if (1 + product > maxRuns) return { status: 'over_cap', atLeastRuns: 1 + product };
  }
  return { status: 'within_cap', totalRuns: 1 + product };
}

interface PlannedVariant {
  kind: EngineRun['kind'];
  resolved: ScenarioV1;
  assignments: Record<string, unknown>;
}

/**
 * Builds the resolved variants. Its parameter type only admits a `within_cap` plan, so the ordering
 * "count first, reject, only then enumerate" is enforced by the compiler, not by convention. Even so, the
 * enumeration itself carries a hard guard so that no future caller can grow it past the plan.
 */
function materializeVariants(scenario: ScenarioV1, uncertain: Uncertain[], plan: Extract<VariantPlan, { status: 'within_cap' }>): PlannedVariant[] {
  if (uncertain.length === 0) return [{ kind: 'single', resolved: scenario, assignments: {} }];

  const central = resolveWith(scenario, uncertain, (u) => u.central);
  const variants: PlannedVariant[] = [{ kind: 'central', resolved: central.scenario, assignments: central.assignments }];

  let combos: Array<Map<string, unknown>> = [new Map()];
  for (const u of uncertain) {
    const next: Array<Map<string, unknown>> = [];
    for (const partial of combos) {
      for (const candidate of u.candidates) {
        if (next.length >= plan.totalRuns) throw new Error('scenario variant enumeration exceeded its plan');
        const copy = new Map(partial);
        copy.set(u.path, candidate);
        next.push(copy);
      }
    }
    combos = next;
  }
  for (const combo of combos) {
    const variant = resolveWith(scenario, uncertain, (u) => combo.get(u.path));
    variants.push({ kind: 'variant', resolved: variant.scenario, assignments: variant.assignments });
  }
  return variants;
}

/**
 * F2 (Cursor review): the top-level Scenario is validated once, but ranges / alternatives only become
 * concrete values when a variant is resolved - and a resolved variant can be impossible even though the
 * unresolved Scenario looked fine (an explicit overtime layout that disagrees with the resolved overtime
 * hours, a day holding more than 24 h, a week over the limit). Every resolved variant therefore goes
 * through the SAME validator (not a copy of its rules) BEFORE any engine call. One impossible variant
 * makes the whole evaluation `invalid`: it is never silently dropped while the others are priced.
 */
function revalidateVariants(variants: PlannedVariant[]): ScenarioIssue[] {
  const issues: ScenarioIssue[] = [];
  const validated = new Set<string>();
  for (const variant of variants) {
    if (variant.kind === 'single') continue; // identical to the Scenario that was just validated
    // The central variant is often the same resolution as one of the corners (the first alternative, or a
    // degenerate range): an identical resolution is validated - and reported - once.
    const resolution = canonicalJson(variant.assignments);
    if (validated.has(resolution)) continue;
    validated.add(resolution);
    const validation = validateScenario(variant.resolved);
    if (validation.status !== 'invalid') continue;
    const described = describeAssignments(variant.assignments);
    for (const issue of validation.issues) issues.push({ ...issue, variant: described });
  }
  return issues;
}

function describeAssignments(assignments: Record<string, unknown>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [path, value] of Object.entries(assignments)) {
    out[path] = typeof value === 'number' || typeof value === 'string' ? value : canonicalJson(value);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// One engine run
// ---------------------------------------------------------------------------------------------

/** A string discriminant (not a boolean): it narrows under any TypeScript configuration, including the
 * default one Vercel compiles the API entry with. */
type RunOutcome = { status: 'ran'; run: EngineRun } | { status: 'blocked'; requirements: ScenarioRequirement[] };

const CATEGORY_FIELD: Partial<Record<HourGridLineCategory, ScenarioFieldPath>> = {
  overtime_tier_1: 'pay.overtime.tier1Percent',
  overtime_tier_2: 'pay.overtime.tier2Percent',
  saturday: 'pay.saturdayPremiumPercent',
  sunday: 'pay.sundayPremiumPercent',
  holiday: 'pay.publicHolidayPremiumPercent',
};

function engineRequirement(field: ScenarioFieldPath): ScenarioRequirement {
  return { field, reason: 'engine_requires', resolvableBy: { userAnswer: true, explicitAssumption: false, deterministicVariants: false } };
}

function runEngine(resolved: ScenarioV1, assignments: Record<string, unknown>, kind: EngineRun['kind'], rates: PayslipComputationRates): RunOutcome {
  const mapped = mapScenarioToEngine(resolved);
  if (mapped.status === 'blocked') return { status: 'blocked', requirements: mapped.requirements };
  const { input, consumption } = mapped.mapping;

  const computed = computeTierAResult(input, rates);
  if (computed.status === 'blocked') {
    if (computed.reason === 'overtime_threshold_unknown') return { status: 'blocked', requirements: [engineRequirement('pay.overtime.thresholdHoursPerDay')] };
    return {
      status: 'blocked',
      requirements: computed.categories.flatMap((category) => {
        const field = CATEGORY_FIELD[category];
        return field ? [engineRequirement(field)] : [];
      }),
    };
  }
  if (computed.outcome.status !== 'complete') {
    // The engine's own "incomplete" outcome: a deduction field it needs is unknown. No money figure exists.
    return { status: 'blocked', requirements: [engineRequirement('deductions.mode')] };
  }
  const result = computed.outcome.result;
  return {
    status: 'ran',
    run: {
      kind,
      assignments,
      engineInput: input,
      engineInputDigest: digestOf(input),
      consumption,
      figures: {
        payoutAmount: result.payout_amount,
        wageNet: result.wage_net,
        grossTotal: result.gross_total,
        totalTax: result.total_tax,
        hoursWorked: result.hours_worked,
      },
      engineResult: result,
      estimate:
        computed.sector_premium_estimate && computed.net_range && computed.payout_range
          ? { sectorPremium: computed.sector_premium_estimate, netRange: computed.net_range, payoutRange: computed.payout_range }
          : null,
    },
  };
}

function dedupe(requirements: ScenarioRequirement[]): ScenarioRequirement[] {
  const seen = new Set<string>();
  return requirements.filter((r) => {
    const key = `${r.field}|${r.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Range from engine runs
// ---------------------------------------------------------------------------------------------

function round2(value: number): number {
  return Number(value.toFixed(2));
}

function buildRange(runs: EngineRun[], uncertainFields: string[]): ScenarioRange | null {
  // Every endpoint is a payout the ENGINE produced: a run's own payout, or - for a run in estimate mode -
  // the engine's own payout range for that run.
  let low = Infinity;
  let high = -Infinity;
  let lowRun = 0;
  let highRun = 0;
  runs.forEach((run, index) => {
    const runLow = run.estimate ? run.estimate.payoutRange.low : run.figures.payoutAmount;
    const runHigh = run.estimate ? run.estimate.payoutRange.high : run.figures.payoutAmount;
    if (runLow < low) { low = runLow; lowRun = index; }
    if (runHigh > high) { high = runHigh; highRun = index; }
  });
  const swing = round2(high - low);
  const referencePayout = round2((low + high) / 2);
  const threshold = round2(rangeMaterialityThreshold(referencePayout));
  if (swing < threshold) return null;
  return { basis: 'payout_amount', low: round2(low), high: round2(high), swing, threshold, referencePayout, lowRun, highRun, uncertainFields };
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

export function evaluateScenario(input: unknown, rates: PayslipComputationRates): ScenarioEvaluationResult {
  const validation = validateScenario(input);

  if (validation.status === 'invalid') {
    return { status: 'invalid', scenario: normalizeScenario(input, 'invalid'), issues: validation.issues };
  }
  const scenario = input as ScenarioV1;

  const unsupported: UnsupportedReason[] = findUnsupported(scenario);
  if (unsupported.length > 0) {
    return { status: 'unsupported', scenario: normalizeScenario(input, validation.status), unsupported };
  }
  if (validation.status === 'blocked') {
    return { status: 'blocked', scenario: normalizeScenario(input, 'blocked'), requirements: validation.requirements, warnings: validation.warnings };
  }

  const uncertain = collectUncertain(scenario);

  // F1: decide the run count from the candidate COUNTS alone - before any combination exists.
  const plan = planVariantRuns(uncertain.map((u) => u.candidates.length));
  if (plan.status === 'over_cap') {
    return {
      status: 'unsupported',
      scenario: normalizeScenario(input, 'ready'),
      unsupported: [{ kind: 'capability', capability: 'too_many_variants', params: { atLeastRuns: plan.atLeastRuns, max: MAX_VARIANT_RUNS } }],
    };
  }

  // F2: every resolved variant is validated before ANY of them reaches the engine.
  const variants = materializeVariants(scenario, uncertain, plan);
  const variantIssues = revalidateVariants(variants);
  if (variantIssues.length > 0) {
    return { status: 'invalid', scenario: normalizeScenario(input, 'invalid'), issues: variantIssues };
  }

  const outcomes: RunOutcome[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    const outcome = runEngine(variant.resolved, variant.assignments, variant.kind, rates);
    if (outcome.status === 'ran') {
      if (seen.has(outcome.run.engineInputDigest)) continue;
      seen.add(outcome.run.engineInputDigest);
    }
    outcomes.push(outcome);
  }

  const blocked = outcomes.flatMap((o) => (o.status === 'ran' ? [] : o.requirements));
  if (blocked.length > 0) {
    return { status: 'blocked', scenario: normalizeScenario(input, 'blocked'), requirements: dedupe(blocked), warnings: validation.warnings };
  }
  const runs = outcomes.flatMap((o) => (o.status === 'ran' ? [o.run] : []));
  const representative = runs[0] as EngineRun;
  const uncertainFields = uncertain.map((u) => u.path as string);
  const range = uncertain.length > 0 || representative.estimate ? buildRange(runs, uncertainFields) : null;

  const consumed = new Set(representative.consumption.filter((c) => c.status === 'consumed').map((c) => c.path));
  const provenance: ScenarioProvenanceEntry[] = [];
  for (const path of SCENARIO_FIELD_PATHS) {
    const node = getAt(scenario, path);
    if (!isRecord(node) || (node.state !== 'known' && node.state !== 'range' && node.state !== 'alternatives')) continue;
    provenance.push({
      path,
      state: node.state,
      source: node.source as ScenarioValueSource,
      ...(typeof node.ref === 'string' ? { ref: node.ref } : {}),
      consumedByEngine: consumed.has(path),
    });
  }
  const assumptionsUsed: ScenarioAssumptionUse[] = provenance
    .filter((p) => p.source === 'loonto_assumption' && p.consumedByEngine)
    .map((p) => ({ path: p.path, state: p.state, ...(p.ref ? { ref: p.ref } : {}) }));

  const warnings: ScenarioWarning[] = [...validation.warnings];
  for (const a of assumptionsUsed) warnings.push({ code: 'assumption_in_use', path: a.path });
  if (representative.estimate) warnings.push({ code: 'sector_premium_estimated' });
  for (const sanity of checkTierASanity({ status: 'complete', result: representative.engineResult }, representative.engineInput)) {
    warnings.push({ code: sanity.code === 'net_exceeds_gross' ? 'engine_sanity_net_exceeds_gross' : 'engine_sanity_effective_rate_exceeds_gross_rate' });
  }

  return {
    status: 'computed',
    scenario: normalizeScenario(input, 'ready'),
    figures: representative.figures,
    range,
    runs,
    assumptionsUsed,
    provenance,
    warnings,
  };
}
