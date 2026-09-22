import { useRef, useState } from 'react';
import { AlertTriangle, ShieldCheck, Upload } from 'lucide-react';
import { renderPageImages } from './local-ocr.ts';
import { StepProgress } from './StepProgress.tsx';
import { TierACalculator, type TierAContractPrefill } from './TierACalculator.tsx';
import { translations, type Lang } from './translations.ts';

/**
 * Tier B - "Z umowy" (SPEC-loonto-architecture.md §4, audit "CONSOLIDATED ASSIGNMENT" round §3).
 * Scope, exactly as assigned: "contract extraction pre-fills Tier A. Nothing more." This is NOT a
 * new calculator and NOT a copy of Module 2's contract-analysis flow (ContractAnalysis.tsx) - it
 * reuses the same `/api/contracts/analyze` extraction endpoint (already built for Module 2) but
 * deliberately discards `analysis`/`explanation` from that response. Tier B only wants the raw
 * `extraction` fields that can seed Tier A's own inputs; showing compliance flags here would blur
 * the calculator (Kalkulator) with the interpreter (Analiza) - exactly the confusion spec §8a warns
 * against ("Umowa" vs "Z umowy").
 *
 * Per spec §2 / the owner's own instruction: this is NOT a separate tier-shaped application. Once
 * extraction succeeds, this renders the SAME TierACalculator component Tier A uses, pre-seeded via
 * its `contractPrefill` prop - one engine, one model, one component, populated differently.
 */

type UploadState = 'idle' | 'uploading' | 'error';

interface ContractExtractionResponse {
  hourlyRate: number | null;
  hoursPerWeek: number | null;
  overtimeTierThresholdHours: number | null;
  redactedFields: string[];
}

export function TierBFlow({ lang, onNavigateToDictionary }: { lang: Lang; onNavigateToDictionary: () => void }) {
  const t = translations[lang].tierB;
  const progressLabels = translations[lang].progress;
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [isDragOver, setIsDragOver] = useState(false);
  const [message, setMessage] = useState('');
  const [prefill, setPrefill] = useState<TierAContractPrefill | null>(null);
  const [hadOvertimeThreshold, setHadOvertimeThreshold] = useState(true);

  async function uploadFile(file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setUploadState('error'); setMessage(lang === 'pl' ? 'Plik jest większy niż 10 MB.' : 'The file is larger than 10 MB.'); return; }
    setUploadState('uploading'); setMessage(t.analyzing);
    try {
      const { images } = await renderPageImages(file, true); // Stage 2i (§2i.0d): this flow doesn't read a text layer at all - `true` keeps the same fixed, moderate setting it always used, unrelated to Tier C's adaptive image-only budget.
      const response = await fetch('/api/contracts/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ images, language: lang }),
      });
      const data = await response.json() as { extraction?: ContractExtractionResponse; error_code?: string };
      if (!response.ok) {
        // §3.2: error_code -> translated message, resolved here where `lang` is known - never the
        // raw backend string (contract.controller.ts now sends only a code, never a sentence).
        const code = data.error_code;
        const translated = code === 'vision_unavailable' ? t.errorVisionUnavailable
          : code === 'invalid_input' ? t.errorInvalidInput
          : code === 'extraction_failed' ? t.errorExtractionFailed
          : code === 'rate_limit_unknown' ? t.errorRateLimitUnknown
          : code === 'rate_limit_exceeded' ? t.errorRateLimitExceeded
          : t.error;
        throw new Error(translated);
      }
      const extraction = data.extraction;
      if (!extraction) throw new Error(t.error);
      setPrefill({
        ...(extraction.hourlyRate !== null ? { hourly_rate: extraction.hourlyRate } : {}),
        ...(extraction.hoursPerWeek !== null ? { hours_per_week: extraction.hoursPerWeek } : {}),
        ...(extraction.overtimeTierThresholdHours !== null ? { overtime_tier_threshold_hours: extraction.overtimeTierThresholdHours } : {}),
      });
      // §3.3: report either way, on screen, not just in an audit report - most real contracts will
      // not state this (confirmed against the one real reference document this round), and a worker
      // pre-filling Tier B should know that up front, not discover it only once the grid blocks.
      setHadOvertimeThreshold(extraction.overtimeTierThresholdHours !== null);
      setUploadState('idle'); setMessage('');
    } catch (error) {
      setUploadState('error'); setMessage(error instanceof Error ? error.message : t.error);
    }
  }

  if (prefill) {
    return (
      <>
        {!hadOvertimeThreshold && (
          <div className="notice-card">
            <AlertTriangle/>
            <div><h3>{t.noThresholdTitle}</h3><p>{t.noThresholdBody}</p></div>
          </div>
        )}
        <TierACalculator lang={lang} tierMode="B" contractPrefill={prefill} onNavigateToDictionary={onNavigateToDictionary}/>
      </>
    );
  }

  return (
    <section className="flow-page">
      <div className="flow-heading">
        <span className="step">Tier B</span>
        <h1>{t.title}</h1>
        <p>{t.lead}</p>
      </div>
      <div className="notice-card contract-privacy-card">
        <ShieldCheck/>
        <div><h3>{t.mappingGapTitle}</h3><p>{t.mappingGapBody}</p></div>
      </div>
      <div className="upload-card contract-upload-card">
        <StepProgress current={uploadState === 'uploading' ? 2 : 1} labels={[progressLabels.document, progressLabels.analysis]}/>
        <h2>{t.uploadTitle}</h2>
        <p>{t.uploadLead}</p>
        {/* §3.1: owner's decision - annex override detection is deferred until a real annex document
            exists (§2.3/§2.4: not built from a guessed shape). What ships instead is this notice,
            right where the user decides what to upload - not a tooltip, not a footnote. */}
        <p className="form-note calc-honest-limit">{t.annexNotice}</p>
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
    </section>
  );
}
