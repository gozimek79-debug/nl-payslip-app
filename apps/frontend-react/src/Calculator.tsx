import { useEffect, useState } from 'react';
import { AlertTriangle, Calculator as CalculatorIcon, Download, Printer, ShieldCheck, Sparkles } from 'lucide-react';
import { translations, type Lang } from './translations.ts';

type PeriodType = 'week' | '4-wekelijks' | 'maand';

interface OvertimeTier { hours: number; multiplier: number }

type PensionMode = 'none' | 'percent' | 'stipp';

interface AdvancedInput {
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

interface CalculatorInput {
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

interface CalculatorResult {
  grossBreakdown: {
    normal: number; saturday: number; sunday: number; holiday: number; night: number;
    overtime: number; subtotal: number; vakantiegeld: number; totalGross: number;
  };
  premiumBreakdown: { pensionPremium: number; paww: number; sicknessInsurance: number; wga: number; loonVoorHeffingen: number };
  taxBreakdown: {
    taxableBase: number; thirtyPercentExempt: number; loonheffingTabel: number; loonheffingBijzonderTarief: number;
    bijzonderTariefPercent: number;
    loonheffingBeforeKorting: number; algemeneHeffingskorting: number; arbeidskorting: number; totalTax: number;
  };
  netAdjustments: { travelAllowance: number; otherDeductions: number };
  totalHours: number;
  netTotal: number;
  effectiveHourlyNet: number;
  wmlCheck: { minimumHourlyRate: number; isBelowMinimum: boolean };
  annual: { gross: number; taxableWage: number; tax: number; pensionPremium: number; paww: number; travelAllowance: number; net: number };
  taxYear: number;
  disclaimer: string;
}

interface OvertimeTierForm { hours: string; multiplier: number }

interface AdvancedForm {
  enabled: boolean;
  pensionMode: PensionMode;
  pensionPremiumPercent: string;
  pawwPercent: string;
  sicknessInsurancePercent: string;
  wgaPremiumPercent: string;
  travelAllowance: string;
  otherDeductions: string;
  applyBijzonderTarief: boolean;
}

interface FormState {
  periodType: PeriodType;
  baseHourlyRate: string;
  hours: { normal: string; saturday: string; sunday: string; holiday: string; night: string };
  toeslagPercentages: { saturday: string; sunday: string; holiday: string; night: string };
  overtime: { tier1: OvertimeTierForm; tier2: OvertimeTierForm };
  includeVakantiegeld: boolean;
  applyThirtyPercentRuling: boolean;
  applyLoonheffingskorting: boolean;
  advanced: AdvancedForm;
}

const defaultForm: FormState = {
  periodType: 'maand',
  baseHourlyRate: '16',
  hours: { normal: '160', saturday: '', sunday: '', holiday: '', night: '' },
  toeslagPercentages: { saturday: '25', sunday: '50', holiday: '100', night: '15' },
  overtime: { tier1: { hours: '', multiplier: 1.25 }, tier2: { hours: '', multiplier: 1.5 } },
  includeVakantiegeld: true,
  applyThirtyPercentRuling: false,
  applyLoonheffingskorting: true,
  advanced: {
    enabled: false,
    pensionMode: 'percent',
    pensionPremiumPercent: '0',
    pawwPercent: '0.10',
    sicknessInsurancePercent: '0',
    wgaPremiumPercent: '0',
    travelAllowance: '0',
    otherDeductions: '0',
    applyBijzonderTarief: false,
  },
};

function money(value: number): string {
  return `€${value.toFixed(2)}`;
}

// Akceptuje zarówno przecinek, jak i kropkę jako separator dziesiętny (np. "15,58").
function sanitizeDecimalInput(value: string): string {
  return value.replace(/[^0-9.,]/g, '');
}

function parseDecimal(value: string): number {
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildCalculatorInput(form: FormState): CalculatorInput {
  return {
    periodType: form.periodType,
    baseHourlyRate: parseDecimal(form.baseHourlyRate),
    hours: {
      normal: parseDecimal(form.hours.normal),
      saturday: parseDecimal(form.hours.saturday),
      sunday: parseDecimal(form.hours.sunday),
      holiday: parseDecimal(form.hours.holiday),
      night: parseDecimal(form.hours.night),
    },
    toeslagPercentages: {
      saturday: parseDecimal(form.toeslagPercentages.saturday),
      sunday: parseDecimal(form.toeslagPercentages.sunday),
      holiday: parseDecimal(form.toeslagPercentages.holiday),
      night: parseDecimal(form.toeslagPercentages.night),
    },
    overtime: {
      tier1: { hours: parseDecimal(form.overtime.tier1.hours), multiplier: form.overtime.tier1.multiplier },
      tier2: { hours: parseDecimal(form.overtime.tier2.hours), multiplier: form.overtime.tier2.multiplier },
    },
    includeVakantiegeld: form.includeVakantiegeld,
    applyThirtyPercentRuling: form.applyThirtyPercentRuling,
    applyLoonheffingskorting: form.applyLoonheffingskorting,
    advanced: {
      enabled: form.advanced.enabled,
      pensionMode: form.advanced.pensionMode,
      pensionPremiumPercent: parseDecimal(form.advanced.pensionPremiumPercent),
      pawwPercent: parseDecimal(form.advanced.pawwPercent),
      sicknessInsurancePercent: parseDecimal(form.advanced.sicknessInsurancePercent),
      wgaPremiumPercent: parseDecimal(form.advanced.wgaPremiumPercent),
      travelAllowance: parseDecimal(form.advanced.travelAllowance),
      otherDeductions: parseDecimal(form.advanced.otherDeductions),
      applyBijzonderTarief: form.advanced.applyBijzonderTarief,
    },
  };
}

const overtimeMultiplierOptions = [1.25, 1.5, 2];

export function Calculator({ lang }: { lang: Lang }) {
  const t = translations[lang].calc;
  const periodLabels: Record<PeriodType, string> = { week: t.periodWeek, '4-wekelijks': t.period4w, maand: t.periodMonth };
  const hourFields: Array<[keyof FormState['hours'], string]> = [
    ['normal', t.hNormal], ['saturday', t.hSaturday], ['sunday', t.hSunday], ['holiday', t.hHoliday], ['night', t.hNight],
  ];
  const toeslagFields: Array<[keyof FormState['toeslagPercentages'], string]> = [
    ['saturday', t.tSaturday], ['sunday', t.tSunday], ['holiday', t.tHoliday], ['night', t.tNight],
  ];

  const [form, setForm] = useState<FormState>(defaultForm);
  const [lastInput, setLastInput] = useState<CalculatorInput | null>(null);
  const [result, setResult] = useState<CalculatorResult | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiExplanation, setAiExplanation] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    void fetch('/api/ai/status').then(response => response.json()).then((data: { available: boolean }) => setAiAvailable(data.available)).catch(() => undefined);
  }, []);

  function updateHours(key: keyof FormState['hours'], value: string) {
    setForm(current => ({ ...current, hours: { ...current.hours, [key]: sanitizeDecimalInput(value) } }));
  }

  function updateToeslag(key: keyof FormState['toeslagPercentages'], value: string) {
    setForm(current => ({ ...current, toeslagPercentages: { ...current.toeslagPercentages, [key]: sanitizeDecimalInput(value) } }));
  }

  function updateOvertimeHours(tier: 'tier1' | 'tier2', value: string) {
    setForm(current => ({ ...current, overtime: { ...current.overtime, [tier]: { ...current.overtime[tier], hours: sanitizeDecimalInput(value) } } }));
  }

  function updateOvertimeMultiplier(tier: 'tier1' | 'tier2', value: number) {
    setForm(current => ({ ...current, overtime: { ...current.overtime, [tier]: { ...current.overtime[tier], multiplier: value } } }));
  }

  function updateAdvanced<K extends keyof AdvancedForm>(key: K, value: AdvancedForm[K]) {
    setForm(current => ({ ...current, advanced: { ...current.advanced, [key]: value } }));
  }

  async function calculate(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    const calcInput = buildCalculatorInput(form);
    try {
      const response = await fetch('/api/calculator/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(calcInput),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Error');
      setResult(data as CalculatorResult);
      setLastInput(calcInput);
      setAiExplanation('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Error');
    } finally {
      setLoading(false);
    }
  }

  async function explainWithAi() {
    if (!lastInput) return;
    setAiLoading(true);
    try {
      const response = await fetch('/api/calculator/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...lastInput, language: lang }),
      });
      const data = await response.json() as { explanation?: string; error?: string };
      if (!response.ok || !data.explanation) throw new Error(data.error ?? 'Error');
      setAiExplanation(data.explanation);
    } catch (error) {
      setAiExplanation(error instanceof Error ? error.message : 'Error');
    } finally {
      setAiLoading(false);
    }
  }

  function downloadCsv() {
    if (!result || !lastInput) return;
    const rows: Array<[string, string]> = [
      [t.period, periodLabels[lastInput.periodType]],
      [t.hNormal + '+' + t.hSaturday + '+' + t.hSunday + '+' + t.hHoliday + '+' + t.hNight, String(result.totalHours)],
      [t.totalGross, money(result.grossBreakdown.totalGross)],
      [t.vakantiegeldLabel, money(result.grossBreakdown.vakantiegeld)],
      [t.exempt, money(result.taxBreakdown.thirtyPercentExempt)],
      [t.taxableBase, money(result.taxBreakdown.taxableBase)],
      [t.taxAfterRelief, money(result.taxBreakdown.totalTax)],
      [t.netTotal, money(result.netTotal)],
      [t.effectiveNet, money(result.effectiveHourlyNet)],
    ];
    if (lastInput.advanced.enabled) {
      rows.push(
        [t.pensionPremiumLabel, money(result.premiumBreakdown.pensionPremium)],
        [t.pawwLabel, money(result.premiumBreakdown.paww)],
        [t.sicknessLabel, money(result.premiumBreakdown.sicknessInsurance)],
        [t.wgaLabel, money(result.premiumBreakdown.wga)],
        [t.loonVoorHeffingen, money(result.premiumBreakdown.loonVoorHeffingen)],
        [t.travelAllowanceLabel, money(result.netAdjustments.travelAllowance)],
        [t.otherDeductionsLabel, money(result.netAdjustments.otherDeductions)],
        [t.annualGross, money(result.annual.gross)],
        [t.annualNet, money(result.annual.net)],
      );
    }
    const csv = rows.map(([label, value]) => `"${label}","${value}"`).join('\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dutchpay-${lastInput.periodType}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="flow-page calc-page">
      <div className="flow-heading">
        <span className="step">{t.step}</span>
        <h1>{t.title}</h1>
        <p>{t.lead}</p>
      </div>
      <div className="review-grid">
        <form className="fields-card calculator-form-card" onSubmit={event => void calculate(event)}>
          <h2><CalculatorIcon size={20}/> {t.inputsTitle}</h2>

          <label className="calc-select-label">{t.period}
            <select value={form.periodType} onChange={event => setForm(current => ({ ...current, periodType: event.target.value as PeriodType }))}>
              {(Object.entries(periodLabels) as Array<[PeriodType, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>

          <label>{t.baseRate}
            <div className="money-input"><span>€</span><input required inputMode="decimal" placeholder="e.g. 15.58" value={form.baseHourlyRate} onChange={event => setForm(current => ({ ...current, baseHourlyRate: sanitizeDecimalInput(event.target.value) }))}/></div>
          </label>

          <h3 className="calc-subheading">{t.hoursTitle}</h3>
          <div className="fields-grid">
            {hourFields.map(([key, label]) => (
              <label key={key}>{label}
                <div className="money-input"><span>h</span><input inputMode="decimal" placeholder="0" value={form.hours[key]} onChange={event => updateHours(key, event.target.value)}/></div>
              </label>
            ))}
          </div>

          <h3 className="calc-subheading">{t.toeslagTitle}</h3>
          <div className="fields-grid">
            {toeslagFields.map(([key, label]) => (
              <label key={key}>{label}
                <div className="money-input"><span>%</span><input inputMode="decimal" placeholder="0" value={form.toeslagPercentages[key]} onChange={event => updateToeslag(key, event.target.value)}/></div>
              </label>
            ))}
          </div>

          <h3 className="calc-subheading">{t.overtimeTitle}</h3>
          <div className="fields-grid">
            <label>{t.overtimeTier1}
              <div className="money-input"><span>h</span><input inputMode="decimal" placeholder="0" value={form.overtime.tier1.hours} onChange={event => updateOvertimeHours('tier1', event.target.value)}/></div>
            </label>
            <label>{t.overtimeMultiplier}
              <select value={form.overtime.tier1.multiplier} onChange={event => updateOvertimeMultiplier('tier1', Number(event.target.value))}>
                {overtimeMultiplierOptions.map(value => <option key={value} value={value}>{value.toFixed(2)}x</option>)}
              </select>
            </label>
            <label>{t.overtimeTier2}
              <div className="money-input"><span>h</span><input inputMode="decimal" placeholder="0" value={form.overtime.tier2.hours} onChange={event => updateOvertimeHours('tier2', event.target.value)}/></div>
            </label>
            <label>{t.overtimeMultiplier}
              <select value={form.overtime.tier2.multiplier} onChange={event => updateOvertimeMultiplier('tier2', Number(event.target.value))}>
                {overtimeMultiplierOptions.map(value => <option key={value} value={value}>{value.toFixed(2)}x</option>)}
              </select>
            </label>
          </div>

          <h3 className="calc-subheading">{t.perksTitle}</h3>
          <div className="calc-toggles">
            <label className="calc-toggle"><input type="checkbox" checked={form.includeVakantiegeld} onChange={event => setForm(current => ({ ...current, includeVakantiegeld: event.target.checked }))}/> {t.vakantiegeld}</label>
            <label className="calc-toggle"><input type="checkbox" checked={form.applyLoonheffingskorting} onChange={event => setForm(current => ({ ...current, applyLoonheffingskorting: event.target.checked }))}/> {t.loonheffingskorting}</label>
            <label className="calc-toggle"><input type="checkbox" checked={form.applyThirtyPercentRuling} onChange={event => setForm(current => ({ ...current, applyThirtyPercentRuling: event.target.checked }))}/> {t.thirtyPercent}</label>
          </div>

          <h3 className="calc-subheading">{t.advancedTitle}</h3>
          <div className="calc-toggles">
            <label className="calc-toggle"><input type="checkbox" checked={form.advanced.enabled} onChange={event => updateAdvanced('enabled', event.target.checked)}/> {t.advancedToggle}</label>
          </div>
          {form.advanced.enabled && (
            <div className="calc-advanced-panel">
              <small className="form-note">{t.advancedHint}</small>
              <label className="calc-select-label">{t.pensionModeLabel}
                <select value={form.advanced.pensionMode} onChange={event => updateAdvanced('pensionMode', event.target.value as PensionMode)}>
                  <option value="none">{t.pensionModeNone}</option>
                  <option value="percent">{t.pensionModePercent}</option>
                  <option value="stipp">{t.pensionModeStipp}</option>
                </select>
              </label>
              {form.advanced.pensionMode === 'stipp' && <small className="form-note">{t.pensionModeStippHint}</small>}
              <div className="fields-grid">
                {form.advanced.pensionMode === 'percent' && (
                  <label>{t.pensionPremiumPercent}
                    <div className="money-input"><span>%</span><input inputMode="decimal" value={form.advanced.pensionPremiumPercent} onChange={event => updateAdvanced('pensionPremiumPercent', sanitizeDecimalInput(event.target.value))}/></div>
                  </label>
                )}
                <label>{t.pawwPercent}
                  <div className="money-input"><span>%</span><input inputMode="decimal" value={form.advanced.pawwPercent} onChange={event => updateAdvanced('pawwPercent', sanitizeDecimalInput(event.target.value))}/></div>
                </label>
                <label>{t.sicknessInsurancePercent}
                  <div className="money-input"><span>%</span><input inputMode="decimal" value={form.advanced.sicknessInsurancePercent} onChange={event => updateAdvanced('sicknessInsurancePercent', sanitizeDecimalInput(event.target.value))}/></div>
                </label>
                <label>{t.wgaPremiumPercent}
                  <div className="money-input"><span>%</span><input inputMode="decimal" value={form.advanced.wgaPremiumPercent} onChange={event => updateAdvanced('wgaPremiumPercent', sanitizeDecimalInput(event.target.value))}/></div>
                </label>
                <label>{t.travelAllowance}
                  <div className="money-input"><span>€</span><input inputMode="decimal" value={form.advanced.travelAllowance} onChange={event => updateAdvanced('travelAllowance', sanitizeDecimalInput(event.target.value))}/></div>
                </label>
                <label>{t.otherDeductions}
                  <div className="money-input"><span>€</span><input inputMode="decimal" value={form.advanced.otherDeductions} onChange={event => updateAdvanced('otherDeductions', sanitizeDecimalInput(event.target.value))}/></div>
                </label>
              </div>
              <label className="calc-toggle"><input type="checkbox" checked={form.advanced.applyBijzonderTarief} onChange={event => updateAdvanced('applyBijzonderTarief', event.target.checked)}/> {t.applyBijzonderTarief}</label>
              {form.advanced.applyBijzonderTarief && <small className="form-note">{t.bijzonderTariefAuto}</small>}
            </div>
          )}

          {message && <div className="status error" role="status">{message}</div>}
          <button className="primary" type="submit" disabled={loading}>{loading ? t.calculating : t.submit}</button>
        </form>

        <aside className="notice-card calc-side-notice">
          <ShieldCheck/>
          <div>
            <h3>{t.howTitle}</h3>
            <p>{t.how1}</p>
            <p>{t.how2}</p>
          </div>
        </aside>
      </div>

      {result && lastInput && (
        <div className="calc-result" id="calc-print">
          {result.wmlCheck.isBelowMinimum && (
            <div className="status error calc-wml-warning"><AlertTriangle size={16}/> {t.wmlWarning(result.wmlCheck.minimumHourlyRate.toFixed(2), result.taxYear)}</div>
          )}
          <div className="result-hero">
            <div className="result-icon">€</div>
            <div><span>{t.resultFor}: {periodLabels[lastInput.periodType]}</span><h2>{t.netTotal}: {money(result.netTotal)}</h2></div>
          </div>
          <div className="result-grid">
            <article><span>{t.totalGross}</span><strong>{money(result.grossBreakdown.totalGross)}</strong></article>
            <article><span>{t.vakantiegeldLabel}</span><strong>{money(result.grossBreakdown.vakantiegeld)}</strong></article>
            <article><span>{t.taxAfterRelief}</span><strong>{money(result.taxBreakdown.totalTax)}</strong></article>
            <article><span>{t.effectiveNet}</span><strong>{money(result.effectiveHourlyNet)}</strong></article>
          </div>
          {lastInput.applyThirtyPercentRuling && (
            <div className="result-grid">
              <article><span>{t.exempt}</span><strong>{money(result.taxBreakdown.thirtyPercentExempt)}</strong></article>
              <article><span>{t.taxableBase}</span><strong>{money(result.taxBreakdown.taxableBase)}</strong></article>
            </div>
          )}

          {lastInput.advanced.enabled && (
            <>
              <div className="notice-card">
                <ShieldCheck/>
                <div>
                  <h3>{t.premiumsTitle}</h3>
                  <div className="result-grid">
                    <article><span>{t.pensionPremiumLabel}</span><strong>{money(result.premiumBreakdown.pensionPremium)}</strong></article>
                    <article><span>{t.pawwLabel}</span><strong>{money(result.premiumBreakdown.paww)}</strong></article>
                    <article><span>{t.sicknessLabel}</span><strong>{money(result.premiumBreakdown.sicknessInsurance)}</strong></article>
                    <article><span>{t.wgaLabel}</span><strong>{money(result.premiumBreakdown.wga)}</strong></article>
                  </div>
                  <p>{t.loonVoorHeffingen}: <strong>{money(result.premiumBreakdown.loonVoorHeffingen)}</strong></p>
                  {lastInput.advanced.applyBijzonderTarief && (
                    <p>{t.loonheffingTabelLabel}: <strong>{money(result.taxBreakdown.loonheffingTabel)}</strong> · {t.loonheffingBTLabel} ({result.taxBreakdown.bijzonderTariefPercent}%): <strong>{money(result.taxBreakdown.loonheffingBijzonderTarief)}</strong></p>
                  )}
                  {(result.netAdjustments.travelAllowance > 0 || result.netAdjustments.otherDeductions > 0) && (
                    <p>{t.travelAllowanceLabel}: <strong>+{money(result.netAdjustments.travelAllowance)}</strong> · {t.otherDeductionsLabel}: <strong>-{money(result.netAdjustments.otherDeductions)}</strong></p>
                  )}
                </div>
              </div>

              <div className="notice-card">
                <ShieldCheck/>
                <div>
                  <h3>{t.annualTitle}</h3>
                  <p className="form-note">{t.annualHint}</p>
                  <div className="result-grid">
                    <article><span>{t.annualGross}</span><strong>{money(result.annual.gross)}</strong></article>
                    <article><span>{t.annualTaxableWage}</span><strong>{money(result.annual.taxableWage)}</strong></article>
                    <article><span>{t.annualTax}</span><strong>{money(result.annual.tax)}</strong></article>
                    <article><span>{t.annualNet}</span><strong>{money(result.annual.net)}</strong></article>
                  </div>
                  <p>{t.annualPension}: <strong>{money(result.annual.pensionPremium)}</strong> · {t.annualPaww}: <strong>{money(result.annual.paww)}</strong> · {t.annualTravelAllowance}: <strong>{money(result.annual.travelAllowance)}</strong></p>
                </div>
              </div>
            </>
          )}

          <div className="notice-card">
            <ShieldCheck/>
            <div>
              <h3>{t.disclaimerTitle}</h3>
              <p>{t.disclaimerText}</p>
              <p>{t.taxTable} {result.taxYear}.</p>
            </div>
          </div>
          {aiAvailable && (
            <div className="notice-card ai-notice-card">
              <Sparkles/>
              <div>
                <h3>{t.aiTitle}</h3>
                {aiExplanation ? <p>{aiExplanation}</p> : <p className="form-note">{t.aiPrompt}</p>}
                <button type="button" className="secondary" disabled={aiLoading} onClick={() => void explainWithAi()}>{aiLoading ? t.aiLoading : aiExplanation ? t.aiRetry : t.aiAsk}</button>
              </div>
            </div>
          )}
          <div className="calculator-actions">
            <button className="secondary" type="button" onClick={() => window.print()}><Printer size={16}/> {t.print}</button>
            <button className="secondary" type="button" onClick={downloadCsv}><Download size={16}/> {t.csv}</button>
          </div>
        </div>
      )}
    </section>
  );
}
