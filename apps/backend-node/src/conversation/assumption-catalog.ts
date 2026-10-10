import { SCENARIO_FIELD_PATHS, type ScenarioFieldPath } from '../scenario/scenario-types.js';
import { canonicalJson, getAt, isRecord } from '../scenario/scenario-util.js';

/**
 * The catalogue of explicit Loonto assumptions (LOONTO-ARCHITECTURE-UX-LOCK-v1.1 §9, §9.1, §33).
 *
 * This is the ONLY place an assumption value comes from. Neither the user nor the LLM can choose an
 * assumption's value or source: accepting an offer is `accept_assumption {field}`, and the server writes
 * exactly the catalogued entry with `source: 'loonto_assumption'`. An accepted assumption stays an
 * assumption - user acceptance never turns it into a verified fact (RT-001), and it is reported in R1's
 * `assumptionsUsed` on every evaluation.
 *
 * Contents are deliberately small:
 *   - the Lock's orientation premiums (Saturday +50%, Sunday +100%, public holiday +100%) - these are NOT
 *     universal Dutch rules and are never presented as facts;
 *   - deductions: R1's own `estimate` mode (the engine's sourced population defaults - no percent->EUR
 *     maths is invented here);
 *   - loonheffingskorting: never assumed (high impact, Lock §33) - instead BOTH variants are computed, so
 *     the evaluation shows the deterministic range.
 */
export type AssumptionEntry =
  | { kind: 'value'; value: number | string }
  | { kind: 'alternatives'; options: readonly string[] };

export const ASSUMPTION_CATALOG: Partial<Record<ScenarioFieldPath, AssumptionEntry>> = {
  'pay.saturdayPremiumPercent': { kind: 'value', value: 50 },
  'pay.sundayPremiumPercent': { kind: 'value', value: 100 },
  'pay.publicHolidayPremiumPercent': { kind: 'value', value: 100 },
  'deductions.mode': { kind: 'value', value: 'estimate' },
  'tax.loonheffingskorting': { kind: 'alternatives', options: ['applied', 'not_applied'] },
};

export function assumptionFor(field: string): AssumptionEntry | undefined {
  return Object.prototype.hasOwnProperty.call(ASSUMPTION_CATALOG, field) ? ASSUMPTION_CATALOG[field as ScenarioFieldPath] : undefined;
}

/** The Scenario value node an accepted assumption becomes. */
export function assumptionNode(entry: AssumptionEntry): Record<string, unknown> {
  return entry.kind === 'value'
    ? { state: 'known', value: entry.value, source: 'loonto_assumption' }
    : { state: 'alternatives', options: [...entry.options], source: 'loonto_assumption' };
}

/**
 * F3: every `loonto_assumption` in a client-carried Scenario must be EXACTLY the server's own catalogued
 * node for that field (deep-equal: same state, value / options in the same order, no `ref`, nothing extra).
 * Anything else was minted by the caller - authority laundering - and the turn is rejected; it is never
 * downgraded to `user`. Conflict candidates and requested concepts never carry a Loonto assumption.
 */
export function findForgedAssumptions(scenario: unknown): Array<{ field: string; reason: 'not_in_catalog' | 'not_canonical' }> {
  const out: Array<{ field: string; reason: 'not_in_catalog' | 'not_canonical' }> = [];
  for (const field of SCENARIO_FIELD_PATHS) {
    const node = getAt(scenario, field);
    if (!isRecord(node)) continue;
    if (node.state === 'conflict' && Array.isArray(node.candidates)) {
      if (node.candidates.some((c) => isRecord(c) && c.source === 'loonto_assumption')) out.push({ field, reason: 'not_canonical' });
      continue;
    }
    if (node.source !== 'loonto_assumption') continue;
    const entry = assumptionFor(field);
    if (!entry) out.push({ field, reason: 'not_in_catalog' });
    else if (canonicalJson(node) !== canonicalJson(assumptionNode(entry))) out.push({ field, reason: 'not_canonical' });
  }
  const concepts = isRecord(scenario) && Array.isArray(scenario.requestedConcepts) ? scenario.requestedConcepts : [];
  concepts.forEach((entry, index) => {
    if (isRecord(entry) && entry.source === 'loonto_assumption') out.push({ field: `requestedConcepts.${index}`, reason: 'not_in_catalog' });
  });
  return out;
}
