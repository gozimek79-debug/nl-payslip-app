import express from 'express';
import { z } from 'zod';
import { extractContract } from '../ocr-service/contract-client.js';
import { analyzeContract, checkContractPlausibility } from '../payroll-engine/contract.js';
import { explainContract, translatePayslipTerms } from '../ai-service/ai-client.js';
import { isDocumentVisionConfigured } from '../ai-service/document-vision-provider.js';
import { getMinimumWageAt } from '../rules-repository.js';
import { ipRateLimit } from '../rate-limiter.js';

const router = express.Router();
const aiRateLimit = ipRateLimit('contracts-ai', 10, 300, 'deny');

const imageDataUrlSchema = z.string().min(50).max(16_000_000).regex(/^data:image\/(png|jpe?g);base64,/, 'Oczekiwano obrazu PNG lub JPEG jako data URL.');

const analyzeSchema = z.object({
  images: z.array(imageDataUrlSchema).min(1).max(5),
  language: z.enum(['pl', 'en']).optional(),
});

router.post('/analyze', aiRateLimit, async (req, res) => {
  // §3.2 (audit "CONSOLIDATED ASSIGNMENT" round): error_code + params, never a prebaked sentence -
  // the same CONVENTIONS.md pattern already applied to tier-a.controller.ts, scoped here to the
  // controller Tier B actually calls (TierBFlow.tsx). Module 2's OWN surfaces - ContractAnalysis.tsx
  // rendering `analysis.flags[].message` directly - are a separate, already-flagged defect (NEW
  // FINDING, prior round) left for whenever Module 2 itself is built, not retrofitted here.
  if (!isDocumentVisionConfigured()) {
    return res.status(503).json({ error_code: 'vision_unavailable' });
  }
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error_code: 'invalid_input', details: parsed.error.flatten() });

  const language = parsed.data.language ?? 'pl';
  try {
    const rawExtraction = await extractContract(parsed.data.images);
    // 2.0b: plausibility bounds, checked and nulled BEFORE anything downstream (the minimum-wage
    // math below, a future Tier A pre-fill) can use an implausible value - the exact failure mode a
    // tolerance check cannot reach (digits right, unit/period wrong). Flagged fields are returned
    // separately (`implausibleFields`) so the frontend can ask, per stage 1's middle-band pattern,
    // rather than either silently trusting or silently discarding the misread value.
    const implausibleFields = checkContractPlausibility(rawExtraction);
    const extraction = implausibleFields.reduce(
      (acc, flag) => ({ ...acc, [flag.field]: null }),
      rawExtraction,
    );
    // Two different questions need two different reference dates (audit R2, a regression from
    // last round's B2 fix): proeftijd/opzegtermijn ask "was this contract term legal when signed"
    // -> the contract's own start date (analyzeContract still resolves that internally, unchanged).
    // Minimum wage asks "does today's pay meet today's statutory minimum" -> today, regardless of
    // when the contract started. Using startDate for both meant a 2021 contract at EUR 10.50/h (now
    // roughly a third below the 2026 minimum) would be checked against the 2021 WML and pass.
    const analysis = await analyzeContract(extraction, await getMinimumWageAt(new Date()));

    const uniqueTerms = Array.from(new Set(
      [extraction.contractType, extraction.functionTitle, extraction.caoName, extraction.pensionFund].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
    ));
    const termMap = new Map<string, string>();
    try {
      const translated = await translatePayslipTerms(uniqueTerms, language);
      uniqueTerms.forEach((term, index) => termMap.set(term, translated[index] ?? term));
    } catch (error) {
      console.error('Groq translate error', error);
    }
    const display = (term: string | null): string | null => {
      if (!term) return term;
      const translated = termMap.get(term);
      return !translated || translated === term ? term : `${translated} (${term})`;
    };
    const displayExtraction = {
      ...extraction,
      contractType: display(extraction.contractType),
      functionTitle: display(extraction.functionTitle),
      caoName: display(extraction.caoName),
      pensionFund: display(extraction.pensionFund),
    };

    let explanation = '';
    try {
      explanation = await explainContract(extraction, analysis, language);
    } catch (error) {
      console.error('Groq contract explain error', error);
    }

    return res.json({ extraction: displayExtraction, analysis, explanation, implausibleFields });
  } catch (error) {
    console.error('Groq contract OCR error', error);
    return res.status(502).json({ error_code: 'extraction_failed' });
  }
});

export default router;
