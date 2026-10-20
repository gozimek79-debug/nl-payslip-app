import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dotDecimal, numbersInRaw, rawSupportsNumber, PAYSLIP_FACTS_PROMPT, PAYSLIP_FACTS_SCHEMA } from '../ocr-service/fact-extraction.js';
import { mergeContractBatches, mergePayslipBatches } from '../payroll-engine/document-facts.js';
import { agentDocumentDigest, answerFacts, buildDocumentKnowledge, type DocumentKnowledge } from '../document-context/knowledge.js';
import { documentQuestionTopics } from '../document-context/document-questions.js';
import { trustedContextFromProfile, type TrustedContext } from './trusted-context.js';
import { runConversationTurn } from './conversation-turn.js';
import { createGroqConversationAgent } from './conversation-agent.js';
import { RATES_2026, known, ok, out, scenario, scriptedAgent } from '../test-support/conversation-fixtures.js';
import { absent, contractBatch, found, hourLine, rawContract } from '../test-support/fact-fixtures.js';
import { INSTRUCTION_TEXT } from '../test-support/r3b-fixtures.js';
import { LINE_ADV, LINE_REGULAR, profileOf, week41Batch, week41Document } from '../test-support/r3b2-fixtures.js';
import type { ProfileDocumentInput } from '../payroll-engine/payroll-profile.js';

/**
 * R3-B.2 (ZADANIE-LOONTO-R3-B2-FIX-GEMINI-TO-CONVERSATION-PIPELINE.md): the vertical slice
 *   Gemini reading -> document facts -> Payroll Profile -> server-held Document Knowledge + TrustedContext -> turn.
 * Synthetic week-41 payslip only (test-support/r3b2-fixtures.ts); the reader output goes through the REAL mapping, the
 * model is scripted or a recording completer - no network, no paid call, no real document.
 */

const Q = {
  rate: 'Jaka jest moja stawka?',
  hours: 'Ile godzin mi zapłacono?',
  payout: 'Ile faktycznie przelano?',
  whyNet: 'Dlaczego netto jest niższe?',
  summary: 'Co jest na tym dokumencie?',
};

const ADV_LINE = () => hourLine({ description: 'ADV toeslag', kind: 'adv_compensation', adds_hours: 'no', hours: 36, rate: 15.55, percent: 1.54, amount: 8.62, raw: LINE_ADV });

function contractDocument(rate: number, index = 1): ProfileDocumentInput {
  const printed = `Uurloon: € ${rate.toFixed(2).replace('.', ',')}`;
  return { index, documentId: `r3b2-contract-${index}`, label: 'contract', role: 'contract_base', effectiveDate: null, facts: mergeContractBatches([contractBatch(rawContract({ hourly_rate: found(rate, printed, 1, 'Uurloon') }))]) };
}

function documentContext(documents: ProfileDocumentInput[] = [week41Document()]): { trusted: TrustedContext; knowledge: DocumentKnowledge } {
  const profile = profileOf(documents);
  return { trusted: trustedContextFromProfile(profile), knowledge: buildDocumentKnowledge(documents, profile) };
}

type Answered = { documentAnswer: { available: boolean; topics: string[]; items: Array<{ key: string; value: unknown; status: string }> } | null };
const items = (r: Answered) => r.documentAnswer?.items.map((i) => [i.key, i.value]);

async function ask(message: string, locale: 'pl' | 'en' = 'pl', ctx = documentContext()) {
  const agent = scriptedAgent([]);
  const r = await runConversationTurn({ message, locale, conversation: { deferredFields: [] } }, { agent, rates: RATES_2026, trusted: ctx.trusted, documentKnowledge: ctx.knowledge });
  return { r, agent };
}

// ---------------------------------------------------------------------------------------------
// 1. Extraction: one Gemini read captures the header rate and the dot-decimal wage lines
// ---------------------------------------------------------------------------------------------

test('R3-B.2 root cause: dot-decimal wage lines are now supported by their raw text (they were all "raw_value_mismatch")', () => {
  assert.deepEqual(numbersInRaw(LINE_REGULAR), [41, 36, 15.55, 559.8]);
  assert.deepEqual(numbersInRaw(LINE_ADV), [1.54, 36, 15.55, 8.62]);
  for (const v of [36, 15.55, 559.8]) assert.ok(rawSupportsNumber(LINE_REGULAR, v), `${v} is printed on the regular line`);
});

test('R3-B.2: dot decimals are accepted narrowly - Dutch thousands and comma decimals keep their meaning, nothing else loosens', () => {
  assert.equal(dotDecimal('15.55'), 15.55);
  assert.equal(dotDecimal('-8.62'), 8.62);
  assert.equal(dotDecimal('1.555'), null, 'three digits after the dot is a Dutch thousands separator, never 1.555');
  assert.equal(dotDecimal('1.234.56'), null);
  assert.equal(dotDecimal('15'), null);
  assert.deepEqual(numbersInRaw('Brutoloon 1.555'), [], 'a bare three-digit group stays unreadable, as before - never claimed as a decimal');
  assert.ok(rawSupportsNumber('Brutoloon 1.555,00', 1555), 'Dutch thousands separator unchanged');
  assert.ok(!rawSupportsNumber('Brutoloon 1.555,00', 1.555));
  assert.ok(rawSupportsNumber('Uurloon: € 15,55', 15.55), 'comma decimals unchanged');
  assert.ok(!rawSupportsNumber('Uurloon 15.55', 1555), 'a dot-decimal is never re-read as thousands');
  assert.ok(!rawSupportsNumber('Uurloon 15.55', 15.5), 'no rounding tolerance');
});

test('R3-B.2: the ONE payslip read asks for the printed header rate; regular wording and ADV are named; the schema carries hourly_rate', () => {
  assert.match(PAYSLIP_FACTS_PROMPT, /hourly_rate: the gross BASE hourly wage printed as its own field/);
  assert.match(PAYSLIP_FACTS_PROMPT, /"Uurloon"/);
  assert.match(PAYSLIP_FACTS_PROMPT, /Never take it from an ADV, surcharge, overtime or holiday line/);
  assert.match(PAYSLIP_FACTS_PROMPT, /"Loon normaal"/);
  assert.match(PAYSLIP_FACTS_PROMPT, /"adv_compensation" \(ADV \/ ADV\s+toeslag/);
  assert.match(JSON.stringify(PAYSLIP_FACTS_SCHEMA), /"hourly_rate"/);
});

test('R3-B.2: the synthetic week-41 payslip maps every printed fact - header rate, regular line, separate ADV, net, reimbursement, payout', () => {
  const batch = week41Batch();
  const rate = batch.scalars.hourlyRate?.[0];
  assert.deepEqual([rate?.status, rate?.value, rate?.unit, rate?.evidence.printedLabel, rate?.evidence.rawValue], ['exact', 15.55, 'eur_per_hour', 'Uurloon', 'Uurloon: 15.55']);
  assert.deepEqual(batch.hourLines.map((l) => [l.kind, l.hours, l.rate, l.percent, l.amount]), [['regular', 36, 15.55, null, 559.8], ['adv_compensation', 36, 15.55, 1.54, 8.62]]);
  assert.deepEqual([batch.scalars.printedNet[0]?.value, batch.scalars.printedPayout[0]?.value], [509.92, 584.92]);
  assert.deepEqual(batch.netLines.map((l) => [l.category, l.amount]), [['reimbursement', 75]]);
  assert.deepEqual([batch.scalars.periodLabel[0]?.value, batch.scalars.periodType[0]?.value], ['week 41/2026', 'week']);
});

test('R3-B.2: a header rate that is absent, implausible or not printed as read is never invented', () => {
  assert.deepEqual(week41Batch({ hourly_rate: absent }).scalars.hourlyRate, [], 'not printed -> no fact at all');
  const implausible = week41Batch({ hourly_rate: found(250, 'Uurloon: 250.00', 1, 'Uurloon') }).scalars.hourlyRate?.[0];
  assert.deepEqual([implausible?.status, implausible?.value, implausible?.reason], ['implausible', null, 'exceeds_plausible_hourly_rate']);
  const misread = week41Batch({ hourly_rate: found(15.85, 'Uurloon: 15.55', 1, 'Uurloon') }).scalars.hourlyRate?.[0];
  assert.deepEqual([misread?.status, misread?.value, misread?.reason], ['ambiguous', null, 'raw_value_mismatch']);
});

test('R3-B.2: older batches without the new header-rate key still merge (backward compatible)', () => {
  const batch = week41Batch();
  const { hourlyRate: _new, ...olderScalars } = batch.scalars;
  const merged = mergePayslipBatches([{ ...batch, scalars: olderScalars as typeof batch.scalars }]);
  assert.equal(merged.hourLines[0]?.rate, 15.55);
});

// ---------------------------------------------------------------------------------------------
// 2. Payroll Profile: header + regular line = one document; ADV is never the base rate
// ---------------------------------------------------------------------------------------------

test('R3-B.2: header 15.55 and the regular line 15.55 on ONE payslip resolve to 15.55 from one document (no self-corroboration)', () => {
  const rate = profileOf([week41Document()]).employment.hourlyRate;
  assert.deepEqual([rate.state, rate.value], ['document_exact', 15.55]);
  assert.deepEqual([...new Set(rate.candidates.map((c) => c.source.documentIndex))], [0], 'both readings come from the same document');
  assert.deepEqual(rate.candidates.map((c) => c.source.printedLabel).sort(), ['Loon normaal', 'Uurloon']);
});

test('R3-B.2: a header rate that differs from the regular line on the same payslip is a CONFLICT, never a silent pick', () => {
  const rate = profileOf([week41Document({ hourly_rate: found(16.2, 'Uurloon: 16.20', 1, 'Uurloon') })]).employment.hourlyRate;
  assert.deepEqual([rate.state, rate.value], ['conflict', null]);
  assert.deepEqual(rate.candidates.map((c) => c.value).sort(), [15.55, 16.2]);
});

test('R3-B.2: ADV alone never becomes the base rate; the printed header alone is enough', () => {
  const adv = profileOf([week41Document({ hourly_rate: absent, hour_lines: [ADV_LINE()] })]).employment.hourlyRate;
  assert.deepEqual([adv.state, adv.value], ['unknown', null]);
  const header = profileOf([week41Document({ hour_lines: [ADV_LINE()] })]).employment.hourlyRate;
  assert.deepEqual([header.state, header.value, header.candidates.map((c) => c.source.printedLabel)], ['document_exact', 15.55, ['Uurloon']]);
});

test('R3-B.2: a contract at the same rate corroborates across documents; at a different rate it is a conflict', () => {
  const same = profileOf([week41Document(), contractDocument(15.55)]).employment.hourlyRate;
  assert.deepEqual([same.state, same.value], ['corroborated', 15.55]);
  const different = profileOf([week41Document(), contractDocument(16.2)]).employment.hourlyRate;
  assert.equal(different.state, 'conflict');
});

// ---------------------------------------------------------------------------------------------
// 3. Document Knowledge: printed readings only, no identity, conflicts kept
// ---------------------------------------------------------------------------------------------

test('R3-B.2: Document Knowledge lists the printed facts (one rate reading per document) and nothing identifying', () => {
  const { knowledge } = documentContext();
  const byKey = (key: string) => knowledge.facts.filter((f) => f.key === key).map((f) => f.value);
  assert.deepEqual(byKey('hourly_rate'), [15.55], 'header and line are ONE reading of one document');
  assert.deepEqual(knowledge.facts.filter((f) => f.key === 'hourly_rate').map((f) => f.label), ['Uurloon / Loon normaal'], 'both printed places are named');
  assert.deepEqual(byKey('regular_hours'), [36], 'ADV hours are not paid hours');
  assert.deepEqual(byKey('surcharge_percent'), [1.54]);
  assert.deepEqual(byKey('wage_line_amount'), [559.8, 8.62]);
  assert.deepEqual([byKey('net'), byKey('payout'), byKey('reimbursement')], [[509.92], [584.92], [75]]);
  assert.deepEqual(byKey('period_label'), ['week 41/2026']);
  assert.ok(knowledge.facts.every((f) => f.status === 'document_reading'));
  const json = JSON.stringify(knowledge);
  for (const forbidden of ['Synthetic Uitzend', 'Werkgever', LINE_REGULAR, 'rawValue', 'evidence']) assert.ok(!json.includes(forbidden), `knowledge must not carry ${forbidden}`);
});

test('R3-B.2: a rate conflict is shown as a conflict with each printed value - never one silently chosen', () => {
  const { knowledge, trusted } = documentContext([week41Document({ hourly_rate: found(16.2, 'Uurloon: 16.20', 1, 'Uurloon') })]);
  const rates = knowledge.facts.filter((f) => f.key === 'hourly_rate');
  assert.deepEqual(rates.map((f) => [f.value, f.status]).sort(), [[15.55, 'conflict'], [16.2, 'conflict']]);
  assert.equal(trusted.facts.find((f) => f.field === 'pay.hourlyRate')?.node.state, 'conflict');
});

// ---------------------------------------------------------------------------------------------
// 4. Grounded conversation: the worker's questions are answered from the document
// ---------------------------------------------------------------------------------------------

test('R3-B.2: "Jaka jest moja stawka?" - answered from the document (15.55), no model call, nothing written, rate not asked', async () => {
  const { r, agent } = await ask(Q.rate);
  assert.equal(agent.calls, 0);
  assert.deepEqual([r.intent, r.answerSource, r.responseHint?.code], ['document_question', 'document_facts', 'document_answer']);
  assert.deepEqual(r.documentAnswer?.topics, ['hourly_rate']);
  assert.deepEqual(items(r), [['hourly_rate', 15.55]]);
  assert.equal(r.patchApplied, null);
  assert.deepEqual(r.scenario.pay.hourlyRate, { state: 'known', value: 15.55, source: 'document', ref: 'r3b2-slip-41' });
  assert.notEqual(r.nextQuestion?.field, 'pay.hourlyRate', 'the rate is known from the document - never asked again');
  assert.equal(r.nextQuestion?.field, 'work.hours', 'the conversation simply continues');
});

test('R3-B.2: hours, payout, "why is net lower" and "what is on it" are answered from printed facts only', async () => {
  assert.deepEqual(items((await ask(Q.hours)).r), [['regular_hours', 36]]);
  assert.deepEqual(items((await ask(Q.payout)).r), [['payout', 584.92], ['net', 509.92], ['reimbursement', 75]]);
  const why = (await ask(Q.whyNet)).r;
  assert.deepEqual(why.documentAnswer?.topics, ['deductions', 'net']);
  assert.deepEqual(items(why), [['wage_line_amount', 559.8], ['surcharge_percent', 1.54], ['wage_line_amount', 8.62], ['net', 509.92]], 'printed readings side by side - no computed difference, no invented deduction');
  const summary = (await ask(Q.summary)).r;
  assert.deepEqual(items(summary), [['hourly_rate', 15.55], ['period_label', 'week 41/2026'], ['regular_hours', 36], ['net', 509.92], ['payout', 584.92], ['reimbursement', 75]]);
  for (const r of [why, summary]) assert.equal(r.answerSource, 'document_facts');
});

test('R3-B.2: English questions work the same way', async () => {
  assert.deepEqual(items((await ask('What is my hourly rate?', 'en')).r), [['hourly_rate', 15.55]]);
  assert.deepEqual(items((await ask('How many hours was I paid?', 'en')).r), [['regular_hours', 36]]);
  assert.deepEqual(items((await ask('How much was actually transferred?', 'en')).r), [['payout', 584.92], ['net', 509.92], ['reimbursement', 75]]);
});

test('R3-B.2: without a document context a document question says so (available: false) - nothing invented, nothing written', async () => {
  const agent = scriptedAgent([]);
  const r = await runConversationTurn({ message: Q.rate, locale: 'pl' }, { agent, rates: RATES_2026, trusted: null });
  assert.deepEqual(r.documentAnswer, { available: false, topics: ['hourly_rate'], items: [] });
  assert.equal(agent.calls, 0);
  assert.equal(r.scenario.pay.hourlyRate, undefined);
  assert.equal(r.nextQuestion?.field, 'work.hours');
});

test('R3-B.2: the question recogniser is narrow - statements, numbers and calculation requests are NOT document questions', () => {
  for (const message of ['Moja stawka to 15,55', 'Ile dostanę za 40 godzin?', 'Ile dostanę?', 'Ile to będzie netto?', 'How much will I get?', 'Tak', 'Nie wiem', '40 godzin w tygodniu', 'x'.repeat(301) + '?']) {
    assert.deepEqual(documentQuestionTopics(message), [], message.slice(0, 40));
  }
  assert.deepEqual(documentQuestionTopics('Co jest na pasku?'), ['summary']);
  assert.deepEqual(documentQuestionTopics('Ile zwrotu za dojazd?'), ['reimbursement']);
});

test('R3-B.2: "Ile dostanę za 40 godzin?" never re-asks the document rate; the calculation stays gated behind R1 readiness', async () => {
  const { trusted, knowledge } = documentContext();
  const agent = scriptedAgent([ok({ intent: 'calculation_request', patch: { version: 1, ops: [] }, statedWeeklyHours: 40, hint: 'ambiguous_hours' })]);
  const r = await runConversationTurn({ message: 'Ile dostanę za 40 godzin?', locale: 'pl', conversation: { deferredFields: [] } }, { agent, rates: RATES_2026, trusted, documentKnowledge: knowledge });
  assert.equal(agent.calls, 1);
  assert.equal(agent.inputs[0]?.currentQuestion?.field, 'work.hours', 'the model is never told to ask for the rate');
  assert.deepEqual(agent.inputs[0]?.scenario.find((s) => s.field === 'pay.hourlyRate'), { field: 'pay.hourlyRate', state: 'known', value: 15.55, source: 'document' });
  assert.equal(r.intent, 'calculation_request');
  assert.notEqual(r.nextQuestion?.field, 'pay.hourlyRate');
  assert.deepEqual(r.scenario.pay.hourlyRate, { state: 'known', value: 15.55, source: 'document', ref: 'r3b2-slip-41' });
  assert.equal(r.scenario.work.regularWeekdayHours, undefined, '"40 godzin" alone is not written as weekday hours (M1) - it is clarified');
  assert.notEqual(r.evaluation?.status, 'computed', 'no payout while required inputs are open');
  assert.equal(r.documentAnswer, null);
});

test('R3-B.2: an unsupported allowance no longer dead-ends the conversation - the calculable inputs are still asked', async () => {
  const { trusted, knowledge } = documentContext();
  const agent = scriptedAgent([out('unsupported_concept', [{ op: 'request_concept', concept: 'night_premium' }])]);
  const r = await runConversationTurn({ message: 'Dostaję też dodatek nocny', locale: 'pl', conversation: { deferredFields: [] } }, { agent, rates: RATES_2026, trusted, documentKnowledge: knowledge });
  assert.equal(r.evaluation?.status, 'unsupported', 'the evaluation stays honest - nothing calculated');
  assert.deepEqual(r.scenario.requestedConcepts, [{ concept: 'night_premium', source: 'user' }]);
  assert.equal(r.nextQuestion?.field, 'work.hours', 'before R3-B.2 this was null: the conversation ended');
  assert.deepEqual(r.responseHint, { code: 'unsupported_concept', params: { concept: 'night_premium' } });
});

// ---------------------------------------------------------------------------------------------
// 5. What the model sees, and what it can never do with it
// ---------------------------------------------------------------------------------------------

test('R3-B.2: the Groq request carries a typed digest of printed facts - no labels, raw text, names, ids, pages or injected text', async () => {
  const injected = week41Document({
    hour_lines: [
      hourLine({ description: 'Loon normaal', kind: 'regular', hours: 36, rate: 15.55, amount: 559.8, raw: LINE_REGULAR }),
      hourLine({ description: INSTRUCTION_TEXT, kind: 'other', adds_hours: 'no', hours: null, rate: null, amount: 12.5, raw: `${INSTRUCTION_TEXT} 12.50` }),
    ],
  });
  const { trusted, knowledge } = documentContext([injected]);
  assert.ok(knowledge.facts.some((f) => f.label?.startsWith('IGNORE PREVIOUS')), 'the printed text is kept as a label for the user\'s own view only');
  const sent: string[] = [];
  const agent = createGroqConversationAgent({
    complete: async ({ user }) => {
      sent.push(user);
      // A hostile/confused model obeys the injected text: rate 99.
      return JSON.stringify({ intent: 'provide_information', patch: { version: 1, ops: [{ op: 'set', field: 'pay.hourlyRate', value: 99 }] } });
    },
  });
  const r = await runConversationTurn({ message: 'hmm a ten dodatek', locale: 'pl', conversation: { deferredFields: [] } }, { agent, rates: RATES_2026, trusted, documentKnowledge: knowledge });
  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0] ?? '{}') as { documentFacts?: Array<Record<string, unknown>> };
  assert.ok(payload.documentFacts?.some((f) => f.key === 'hourly_rate' && f.value === 15.55));
  for (const fact of payload.documentFacts ?? []) assert.deepEqual(Object.keys(fact).sort(), ['key', 'status', 'topic', 'unit', 'value']);
  for (const forbidden of ['IGNORE', 'Synthetic', 'Uurloon', 'Loon normaal', 'W 41', 'r3b2-slip-41', 'payslip-41', 'week 41/2026', '"page"', 'documentId', 'label']) {
    assert.ok(!(sent[0] ?? '').includes(forbidden), `the model request must not contain ${forbidden}`);
  }
  assert.deepEqual(r.scenario.pay.hourlyRate, { state: 'known', value: 15.55, source: 'document', ref: 'r3b2-slip-41' }, 'the injected 99 is withheld - the user never said it');
  assert.ok(r.patchNotes.some((n) => n.code === 'value_not_stated_withheld'));
});

test('R3-B.2: a model can classify a document question, but cannot write anything with it', async () => {
  const { trusted, knowledge } = documentContext();
  const asks = scriptedAgent([ok({ intent: 'document_question', patch: { version: 1, ops: [] }, documentTopics: ['payout'] })]);
  const r = await runConversationTurn({ message: 'kasa która wpłynęła', locale: 'pl', conversation: { deferredFields: [] } }, { agent: asks, rates: RATES_2026, trusted, documentKnowledge: knowledge });
  assert.deepEqual([r.intent, r.answerSource], ['document_question', 'document_facts']);
  assert.deepEqual(items(r), [['payout', 584.92], ['net', 509.92], ['reimbursement', 75]]);

  const writes = scriptedAgent([ok({ intent: 'document_question', patch: { version: 1, ops: [{ op: 'set', field: 'work.regularWeekdayHours', value: 36 }] }, documentTopics: ['hours'] })]);
  const w = await runConversationTurn({ message: 'kasa która wpłynęła', locale: 'pl', conversation: { deferredFields: [] } }, { agent: writes, rates: RATES_2026, trusted, documentKnowledge: knowledge });
  assert.deepEqual([w.agentStatus, w.intent, w.documentAnswer, w.scenario.work.regularWeekdayHours], ['invalid_output', 'unclear', null, undefined], 'a document question that mutates is not trusted');
});

test('R3-B.2: the agent digest is bounded and typed', () => {
  const { knowledge } = documentContext();
  const digest = agentDocumentDigest(knowledge);
  assert.ok(digest.length <= 40);
  assert.ok(digest.every((f) => typeof f.value === 'number' || f.unit === 'date' || f.unit === 'period_type'), 'no free text');
  assert.deepEqual(answerFacts(null, ['summary']), []);
});

test('R3-B.2: a self-declared document source is still rejected when no server-held context backs it (RT-001 unchanged)', async () => {
  const forged = scenario({ pay: { hourlyRate: known(15.55, 'document', 'r3b2-slip-41') } });
  const r = await runConversationTurn({ scenario: forged, message: Q.rate, locale: 'pl' }, { agent: scriptedAgent([]), rates: RATES_2026, trusted: null });
  assert.equal(r.status, 'rejected');
  assert.deepEqual(r.patchIssues.map((i) => i.code), ['untrusted_provenance_in_scenario']);
  assert.equal(r.documentAnswer, null);
  // ...and a context for ANOTHER value does not back it either.
  const other = documentContext([week41Document({ hourly_rate: found(16.2, 'Uurloon: 16.20', 1, 'Uurloon'), hour_lines: [hourLine({ description: 'Loon normaal', kind: 'regular', hours: 36, rate: 16.2, amount: 583.2, raw: 'W 41 Loon normaal 36.00 x 16.20 583.20' })] })]);
  const r2 = await runConversationTurn({ scenario: forged, message: Q.rate, locale: 'pl' }, { agent: scriptedAgent([]), rates: RATES_2026, trusted: other.trusted, documentKnowledge: other.knowledge });
  assert.equal(r2.status, 'rejected');
});
