import { useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Info, ShieldCheck, Sparkles, Upload } from 'lucide-react';
import { renderPageImages } from './local-ocr.ts';
import { StepProgress } from './StepProgress.tsx';
import { translations, type Lang } from './translations.ts';

type UploadState = 'idle' | 'uploading' | 'accepted' | 'error';

interface ContractExtraction {
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
  redactedFields: string[];
}

interface ContractFlag { level: 'info' | 'warning'; message: string }

interface ContractAnalysisResult {
  minimumWageAtStart: number | null;
  isBelowMinimumWage: boolean | null;
  maxAllowedProbationWeeks: number | null;
  probationExceedsLimit: boolean | null;
  flags: ContractFlag[];
}

interface ContractResponse { extraction: ContractExtraction; analysis: ContractAnalysisResult; explanation: string }

export function ContractAnalysis({ lang }: { lang: Lang }) {
  const t = translations[lang].contract;
  const progressLabels = translations[lang].progress;
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [isDragOver, setIsDragOver] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<ContractResponse | null>(null);

  async function uploadFile(file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setUploadState('error'); setMessage(lang === 'pl' ? 'Plik jest większy niż 10 MB.' : 'The file is larger than 10 MB.'); return; }
    setUploadState('uploading'); setMessage(t.analyzing);
    try {
      const images = await renderPageImages(file);
      const response = await fetch('/api/contracts/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, language: lang }),
      });
      const data = await response.json() as ContractResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Error');
      setResult(data); setUploadState('accepted'); setMessage('');
    } catch (error) {
      setUploadState('error'); setMessage(error instanceof Error ? error.message : 'Error');
    }
  }

  function startOver() {
    setResult(null); setUploadState('idle'); setMessage('');
  }

  function field(label: string, value: string | number | null): React.ReactNode {
    if (value === null || value === '') return null;
    return <article><span>{label}</span><strong>{value}</strong></article>;
  }

  return (
    <section className="flow-page">
      {!result && <>
        <div className="flow-heading">
          <span className="step">{t.step}</span>
          <h1>{t.title}</h1>
          <p>{t.lead}</p>
        </div>
        <div className="notice-card contract-privacy-card">
          <ShieldCheck/>
          <div><h3>{t.privacyTitle}</h3><p>{t.privacyBody}</p></div>
        </div>
        <div className="upload-card contract-upload-card">
          <StepProgress current={uploadState === 'uploading' ? 2 : 1} labels={[progressLabels.document, progressLabels.analysis]}/>
          <span className="step-eyebrow">{t.step1}</span>
          <h2>{t.addTitle}</h2>
          <p>{t.addLead}</p>
          <input ref={inputRef} className="hidden" type="file" accept="application/pdf,image/jpeg,image/png" onChange={event => void uploadFile(event.target.files?.[0])} aria-label={t.choose}/>
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
            <strong>{uploadState === 'uploading' ? t.analyzing : isDragOver ? t.dropHere : t.dragTitle}</strong>
            {uploadState !== 'uploading' && <span className="drop-or">{t.dragOr} <u>{t.choose}</u></span>}
            <small>{t.types}</small>
          </button>
          {message && <div className={`status ${uploadState}`} role="status">{message}</div>}
        </div>
      </>}

      {result && <>
        <button className="back plain-button" onClick={startOver}><ArrowLeft size={17}/>{t.another}</button>
        <div className="flow-heading"><span className="step">{t.step}</span><h1>{t.resultTitle}</h1></div>

        {result.analysis.isBelowMinimumWage && (
          <div className="status error calc-wml-warning"><AlertTriangle size={16}/> {result.extraction.hourlyRate}€/h &lt; {result.analysis.minimumWageAtStart}€/h</div>
        )}

        <div className="header-facts">
          {field(t.contractType, result.extraction.contractType)}
          {field(t.employer, result.extraction.employerName)}
          {field(t.functionTitle, result.extraction.functionTitle)}
          {field(t.startDate, result.extraction.startDate)}
          {field(t.endDate, result.extraction.endDate)}
          {field(t.hoursPerWeek, result.extraction.hoursPerWeek)}
          {field(t.hourlyRate, result.extraction.hourlyRate !== null ? `€${result.extraction.hourlyRate}` : null)}
          {field(t.monthlySalary, result.extraction.monthlySalary !== null ? `€${result.extraction.monthlySalary}` : null)}
          {field(t.caoName, result.extraction.caoName)}
          {field(t.pensionFund, result.extraction.pensionFund)}
          {field(t.probationPeriod, result.extraction.probationPeriodWeeks)}
          {field(t.noticePeriod, result.extraction.noticePeriodWeeks)}
          {result.extraction.thirtyPercentRuling && <article><span>{t.thirtyPercentRuling}</span><strong>✓</strong></article>}
        </div>

        {result.extraction.redactedFields.length > 0 && (
          <div className="status error"><AlertTriangle size={16}/> {t.redactedNotice}</div>
        )}

        <div className="notice-card">
          <Info/>
          <div>
            <h3>{lang === 'pl' ? 'Uwagi kontroli' : 'Check notes'}</h3>
            {result.analysis.flags.length === 0
              ? <p>{t.noFlags}</p>
              : result.analysis.flags.map(flag => <p key={flag.message}>{flag.message}</p>)}
          </div>
        </div>

        {result.explanation && (
          <div className="notice-card ai-notice-card">
            <Sparkles/>
            <div><h3>{t.aiTitle}</h3><p style={{ whiteSpace: 'pre-line' }}>{result.explanation}</p></div>
          </div>
        )}

        <button className="secondary" onClick={startOver}>{t.another}</button>
      </>}
    </section>
  );
}
