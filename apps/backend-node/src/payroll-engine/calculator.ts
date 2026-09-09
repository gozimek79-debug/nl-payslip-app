import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentRule } from '../rules-repository.js';

export type PeriodType = 'week' | '4-wekelijks' | 'maand';
export type PensionMode = 'none' | 'percent' | 'stipp';

export interface OvertimeTier {
  hours: number;
  multiplier: number;
}

export interface AdvancedInput {
  enabled: boolean;
  pensionMode: PensionMode;
  pensionPremiumPercent: number;
  pawwPercent: number;
  sicknessInsurancePercent: number;
  wgaPremiumPercent: number;
  travelAllowance: number;
  otherDeductions: number;
  applyBijzonderTarief: boolean;
}

export interface CalculatorInput {
  periodType: PeriodType;
  baseHourlyRate: number;
  hours: { normal: number; saturday: number; sunday: number; holiday: number; night: number };
  toeslagPercentages: { saturday: number; sunday: number; holiday: number; night: number };
  overtime: { tier1: OvertimeTier; tier2: OvertimeTier };
  includeVakantiegeld: boolean;
  applyThirtyPercentRuling: boolean;
  applyLoonheffingskorting: boolean;
  advanced: AdvancedInput;
}

export interface CalculatorResult {
  grossBreakdown: {
    normal: number;
    saturday: number;
    sunday: number;
    holiday: number;
    night: number;
    overtime: number;
    subtotal: number;
    vakantiegeld: number;
    totalGross: number;
  };
  premiumBreakdown: {
    pensionPremium: number;
    paww: number;
    sicknessInsurance: number;
    wga: number;
    loonVoorHeffingen: number;
  };
  taxBreakdown: {
    taxableBase: number;
    thirtyPercentExempt: number;
    loonheffingTabel: number;
    loonheffingBijzonderTarief: number;
    bijzonderTariefPercent: number;
    loonheffingBeforeKorting: number;
    algemeneHeffingskorting: number;
    arbeidskorting: number;
    totalTax: number;
  };
  netAdjustments: { travelAllowance: number; otherDeductions: number };
  totalHours: number;
  netTotal: number;
  effectiveHourlyNet: number;
  wmlCheck: { minimumHourlyRate: number; isBelowMinimum: boolean };
  annual: {
    gross: number;
    taxableWage: number;
    tax: number;
    pensionPremium: number;
    paww: number;
    travelAllowance: number;
    net: number;
  };
  taxYear: number;
  ratesSource: 'database' | 'static';
  disclaimer: string;
}

interface TaxBracket {
  min: number;
  max: number;
  rate: number;
}

interface BuildupTier {
  max: number;
  rate: number;
}

interface BijzonderTariefAddonTier {
  max: number;
  addon: number;
}

interface TaxRatesFile {
  valid_from: string;
  valid_to: string;
  year: number;
  minimum_wage_per_hour: number;
  loonheffing_brackets: TaxBracket[];
  bijzonder_tarief_brackets: TaxBracket[];
  bijzonder_tarief_loonheffingskorting_addon_tiers: BijzonderTariefAddonTier[];
  heffingskortingen: {
    algemene_heffingskorting: { max_amount: number; phaseout_start: number; phaseout_rate: number };
    arbeidskorting: { max_amount: number; phaseout_start: number; phaseout_rate: number; buildup_tiers: BuildupTier[] };
  };
}

interface StippRates {
  franchise_per_hour: number;
  max_pensionable_hourly_wage: number;
  employee_rate: number;
}

const PERIOD_MULTIPLIERS: Record<PeriodType, number> = { week: 52, '4-wekelijks': 13, maand: 12 };

let cachedStaticPeriods: TaxRatesFile[] | null = null;

function loadStaticPeriods(): TaxRatesFile[] {
  if (cachedStaticPeriods) return cachedStaticPeriods;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(dir, '../../../../packages/tax-tables/2026-rates.json');
  const file = JSON.parse(readFileSync(filePath, 'utf-8')) as { periods: TaxRatesFile[] };
  cachedStaticPeriods = file.periods;
  return cachedStaticPeriods;
}

/**
 * Audit S1: the static fallback used to be a single undated snapshot, so it silently returned
 * whichever period it happened to hold even for a date outside that period - e.g. the 2026-H2 rate
 * for an H1 date, if the DB were down. The file now holds every period explicitly, and this refuses
 * (returns null) for any date none of them cover, rather than guessing. The calculator has nowhere
 * good to propagate "cannot compute" today (see the comment at its one call site below) - fixed
 * where it matters most, the minimum-wage check, via rules-repository.ts's getMinimumWageAt.
 */
function loadStaticTaxRatesAt(date: Date): TaxRatesFile | null {
  const iso = date.toISOString().slice(0, 10);
  return loadStaticPeriods().find((period) => iso >= period.valid_from && iso <= period.valid_to) ?? null;
}

const STATIC_STIPP_RATES: StippRates = { franchise_per_hour: 9.24, max_pensionable_hourly_wage: 42.42, employee_rate: 0.075 };

function round(value: number): number {
  return Number(value.toFixed(2));
}

export class PayrollCalculator {
  async calculate(input: CalculatorInput): Promise<CalculatorResult> {
    const dbRates = await getCurrentRule<TaxRatesFile>('loonheffing_nl');
    const staticRates = dbRates ? null : loadStaticTaxRatesAt(new Date());
    if (!dbRates && !staticRates) {
      // Genuinely out of range for the static fallback (e.g. running past the file's last covered
      // period with the DB also down) - refuse rather than silently compute with the wrong year's
      // rates. Left as a thrown error (not a typed "cannot verify" result like getMinimumWageAt)
      // because every CalculatorResult field depends on having rates at all - there's no partial
      // result to return, unlike a single minimum-wage check.
      throw new Error('Brak dostępnych stawek podatkowych dla bieżącej daty (baza niedostępna, a plik statyczny jej nie obejmuje).');
    }
    const rates = dbRates ?? staticRates!;
    const ratesSource: 'database' | 'static' = dbRates ? 'database' : 'static';

    const multiplier = PERIOD_MULTIPLIERS[input.periodType];
    const base = input.baseHourlyRate;
    const adv = input.advanced;

    const normal = input.hours.normal * base;
    const saturday = input.hours.saturday * base * (1 + input.toeslagPercentages.saturday / 100);
    const sunday = input.hours.sunday * base * (1 + input.toeslagPercentages.sunday / 100);
    const holiday = input.hours.holiday * base * (1 + input.toeslagPercentages.holiday / 100);
    const night = input.hours.night * base * (1 + input.toeslagPercentages.night / 100);
    const regularGross = normal + saturday + sunday + holiday + night;

    const overtime = input.overtime.tier1.hours * base * input.overtime.tier1.multiplier
      + input.overtime.tier2.hours * base * input.overtime.tier2.multiplier;

    const subtotal = regularGross + overtime;
    const vakantiegeld = input.includeVakantiegeld ? subtotal * 0.08 : 0;
    const totalGross = subtotal + vakantiegeld;

    const totalHours =
      input.hours.normal + input.hours.saturday + input.hours.sunday + input.hours.holiday + input.hours.night
      + input.overtime.tier1.hours + input.overtime.tier2.hours;

    // Pozycje traktowane jako "bijzondere beloningen" (nieregularne): nadgodziny i vakantiegeld.
    const irregularGross = overtime + vakantiegeld;

    // Składki pracownicze odliczane od brutto PRZED podatkiem (kolejność zgodna z realnymi paskami wypłaty).
    const pawwAmount = adv.enabled ? totalGross * (adv.pawwPercent / 100) : 0;
    const sicknessAmount = adv.enabled ? totalGross * (adv.sicknessInsurancePercent / 100) : 0;
    // PROVISIONAL (audit P4, reopened after N3): StiPP's own definition ("pensioengevend loon" =
    // SV-loon, the wage reported to the Belastingdienst for employee insurance — see
    // stippensioen.nl/werkgever/pensioenadministratie/pensioengevend-loon-en-pensioengrondslag-berekenen)
    // does not net out PAWW or the sickness premium, so `totalGross` (not `totalGross - pawwAmount
    // - sicknessAmount`, tried last round) is used here. This does NOT reproduce either reference
    // payslip exactly: Olympia computes 35.23 vs printed 34.79 (+0.44), Randstad computes 38.69 vs
    // printed 38.35 (+0.34) - both off by a similar relative amount in the same direction, which
    // looks more like a cumulative/voortschrijdend computation method neither payslip's single
    // period can be checked against without full year-to-date history, than a wrong parameter here.
    // Tested and ruled out: both variants that net out exactly one of PAWW/sickness each reproduce
    // one payslip exactly while missing the other by 6-7 cents - see calculator.test.ts for all four
    // combinations tried against both fixtures. Do not treat this formula as settled.
    const pensionAmount = adv.enabled ? await this.computePension(adv, totalGross, totalHours) : 0;
    const afterFirstPremiums = totalGross - pawwAmount - pensionAmount - sicknessAmount;
    const wgaAmount = adv.enabled ? afterFirstPremiums * (adv.wgaPremiumPercent / 100) : 0;
    const loonVoorHeffingen = afterFirstPremiums - wgaAmount;

    const thirtyPercentExempt = input.applyThirtyPercentRuling ? loonVoorHeffingen * 0.3 : 0;
    const taxableBase = loonVoorHeffingen - thirtyPercentExempt;

    const useBijzonderTarief = adv.enabled && adv.applyBijzonderTarief && totalGross > 0;
    const irregularShare = useBijzonderTarief ? irregularGross / totalGross : 0;
    const taxableIrregular = taxableBase * irregularShare;
    const taxableRegular = taxableBase - taxableIrregular;

    const annualizedRegular = taxableRegular * multiplier;
    const loonheffingTabelAnnual = this.progressiveTax(annualizedRegular, rates.loonheffing_brackets);
    const loonheffingTabelPeriod = loonheffingTabelAnnual / multiplier;
    const bijzonderTariefPercent = useBijzonderTarief
      ? this.bijzonderTariefRate(rates, annualizedRegular, input.applyLoonheffingskorting)
      : 0;
    const loonheffingBTPeriod = useBijzonderTarief ? taxableIrregular * (bijzonderTariefPercent / 100) : 0;

    let algemeneHeffingskorting = 0;
    let arbeidskorting = 0;
    if (input.applyLoonheffingskorting) {
      const kortingen = this.heffingskortingen(rates, annualizedRegular);
      algemeneHeffingskorting = kortingen.algemeneHeffingskorting / multiplier;
      arbeidskorting = kortingen.arbeidskorting / multiplier;
    }
    const loonheffingTabelAfterKorting = Math.max(0, loonheffingTabelPeriod - algemeneHeffingskorting - arbeidskorting);
    const totalTax = loonheffingTabelAfterKorting + loonheffingBTPeriod;

    const travelAllowance = adv.enabled ? adv.travelAllowance : 0;
    const otherDeductions = adv.enabled ? adv.otherDeductions : 0;
    const netTotal = totalGross - pawwAmount - pensionAmount - sicknessAmount - wgaAmount - totalTax + travelAllowance - otherDeductions;

    return {
      grossBreakdown: {
        normal: round(normal),
        saturday: round(saturday),
        sunday: round(sunday),
        holiday: round(holiday),
        night: round(night),
        overtime: round(overtime),
        subtotal: round(subtotal),
        vakantiegeld: round(vakantiegeld),
        totalGross: round(totalGross),
      },
      premiumBreakdown: {
        pensionPremium: round(pensionAmount),
        paww: round(pawwAmount),
        sicknessInsurance: round(sicknessAmount),
        wga: round(wgaAmount),
        loonVoorHeffingen: round(loonVoorHeffingen),
      },
      taxBreakdown: {
        taxableBase: round(taxableBase),
        thirtyPercentExempt: round(thirtyPercentExempt),
        loonheffingTabel: round(loonheffingTabelPeriod),
        loonheffingBijzonderTarief: round(loonheffingBTPeriod),
        bijzonderTariefPercent: round(bijzonderTariefPercent),
        loonheffingBeforeKorting: round(loonheffingTabelPeriod + loonheffingBTPeriod),
        algemeneHeffingskorting: round(algemeneHeffingskorting),
        arbeidskorting: round(arbeidskorting),
        totalTax: round(totalTax),
      },
      netAdjustments: { travelAllowance: round(travelAllowance), otherDeductions: round(otherDeductions) },
      totalHours,
      netTotal: round(netTotal),
      effectiveHourlyNet: totalHours > 0 ? round(netTotal / totalHours) : 0,
      wmlCheck: {
        minimumHourlyRate: rates.minimum_wage_per_hour,
        isBelowMinimum: base < rates.minimum_wage_per_hour,
      },
      annual: {
        gross: round(totalGross * multiplier),
        taxableWage: round(loonVoorHeffingen * multiplier),
        tax: round(totalTax * multiplier),
        pensionPremium: round(pensionAmount * multiplier),
        paww: round(pawwAmount * multiplier),
        travelAllowance: round(travelAllowance * multiplier),
        net: round(netTotal * multiplier),
      },
      taxYear: rates.year,
      ratesSource,
      disclaimer:
        'Kalkulacja ma charakter orientacyjny i wykorzystuje uproszczone tabele podatkowe. Ostateczne rozliczenie zależy od pracodawcy i Belastingdienst.',
    };
  }

  /**
   * StiPP's own definition of "pensioengevend loon" is SV-loon (the wage reported to the
   * Belastingdienst for employee insurance) — i.e. `totalGross`, unreduced by PAWW or sickness
   * premiums; see the PROVISIONAL note at the call site (audit P4). Franchise and the
   * pensionable-wage cap are still expressed per hour by StiPP, so they're converted to period
   * totals here (franchise_per_hour * totalHours) rather than reduced to a per-hour average first,
   * which would silently blend in irregular-hours surcharges at the wrong point in the calculation.
   */
  private async computePension(adv: AdvancedInput, totalGross: number, totalHours: number): Promise<number> {
    if (adv.pensionMode === 'percent') return totalGross * (adv.pensionPremiumPercent / 100);
    if (adv.pensionMode === 'stipp') {
      const dbStipp = await getCurrentRule<StippRates>('pensioenfonds_stipp');
      const stipp = dbStipp ?? STATIC_STIPP_RATES;
      const franchiseTotal = stipp.franchise_per_hour * totalHours;
      const maxGrondslagTotal = (stipp.max_pensionable_hourly_wage - stipp.franchise_per_hour) * totalHours;
      const grondslag = Math.min(Math.max(totalGross - franchiseTotal, 0), maxGrondslagTotal);
      return grondslag * stipp.employee_rate;
    }
    return 0;
  }

  private progressiveTax(annualAmount: number, brackets: TaxBracket[]): number {
    let tax = 0;
    for (const bracket of brackets) {
      if (annualAmount <= bracket.min) continue;
      const upper = Math.min(annualAmount, bracket.max);
      tax += (upper - bracket.min) * bracket.rate;
    }
    return tax;
  }

  private heffingskortingen(rates: TaxRatesFile, annualizedTaxable: number): { algemeneHeffingskorting: number; arbeidskorting: number } {
    const { algemene_heffingskorting, arbeidskorting } = rates.heffingskortingen;
    let algemeneKorting = algemene_heffingskorting.max_amount;
    if (annualizedTaxable > algemene_heffingskorting.phaseout_start) {
      const excess = annualizedTaxable - algemene_heffingskorting.phaseout_start;
      algemeneKorting = Math.max(0, algemeneKorting - excess * algemene_heffingskorting.phaseout_rate);
    }

    let arbeidskortingAmount: number;
    if (annualizedTaxable <= arbeidskorting.phaseout_start) {
      arbeidskortingAmount = this.arbeidskortingBuildup(annualizedTaxable, arbeidskorting.buildup_tiers);
    } else {
      const excess = annualizedTaxable - arbeidskorting.phaseout_start;
      arbeidskortingAmount = Math.max(0, arbeidskorting.max_amount - excess * arbeidskorting.phaseout_rate);
    }
    return { algemeneHeffingskorting: algemeneKorting, arbeidskorting: arbeidskortingAmount };
  }

  private arbeidskortingBuildup(income: number, tiers: BuildupTier[]): number {
    let amount = 0;
    let previousMax = 0;
    for (const tier of tiers) {
      if (income <= previousMax) break;
      const upper = Math.min(income, tier.max);
      amount += (upper - previousMax) * tier.rate;
      previousMax = tier.max;
    }
    return amount;
  }

  /** Bijzonder tarief: "standaardtarief" zależy od rocznego dochodu (próg), a przy stosowaniu
   * loonheffingskorting dolicza się "verrekeningspercentage" — który TAKŻE zależy od progu dochodu
   * (może być ujemny przy niskich dochodach) — zgodnie z oficjalną "witte tabel bijzondere beloning
   * Nederland" Belastingdienst (kolumna "Jonger dan AOW-leeftijd"). To NIE jest stały dodatek. */
  private bijzonderTariefRate(rates: TaxRatesFile, annualizedRegularIncome: number, applyLoonheffingskorting: boolean): number {
    const brackets = rates.bijzonder_tarief_brackets;
    const bracket = brackets.find((item) => annualizedRegularIncome <= item.max) ?? brackets[brackets.length - 1];
    const base = (bracket?.rate ?? 0) * 100;
    if (!applyLoonheffingskorting) return base;
    // Defensive fallback: a legal_rule_versions row written before this field existed (or any
    // future row missing it) must not crash the calculator. Fall back to the static file's tiers
    // per-field, rather than trusting the unchecked cast of the whole DB row. If even that fails
    // (static file doesn't cover today either - the double-fallback edge case S1 is about), return
    // the plain bracket rate with no addon rather than crash; this one field degrading to a less
    // precise number is preferable to failing the whole calculation over a missing addon table.
    const staticTiers = loadStaticTaxRatesAt(new Date())?.bijzonder_tarief_loonheffingskorting_addon_tiers;
    const tiers = rates.bijzonder_tarief_loonheffingskorting_addon_tiers?.length
      ? rates.bijzonder_tarief_loonheffingskorting_addon_tiers
      : staticTiers;
    if (!tiers?.length) return base;
    const tier = tiers.find((item) => annualizedRegularIncome <= item.max) ?? tiers[tiers.length - 1];
    return base + (tier?.addon ?? 0) * 100;
  }
}
