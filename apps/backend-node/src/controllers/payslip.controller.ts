import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query, transaction } from '../database.js';
import { currentUser } from '../auth.js';
import { extractPayslipFieldsFromImage, extractFullPayslip } from '../ocr-service/ocr-client.js';
import { explainPayslipAnalysis, explainFullPayslip, translatePayslipTerms } from '../ai-service/ai-client.js';
import { isGroqConfigured, isVisionConfigured } from '../ai-service/groq.js';
import { validateFullPayslip } from '../payroll-engine/full-payslip.js';
import { ipRateLimit } from '../rate-limiter.js';
import { getMinimumWageAt } from '../rules-repository.js';

// Resolves the payslip's own reference date for rules-DB lookups (audit N4). Falls back to today
// only when the AI could not read a usable period-end date - a stated date always wins.
function resolvePayslipReferenceDate(periodEndDate: string | null): Date {
  if (periodEndDate) {
    const parsed = new Date(periodEndDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

const router = express.Router();
// AI-invoking endpoints (Groq inference cost): 10 requests / 5 min per IP.
const aiRateLimit = ipRateLimit('payslips-ai', 10, 300);
// DB-write endpoints without AI cost: looser, mainly against scripted spam.
const writeRateLimit = ipRateLimit('payslips-write', 30, 300);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, ALLOWED_MIME_TYPES.has(file.mimetype)),
});

const fieldsSchema = z.object({
  hours: z.number().min(0).max(744),
  hourlyRate: z.number().min(0).max(1000),
  grossBase: z.number().min(0).max(1_000_000),
  additions: z.number().min(0).max(1_000_000),
  deductions: z.number().min(0).max(1_000_000),
  netPaid: z.number().min(0).max(1_000_000),
});

const analysisSchema = z.object({
  analysisId: z.string().uuid(),
  userVerified: z.literal(true),
  fields: fieldsSchema,
});

const imageDataUrlSchema = z.string().min(50).max(16_000_000).regex(/^data:image\/(png|jpe?g);base64,/, 'Oczekiwano obrazu PNG lub JPEG jako data URL.');

const aiOcrSchema = z.object({
  imageBase64: imageDataUrlSchema,
});

const explainSchema = z.object({
  fields: fieldsSchema,
  result: z.object({
    status: z.string(),
    summary: z.string(),
    arithmetic: z.record(z.string(), z.unknown()),
    notices: z.array(z.string()),
  }),
  language: z.enum(['pl', 'en']).optional(),
});

const analyzeFullSchema = z.object({
  images: z.array(imageDataUrlSchema).min(1).max(5),
  language: z.enum(['pl', 'en']).optional(),
});

const draftSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
});

router.post('/draft', writeRateLimit, async (req, res) => {
  const parsed = draftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nieprawidłowe metadane dokumentu.' });
  const analysisId = randomUUID();
  let persisted = false;
  try {
    const user = await currentUser(req);
    const rows = await query<{ id: string }>(
      `INSERT INTO payslips (id, user_id, original_name, mime_type, status, retention_until)
       VALUES ($1, $2, $3, $4, 'manual_review', now() + interval '24 hours') RETURNING id`,
      [analysisId, user?.id ?? null, parsed.data.fileName, parsed.data.mimeType],
    );
    persisted = rows.length === 1;
  } catch (error) {
    console.error('Could not persist draft metadata', error);
  }
  return res.status(201).json({ analysisId, persisted });
});

router.post('/upload', writeRateLimit, upload.single('payslip'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Dodaj plik PDF, JPG lub PNG o rozmiarze do 10 MB.' });
  }

  const analysisId = randomUUID();
  let persisted = false;
  try {
    const user = await currentUser(req);
    const rows = await query<{ id: string }>(
      `INSERT INTO payslips (id, user_id, original_name, mime_type, status, retention_until)
       VALUES ($1, $2, $3, $4, 'manual_review', now() + interval '24 hours')
       RETURNING id`,
      [analysisId, user?.id ?? null, req.file.originalname, req.file.mimetype],
    );
    persisted = rows.length === 1;
    if (persisted) {
      await query(
        `INSERT INTO user_events (event_name, properties)
         VALUES ('payslip_uploaded', jsonb_build_object('payslipId', $1::text, 'mimeType', $2::text))`,
        [analysisId, req.file.mimetype],
      );
    }
  } catch (error) {
    console.error('Could not persist upload metadata', error);
  }

  return res.status(202).json({
    analysisId,
    fileName: req.file.originalname,
    status: 'manual_review',
    persisted,
    fields: {
      hours: 0,
      hourlyRate: 0,
      grossBase: 0,
      additions: 0,
      deductions: 0,
      netPaid: 0,
    },
    message: 'Plik przyjęty. Moduł OCR zostanie podłączony w kolejnym etapie.',
  });
});

router.post('/analyze', writeRateLimit, async (req, res) => {
  const parsed = analysisSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Zweryfikuj dane przed rozpoczęciem analizy.',
      details: parsed.error.flatten(),
    });
  }

  const { fields } = parsed.data;
  const expectedGross = Number((fields.hours * fields.hourlyRate).toFixed(2));
  const grossDifference = Number((fields.grossBase - expectedGross).toFixed(2));
  const grossConsistent = Math.abs(grossDifference) <= 0.05;
  const result = {
    status: grossConsistent ? 'consistent' as const : 'attention' as const,
    summary: grossConsistent
      ? 'Kwota brutto jest zgodna z liczbą godzin i stawką.'
      : 'Kwota brutto różni się od prostego przeliczenia godzin i stawki.',
    arithmetic: {
      expectedGross,
      reportedGross: fields.grossBase,
      difference: grossDifference,
      grossConsistent,
      reportedNet: fields.netPaid,
      additions: fields.additions,
      deductions: fields.deductions,
    },
    notices: [
      'To jest kontrola arytmetyczna, nie pełna walidacja podatkowa.',
      'Reguły WML, CAO i loonheffing zostaną dodane jako wersjonowany moduł.',
    ],
  };

  let persisted = false;
  try {
    const saved = await transaction(async (client) => {
      for (const [fieldName, numericValue] of Object.entries(fields)) {
        await client.query(
          `INSERT INTO payslip_fields (payslip_id, field_name, numeric_value, corrected_by_user)
           VALUES ($1, $2, $3, true)
           ON CONFLICT (payslip_id, field_name) DO UPDATE
           SET numeric_value = EXCLUDED.numeric_value, corrected_by_user = true`,
          [parsed.data.analysisId, fieldName, numericValue],
        );
      }
      await client.query(
        `INSERT INTO analyses (payslip_id, ruleset_version, result) VALUES ($1, $2, $3::jsonb)`,
        [parsed.data.analysisId, 'arithmetic-v1', JSON.stringify(result)],
      );
      await client.query(`UPDATE payslips SET status = $2 WHERE id = $1`, [parsed.data.analysisId, result.status]);
      await client.query(
        `INSERT INTO user_events (event_name, properties)
         VALUES ('analysis_completed', jsonb_build_object('payslipId', $1::text, 'status', $2::text))`,
        [parsed.data.analysisId, result.status],
      );
      return true;
    });
    persisted = saved === true;
  } catch (error) {
    console.error('Could not persist analysis', error);
  }

  return res.json({
    analysisId: parsed.data.analysisId,
    ...result,
    persisted,
  });
});

router.post('/ai-ocr', aiRateLimit, async (req, res) => {
  if (!isVisionConfigured()) {
    return res.status(503).json({ error: 'Odczyt dokumentu przez AI jest chwilowo niedostępny (brak modelu wizyjnego u dostawcy).' });
  }
  const parsed = aiOcrSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nieprawidłowe dane obrazu.' });
  try {
    const fields = await extractPayslipFieldsFromImage(parsed.data.imageBase64);
    return res.json({ fields });
  } catch (error) {
    console.error('Groq OCR error', error);
    return res.status(502).json({ error: 'Nie udało się odczytać dokumentu przez AI. Popraw dane ręcznie lub spróbuj ponownie.' });
  }
});

router.post('/explain', aiRateLimit, async (req, res) => {
  if (!isGroqConfigured()) {
    return res.status(503).json({ error: 'Interpretacja AI nie jest skonfigurowana (brak GROQ_API_KEY).' });
  }
  const parsed = explainSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nieprawidłowe dane do interpretacji.' });
  const { language, ...context } = parsed.data;
  try {
    const explanation = await explainPayslipAnalysis(context, language ?? 'pl');
    return res.json({ explanation });
  } catch (error) {
    console.error('Groq explain error', error);
    return res.status(502).json({ error: 'Nie udało się uzyskać interpretacji AI. Spróbuj ponownie.' });
  }
});

router.post('/analyze-full', aiRateLimit, async (req, res) => {
  if (!isVisionConfigured()) {
    return res.status(503).json({ error: 'Pełna analiza AI jest chwilowo niedostępna (brak modelu wizyjnego u dostawcy).' });
  }
  const parsed = analyzeFullSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Nieprawidłowe dane obrazu.', details: parsed.error.flatten() });
  const language = parsed.data.language ?? 'pl';
  try {
    const extraction = await extractFullPayslip(parsed.data.images);
    const referenceDate = resolvePayslipReferenceDate(extraction.periodEndDate);
    const applicableMinimumWage = await getMinimumWageAt(referenceDate);
    const validation = validateFullPayslip(extraction, applicableMinimumWage);

    const uniqueTerms = Array.from(new Set([
      ...extraction.lineItems.flatMap((item) => [item.section, item.description]),
      ...(extraction.contractType ? [extraction.contractType] : []),
    ]));
    const termMap = new Map<string, string>();
    try {
      const translated = await translatePayslipTerms(uniqueTerms, language);
      uniqueTerms.forEach((term, index) => termMap.set(term, translated[index] ?? term));
    } catch (error) {
      console.error('Groq translate error', error);
    }
    const display = (term: string): string => {
      const translated = termMap.get(term);
      return !translated || translated === term ? term : `${translated} (${term})`;
    };
    const displayExtraction = {
      ...extraction,
      contractType: extraction.contractType ? display(extraction.contractType) : null,
      lineItems: extraction.lineItems.map((item) => ({ ...item, section: display(item.section), description: display(item.description) })),
    };

    let explanation = '';
    try {
      explanation = await explainFullPayslip(extraction, validation, language);
    } catch (error) {
      console.error('Groq full-payslip explain error', error);
    }
    return res.json({ extraction: displayExtraction, validation, explanation });
  } catch (error) {
    console.error('Groq full-payslip OCR error', error);
    return res.status(502).json({ error: 'Nie udało się odczytać dokumentu przez AI. Spróbuj ponownie.' });
  }
});

export default router;
