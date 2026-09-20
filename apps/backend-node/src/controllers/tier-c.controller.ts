import express from 'express';
import { getCurrentRule, getMinimumWageAt } from '../rules-repository.js';
import { isCompleteTaxRatesFile, loadStaticTaxRatesAt, type TaxRatesFile } from '../payroll-engine/calculator.js';
import { computePayslipPeriod, periodMultiplierFor, type PayslipComputationRates, type PayslipPeriod } from '../payroll-engine/payslip-model.js';
import { comparePeriodToDocument } from '../payroll-engine/discrepancy.js';
import { checkExtractionConsistency, buildExtractionTrace, type ConsistencyIssue } from '../payroll-engine/extraction-consistency.js';
import { verifyAmountsAgainstText, type DocumentTextItem } from '../payroll-engine/document-text-guard.js';
import { mapExtractionToPeriod, type TierCPeriodType } from '../payroll-engine/tier-c.js';
import { isDocumentVisionConfigured } from '../ai-service/document-vision-provider.js';
import { extractTierCPayslip } from '../ocr-service/ocr-client.js';
import { normalizePeriodSigns } from '../payroll-engine/sign-policy.js';
import { ipRateLimit } from '../rate-limiter.js';

/**
 * Stage 2g (audit v27, §2g.1): "the server treats this list as untrusted input: type and length
 * checks, a cap on items and on total size, strings only. It is a consistency aid, not a security
 * control (the client could forge the images as easily)." A client-supplied `documentText` is
 * rejected field-by-field rather than the whole array on one bad entry - a single malformed item
 * should not silently disable the guard for an otherwise-fine upload.
 */
const MAX_DOCUMENT_TEXT_ITEMS = 500;
const MAX_DOCUMENT_TEXT_ITEM_LENGTH = 300;

function sanitizeDocumentText(raw: unknown): DocumentTextItem[] {
  if (!Array.isArray(raw)) return [];
  const items: DocumentTextItem[] = [];
  for (const entry of raw.slice(0, MAX_DOCUMENT_TEXT_ITEMS)) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.text !== 'string' || typeof r.page !== 'number' || typeof r.x !== 'number' || typeof r.y !== 'number') continue;
    if (!Number.isFinite(r.page) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    items.push({ page: r.page, text: r.text.slice(0, MAX_DOCUMENT_TEXT_ITEM_LENGTH), x: r.x, y: r.y });
  }
  return items;
}

/**
 * BP1.5 (audit round): the PRO bridge's fate is decided as RETIRE, not migrate-and-keep-both -
 * once a frontend consumes this endpoint, `/api/payslips/analyze-full` and its
 * full-payslip.ts/ocr-client.ts's extractFullPayslip() (the pre-Tier-C interim path App.tsx's PRO
 * card currently opens, labelled "interim version" since the language-regression round) are to be
 * removed, not left running alongside this one - spec §2's own warning against two engines
 * diverging applies equally to two extraction paths.
 *
 * Stage 2 (audit "CONSOLIDATED ASSIGNMENT" round, Tier C - "wire the engine, build the panel"):
 * that retirement is done this round - full-payslip.ts, extractFullPayslip, explainFullPayslip and
 * the /analyze-full route are deleted, in the same commit as TierCFlow.tsx replacing App.tsx's old
 * PRO flow.
 */
const router = express.Router();
const aiRateLimit = ipRateLimit('tier-c-ai', 10, 300, 'deny');

/**
 * Same fetch-rates logic as tier-a.controller.ts's own fetchRates() (audit AF2's whole-row
 * completeness check, then the date-range-aware static fallback) - NOT yet promoted to one shared
 * module. Flagged as a real, small duplication in an earlier round's audit reply rather than
 * refactored here, since nothing has caught a bug from it yet (unlike periodMultiplierFor, which a
 * Tier C test DID catch drifting) - a candidate for consolidation, not an urgent one.
 */
// Stage 2f (§2f.4): periodType is now required, non-nullable - both callers (this file's /analyze,
// after confirming extraction.period_type is not null, and /recompute, whose PayslipPeriod always
// carries a concrete period_type by type) only reach this function once a real period type is known.
// The old `periodType ?? 'week'` default lived here and is gone; there is no longer a call site where
// an unknown period type silently becomes a computed rate.
async function fetchRates(periodType: TierCPeriodType): Promise<{ rates: PayslipComputationRates; source: 'database' | 'static' } | null> {
  const rawDbRates = await getCurrentRule<TaxRatesFile>('loonheffing_nl');
  const dbRates = rawDbRates && isCompleteTaxRatesFile(rawDbRates) ? rawDbRates : null;
  const staticRates = dbRates ? null : loadStaticTaxRatesAt(new Date());
  const taxRatesFile = dbRates ?? staticRates;
  if (!taxRatesFile) return null;
  return {
    rates: {
      loonheffing_brackets: taxRatesFile.loonheffing_brackets,
      heffingskortingen: taxRatesFile.heffingskortingen,
      period_multiplier: periodMultiplierFor(periodType),
    },
    source: dbRates ? 'database' : 'static',
  };
}

// Resolves the payslip's own reference date for the minimum-wage rules-DB lookup (audit BP1 point
// 4/N4) - falls back to today only when the extraction could not read a usable period-end date.
function resolveReferenceDate(periodEndDate: string | null): Date {
  if (periodEndDate) {
    const parsed = new Date(periodEndDate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/**
 * Stage 2e (audit v24, §2e.7): the gate-fire log previously JSON.stringify()'d the whole raw
 * extraction/period, including employer_names, hirer_name, period_label and free-text line
 * descriptions - rated a blocker by the reviewer, major by the auditor ("with amounts and a week
 * they point at one worker's payslip, and a free-text description can carry a name sanitizeText does
 * not match"). This is the allowlist instead: amounts, categories and printed labels (already run
 * through sanitizeText in ocr-client.ts) - never a description, an employer/hirer name, or a raw
 * period label, even sanitized. Diagnosing a gate failure needs the figures, not the free text.
 */
function redactedGateLogPayload(period: PayslipPeriod) {
  return {
    period_type: period.period_type,
    period_type_confirmed: period.period_type_confirmed,
    hour_lines: period.hour_lines.map((l) => ({ category: l.category, tax_treatment: l.tax_treatment, amount: l.amount })),
    pre_tax_deductions: period.pre_tax_deductions.map((d) => ({ category: d.category, amount: d.amount })),
    post_tax_social: period.post_tax_social.map((d) => ({ category: d.category, amount: d.amount })),
    net_additions: period.net_additions.map((l) => ({ category: l.category, amount: l.amount })),
    net_deductions: period.net_deductions.map((l) => ({ category: l.category, amount: l.amount })),
    printed_table_tax: period.printed_table_tax,
    printed_bt_tax: period.printed_bt_tax,
    printed_net: period.printed_net,
    printed_payout: period.printed_payout,
    printed_gross_total: period.printed_gross_total,
    printed_loon_voor_heffingen: period.printed_loon_voor_heffingen,
    printed_table_tax_label: period.printed_table_tax_label,
    printed_net_label: period.printed_net_label,
    printed_payout_label: period.printed_payout_label,
  };
}

/** Same allowlist principle applied to the issues array itself - deduction_miscategorized carries the
 * line's free-text description, which the payload above deliberately omits everywhere else. */
function redactedIssuesForLogging(issues: ConsistencyIssue[]) {
  return issues.map((issue) => (issue.code === 'deduction_miscategorized' ? { code: issue.code, placement: issue.placement, suggested_category: issue.suggested_category } : issue));
}

router.post('/analyze', aiRateLimit, async (req, res) => {
  // §2.6/CONVENTIONS.md: error_code + params, never a prebaked sentence - this controller had the
  // same pre-existing defect as tier-a/contract had before those were fixed; wiring this route to a
  // real frontend this round (Stage 2) is exactly when it stops being a theoretical gap.
  if (!isDocumentVisionConfigured()) {
    return res.status(503).json({ error_code: 'vision_unavailable' });
  }
  const images = Array.isArray(req.body?.images) ? (req.body.images as unknown[]) : [];
  if (images.length === 0 || images.length > 5 || !images.every((i) => typeof i === 'string')) {
    return res.status(400).json({ error_code: 'invalid_input' });
  }
  // Stage 2g (§2g.1): optional - a plain image upload, or a PDF with no usable text layer, sends none.
  const documentText = sanitizeDocumentText(req.body?.documentText);

  try {
    const extraction = await extractTierCPayslip(images as string[], documentText);
    const referenceDate = resolveReferenceDate(extraction.period_end_date);
    const applicableMinimumWage = await getMinimumWageAt(referenceDate);
    const period = mapExtractionToPeriod(extraction, applicableMinimumWage);

    // Stage 2f (§2f.4): "unknown stays unknown after the flag" - stage 2e raised these two issues but
    // still computed with 'week' and 0 underneath them. Checked against the RAW extraction (only it
    // can tell "genuinely absent" from "read as zero/week" - mapExtractionToPeriod's own period_type/
    // et_exchange_amount defaults exist only so this period is buildable for the trace below), and
    // checked BEFORE fetchRates/computePayslipPeriod run at all: no period_multiplier is resolved, no
    // tax is computed, no net figure is shown, when either of these is true.
    const periodType = extraction.period_type;
    const extractionGapIssues: ConsistencyIssue[] = [];
    if (periodType === null) extractionGapIssues.push({ code: 'period_type_unknown' });
    if (extraction.et_reimbursement_lines.length > 0 && extraction.et_exchange_amount === null) {
      extractionGapIssues.push({ code: 'et_exchange_amount_unknown' });
    }
    // Stage 2f (§2f.8): "an unreadable amount is not a zero" - hour/net/ET-reimbursement/payout/
    // reservation amounts are stored as 0 when non-finite (no shared type changed for this), so this
    // is the only place that distinguishes "read as zero" from "could not be read" for them.
    for (const field of extraction.unreadable_amount_fields) {
      extractionGapIssues.push({ code: 'amount_unreadable', field });
    }
    // Stage 2g (§2g.3): "for every amount the model returns, require that its magnitude equals...
    // some number in the text list... Applies only when a text list exists." The classic case:
    // 699.75 (= 45 x 15.55, computed) is not printed anywhere the document says 699.78.
    for (const field of verifyAmountsAgainstText(period, documentText)) {
      extractionGapIssues.push({ code: 'amount_unreadable', field });
    }
    if (periodType === null || extractionGapIssues.length > 0) {
      console.error('[consistency-gate] blocked - extraction:', JSON.stringify(redactedGateLogPayload(period)), 'issues:', JSON.stringify(redactedIssuesForLogging(extractionGapIssues)));
      return res.json({
        status: 'unreliable',
        issues: extractionGapIssues,
        trace: buildExtractionTrace(period, null, documentText),
        period,
        truncated: extraction.truncated,
        redactedFields: extraction.redacted_fields,
      });
    }

    const fetched = await fetchRates(periodType);
    if (!fetched) {
      return res.status(503).json({ error_code: 'tax_rates_unavailable' });
    }

    const outcome = computePayslipPeriod(period, fetched.rates, true);

    // Stage 2b (audit v12, §Stage 2b): the §Stage 2a live test showed three "discrepancies" that were
    // entirely OUR extraction's own errors, presented exactly as a real employer violation would be -
    // the three-band classifier separates noise from findings BY MAGNITUDE, and a systematic
    // extraction failure also produces large residuals. This gate runs BEFORE comparePeriodToDocument
    // and, if the extraction fails its own internal-consistency checks, short-circuits to a distinct
    // response shape that never reaches a discrepancy list at all.
    const consistencyIssues = checkExtractionConsistency(extraction.payment_date, period, outcome);
    if (consistencyIssues.length > 0) {
      // v18 (audit): a real Olympia retest showed the gate firing twice, with two different
      // computed nets from what was reported as "the same document" - and there was NOTHING to
      // check afterward. This route never persisted to the database (only the orphaned old
      // payslip.controller.ts route does; the 24h retention_until column that policy assumed does
      // not apply here), and the SDK-bypass diagnostic added for the Mistral cutover only fires on
      // a THROWN error - a gate firing is a normal 200 response, so it never logged either. This is
      // the fix: log it unconditionally here, so the next gate-firing request is diagnosable from
      // Vercel's logs without needing to reproduce it. v24 (§2e.7): the raw extraction DOES carry
      // employer/hirer names and free-text descriptions (tier-c.ts's own comment calling
      // TierCExtraction PII-free was about identity fields like BSN/IBAN, not business names or
      // descriptions) - logs an allowlisted projection instead, never the raw extraction or period.
      console.error('[consistency-gate] blocked - extraction:', JSON.stringify(redactedGateLogPayload(period)), 'issues:', JSON.stringify(redactedIssuesForLogging(consistencyIssues)));
      // Stage 2d (§2d.1): "the blocking panel must show what it read" - every extracted line, and
      // the gate's own gross-to-net chain, not just the one figure that happened to trip a check.
      return res.json({
        status: 'unreliable',
        issues: consistencyIssues,
        trace: buildExtractionTrace(period, outcome, documentText),
        period,
        truncated: extraction.truncated,
        redactedFields: extraction.redacted_fields,
      });
    }

    const discrepancies = comparePeriodToDocument(period, outcome);

    return res.json({
      status: 'ok',
      period,
      outcome,
      discrepancies,
      truncated: extraction.truncated,
      redactedFields: extraction.redacted_fields,
      taxRatesSource: fetched.source,
    });
  } catch (error) {
    console.error('Tier C analyze error', error);
    return res.status(502).json({ error_code: 'extraction_failed' });
  }
});

/**
 * Stage 2's "correction path": the result panel lets a user confirm or correct any `confirm`-status
 * discrepancy (Stage 1). Correcting means the user is stating a different PRINTED value than what
 * extraction read - not a new document, not a new AI call. This route re-runs the SAME
 * computation/comparison the analyze route already ran, against a period the client already has (it
 * came from THIS server moments earlier) with one `printed_*` field edited. No new extraction, no
 * AI cost - purely payslip-model.ts + discrepancy.ts, both already fully tested elsewhere.
 *
 * Minimal validation, deliberately: the only caller is our own frontend echoing back a period this
 * same endpoint (via /analyze) produced, with a single numeric field changed - not an arbitrary
 * public input shape. Full structural validation of the entire nested PayslipPeriod type is a
 * reasonable hardening item for later, not a blocker for this round's panel to function correctly.
 */
const KNOWN_PERIOD_TYPES: TierCPeriodType[] = ['week', '4-weekly', 'month'];

router.post('/recompute', async (req, res) => {
  const rawPeriod = req.body?.period as PayslipPeriod | undefined;
  if (!rawPeriod || typeof rawPeriod !== 'object' || !Array.isArray(rawPeriod.hour_lines) || typeof rawPeriod.period_type !== 'string') {
    return res.status(400).json({ error_code: 'invalid_input' });
  }
  // Stage 2g (§2g.0b): "an unknown period type may not drive anything anywhere." Before this, any
  // string here (including the placeholder 'week' a blocked /analyze had to write into the returned
  // period so the trace panel could render) would reach fetchRates/computePayslipPeriod unchecked -
  // the one path where a client-echoed placeholder could still drive a real computation. Refused
  // the same way /analyze already refuses: no rates resolved, no tax computed.
  if (rawPeriod.period_type_confirmed !== true || !KNOWN_PERIOD_TYPES.includes(rawPeriod.period_type as TierCPeriodType)) {
    console.error('[consistency-gate] blocked on /recompute - period_type not confirmed:', JSON.stringify({ period_type: rawPeriod.period_type, period_type_confirmed: rawPeriod.period_type_confirmed }));
    return res.json({ status: 'unreliable', issues: [{ code: 'period_type_unknown' as const }], trace: buildExtractionTrace(rawPeriod, null) });
  }

  // Stage 2f (§2f.5): "one sign policy... apply it in mapExtractionToPeriod AND in /recompute (which
  // today passes the browser's period straight in)". The body is client-supplied - normalising it here
  // too means a signed deduction amount (however it got there) is corrected before computing, not
  // trusted as-is.
  const period = normalizePeriodSigns(rawPeriod);

  const fetched = await fetchRates(period.period_type);
  if (!fetched) {
    return res.status(503).json({ error_code: 'tax_rates_unavailable' });
  }

  const outcome = computePayslipPeriod(period, fetched.rates, true);

  // Same gate as /analyze (Stage 2b): a correction to one printed_* field does not itself prove the
  // rest of the extraction is trustworthy. No payment_date travels with a bare PayslipPeriod (it is
  // extraction-only, per tier-c.ts), so the year-mismatch check simply does not re-fire here - the
  // checks that DO still apply (zero-tax, period length from the label, category, both totals
  // reconciliations) are exactly the ones a single-field correction can newly satisfy or newly break.
  const consistencyIssues = checkExtractionConsistency(null, period, outcome);
  if (consistencyIssues.length > 0) {
    console.error('[consistency-gate] blocked on /recompute - period:', JSON.stringify(redactedGateLogPayload(period)), 'issues:', JSON.stringify(redactedIssuesForLogging(consistencyIssues)));
    return res.json({ status: 'unreliable', issues: consistencyIssues, trace: buildExtractionTrace(period, outcome) });
  }

  const discrepancies = comparePeriodToDocument(period, outcome);
  return res.json({ status: 'ok', outcome, discrepancies, taxRatesSource: fetched.source });
});

export default router;
