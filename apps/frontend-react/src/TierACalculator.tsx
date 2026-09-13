import { useState } from 'react';
import { AlertTriangle, Calculator as CalculatorIcon, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { translations, type Lang } from './translations.ts';

/**
 * Tier A - "Quick calculator" (SPEC-loonto-architecture.md §3, §5b). Replaces the old Calculator.tsx
 * as the app's default calculator: that one silently taxed the full gross whenever the user had no
 * pension/PAWW/sector-premium figures (the live 8% overstatement bug this whole architecture change
 * exists to fix). This component talks to POST /api/tier-a/calculate and renders exactly what that
 * route returns - the full chain with per-line provenance, an explicit "cannot determine net" state
 * when deductions are skipped, and a net RANGE (not a single fabricated number) for "estimate".
 *
 * CX2a (audit "CK RESTATED, THEN FINISH TIER A" round): the flat "hours worked" field is gone,
 * replaced by a day grid (Mon-Sun, regular/overtime hours + a holiday flag) - the missing piece named
 * explicitly in that round: "Tier A cannot express a Saturday, a Sunday or a public holiday". Built
 * on the SAME hour-grid.ts backend module Tier C's multi-employer work already tested (CD/CR), not a
 * second implementation. Monthly/4-weekly periods reuse one grid component behind a week selector
 * (CM1), and the grid starts empty (CM2) - no assumed "typical week". Single-employer only (CR3): no
 * tabs, no employer column, since that dimension is Tier C's, not Tier A's.
 *
 * The pre-existing free-form "surcharge lines" (Olympia's real "Loon onregelm. uren 100%/50%", "ADV
 * toeslag") are UNCHANGED in concept, just renamed - they are period-level CAO allowances a worker
 * states directly by hours+percent, genuinely independent of which weekday they fell on, and forcing
 * them into the day grid would ask a question the worker's payslip doesn't answer either.
 */

type PeriodType = 'week' | '4-weekly' | 'month';
type DeductionMode = 'enter' | 'estimate' | 'skip';
type VakantiegeldMode = 'none' | 'accruing' | 'paid_now';
type Provenance = 'user_entered' | 'contract_extracted' | 'payslip_extracted' | 'estimated' | 'rules_database' | 'unknown';

interface Field<T> {
  provenance: Provenance;
  value: T | null;
}

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

interface DayHoursForm {
  regular_hours: string;
  overtime_hours: string;
  is_public_holiday: boolean;
}

type WeekGridForm = Record<DayKey, DayHoursForm>;

function emptyWeekGrid(): WeekGridForm {
  const grid = {} as WeekGridForm;
  for (const day of DAY_KEYS) grid[day] = { regular_hours: '', overtime_hours: '', is_public_holiday: false };
  return grid;
}

interface SurchargeLineForm {
  description: string;
  hours: string;
  percent: string;
}

interface PreTaxDeductionLine {
  category: string;
  description: string;
  amount: Field<number>;
}

interface PostTaxSocialLine {
  category: string;
  description: string;
  amount: Field<number>;
}

interface NetLineItem {
  category: string;
  description: string;
  amount: number;
}

interface TierAPeriodResponse {
  hour_lines: Array<{ description: string; amount: number }>;
  pre_tax_deductions: PreTaxDeductionLine[];
  post_tax_social: PostTaxSocialLine[];
  net_additions: NetLineItem[];
  net_deductions: NetLineItem[];
  reservations: Array<{ type: string; opgebouwd_this_period: number; paid_out_this_period: number }>;
}

interface CompleteOutcome {
  status: 'complete';
  result: {
    gross_total: number;
    loon_voor_heffingen: number;
    taxable_base: number;
    table_tax_after_korting: number;
    bt_tax: number;
    total_tax: number;
    wage_net: number;
    net_additions_total: number;
    net_deductions_total: number;
    period_net: number;
    payout_amount: number;
  };
}

interface IncompleteOutcome {
  status: 'incomplete';
  missing_fields: string[];
  tax_is_upper_bound: boolean;
  gross_total: number;
  taxable_base: number;
  table_tax_after_korting: number;
  bt_tax: number;
  total_tax: number;
}

type Outcome = CompleteOutcome | IncompleteOutcome;

interface SectorPremiumEstimate {
  low_percent: number;
  high_percent: number;
  low_amount: number;
  high_amount: number;
  /** BK4: literal Dutch payslip line names (data, not copy) - the frontend builds its own
   * translated sentence around this list rather than receiving one hardcoded Dutch sentence. */
  known_terms: string[];
}

/** BJ1: structured, not a prebaked sentence - the frontend builds the message in the interface
 * language from these numeric fields (see sanityWarningMessage below). */
type SanityWarning =
  | { code: 'net_exceeds_gross'; wage_net: number; gross_total: number }
  | { code: 'effective_rate_exceeds_gross_rate'; effective_rate: number; hourly_rate: number };

interface ComputedResponse {
  status: 'computed';
  period: TierAPeriodResponse;
  outcome: Outcome;
  sector_premium_estimate: SectorPremiumEstimate | null;
  net_range: { low: number; high: number } | null;
  payout_range: { low: number; high: number } | null;
  warnings: SanityWarning[];
  taxRatesSource: 'database' | 'static';
}

type GridCategory = 'overtime_tier_1' | 'overtime_tier_2' | 'saturday' | 'sunday' | 'holiday';

interface BlockedResponse {
  status: 'blocked';
  reason: 'overtime_threshold_unknown' | 'category_percent_missing';
  days_affected?: DayKey[];
  categories?: GridCategory[];
}

type TierAResponse = ComputedResponse | BlockedResponse;

type TierACopy = (typeof translations)['pl']['tierA'];

function money(value: number): string {
  return `€${value.toFixed(2)}`;
}

function sanityWarningMessage(t: TierACopy, warning: SanityWarning): string {
  if (warning.code === 'net_exceeds_gross') return t.sanityNetExceedsGross(money(warning.wage_net), money(warning.gross_total));
  return t.sanityEffectiveRateExceedsGross(money(warning.effective_rate), money(warning.hourly_rate));
}

function categoryLabel(t: TierACopy, category: string): string {
  if (category === 'pension') return t.categoryPension;
  if (category === 'paww') return t.categoryPaww;
  if (category === 'ziektewet') return t.categorySector;
  return t.categoryOther;
}

function provenanceLabel(t: TierACopy, provenance: Provenance): string {
  if (provenance === 'user_entered' || provenance === 'contract_extracted' || provenance === 'payslip_extracted') return t.provenanceUserEntered;
  if (provenance === 'estimated') return t.provenanceEstimated;
  if (provenance === 'rules_database') return t.provenanceRulesDatabase;
  return '';
}

function missingFieldLabel(t: TierACopy, field: string): string {
  if (field === 'pension') return t.missingPension;
  if (field === 'paww') return t.missingPaww;
  if (field === 'ziektewet') return t.missingZiektewet;
  if (field === 'bijzonder_tarief_percentage') return t.missingBt;
  return field;
}

function dayLabel(t: TierACopy, day: DayKey): string {
  return { mon: t.dayMon, tue: t.dayTue, wed: t.dayWed, thu: t.dayThu, fri: t.dayFri, sat: t.daySat, sun: t.daySun }[day];
}

function gridCategoryLabel(t: TierACopy, category: GridCategory): string {
  return {
    overtime_tier_1: t.categoryOvertimeTier1,
    overtime_tier_2: t.categoryOvertimeTier2,
    saturday: t.categorySaturday,
    sunday: t.categorySunday,
    holiday: t.categoryHoliday,
  }[category];
}

function sanitizeDecimal(value: string): string {
  return value.replace(/[^0-9.,-]/g, '');
}

/** The 'complete' and 'incomplete' outcome shapes genuinely differ (gross_total/table_tax_after_
 * korting/bt_tax sit at the top level when incomplete, nested under `.result` when complete) -
 * mirroring the backend's own PayslipComputationOutcome discriminated union. This extracts the
 * handful of figures both branches can always show, rather than accessing them polymorphically on
 * a union type that doesn't actually have them in a common shape. */
function getDisplayFigures(outcome: Outcome): { gross_total: number; table_tax_after_korting: number; bt_tax: number } {
  if (outcome.status === 'complete') {
    return { gross_total: outcome.result.gross_total, table_tax_after_korting: outcome.result.table_tax_after_korting, bt_tax: outcome.result.bt_tax };
  }
  return { gross_total: outcome.gross_total, table_tax_after_korting: outcome.table_tax_after_korting, bt_tax: outcome.bt_tax };
}

function parseDecimal(value: string): number {
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNullableDecimal(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function weekGridToApi(grid: WeekGridForm) {
  const api = {} as Record<DayKey, { regular_hours: number; overtime_hours: number; is_public_holiday: boolean }>;
  for (const day of DAY_KEYS) {
    api[day] = {
      regular_hours: parseDecimal(grid[day].regular_hours),
      overtime_hours: parseDecimal(grid[day].overtime_hours),
      is_public_holiday: grid[day].is_public_holiday,
    };
  }
  return api;
}

function weeksForPeriod(periodType: PeriodType, current: WeekGridForm[]): WeekGridForm[] {
  const target = periodType === 'week' ? 1 : 4;
  if (current.length === target) return current;
  if (current.length > target) return current.slice(0, target);
  return [...current, ...Array.from({ length: target - current.length }, emptyWeekGrid)];
}

/** Tier B (audit "CONSOLIDATED ASSIGNMENT" round, §3.1): a contract states weekly hours, not a
 * day-by-day breakdown - this is a starting point only (spread evenly Mon-Fri), not a claim about
 * which days the worker actually works. Fully editable, exactly like every other pre-filled field. */
function gridFromWeeklyHours(hoursPerWeek: number): WeekGridForm {
  const grid = emptyWeekGrid();
  const perDay = Math.round((hoursPerWeek / 5) * 100) / 100;
  for (const day of ['mon', 'tue', 'wed', 'thu', 'fri'] as DayKey[]) {
    grid[day] = { ...grid[day], regular_hours: String(perDay) };
  }
  return grid;
}

/** Tier B: which Tier A fields a contract extraction can pre-fill, and nothing more (§3.1 - "Tier A
 * ships when" isn't reopened; Tier B only feeds it). */
export interface TierAContractPrefill {
  hourly_rate?: number;
  hours_per_week?: number;
  overtime_tier_threshold_hours?: number;
}

export function TierACalculator({ lang, onNavigateToDictionary, tierMode = 'A', contractPrefill }: {
  lang: Lang;
  onNavigateToDictionary: () => void;
  /** 'B' when this render is Tier B (contract-prefilled) rather than plain Tier A - changes only
   * the reliability wording (§3.4) and whether contract-provenance badges render; the calculator
   * itself, per spec §2, is the same component and engine either way. */
  tierMode?: 'A' | 'B';
  contractPrefill?: TierAContractPrefill;
}) {
  const t = translations[lang].tierA;

  const [periodType, setPeriodType] = useState<PeriodType>('week');
  const [hourlyRate, setHourlyRate] = useState(() => (contractPrefill?.hourly_rate !== undefined ? String(contractPrefill.hourly_rate) : '15.58'));
  const [weekGrids, setWeekGrids] = useState<WeekGridForm[]>(() => [contractPrefill?.hours_per_week !== undefined ? gridFromWeeklyHours(contractPrefill.hours_per_week) : emptyWeekGrid()]);
  const [activeWeek, setActiveWeek] = useState(0);
  const [overtimeThreshold, setOvertimeThreshold] = useState(() => (contractPrefill?.overtime_tier_threshold_hours !== undefined ? String(contractPrefill.overtime_tier_threshold_hours) : ''));
  const [contractProvenance, setContractProvenance] = useState({
    hourlyRate: contractPrefill?.hourly_rate !== undefined,
    grid: contractPrefill?.hours_per_week !== undefined,
    threshold: contractPrefill?.overtime_tier_threshold_hours !== undefined,
  });
  const [overtimeTier1Percent, setOvertimeTier1Percent] = useState('');
  const [overtimeTier2Percent, setOvertimeTier2Percent] = useState('');
  const [saturdayPercent, setSaturdayPercent] = useState('');
  const [sundayPercent, setSundayPercent] = useState('');
  const [holidayPercent, setHolidayPercent] = useState('');
  const [surchargeLines, setSurchargeLines] = useState<SurchargeLineForm[]>([]);
  const [applyLoonheffingskorting, setApplyLoonheffingskorting] = useState(true);
  const [travelAllowance, setTravelAllowance] = useState('0');
  const [vakantiegeldMode, setVakantiegeldMode] = useState<VakantiegeldMode>('accruing');
  const [vakantiegeldPercent, setVakantiegeldPercent] = useState('8');
  const [deductionMode, setDeductionMode] = useState<DeductionMode>('estimate');
  const [enteredPension, setEnteredPension] = useState('');
  const [enteredPaww, setEnteredPaww] = useState('');
  const [enteredSector, setEnteredSector] = useState('');

  const [response, setResponse] = useState<TierAResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function changePeriodType(next: PeriodType) {
    setPeriodType(next);
    setWeekGrids(current => weeksForPeriod(next, current));
    setActiveWeek(0);
  }

  function updateDay(weekIndex: number, day: DayKey, patch: Partial<DayHoursForm>) {
    setWeekGrids(current => current.map((grid, i) => (i === weekIndex ? { ...grid, [day]: { ...grid[day], ...patch } } : grid)));
    setContractProvenance(current => (current.grid ? { ...current, grid: false } : current));
  }

  function addWeek() {
    setWeekGrids(current => (current.length >= 5 ? current : [...current, emptyWeekGrid()]));
  }
  function removeWeek(index: number) {
    setWeekGrids(current => (current.length <= 1 ? current : current.filter((_, i) => i !== index)));
    setActiveWeek(current => Math.max(0, Math.min(current, weekGrids.length - 2)));
  }

  function addSurchargeLine() {
    setSurchargeLines(current => [...current, { description: '', hours: '', percent: '' }]);
  }
  function updateSurchargeLine(index: number, patch: Partial<SurchargeLineForm>) {
    setSurchargeLines(current => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }
  function removeSurchargeLine(index: number) {
    setSurchargeLines(current => current.filter((_, i) => i !== index));
  }

  async function calculate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const body = {
      period_type: periodType,
      hourly_rate: parseDecimal(hourlyRate),
      week_grids: weekGrids.map(weekGridToApi),
      overtime_tier_threshold_hours: parseNullableDecimal(overtimeThreshold),
      overtime_tier_1_percent: parseNullableDecimal(overtimeTier1Percent),
      overtime_tier_2_percent: parseNullableDecimal(overtimeTier2Percent),
      saturday_percent: parseNullableDecimal(saturdayPercent),
      sunday_percent: parseNullableDecimal(sundayPercent),
      holiday_percent: parseNullableDecimal(holidayPercent),
      surcharge_lines: surchargeLines
        .filter(line => line.hours.trim() !== '')
        .map(line => ({ description: line.description || t.defaultLineDescription, hours: parseDecimal(line.hours), percent: parseDecimal(line.percent) })),
      apply_loonheffingskorting: applyLoonheffingskorting,
      travel_allowance: parseDecimal(travelAllowance),
      vakantiegeld: vakantiegeldMode === 'none' ? { mode: 'none' } : { mode: vakantiegeldMode, percent: parseDecimal(vakantiegeldPercent) },
      deductions: {
        mode: deductionMode,
        ...(deductionMode === 'enter'
          ? {
              entered: {
                ...(enteredPension.trim() !== '' ? { pension: parseDecimal(enteredPension) } : {}),
                ...(enteredPaww.trim() !== '' ? { paww: parseDecimal(enteredPaww) } : {}),
                ...(enteredSector.trim() !== '' ? { sector_premium: parseDecimal(enteredSector) } : {}),
              },
            }
          : {}),
      },
    };
    try {
      const res = await fetch('/api/tier-a/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        // CX2d/CONVENTIONS.md: the backend sends error_code + params, never a sentence - resolved
        // here, in the interface language, instead of displaying backend prose (which was Polish
        // regardless of `lang` before this round).
        const code = data.error_code as string | undefined;
        const message = code === 'invalid_input' ? t.errorInvalidInput : code === 'tax_rates_unavailable' ? t.errorRatesUnavailable : t.error;
        throw new Error(message);
      }
      setResponse(data as TierAResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error);
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }

  const currentWeek = weekGrids[activeWeek] ?? emptyWeekGrid();

  return (
    <section className="flow-page calc-page">
      <div className="flow-heading">
        <span className="step">Tier A</span>
        <h1>{t.title}</h1>
        <p>{t.lead}</p>
      </div>
      <div className="review-grid">
        <form className="fields-card calculator-form-card" onSubmit={event => void calculate(event)}>
          <h2><CalculatorIcon size={20}/> {t.inputsTitle}</h2>

          <label className="calc-select-label">{t.period}
            <select value={periodType} onChange={event => changePeriodType(event.target.value as PeriodType)}>
              <option value="week">{t.periodWeek}</option>
              <option value="4-weekly">{t.period4w}</option>
              <option value="month">{t.periodMonth}</option>
            </select>
          </label>

          <label>{t.hourlyRate} {contractProvenance.hourlyRate && <span className="form-note contract-badge">({t.fromContract})</span>}
            <div className="money-input"><span>€</span><input required inputMode="decimal" value={hourlyRate} onChange={event => { setHourlyRate(sanitizeDecimal(event.target.value)); setContractProvenance(c => ({ ...c, hourlyRate: false })); }}/></div>
          </label>

          <h3 className="calc-subheading">{t.gridTitle} {contractProvenance.grid && <span className="form-note contract-badge">({t.fromContract})</span>}</h3>
          <p className="form-note">{t.gridHint}</p>

          {weekGrids.length > 1 && (
            <div className="calc-week-tabs">
              {weekGrids.map((_, i) => (
                <button type="button" key={i} className={i === activeWeek ? 'week-tab active' : 'week-tab'} onClick={() => setActiveWeek(i)}>
                  {t.weekSelectorLabel(i + 1)}
                </button>
              ))}
              {periodType === 'month' && weekGrids.length < 5 && (
                <button type="button" className="secondary" onClick={addWeek}><Plus size={14}/> {t.addWeek}</button>
              )}
              {periodType === 'month' && weekGrids.length > 4 && (
                <button type="button" className="secondary" onClick={() => removeWeek(activeWeek)}><Trash2 size={14}/> {t.removeWeek}</button>
              )}
            </div>
          )}

          <div className="hour-grid-table">
            <table>
              <thead>
                <tr>
                  <th></th>
                  {DAY_KEYS.map(day => <th key={day}>{dayLabel(t, day)}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>{t.gridRegular}</th>
                  {DAY_KEYS.map(day => (
                    <td key={day}>
                      <input inputMode="decimal" className="grid-hour-input" value={currentWeek[day].regular_hours}
                        onChange={event => updateDay(activeWeek, day, { regular_hours: sanitizeDecimal(event.target.value) })}/>
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>{t.gridOvertime}</th>
                  {DAY_KEYS.map(day => (
                    <td key={day}>
                      <input inputMode="decimal" className="grid-hour-input" value={currentWeek[day].overtime_hours}
                        onChange={event => updateDay(activeWeek, day, { overtime_hours: sanitizeDecimal(event.target.value) })}/>
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>{t.gridHoliday}</th>
                  {DAY_KEYS.map(day => (
                    <td key={day}>
                      <input type="checkbox" checked={currentWeek[day].is_public_holiday}
                        onChange={event => updateDay(activeWeek, day, { is_public_holiday: event.target.checked })}/>
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>

          <h3 className="calc-subheading">{t.overtimeThresholdTitle} {contractProvenance.threshold && <span className="form-note contract-badge">({t.fromContract})</span>}</h3>
          <label>{t.overtimeThresholdLabel}
            <div className="money-input"><span>h</span><input inputMode="decimal" value={overtimeThreshold} onChange={event => { setOvertimeThreshold(sanitizeDecimal(event.target.value)); setContractProvenance(c => ({ ...c, threshold: false })); }}/></div>
          </label>
          <p className="form-note">{t.overtimeThresholdHint}</p>
          <div className="fields-grid">
            <label>{t.overtimeTier1Percent}
              <div className="money-input"><span>%</span><input inputMode="decimal" value={overtimeTier1Percent} onChange={event => setOvertimeTier1Percent(sanitizeDecimal(event.target.value))}/></div>
            </label>
            <label>{t.overtimeTier2Percent}
              <div className="money-input"><span>%</span><input inputMode="decimal" value={overtimeTier2Percent} onChange={event => setOvertimeTier2Percent(sanitizeDecimal(event.target.value))}/></div>
            </label>
            <label>{t.saturdayPercent}
              <div className="money-input"><span>%</span><input inputMode="decimal" value={saturdayPercent} onChange={event => setSaturdayPercent(sanitizeDecimal(event.target.value))}/></div>
            </label>
            <label>{t.sundayPercent}
              <div className="money-input"><span>%</span><input inputMode="decimal" value={sundayPercent} onChange={event => setSundayPercent(sanitizeDecimal(event.target.value))}/></div>
            </label>
            <label>{t.holidayPercentLabel}
              <div className="money-input"><span>%</span><input inputMode="decimal" value={holidayPercent} onChange={event => setHolidayPercent(sanitizeDecimal(event.target.value))}/></div>
            </label>
          </div>
          <p className="form-note">{t.percentHint}</p>

          <h3 className="calc-subheading">{t.surchargeTitle}</h3>
          <p className="form-note">{t.surchargeHint}</p>
          {surchargeLines.map((line, index) => (
            <div className="fields-grid" key={index}>
              <label>{t.lineDescription}
                <input value={line.description} onChange={event => updateSurchargeLine(index, { description: event.target.value })}/>
              </label>
              <label>{t.lineHours}
                <div className="money-input"><span>h</span><input inputMode="decimal" value={line.hours} onChange={event => updateSurchargeLine(index, { hours: sanitizeDecimal(event.target.value) })}/></div>
              </label>
              <label>{t.linePercent}
                <div className="money-input"><span>%</span><input inputMode="decimal" value={line.percent} onChange={event => updateSurchargeLine(index, { percent: sanitizeDecimal(event.target.value) })}/></div>
              </label>
              <button type="button" className="secondary" onClick={() => removeSurchargeLine(index)}><Trash2 size={14}/></button>
            </div>
          ))}
          <button type="button" className="secondary" onClick={addSurchargeLine}><Plus size={14}/> {t.addLine}</button>

          <div className="calc-toggles">
            <label className="calc-toggle"><input type="checkbox" checked={applyLoonheffingskorting} onChange={event => setApplyLoonheffingskorting(event.target.checked)}/> {t.loonheffingskorting}</label>
          </div>
          <label>{t.travelAllowance}
            <div className="money-input"><span>€</span><input inputMode="decimal" value={travelAllowance} onChange={event => setTravelAllowance(sanitizeDecimal(event.target.value))}/></div>
          </label>

          <h3 className="calc-subheading">{t.vakantiegeldTitle}</h3>
          <div className="calc-toggles">
            <label className="calc-toggle"><input type="radio" name="vak" checked={vakantiegeldMode === 'none'} onChange={() => setVakantiegeldMode('none')}/> {t.vakantiegeldNone}</label>
            <label className="calc-toggle"><input type="radio" name="vak" checked={vakantiegeldMode === 'accruing'} onChange={() => setVakantiegeldMode('accruing')}/> {t.vakantiegeldAccruing}</label>
            <label className="calc-toggle"><input type="radio" name="vak" checked={vakantiegeldMode === 'paid_now'} onChange={() => setVakantiegeldMode('paid_now')}/> {t.vakantiegeldPaidNow}</label>
          </div>
          {vakantiegeldMode !== 'none' && (
            <label>{t.vakantiegeldPercent}
              <div className="money-input"><span>%</span><input inputMode="decimal" value={vakantiegeldPercent} onChange={event => setVakantiegeldPercent(sanitizeDecimal(event.target.value))}/></div>
            </label>
          )}

          <h3 className="calc-subheading">{t.deductionsTitle}</h3>
          <p className="form-note">{t.deductionsHint}</p>
          {/* §3.4: Tier B's honest limit, on screen where the user is about to answer the deduction
              question - not a tooltip. A contract improves rate/hours/percentages; it never contains
              pension/PAWW/sector-premium figures, so this question still applies exactly as in Tier A. */}
          {tierMode === 'B' && <p className="form-note calc-honest-limit">{t.tierBHonestLimit}</p>}
          <div className="calc-toggles">
            <label className="calc-toggle"><input type="radio" name="ded" checked={deductionMode === 'enter'} onChange={() => setDeductionMode('enter')}/> {t.deductionEnter}</label>
            <label className="calc-toggle"><input type="radio" name="ded" checked={deductionMode === 'estimate'} onChange={() => setDeductionMode('estimate')}/> {t.deductionEstimate}</label>
            <label className="calc-toggle"><input type="radio" name="ded" checked={deductionMode === 'skip'} onChange={() => setDeductionMode('skip')}/> {t.deductionSkip}</label>
          </div>
          {deductionMode === 'estimate' && <small className="form-note">{t.deductionEstimateHint}</small>}
          {deductionMode === 'skip' && <small className="form-note">{t.deductionSkipHint}</small>}
          {deductionMode === 'enter' && (
            <div className="fields-grid">
              <label>{t.enteredPension}
                <div className="money-input"><span>€</span><input inputMode="decimal" value={enteredPension} onChange={event => setEnteredPension(sanitizeDecimal(event.target.value))}/></div>
              </label>
              <label>{t.enteredPaww}
                <div className="money-input"><span>€</span><input inputMode="decimal" value={enteredPaww} onChange={event => setEnteredPaww(sanitizeDecimal(event.target.value))}/></div>
              </label>
              <label>{t.enteredSector}
                <div className="money-input"><span>€</span><input inputMode="decimal" value={enteredSector} onChange={event => setEnteredSector(sanitizeDecimal(event.target.value))}/></div>
              </label>
            </div>
          )}

          {error && <div className="status error" role="status">{error}</div>}
          <button className="primary" type="submit" disabled={loading}>{loading ? t.calculating : t.submit}</button>
        </form>

        <aside className="notice-card calc-side-notice">
          <ShieldCheck/>
          <div>
            <h3>{t.inputsTitle}</h3>
            <p>{t.deductionsHint}</p>
          </div>
        </aside>
      </div>

      {response && response.status === 'blocked' && (
        <div className="calc-result" id="tier-a-result">
          <div className="notice-card">
            <AlertTriangle/>
            <div>
              <h3>{t.blockedTitle}</h3>
              {response.reason === 'overtime_threshold_unknown' && (
                <p>{t.blockedThresholdBody((response.days_affected ?? []).map(d => dayLabel(t, d)).join(', '))}</p>
              )}
              {response.reason === 'category_percent_missing' && (
                <p>{t.blockedPercentBody((response.categories ?? []).map(c => gridCategoryLabel(t, c)).join(', '))}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {response && response.status === 'computed' && (() => {
        const displayFigures = getDisplayFigures(response.outcome);
        return (
        <div className="calc-result" id="tier-a-result">
          {response.warnings.length > 0 && (
            <div className="status error calc-wml-warning">
              <AlertTriangle size={16}/>
              <div>
                <strong>{t.warningsTitle}</strong>
                {response.warnings.map((w, i) => <p key={i}>{sanityWarningMessage(t, w)}</p>)}
              </div>
            </div>
          )}

          <div className="result-grid">
            <article><span>{t.grossTotal}</span><strong>{money(displayFigures.gross_total)}</strong></article>
            <article><span>{t.taxTable}</span><strong>{money(displayFigures.table_tax_after_korting)}</strong></article>
            {displayFigures.bt_tax > 0 && <article><span>{t.taxBt}</span><strong>{money(displayFigures.bt_tax)}</strong></article>}
          </div>

          {response.period.pre_tax_deductions.length > 0 && (
            <div className="notice-card">
              <ShieldCheck/>
              <div>
                <h3>{t.preTaxDeductions}</h3>
                {response.period.pre_tax_deductions.map((d, i) => (
                  <p key={i}>
                    {categoryLabel(t, d.category)} <span className="form-note nl-term">({t.dutchTerm(d.description)})</span>:{' '}
                    <strong>{d.amount.provenance === 'unknown' ? '—' : money(d.amount.value as number)}</strong>
                    {d.amount.provenance !== 'unknown' && <span className="form-note"> ({provenanceLabel(t, d.amount.provenance)})</span>}
                  </p>
                ))}
              </div>
            </div>
          )}

          {response.outcome.status === 'incomplete' ? (
            <div className="notice-card">
              <AlertTriangle/>
              <div>
                <h3>{t.incompleteTitle}</h3>
                <p>{t.incompleteBody}</p>
                <ul>
                  {response.outcome.missing_fields.map((field, i) => <li key={i}>{missingFieldLabel(t, field)}</li>)}
                </ul>
                {response.outcome.tax_is_upper_bound && <p className="form-note">{t.upperBoundNote}</p>}
              </div>
            </div>
          ) : (
            <div className="notice-card">
              <ShieldCheck/>
              <div>
                <h3>{t.wageNet}</h3>
                {response.sector_premium_estimate && response.net_range ? (
                  <>
                    <p>
                      <strong>{money(response.net_range.low)} – {money(response.net_range.high)}</strong>{' '}
                      <span className="form-note">({t.rangeNote})</span>
                    </p>
                    <p className="form-note">{t.sectorPremiumBasis(response.sector_premium_estimate.known_terms)}</p>
                  </>
                ) : (
                  <p><strong>{money(response.outcome.result.wage_net)}</strong></p>
                )}
                {response.outcome.result.net_additions_total > 0 && (
                  <p>{t.netAdditions}: <strong>+{money(response.outcome.result.net_additions_total)}</strong></p>
                )}
                <p>{t.payoutAmount}:{' '}
                  <strong>
                    {response.payout_range ? `${money(response.payout_range.low)} – ${money(response.payout_range.high)}` : money(response.outcome.result.payout_amount)}
                  </strong>
                </p>
              </div>
            </div>
          )}

          {/* 3.5 (audit "LOONTO — CONSOLIDATED ASSIGNMENT"): a MENTION only, per spec §6a/§DJ1 - one
              line per group, the held-for-later total, a link. Full breakdown (per-type balances,
              what to claim) belongs to Module 3, not built yet. Gated on 'complete': §1's own rule
              (unknown != 0) means this must not render a "gone for good" figure derived from an
              outcome that couldn't compute wage_net in the first place. */}
          {response.outcome.status === 'complete' && (() => {
            const { gross_total, wage_net, payout_amount } = response.outcome.result;
            const heldForLaterTotal = response.period.reservations.reduce((sum, r) => sum + r.opgebouwd_this_period, 0);
            const spe = response.sector_premium_estimate;
            // AZ5: the sector-premium estimate is applied to net/payout AFTER wage_net, never inside
            // pre_tax_deductions - so "gone for good" must add it back in explicitly (as a range) or
            // it would understate the group by exactly the premium estimate mode already shows
            // elsewhere on this same result.
            const goneForGoodLow = spe ? gross_total - wage_net + spe.low_amount : gross_total - wage_net;
            const goneForGoodHigh = spe ? gross_total - wage_net + spe.high_amount : gross_total - wage_net;
            return (
              <div className="notice-card three-groups">
                <div>
                  <h3>{t.threeGroupsTitle}</h3>
                  <p>
                    <strong>{t.paidNowLabel}</strong>: {response.payout_range ? `${money(response.payout_range.low)} – ${money(response.payout_range.high)}` : money(payout_amount)}{' '}
                    <span className="form-note">({t.paidNowHint})</span>
                  </p>
                  <p>
                    <strong>{t.goneForGoodLabel}</strong>: {goneForGoodLow === goneForGoodHigh ? money(goneForGoodLow) : `${money(goneForGoodLow)} – ${money(goneForGoodHigh)}`}{' '}
                    <span className="form-note">({t.goneForGoodHint})</span>
                  </p>
                  {heldForLaterTotal > 0 && (
                    <>
                      <p><strong>{t.heldForLaterLabel}</strong>: {money(heldForLaterTotal)} <span className="form-note">({t.heldForLaterHint})</span></p>
                      <p className="form-note">{t.heldForLaterNote}</p>
                      <button type="button" className="secondary" onClick={onNavigateToDictionary}>{t.heldForLaterLink}</button>
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* CA3/CA5 (audit "CK RESTATED, THEN FINISH TIER A" round): visible on every result, in
              every language, not a tooltip - the owner's requirement (spec §5a) that reliability be
              stated at the point of use. §3.4: Tier B gets its own reliability sentence ("based on
              your contract; deduction rates still not yours") - the permanent limitation is
              tier-agnostic and unchanged. */}
          <p className="form-note calc-reliability-note">{tierMode === 'B' ? t.reliabilityNoteB : t.reliabilityNote}</p>
          <p className="form-note calc-reliability-note">{t.permanentLimitationNote}</p>
        </div>
        );
      })()}
    </section>
  );
}
