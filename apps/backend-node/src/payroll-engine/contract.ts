import { getCurrentRule } from '../rules-repository.js';

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
  /** Nazwy pól, które zostały odrzucone/wyzerowane po stronie serwera, bo wyglądały na dane osobowe. */
  redactedFields: string[];
}

export interface ContractFlag {
  level: 'info' | 'warning';
  message: string;
}

export interface ContractAnalysis {
  minimumWageAtStart: number | null;
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
 * Sprawdza umowę WYŁĄCZNIE pod kątem pól istotnych dla wynagrodzenia — nie ocenia treści prawnej
 * całościowo i nie zastępuje porady prawnej. Reguły (okres próbny wg art. 7:652 BW, okres
 * wypowiedzenia wg art. 7:672 BW) pochodzą z bazy referencyjnej `legal_rules` — patrz
 * rules-repository.ts — z bezpiecznym fallbackiem na stałe w kodzie, gdyby baza była niedostępna.
 */
export async function analyzeContract(extraction: ContractExtraction, minimumWagePerHour: number): Promise<ContractAnalysis> {
  const flags: ContractFlag[] = [];

  let isBelowMinimumWage: boolean | null = null;
  if (extraction.hourlyRate !== null) {
    isBelowMinimumWage = extraction.hourlyRate < minimumWagePerHour;
    if (isBelowMinimumWage) {
      flags.push({ level: 'warning', message: `Stawka godzinowa (€${extraction.hourlyRate}) jest poniżej wettelijk minimumloon (€${minimumWagePerHour}).` });
    }
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

  const proeftijd = (await getCurrentRule<ProeftijdRules>('arbeidsrecht_proeftijd')) ?? STATIC_PROEFTIJD;
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
    const opzegtermijn = (await getCurrentRule<OpzegtermijnRules>('arbeidsrecht_opzegtermijn_werkgever')) ?? STATIC_OPZEGTERMIJN;
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
    isBelowMinimumWage,
    maxAllowedProbationWeeks,
    probationExceedsLimit,
    minimumEmployerNoticeWeeks,
    noticePeriodBelowStatutory,
    flags,
  };
}
