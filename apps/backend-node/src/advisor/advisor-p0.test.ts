import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statedInDialogue, statementsIn, type DialogueTurn } from './hours-statements.js';
import { checkClaims, claimsUsed, rewriteInstruction, type ClaimIssueCode, type ClaimSource } from './claim-check.js';
import { claimSourcesFromKnowledge, claimSourcesFromTool, executeTool } from './advisor-tools.js';
import { capabilitiesForModel } from './capabilities.js';
import { ADVISOR_SYSTEM_PROMPT } from './advisor-prompt.js';
import { runAdvisorTurn } from './advisor-turn.js';
import { advisorBudget } from './advisor-config.js';
import { callTools, payslipDocument, recordedModel, say, toolContext } from '../test-support/advisor-fixtures.js';
import { week41Batch } from '../test-support/r3b2-fixtures.js';
import { buildDocumentKnowledge } from '../document-context/knowledge.js';
import { resolvePayrollProfile } from '../payroll-engine/payroll-profile.js';

/**
 * AI-001 CTO gate P0-1 / P0-2 / P0-3 (LOONTO-AI001-CTO-GATE-REVIEW.md). Deterministic: the statement parser, the
 * orientation tool's provenance, the financial-claim check and the knowledge boundary, plus the turn with a RECORDED
 * model. These prove the server-side controls - not the real model's conversational quality.
 */

const user = (...texts: string[]): DialogueTurn[] => texts.map((text) => ({ role: 'user', text }));
const week41 = () => [payslipDocument([week41Batch()])];
const orientation = (dialogue: DialogueTurn[], args: Record<string, unknown>) =>
  executeTool('calculate_base_wage_orientation', JSON.stringify(args), toolContext({ dialogue, documents: week41() })).result as Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// P0-1 - days and hours as the user stated them
// ---------------------------------------------------------------------------------------------

test('P0-1 statements: days, hours per day and weekly totals are read separately - never derived from one another', () => {
  const cases: Array<[string, { days: number[]; perDay: number[]; totals: number[] }]> = [
    ['Pracuję 7 dni w tygodniu, 56 godzin.', { days: [7], perDay: [], totals: [56] }],
    ['Od poniedziałku do niedzieli po 8 h', { days: [7], perDay: [8], totals: [] }],
    ['pon–pt po 8 godzin', { days: [5], perDay: [8], totals: [] }],
    ['Monday to Sunday, 8 hours a day', { days: [7], perDay: [8], totals: [] }],
    ['I work every day of the seven-day week, 8h per day', { days: [7], perDay: [8], totals: [] }],
    ['siedem dni po 8 godzin', { days: [7], perDay: [8], totals: [] }],
    ['8 godzin dziennie', { days: [], perDay: [8], totals: [] }],
    ['codziennie po 8 h', { days: [], perDay: [8], totals: [] }],
    ['codziennie, także w weekend, po 8 h', { days: [7], perDay: [8], totals: [] }],
    ['56 godzin tygodniowo', { days: [], perDay: [], totals: [56] }],
    ['W sobotę 10, w niedzielę 6, reszta w tygodniu', { days: [], perDay: [], totals: [] }],
    ['stawka 15,55 €, pracuję 5 dni', { days: [5], perDay: [], totals: [] }],
    ['Zacząłem 3 dni temu, 40 h', { days: [], perDay: [], totals: [40] }],
    ['6-dniowy tydzień, 48 h', { days: [6], perDay: [], totals: [48] }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(statementsIn(text), expected, text);
});

test('P0-1 orientation: a day count must be stated - "8 h a day" never becomes 8 x 7', () => {
  const refused = (dialogue: DialogueTurn[], args: Record<string, unknown>) => orientation(dialogue, args).reason;
  assert.equal(refused(user('Pracuję 8 godzin dziennie. Ile dostanę?'), { per_day_hours: 8, days: 7 }), 'days_not_stated_by_user');
  assert.equal(refused(user('I work 8 hours a day, how much is that?'), { per_day_hours: 8, days: 5 }), 'days_not_stated_by_user', 'not 5 either');
  assert.equal(refused(user('Pracuję codziennie po 8 h'), { per_day_hours: 8, days: 7 }), 'days_not_stated_by_user', 'a bare "codziennie" does not say the weekend is included');
  assert.equal(refused(user('Pracuję 8 h dziennie, 5 dni w tygodniu'), { per_day_hours: 8, days: 7 }), 'days_not_stated_by_user', 'the stated 5 is not 7');
  assert.equal(refused(user('Moja stawka to 8 euro, pracuję 5 dni'), { per_day_hours: 8, days: 5 }), 'per_day_hours_not_stated_by_user', 'a rate of 8 is not 8 hours a day');
});

test('P0-1 orientation: "7 days, 56 hours" stays a TOTAL - it is not 8 hours on each day', () => {
  const dialogue = user('Pracuję 7 dni w tygodniu, 56 godzin. Ile dostanę?');
  assert.equal(orientation(dialogue, { per_day_hours: 8, days: 7 }).reason, 'per_day_hours_not_stated_by_user');
  const total = orientation(dialogue, { hours_total: 56 });
  assert.deepEqual([total.ok, total.hours, total.amount, total.hours_basis], [true, 56, 870.8, 'total_stated_by_user']);
  assert.equal(orientation(user('56 godzin tygodniowo'), { per_day_hours: 8, days: 7 }).reason, 'per_day_hours_not_stated_by_user', 'no fabricated schedule');
});

test('P0-1 orientation: stated schedules still work (Monday to Sunday, seven-day week, PL and EN)', () => {
  for (const text of ['Od poniedziałku do niedzieli po 8 h', 'Monday to Sunday, 8 hours a day', 'every day of the seven-day week, 8 hours a day', 'Pracuję 7 dni w tygodniu po 8 godzin']) {
    const r = orientation(user(text), { per_day_hours: 8, days: 7 });
    assert.deepEqual([r.ok, r.hours, r.amount, r.hours_basis], [true, 56, 870.8, 'per_day_8_x_7_days'], text);
  }
  const weekdays = orientation(user('pon-pt po 8 h'), { per_day_hours: 8, days: 5 });
  assert.deepEqual([weekdays.ok, weekdays.amount], [true, 622]);
});

test('P0-1 confirmation: a "tak" grounds the ONE day count the advisor asked about; a bare number answers its question', () => {
  const asked = (question: string, answer: string): DialogueTurn[] => [{ role: 'user', text: 'Pracuję 8 godzin dziennie.' }, { role: 'assistant', text: question }, { role: 'user', text: answer }];
  const confirmed = orientation(asked('Czy pracujesz 7 dni w tygodniu, także w sobotę i niedzielę?', 'tak'), { per_day_hours: 8, days: 7 });
  assert.deepEqual([confirmed.ok, confirmed.amount], [true, 870.8]);
  assert.equal(orientation(asked('Od poniedziałku do piątku czy przez 7 dni?', 'tak'), { per_day_hours: 8, days: 7 }).reason, 'days_not_stated_by_user', 'two options named - "tak" confirms neither');
  const six = orientation(asked('Ile dni w tygodniu pracujesz?', '6'), { per_day_hours: 8, days: 6 });
  assert.deepEqual([six.ok, six.hours], [true, 48]);
  assert.deepEqual(statedInDialogue([{ role: 'assistant', text: 'Ile godzin w tygodniu pracujesz?' }, { role: 'user', text: '5' }]), { days: [], perDay: [], totals: [5] }, 'an hours question is not a days question');
  assert.deepEqual(statedInDialogue([{ role: 'assistant', text: 'Pracujesz 7 dni?' }, { role: 'user', text: 'tak, ale nie wiem ile godzin' }]).days, [], 'only a plain "tak" confirms');
});

// ---------------------------------------------------------------------------------------------
// P0-2 - every amount described as what it is
// ---------------------------------------------------------------------------------------------

const ORIENTATION: ClaimSource = { value: 870.8, kind: 'indicative_base_wage_only' };
const RATE: ClaimSource = { value: 15.55, kind: 'document_reading', topic: 'hourly_rate', key: 'hourly_rate' };
const PAYOUT: ClaimSource = { value: 584.92, kind: 'document_reading', topic: 'payout', key: 'payout', period: 'week 41/2026' };
const NET: ClaimSource = { value: 509.92, kind: 'document_reading', topic: 'net', key: 'net', period: 'week 41/2026' };
const GROSS: ClaimSource = { value: 622, kind: 'document_reading', topic: 'gross', key: 'gross_total' };
const NIGHT: ClaimSource = { value: 15.8, kind: 'document_reading', topic: 'gross', key: 'wage_line_amount', component: 'night_premium' };
const SOURCES = [ORIENTATION, RATE, PAYOUT, NET, GROSS, NIGHT];
const codes = (text: string, sources: ClaimSource[] = SOURCES, percents: number[] = []): ClaimIssueCode[] => [...new Set(checkClaims(text, sources, percents).map((i) => i.code))].sort();

test('P0-2: the orientation is never net, gross, payout, a premium or verified - and never "your pay" without being called an orientation', () => {
  assert.deepEqual(codes('56 h × 15,55 €/h = 870,80 € netto.'), ['orientation_mislabelled']);
  assert.deepEqual(codes('Na rękę dostaniesz 870,80 €.'), ['orientation_mislabelled', 'orientation_presented_as_pay']);
  assert.deepEqual(codes('Za 56 godzin zarobisz 870,80 €.'), ['orientation_presented_as_pay']);
  assert.deepEqual(codes('To zweryfikowana kwota brutto: 870,80 €.'), ['amount_described_as_verified', 'orientation_mislabelled']);
  assert.deepEqual(codes('You will take home 870.80 EUR net.'), ['orientation_mislabelled', 'orientation_presented_as_pay']);
  assert.deepEqual(codes('Twoja wypłata: 870,80 €.'), ['orientation_mislabelled']);
});

test('P0-2: the orientation described as an orientation passes - negations, exclusions and "plus premiums" included', () => {
  for (const ok of [
    'Orientacyjnie: 56 h × 15,55 €/h = 870,80 € — sama stawka podstawowa, bez dodatków, podatku i potrąceń; to nie jest kwota netto ani brutto.',
    'Za 56 godzin dostaniesz orientacyjnie 870,80 € (stawka podstawowa × godziny), ale to nie jest wypłata netto.',
    'At the base rate alone, 56 hours come to about €870.80 - an orientation, not your net pay.',
    '870,80 € plus dodatki za weekend, których jeszcze nie znam.',
    'Stawka podstawowa razy godziny daje 870,80 €. Nie obejmuje to dodatków, podatku ani potrąceń.',
    'Netto nie umiem jeszcze policzyć; 870,80 € to tylko orientacja: stawka podstawowa × godziny.',
    'Orientacyjnie wychodzi 870,80 € (56 h × 15,55 €/h). Netto będzie niższe, ale jego jeszcze nie liczę.',
    'Based on your rate of €15.55, 56 hours give an indicative base wage of €870.80 — before any weekend premiums, holiday pay, tax or deductions.',
  ]) assert.deepEqual(codes(ok), [], ok);
});

test('P0-2: a past document figure is never a forecast, never relabelled, never a premium it is not', () => {
  assert.deepEqual(codes('Za 56 godzin w przyszłym tygodniu dostaniesz około 584,92 € netto.'), ['document_amount_as_forecast']);
  assert.deepEqual(codes('Brutto wyniosło 584,92 €.'), ['document_amount_mislabelled']);
  assert.deepEqual(codes('Netto to 622,00 €.'), ['document_amount_mislabelled']);
  assert.deepEqual(codes('Dodatek za sobotę to 15,55 €.'), ['premium_without_source'], 'the hourly rate is not a Saturday premium');
  for (const ok of [
    'Na pasku z tygodnia 41 przelano 584,92 € na konto.',
    'Za 4 godziny w nocy na Twoim pasku jest dodatek nocny 15,80 €.',
    'Brutto 622,00 €, netto 509,92 € — tak wydrukowano na pasku.',
    'Przy stawce 15,55 €/h za 56 godzin dostaniesz orientacyjnie 870,80 €.',
    'W week 41/2026 wypłacono 584,92 €.',
  ]) assert.deepEqual(codes(ok), [], ok);
});

test('P0-2: user amounts are not turned into a net forecast; premium percentages need a source', () => {
  const typed: ClaimSource[] = [{ value: 600, kind: 'user_stated' }];
  assert.deepEqual(codes('Dostaniesz 600,00 € netto.', typed), ['net_forecast']);
  assert.deepEqual(codes('Podałeś 600,00 € netto — tego nie sprawdzę bez paska.', typed), []);
  assert.deepEqual(codes('W soboty zwykle obowiązuje dodatek 50%.'), ['premium_percent_without_source']);
  assert.deepEqual(codes('150% może oznaczać 150% łącznie albo 50% dodatku do stawki — który przypadek Cię dotyczy?', SOURCES, [150]), [], '"150%" read both ways from the user\'s own number');
  assert.deepEqual(codes('Na pasku nocny dodatek ma 25%.', SOURCES, [25]), [], 'a percentage printed on the document');
  assert.deepEqual(codes('Netto wyjdzie około 620,00 €.'), ['ungrounded_amount']);
});

test('P0-2: later turns keep the kind - an orientation shown earlier is still an orientation', () => {
  const used = claimsUsed('Orientacyjnie 56 h × 15,55 €/h = 870,80 €.', SOURCES);
  assert.ok(used.some((s) => s.kind === 'indicative_base_wage_only' && s.value === 870.8));
  assert.deepEqual(codes('870,80 € to Twoja kwota netto.', used), ['orientation_mislabelled']);
});

test('P0-2: claim sources carry what each figure IS - tool results and the server-held document', () => {
  const fromTool = claimSourcesFromTool('calculate_base_wage_orientation', { ok: true, amount: 870.8, hourly_rate: 15.55, rate_source: 'document_reading', hours: 56 });
  assert.deepEqual(fromTool, [
    { value: 870.8, kind: 'indicative_base_wage_only' },
    { value: 15.55, kind: 'document_reading', topic: 'hourly_rate', key: 'hourly_rate' },
    { value: 56, kind: 'tool_value' },
  ]);
  const docs = week41();
  const knowledge = buildDocumentKnowledge(docs, resolvePayrollProfile({ asOfDate: '2026-10-21', documents: docs }));
  const fromDoc = claimSourcesFromKnowledge(knowledge);
  assert.ok(fromDoc.some((s) => s.value === 584.92 && s.kind === 'document_reading' && s.topic === 'payout'));
  assert.ok(fromDoc.every((s) => s.kind === 'document_reading'));
  assert.ok(!JSON.stringify(fromDoc).includes('"label"'), 'no printed text in the registry');
  assert.match(rewriteInstruction(checkClaims('56 h × 15,55 €/h = 870,80 € netto.', SOURCES, [])), /indicative base-wage orientation/);
});

// ---------------------------------------------------------------------------------------------
// P0-3 - general information, never an asserted entitlement
// ---------------------------------------------------------------------------------------------

test('P0-3: entitlements, guarantees and a CAO\'s applicability asserted as fact are flagged; hedged general information is not', () => {
  for (const bad of [
    'Przysługuje Ci dodatek za pracę w niedzielę.',
    'You are entitled to a night premium by law.',
    'Podlegasz CAO ABU.',
    'Pracodawca musi wypłacić Ci vakantiegeld.',
    'Zgodnie z prawem należy Ci się wyższa stawka w sobotę.',
  ]) assert.ok(codes(bad).includes('unsupported_entitlement'), bad);
  for (const ok of [
    'W wielu CAO za niedzielę jest dodatek, ale to zależy od Twojej umowy — sprawdź swoje CAO.',
    'Czy przysługuje Ci dodatek, zależy od CAO i umowy.',
    'Czy w Twojej umowie jest napisane, że przysługuje Ci dodatek?',
    'Masz prawo zapytać pracodawcę o rozliczenie.',
    'Typically some CAOs pay a Sunday premium, but I cannot confirm yours.',
  ]) assert.deepEqual(codes(ok), [], ok);
});

test('P0-3: the advisor is told - and the capability map says - that no verified legal / CAO / tax source exists yet', () => {
  const caps = capabilitiesForModel();
  assert.deepEqual(Object.keys(caps.knowledge_sources).sort(), ['cao_texts_or_rates', 'general_explanations', 'tax_tables_for_the_advisor', 'verified_dutch_labour_law']);
  assert.match(caps.knowledge_sources.verified_dutch_labour_law, /none/);
  for (const rule of [
    /NO verified Dutch labour-law, CAO or tax source/,
    /Never assert that the user is entitled to something/,
    /Never give an exact take-home \(net\) forecast/,
    /The orientation is "hours x base rate \(orientation\)" - never gross, net, take-home, payout, a premium, verified or guaranteed/,
    /Never state a premium percentage/,
    /"8 hours a day" does not say how many days - never assume 5 or 7/,
  ]) assert.match(ADVISOR_SYSTEM_PROMPT, rule);
});

// ---------------------------------------------------------------------------------------------
// The turn (recorded model): one rewrite, then fail closed - the model keeps writing the text
// ---------------------------------------------------------------------------------------------

const turn = (messages: string[], steps: Parameters<typeof recordedModel>[0], earlierClaims: ClaimSource[] = []) => {
  const ctx = toolContext({ messages, documents: week41() });
  const model = recordedModel(steps);
  return { model, outcome: runAdvisorTurn({ locale: 'pl', message: messages[messages.length - 1] as string, history: [], earlierClaims, today: '2026-10-21' }, ctx, model, advisorBudget()) };
};

test('P0-2 turn: a mislabelled orientation gets ONE rewrite from the model; a stubborn one is withheld', async () => {
  const fixed = turn(['Pracuję 7 dni w tygodniu, 56 godzin. Ile dostanę?'], [
    callTools(['calculate_base_wage_orientation', { hours_total: 56 }]),
    say('Dostaniesz 870,80 € netto.'),
    (request) => {
      const instruction = request.messages[request.messages.length - 1];
      assert.equal(instruction?.role, 'system');
      assert.match(String(instruction?.content), /indicative base-wage orientation/);
      return say('Orientacyjnie 56 h × 15,55 €/h = 870,80 € — sama stawka podstawowa; to nie jest kwota netto.');
    },
  ]);
  const r = await fixed.outcome;
  assert.equal(r.status, 'ok');
  assert.ok(r.status === 'ok' && r.groundingRewrite && r.checks.includes('orientation_mislabelled'));
  assert.ok(r.status === 'ok' && r.text.startsWith('Orientacyjnie'), 'the delivered text is the model\'s rewrite');
  assert.ok(r.status === 'ok' && r.claims.some((c) => c.kind === 'indicative_base_wage_only'));

  const stubborn = await turn(['Pracuję 7 dni w tygodniu, 56 godzin. Ile dostanę?'], [
    callTools(['calculate_base_wage_orientation', { hours_total: 56 }]), say('Dostaniesz 870,80 € netto.'), say('Na rękę 870,80 €.'),
  ]).outcome;
  assert.deepEqual([stubborn.status, stubborn.status === 'withheld' && stubborn.reason], ['withheld', 'mislabelled_amount']);
});

test('P0-2 / P0-3 turn: a past payout quoted as a forecast and an asserted entitlement are withheld when the model insists', async () => {
  const forecast = await turn(['Ile dostanę za 56 godzin?'], [say('W przyszłym tygodniu dostaniesz 584,92 €.'), say('Dostaniesz 584,92 €.')]).outcome;
  assert.deepEqual([forecast.status, forecast.status === 'withheld' && forecast.reason], ['withheld', 'mislabelled_amount']);
  const entitlement = await turn(['Czy dostanę dodatek za niedzielę?'], [say('Tak, przysługuje Ci dodatek za niedzielę.'), say('Przysługuje Ci dodatek niedzielny.')]).outcome;
  assert.deepEqual([entitlement.status, entitlement.status === 'withheld' && entitlement.reason], ['withheld', 'unsupported_entitlement']);
  const hedged = await turn(['Czy dostanę dodatek za niedzielę?'], [say('Tak, przysługuje Ci dodatek za niedzielę.'), say('To zależy od Twojej umowy i CAO — Loonto nie ma jeszcze zweryfikowanego źródła przepisów. Sprawdź umowę albo dodaj ją do analizy.')]).outcome;
  assert.equal(hedged.status, 'ok', 'the model\'s hedged rewrite is delivered');
});
