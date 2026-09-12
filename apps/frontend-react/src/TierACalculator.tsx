import { useState } from 'react';
import { AlertTriangle, Calculator as CalculatorIcon, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { translations, type Lang } from './translations.ts';

/**
 * Tier A - "Quick calculator" (SPEC-loonto-architecture.md §3). Replaces the old Calculator.tsx as
 * the app's default calculator: that one silently taxed the full gross whenever the user had no
 * pension/PAWW/sector-premium figures (the live 8% overstatement bug this whole architecture change
 * exists to fix). This component talks to POST /api/tier-a/calculate and renders exactly what that
 * route returns - the full chain with per-line provenance, an explicit "cannot determine net" state
 * when deductions are skipped, and a net RANGE (not a single fabricated number) for "estimate".
 *
 * Language-regression round (audit BJ): every user-facing string here now resolves through
 * translations[lang].tierA, honouring the PL/EN switch - the previous version hardcoded Dutch
 * strings and discarded the `lang` prop entirely (`const t = copy.pl`, despite `copy.pl`'s own
 * content being Dutch, not Polish - a double confusion). BK: every line that names a deduction
 * category also renders the Dutch term the backend supplies (`description`, per audit BK3 - Tier
 * A's own canonical name for that category), never translated, alongside the translated label -
 * that Dutch term is what the user will actually find printed on their own payslip.
 */

type PeriodType = 'week' | '4-weekly' | 'month';
type DeductionMode = 'enter' | 'estimate' | 'skip';
type VakantiegeldMode = 'none' | 'accruing' | 'paid_now';
type Provenance = 'user_entered' | 'contract_extracted' | 'payslip_extracted' | 'estimated' | 'rules_database' | 'unknown';

interface Field<T> {
  provenance: Provenance;
  value: T | null;
}

interface OvertimeLineForm {
  description: string;
  hours: string;
  percent: string;
  addsHours: boolean;
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

interface TierAResponse {
  period: TierAPeriodResponse;
  outcome: Outcome;
  sector_premium_estimate: SectorPremiumEstimate | null;
  net_range: { low: number; high: number } | null;
  payout_range: { low: number; high: number } | null;
  warnings: SanityWarning[];
  taxRatesSource: 'database' | 'static';
}

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

export function TierACalculator({ lang }: { lang: Lang }) {
  const t = translations[lang].tierA;

  const [periodType, setPeriodType] = useState<PeriodType>('week');
  const [hoursWorked, setHoursWorked] = useState('40');
  const [hourlyRate, setHourlyRate] = useState('15.58');
  const [overtimeLines, setOvertimeLines] = useState<OvertimeLineForm[]>([]);
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

  function addOvertimeLine() {
    setOvertimeLines(current => [...current, { description: '', hours: '', percent: '', addsHours: false }]);
  }
  function updateOvertimeLine(index: number, patch: Partial<OvertimeLineForm>) {
    setOvertimeLines(current => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }
  function removeOvertimeLine(index: number) {
    setOvertimeLines(current => current.filter((_, i) => i !== index));
  }

  async function calculate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    const body = {
      period_type: periodType,
      hours_worked: parseDecimal(hoursWorked),
      hourly_rate: parseDecimal(hourlyRate),
      overtime_lines: overtimeLines
        .filter(line => line.hours.trim() !== '')
        .map(line => ({ description: line.description || t.defaultLineDescription, hours: parseDecimal(line.hours), percent: parseDecimal(line.percent), adds_hours: line.addsHours })),
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
      if (!res.ok) throw new Error(data.error ?? t.error);
      setResponse(data as TierAResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : t.error);
      setResponse(null);
    } finally {
      setLoading(false);
    }
  }

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
            <select value={periodType} onChange={event => setPeriodType(event.target.value as PeriodType)}>
              <option value="week">{t.periodWeek}</option>
              <option value="4-weekly">{t.period4w}</option>
              <option value="month">{t.periodMonth}</option>
            </select>
          </label>

          <div className="fields-grid">
            <label>{t.hoursWorked}
              <div className="money-input"><span>h</span><input required inputMode="decimal" value={hoursWorked} onChange={event => setHoursWorked(sanitizeDecimal(event.target.value))}/></div>
            </label>
            <label>{t.hourlyRate}
              <div className="money-input"><span>€</span><input required inputMode="decimal" value={hourlyRate} onChange={event => setHourlyRate(sanitizeDecimal(event.target.value))}/></div>
            </label>
          </div>

          <h3 className="calc-subheading">{t.overtimeTitle}</h3>
          {overtimeLines.map((line, index) => (
            <div className="fields-grid" key={index}>
              <label>{t.lineDescription}
                <input value={line.description} onChange={event => updateOvertimeLine(index, { description: event.target.value })}/>
              </label>
              <label>{t.lineHours}
                <div className="money-input"><span>h</span><input inputMode="decimal" value={line.hours} onChange={event => updateOvertimeLine(index, { hours: sanitizeDecimal(event.target.value) })}/></div>
              </label>
              <label>{t.linePercent}
                <div className="money-input"><span>%</span><input inputMode="decimal" value={line.percent} onChange={event => updateOvertimeLine(index, { percent: sanitizeDecimal(event.target.value) })}/></div>
              </label>
              <label className="calc-toggle">
                <input type="checkbox" checked={line.addsHours} onChange={event => updateOvertimeLine(index, { addsHours: event.target.checked })}/>
                {line.addsHours ? t.addsHours : t.surchargeOnly}
              </label>
              <button type="button" className="secondary" onClick={() => removeOvertimeLine(index)}><Trash2 size={14}/></button>
            </div>
          ))}
          <button type="button" className="secondary" onClick={addOvertimeLine}><Plus size={14}/> {t.addLine}</button>

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

      {response && (() => {
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
        </div>
        );
      })()}
    </section>
  );
}
