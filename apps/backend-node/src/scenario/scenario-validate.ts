import {
  SCENARIO_FIELDS,
  SCENARIO_FIELD_PATHS,
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_VALUE_SOURCES,
  UNSUPPORTED_CONCEPTS,
  WEEKDAY_KEYS,
  type ChoiceFieldSpec,
  type NumberFieldSpec,
  type OvertimeDistribution,
  type ScenarioFieldPath,
  type ScenarioIssue,
  type ScenarioIssueCode,
  type ScenarioRequirement,
  type ScenarioRequirementReason,
  type ScenarioValidation,
  type ScenarioWarning,
} from './scenario-types.js';
import { expandWeekdayHours, getAt, hoursRelevance, isRecord, numericEndpoints, valueStatus } from './scenario-util.js';

/**
 * The pure, deterministic Scenario validator (§5). It never throws for user-data problems and never
 * calls a model; the lifecycle it returns is decided here, by code:
 *   invalid - cannot be interpreted safely (structure, units, bounds, contradictions)
 *   blocked - structurally valid, but a value the engine needs is missing / unknown / in conflict
 *   ready   - safe to evaluate
 * It performs NO payroll arithmetic - only bounds checks and the "is this value present" question.
 */

const WEEK_HOURS_CAP = 168;
const DISTRIBUTION_TOLERANCE = 1e-6;

/** Variants (a range / alternatives supplied by the producer) can express genuine uncertainty for these. */
const VARIANT_FIELDS: ReadonlySet<ScenarioFieldPath> = new Set<ScenarioFieldPath>([
  'tax.loonheffingskorting',
  'deductions.mode',
  'pay.saturdayPremiumPercent',
  'pay.sundayPremiumPercent',
  'pay.publicHolidayPremiumPercent',
  'pay.overtime.tier1Percent',
  'pay.overtime.tier2Percent',
]);

function requirement(field: ScenarioRequirement['field'], reason: ScenarioRequirementReason): ScenarioRequirement {
  const spec = field === 'work.hours' ? null : SCENARIO_FIELDS[field];
  return {
    field,
    reason,
    resolvableBy: {
      userAnswer: true,
      explicitAssumption: spec?.assumption === 'orientation_allowed',
      deterministicVariants: field !== 'work.hours' && VARIANT_FIELDS.has(field),
    },
  };
}

function isSource(value: unknown): boolean {
  return typeof value === 'string' && (SCENARIO_VALUE_SOURCES as readonly string[]).includes(value);
}

function boundsCode(spec: NumberFieldSpec, value: number): ScenarioIssueCode {
  switch (spec.unit) {
    case 'hours':
    case 'hours_per_day':
      return value < 0 ? 'negative_hours' : 'hours_out_of_range';
    case 'eur_per_hour':
      return 'hourly_rate_out_of_range';
    case 'premium_percent':
    case 'percent':
      return 'percent_out_of_range';
    case 'eur_per_week':
      return 'amount_out_of_range';
  }
}

function checkNumber(path: ScenarioFieldPath, spec: NumberFieldSpec, value: unknown, issues: ScenarioIssue[]): void {
  if (typeof value !== 'number') {
    issues.push({ code: 'malformed_value', path });
    return;
  }
  if (!Number.isFinite(value)) {
    issues.push({ code: 'value_not_finite', path });
    return;
  }
  const below = spec.exclusiveMin ? value <= spec.min : value < spec.min;
  if (below || value > spec.max) {
    issues.push({ code: boundsCode(spec, value), path, params: { value, min: spec.min, max: spec.max } });
  }
}

function checkOrigin(path: string, node: Record<string, unknown>, issues: ScenarioIssue[]): void {
  if (!isSource(node.source) || (node.ref !== undefined && typeof node.ref !== 'string')) {
    issues.push({ code: 'malformed_source', path });
  }
}

function checkDistribution(path: ScenarioFieldPath, value: unknown, issues: ScenarioIssue[]): boolean {
  if (!isRecord(value)) {
    issues.push({ code: 'invalid_overtime_distribution', path });
    return false;
  }
  if (value.kind === 'even') {
    if (!Number.isInteger(value.days) || (value.days as number) < 1 || (value.days as number) > 5) {
      issues.push({ code: 'invalid_overtime_distribution', path, params: { days: String(value.days) } });
      return false;
    }
    return true;
  }
  if (value.kind === 'explicit' && isRecord(value.byDay)) {
    let ok = true;
    for (const day of WEEKDAY_KEYS) {
      const hours = value.byDay[day];
      if (typeof hours !== 'number' || !Number.isFinite(hours)) {
        issues.push({ code: 'invalid_overtime_distribution', path, params: { day } });
        ok = false;
      } else if (hours < 0) {
        issues.push({ code: 'negative_hours', path, params: { day, value: hours } });
        ok = false;
      } else if (hours > 24) {
        issues.push({ code: 'day_hours_exceed_24', path, params: { day, value: hours } });
        ok = false;
      }
    }
    return ok;
  }
  issues.push({ code: 'invalid_overtime_distribution', path });
  return false;
}

function checkChoiceValue(path: ScenarioFieldPath, spec: ChoiceFieldSpec, value: unknown, issues: ScenarioIssue[]): boolean {
  if (path === 'work.overtimeDistribution') return checkDistribution(path, value, issues);
  if (spec.allowed && !(typeof value === 'string' && spec.allowed.includes(value))) {
    issues.push({ code: path === 'tax.loonheffingskorting' ? 'invalid_tax_credit_state' : 'invalid_choice_value', path });
    return false;
  }
  return true;
}

function checkField(path: ScenarioFieldPath, node: unknown, issues: ScenarioIssue[]): void {
  const spec = SCENARIO_FIELDS[path];
  if (!isRecord(node) || typeof node.state !== 'string') {
    issues.push({ code: 'malformed_value', path });
    return;
  }
  const state = node.state;

  if (state === 'unknown') return;

  if (state === 'conflict') {
    if (!Array.isArray(node.candidates) || node.candidates.length < 2) {
      issues.push({ code: 'conflict_too_few', path });
      return;
    }
    for (const candidate of node.candidates) {
      if (!isRecord(candidate)) {
        issues.push({ code: 'malformed_value', path });
        continue;
      }
      checkOrigin(path, candidate, issues);
      if (spec.kind === 'number') checkNumber(path, spec, candidate.value, issues);
      else checkChoiceValue(path, spec, candidate.value, issues);
    }
    return;
  }

  if (state === 'known') {
    checkOrigin(path, node, issues);
    if (spec.kind === 'number') checkNumber(path, spec, node.value, issues);
    else checkChoiceValue(path, spec, node.value, issues);
    return;
  }

  if (state === 'range' && spec.kind === 'number') {
    checkOrigin(path, node, issues);
    checkNumber(path, spec, node.low, issues);
    checkNumber(path, spec, node.high, issues);
    if (typeof node.low === 'number' && typeof node.high === 'number' && node.low > node.high) {
      issues.push({ code: 'range_inverted', path, params: { low: node.low, high: node.high } });
    }
    return;
  }

  if (state === 'alternatives' && spec.kind === 'choice') {
    checkOrigin(path, node, issues);
    if (!Array.isArray(node.options) || node.options.length < 2) {
      issues.push({ code: 'alternatives_too_few', path });
      return;
    }
    for (const option of node.options) checkChoiceValue(path, spec, option, issues);
    return;
  }

  issues.push({ code: 'malformed_value', path, params: { state } });
}

/** The known distribution of a choice value, when it is a single known one. */
function knownDistribution(value: unknown): OvertimeDistribution | null {
  return isRecord(value) && value.state === 'known' && isRecord(value.value) ? (value.value as unknown as OvertimeDistribution) : null;
}

function crossChecks(scenario: Record<string, unknown>, issues: ScenarioIssue[]): void {
  const regular = numericEndpoints(getAt(scenario, 'work.regularWeekdayHours'));
  const overtime = numericEndpoints(getAt(scenario, 'work.overtimeHours'));
  const sat = numericEndpoints(getAt(scenario, 'work.saturdayHours'));
  const sun = numericEndpoints(getAt(scenario, 'work.sundayHours'));
  const holiday = numericEndpoints(getAt(scenario, 'work.publicHolidayHours'));

  const high = (values: number[]) => (values.length === 0 ? 0 : Math.max(...values));
  const total = high(regular) + high(overtime) + high(sat) + high(sun) + high(holiday);
  if (total > WEEK_HOURS_CAP) {
    issues.push({ code: 'hours_exceed_week', path: 'work', params: { total, max: WEEK_HOURS_CAP } });
  }

  const distribution = knownDistribution(getAt(scenario, 'work.overtimeDistribution'));
  if (!distribution) return;
  const knownOvertime = getAt(scenario, 'work.overtimeHours');
  if (distribution.kind === 'explicit' && isRecord(knownOvertime) && knownOvertime.state === 'known' && typeof knownOvertime.value === 'number') {
    const sum = WEEKDAY_KEYS.reduce((acc, day) => acc + (distribution.byDay[day] ?? 0), 0);
    if (Math.abs(sum - knownOvertime.value) > DISTRIBUTION_TOLERANCE) {
      issues.push({ code: 'overtime_distribution_mismatch', path: 'work.overtimeDistribution', params: { distributed: sum, overtimeHours: knownOvertime.value } });
    }
  }
  // A day can never hold more than 24 h across its regular and overtime hours (allocation only - no pay).
  if (high(regular) <= 120 && high(overtime) <= 120) {
    const cells = expandWeekdayHours(high(regular), high(overtime), distribution);
    for (const day of WEEKDAY_KEYS) {
      const dayTotal = cells[day].regular + cells[day].overtime;
      if (dayTotal > 24 + DISTRIBUTION_TOLERANCE) {
        issues.push({ code: 'day_hours_exceed_24', path: 'work', params: { day, hours: dayTotal } });
      }
    }
  }
}

function structuralIssues(scenario: unknown, issues: ScenarioIssue[]): scenario is Record<string, unknown> {
  if (!isRecord(scenario)) {
    issues.push({ code: 'malformed_scenario', path: '' });
    return false;
  }
  if (scenario.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    issues.push({ code: 'unsupported_schema_version', path: 'schemaVersion', params: { received: String(scenario.schemaVersion) } });
  }
  if (typeof scenario.scenarioId !== 'string' || scenario.scenarioId.trim() === '') {
    issues.push({ code: 'malformed_scenario', path: 'scenarioId' });
  }
  if (scenario.periodType !== 'week') {
    issues.push({ code: 'unsupported_period_type', path: 'periodType', params: { received: String(scenario.periodType) } });
  }
  for (const section of ['work', 'pay', 'tax'] as const) {
    if (!isRecord(scenario[section])) issues.push({ code: 'malformed_scenario', path: section });
  }
  if (scenario.requestedConcepts !== undefined) {
    if (!Array.isArray(scenario.requestedConcepts)) {
      issues.push({ code: 'malformed_scenario', path: 'requestedConcepts' });
    } else {
      scenario.requestedConcepts.forEach((entry, index) => {
        const path = `requestedConcepts.${index}`;
        if (!isRecord(entry) || !isSource(entry.source)) issues.push({ code: 'malformed_source', path });
        else if (!(UNSUPPORTED_CONCEPTS as readonly string[]).includes(entry.concept as string)) issues.push({ code: 'unknown_requested_concept', path });
      });
    }
  }
  return true;
}

function missingReason(status: ReturnType<typeof valueStatus>): ScenarioRequirementReason | null {
  return status === 'present' ? null : status;
}

function collectRequirements(scenario: Record<string, unknown>): ScenarioRequirement[] {
  const out: ScenarioRequirement[] = [];
  const need = (field: ScenarioFieldPath) => {
    const reason = missingReason(valueStatus(getAt(scenario, field)));
    if (reason) out.push(requirement(field, reason));
  };
  const asNumber = (field: ScenarioFieldPath) => getAt(scenario, field) as Parameters<typeof hoursRelevance>[0];

  const hoursFields = ['work.regularWeekdayHours', 'work.overtimeHours', 'work.saturdayHours', 'work.sundayHours', 'work.publicHolidayHours'] as const;
  const relevance = Object.fromEntries(hoursFields.map((f) => [f, hoursRelevance(asNumber(f))])) as Record<(typeof hoursFields)[number], ReturnType<typeof hoursRelevance>>;

  // A work-hours field that is present but unresolved is itself the requirement.
  for (const field of hoursFields) {
    const reason = missingReason(valueStatus(getAt(scenario, field)));
    if (reason && reason !== 'missing') out.push(requirement(field, reason));
  }
  if (hoursFields.every((f) => relevance[f] === 'none') && !out.some((r) => r.field.startsWith('work.'))) {
    out.push(requirement('work.hours', 'missing'));
  }

  need('pay.hourlyRate');

  if (relevance['work.saturdayHours'] === 'some') need('pay.saturdayPremiumPercent');
  if (relevance['work.sundayHours'] === 'some') need('pay.sundayPremiumPercent');
  if (relevance['work.publicHolidayHours'] === 'some') need('pay.publicHolidayPremiumPercent');

  if (relevance['work.overtimeHours'] === 'some') {
    need('pay.overtime.thresholdHoursPerDay');
    need('pay.overtime.tier1Percent');
    need('work.overtimeDistribution');
    // tier-2 percent is required only if the engine's own per-day tiering produces tier-2 hours -
    // the engine reports that itself (`engine_requires`); the Scenario layer does not duplicate it.
  }

  need('tax.loonheffingskorting');
  need('deductions.mode');

  const mode = getAt(scenario, 'deductions.mode');
  const modeStatus = valueStatus(mode);
  const modeValues: unknown[] = isRecord(mode) && mode.state === 'known' ? [mode.value] : isRecord(mode) && mode.state === 'alternatives' && Array.isArray(mode.options) ? mode.options : [];
  if (modeStatus === 'present' && modeValues.includes('enter')) {
    need('deductions.entered.pension');
    need('deductions.entered.paww');
    need('deductions.entered.sectorPremium');
  }
  for (const optional of ['deductions.entered.postTaxOther', 'extras.travelAllowance'] as const) {
    const reason = missingReason(valueStatus(getAt(scenario, optional)));
    if (reason && reason !== 'missing') out.push(requirement(optional, reason));
  }

  const vakantiegeldMode = getAt(scenario, 'extras.vakantiegeld.mode');
  if (isRecord(getAt(scenario, 'extras.vakantiegeld'))) {
    need('extras.vakantiegeld.mode');
    const vModes: unknown[] = isRecord(vakantiegeldMode) && vakantiegeldMode.state === 'known' ? [vakantiegeldMode.value] : isRecord(vakantiegeldMode) && vakantiegeldMode.state === 'alternatives' && Array.isArray(vakantiegeldMode.options) ? vakantiegeldMode.options : [];
    if (vModes.includes('accruing')) need('extras.vakantiegeld.percent');
  }
  return out;
}

function collectWarnings(scenario: Record<string, unknown>): ScenarioWarning[] {
  const out: ScenarioWarning[] = [];
  const present = (path: ScenarioFieldPath) => valueStatus(getAt(scenario, path)) !== 'missing';
  const rel = (path: ScenarioFieldPath) => hoursRelevance(getAt(scenario, path) as Parameters<typeof hoursRelevance>[0]);

  const premiumPairs: Array<[ScenarioFieldPath, ScenarioFieldPath]> = [
    ['pay.saturdayPremiumPercent', 'work.saturdayHours'],
    ['pay.sundayPremiumPercent', 'work.sundayHours'],
    ['pay.publicHolidayPremiumPercent', 'work.publicHolidayHours'],
  ];
  for (const [premium, hours] of premiumPairs) {
    if (present(premium) && rel(hours) === 'none') out.push({ code: 'irrelevant_value_ignored', path: premium });
  }
  if (rel('work.overtimeHours') === 'none') {
    for (const field of ['pay.overtime.thresholdHoursPerDay', 'pay.overtime.tier1Percent', 'pay.overtime.tier2Percent', 'work.overtimeDistribution'] as const) {
      if (present(field)) out.push({ code: 'irrelevant_value_ignored', path: field });
    }
  }
  const mode = getAt(scenario, 'deductions.mode');
  if (isRecord(mode) && mode.state === 'known' && mode.value === 'estimate') {
    for (const field of ['deductions.entered.pension', 'deductions.entered.paww', 'deductions.entered.sectorPremium', 'deductions.entered.postTaxOther'] as const) {
      if (present(field)) out.push({ code: 'irrelevant_value_ignored', path: field });
    }
  }
  return out;
}

export function validateScenario(scenario: unknown): ScenarioValidation {
  const issues: ScenarioIssue[] = [];
  if (!structuralIssues(scenario, issues)) return { status: 'invalid', issues, requirements: [], warnings: [] };

  for (const path of SCENARIO_FIELD_PATHS) {
    const node = getAt(scenario, path);
    if (node !== undefined) checkField(path, node, issues);
  }
  if (issues.length === 0) crossChecks(scenario, issues);

  if (issues.length > 0) return { status: 'invalid', issues, requirements: [], warnings: [] };

  const requirements = collectRequirements(scenario);
  const warnings = collectWarnings(scenario);
  return { status: requirements.length > 0 ? 'blocked' : 'ready', issues: [], requirements, warnings };
}
