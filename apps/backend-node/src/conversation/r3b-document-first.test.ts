import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { runConversationTurn, type TurnRequest } from './conversation-turn.js';
import { selectNextQuestion } from './next-question.js';
import type { AgentOutcome } from './conversation-agent.js';
import type { ConversationTurnResult } from './conversation-types.js';
import { evaluateScenario } from '../scenario/scenario-evaluate.js';
import { EMPLOYMENT_FIELD_ENGINE, PAYROLL_FIELD_ENGINE } from '../scenario/scenario-profile-gaps.js';
import type { ScenarioV1 } from '../scenario/scenario-types.js';
import { RATES_2026, known, ok, out, scenario, scriptedAgent } from '../test-support/conversation-fixtures.js';
import { INSTRUCTION_TEXT, r3bFactBatches, type R3BDocumentId } from '../test-support/r3b-fixtures.js';
import { mergePayslipBatches, type PayslipFactsBatch } from '../payroll-engine/document-facts.js';
import { resolvePayrollProfile } from '../payroll-engine/payroll-profile.js';
import { buildDocumentKnowledge, type DocumentKnowledge } from '../document-context/knowledge.js';
import { trustedContextFromProfile, type TrustedContext } from './trusted-context.js';

/**
 * R3-B (Document-First Intelligent Conversation) - the server side of the vertical slice, with NO paid call:
 * the reader is replaced by synthetic fact batches built through the real reader mapping; the Payroll Profile is
 * the real `/api/profile/resolve` over HTTP; the conversation is the real `runConversationTurn` with no model or a
 * scripted one. What the R3-B interface sends and receives is recorded in
 * `apps/frontend-react/src/r3b/fixtures/r3b-contract-fixtures.json`: the frontend tests replay those exact
 * responses and assert they send those exact requests; this file re-runs every recorded request against the real
 * code and requires the same responses - so neither side can drift without a failing test.
 * Regenerate after an intended change: `R3B_WRITE_FIXTURES=1 npm test` (then review the diff).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILE = path.resolve(here, '../../../frontend-react/src/r3b/fixtures/r3b-contract-fixtures.json');
const PROJECTION_FILE = path.resolve(here, '../../../frontend-react/src/r3b/r3b-profile-projection.ts');

/** The interface's weekly base-pay goal does not ask about tax, deductions or extras (they are not deferred values -
 * the evaluation stays blocked on them, so no amount can appear). Mirrored by the frontend constant. */
const OUT_OF_GOAL = [
  'tax.loonheffingskorting', 'deductions.mode', 'deductions.entered.pension', 'deductions.entered.paww', 'deductions.entered.sectorPremium',
  'deductions.entered.postTaxOther', 'extras.travelAllowance', 'extras.vakantiegeld.mode', 'extras.vakantiegeld.percent',
];
/** The interface's technical as-of date for a document set the as-of date cannot change (no annex). */
const TODAY = '2026-10-18';

/**
 * R3-B.2: the server-held references of the recorded week-41 flow. The real store issues random references bound to a
 * session (document-context/store.ts - its HTTP path is covered by controllers/document-context.controller.test.ts);
 * here they are fixed, and the context behind R3B2_CONTEXT_REF is built exactly as profile.controller.ts builds it:
 * the documentary profile of the same batches, its TrustedContext and its Document Knowledge.
 */
const R3B2_BATCH_REF = `R3B2batchRef${'0'.repeat(20)}`;
const R3B2_CONTEXT_REF = `R3B2contextRef${'0'.repeat(18)}`;

function week41Context(): { trusted: TrustedContext; knowledge: DocumentKnowledge } {
  const documents = [{ index: 0, documentId: 'doc-1', label: 'payslip-1', role: 'payslip' as const, effectiveDate: null, facts: mergePayslipBatches(r3bFactBatches().payslip_week41_1555 as PayslipFactsBatch[]) }];
  const documentary = resolvePayrollProfile({ asOfDate: TODAY, documents });
  return { trusted: trustedContextFromProfile(documentary), knowledge: buildDocumentKnowledge(documents, documentary) };
}

let app: (typeof import('../app.js'))['default'];
let server: ReturnType<typeof app.listen>;
let baseUrl: string;

before(async () => {
  ({ default: app } = await import('../app.js'));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ---------------------------------------------------------------------------------------------
// The recorded interface contract: profile resolves, conversation flows, deterministic-reply probes
// ---------------------------------------------------------------------------------------------

type Role = 'payslip' | 'contract_base' | 'contract_annex';
interface DocSpec { fixture: R3BDocumentId; role: Role; effectiveDate?: string }

/** Exactly the request the R3-B interface builds: ids in upload order, technical labels (never a file name). */
function profileRequest(asOfDate: string, docs: DocSpec[]) {
  const batches = r3bFactBatches();
  return {
    asOfDate,
    documents: docs.map((d, i) => ({
      index: i, documentId: `doc-${i + 1}`, label: `${d.role}-${i + 1}`, role: d.role,
      effectiveDate: d.role === 'contract_annex' ? (d.effectiveDate ?? null) : null, factBatches: batches[d.fixture],
    })),
  };
}

const PAYSLIP: DocSpec = { fixture: 'payslip_week33_1680', role: 'payslip' };
const ANNEX_SET: DocSpec[] = [{ fixture: 'contract_base_1680', role: 'contract_base' }, { fixture: 'annex_1720_from_2026_09_01', role: 'contract_annex', effectiveDate: '2026-09-01' }, PAYSLIP];

const PROFILE_CASES: Record<string, () => ReturnType<typeof profileRequest>> = {
  payslip_only: () => profileRequest(TODAY, [PAYSLIP]),
  contract_payslip_conflict: () => profileRequest(TODAY, [{ fixture: 'contract_base_1720', role: 'contract_base' }, PAYSLIP]),
  annex_week_before: () => profileRequest('2026-08-31', ANNEX_SET),
  annex_week_from: () => profileRequest('2026-09-01', ANNEX_SET),
  partial_read: () => profileRequest(TODAY, [{ fixture: 'payslip_week33_1680_page1_of_2', role: 'payslip' }]),
  instruction_text: () => profileRequest(TODAY, [{ fixture: 'payslip_week33_instruction_text', role: 'payslip' }]),
  contract_no_rate: () => profileRequest(TODAY, [{ fixture: 'contract_base_no_rate', role: 'contract_base' }]),
};

interface FlowSpec { id: string; locale: 'pl' | 'en'; docKnown: string[]; contextRef?: string; steps: Array<{ message: string; agent?: AgentOutcome; extraDeferred?: string[] }> }

const FLOWS: FlowSpec[] = [
  // Case 1: a readable EUR 16.80 - the free-text goal (model path, scripted as the model reads it) and the no-model fallback.
  { id: 'case1_goal_model', locale: 'pl', docKnown: ['pay.hourlyRate'], steps: [
    { message: 'Ile dostanę za 40 godzin?', agent: ok({ intent: 'calculation_request', patch: { version: 1, ops: [] }, statedWeeklyHours: 40 }) },
    { message: '40 godzin od poniedziałku do piątku' },
  ] },
  { id: 'case1_goal_no_model', locale: 'pl', docKnown: ['pay.hourlyRate'], steps: [
    { message: 'Ile dostanę za 40 godzin?' },
    { message: '40 godzin od poniedziałku do piątku' },
  ] },
  // Case 2: no documents - the rate is asked; "nie wiem" keeps it unknown and is not asked again.
  { id: 'case2_no_documents', locale: 'pl', docKnown: [], steps: [
    { message: '40 godzin w tygodniu' }, { message: '40 godzin od poniedziałku do piątku' }, { message: 'Nie wiem' },
  ] },
  { id: 'case2_no_documents_en', locale: 'en', docKnown: [], steps: [
    { message: '40 hours a week' }, { message: '40 hours Monday to Friday' }, { message: "I don't know" },
  ] },
  // Case 3: the rate conflict - the user picked the payslip candidate (now a user-confirmed profile value), or left it open.
  { id: 'case3_conflict_payslip_chosen', locale: 'pl', docKnown: ['pay.hourlyRate'], steps: [{ message: '40 godzin w tygodniu' }, { message: '40 godzin od poniedziałku do piątku' }] },
  { id: 'case3_conflict_left_open', locale: 'pl', docKnown: [], steps: [{ message: '40 godzin w tygodniu', extraDeferred: ['pay.hourlyRate'] }, { message: '40 godzin od poniedziałku do piątku' }] },
  // Case 5: Saturday semantics - an intercepted bare "150%" resolved by the user as "150% in total" (+50% above base);
  // a night allowance given on the Saturday question; repeated "nie wiem".
  { id: 'case5_saturday_total_150', locale: 'pl', docKnown: ['pay.hourlyRate'], steps: [
    { message: '40 godzin w tygodniu' }, { message: 'Nie' }, { message: '32 godziny od poniedziałku do piątku i 8 godzin w sobotę' }, { message: '50%' },
  ] },
  { id: 'case5_night_allowance_and_dont_know', locale: 'pl', docKnown: ['pay.hourlyRate'], steps: [
    { message: '32 godziny od poniedziałku do piątku i 8 godzin w sobotę' },
    { message: 'dodatek nocny 50%', agent: out('provide_information', [{ op: 'set', field: 'pay.saturdayPremiumPercent', value: 50 }]) },
    { message: 'Nie wiem' }, { message: 'Nie wiem' },
  ] },
  { id: 'g23_repeated_dont_know', locale: 'pl', docKnown: [], steps: [{ message: 'Nie wiem' }, { message: 'Nie wiem' }] },
  // R3-B.2: a payslip read by reference - the worker's questions are answered from the document, the rate is trusted
  // (never asked), the calculation request still only gathers inputs.
  { id: 'r3b2_document_questions', locale: 'pl', docKnown: ['pay.hourlyRate'], contextRef: R3B2_CONTEXT_REF, steps: [
    { message: 'Jaka jest moja stawka?' },
    { message: 'Ile faktycznie przelano?' },
    { message: 'Dlaczego netto jest niższe?' },
    { message: 'Ile dostanę za 40 godzin?', agent: ok({ intent: 'calculation_request', patch: { version: 1, ops: [] }, statedWeeklyHours: 40 }) },
    { message: '40 godzin od poniedziałku do piątku' },
  ] },
  { id: 'r3b2_document_questions_en', locale: 'en', docKnown: ['pay.hourlyRate'], contextRef: R3B2_CONTEXT_REF, steps: [
    { message: 'What is my hourly rate?' },
    { message: 'How many hours was I paid?' },
  ] },
];

/** Deterministic replies the interface offers, per question context (all must be answered without a model). */
const PROBES: Array<{ context: string; locale: 'pl' | 'en'; docKnown: string[]; prefix: string[]; messages: string[] }> = [
  { context: 'opening', locale: 'pl', docKnown: [], prefix: [], messages: ['40 godzin w tygodniu', '40 godzin od poniedziałku do piątku', '32 godziny od poniedziałku do piątku i 8 godzin w sobotę', 'Nie wiem'] },
  { context: 'clarify_40', locale: 'pl', docKnown: [], prefix: ['40 godzin w tygodniu'], messages: ['40 godzin od poniedziałku do piątku', 'Nie', 'Nie wiem'] },
  { context: 'split_40', locale: 'pl', docKnown: [], prefix: ['40 godzin w tygodniu', 'Nie'], messages: ['32 godziny od poniedziałku do piątku i 8 godzin w sobotę', 'Nie wiem'] },
  { context: 'rate', locale: 'pl', docKnown: [], prefix: ['40 godzin od poniedziałku do piątku'], messages: ['16,80 €/h', 'Nie wiem'] },
  { context: 'saturday_premium', locale: 'pl', docKnown: ['pay.hourlyRate'], prefix: ['32 godziny od poniedziałku do piątku i 8 godzin w sobotę'], messages: ['50%', '150%', 'Nie wiem'] },
  { context: 'offer_saturday', locale: 'pl', docKnown: ['pay.hourlyRate'], prefix: ['32 godziny od poniedziałku do piątku i 8 godzin w sobotę', 'Nie wiem'], messages: ['Tak', 'Nie', 'Nie wiem'] },
  { context: 'opening', locale: 'en', docKnown: [], prefix: [], messages: ['40 hours a week', '40 hours Monday to Friday', '32 hours Monday to Friday and 8 hours on Saturday', "I don't know"] },
  { context: 'clarify_40', locale: 'en', docKnown: [], prefix: ['40 hours a week'], messages: ['40 hours Monday to Friday', 'No', "I don't know"] },
  { context: 'split_40', locale: 'en', docKnown: [], prefix: ['40 hours a week', 'No'], messages: ['32 hours Monday to Friday and 8 hours on Saturday', "I don't know"] },
  { context: 'rate', locale: 'en', docKnown: [], prefix: ['40 hours Monday to Friday'], messages: ['€16.80/h', "I don't know"] },
  { context: 'saturday_premium', locale: 'en', docKnown: ['pay.hourlyRate'], prefix: ['32 hours Monday to Friday and 8 hours on Saturday'], messages: ['50%', '150%', "I don't know"] },
  { context: 'offer_saturday', locale: 'en', docKnown: ['pay.hourlyRate'], prefix: ['32 hours Monday to Friday and 8 hours on Saturday', "I don't know"], messages: ['Yes', 'No', "I don't know"] },
];

/** What the interface sends as `deferredFields`: the server's list, then any missing goal/document/user deferral. */
function unionDeferred(server: readonly string[] | undefined, add: readonly string[]): string[] {
  const outList = [...(server ?? [])];
  for (const f of add) if (!outList.includes(f)) outList.push(f);
  return outList;
}

type RecordedTurnRequest = TurnRequest & { documentContextRef?: string };
interface TurnRecord { idPrefix: string; request: RecordedTurnRequest; agentOutcome: AgentOutcome | null; response: ConversationTurnResult }

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** As the turn route does: a request naming the (recorded) context reference runs with that server-held context. */
async function turnOnce(request: RecordedTurnRequest, agentOutcome: AgentOutcome | null, idPrefix: string): Promise<ConversationTurnResult> {
  let n = 0;
  const agent = agentOutcome ? scriptedAgent([agentOutcome]) : null;
  const { documentContextRef, ...turnRequest } = json(request);
  assert.ok(documentContextRef === undefined || documentContextRef === R3B2_CONTEXT_REF, 'only the recorded context exists');
  const ctx = documentContextRef ? week41Context() : null;
  return json(await runConversationTurn(turnRequest, { agent, rates: RATES_2026, trusted: ctx?.trusted ?? null, documentKnowledge: ctx?.knowledge ?? null, newId: () => `${idPrefix}-${++n}` }));
}

async function playFlow(locale: 'pl' | 'en', docKnown: string[], steps: FlowSpec['steps'], id: string, contextRef?: string): Promise<TurnRecord[]> {
  const records: TurnRecord[] = [];
  let last: ConversationTurnResult | null = null;
  for (const [i, step] of steps.entries()) {
    const request: RecordedTurnRequest = {
      ...(last ? { scenario: last.scenario } : {}),
      message: step.message,
      locale,
      conversation: { ...(last?.conversation ?? {}), deferredFields: unionDeferred(last?.conversation.deferredFields, [...docKnown, ...OUT_OF_GOAL, ...(step.extraDeferred ?? [])]) } as TurnRequest['conversation'],
      ...(contextRef ? { documentContextRef: contextRef } : {}),
    };
    const idPrefix = `${id}-t${i + 1}`;
    const response = await turnOnce(request, step.agent ?? null, idPrefix);
    records.push({ idPrefix, request: json(request), agentOutcome: step.agent ?? null, response });
    last = response;
  }
  return records;
}

async function resolve(body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}/api/profile/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  return res.json();
}

type IssueJson = { fieldPath: string; evidenceFingerprint: string; candidates: Array<{ candidateId: string; value: number; sources: Array<{ role: string }> }> };

async function buildFixtures() {
  const profiles: Record<string, { request: unknown; response: unknown }> = {};
  for (const [id, make] of Object.entries(PROFILE_CASES)) {
    const request = make();
    profiles[id] = { request, response: await resolve(request) };
  }
  // The user answers the grounded conflict question with the payslip's value: ONE existing confirm_candidate decision.
  const conflict = profiles.contract_payslip_conflict as { request: ReturnType<typeof profileRequest>; response: { issues: IssueJson[] } };
  const issue = conflict.response.issues.find((i) => i.fieldPath === 'employment.hourlyRate') as IssueJson;
  const candidate = issue.candidates.find((c) => c.sources.some((s) => s.role === 'payslip')) as IssueJson['candidates'][number];
  const chosen = { ...conflict.request, decisions: [{ kind: 'confirm_candidate', decisionId: 'd-r3b-1', fieldPath: issue.fieldPath, value: candidate.value, evidenceFingerprint: issue.evidenceFingerprint, decidedAt: '2026-10-18T10:00:00.000Z' }] };
  profiles.contract_payslip_conflict_payslip_chosen = { request: chosen, response: await resolve(chosen) };

  const turns: Record<string, TurnRecord[]> = {};
  // R3-B.2: the week-41 payslip by reference. The response is the real resolve of the same batches plus the document
  // context the controller issues for an all-by-reference request (here under the recorded reference).
  const week41Echo = (await resolve(profileRequest(TODAY, [{ fixture: 'payslip_week41_1555', role: 'payslip' }]))) as Record<string, unknown>;
  assert.equal(week41Echo.documentContext, null, 'echoed batches never produce a document context');
  profiles.payslip_week41_by_ref = {
    request: { asOfDate: TODAY, documents: [{ index: 0, documentId: 'doc-1', label: 'payslip-1', role: 'payslip', effectiveDate: null, batchRefs: [R3B2_BATCH_REF] }] },
    response: { ...week41Echo, documentContext: { ref: R3B2_CONTEXT_REF, knowledge: week41Context().knowledge } },
  };

  for (const flow of FLOWS) turns[flow.id] = await playFlow(flow.locale, flow.docKnown, flow.steps, flow.id, flow.contextRef);

  const probes: Array<{ context: string; locale: string; message: string; question: string | null; agentStatus: string; status: string; written: string[]; next: string | null }> = [];
  for (const probe of PROBES) {
    const prefix = await playFlow(probe.locale, probe.docKnown, probe.prefix.map((message) => ({ message })), `probe-${probe.context}-${probe.locale}`);
    const last = prefix[prefix.length - 1]?.response ?? null;
    for (const message of probe.messages) {
      const request: TurnRequest = {
        ...(last ? { scenario: last.scenario } : {}), message, locale: probe.locale,
        conversation: { ...(last?.conversation ?? {}), deferredFields: unionDeferred(last?.conversation.deferredFields, [...probe.docKnown, ...OUT_OF_GOAL]) } as TurnRequest['conversation'],
      };
      const response = await turnOnce(request, null, `probe-${probe.context}-${probe.locale}`);
      probes.push({
        context: probe.context, locale: probe.locale, message,
        question: last?.nextQuestion ? `${last.nextQuestion.kind}:${last.nextQuestion.field}` : 'provide_value:work.hours',
        agentStatus: response.agentStatus, status: response.status,
        written: (response.patchApplied ?? []).flatMap((op) => (op.op === 'write' ? [`${op.field}=${JSON.stringify(op.node)}`] : [])),
        next: response.nextQuestion ? `${response.nextQuestion.kind}:${response.nextQuestion.field}` : null,
      });
    }
  }

  return {
    note: 'GENERATED by apps/backend-node/src/conversation/r3b-document-first.test.ts (R3B_WRITE_FIXTURES=1). Synthetic data only. Do not edit by hand.',
    outOfGoalFields: OUT_OF_GOAL,
    technicalAsOfDate: TODAY,
    documentRefs: { batch: { payslip_week41_1555: [R3B2_BATCH_REF] }, context: R3B2_CONTEXT_REF },
    batches: r3bFactBatches(),
    profiles,
    turns,
    probes,
  };
}

type Fixtures = Awaited<ReturnType<typeof buildFixtures>>;
let fixtures: Fixtures;

test('R3-B contract: the shared interface fixtures equal what the real reader mapping, Profile and R2 produce now', async () => {
  fixtures = json(await buildFixtures());
  if (process.env.R3B_WRITE_FIXTURES === '1') {
    mkdirSync(path.dirname(FIXTURE_FILE), { recursive: true });
    writeFileSync(FIXTURE_FILE, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf-8');
  }
  assert.ok(existsSync(FIXTURE_FILE), `missing ${FIXTURE_FILE} - run R3B_WRITE_FIXTURES=1 npm test`);
  const recorded = JSON.parse(readFileSync(FIXTURE_FILE, 'utf-8')) as Fixtures;
  assert.deepEqual(recorded, fixtures, 'the frontend fixtures drifted from the real backend behaviour');
  // Every recorded turn replays to the same response (the frontend replays these exact responses).
  for (const records of Object.values(recorded.turns)) {
    for (const r of records) assert.deepEqual(await turnOnce(r.request, r.agentOutcome, r.idPrefix), r.response);
  }
  const text = JSON.stringify(recorded);
  assert.doesNotMatch(text, /\b\d{9}\b/, 'no BSN-like number in the synthetic fixtures');
  assert.doesNotMatch(text, /\bNL\d{2}[A-Z]{4}\d{10}\b/, 'no IBAN in the synthetic fixtures');
});

// ---------------------------------------------------------------------------------------------
// The five acceptance cases, asserted on the recorded (= real) behaviour
// ---------------------------------------------------------------------------------------------

type FieldJson = { state: string; value: unknown; unit: string; candidates: Array<{ value: unknown; source: { role: string; payPeriod: { startDate: string | null; endDate: string | null } | null } }>; sources: Array<{ role: string; page: number | null; printedLabel: string | null; rawValue: string | null; documentId: string | null; payPeriod: { startDate: string | null; endDate: string | null; periodType: string | null } | null }>; excluded: Array<{ reason: string; value: unknown }>; resolution?: { kind: string; decidedAt: string } | null };
type ProfileJson = { profile: { employment: Record<string, FieldJson>; payroll: Record<string, FieldJson> }; issues: Array<{ fieldPath: string; state: string }>; coverage: Array<{ index: number; totalPages: number; notProcessedPages: number[] }> };
const profileOf = (id: string) => (fixtures.profiles[id] as { response: ProfileJson }).response;
const rateOf = (id: string) => profileOf(id).profile.employment.hourlyRate as FieldJson;
const asked = (records: TurnRecord[]) => records.map((r) => r.response.nextQuestion?.field ?? null);
const NO_AMOUNT_KEYS = ['payoutAmount', 'wageNet', 'grossTotal', 'totalTax', 'figures', 'variants', 'range'];

function assertNoAmount(records: TurnRecord[]) {
  for (const r of records) {
    assert.notEqual(r.response.evaluation?.status, 'computed', `${r.idPrefix}: never a computed (payable) result`);
    const keys = JSON.stringify(r.response.evaluation ?? {});
    for (const k of NO_AMOUNT_KEYS) assert.ok(!keys.includes(`"${k}"`), `${r.idPrefix}: ${k}`);
  }
}

test('R3-B case 1: a readable EUR 16.80 payslip rate is read with its source - and never asked again', () => {
  const rate = rateOf('payslip_only');
  assert.equal(rate.state, 'document_exact');
  assert.equal(rate.value, 16.8);
  assert.equal(rate.sources[0]?.role, 'payslip');
  assert.equal(rate.sources[0]?.documentId, 'doc-1');
  assert.equal(rate.sources[0]?.page, 1);
  assert.deepEqual([rate.sources[0]?.payPeriod?.startDate, rate.sources[0]?.payPeriod?.endDate, rate.sources[0]?.payPeriod?.periodType], ['2026-08-10', '2026-08-16', 'week']);
  for (const id of ['case1_goal_model', 'case1_goal_no_model']) {
    const records = fixtures.turns[id] as TurnRecord[];
    assert.ok(!asked(records).includes('pay.hourlyRate'), `${id}: the document rate is not asked again`);
    assert.ok(records.every((r) => r.request.scenario?.pay.hourlyRate === undefined), `${id}: the document value never enters the Scenario`);
    assertNoAmount(records);
    const final = records[records.length - 1] as TurnRecord;
    assert.deepEqual(final.response.scenario.work.regularWeekdayHours, { state: 'known', value: 40, source: 'user' });
    assert.equal(final.response.nextQuestion, null);
    assert.equal(final.response.evaluation?.status, 'blocked', 'the rate stays a requirement: a provisional reading is not a calculable value');
  }
  const [modelGoal] = fixtures.turns.case1_goal_model as TurnRecord[];
  assert.equal(modelGoal?.response.nextQuestion?.kind, 'clarify_hours_composition', 'the hours are clarified, not guessed');
  const [noModelGoal] = fixtures.turns.case1_goal_no_model as TurnRecord[];
  assert.equal(noModelGoal?.response.agentStatus, 'not_configured');
  assert.equal(noModelGoal?.response.nextQuestion?.field, 'work.hours', 'without a model the step is still meaningful: the hours question');
});

test('R3-B case 2: without documents the rate is asked; "nie wiem" keeps it unknown and ends the loop (PL and EN)', () => {
  for (const id of ['case2_no_documents', 'case2_no_documents_en']) {
    const records = fixtures.turns[id] as TurnRecord[];
    assert.deepEqual(records.map((r) => r.response.agentStatus), ['not_needed', 'not_needed', 'not_needed'], `${id}: deterministic`);
    assert.deepEqual(asked(records), ['work.hours', 'pay.hourlyRate', null]);
    const final = records[2] as TurnRecord;
    assert.deepEqual(final.response.scenario.pay.hourlyRate, { state: 'unknown' }, 'unknown, never zero');
    assert.ok(final.response.conversation.deferredFields?.includes('pay.hourlyRate'));
    assertNoAmount(records);
  }
});

test('R3-B case 3: same-period contract/payslip rates stay a conflict; a choice is a separate user decision; disjoint periods are no conflict', async () => {
  const conflict = rateOf('contract_payslip_conflict');
  assert.equal(conflict.state, 'conflict');
  assert.equal(conflict.value, null, 'no winner is picked');
  assert.deepEqual(conflict.candidates.map((c) => [c.value, c.source.role]), [[17.2, 'contract_base'], [16.8, 'payslip']]);
  assert.ok(profileOf('contract_payslip_conflict').issues.some((i) => i.fieldPath === 'employment.hourlyRate' && i.state === 'conflict'));
  const chosen = rateOf('contract_payslip_conflict_payslip_chosen');
  assert.equal(chosen.state, 'user_confirmed', 'the user choice is a user state - never a document reading');
  assert.equal(chosen.value, 16.8);
  assert.equal(chosen.resolution?.kind, 'confirm_candidate');
  assert.equal(chosen.resolution?.decidedAt, '2026-10-18T10:00:00.000Z', 'the decision date is preserved');
  // Disjoint periods: before the annex the contract and the August payslip agree; from the annex the August payslip
  // belongs to an earlier regime (excluded with a marker) - neither date produces a conflict.
  const before = rateOf('annex_week_before');
  assert.equal(before.state, 'corroborated');
  assert.equal(before.value, 16.8);
  const from = rateOf('annex_week_from');
  assert.equal(from.state, 'document_exact');
  assert.equal(from.value, 17.2);
  assert.ok(from.excluded.every((x) => x.reason === 'superseded_by_later_document'));
  assert.ok(from.excluded.some((x) => x.value === 16.8));
  // Without an annex the as-of date changes nothing - the interface's technical date is not a hidden choice.
  const req = PROFILE_CASES.contract_payslip_conflict as () => ReturnType<typeof profileRequest>;
  for (const asOfDate of ['2025-01-06', '2027-12-31']) {
    const other = (await resolve({ ...req(), asOfDate })) as ProfileJson;
    assert.deepEqual(other.profile.employment.hourlyRate, conflict, `as-of ${asOfDate}`);
  }
  for (const id of ['case3_conflict_payslip_chosen', 'case3_conflict_left_open']) {
    const records = fixtures.turns[id] as TurnRecord[];
    assert.ok(!asked(records).includes('pay.hourlyRate'), `${id}: the grounded conflict question was asked instead`);
    assertNoAmount(records);
  }
});

test('R3-B case 4: a partly read document keeps its valid facts and names the page not read', () => {
  const partial = profileOf('partial_read');
  assert.deepEqual(partial.coverage, [{ index: 0, totalPages: 2, processedPages: [1], notProcessedPages: [2] }]);
  assert.equal(rateOf('partial_read').state, 'document_exact');
  assert.equal(rateOf('partial_read').value, 16.8);
});

test('R3-B case 5: instruction text inside a document is inert data; a night allowance never becomes the Saturday premium; repeated "nie wiem" ends', async () => {
  const instructed = rateOf('instruction_text');
  assert.equal(instructed.state, 'document_exact');
  assert.equal(instructed.value, 16.8, 'the printed instruction changes nothing');
  assert.ok(JSON.stringify(fixtures.profiles.instruction_text).includes(INSTRUCTION_TEXT), 'kept only as raw evidence');
  for (const records of Object.values(fixtures.turns)) {
    for (const r of records) assert.ok(!JSON.stringify(r.request).includes('IGNORE PREVIOUS'), 'document text never reaches the conversation');
  }

  const night = fixtures.turns.case5_night_allowance_and_dont_know as TurnRecord[];
  assert.equal(night[0]?.response.nextQuestion?.field, 'pay.saturdayPremiumPercent');
  assert.equal(night[1]?.response.scenario.pay.saturdayPremiumPercent, undefined, 'the night allowance is not written as the Saturday premium');
  assert.deepEqual(night[1]?.response.patchNotes.map((n) => n.code), ['component_mismatch_withheld']);
  assert.equal(night[2]?.response.nextQuestion?.kind, 'offer_assumption', 'after "nie wiem" an explicit Loonto assumption is OFFERED');
  assert.equal(night[3]?.response.scenario.pay.saturdayPremiumPercent?.state, 'unknown', '"nie wiem" is not an acceptance (CEO decision 10)');
  assert.equal(night[3]?.response.nextQuestion, null, 'no loop');
  assert.ok(night[3]?.response.conversation.deferredFields?.includes('pay.saturdayPremiumPercent'));
  assertNoAmount(night);

  const total150 = fixtures.turns.case5_saturday_total_150 as TurnRecord[];
  assert.deepEqual(total150[3]?.response.scenario.pay.saturdayPremiumPercent, { state: 'known', value: 50, source: 'user' }, 'the user said "150% in total" - written as +50% above base');

  const repeated = fixtures.turns.g23_repeated_dont_know as TurnRecord[];
  assert.deepEqual(asked(repeated), ['pay.hourlyRate', null]);
  assert.equal(repeated[0]?.response.scenario.work.regularWeekdayHours, undefined, 'never zero hours');
  assert.deepEqual(repeated[1]?.response.conversation.deferredFields?.slice(-2), ['work.hours', 'pay.hourlyRate']);

  // A client that injects `source: document` (even with the deferral list) is rejected before anything else runs.
  const forged = await runConversationTurn({ scenario: scenario({ work: { regularWeekdayHours: known(40) }, pay: { hourlyRate: known(16.8, 'document', 'doc-1') } }), message: '40 godzin od poniedziałku do piątku', locale: 'pl', conversation: { deferredFields: ['pay.hourlyRate'] } }, { agent: null, rates: RATES_2026, trusted: null });
  assert.equal(forged.status, 'rejected');
  assert.equal(forged.evaluation, null);
  assert.deepEqual(forged.patchIssues.map((i) => i.code), ['untrusted_provenance_in_scenario']);
});

test('R3-B probes: every reply the interface suggests is answered deterministically (no model call)', () => {
  assert.ok(fixtures.probes.length >= 30);
  for (const p of fixtures.probes) {
    assert.equal(p.agentStatus, 'not_needed', `${p.locale}/${p.context}: "${p.message}"`);
    for (const w of p.written) assert.match(w, /"source":"(user|loonto_assumption)"|"state":"unknown"/, `${p.message}: ${w}`);
  }
});

// ---------------------------------------------------------------------------------------------
// The selector / turn rules behind the hint
// ---------------------------------------------------------------------------------------------

const ask = (s: ScenarioV1, deferredFields: string[]) => selectNextQuestion({ scenario: s, evaluation: evaluateScenario(s, RATES_2026), deferredFields });

test('R3-B selector: deferral skips blocked requirements only - it never hides a correction of an invalid Scenario', () => {
  const s = scenario({ work: { regularWeekdayHours: known(40) } });
  assert.equal(ask(s, [])?.field, 'pay.hourlyRate');
  assert.equal(ask(s, ['pay.hourlyRate'])?.field, 'tax.loonheffingskorting');
  assert.equal(ask(s, ['pay.hourlyRate', ...OUT_OF_GOAL]), null);
  assert.equal(evaluateScenario(s, RATES_2026).status, 'blocked', 'the evaluation is unaffected');
  const invalid = scenario({ work: { regularWeekdayHours: known(-5) }, pay: { hourlyRate: known(16.8) } });
  assert.equal(ask(invalid, ['work.regularWeekdayHours', 'work.hours'])?.kind, 'correct_value');
});

test('R3-B turn: without the list nothing changes (R2 behaviour); with it, a decline after an offer is not followed by the same question', async () => {
  const withSaturday = scenario({ work: { regularWeekdayHours: known(32), saturdayHours: known(8) }, pay: { hourlyRate: known(16.8) } });
  const legacy = await runConversationTurn({ scenario: withSaturday, message: 'nie wiem', locale: 'pl' }, { agent: null, rates: RATES_2026, trusted: null });
  assert.equal(legacy.conversation.deferredFields, undefined);
  assert.equal(legacy.nextQuestion?.kind, 'offer_assumption');
  const declined = await runConversationTurn({ scenario: legacy.scenario, message: 'nie', locale: 'pl', conversation: { ...legacy.conversation, deferredFields: [] } }, { agent: null, rates: RATES_2026, trusted: null });
  assert.notEqual(declined.nextQuestion?.field, 'pay.saturdayPremiumPercent');
  assert.deepEqual(declined.conversation.deferredFields, ['pay.saturdayPremiumPercent']);
  assert.deepEqual(declined.conversation.declinedAssumptions, ['pay.saturdayPremiumPercent']);
  const agent = scriptedAgent([]);
  const dontKnowOffer = await runConversationTurn({ scenario: legacy.scenario, message: 'nie wiem', locale: 'pl', conversation: legacy.conversation }, { agent, rates: RATES_2026, trusted: null });
  assert.equal(agent.calls, 0, '"nie wiem" to an offer needs no model');
  assert.equal(dontKnowOffer.status, 'unchanged', 'and is not an acceptance');
});

test('R3-B projection: the interface maps document fields only onto the Scenario fields the backend itself says they feed', () => {
  const source = readFileSync(PROJECTION_FILE, 'utf-8');
  const block = /DOCUMENT_FIELD_TO_SCENARIO[^{]*\{([^}]*)\}/.exec(source)?.[1] ?? '';
  const pairs = [...block.matchAll(/'(employment|payroll)\.(\w+)':\s*'([\w.]+)'/g)].map((m) => ({ group: m[1] as string, key: m[2] as string, field: m[3] as string }));
  assert.ok(pairs.length >= 1 && pairs.some((p) => p.key === 'hourlyRate'));
  for (const p of pairs) {
    const table = (p.group === 'employment' ? EMPLOYMENT_FIELD_ENGINE : PAYROLL_FIELD_ENGINE) as Record<string, { status: string; scenarioField?: string }>;
    assert.equal(table[p.key]?.status, 'consumed', `${p.group}.${p.key}`);
    assert.equal(table[p.key]?.scenarioField, p.field, `${p.group}.${p.key}`);
  }
  assert.ok(!pairs.some((p) => p.key === 'hoursPerWeek'), 'contract hours per week is a hint, never a reason to skip the hours question');
});

test('R3-B narrow L1 subset: a night / evening / shift / irregular-hours allowance never fills another premium or the rate', async () => {
  const weekend = scenario({ work: { regularWeekdayHours: known(32), saturdayHours: known(8), sundayHours: known(6) }, pay: { hourlyRate: known(16.8) } });
  const cases: Array<[string, string, number]> = [
    ['dodatek nocny 50%', 'pay.saturdayPremiumPercent', 50],
    ['za nocki dostaję 25%', 'pay.saturdayPremiumPercent', 25],
    ['night allowance 25%', 'pay.saturdayPremiumPercent', 25],
    ['nachttoeslag 50%', 'pay.saturdayPremiumPercent', 50],
    ['ploegentoeslag 20%', 'pay.saturdayPremiumPercent', 20],
    ['dodatek wieczorny 15%', 'pay.saturdayPremiumPercent', 15],
  ];
  for (const [message, field, value] of cases) {
    const agent = scriptedAgent([out('provide_information', [{ op: 'set', field: field as never, value }])]);
    const r = await runConversationTurn({ scenario: weekend, message, locale: 'pl', conversation: { deferredFields: [] } }, { agent, rates: RATES_2026, trusted: null });
    assert.equal(agent.calls, 1, message);
    assert.equal(r.scenario.pay.saturdayPremiumPercent, undefined, `${message}: was written as the Saturday premium`);
    assert.deepEqual(r.patchNotes.map((n) => n.code), ['component_mismatch_withheld'], message);
    assert.equal(r.nextQuestion?.field, 'pay.saturdayPremiumPercent', `${message}: the Saturday question stays open`);
  }
  const rateAgent = scriptedAgent([out('provide_information', [{ op: 'set', field: 'pay.hourlyRate', value: 3 }])]);
  const noRate = await runConversationTurn({ scenario: scenario({ work: { regularWeekdayHours: known(40) } }), message: 'nocny dodatek 3 euro za godzinę', locale: 'pl', conversation: { deferredFields: [] } }, { agent: rateAgent, rates: RATES_2026, trusted: null });
  assert.equal(noRate.scenario.pay.hourlyRate, undefined, 'a night allowance per hour is not the base rate');
  // Unchanged: the bare answer to the Saturday question, and a Saturday value named next to a night one.
  const bare = await runConversationTurn({ scenario: weekend, message: '50%', locale: 'pl', conversation: { deferredFields: [] } }, { agent: null, rates: RATES_2026, trusted: null });
  assert.deepEqual(bare.scenario.pay.saturdayPremiumPercent, { state: 'known', value: 50, source: 'user' });
  const both = await runConversationTurn({ scenario: weekend, message: 'sobota 50%, a nocki 25%', locale: 'pl', conversation: { deferredFields: [] } }, { agent: scriptedAgent([out('provide_information', [{ op: 'set', field: 'pay.saturdayPremiumPercent', value: 50 }])]), rates: RATES_2026, trusted: null });
  assert.deepEqual(both.scenario.pay.saturdayPremiumPercent, { state: 'known', value: 50, source: 'user' });
});

test('R3-B.2 contract: by reference, the worker\'s questions are answered from the payslip and its rate is trusted - never asked', () => {
  const byRef = fixtures.profiles.payslip_week41_by_ref as { request: { documents: Array<Record<string, unknown>> }; response: { documentContext: { ref: string; knowledge: DocumentKnowledge } } };
  assert.ok(byRef.request.documents.every((d) => Array.isArray(d.batchRefs) && d.factBatches === undefined), 'only references are sent - never the batch JSON');
  assert.equal(byRef.response.documentContext.ref, R3B2_CONTEXT_REF);
  assert.deepEqual(byRef.response.documentContext.knowledge.facts.filter((f) => f.key === 'hourly_rate').map((f) => f.value), [15.55]);
  const records = fixtures.turns.r3b2_document_questions as TurnRecord[];
  assert.ok(records.every((r) => r.request.documentContextRef === R3B2_CONTEXT_REF));
  assert.deepEqual(records.map((r) => r.response.answerSource), ['document_facts', 'document_facts', 'document_facts', 'none', 'user_input']);
  assert.deepEqual(records[0]?.response.documentAnswer?.items.map((i) => [i.key, i.value]), [['hourly_rate', 15.55]]);
  assert.deepEqual(records[1]?.response.documentAnswer?.items.map((i) => [i.key, i.value]), [['payout', 584.92], ['net', 509.92], ['reimbursement', 75]]);
  assert.ok(!asked(records).includes('pay.hourlyRate'), 'the document rate is never asked');
  assert.equal(records[3]?.response.nextQuestion?.kind, 'clarify_hours_composition', '"Ile dostanę za 40 godzin?" clarifies the hours - it does not re-ask the rate');
  const final = records[records.length - 1] as TurnRecord;
  assert.deepEqual(final.response.scenario.pay.hourlyRate, { state: 'known', value: 15.55, source: 'document', ref: 'doc-1' });
  assert.deepEqual(final.response.scenario.work.regularWeekdayHours, { state: 'known', value: 40, source: 'user' });
  assertNoAmount(records);
  const en = fixtures.turns.r3b2_document_questions_en as TurnRecord[];
  assert.deepEqual(en.map((r) => r.response.documentAnswer?.items.map((i) => [i.key, i.value])), [[['hourly_rate', 15.55]], [['regular_hours', 36]]]);
});
