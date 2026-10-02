// P2 controlled live pass (ZADANIE-P2-LOONTO-PRO.md §P2.15/§P2.16) over the SYNTHETIC corpus from
// generate-corpus.mjs. Uses the production code path: the frontend batch planner, the backend Gemini
// fact readers, the deterministic merge, the Payroll Profile resolver and the extraction table.
// Every reader result is cached per (document, pages) so no document is ever read twice; a call log is
// written next to the results. Requires GEMINI_API_KEY (and builds: `npm run build --workspace @nl-payslip/backend`).
// Usage: node scripts/p2-reference/live-pass.mjs <corpusDir> <outDir> [--dry-run]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const [corpusDir, outDir] = process.argv.slice(2);
const dryRun = process.argv.includes('--dry-run');
if (!corpusDir || !outDir) throw new Error('usage: live-pass.mjs <corpusDir> <outDir> [--dry-run]');
mkdirSync(path.join(outDir, 'cache'), { recursive: true });

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = (p) => pathToFileURL(path.join(repo, 'apps/backend-node/dist', p)).href;
const { planDocumentBatches } = await import(pathToFileURL(path.join(repo, 'apps/frontend-react/src/document-batches.ts')).href);
const { extractPayslipFacts, extractContractFacts, geminiModel } = await import(dist('ai-service/gemini-client.js'));
const { mergePayslipBatches, mergeContractBatches } = await import(dist('payroll-engine/document-facts.js'));
const { resolvePayrollProfile } = await import(dist('payroll-engine/payroll-profile.js'));
const { buildExtractionTable } = await import(dist('payroll-engine/fact-table.js'));

// --- the frontend's own reading steps, reproduced for Node (local-ocr.ts needs a browser) ----------
async function readSource(file) {
  if (!file.endsWith('.pdf')) return { isPdf: false, pageCount: 1, lines: [], itemsPerPage: [0], charsPerPage: [0] };
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(file)), standardFontDataUrl: `${path.join(repo, 'node_modules/pdfjs-dist/standard_fonts').split(path.sep).join('/')}/` }).promise;
  const lines = []; const itemsPerPage = []; const charsPerPage = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const rows = new Map(); let items = 0;
    for (const raw of content.items) {
      const text = typeof raw.str === 'string' ? raw.str.trim() : '';
      if (!text) continue;
      items += 1;
      const y = Math.round(raw.transform[5] ?? 0);
      rows.set(y, [...(rows.get(y) ?? []), { x: Math.round(raw.transform[4] ?? 0), text }]);
    }
    let chars = 0;
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const text = rows.get(y).sort((a, b) => a.x - b.x).map((r) => r.text).join(' ').slice(0, 1000);
      chars += text.length; lines.push({ page: n, text });
    }
    itemsPerPage.push(items); charsPerPage.push(chars);
  }
  return { isPdf: true, pageCount: pdf.numPages, lines, itemsPerPage, charsPerPage, pdf };
}

async function renderPages(pdf, pages, textMode) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const scale = textMode ? 1.5 : 2;
  const quality = textMode ? 90 : 85;
  const out = [];
  for (const n of pages) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const jpeg = canvas.toBuffer('image/jpeg', quality);
    if (process.env.P2_DUMP_PAGES) writeFileSync(path.join(outDir, `render-p${n}-${Date.now()}.jpg`), jpeg);
    out.push(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
  }
  return out;
}

// --- reference corpus and expected facts (all synthetic) -------------------------------------------
const DOCS = [
  { id: 'payslip-text', file: 'payslip-text.pdf', role: 'payslip', modality: 'text PDF' },
  { id: 'payslip-photo', file: 'payslip-photo.jpg', role: 'payslip', modality: 'photo (JPEG)' },
  { id: 'contract-text', file: 'contract-text.pdf', role: 'contract_base', modality: 'text PDF (5 pages)' },
  { id: 'annex-text', file: 'annex-text.pdf', role: 'contract_annex', modality: 'text PDF', userDate: '2026-09-01' },
  { id: 'contract-scan', file: 'contract-scan.pdf', role: 'contract_base', modality: 'scanned PDF (4 pages, images only)' },
];

// key, expected normalised value, expected page, optional printed-label match (for line rows)
const EXPECTED = {
  'payslip-text': [
    ['payslip.periodLabel', 'week 10/2026', 1], ['payslip.periodStart', '2026-03-02', 1], ['payslip.periodEnd', '2026-03-08', 1],
    ['payslip.paymentDate', '2026-03-13', 1], ['payslip.periodType', 'week', 1], ['payslip.employerName', 'Synthetic Uitzend B.V.', 1],
    ['payslip.hirerName', 'Synthetic Client B.V.', 1], ['payslip.hoursPerWeek', 40, 1],
    ['payslip.hourLine.regular.rate', 16.2, 1, 'Uren normaal'], ['payslip.hourLine.overtime.percent', 125, 1, 'Overwerk 125'],
    ['payslip.hourLine.overtime.percent', 150, 1, 'Overwerk 150'], ['payslip.hourLine.irregular_surcharge.percent', 50, 1, 'onregelmatig'],
    ['payslip.deduction.pre_tax.pension.percent', 7.5, 1], ['payslip.deduction.pre_tax.paww.percent', 0.1, 1],
    ['payslip.netLine.reimbursement.amount', 42, 1], ['payslip.netLine.housing.amount', 95, 1],
    ['payslip.reservation.vakantiegeld.accrued', 75.17, 1],
    ['payslip.printedGrossTotal', 939.6, 1], ['payslip.printedLoonVoorHeffingen', 892.91, 1], ['payslip.printedTableTax', 98.22, 1],
    ['payslip.printedNet', 794.69, 1], ['payslip.printedPayout', 741.69, 1],
  ],
  'payslip-photo': [
    ['payslip.periodLabel', 'Periode 11 / 2026', 1], ['payslip.paymentDate', '2026-03-20', 1], ['payslip.employerName', 'Synthetic Uitzend B.V.', 1],
    ['payslip.hourLine.regular.rate', 16.2, 1, 'Uren normaal'], ['payslip.hourLine.overtime.percent', 150, 1, 'Overwerk'],
    ['payslip.deduction.pre_tax.pension.percent', 7.5, 1], ['payslip.deduction.pre_tax.paww.percent', 0.1, 1],
    ['payslip.printedTableTax', 61.1, 1], ['payslip.printedPayout', 573.1, 1],
  ],
  'contract-text': [
    ['contract.employerName', 'Synthetic Uitzend B.V.', 1], ['contract.hirerName', 'Synthetic Client B.V.', 1], ['contract.functionTitle', 'Orderpicker', 1],
    ['contract.startDate', '2026-01-05', 1], ['contract.endDate', '2026-12-31', 1], ['contract.caoPhase', 'A', 1],
    ['contract.hourlyRate', 16.2, 2], ['contract.hoursPerWeek', 40, 2], ['contract.guaranteedHours', 64, 3], ['contract.guaranteedHoursPeriodWeeks', 4, 3],
    ['contract.overtimeThresholdHours', 2, 4],
    ['contract.premium.overtime.total_multiplier', 125, 4, null, 1], ['contract.premium.overtime.total_multiplier', 150, 4, null, 2],
    ['contract.premium.sunday.total_multiplier', 200, 4], ['contract.premium.saturday.premium_above_base', 50, 4],
    ['contract.premium.irregular_hours.premium_above_base', 25, 4],
  ],
  'annex-text': [['contract.effectiveDate', '2026-09-01', 1], ['contract.hourlyRate', 16.8, 1], ['contract.employerName', 'Synthetic Uitzend B.V.', 1]],
  'contract-scan': [
    ['contract.employerName', 'Synthetic Uitzend B.V.', 1], ['contract.startDate', '2026-01-05', 1], ['contract.hourlyRate', 16.2, 2],
    ['contract.guaranteedHours', 64, 3], ['contract.guaranteedHoursPeriodWeeks', 4, 3], ['contract.overtimeThresholdHours', 2, 4],
    ['contract.premium.sunday.total_multiplier', 200, 4],
  ],
};
// Facts these documents do NOT print - any exact value for them would be an invented, false-certain fact.
const MUST_NOT_BE_CERTAIN = {
  'payslip-photo': ['payslip.periodType', 'payslip.hoursPerWeek', 'payslip.hirerName', 'payslip.periodStart', 'payslip.periodEnd'],
  'payslip-text': ['payslip.bijzonderTariefPercent', 'payslip.etExchangeAmount'],
  'contract-text': ['contract.monthlySalary', 'contract.effectiveDate'],
  'annex-text': ['contract.hoursPerWeek', 'contract.guaranteedHours', 'contract.overtimeThresholdHours'],
};

// --- run ------------------------------------------------------------------------------------------
// Owner constraints for the controlled pass: the configured model must be exactly the expected one
// (no silent substitution), at most MAX_CALLS reader calls, and the first failure stops every further
// call. The credential is never read, printed or logged here - only whether one is configured.
const EXPECTED_MODEL = 'gemini-3.1-pro-preview';
const MAX_CALLS = 7;
if (!dryRun) {
  if (!process.env.GEMINI_API_KEY) { console.error('STOP: GEMINI_API_KEY is not configured in this environment.'); process.exit(2); }
  if (geminiModel() !== EXPECTED_MODEL) { console.error(`STOP: configured model is ${geminiModel()}, expected ${EXPECTED_MODEL}.`); process.exit(2); }
}
let callsMade = 0;
let stopped = null;
const callLog = [];
const facts = {};
for (const doc of DOCS) {
  const file = path.join(corpusDir, doc.file);
  const source = await readSource(file);
  const plan = planDocumentBatches(source);
  const kind = doc.role === 'payslip' ? 'payslip' : 'contract';
  const batches = [];
  for (const b of plan.batches) {
    const cacheFile = path.join(outDir, 'cache', `${doc.id}-p${b.pages.join('_')}.json`);
    if (existsSync(cacheFile)) { batches.push(JSON.parse(readFileSync(cacheFile, 'utf-8'))); callLog.push({ doc: doc.id, pages: b.pages, model: 'cached', ms: 0, outcome: 'cached (not re-read)' }); continue; }
    const images = b.imagePages.length === 0 ? [] : source.isPdf ? await renderPages(source.pdf, b.imagePages, plan.mode === 'text') : [`data:image/jpeg;base64,${readFileSync(file).toString('base64')}`];
    const req = { images, imagePages: b.imagePages, pages: b.pages, totalPages: source.pageCount, textLines: source.lines.filter((l) => b.pages.includes(l.page)) };
    if (dryRun) { callLog.push({ doc: doc.id, pages: b.pages, imagePages: b.imagePages, textLines: req.textLines.length, imageKb: Math.round(images.join('').length / 1024), outcome: 'dry-run (not sent)' }); continue; }
    if (stopped) { callLog.push({ doc: doc.id, pages: b.pages, model: geminiModel(), ms: 0, outcome: `not sent - stopped after: ${stopped}` }); continue; }
    if (callsMade >= MAX_CALLS) { stopped = `call budget of ${MAX_CALLS} reached`; callLog.push({ doc: doc.id, pages: b.pages, model: geminiModel(), ms: 0, outcome: `not sent - ${stopped}` }); continue; }
    callsMade += 1;
    const started = Date.now();
    try {
      const batch = await (kind === 'payslip' ? extractPayslipFacts(req) : extractContractFacts(req));
      writeFileSync(cacheFile, JSON.stringify(batch, null, 1));
      batches.push(batch);
      callLog.push({ doc: doc.id, pages: b.pages, imagePages: b.imagePages, model: geminiModel(), ms: Date.now() - started, outcome: 'ok' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      stopped = `${doc.id} pages ${b.pages.join(',')} failed (${message})`;
      callLog.push({ doc: doc.id, pages: b.pages, model: geminiModel(), ms: Date.now() - started, outcome: `error: ${message}` });
    }
  }
  facts[doc.id] = { doc, plan, merged: batches.length === 0 ? null : kind === 'payslip' ? mergePayslipBatches(batches) : mergeContractBatches(batches) };
}
writeFileSync(path.join(outDir, 'call-log.json'), JSON.stringify(callLog, null, 1));
if (dryRun) { console.log(JSON.stringify(callLog, null, 1)); process.exit(0); }

// --- evaluate field by field ----------------------------------------------------------------------
const results = [];
for (const doc of DOCS) {
  const merged = facts[doc.id].merged;
  const table = merged ? buildExtractionTable([{ documentIndex: 0, documentLabel: doc.id, role: doc.role, facts: merged }]) : [];
  const used = new Set();
  const rows = [];
  for (const [key, expected, page, labelMatch, tier] of EXPECTED[doc.id] ?? []) {
    const candidates = table.filter((r, i) => !used.has(i) && r.key === key && (!labelMatch || (r.printedLabel ?? r.rawValue ?? '').toLowerCase().includes(labelMatch.toLowerCase())));
    const exactMatch = candidates.find((r) => r.status === 'exact' && (typeof expected === 'number' ? Math.abs(Number(r.value) - expected) < 0.005 : String(r.value).trim().toLowerCase().endsWith(String(expected).toLowerCase())));
    const row = exactMatch ?? candidates.find((r) => r.status === 'exact') ?? candidates[0] ?? null;
    if (row) used.add(table.indexOf(row));
    const verdict = !row || row.status === 'absent' ? 'unknown' : row.status !== 'exact' ? 'unknown' : exactMatch ? 'correct' : 'incorrect';
    const tierOk = tier === undefined ? null : (row?.destination ?? '').includes(`overtimeTier${tier}Premium`);
    rows.push({ key, expected, expectedPage: page, extracted: row?.value ?? null, raw: row?.rawValue ?? null, page: row?.page ?? null, label: row?.printedLabel ?? null, status: row?.status ?? 'absent', reason: row?.reason ?? null, destination: row?.destination ?? null, verdict, pageCorrect: verdict === 'correct' ? row.page === page : null, explicitTierCorrect: tierOk });
  }
  const falseCertain = (MUST_NOT_BE_CERTAIN[doc.id] ?? []).flatMap((key) => table.filter((r) => r.key === key && r.status === 'exact').map((r) => ({ key, value: r.value, raw: r.rawValue, page: r.page })));
  const incorrectCertain = rows.filter((r) => r.verdict === 'incorrect');
  const unexpectedExact = table.filter((r, i) => r.status === 'exact' && !used.has(i)).map((r) => ({ key: r.key, value: r.value, raw: r.rawValue, page: r.page, destination: r.destination }));
  results.push({
    doc: doc.id, modality: doc.modality, role: doc.role,
    coverage: merged?.coverage ?? null,
    expected: rows.length,
    correct: rows.filter((r) => r.verdict === 'correct').length,
    incorrect: incorrectCertain.length,
    unknown: rows.filter((r) => r.verdict === 'unknown').length,
    falseCertain: falseCertain.length + incorrectCertain.length,
    pageCorrect: rows.filter((r) => r.pageCorrect === true).length,
    pageChecked: rows.filter((r) => r.pageCorrect !== null).length,
    rows, falseCertainFacts: falseCertain, unexpectedExact,
  });
}

// Integration: one profile from the payslips + contract + annex (user date 2026-09-01), as of 2026-10-01.
const profileDocs = ['payslip-text', 'payslip-photo', 'contract-text', 'annex-text']
  .map((id, index) => ({ id, index, f: facts[id] }))
  .filter((d) => d.f.merged)
  .map((d) => ({ index: d.index, label: d.id, role: d.f.doc.role, effectiveDate: d.f.doc.userDate ?? null, facts: d.f.merged }));
const profile = resolvePayrollProfile({ asOfDate: '2026-10-01', documents: profileDocs });
const profileSummary = Object.fromEntries(
  [...Object.values(profile.employment), ...Object.values(profile.payroll)].map((f) => [f.key, { state: f.state, value: f.value, reason: f.reason?.code ?? null, sources: f.sources.map((s) => `${s.documentLabel}${s.page ? ` p${s.page}` : ''}`) }]),
);
profileSummary.observedOvertimePremiums = profile.observedOvertimePremiums.fields.map((f) => ({ value: f.value, state: f.state, sources: f.sources.map((s) => s.documentLabel) }));
profileSummary.annexDates = profile.contractContext.annexDates;

writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ model: geminiModel(), results, profileSummary }, null, 1));
for (const r of results) console.log(`${r.doc}: expected ${r.expected}, correct ${r.correct}, incorrect ${r.incorrect}, unknown ${r.unknown}, false-certain ${r.falseCertain}, page ${r.pageCorrect}/${r.pageChecked}, coverage ${JSON.stringify(r.coverage)}`);
if (stopped) console.log(`STOPPED: ${stopped}`);
console.log(`model: ${geminiModel()} | calls: ${callLog.filter((c) => c.outcome === 'ok').length} ok, ${callLog.filter((c) => c.outcome.startsWith('error')).length} failed, ${callLog.filter((c) => c.outcome.startsWith('cached')).length} cached`);
