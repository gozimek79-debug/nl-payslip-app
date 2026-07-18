import express from 'express';
import { DutchPayrollValidator } from '../payroll-engine/validator';
import { PIIMasker } from '../middleware/pii-masker';
import { taxTables } from '@tax-tables';

const router = express.Router();
const validator = new DutchPayrollValidator();
const piiMasker = new PIIMasker();

router.post('/validate-ocr', async (req, res) => {
  try {
    const { ocrData } = req.body;
    const validations = {
      hoursPositive: ocrData.normal_hours > 0,
      rateAboveWML: ocrData.normal_rate >= 14.45,
      hoursMatch: Math.abs(ocrData.normal_hours * ocrData.normal_rate - ocrData.gross_base) < 1
    };
    res.json({ validations });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

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
    res.json({ validation: validationResult, ai_context: safeAIContext });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
