/**
 * §5c - several employers at once (audit "SEVERAL EMPLOYERS AT ONCE" round, parts CN/CO/CP/CQ).
 *
 * ============================================================================================
 * CN1 - THIS IS NOT THE OTTO CASE. OTTO Workforce is ONE employer with TWO hirers - one payroll, one
 * payslip, two workplaces. The existing employer/hirer split on PayslipPeriod already covers that;
 * nothing here changes it. This file covers genuinely separate employers: two contracts, two
 * payrolls, two payslips, possibly on the same day. We hold no reference document for this case
 * (CN1's own words) - everything below is reasoning from the rules, not observation, and must be
 * checked against a real document before it is trusted the way the four single-employer reference
 * fixtures are.
 * ============================================================================================
 *
 * CO1 (never pool hours) / CO3 (franchise applies once per employment) need NO new code here: the
 * existing model already computes one PayslipPeriod per employer (an Employer[] of length 1 in the
 * true multi-employer case, unlike OTTO's length-2 same-payroll case) and franchise_bearing is
 * already a per-employer field. The requirement is architectural discipline at the CALLER
 * (tier-a.ts/tier-c.ts, not yet updated to build several periods per worker) - build N independent
 * PayslipPeriod objects and run computePayslipPeriod() once per period, then aggregate RESULTS, never
 * pool inputs before computing. This file provides that aggregation step and CO4's enforcement; it
 * does not itself change how a single PayslipPeriod is built.
 *
 * CO2 (overtime threshold per employer) is enforced by hour-grid.ts's
 * convertMultiEmployerHourGrid() - one threshold per employer, never summed hours before applying it.
 */

import type { PayslipComputationOutcome } from './payslip-model.js';
import type { EmployerId } from './hour-grid.js';

export type { EmployerId };

/**
 * CO4 - the significant consequence. Verified against a primary source before writing any of this
 * (CO5): Belastingdienst's own page states outright "U mag de loonheffingskorting maar op 1 inkomen
 * toepassen" ("You may only apply the wage tax credit to 1 income") -
 * https://www.belastingdienst.nl/wps/wcm/connect/nl/werk-en-inkomen/content/loonheffingskorting-hoe-vraag-ik-die-aan
 * (fetched and quoted directly this round, not reasoned from memory - this project has twice reached
 * a wrong conclusion by reasoning where a document then contradicted it: jaarloon_bt, the StiPP base).
 *
 * Applying the credit at more than one employer understates tax at both and overstates net
 * substantially - the same direction and magnitude of error as the 8% overstatement this entire
 * restructure exists to fix (spec §0). This is a hard refusal, not a warning.
 *
 * Per-employer claim state mirrors the model's own provenance rule (spec §1): `true` (claimed here),
 * `false` (explicitly not claimed here), or `'unknown'` (not yet stated by the user). `'unknown'`
 * never defaults to the first employer, per CO4's explicit requirement - the interface must ask.
 */
export type LoonheffingskortingClaim = true | false | 'unknown';

export type LoonheffingskortingAssignmentResult =
  | { status: 'unknown'; employers_unassigned: EmployerId[] }
  | { status: 'invalid'; employers_claiming: EmployerId[] } // more than one - refused, never silently resolved to "the first one"
  | { status: 'valid'; employer_claiming: EmployerId | null }; // null = no employer claims it (all explicitly false) - valid, if unusual

export function resolveLoonheffingskortingAssignment(claims: Record<EmployerId, LoonheffingskortingClaim>): LoonheffingskortingAssignmentResult {
  const employerIds = Object.keys(claims);
  const claiming = employerIds.filter((id) => claims[id] === true);
  const unassigned = employerIds.filter((id) => claims[id] === 'unknown');

  if (claiming.length > 1) {
    return { status: 'invalid', employers_claiming: claiming };
  }
  if (unassigned.length > 0) {
    return { status: 'unknown', employers_unassigned: unassigned };
  }
  return { status: 'valid', employer_claiming: claiming[0] ?? null };
}

/**
 * ============================================================================================
 * CP - THE UNTESTED TABLE COLUMN. Every one of the four reference fixtures has the credit applied
 * ("met loonheffingskorting"). The engine's own heffingskortingen() (payslip-model.ts) has no concept
 * of a credit toggle at all - it unconditionally computes and subtracts algemene_heffingskorting and
 * arbeidskorting every time. A "zonder loonheffingskorting" employer (every employer past the first
 * one, per CO4) needs a DIFFERENT computation path this engine does not have, and CP2 is explicit that
 * it cannot ship uncalibrated: neither a real payslip without the credit applied, nor the official
 * Belastingdienst table for that column, was available this round to calibrate against.
 *
 * Per CP3's own instruction, this is stated rather than silently guessed: any second-employer
 * projection this round MUST mark its figure uncalibrated or refuse to produce one. No "zonder"
 * computation path exists yet - do not build one from reasoning alone the way the credit's
 * ELIGIBILITY rule was (that one has a citable primary source; the "zonder" table's actual withheld
 * amounts do not, yet).
 * ============================================================================================
 */
export interface SecondEmployerTaxComputation {
  status: 'uncalibrated';
  reason: 'zonder_loonheffingskorting_table_not_calibrated';
}

/**
 * CQ - combined income and the annual return. Each employer withholds as though its own payment were
 * the worker's only income; combined, tax brackets and credit phase-outs mean this usually
 * under-withholds relative to what total income actually owes, settled the following year in the
 * annual return (aangifte). CQ1 is explicit: do not attempt to compute that settlement - name it.
 * This is a STATEMENT to surface next to any multi-employer projection, not a computation - there is
 * deliberately no numeric output here.
 */
export const COMBINED_INCOME_ANNUAL_RETURN_NOTICE =
  'Elke werkgever houdt belasting in alsof zijn betaling je enige inkomen is. Bij meerdere werkgevers ' +
  'tegelijk leidt dat meestal tot te weinig ingehouden belasting over het totaal - het verschil wordt ' +
  'verrekend in de aangifte inkomstenbelasting. Dit bedrag wordt hier niet berekend.';

/**
 * CO1's aggregation step: combines N independently-computed outcomes (one per employer, each already
 * run through computePayslipPeriod() on its OWN PayslipPeriod - never pooled hours) into the combined
 * view the worker actually wants ("what lands in my account, in total, this period"). Only combines
 * figures that are safe to sum post-computation (net payout per employer) - it does not touch
 * gross/taxable-base/tax internals, which stay per-employer and are never combined.
 */
export interface CombinedMultiEmployerView {
  per_employer_payout: Record<EmployerId, number | null>; // null when that employer's own outcome was 'incomplete'
  combined_payout: number | null; // null if ANY employer's outcome was incomplete - a partial sum would misstate what's actually known
  annual_return_notice: string;
}

export function combineMultiEmployerOutcomes(outcomes: Record<EmployerId, PayslipComputationOutcome>): CombinedMultiEmployerView {
  const perEmployerPayout: Record<EmployerId, number | null> = {};
  let anyIncomplete = false;
  let total = 0;

  for (const [employerId, outcome] of Object.entries(outcomes)) {
    if (outcome.status === 'complete') {
      perEmployerPayout[employerId] = outcome.result.payout_amount;
      total += outcome.result.payout_amount;
    } else {
      perEmployerPayout[employerId] = null;
      anyIncomplete = true;
    }
  }

  return {
    per_employer_payout: perEmployerPayout,
    combined_payout: anyIncomplete ? null : Math.round(total * 100) / 100,
    annual_return_notice: COMBINED_INCOME_ANNUAL_RETURN_NOTICE,
  };
}
