import express from 'express';
import { getCurrentRule, getMinimumWageAt } from '../rules-repository.js';
import { isCompleteTaxRatesFile, loadStaticTaxRatesAt, type TaxRatesFile } from '../payroll-engine/calculator.js';
import { computePayslipPeriod, periodMultiplierFor, type PayslipComputationRates, type PayslipPeriod } from '../payroll-engine/payslip-model.js';
import { comparePeriodToDocument } from '../payroll-engine/discrepancy.js';
import { checkExtractionConsistency, buildExtractionTrace, resolveNetPosition, type ConsistencyIssue } from '../payroll-engine/extraction-consistency.js';
import { verifyAmountsAgainstText, textLayerVerificationCounts, type DocumentTextItem } from '../payroll-engine/document-text-guard.js';
import { mapExtractionToPeriod, resolveEtExchangeAmountFromExtraction, type TierCPeriodType } from '../payroll-engine/tier-c.js';
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
 *
 * Stage 2h (audit v28, §2h.2): "no silent truncation... never cut the tail." Stage 2g's `slice(0,500)`
 * dropped everything PAST the 500th item - on a real multi-page payslip, totals/net sit at the END of
 * the page, so a busy document would lose exactly the figures most worth verifying. Caps raised and
 * derived (not guessed): the densest synthetic fixture this round builds (`synthetic-pdf.test.ts`'s
 * "dense three-page document") measures ~1000 text items on one single, deliberately crowded A4 page
 * (every hours/rate/amount cell as its own run) - budgeting for a real document that dense on EVERY
 * one of the three rendered pages gives 1000 x 3 = 3000 items. The character cap is the same fixture's
 * own measured average item length (~9 chars for a typical "1.234,56"-shaped token, well under
 * MAX_DOCUMENT_TEXT_ITEM_LENGTH's already-generous 300) times the item cap, rounded up with margin:
 * 3000 x 20 = 60000 characters (~59 KB) - generous for genuine payslip text, small next to the actual
 * image payload 2h.5 budgets separately.
 */
const MAX_DOCUMENT_TEXT_ITEMS = 3000;
const MAX_DOCUMENT_TEXT_ITEM_LENGTH = 300;
const MAX_DOCUMENT_TEXT_TOTAL_CHARS = 60000;

/**
 * Stage 2h (§2h.2): "if the frontend's list is over the cap, drop items that contain no digit first
 * (the guard only needs numbers); if it is still over, send images only and record text_layer_status:
 * 'too_large'." Applied here, server-side, since the server is already the trust boundary for this
 * list (2g.1) and the ONLY place this reduction is implemented - the frontend sends whatever
 * `extractTextItems` produces and relies on this same enforcement, so there is exactly one algorithm
 * that can ever decide "too large", never two that could disagree.
 */
function sanitizeDocumentText(raw: unknown): { items: DocumentTextItem[]; status: TextLayerStatus } {
  if (!Array.isArray(raw)) return { items: [], status: 'ok' };
  let items: DocumentTextItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.text !== 'string' || typeof r.page !== 'number' || typeof r.x !== 'number' || typeof r.y !== 'number') continue;
    if (!Number.isFinite(r.page) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    items.push({ page: r.page, text: r.text.slice(0, MAX_DOCUMENT_TEXT_ITEM_LENGTH), x: r.x, y: r.y });
  }

  const totalChars = (list: DocumentTextItem[]): number => list.reduce((sum, i) => sum + i.text.length, 0);
  const overCap = (list: DocumentTextItem[]): boolean => list.length > MAX_DOCUMENT_TEXT_ITEMS || totalChars(list) > MAX_DOCUMENT_TEXT_TOTAL_CHARS;

  if (overCap(items)) {
    // The guard only ever needs numbers (document-text-guard.ts) - a label-only item contributes
    // nothing to verification, so it is the first, content-preserving thing to drop.
    items = items.filter((i) => /\d/.test(i.text));
  }
  if (overCap(items)) {
    return { items: [], status: 'too_large' };
  }
  return { items, status: 'ok' };
}

export type TextLayerStatus = 'ok' | 'too_large' | 'mismatch' | 'none';

/**
 * Stage 2h (§2h.2): "if the guard cannot find half or more of the amounts it checked... treat the
 * layer as unusable: do not block on the guard, fall back to the image-only read with its gate."
 * CHOSEN and labelled (per the assignment's own instruction): 0.5 - a layer that fails to confirm
 * half the read is more likely a mismatched text layer (wrong pages, a scan with stray OCR text
 * layer, garbled encoding) than a model that is wrong on half its fields at once.
 *
 * Stage 2i (audit v29, §2i.0a): "the guard cannot be switched off by one miss." The reviewer found
 * this ratio alone falls back at `checked=2, unverified=1` - the exact shape of the classic single-
 * invented-digit case (699.75 vs printed 699.78: one field wrong out of a short, correctly-read
 * period), so the ratio being satisfied could silence the ONE check that exists to catch it. A floor
 * requires BOTH the ratio AND an absolute minimum count of unverified fields before falling back.
 */
const TEXT_LAYER_MISMATCH_RATIO = 0.5;
/** CHOSEN (§2i.0a's own suggestion, adopted): 3. Below 3 unverified fields, no plausible "wrong
 * text layer" explanation is more likely than "the model got a small number of individual fields
 * wrong" - a genuinely mismatched layer (wrong pages, OCR garbage, a different document) fails to
 * confirm far more than a couple of fields, not exactly one or two. 3 is the smallest count that
 * cannot be produced by the single-invented-digit case alone. */
const TEXT_LAYER_MISMATCH_FLOOR = 3;

/**
 * Stage 2i (§2i.0a): the floor-and-ratio decision as its own pure, directly testable function -
 * exported so the exact checked/unverified matrix the assignment names (2/1, 4/2, 6/3, 12/6, 12/1)
 * can be tested without going through a full period/text-item fixture.
 */
export function isTextLayerMismatch(checked: number, unverified: number): boolean {
  return checked > 0 && unverified >= TEXT_LAYER_MISMATCH_FLOOR && unverified / checked >= TEXT_LAYER_MISMATCH_RATIO;
}

/**
 * Decides, from the SAME counts the trace will report (§2h.4: "amounts checked, amounts not found"),
 * whether this upload's text layer is usable at all. Returns the unverified field list ONLY when the
 * layer is usable (so the caller blocks exactly those fields, unchanged from 2g.3); returns an empty
 * list and `status: 'mismatch'` when it is not (so the caller does not block on the guard at all).
 */
function assessTextLayer(period: PayslipPeriod, documentText: DocumentTextItem[], baseStatus: TextLayerStatus): { unverifiedFields: string[]; status: TextLayerStatus; checked: number; unverified: number } {
  if (baseStatus === 'too_large') return { unverifiedFields: [], status: 'too_large', checked: 0, unverified: 0 };
  if (documentText.length === 0) return { unverifiedFields: [], status: 'none', checked: 0, unverified: 0 };
  const { checked, unverified } = textLayerVerificationCounts(period, documentText);
  if (isTextLayerMismatch(checked, unverified)) {
    return { unverifiedFields: [], status: 'mismatch', checked, unverified };
  }
  return { unverifiedFields: verifyAmountsAgainstText(period, documentText), status: 'ok', checked, unverified };
}

/**
 * Stage 2i (audit v29, §2i.0e): "when Content-Length is absent or disagrees with the re-encoded size
 * by more than a margin, show the measured size and say which." A pure function so the exact
 * agreement/disagreement boundary is directly testable without a real HTTP request (fetch computes
 * its own Content-Length automatically, so a test cannot easily forge a mismatching one at that
 * layer). CHOSEN margin: 10% - a genuine Content-Length legitimately differs slightly from a
 * re-encode (chunked transfer framing, charset differences); a client-supplied header claiming a
 * materially different size than what was actually sent is the case worth flagging, not normal
 * encoding noise.
 */
export const REQUEST_SIZE_AGREEMENT_MARGIN = 0.1;

export function resolveRequestSize(headerSizeKb: number | null, measuredSizeKb: number): { requestSizeKb: number; requestSizeSource: 'content_length' | 'measured' } {
  if (headerSizeKb !== null && Number.isFinite(headerSizeKb)) {
    const agrees = Math.abs(headerSizeKb - measuredSizeKb) <= measuredSizeKb * REQUEST_SIZE_AGREEMENT_MARGIN;
    if (agrees) return { requestSizeKb: Math.round(headerSizeKb * 10) / 10, requestSizeSource: 'content_length' };
  }
  return { requestSizeKb: Math.round(measuredSizeKb * 10) / 10, requestSizeSource: 'measured' };
}

/** Stage 2i (§2i.0d): the only render-step labels the frontend can legitimately report - anything
 * else (malformed, forged, or simply unset) becomes 'unknown' rather than surfacing arbitrary text. */
export const KNOWN_RENDER_STEPS = ['text-layer-present', 'image-high', 'image-medium', 'image-low', 'image-floor', 'non-pdf'];

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
  // Stage 2h (§2h.2): the sanitizer's own status ('ok'/'too_large') is carried forward - a too-large
  // list is never partially trusted, it is treated exactly like no text layer at all.
  const { items: documentText, status: sanitizedStatus } = sanitizeDocumentText(req.body?.documentText);
  // Stage 2h (§2h.4): "the total request size in kilobytes" - the header the client itself sent, not
  // a re-serialisation of req.body (which can differ from the wire size by whitespace/encoding).
  // Falls back to a re-encode only when a client/proxy omits the header.
  //
  // Stage 2i (audit v29, §2i.0e): "when Content-Length is absent or disagrees with the re-encoded
  // size by more than a margin, show the measured size and say which." The reviewer's own finding
  // (T7c): a client can omit or spoof this header. Both sizes are now always computed; the trusted
  // header is used only when it roughly agrees with an independent re-encode - otherwise the
  // independently measured size is shown, and which source won is itself reported (never silently
  // picking the untrusted, possibly-wrong header value without saying so).
  const contentLengthHeader = req.headers['content-length'];
  const measuredSizeKb = Math.round((Buffer.byteLength(JSON.stringify(req.body ?? {})) / 1024) * 10) / 10;
  const { requestSizeKb, requestSizeSource } = resolveRequestSize(contentLengthHeader ? Number(contentLengthHeader) / 1024 : null, measuredSizeKb);
  // Stage 2i (§2i.0d): "put the chosen step in the technical line" - a client-reported label only
  // (untrusted), constrained to the known set so a malformed/forged value can never surface as
  // arbitrary text on the panel.
  const renderStepRaw = req.body?.renderStep;
  const renderStep = typeof renderStepRaw === 'string' && KNOWN_RENDER_STEPS.includes(renderStepRaw) ? renderStepRaw : 'unknown';

  try {
    const extraction = await extractTierCPayslip(images as string[], documentText);
    const referenceDate = resolveReferenceDate(extraction.period_end_date);
    const applicableMinimumWage = await getMinimumWageAt(referenceDate);
    const period = mapExtractionToPeriod(extraction, applicableMinimumWage);

    // Stage 2h (§2h.2): decide once whether this upload's text layer is usable at all, before it can
    // block anything - a mismatched or too-large layer falls back to the image-only read and gate,
    // never a per-field block on numbers that were never trustworthy to compare against in the first
    // place. `textLayerTrace` is the (possibly emptied) list every `buildExtractionTrace` call below
    // uses, so `reading_basis`/`unused_printed_amounts` agree with this decision everywhere.
    const textLayerAssessment = assessTextLayer(period, documentText, sanitizedStatus);
    const textLayerTrace = textLayerAssessment.status === 'ok' ? documentText : [];
    const traceMeta = {
      textLayerStatus: textLayerAssessment.status,
      requestSizeKb,
      requestSizeSource,
      renderStep,
      textItemsSent: documentText.length,
      amountsChecked: textLayerAssessment.checked,
      amountsNotFound: textLayerAssessment.unverified,
    };

    // Stage 2f (§2f.4): "unknown stays unknown after the flag" - stage 2e raised these two issues but
    // still computed with 'week' and 0 underneath them. Checked against the RAW extraction (only it
    // can tell "genuinely absent" from "read as zero/week" - mapExtractionToPeriod's own period_type/
    // et_exchange_amount defaults exist only so this period is buildable for the trace below), and
    // checked BEFORE fetchRates/computePayslipPeriod run at all: no period_multiplier is resolved, no
    // tax is computed, no net figure is shown, when either of these is true.
    const periodType = extraction.period_type;
    const extractionGapIssues: ConsistencyIssue[] = [];
    if (periodType === null) extractionGapIssues.push({ code: 'period_type_unknown' });
    // Stage 2i (§2i.3): reads the SAME resolution mapExtractionToPeriod uses (resolveEtExchangeAmountFromExtraction,
    // which also recognises an ET-labelled line the model left in pre_tax_deduction_lines - see its own
    // comment) rather than the raw `et_exchange_amount` field alone, so a reading the mapper can now
    // resolve is never blocked here as if it were still genuinely absent.
    if (extraction.et_reimbursement_lines.length > 0 && resolveEtExchangeAmountFromExtraction(extraction) === null) {
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
    // Stage 2h (§2h.2): only the fields `assessTextLayer` decided are worth blocking on - empty when
    // the layer was judged a mismatch or too large, exactly as if no text had been sent at all.
    for (const field of textLayerAssessment.unverifiedFields) {
      extractionGapIssues.push({ code: 'amount_unreadable', field });
    }
    if (periodType === null || extractionGapIssues.length > 0) {
      console.error('[consistency-gate] blocked - extraction:', JSON.stringify(redactedGateLogPayload(period)), 'issues:', JSON.stringify(redactedIssuesForLogging(extractionGapIssues)));
      // Stage 2l (§2l.2): the exact field paths already named by `amount_unreadable` above - passed
      // through so the trace can exclude a flagged guess from gross_total/pre_tax_deductions_sum
      // instead of silently summing it as if it were trustworthy. Only this call site ever has any -
      // the 'ok' path and the gate-blocked-but-extraction-clean path below both require
      // extractionGapIssues to already be empty to be reached at all.
      const flaggedFieldPaths = extractionGapIssues.filter((i) => i.code === 'amount_unreadable').map((i) => i.field);
      return res.json({
        status: 'unreliable',
        issues: extractionGapIssues,
        trace: buildExtractionTrace(period, null, textLayerTrace, { ...traceMeta, flaggedFieldPaths }),
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
        trace: buildExtractionTrace(period, outcome, textLayerTrace, traceMeta),
        period,
        truncated: extraction.truncated,
        redactedFields: extraction.redacted_fields,
      });
    }

    // Stage 2h (§2h.3) / 2i (§2i.0b): the printed net's confirmed chain position (or lack of one) -
    // structured data, never prose (§2.6); the interface decides how to word it. Same vocabulary and
    // same resolver the trace uses, so the two can never disagree.
    const net_position = resolveNetPosition(period, outcome);
    const discrepancies = comparePeriodToDocument(period, outcome);

    return res.json({
      status: 'ok',
      period,
      outcome,
      discrepancies,
      net_position,
      // Stage 2h (§2h.4): shown on a successful read too, per its own "why" - the owner's one real-PDF
      // upload result is read from this line whether or not it happens to block on anything.
      technicalDetails: {
        text_items_sent: documentText.length,
        amounts_checked: textLayerAssessment.checked,
        amounts_not_found: textLayerAssessment.unverified,
        text_layer_status: textLayerAssessment.status,
        request_size_kb: requestSizeKb,
        request_size_source: requestSizeSource,
        render_step: renderStep,
      },
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

function isFiniteOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}
function isField(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return typeof f.provenance === 'string' && isFiniteOrNull(f.value);
}
function isFiniteAmountLine(v: unknown): boolean {
  return !!v && typeof v === 'object' && typeof (v as Record<string, unknown>).amount === 'number' && Number.isFinite((v as Record<string, unknown>).amount);
}

/**
 * Stage 2h (audit v28, §2h.6): "/recompute validates the shape of period (arrays present, numbers
 * finite, known enums) and answers 400 invalid_period with no stack and no field names beyond the
 * code." Found necessary by the reviewer's own reproduction (T3c): a period missing most
 * `PayslipPeriod` fields reached `buildExtractionTrace`'s `.map()` calls on `undefined` and crashed
 * with a generic 500 instead of a clean 400 - this is the fix, checked BEFORE any other logic in the
 * route (including the period_type_confirmed gate, which itself called `buildExtractionTrace` on an
 * unvalidated body). Deliberately does not report which field failed (§2h.6's own instruction) - the
 * only legitimate caller is our own frontend echoing back a period this endpoint itself produced, so
 * a shape failure here means a bug or a forged request, neither of which benefits from a field-level
 * diagnostic in the response body.
 */
function isValidPayslipPeriodShape(value: unknown): value is PayslipPeriod {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  if (typeof p.period_type !== 'string' || !KNOWN_PERIOD_TYPES.includes(p.period_type as TierCPeriodType)) return false;
  if (typeof p.period_type_confirmed !== 'boolean') return false;
  if (!isStringOrNull(p.period_label) || !isStringOrNull(p.period_end_date)) return false;
  if (typeof p.is_correction !== 'boolean') return false;
  if (typeof p.version !== 'number' || !Number.isFinite(p.version)) return false;
  if (!Array.isArray(p.employers) || !p.employers.every((e) => e && typeof e === 'object' && isStringOrNull((e as Record<string, unknown>).name) && (typeof (e as Record<string, unknown>).franchise_bearing === 'boolean' || (e as Record<string, unknown>).franchise_bearing === 'unknown'))) return false;
  if (p.hirer !== null && !(p.hirer && typeof p.hirer === 'object' && isStringOrNull((p.hirer as Record<string, unknown>).name))) return false;
  if (!isFiniteOrNull(p.contract_hours)) return false;
  if (!Array.isArray(p.hour_lines) || !p.hour_lines.every(isFiniteAmountLine)) return false;
  if (!Array.isArray(p.pre_tax_deductions) || !p.pre_tax_deductions.every((d) => d && typeof d === 'object' && isField((d as Record<string, unknown>).amount))) return false;
  if (!p.bijzonder_tarief || typeof p.bijzonder_tarief !== 'object') return false;
  const bt = p.bijzonder_tarief as Record<string, unknown>;
  if (!['known', 'not_applicable', 'unknown'].includes(bt.bt_state as string)) return false;
  if (!bt.tarief_bt || typeof bt.tarief_bt !== 'object') return false;
  const tariefBt = bt.tarief_bt as Record<string, unknown>;
  if (!isFiniteOrNull(tariefBt.printed) || !isFiniteOrNull(tariefBt.computed) || !isFiniteOrNull(bt.jaarloon_bt)) return false;
  if (p.et !== null) {
    if (!p.et || typeof p.et !== 'object') return false;
    const et = p.et as Record<string, unknown>;
    if (typeof et.et_applicable !== 'boolean') return false;
    if (typeof et.et_exchange_amount !== 'number' || !Number.isFinite(et.et_exchange_amount)) return false;
    if (!Array.isArray(et.et_reimbursements) || !et.et_reimbursements.every(isFiniteAmountLine)) return false;
    if (!isStringOrNull(et.adres_fiskalny)) return false;
  }
  if (!Array.isArray(p.post_tax_social) || !p.post_tax_social.every((d) => d && typeof d === 'object' && isField((d as Record<string, unknown>).amount))) return false;
  if (!Array.isArray(p.net_additions) || !p.net_additions.every(isFiniteAmountLine)) return false;
  if (!Array.isArray(p.net_deductions) || !p.net_deductions.every(isFiniteAmountLine)) return false;
  if (!Array.isArray(p.payout_adjustments) || !p.payout_adjustments.every(isFiniteAmountLine)) return false;
  if (
    !Array.isArray(p.reservations) ||
    !p.reservations.every(
      (r) =>
        r &&
        typeof r === 'object' &&
        typeof (r as Record<string, unknown>).opgebouwd_this_period === 'number' &&
        Number.isFinite((r as Record<string, unknown>).opgebouwd_this_period) &&
        typeof (r as Record<string, unknown>).paid_out_this_period === 'number' &&
        Number.isFinite((r as Record<string, unknown>).paid_out_this_period),
    )
  )
    return false;
  if (!isFiniteOrNull(p.wml_printed) || !isFiniteOrNull(p.wml_applicable)) return false;
  const printedNumberFields = ['printed_table_tax', 'printed_bt_tax', 'printed_algemene_heffingskorting', 'printed_arbeidskorting', 'printed_net', 'printed_payout', 'printed_gross_total', 'printed_loon_voor_heffingen'];
  if (!printedNumberFields.every((f) => isFiniteOrNull(p[f]))) return false;
  const printedLabelFields = ['printed_table_tax_label', 'printed_bt_tax_label', 'printed_algemene_heffingskorting_label', 'printed_arbeidskorting_label', 'printed_net_label', 'printed_payout_label'];
  if (!printedLabelFields.every((f) => isStringOrNull(p[f]))) return false;
  return true;
}

router.post('/recompute', async (req, res) => {
  const rawPeriodInput = req.body?.period;
  if (!isValidPayslipPeriodShape(rawPeriodInput)) {
    return res.status(400).json({ error_code: 'invalid_period' });
  }
  const rawPeriod = rawPeriodInput;
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

  // Stage 2h (§2h.3) / 2i (§2i.0b): same structured basis /analyze reports - a correction can change
  // which chain position the printed net now confirms (or stops confirming).
  const net_position = resolveNetPosition(period, outcome);
  const discrepancies = comparePeriodToDocument(period, outcome);
  return res.json({
    status: 'ok',
    outcome,
    discrepancies,
    net_position,
    // Stage 2h (§2h.4): /recompute sends no document text at all (it re-derives from an already-read
    // period) - the technical-details line still appears, honestly reporting nothing to check.
    technicalDetails: { text_items_sent: 0, amounts_checked: 0, amounts_not_found: 0, text_layer_status: 'none' as const, request_size_kb: 0, request_size_source: 'measured' as const, render_step: 'non-pdf' },
    taxRatesSource: fetched.source,
  });
});

export default router;
