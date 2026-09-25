import { getRuleAt } from '../rules-repository.js';

export interface ContractExtraction {
  contractType: string | null;
  employerName: string | null;
  functionTitle: string | null;
  startDate: string | null;
  endDate: string | null;
  hoursPerWeek: number | null;
  hourlyRate: number | null;
  monthlySalary: number | null;
  caoName: string | null;
  pensionFund: string | null;
  probationPeriodWeeks: number | null;
  noticePeriodWeeks: number | null;
  thirtyPercentRuling: boolean;
  /** Tier B (audit "CONSOLIDATED ASSIGNMENT" round, §3.3): the ONE new field this round adds, and
   * deliberately the only one. Checked against a real reference contract (Olympia's own Fase A
   * agreement) before being added, per §2.2/§2.3 - that document lists overtime PERCENTAGE tiers
   * (Overwerkuren 130/150/200%, Onregelmatige uren 20/50/75/100/200%) but never states the HOUR
   * boundary between them; hour-grid.ts's own `contract_stated` provenance slot on
   * OvertimeTierThreshold has existed since last round with nothing feeding it. This field is that
   * feed - stays null when a contract doesn't state it (confirmed: the one real document checked
   * does not), never guessed from the percentage list alone. Weekend/Saturday/Sunday percentages are
   * NOT added here yet - the same real document doesn't state them in a day-bound form either (its
   * percentages are generic tiers, not "Saturday = X%"), and one document isn't enough evidence to
   * design that schema without guessing its shape (§2.4). */
  overtimeTierThresholdHours: number | null;
  /** 2.0c (audit "CONSOLIDATED ASSIGNMENT" v8): Art. 2.4 of the real Olympia contract states a real
   * entitlement the model had no field for - "64,00 hours per 4 weken" payable even if the hirer
   * offers fewer hours (a guarantee, distinct from `hoursPerWeek` which is just a rate/scheduling
   * figure with no such backing). Field added now so PRO can use it later; the check itself (worked
   * hours against this guarantee) is explicitly deferred, not built this round. */
  guaranteedHours: number | null;
  guaranteedHoursPeriodWeeks: number | null;
  /** Nazwy pól, które zostały odrzucone/wyzerowane po stronie serwera, bo wyglądały na dane osobowe. */
  redactedFields: string[];
}

export interface ContractFlag {
  level: 'info' | 'warning';
  message: string;
}

export interface ContractAnalysis {
  minimumWageAtStart: number | null;
  /** false only when there is not enough data (no hourly rate, or no monthly salary + weekly
   * hours to derive one) to compute an hourly-equivalent wage at all. Never conflate this with
   * "compliant" — the frontend must render "unable to verify", not silently omit the check. */
  minimumWageVerifiable: boolean;
  isBelowMinimumWage: boolean | null;
  maxAllowedProbationWeeks: number | null;
  probationExceedsLimit: boolean | null;
  minimumEmployerNoticeWeeks: number | null;
  noticePeriodBelowStatutory: boolean | null;
  flags: ContractFlag[];
}

interface ProeftijdRules {
  max_weeks_short_contract: number;
  short_contract_threshold_months: number;
  max_weeks_long_contract: number;
}

interface OpzegtermijnRules {
  tiers: Array<{ max_years: number; months: number }>;
}

const STATIC_PROEFTIJD: ProeftijdRules = { max_weeks_short_contract: 4.3, short_contract_threshold_months: 24, max_weeks_long_contract: 8.7 };
const STATIC_OPZEGTERMIJN: OpzegtermijnRules = {
  tiers: [
    { max_years: 5, months: 1 },
    { max_years: 10, months: 2 },
    { max_years: 15, months: 3 },
    { max_years: 999, months: 4 },
  ],
};
const WEEKS_PER_MONTH = 4.33;

/**
 * ============================================================================================
 * 2.0b (audit "CONSOLIDATED ASSIGNMENT" v8) - PLAUSIBILITY BOUNDS, a failure mode tolerance design
 * cannot reach. The live model read the real contract's "64 hours per 4 weeks" as something that
 * came out unit-wrong and period-wrong - digits right, everything else not. No tolerance check
 * catches that, because the digits ARE right; this is §2.1's "unknown, never zero" rule applied to
 * a different failure class: a value that is confidently, precisely WRONG, not merely absent.
 *
 * `hoursPerWeek` <= 168 (24h x 7 days - the actual physical ceiling, not a labour-law figure) and
 * `hourlyRate` <= 200 are implausibility screens, not statutory bounds - they exist to catch a unit/
 * period confusion in the reading, not to encode a legal maximum. 200 EUR/hour has no source and
 * needs none: it is a "this cannot be right" backstop for THIS product's population (agency/temp
 * workers), not a claim about what any real contract could legally state.
 *
 * Hours-per-day (<=24) and days-per-week (<=7) bounds already exist structurally elsewhere - the
 * Tier A hour grid's own zod schema caps regular/overtime hours at 24 per cell
 * (tier-a.controller.ts's dayHoursSchema), and the grid's fixed 7-day shape makes a days-per-week
 * bound automatic. Contract extraction has no per-day/per-week grid, only aggregate hoursPerWeek -
 * these two bounds are the ones actually missing, and the only ones added here.
 * ============================================================================================
 */
export interface ImplausibleField {
  field: 'hoursPerWeek' | 'hourlyRate';
  extractedValue: number;
  code: 'exceeds_physical_hours_per_week' | 'exceeds_plausible_hourly_rate';
  bound: number;
}

const MAX_PLAUSIBLE_HOURS_PER_WEEK = 168; // 24 x 7 - a physical ceiling, not a labour-law figure
const MAX_PLAUSIBLE_HOURLY_RATE = 200; // an implausibility screen for this product's population, not a legal maximum

/**
 * Checks raw extraction against the bounds above and returns what to flag - does NOT mutate the
 * extraction itself. The caller (contract.controller.ts) is responsible for nulling the flagged
 * field before it reaches anything downstream (analyzeContract's minimum-wage math, a Tier A
 * pre-fill) and for surfacing the question this implies (stage 1's middle-band pattern: a plausible
 * misread asks, it does not silently get used and does not silently get discarded either).
 */
export function checkContractPlausibility(extraction: Pick<ContractExtraction, 'hoursPerWeek' | 'hourlyRate'>): ImplausibleField[] {
  const flags: ImplausibleField[] = [];
  if (extraction.hoursPerWeek !== null && extraction.hoursPerWeek > MAX_PLAUSIBLE_HOURS_PER_WEEK) {
    flags.push({ field: 'hoursPerWeek', extractedValue: extraction.hoursPerWeek, code: 'exceeds_physical_hours_per_week', bound: MAX_PLAUSIBLE_HOURS_PER_WEEK });
  }
  if (extraction.hourlyRate !== null && extraction.hourlyRate > MAX_PLAUSIBLE_HOURLY_RATE) {
    flags.push({ field: 'hourlyRate', extractedValue: extraction.hourlyRate, code: 'exceeds_plausible_hourly_rate', bound: MAX_PLAUSIBLE_HOURLY_RATE });
  }
  return flags;
}

/**
 * Stage 3.0 (audit v40, §3.0.3): "a sense check on hours-per-period, within a stated range - this
 * is what would have caught the documented live error (64 hours per 4 weeks read as 64 hours per
 * week)." `guaranteedHours`/`guaranteedHoursPeriodWeeks` is a PAIR - the same digits (64) are
 * correct in both the real document and the misread; only the PERIOD unit was wrong. The bound has
 * to be about what the pair IMPLIES (hours per week = guaranteedHours / guaranteedHoursPeriodWeeks),
 * not either field alone - `checkContractPlausibility`'s own `hoursPerWeek` bound (168, a physical
 * ceiling) cannot see this at all, since that field is a different one and 64 alone is far below it
 * anyway.
 *
 * §2.2 applies here as much as anywhere else: checked against the actual statute rather than
 * reasoned toward - Arbeidstijdenwet art. 5:7 lid 2 (confirmed via Rijksoverheid.nl,
 * https://www.rijksoverheid.nl/vraag-en-antwoord/werktijden/wettelijke-regels-werktijden-en-rusttijden,
 * checked 2026-09-25): an employee of 18+ may work "maximaal 60 uur per week" in ANY single week -
 * an absolute ceiling that no CAO or company regulation may ever exceed ("u mag nooit meer dan 60
 * uur per week werken"), independent of the averaging period (55/week over 4 weeks, 48/week over 16
 * weeks are STRICTER long-run averages, not weaker - never usable as a looser bound here, since a
 * period-length misread could make the implied per-week figure land anywhere). 60, not the 168 used
 * for `hoursPerWeek` above, because THIS check targets the specific unit/period-confusion failure
 * mode 2.0b names, not a bare physical impossibility - 64 > 60 is legally impossible for a single
 * week under any circumstance, which is exactly the signal a genuine "64 per 4 weeks" misread as
 * "64 per week" produces, while 64 hours spread over 4 weeks (16/week) is ordinary and unflagged.
 */
export interface ImplausibleHoursPerPeriod {
  field: 'guaranteedHours';
  guaranteedHours: number;
  guaranteedHoursPeriodWeeks: number;
  impliedHoursPerWeek: number;
  code: 'exceeds_legal_hours_per_week';
  bound: number;
}

const MAX_LEGAL_HOURS_PER_WEEK = 60; // Arbeidstijdenwet art. 5:7 lid 2 - see doc comment above

export function checkHoursPerPeriodPlausibility(extraction: Pick<ContractExtraction, 'guaranteedHours' | 'guaranteedHoursPeriodWeeks'>): ImplausibleHoursPerPeriod[] {
  const { guaranteedHours, guaranteedHoursPeriodWeeks } = extraction;
  if (guaranteedHours === null || guaranteedHoursPeriodWeeks === null || guaranteedHoursPeriodWeeks <= 0) return [];
  const impliedHoursPerWeek = guaranteedHours / guaranteedHoursPeriodWeeks;
  if (impliedHoursPerWeek > MAX_LEGAL_HOURS_PER_WEEK) {
    return [{
      field: 'guaranteedHours',
      guaranteedHours,
      guaranteedHoursPeriodWeeks,
      impliedHoursPerWeek: Math.round(impliedHoursPerWeek * 100) / 100,
      code: 'exceeds_legal_hours_per_week',
      bound: MAX_LEGAL_HOURS_PER_WEEK,
    }];
  }
  return [];
}

/**
 * Derives an hourly-equivalent wage from whatever the contract actually states. Per audit
 * requirement D1: the check must be `period_wage / period_hours >= hourly WML`, computed from a
 * monthly salary when no hourly rate is stated — a contract with a monthly salary but no stated
 * weekly hours cannot be converted to an hourly rate at all, and must be reported as
 * unverifiable, never silently treated as compliant.
 */
function estimateHourlyRate(extraction: Pick<ContractExtraction, 'hourlyRate' | 'monthlySalary' | 'hoursPerWeek'>): number | null {
  if (extraction.hourlyRate !== null) return extraction.hourlyRate;
  if (extraction.monthlySalary !== null && extraction.hoursPerWeek !== null && extraction.hoursPerWeek > 0) {
    return extraction.monthlySalary / (extraction.hoursPerWeek * WEEKS_PER_MONTH);
  }
  return null;
}

/**
 * A contract is a historical document: the statutory limits that applied to it are the ones in
 * force on its start date, not whichever version happens to be current today. Falls back to today
 * only when the AI could not read a usable start date at all (extraction failure, not a design
 * choice) — every legal_rule lookup below must go through this, per audit requirement B2.
 */
export function resolveReferenceDate(extraction: Pick<ContractExtraction, 'startDate'>): Date {
  if (extraction.startDate) {
    const parsed = new Date(extraction.startDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * Sprawdza umowę WYŁĄCZNIE pod kątem pól istotnych dla wynagrodzenia — nie ocenia treści prawnej
 * całościowo i nie zastępuje porady prawnej. Reguły (okres próbny wg art. 7:652 BW, okres
 * wypowiedzenia wg art. 7:672 BW) pochodzą z bazy referencyjnej `legal_rules` — patrz
 * rules-repository.ts — z bezpiecznym fallbackiem na stałe w kodzie, gdyby baza była niedostępna.
 * Reguły są odczytywane na dzień rozpoczęcia umowy (resolveReferenceDate), nie na dziś.
 */
export async function analyzeContract(extraction: ContractExtraction, minimumWagePerHour: number | null): Promise<ContractAnalysis> {
  const referenceDate = resolveReferenceDate(extraction);
  const flags: ContractFlag[] = [];

  // `minimumWagePerHour` is null when getMinimumWageAt() itself couldn't answer for today (audit
  // S1: rules DB unreachable AND the static fallback's period file doesn't cover today either) -
  // distinct from "the contract has no derivable rate" below, but both collapse to the same
  // unverifiable result, since a comparison needs both sides.
  let isBelowMinimumWage: boolean | null = null;
  const effectiveHourlyRate = estimateHourlyRate(extraction);
  const minimumWageVerifiable = effectiveHourlyRate !== null && minimumWagePerHour !== null;
  if (effectiveHourlyRate !== null && minimumWagePerHour !== null) {
    isBelowMinimumWage = effectiveHourlyRate < minimumWagePerHour;
    if (isBelowMinimumWage) {
      const rateDescription = extraction.hourlyRate !== null
        ? `€${extraction.hourlyRate}`
        : `ok. €${effectiveHourlyRate.toFixed(2)} (przeliczone z wynagrodzenia miesięcznego)`;
      flags.push({ level: 'warning', message: `Stawka godzinowa (${rateDescription}) jest poniżej wettelijk minimumloon (€${minimumWagePerHour}).` });
    }
  } else if (effectiveHourlyRate === null) {
    flags.push({ level: 'warning', message: 'Nie można zweryfikować zgodności z płacą minimalną — w umowie brak stawki godzinowej, a przy wynagrodzeniu miesięcznym brak liczby godzin w tygodniu potrzebnej do przeliczenia.' });
  } else {
    flags.push({ level: 'warning', message: 'Nie można zweryfikować zgodności z płacą minimalną — aktualna stawka ustawowa jest chwilowo niedostępna (baza reguł i plik zapasowy). Spróbuj ponownie później.' });
  }

  let durationMonths: number | null = null;
  const isIndefinite = extraction.contractType?.toLowerCase().includes('onbepaald') ?? false;
  if (!isIndefinite && extraction.startDate && extraction.endDate) {
    const start = new Date(extraction.startDate);
    const end = new Date(extraction.endDate);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      durationMonths = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    }
  }

  const proeftijd = (await getRuleAt<ProeftijdRules>('arbeidsrecht_proeftijd', referenceDate)) ?? STATIC_PROEFTIJD;
  const maxAllowedProbationWeeks = isIndefinite || (durationMonths !== null && durationMonths >= proeftijd.short_contract_threshold_months)
    ? proeftijd.max_weeks_long_contract
    : proeftijd.max_weeks_short_contract;
  let probationExceedsLimit: boolean | null = null;
  if (extraction.probationPeriodWeeks !== null) {
    probationExceedsLimit = extraction.probationPeriodWeeks > maxAllowedProbationWeeks;
    if (probationExceedsLimit) {
      flags.push({ level: 'warning', message: `Okres próbny (${extraction.probationPeriodWeeks} tyg.) może przekraczać ustawowy limit dla tego typu umowy (maks. ${maxAllowedProbationWeeks} tyg.).` });
    }
  }

  let minimumEmployerNoticeWeeks: number | null = null;
  let noticePeriodBelowStatutory: boolean | null = null;
  if (durationMonths !== null || isIndefinite) {
    const opzegtermijn = (await getRuleAt<OpzegtermijnRules>('arbeidsrecht_opzegtermijn_werkgever', referenceDate)) ?? STATIC_OPZEGTERMIJN;
    const tenureYears = durationMonths !== null ? durationMonths / 12 : 0;
    const tier = opzegtermijn.tiers.find((item) => tenureYears <= item.max_years) ?? opzegtermijn.tiers[opzegtermijn.tiers.length - 1];
    minimumEmployerNoticeWeeks = Math.round((tier?.months ?? 1) * WEEKS_PER_MONTH * 10) / 10;
    if (extraction.noticePeriodWeeks !== null) {
      noticePeriodBelowStatutory = extraction.noticePeriodWeeks < minimumEmployerNoticeWeeks;
      if (noticePeriodBelowStatutory) {
        flags.push({ level: 'warning', message: `Okres wypowiedzenia przez pracodawcę (${extraction.noticePeriodWeeks} tyg.) wygląda na krótszy niż ustawowe minimum dla tego stażu (ok. ${minimumEmployerNoticeWeeks} tyg.).` });
      }
    }
  }

  if (!extraction.caoName) {
    flags.push({ level: 'info', message: 'Nie znaleziono nazwy układu zbiorowego (CAO) — sprawdź, czy Twoja umowa się do niego odwołuje.' });
  }
  if (!extraction.pensionFund) {
    flags.push({ level: 'info', message: 'Nie znaleziono informacji o funduszu emerytalnym.' });
  }
  if (extraction.noticePeriodWeeks === null) {
    flags.push({ level: 'info', message: 'Nie znaleziono okresu wypowiedzenia.' });
  }

  return {
    minimumWageAtStart: minimumWagePerHour,
    minimumWageVerifiable,
    isBelowMinimumWage,
    maxAllowedProbationWeeks,
    probationExceedsLimit,
    minimumEmployerNoticeWeeks,
    noticePeriodBelowStatutory,
    flags,
  };
}
