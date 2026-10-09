/**
 * The ONE place for the Scenario Core's policy constants.
 *
 * Range materiality (LOONTO-ARCHITECTURE-UX-LOCK-v1.1 §10): a result range is retained only when the
 * deterministic payout swing is at least EUR 5 OR at least 1% of the net payout - "whichever is
 * greater", i.e. the threshold is the LARGER of the two. This is a presentation/decision policy, not
 * payroll mathematics: the swing is the difference between payouts the ENGINE already produced.
 */
export const RANGE_MATERIALITY = {
  absoluteSwingEur: 5,
  relativeSwing: 0.01,
} as const;

/** Upper bound on separate deterministic engine runs for one evaluation (corner combinations of
 * ranges/alternatives, plus one central run). Beyond it the evaluation is `unsupported`
 * (too_many_variants) rather than approximated. */
export const MAX_VARIANT_RUNS = 16;

/** The threshold a swing must reach to be material, for a given reference payout. */
export function rangeMaterialityThreshold(referencePayout: number): number {
  return Math.max(RANGE_MATERIALITY.absoluteSwingEur, Math.abs(referencePayout) * RANGE_MATERIALITY.relativeSwing);
}
