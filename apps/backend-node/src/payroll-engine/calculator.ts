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
  /**
   * Per-rule source attribution (audit AF2) — replaces the old single top-level `ratesSource`.
   * `taxRates` covers everything from the loonheffing_nl rule (brackets, heffingskortingen,
   * minimum wage, bijzonder tarief addon table) as ONE unit: either the whole DB row passed its
   * completeness check and every one of those numbers came from it, or it didn't and every one of
   * them came from the static file — never a mix (audit AF2, option (b): a rule that fails
   * completeness is rejected whole, not patched field-by-field). `pension` covers
   * pensioenfonds_stipp separately, since it's a different rule with its own independent
   * DB-or-static outcome; 'not_applicable' when pensionMode isn't 'stipp'.
   */
  sources: {
    taxRates: 'database' | 'static';
    pension: 'database' | 'static' | 'not_applicable';
  };
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

/**
 * Audit AF2, option (b) — adopted over per-field fallback after that pattern (A2, round 2) let a
 * stale DB row serve one CORRECT number (bijzonder tarief, protected by a field-level fallback)
 * and one WRONG number (arbeidskorting buildup tiers, not protected) side by side, undetectable
 * from the response alone. Confirmed live in round 6: production served arbeidskorting computed
 * from a round-1 row missing the tier-array field entirely (it had the old flat
 * `bijzonder_tarief_loonheffingskorting_addon` single number, not the array) while silently
 * "passing" for bijzonder tarief only because that one field happened to have its own fallback.
 * A row that fails ANY of these checks is rejected WHOLE — every number in the result then comes
 * from the static file, never a mix — per the same "decline rather than guess" principle as S1.
 */
export function isCompleteTaxRatesFile(value: unknown): value is TaxRatesFile {
  const r = value as Partial<TaxRatesFile> | null | undefined;
  if (!r || typeof r.minimum_wage_per_hour !== 'number') return false;
  if (!Array.isArray(r.loonheffing_brackets) || r.loonheffing_brackets.length === 0) return false;
  if (!Array.isArray(r.bijzonder_tarief_brackets) || r.bijzonder_tarief_brackets.length === 0) return false;
  if (!Array.isArray(r.bijzonder_tarief_loonheffingskorting_addon_tiers) || r.bijzonder_tarief_loonheffingskorting_addon_tiers.length === 0) return false;
  const hk = r.heffingskortingen;
  if (!hk) return false;
  const ahk = hk.algemene_heffingskorting;
  if (!ahk || typeof ahk.max_amount !== 'number' || typeof ahk.phaseout_start !== 'number' || typeof ahk.phaseout_rate !== 'number') return false;
  const ak = hk.arbeidskorting;
  if (!ak || typeof ak.max_amount !== 'number' || typeof ak.phaseout_start !== 'number' || typeof ak.phaseout_rate !== 'number') return false;
  if (!Array.isArray(ak.buildup_tiers) || ak.buildup_tiers.length === 0) return false;
  return true;
}

export function isCompleteStippRates(value: unknown): value is StippRates {
  const r = value as Partial<StippRates> | null | undefined;
  return !!r && typeof r.franchise_per_hour === 'number' && typeof r.max_pensionable_hourly_wage === 'number' && typeof r.employee_rate === 'number';
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

export class PayrollCalculator {
  async calculate(input: CalculatorInput): Promise<CalculatorResult> {
    const rawDbRates = await getCurrentRule<TaxRatesFile>('loonheffing_nl');
    // Whole-row completeness check (audit AF2) - a DB row missing or malforming any field is
    // treated exactly as if it weren't there, not partially trusted.
    const dbRates = rawDbRates && isCompleteTaxRatesFile(rawDbRates) ? rawDbRates : null;
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
    const taxRatesSource: 'database' | 'static' = dbRates ? 'database' : 'static';

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
    // PROVISIONAL, REINSTATED (audit T1, after briefly reverting under P4). Netting out PAWW and
    // the sickness premium before StiPP's franchise/rate apply is the LEADING hypothesis again:
    //   Olympia (885.50 - 0.89 - 4.90 - 9.24*45)  * 7.5% = 34.79   printed 34.79   diff  0.00 (exact)
    //   Randstad(970.89 - 0.74 - 4.55 - 9.24*49.25)* 7.5% = 38.29   printed 38.35   diff -0.06
    // vs. the no-netting variant tried in between (totalGross, unreduced):
    //   Olympia:  35.23 vs 34.79 (+0.44)   Randstad: 38.69 vs 38.35 (+0.34)
    // Netting fits BOTH documents better, not just the one it was derived from - the objection to
    // HOW it was found (reverse-solved from one payslip, one degree of freedom) stood, but the
    // conclusion it produced turned out to generalise, and the no-netting alternative doesn't.
    // Randstad is itself a correction (version 2, issued 30-04-2026) - its pension line may carry an
    // adjustment from the original run, which alone could explain a 0.06/38.35 = 0.16% residual, so
    // that gap is weak evidence against netting, not strong evidence for the alternative.
    // A THIRD document (OTTO, 2025, fase C/Plusregeling - different scheme, different rates)
    // does NOT confirm this either way: its own PAWW lines cancel to zero net effect, so netting
    // and not-netting predict the SAME number there, and neither reaches the printed 21.65 (best
    // attempt found: 14.79, using "Suma z pracy" 752.37 over 43h at 2025 Plusregeling rates -
    // franchise 8.90, rate 4%). Still marked PROVISIONAL: two documents support netting, a third
    // fails both variants for reasons not yet understood, and this is not a closed question.
    const pensionResult = adv.enabled
      ? await this.computePension(adv, totalGross, totalGross - pawwAmount - sicknessAmount, totalHours)
      : { amount: 0, source: 'not_applicable' as const };
    const pensionAmount = pensionResult.amount;
    const afterFirstPremiums = totalGross - pawwAmount - pensionAmount - sicknessAmount;
    const wgaAmount = adv.enabled ? afterFirstPremiums * (adv.wgaPremiumPercent / 100) : 0;
    const loonVoorHeffingen = afterFirstPremiums - wgaAmount;

    const thirtyPercentExempt = input.applyThirtyPercentRuling ? loonVoorHeffingen * 0.3 : 0;
    const taxableBase = loonVoorHeffingen - thirtyPercentExempt;

    // BT base is the raw, unreduced irregular gross - pre-tax deductions (PAWW, pension, sickness,
    // WGA) burden ONLY the table portion (audit AO1/AO2, round 9). This was previously a
    // proportional split (irregularGross / totalGross share of taxableBase), which spread those
    // deductions across the BT portion too - confirmed wrong while building the payslip-model
    // rewrite against PKF's and Randstad's own explicit notes ("potrącenia przedpodatkowe obciążają
    // wyłącznie część tabelaryczną. Podstawa BT to pełne brutto [nadgodzin]"), both of which
    // reproduce their own printed table/BT split exactly under this rule, not the proportional one.
    // Because totalGross = regularGross + irregularGross, subtracting the raw irregularGross from
    // taxableBase (= loonVoorHeffingen - thirtyPercentExempt) leaves exactly regularGross minus the
    // deductions and the 30%-ruling exemption - i.e. those apply only to the regular/table portion.
    const useBijzonderTarief = adv.enabled && adv.applyBijzonderTarief && totalGross > 0;
    const taxableIrregular = useBijzonderTarief ? irregularGross : 0;
    const taxableRegular = Math.max(0, taxableBase - taxableIrregular);

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
      sources: { taxRates: taxRatesSource, pension: pensionResult.source },
      disclaimer:
        'Kalkulacja ma charakter orientacyjny i wykorzystuje uproszczone tabele podatkowe. Ostateczne rozliczenie zależy od pracodawcy i Belastingdienst.',
    };
  }

  /**
   * `percent` mode is keyed to `totalGross` (unreduced) — a plain user-entered "% of gross", never
   * disputed, not affected by the StiPP question. `stipp` mode uses `pensionableBase` (totalGross
   * minus PAWW and sickness, per the PROVISIONAL T1/N3 note at the call site) — the two must stay
   * separate parameters, not one reused value, or a fix to one mode silently changes the other.
   * Franchise and the pensionable-wage cap are still expressed per hour by StiPP, so they're
   * converted to period totals here (franchise_per_hour * totalHours) rather than reduced to a
   * per-hour average first, which would silently blend in irregular-hours surcharges at the wrong
   * point in the calculation.
   */
  private async computePension(
    adv: AdvancedInput,
    totalGross: number,
    pensionableBase: number,
    totalHours: number,
  ): Promise<{ amount: number; source: 'database' | 'static' | 'not_applicable' }> {
    if (adv.pensionMode === 'percent') return { amount: totalGross * (adv.pensionPremiumPercent / 100), source: 'not_applicable' };
    if (adv.pensionMode === 'stipp') {
      const rawDbStipp = await getCurrentRule<StippRates>('pensioenfonds_stipp');
      // Same whole-row completeness principle as loonheffing_nl (audit AF2) - not split out into a
      // shared helper since there are only two rule shapes in this file; would be worth generalising
      // if a third DB-backed rule shape shows up here.
      const dbStipp = rawDbStipp && isCompleteStippRates(rawDbStipp) ? rawDbStipp : null;
      const stipp = dbStipp ?? STATIC_STIPP_RATES;
      const franchiseTotal = stipp.franchise_per_hour * totalHours;
      const maxGrondslagTotal = (stipp.max_pensionable_hourly_wage - stipp.franchise_per_hour) * totalHours;
      const grondslag = Math.min(Math.max(pensionableBase - franchiseTotal, 0), maxGrondslagTotal);
      return { amount: grondslag * stipp.employee_rate, source: dbStipp ? 'database' : 'static' };
    }
    return { amount: 0, source: 'not_applicable' };
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
    // No per-field fallback here (audit AF2, option (b)): `rates` is guaranteed complete by
    // isCompleteTaxRatesFile() before it ever reaches this method - either it's the DB row (fully
    // valid) or the static file (always fully valid), never a stale DB row missing just this field.
    // The old per-field fallback (round 2's A2 fix) was the exact mechanism that let a stale DB row
    // silently serve a correct bijzonder tarief while its arbeidskorting was wrong (round 6) -
    // removed rather than extended to every field individually.
    const tiers = rates.bijzonder_tarief_loonheffingskorting_addon_tiers;
    const tier = tiers.find((item) => annualizedRegularIncome <= item.max) ?? tiers[tiers.length - 1];
    return base + (tier?.addon ?? 0) * 100;
  }
}
