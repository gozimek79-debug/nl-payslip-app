import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { extractContract } from '../ocr-service/contract-client.js';
import { analyzeContract } from '../payroll-engine/contract.js';
import { explainContract, translatePayslipTerms } from '../ai-service/ai-client.js';
import { isVisionConfigured } from '../ai-service/groq.js';
import { getCurrentRule } from '../rules-repository.js';

const router = express.Router();

const imageDataUrlSchema = z.string().min(50).max(16_000_000).regex(/^data:image\/(png|jpe?g);base64,/, 'Oczekiwano obrazu PNG lub JPEG jako data URL.');

const analyzeSchema = z.object({
  images: z.array(imageDataUrlSchema).min(1).max(5),
  language: z.enum(['pl', 'en']).optional(),
});

interface MinimalRatesFile {
  minimum_wage_per_hour: number;
}

let cachedStaticMinimumWage: number | null = null;

function loadStaticMinimumWagePerHour(): number {
  if (cachedStaticMinimumWage !== null) return cachedStaticMinimumWage;
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.resolve(dir, '../../../../packages/tax-tables/2026-Q1-rates.json');
  const rates = JSON.parse(readFileSync(filePath, 'utf-8')) as MinimalRatesFile;
  cachedStaticMinimumWage = rates.minimum_wage_per_hour;
  return cachedStaticMinimumWage;
}

async function loadMinimumWagePerHour(): Promise<number> {
  const dbRates = await getCurrentRule<MinimalRatesFile>('loonheffing_nl');
  return dbRates?.minimum_wage_per_hour ?? loadStaticMinimumWagePerHour();
}

router.post('/analyze', async (req, res) => {
  if (!isVisionConfigured()) {
    return res.status(503).json({ error: 'Analiza umowy AI jest chwilowo niedostępna (brak modelu wizyjnego u dostawcy).' });
  }
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nieprawidłowe dane obrazu.', details: parsed.error.flatten() });

  const language = parsed.data.language ?? 'pl';
  try {
    const extraction = await extractContract(parsed.data.images);
    const analysis = await analyzeContract(extraction, await loadMinimumWagePerHour());

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

    return res.json({ extraction: displayExtraction, analysis, explanation });
  } catch (error) {
    console.error('Groq contract OCR error', error);
    return res.status(502).json({ error: 'Nie udało się odczytać umowy przez AI. Spróbuj ponownie.' });
  }
});

export default router;
