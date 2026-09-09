import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Calculator as CalculatorIcon, Check, FileText, LockKeyhole, Sparkles, ShieldCheck, Upload } from 'lucide-react';
import { recognizePayslip, renderPageImages } from './local-ocr.ts';
import { Calculator } from './Calculator.tsx';
import { StepProgress } from './StepProgress.tsx';
import { AccountPage } from './AccountPage.tsx';
import { ContractAnalysis } from './ContractAnalysis.tsx';
import { translations, type Lang } from './translations.ts';

type Mode = 'analyze' | 'calculator' | 'contract' | 'account';
type Step = 'upload' | 'review' | 'result' | 'full-result';
type UploadState = 'idle' | 'uploading' | 'accepted' | 'error';
type Fields = { hours: number; hourlyRate: number; grossBase: number; additions: number; deductions: number; netPaid: number };
type FieldsText = Record<keyof Fields, string>;
type AnalysisResult = {
  status: 'consistent' | 'attention';
  summary: string;
  arithmetic: { expectedGross: number; reportedGross: number; difference: number; grossConsistent: boolean; reportedNet: number; additions: number; deductions: number };
  notices: string[];
};
type FullPayslipLineItem = { section: string; description: string; quantity: number | null; rate: number | null; payment: number | null; deduction: number | null };
type FullPayslipExtraction = {
  period: string | null; periodEndDate: string | null; hourlyRate: number | null; minimumWage: number | null; hoursPerWeek: number | null;
  contractType: string | null; thirtyPercentRuling: boolean; lineItems: FullPayslipLineItem[];
  reportedTotalGross: number | null; reportedTotalNet: number | null; reportedNetPaid: number | null; truncated: boolean;
};
type FullPayslipValidation = {
  totalPayments: number; totalDeductions: number; computedNet: number; reportedNet: number | null; variance: number | null;
  isConsistent: boolean; wmlViolation: boolean; minimumWageApplicable: number | null; minimumWageNote: string | null;
  discrepancies: string[]; incomplete: boolean;
};
type FullAnalysisResponse = { extraction: FullPayslipExtraction; validation: FullPayslipValidation; explanation: string };
type User = { id: string; email: string };
type HistoryItem = { id: string; fileName: string; status: string; createdAt: string };

const emptyFieldsText: FieldsText = { hours: '', hourlyRate: '', grossBase: '', additions: '', deductions: '', netPaid: '' };

function sanitizeDecimalInput(value: string): string {
  return value.replace(/[^0-9.,]/g, '');
}

function parseDecimal(value: string): number {
  const parsed = Number(value.trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fieldsToText(fields: Fields): FieldsText {
  return {
    hours: String(fields.hours), hourlyRate: String(fields.hourlyRate), grossBase: String(fields.grossBase),
    additions: String(fields.additions), deductions: String(fields.deductions), netPaid: String(fields.netPaid),
  };
}

function textToFields(text: FieldsText): Fields {
  return {
    hours: parseDecimal(text.hours), hourlyRate: parseDecimal(text.hourlyRate), grossBase: parseDecimal(text.grossBase),
    additions: parseDecimal(text.additions), deductions: parseDecimal(text.deductions), netPaid: parseDecimal(text.netPaid),
  };
}

function money(value: number | null): string {
  return value === null ? '—' : `€${value.toFixed(2)}`;
}

function readStoredLang(): Lang {
  try {
    const stored = localStorage.getItem('loonto-lang');
    return stored === 'en' ? 'en' : 'pl';
  } catch {
    return 'pl';
  }
}

export function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [lang, setLang] = useState<Lang>(readStoredLang);
  const t = translations[lang];
  const [mode, setMode] = useState<Mode>('analyze');
  const [step, setStep] = useState<Step>('upload');
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [message, setMessage] = useState('');
  const [analysisId, setAnalysisId] = useState('');
  const [fileName, setFileName] = useState('');
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [fieldsText, setFieldsText] = useState<FieldsText>(emptyFieldsText);
  const [previewImageBase64, setPreviewImageBase64] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [fullResult, setFullResult] = useState<FullAnalysisResponse | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [ocrConfidence, setOcrConfidence] = useState(0);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiVisionAvailable, setAiVisionAvailable] = useState(false);
  const [aiOcrLoading, setAiOcrLoading] = useState(false);
  const [aiExplainLoading, setAiExplainLoading] = useState(false);
  const [aiExplanation, setAiExplanation] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [authNotice, setAuthNotice] = useState<'success' | 'expired' | 'invalid' | 'error' | null>(null);

  useEffect(() => {
    void fetch('/api/auth/me').then((response) => response.json()).then((data: { user: User | null }) => setUser(data.user)).catch(() => undefined);
    void fetch('/api/ai/status').then((response) => response.json()).then((data: { available: boolean; visionAvailable: boolean }) => { setAiAvailable(data.available); setAiVisionAvailable(data.visionAvailable); }).catch(() => undefined);

    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    if (auth === 'success' || auth === 'expired' || auth === 'invalid' || auth === 'error') {
      setAuthNotice(auth);
      if (auth === 'success') { setMode('account'); void loadHistory(); }
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  useEffect(() => {
    try { localStorage.setItem('loonto-lang', lang); } catch { /* ignore */ }
  }, [lang]);

  async function login() {
    setMagicLinkSent(false);
    const response = await fetch('/api/auth/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, language: lang }) });
    const data = await response.json() as { sent?: boolean; error?: string };
    if (!response.ok || !data.sent) { setMessage(data.error ?? 'Error'); return; }
    setMessage(''); setMagicLinkSent(true);
  }

  async function loadHistory() {
    const response = await fetch('/api/auth/history');
    if (response.ok) { const data = await response.json() as { items: HistoryItem[] }; setHistory(data.items); }
  }

  async function logout() {
    await fetch('/api/auth/session', { method: 'DELETE' });
    setUser(null); setHistory([]); setAccountOpen(false); setMode('analyze');
  }

  async function runFullAnalysis(file: File) {
    setUploadState('uploading'); setMessage(t.fullResult.analyzing);
    try {
      const images = await renderPageImages(file);
      const response = await fetch('/api/payslips/analyze-full', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, language: lang }),
      });
      const data = await response.json() as FullAnalysisResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Error');
      setFileName(file.name); setFullResult(data); setUploadState('accepted'); setMessage(''); setStep('full-result');
    } catch (error) {
      setUploadState('error'); setMessage(error instanceof Error ? error.message : 'Error');
    }
  }

  async function runManualFlow(file: File) {
    setUploadState('uploading'); setMessage('...');
    try {
      const ocr = await recognizePayslip(file, (progress) => setMessage(`${progress}%`));
      const response = await fetch('/api/payslips/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, mimeType: file.type }),
      });
      const data = await response.json() as { error?: string; analysisId: string };
      if (!response.ok) throw new Error(data.error ?? 'Error');
      setAnalysisId(data.analysisId); setFileName(file.name); setFieldsText(fieldsToText(ocr.fields)); setPreviewImageBase64(ocr.previewImageBase64); setOcrConfidence(ocr.confidence); setUploadState('accepted'); setMessage(''); setStep('review');
    } catch (error) { setUploadState('error'); setMessage(error instanceof Error ? error.message : 'Error'); }
  }

  async function uploadFile(file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setUploadState('error'); setMessage(lang === 'pl' ? 'Plik jest większy niż 10 MB.' : 'The file is larger than 10 MB.'); return; }
    setPendingFile(file);
    if (aiVisionAvailable) await runFullAnalysis(file);
    else await runManualFlow(file);
  }

  function switchToManual() {
    if (pendingFile) void runManualFlow(pendingFile);
  }

  async function aiAssistOcr() {
    if (!previewImageBase64) return;
    setAiOcrLoading(true); setMessage('');
    try {
      const response = await fetch('/api/payslips/ai-ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageBase64: previewImageBase64 }) });
      const data = await response.json() as { fields?: Fields; error?: string };
      if (!response.ok || !data.fields) throw new Error(data.error ?? 'Error');
      setFieldsText(fieldsToText(data.fields));
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Error'); } finally { setAiOcrLoading(false); }
  }

  async function analyze() {
    setMessage('...');
    const fields = textToFields(fieldsText);
    try {
      const response = await fetch('/api/payslips/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ analysisId, userVerified: true, fields }) });
      const data = await response.json() as AnalysisResult & { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Error');
      setResult(data); setMessage(''); setAiExplanation(''); setStep('result');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Error'); }
  }

  async function aiExplainResult() {
    if (!result) return;
    setAiExplainLoading(true);
    try {
      const response = await fetch('/api/payslips/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: textToFields(fieldsText), result, language: lang }) });
      const data = await response.json() as { explanation?: string; error?: string };
      if (!response.ok || !data.explanation) throw new Error(data.error ?? 'Error');
      setAiExplanation(data.explanation);
    } catch (error) { setAiExplanation(error instanceof Error ? error.message : 'Error'); } finally { setAiExplainLoading(false); }
  }

  function startOver() {
    setStep('upload'); setUploadState('idle'); setMessage(''); setAnalysisId(''); setFileName(''); setPendingFile(null);
    setFieldsText(emptyFieldsText); setPreviewImageBase64(''); setResult(null); setFullResult(null); setOcrConfidence(0); setAiExplanation('');
  }

  const lineItemsBySection = fullResult
    ? fullResult.extraction.lineItems.reduce<Record<string, FullPayslipLineItem[]>>((acc, item) => {
        (acc[item.section] ??= []).push(item);
        return acc;
      }, {})
    : {};

  return <div className="app-shell">
    <header className="site-header">
      <button className="brand plain-button" onClick={() => { setMode('analyze'); startOver(); }}><span className="brand-mark">L</span>loonto</button>
      <nav>
        {mode === 'analyze' && <a href="#how">{t.nav.how}</a>}
        <div className="lang-switch">
          <button type="button" className={lang === 'pl' ? 'active' : ''} onClick={() => setLang('pl')}>PL</button>
          <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
        </div>
        <button type="button" className={`mode-switch ${mode === 'calculator' ? 'active' : ''}`} onClick={() => setMode('calculator')}><CalculatorIcon size={15}/> {t.nav.calculator}</button>
        <button type="button" className={`mode-switch ${mode === 'contract' ? 'active' : ''}`} onClick={() => setMode('contract')}><ShieldCheck size={15}/> {t.nav.contract}</button>
        <button type="button" className={`mode-switch ${mode === 'account' ? 'active' : ''}`} onClick={() => { if (user) { setMode('account'); void loadHistory(); } else { setAccountOpen(true); } }}>{user ? t.nav.account : t.nav.login}</button>
      </nav>
    </header>
    {authNotice && !accountOpen && <div className={`status ${authNotice === 'success' ? '' : 'error'} auth-notice`} role="status">{authNotice === 'success' ? t.account.noticeSuccess : authNotice === 'expired' ? t.account.noticeExpired : authNotice === 'invalid' ? t.account.noticeInvalid : t.account.noticeError}</div>}
    {accountOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setAccountOpen(false)}><section className="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title" onMouseDown={event => event.stopPropagation()}><button className="modal-close" onClick={() => { setAccountOpen(false); setMagicLinkSent(false); setAuthNotice(null); }} aria-label={t.account.close}>×</button>{magicLinkSent ? <><span className="step">{t.account.title}</span><h2 id="account-title">{t.account.sentTitle}</h2><p>{t.account.sentBody(email)}</p><button className="secondary" onClick={() => void login()}>{t.account.resend}</button></> : <form onSubmit={event => { event.preventDefault(); void login(); }}><span className="step">{t.account.title}</span><h2 id="account-title">{t.account.heading}</h2><p>{t.account.intro}</p><label className="email-label">{t.account.email}<input required type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com"/></label>{message && <div className="status error">{message}</div>}<button className="primary" type="submit">{t.account.continue}</button></form>}</section></div>}
    <main id="top">
      {mode === 'calculator' && <Calculator lang={lang}/>}
      {mode === 'contract' && <ContractAnalysis lang={lang}/>}
      {mode === 'account' && user && <AccountPage lang={lang} user={user} history={history} onBack={() => setMode('analyze')} onLogout={() => void logout()} onStartAnalysis={() => { setMode('analyze'); startOver(); }}/>}
      {mode === 'analyze' && <>

      {step === 'upload' && <>
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow"><ShieldCheck size={16}/> {t.hero.eyebrow}</div>
            <h1>{t.hero.title1}<em>{t.hero.titleEm}</em></h1>
            <p className="lead">{t.hero.lead}</p>
            <ul><li><Check size={17}/>{t.hero.b1}</li><li><Check size={17}/>{t.hero.b2}</li><li><Check size={17}/>{t.hero.b3}</li></ul>
          </div>
          <div className="upload-card">
            <StepProgress current={uploadState === 'uploading' ? 2 : 1} labels={[t.progress.document, t.progress.data, t.progress.analysis]}/>
            <span className="step-eyebrow">{t.hero.step1}</span>
            <h2>{t.hero.addTitle}</h2>
            <p>{t.hero.addLead}</p>
            <input ref={inputRef} className="hidden" type="file" accept="application/pdf,image/jpeg,image/png" onChange={event => void uploadFile(event.target.files?.[0])} aria-label={t.hero.choose}/>
            <button
              className={`drop ${uploadState} ${isDragOver ? 'drag-over' : ''}`}
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploadState === 'uploading'}
              onDragOver={event => { event.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={event => { event.preventDefault(); setIsDragOver(false); void uploadFile(event.dataTransfer.files?.[0]); }}
            >
              <span className="upload-icon"><Upload/></span>
              <strong>{uploadState === 'uploading' ? (aiVisionAvailable ? t.hero.chooseAi : t.hero.chooseUploading) : isDragOver ? t.hero.dropHere : t.hero.dragTitle}</strong>
              {uploadState !== 'uploading' && <span className="drop-or">{t.hero.dragOr} <u>{t.hero.choose}</u></span>}
              <small>{t.hero.types}</small>
            </button>
            {message && <div className={`status ${uploadState}`} role="status">{message}</div>}
          </div>
        </section>
        <div className="trust-bar">
          <div className="trust-bar-item"><LockKeyhole size={16}/>{t.trustBar.private}</div>
          <div className="trust-bar-item"><ShieldCheck size={16}/>{t.trustBar.noAds}</div>
          <div className="trust-bar-item"><Check size={16}/>{t.trustBar.control}</div>
          <div className="trust-bar-item"><FileText size={16}/>{t.trustBar.sources}</div>
        </div>
        <section className="how" id="how"><article><FileText/><span>01</span><h3>{t.hero.how1t}</h3><p>{t.hero.how1}</p></article><article><Sparkles/><span>02</span><h3>{t.hero.how2t}</h3><p>{t.hero.how2}</p></article><article><ShieldCheck/><span>03</span><h3>{t.hero.how3t}</h3><p>{t.hero.how3}</p></article></section>
      </>}

      {step === 'review' && <section className="flow-page"><button className="back plain-button" onClick={startOver}><ArrowLeft size={17}/>{t.review.backToUpload}</button><StepProgress current={2} labels={[t.progress.document, t.progress.data, t.progress.analysis]}/><div className="flow-heading"><span className="step">{t.review.step2}</span><h1>{t.review.title}</h1><p>{t.review.lead}</p></div><div className="review-grid"><aside className="document-card"><FileText size={34}/><strong>{fileName}</strong><span className="document-status"><Check size={15}/>{t.review.documentRead}</span><span>{t.review.notUploaded}</span><div className={`ocr-score ${ocrConfidence >= 80 ? 'good' : 'low'}`}><span>{t.review.ocrScore}</span><strong>{ocrConfidence}%</strong><small>{ocrConfidence >= 80 ? t.review.ocrGood : t.review.ocrLow}</small></div><div className="document-placeholder">{t.review.placeholder}</div>{aiVisionAvailable && <button type="button" className="secondary ai-assist-button" disabled={aiOcrLoading} onClick={() => void aiAssistOcr()}><Sparkles size={16}/> {aiOcrLoading ? t.hero.chooseAi : t.review.tryAi}</button>}{aiVisionAvailable && <small className="form-note">{t.review.tryAiHint}</small>}</aside><form className="fields-card" onSubmit={event => { event.preventDefault(); void analyze(); }}><h2>{t.review.fieldsTitle}</h2><div className="fields-grid">{([['hours', t.review.hours, 'h'], ['hourlyRate', t.review.hourlyRate, '€'], ['grossBase', t.review.grossBase, '€'], ['additions', t.review.additions, '€'], ['deductions', t.review.deductions, '€'], ['netPaid', t.review.netPaid, '€']] as Array<[keyof Fields, string, string]>).map(([key, label, unit]) => <label key={key}>{label}<div className="money-input"><span>{unit}</span><input required inputMode="decimal" value={fieldsText[key]} onChange={event => setFieldsText(current => ({ ...current, [key]: sanitizeDecimalInput(event.target.value) }))}/></div></label>)}</div>{message && <div className="status error" role="status">{message}</div>}<button className="primary" type="submit">{t.review.submit}</button><small className="form-note">{t.review.note}</small></form></div></section>}

      {step === 'result' && result && <section className="flow-page result-page"><button className="back plain-button" onClick={() => setStep('review')}><ArrowLeft size={17}/>{t.result.fixData}</button><StepProgress current={3} labels={[t.progress.document, t.progress.data, t.progress.analysis]}/><div className="flow-heading"><span className="step">{t.result.step3}</span><h1>{t.result.title}</h1><p>{t.result.lead}</p></div><div className={`result-hero ${result.status}`}><div className="result-icon">{result.status === 'consistent' ? <Check/> : '!'}</div><div><span>{t.result.check}</span><h2>{result.status === 'consistent' ? t.result.consistent : t.result.attention}</h2></div></div><div className="result-grid"><article><span>{t.result.expectedGross}</span><strong>€{result.arithmetic.expectedGross.toFixed(2)}</strong></article><article><span>{t.result.reportedGross}</span><strong>€{result.arithmetic.reportedGross.toFixed(2)}</strong></article><article><span>{t.result.difference}</span><strong>€{result.arithmetic.difference.toFixed(2)}</strong></article><article><span>{t.result.reportedNet}</span><strong>€{result.arithmetic.reportedNet.toFixed(2)}</strong></article></div><div className="notice-card"><ShieldCheck/><div><h3>{t.result.nextTitle}</h3><p>{t.result.notice1}</p><p>{t.result.notice2}</p></div></div>{aiAvailable && <div className="notice-card ai-notice-card"><Sparkles/><div><h3>{t.result.aiTitle}</h3>{aiExplanation ? <p>{aiExplanation}</p> : <p className="form-note">{t.result.aiPrompt}</p>}<button type="button" className="secondary" disabled={aiExplainLoading} onClick={() => void aiExplainResult()}>{aiExplainLoading ? t.result.aiLoading : aiExplanation ? t.result.aiRetry : t.result.aiExplain}</button></div></div>}<button className="secondary" onClick={startOver}>{t.result.another}</button></section>}

      {step === 'full-result' && fullResult && <section className="flow-page result-page full-result-page">
        <button className="back plain-button" onClick={startOver}><ArrowLeft size={17}/>{t.result.another}</button>
        <StepProgress current={3} labels={[t.progress.document, t.progress.data, t.progress.analysis]}/>
        <div className="flow-heading"><span className="step">{t.fullResult.step3}</span><h1>{t.fullResult.title}</h1><p>{t.fullResult.lead}</p></div>
        {fullResult.extraction.truncated && <div className="status error calc-wml-warning"><AlertTriangle size={16}/> {t.fullResult.incompleteWarning}</div>}
        {fullResult.validation.minimumWageNote && <div className="status info calc-wml-warning">{fullResult.validation.minimumWageNote}</div>}
        <div className={`result-hero ${fullResult.validation.isConsistent ? 'consistent' : 'attention'}`}>
          <div className="result-icon">{fullResult.validation.isConsistent ? <Check/> : '!'}</div>
          <div><span>{t.result.check}</span><h2>{fullResult.validation.isConsistent ? t.fullResult.consistentTitle : t.fullResult.inconsistentTitle}</h2></div>
        </div>
        <div className="status-counts">
          <div className="status-count ok"><strong>{fullResult.validation.isConsistent ? 1 : 0}</strong><span>{t.statusCounts.ok}</span></div>
          <div className="status-count warn"><strong>{fullResult.validation.discrepancies.length}</strong><span>{t.statusCounts.check}</span></div>
          <div className="status-count info"><strong>{[fullResult.extraction.period, fullResult.extraction.hourlyRate, fullResult.extraction.minimumWage, fullResult.extraction.contractType, fullResult.extraction.thirtyPercentRuling ? true : null].filter(value => value !== null && value !== undefined).length}</strong><span>{t.statusCounts.info}</span></div>
        </div>
        <div className="result-grid">
          <article><span>{t.fullResult.totalPayments}</span><strong>{money(fullResult.validation.totalPayments)}</strong></article>
          <article><span>{t.fullResult.totalDeductions}</span><strong>{money(fullResult.validation.totalDeductions)}</strong></article>
          <article><span>{t.fullResult.computedNet}</span><strong>{money(fullResult.validation.computedNet)}</strong></article>
          <article><span>{t.fullResult.reportedNet}</span><strong>{money(fullResult.validation.reportedNet)}</strong></article>
        </div>
        <div className="header-facts">
          {fullResult.extraction.period && <span><b>{t.fullResult.period}:</b> {fullResult.extraction.period}</span>}
          {fullResult.extraction.hourlyRate !== null && <span><b>{t.fullResult.hourlyRate}:</b> {money(fullResult.extraction.hourlyRate)}</span>}
          {fullResult.extraction.minimumWage !== null && <span><b>{t.fullResult.minimumWage}:</b> {money(fullResult.extraction.minimumWage)}</span>}
          {fullResult.validation.minimumWageApplicable !== null && <span><b>{t.fullResult.minimumWageApplicable}:</b> {money(fullResult.validation.minimumWageApplicable)}</span>}
          {fullResult.extraction.contractType && <span><b>{t.fullResult.contractType}:</b> {fullResult.extraction.contractType}</span>}
          {fullResult.extraction.thirtyPercentRuling && <span><b>{t.fullResult.thirtyPercentRuling}:</b> ✓</span>}
        </div>
        <div className="line-items-card">
          <h2>{t.fullResult.lineItemsTitle}</h2>
          <div className="line-items-scroll">
            <table className="line-items-table">
              <thead><tr><th>{t.fullResult.section}</th><th>{t.fullResult.description}</th><th>{t.fullResult.quantity}</th><th>{t.fullResult.rate}</th><th>{t.fullResult.payment}</th><th>{t.fullResult.deduction}</th></tr></thead>
              <tbody>
                {Object.entries(lineItemsBySection).map(([section, items]) => items.map((item, index) => (
                  <tr key={`${section}-${index}`}>
                    <td>{index === 0 ? section : ''}</td>
                    <td>{item.description}</td>
                    <td>{item.quantity ?? '—'}</td>
                    <td>{item.rate === null ? '—' : item.rate}</td>
                    <td>{item.payment === null ? '—' : money(item.payment)}</td>
                    <td>{item.deduction === null ? '—' : money(item.deduction)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </div>
        {fullResult.validation.discrepancies.length > 0 && <div className="notice-card discrepancy-card"><AlertTriangle/><div><h3>{t.fullResult.discrepanciesTitle}</h3>{fullResult.validation.discrepancies.map(item => <p key={item}>{item}</p>)}</div></div>}
        {fullResult.explanation && <div className="notice-card ai-notice-card"><Sparkles/><div><h3>{t.fullResult.aiTitle}</h3><p style={{ whiteSpace: 'pre-line' }}>{fullResult.explanation}</p></div></div>}
        <div className="calculator-actions">
          <button className="secondary" onClick={startOver}>{t.fullResult.another}</button>
          <button className="secondary" onClick={switchToManual}>{t.fullResult.useManual}</button>
        </div>
      </section>}

      </>}
    </main>
  </div>;
}
