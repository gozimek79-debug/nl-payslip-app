import type { ScenarioFieldPath } from '../scenario/scenario-types.js';

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
