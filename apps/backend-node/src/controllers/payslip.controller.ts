import express from 'express';
import multer from 'multer';
import { DutchPayrollValidator } from '../payroll-engine/validator';
import { PIIMasker } from '../middleware/pii-masker';
import { extractPayslipData } from '../ocr-service/ocr-client';
import { getAIExplanation } from '../ai-service/ai-client';
import { taxTables } from '@tax-tables';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const validator = new DutchPayrollValidator();
const piiMasker = new PIIMasker();

// Upload paska -> OCR -> zwróć dane do weryfikacji
router.post('/upload', upload.single('payslip'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Brak pliku' });
    const ocrResult = await extractPayslipData(req.file.buffer);
    res.json({ ocrData: ocrResult });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Analiza po weryfikacji użytkownika
router.post('/analyze', async (req, res) => {
  try {
    const { salarisRecord, period, userVerified } = req.body;
    if (!userVerified) return res.status(400).json({ error: 'Przed analizą wymagana jest weryfikacja danych przez użytkownika' });
    salarisRecord.meta = {
      ocr_confidence: 0,
      manual_corrections: false,
      verified_by_user: true,
      tax_table_version: '2026-Q1'
    };
    const taxConfig = taxTables.getTaxConfig(period);
    const validationResult = validator.validateSalaris(salarisRecord, taxConfig);
    const safeAIContext = piiMasker.prepareSafeAIContext(salarisRecord, validationResult);

    let aiExplanation = null;
    if (validationResult.discrepancies.length > 0 || validationResult.wmlViolation) {
      aiExplanation = await getAIExplanation(safeAIContext);
    }

    res.json({
      validation: validationResult,
      aiExplanation
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
