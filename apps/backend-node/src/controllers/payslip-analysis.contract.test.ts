import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { found, hourLine, payslipBatch, contractBatch } from '../test-support/fact-fixtures.js';
import { rawPayslipWeek41, week41Batch } from '../test-support/r3b2-fixtures.js';
import type { PayslipFactsBatch } from '../payroll-engine/document-facts.js';

/**
 * FIN-02 Payslip Analysis - the server side of the screen, over real HTTP and with NO AI call:
 *   - `POST /api/pro/payslip-replay` by REFERENCE (new): server-held, session-bound batches only; foreign / contract /
 *     malformed references are refused; echoed batches keep working for the PRO diagnostic.
 *   - every synthetic case runs through the REAL `/api/profile/resolve` (Document Knowledge) and the REAL replay.
 * The screen's recorded backend (`apps/frontend-react/src/payslip-analysis/fixtures/payslip-analysis-fixtures.json`) is
 * GENERATED here (`FIN02_WRITE_FIXTURES=1 npm test`) and re-checked on every normal run, so the frontend tests can
 * never replay responses the real code no longer gives. Mocked: the database (rate-limit counter + the session-bound
 * record table, applying exactly the SQL's conditions) and the rules repository (static tax tables, no minimum wage).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.resolve(here, '../../../frontend-react/src/payslip-analysis/fixtures/payslip-analysis-fixtures.json');
const staticFile = JSON.parse(readFileSync(path.resolve(here, '../../../../packages/tax-tables/2026-rates.json'), 'utf-8')) as { periods: unknown[] };
const PERIOD = staticFile.periods[staticFile.periods.length - 1];

interface Row { session_hash: string; kind: string; payload: unknown; expiresAt: number }
const rows = new Map<string, Row>();
let app: (typeof import('../app.js'))['default'];
let server: ReturnType<typeof app.listen>;
let baseUrl: string;
let putRecord: (typeof import('../document-context/store.js'))['putRecord'];
let sessionHash: (typeof import('../document-context/session.js'))['sessionHash'];
const SESSION_A = 'A'.repeat(43);
const SESSION_B = 'B'.repeat(43);
const cookie = (id: string) => `loonto_doc_session=${id}`;
const TODAY = '2026-10-22';

before(async () => {
  mock.module('../database.js', {
    namedExports: {
      databaseConfigured: true,
      checkDatabase: async () => 'connected',
      transaction: async () => null,
      query: async (text: string, values: unknown[] = []) => {
        if (text.includes('INSERT INTO rate_limits')) return [{ count: 1 }];
        if (text.startsWith('DELETE FROM document_contexts')) return [];
        if (text.includes('INSERT INTO document_contexts')) {
          rows.set(String(values[0]), { session_hash: String(values[1]), kind: String(values[2]), payload: JSON.parse(String(values[3])), expiresAt: Date.now() + Number(values[4]) * 1000 });
          return [];
        }
        if (text.includes('FROM document_contexts')) {
          const row = rows.get(String(values[0]));
          if (!row) return [];
          if (text.includes('session_hash = $2') && row.session_hash !== values[1]) return [];
          if (text.includes('expires_at > now()') && row.expiresAt <= Date.now()) return [];
          return [{ kind: row.kind, payload: row.payload }];
        }
        return [];
      },
    },
  });
  mock.module('../rules-repository.js', {
    namedExports: { getCurrentRule: async () => PERIOD, getRuleAt: async () => null, getMinimumWageAt: async () => null, listRuleFreshness: async () => [] },
  });
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  ({ default: app } = await import('../app.js'));
  ({ putRecord } = await import('../document-context/store.js'));
  ({ sessionHash } = await import('../document-context/session.js'));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

type Json = Record<string, any>;
async function post(url: string, body: unknown, session: string | null = SESSION_A): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: cookie(session) } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Json };
}

/** As the reader route does after a read: the batch kept server-side for this browser session. */
async function stored(batch: unknown, documentKind: 'payslip' | 'contract' = 'payslip', session = SESSION_A): Promise<string> {
  return (await putRecord(sessionHash(session), { kind: 'batch', documentKind, batch })) as string;
}

// ---------------------------------------------------------------------------------------------
// The replay by reference - server provenance only
// ---------------------------------------------------------------------------------------------

test('FIN-02 replay by reference: server-held batches of THIS session only; echo still works for the PRO diagnostic', async () => {
  const ref = await stored(week41Batch());
  const byRef = await post('/api/pro/payslip-replay', { batchRefs: [ref] });
  assert.equal(byRef.status, 200);
  assert.deepEqual([byRef.json.status, byRef.json.source], ['ok', 'server_reference']);
  const echo = await post('/api/pro/payslip-replay', { batches: [week41Batch()] });
  assert.deepEqual([echo.status, echo.json.source], [200, 'client_echo']);
  assert.deepEqual(echo.json.discrepancies, byRef.json.discrepancies, 'the same replay either way');

  const foreign = await stored(week41Batch(), 'payslip', SESSION_B);
  const contract = await stored(contractBatch(), 'contract');
  for (const [name, body, session] of [
    ['other session', { batchRefs: [foreign] }, SESSION_A],
    ['no session cookie', { batchRefs: [ref] }, null],
    ['contract batch', { batchRefs: [contract] }, SESSION_A],
    ['unknown ref', { batchRefs: ['C'.repeat(32)] }, SESSION_A],
  ] as const) {
    const r = await post('/api/pro/payslip-replay', body, session);
    assert.deepEqual([r.status, r.json.error_code], [409, 'document_reference_invalid'], name);
  }
  for (const [name, body] of [
    ['both', { batchRefs: [ref], batches: [week41Batch()] }],
    ['neither', {}],
    ['malformed ref', { batchRefs: ['../../etc'] }],
    ['empty refs', { batchRefs: [] }],
    ['too many refs', { batchRefs: Array.from({ length: 21 }, () => ref) }],
  ] as const) assert.deepEqual((await post('/api/pro/payslip-replay', body)).status, 400, name);
});

// ---------------------------------------------------------------------------------------------
// The synthetic cases - real resolve + real replay, recorded for the screen
// ---------------------------------------------------------------------------------------------

/** "no_mismatch": the week-41 payslip with the figures Loonto's own engine derives printed on it. */
async function consistentWeek41(): Promise<PayslipFactsBatch> {
  const base = (await post('/api/pro/payslip-replay', { batches: [week41Batch()] })).json;
  const r = base.outcome.result as Record<string, number>;
  const two = (n: number) => n.toFixed(2);
  return week41Batch({
    printed_table_tax: found(r.table_tax_after_korting as number, `Loonheffing ${two(r.table_tax_after_korting as number)}`, 1, 'Loonheffing'),
    printed_gross_total: found(r.gross_total as number, `Bruto loon ${two(r.gross_total as number)}`, 1, 'Bruto loon'),
    printed_net: found(r.wage_net as number, `Totaal netto ${two(r.wage_net as number)}`, 1, 'Totaal netto'),
    printed_payout: found(r.payout_amount as number, `Overgemaakt ${two(r.payout_amount as number)}`, 1, 'Overgemaakt'),
  });
}

const NIGHT_UNREADABLE = hourLine({ description: 'Nachttoeslag', kind: 'irregular_surcharge', adds_hours: 'no', hours: 4, rate: null, percent: null, amount: null, unclear_fields: ['amount', 'percent'], raw: 'Nachttoeslag 4.00 uur', page: 1 });

async function caseBatches(): Promise<Record<string, PayslipFactsBatch[]>> {
  const w = rawPayslipWeek41();
  return {
    /** The task's week-41 payslip: rate, hours, wage + ADV lines, net, travel reimbursement, payout; NO printed tax. */
    normal: [week41Batch()],
    /** Printed gross, tax, net and payout all present and consistent with Loonto's calculation. */
    no_mismatch: [await consistentWeek41()],
    /** Printed tax 30.00 and gross 568.42 with net 509.92: the payslip's own figures do not add up. */
    known_mismatch: [week41Batch({ printed_table_tax: found(30, 'Loonheffing 30.00', 1, 'Loonheffing'), printed_gross_total: found(568.42, 'Bruto loon 568.42', 1, 'Bruto loon') })],
    /** A night-premium line whose amount and percent could not be read. */
    unknown_premium: [payslipBatch({ ...w, hour_lines: [...(w.hour_lines as unknown[]), NIGHT_UNREADABLE] })],
    /** Page 2 of 2 was not read. */
    partial: [payslipBatch(rawPayslipWeek41(), [1], 2)],
    /** No period type printed: the replay cannot run. */
    period_unknown: [week41Batch({ period_type: { status: 'absent', value: null, raw: null, page: null, label: null } })],
  };
}

const placeholder = (kind: 'batch' | 'ctx', name: string) => `${kind === 'batch' ? 'FIN02batch' : 'FIN02ctx'}_${name}`.padEnd(32, '0').slice(0, 32);

async function buildFixtures() {
  const cases: Record<string, unknown> = {};
  for (const [name, batches] of Object.entries(await caseBatches())) {
    const refs = await Promise.all(batches.map((b) => stored(b)));
    const resolved = await post('/api/profile/resolve', { asOfDate: TODAY, documents: [{ index: 0, documentId: 'doc-1', label: 'payslip-1', role: 'payslip', effectiveDate: null, batchRefs: refs }] });
    assert.equal(resolved.status, 200, `${name}: resolve`);
    assert.ok(resolved.json.documentContext, `${name}: a document context by reference`);
    const replay = await post('/api/pro/payslip-replay', { batchRefs: refs });
    assert.equal(replay.status, 200, `${name}: replay`);
    const totalPages = batches[0]?.totalPages ?? 1;
    const read = new Set(batches.flatMap((b) => b.pages));
    const notProcessed = Array.from({ length: totalPages }, (_, i) => i + 1).filter((p) => !read.has(p));
    cases[name] = {
      /** What the reader adapter hands the screen after a good read (batch content is not used by the screen). */
      read: { status: 'done', batchRefs: [placeholder('batch', name)], coverage: { totalPages, notProcessedPages: notProcessed, reason: notProcessed.length > 0 ? 'batch_failed' : null } },
      /** The real resolve response's document context (the only part the screen uses); the profile is reduced to a marker. */
      resolve: { profile: { recorded: 'profile omitted - the screen reads documentContext only' }, documentContext: { ...resolved.json.documentContext, ref: placeholder('ctx', name) } },
      replay: replay.json,
    };
  }
  return { note: 'GENERATED by apps/backend-node/src/controllers/payslip-analysis.contract.test.ts (FIN02_WRITE_FIXTURES=1). Synthetic data only. Do not edit by hand.', today: TODAY, cases };
}

type Fixtures = Awaited<ReturnType<typeof buildFixtures>>;
let recorded: Fixtures;

test('FIN-02 contract: the screen\'s recorded backend equals what the real resolve + replay produce now', async () => {
  const fixtures = JSON.parse(JSON.stringify(await buildFixtures())) as Fixtures;
  if (process.env.FIN02_WRITE_FIXTURES === '1') {
    mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
    writeFileSync(FIXTURE_FILE, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf-8');
  }
  assert.ok(existsSync(FIXTURE_FILE), `missing ${FIXTURE_FILE} - run FIN02_WRITE_FIXTURES=1 npm test`);
  recorded = JSON.parse(readFileSync(FIXTURE_FILE, 'utf-8')) as Fixtures;
  assert.deepEqual(recorded, fixtures, 'the Payslip Analysis fixtures drifted from the real backend behaviour');
  const text = JSON.stringify(recorded);
  assert.doesNotMatch(text, /\b\d{9}\b/, 'no BSN-like number in the synthetic fixtures');
  assert.doesNotMatch(text, /\bNL\d{2}[A-Z]{4}\d{10}\b/, 'no IBAN in the synthetic fixtures');
});

const c = (name: string) => (recorded.cases as Record<string, { replay: Json; resolve: Json }>)[name] as { replay: Json; resolve: Json };
const facts = (name: string) => c(name).resolve.documentContext.knowledge.facts as Array<{ key: string; value: unknown }>;
const codes = (list: Array<{ code: string }> | undefined) => (list ?? []).map((i) => i.code).sort();

test('FIN-02 cases: printed gross, net and payout stay separate facts; nothing unread becomes zero', () => {
  const normal = facts('normal');
  assert.deepEqual(['net', 'payout'].map((k) => normal.find((f) => f.key === k)?.value), [509.92, 584.92]);
  assert.equal(normal.find((f) => f.key === 'gross_total'), undefined, 'gross is not printed on this payslip - absent, never 0');
  assert.equal(normal.find((f) => f.key === 'tax'), undefined);
  const full = facts('no_mismatch');
  const [gross, net, payout] = ['gross_total', 'net', 'payout'].map((k) => full.find((f) => f.key === k)?.value as number);
  assert.ok(gross !== net && net !== payout && gross !== payout, 'three different printed totals');
  assert.equal(facts('unknown_premium').filter((f) => f.key === 'wage_line_amount').length, 2, 'the unreadable premium amount is not a fact');
});

test('FIN-02 cases: the replay\'s honest states - missing inputs, the payslip\'s own arithmetic, no mismatch, partial read, no period', () => {
  assert.deepEqual(codes(c('normal').replay.needsConfirmation), ['printed_tax_unknown'], 'without printed tax Loonto\'s comparison lacks its key input');
  assert.deepEqual([codes(c('no_mismatch').replay.needsConfirmation), c('no_mismatch').replay.discrepancies], [[], []], 'consistent figures: nothing flagged');
  assert.ok(codes(c('known_mismatch').replay.needsConfirmation).includes('net_does_not_reconcile'), 'printed gross - printed tax does not reach printed net');
  assert.ok(codes(c('known_mismatch').replay.discrepancies).includes('table_tax_mismatch'));
  assert.ok(codes(c('unknown_premium').replay.needsConfirmation).includes('amount_unreadable'));
  assert.deepEqual(c('partial').replay.coverage.notProcessedPages, [2]);
  assert.deepEqual([c('period_unknown').replay.status, c('period_unknown').replay.reason], ['unavailable', 'period_type_unknown']);
  for (const name of Object.keys(recorded.cases)) assert.equal(c(name).replay.source, 'server_reference', name);
});
