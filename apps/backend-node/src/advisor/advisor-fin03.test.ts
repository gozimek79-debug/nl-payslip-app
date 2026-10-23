import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, claimSourcesFromTool, type ToolContext } from './advisor-tools.js';
import { evaluatePayrollForAdvisor, choiceSupported, CONSENT } from './payroll-evaluation.js';
import { checkClaims, type ClaimIssueCode, type ClaimSource } from './claim-check.js';
import { scheduleBuckets, statedInDialogue, statementsIn } from './hours-statements.js';
import { ADVISOR_SYSTEM_PROMPT } from './advisor-prompt.js';
import { capabilitiesForModel } from './capabilities.js';
import { runAdvisorTurn } from './advisor-turn.js';
import { advisorBudget } from './advisor-config.js';
import { evaluateScenario } from '../scenario/scenario-evaluate.js';
import { emptyScenario } from '../conversation/conversation-turn.js';
import type { ScenarioV1 } from '../scenario/scenario-types.js';
import { callTools, recordedModel, say, toolContext } from '../test-support/advisor-fixtures.js';
import { RATES_2026 } from '../test-support/scenario-fixtures.js';

/**
 * FIN-03 deterministic tests (RECORDED model only - no provider call): the advisor's bridge to Loonto's trusted payroll
 * engine. Proves that every figure comes from the canonical `evaluateScenario`, that the model can inject no value,
 * that unknown never becomes 0, that assumptions need an earlier offer and the user's yes, and that the claim check
 * keeps an engine ESTIMATE from being presented as a certain or mislabelled figure. Conversational quality is NOT
 * proven here - that is the real-model pilot.
 */

const user = (v: unknown) => ({ state: 'known', value: v, source: 'user' });
const ctxWith = (messages: string[], extra: Partial<ToolContext> = {}): ToolContext => ({ ...toolContext({ messages }), ratesSource: 'database', today: '2026-10-23', ...extra });
const write = (ctx: ToolContext, ops: unknown[]) => executeTool('update_scenario', JSON.stringify({ ops }), ctx).result as { recorded: Array<Record<string, unknown>>; withheld: Array<{ field: string | null; reason: string }> };
const evaluate = (ctx: ToolContext) => executeTool('evaluate_payroll_scenario', '{}', ctx).result as Record<string, any>;

// ---------------------------------------------------------------------------------------------
// The figures ARE the canonical engine's
// ---------------------------------------------------------------------------------------------

test('FIN-03 engine parity: three different scenarios - the tool returns exactly what evaluateScenario computes directly', () => {
  const scenarios: Array<[string, ScenarioV1]> = [
    ['40 h x 16, tax credit applied, deductions estimated', { ...emptyScenario('a'), work: { regularWeekdayHours: user(40) }, pay: { hourlyRate: user(16) }, tax: { loonheffingskorting: user('applied') }, deductions: { mode: { state: 'known', value: 'estimate', source: 'loonto_assumption' } } } as ScenarioV1],
    ['36 + Sat 10 (+50%) + Sun 6 (+100%) x 15.55, deductions entered', { ...emptyScenario('b'), work: { regularWeekdayHours: user(36), saturdayHours: user(10), sundayHours: user(6) }, pay: { hourlyRate: user(15.55), saturdayPremiumPercent: user(50), sundayPremiumPercent: user(100) }, tax: { loonheffingskorting: user('applied') }, deductions: { mode: user('enter'), entered: { pension: user(12.4), paww: user(1.1), sectorPremium: user(3.2) } } } as ScenarioV1],
    ['32 h x 18.20, tax credit unknown -> both variants (range), travel 35', { ...emptyScenario('c'), work: { regularWeekdayHours: user(32) }, pay: { hourlyRate: user(18.2) }, tax: { loonheffingskorting: { state: 'alternatives', options: ['applied', 'not_applied'], source: 'loonto_assumption' } }, deductions: { mode: user('enter'), entered: { pension: user(0), paww: user(0), sectorPremium: user(0) } }, extras: { travelAllowance: user(35) } } as ScenarioV1],
  ];
  const payouts = new Set<number>();
  for (const [name, scenario] of scenarios) {
    const direct = evaluateScenario(scenario, RATES_2026);
    assert.equal(direct.status, 'computed', name);
    const viaTool = evaluatePayrollForAdvisor(scenario, RATES_2026, 'database', '2026-10-23');
    const f = (viaTool.result.figures ?? {}) as Record<string, number>;
    assert.deepEqual([f.gross_total, f.total_tax, f.wage_net, f.payout_amount, f.hours_worked], direct.status === 'computed' ? [direct.figures.grossTotal, direct.figures.totalTax, direct.figures.wageNet, direct.figures.payoutAmount, direct.figures.hoursWorked] : [], name);
    assert.deepEqual(viaTool.card.payoutRange, direct.status === 'computed' && direct.range ? { low: direct.range.low, high: direct.range.high } : null, name);
    payouts.add(f.payout_amount as number);
  }
  assert.equal(payouts.size, 3, 'three substantively different results');
  const ranged = evaluatePayrollForAdvisor(scenarios[2]?.[1] as ScenarioV1, RATES_2026, 'database', '2026-10-23');
  assert.ok(ranged.result.payout_range, 'unknown tax credit -> a range, never one guessed figure');
  assert.notEqual((ranged.result.figures as Record<string, number>).wage_net, (ranged.result.figures as Record<string, number>).payout_amount, 'net wage and payout stay different concepts');
});

test('FIN-03 blocked, unsupported, rates unavailable: no figure, the exact missing inputs, never zero', () => {
  const blocked = evaluatePayrollForAdvisor({ ...emptyScenario('d'), work: { regularWeekdayHours: user(40) }, pay: { hourlyRate: user(16) } } as ScenarioV1, RATES_2026, 'database', '2026-10-23');
  assert.equal(blocked.result.status, 'blocked');
  assert.equal(blocked.result.figures, undefined);
  assert.deepEqual((blocked.result.missing as Array<{ field: string }>).map((m) => m.field), ['tax.loonheffingskorting', 'deductions.mode']);
  assert.deepEqual(blocked.offered, ['tax.loonheffingskorting', 'deductions.mode']);
  assert.deepEqual(blocked.claims.filter((c) => c.kind === 'calculated_engine_estimate'), [], 'no engine figure when blocked');
  // A Saturday with hours but no stated premium blocks - it is never computed as 0%.
  const premiumUnknown = evaluatePayrollForAdvisor({ ...emptyScenario('e'), work: { regularWeekdayHours: user(40), saturdayHours: user(8) }, pay: { hourlyRate: user(16) }, tax: { loonheffingskorting: user('applied') }, deductions: { mode: user('enter'), entered: { pension: user(0), paww: user(0), sectorPremium: user(0) } } } as ScenarioV1, RATES_2026, 'database', '2026-10-23');
  assert.equal(premiumUnknown.result.status, 'blocked');
  assert.deepEqual((premiumUnknown.result.missing as Array<{ field: string; loonto_assumption_possible: boolean }>).map((m) => [m.field, m.loonto_assumption_possible]), [['pay.saturdayPremiumPercent', false]], 'premium: ask the user - Loonto does not offer a premium assumption');
  const night = evaluatePayrollForAdvisor({ ...emptyScenario('f'), work: { regularWeekdayHours: user(40) }, pay: { hourlyRate: user(16) }, tax: { loonheffingskorting: user('applied') }, deductions: { mode: user('enter'), entered: { pension: user(0), paww: user(0), sectorPremium: user(0) } }, requestedConcepts: [{ concept: 'night_premium', source: 'user' }] } as ScenarioV1, RATES_2026, 'database', '2026-10-23');
  assert.deepEqual([night.result.status, night.result.unsupported], ['unsupported', ['night_premium']]);
  const noRates = evaluatePayrollForAdvisor(emptyScenario('g'), null, null, '2026-10-23');
  assert.deepEqual([noRates.result.status, noRates.result.reason, noRates.card.status], ['blocked', 'tax_rates_unavailable', 'rates_unavailable']);
});

// ---------------------------------------------------------------------------------------------
// The model cannot inject anything
// ---------------------------------------------------------------------------------------------

test('FIN-03 injection: the calculation takes no values; rates, hours, days, tax settings, assumptions and sources cannot be slipped in', () => {
  const ctx = ctxWith(['Pracuję 40 godzin od poniedziałku do piątku po 16 €.']);
  for (const args of [{ hourly_rate: 99 }, { net: 500 }, { scenario: { pay: { hourlyRate: user(99) } } }, { gross_total: 1000 }]) {
    assert.equal(executeTool('evaluate_payroll_scenario', JSON.stringify(args), ctx).status, 'invalid_arguments', JSON.stringify(args));
  }
  // A rate the user never wrote, a tax credit and an estimate mode the user never mentioned.
  const r = write(ctx, [{ op: 'set', field: 'pay.hourlyRate', value: 99 }, { op: 'set', field: 'tax.loonheffingskorting', value: 'applied' }, { op: 'set', field: 'deductions.mode', value: 'estimate' }]);
  assert.deepEqual(r.withheld.map((w) => [w.field, w.reason]).sort(), [['deductions.mode', 'choice_not_stated_by_user'], ['pay.hourlyRate', 'value_not_stated_withheld'], ['tax.loonheffingskorting', 'choice_not_stated_by_user']]);
  // A model-claimed provenance is refused outright (RT-001).
  assert.equal(executeTool('update_scenario', JSON.stringify({ ops: [{ op: 'set', field: 'pay.hourlyRate', value: 16, source: 'document' }] }), ctx).status, 'refused');
  // An assumption that was never offered in an earlier turn, or offered but without the user's yes.
  assert.deepEqual(write(ctx, [{ op: 'accept_assumption', field: 'deductions.mode' }]).withheld, [{ field: 'deductions.mode', reason: 'assumption_not_offered_earlier' }]);
  const offered = ctxWith(['Ile mniej więcej netto?'], { offeredAssumptions: ['deductions.mode'] });
  assert.deepEqual(write(offered, [{ op: 'accept_assumption', field: 'deductions.mode' }]).withheld, [{ field: 'deductions.mode', reason: 'no_user_consent_in_this_message' }]);
  const notOfferable = ctxWith(['tak'], { offeredAssumptions: ['deductions.mode'] });
  assert.deepEqual(write(notOfferable, [{ op: 'accept_assumption', field: 'pay.saturdayPremiumPercent' }]).withheld, [{ field: 'pay.saturdayPremiumPercent', reason: 'assumption_not_offered_earlier' }]);
});

test('FIN-03 choices and consent: a tax setting only when the user talked about it; a "yes" accepts only what was offered', () => {
  assert.ok(choiceSupported('tax.loonheffingskorting', 'applied', 'Mam ulgę podatkową (loonheffingskorting).'));
  assert.ok(choiceSupported('tax.loonheffingskorting', 'not_applied', 'Nie mam loonheffingskorting u tego pracodawcy.'));
  assert.ok(!choiceSupported('tax.loonheffingskorting', 'applied', 'Nie mam loonheffingskorting.'));
  assert.ok(!choiceSupported('tax.loonheffingskorting', 'applied', 'Pracuję 40 godzin.'));
  assert.ok(!choiceSupported('deductions.mode', 'estimate', 'Oszacuj potrącenia emerytalne.'), 'estimate is a Loonto assumption, never a user write');
  assert.ok(choiceSupported('deductions.mode', 'enter', 'Emerytura 12,40, PAWW 1,10, składka sektorowa 3,20.'));
  for (const yes of ['tak', 'Tak, oszacuj', 'ok', 'yes please', 'go ahead']) assert.ok(CONSENT.test(yes), yes);
  for (const no of ['nie', 'no', 'Ile netto?']) assert.ok(!CONSENT.test(no), no);
  const ctx = ctxWith(['Tak, oszacuj potrącenia.'], { offeredAssumptions: ['deductions.mode', 'tax.loonheffingskorting'] });
  const r = write(ctx, [{ op: 'accept_assumption', field: 'deductions.mode' }]);
  assert.deepEqual(r.recorded, [{ op: 'accept_assumption', field: 'deductions.mode', source: 'loonto_assumption' }]);
  assert.deepEqual(ctx.scenario.deductions?.mode, { state: 'known', value: 'estimate', source: 'loonto_assumption' }, 'the catalogued value - not one the model chose');
});

// ---------------------------------------------------------------------------------------------
// Days and hours (cases A, B, C, F)
// ---------------------------------------------------------------------------------------------

test('FIN-03 schedules: a stated per-day x day span fills the buckets; a total is never split; a bare per-day never becomes 5 or 7 days', () => {
  const stated = (text: string) => scheduleBuckets(statedInDialogue([{ role: 'user', text }]));
  assert.deepEqual(stated('Od poniedziałku do niedzieli po 8 godzin. 15,55 € za godzinę.'), { regularWeekdayHours: 40, saturdayHours: 8, sundayHours: 8 }, 'C');
  assert.deepEqual(stated('Monday to Friday, 8 hours a day'), { regularWeekdayHours: 40 });
  assert.equal(stated('Pracuję 7 dni w tygodniu, 56 godzin.'), null, 'A: a total says nothing about the days');
  assert.equal(stated('Pracuję po 8 godzin dziennie.'), null, 'B: no day span');
  assert.equal(stated('Pracuję 5 dni po 8 godzin.'), null, '"5 dni" does not say which five');
  assert.deepEqual(statementsIn('pon–pt po 8 h').spans, ['mon-fri']);
  assert.deepEqual(stated('Pracuję 40 godzin od poniedziałku do piątku.'), { regularWeekdayHours: 40 }, 'a total stated for Mon-Fri IS the weekday bucket');
  // A base rate the user stated as such - and the look-alikes that are not.
  for (const [text, rates] of [
    ['Pracuję 40 godzin od poniedziałku do piątku po 16 €.', [16]], ['40 hours Monday to Friday at 16 EUR per hour', [16]], ['Pracuję 40 godzin po 16 €, bez dodatków.', [16]],
    ['Stawka 15,55 €.', [15.55]], ['Dostaję €16.80/h brutto', [16.8]],
    ['w sobotę 10 godzin po 20 €', []], ['40 godzin po 8 dziennie', []], ['Kupiłem 2 bilety po 16 €', []], ['Pracuję 8 godzin po 120 € dziennie', []], ['Zwrot dojazdu 35 € i 40 godzin po 16 €', []],
  ] as Array<[string, number[]]>) assert.deepEqual(statementsIn(text).rates, rates, text);
  // C: the derived buckets pass; A: the same buckets from a total are withheld.
  const c = ctxWith(['Od poniedziałku do niedzieli po 8 godzin. 15,55 € za godzinę.']);
  const cw = write(c, [{ op: 'set', field: 'work.regularWeekdayHours', value: 40 }, { op: 'set', field: 'work.saturdayHours', value: 8 }, { op: 'set', field: 'work.sundayHours', value: 8 }, { op: 'set', field: 'pay.hourlyRate', value: 15.55 }]);
  assert.deepEqual(cw.withheld, []);
  assert.deepEqual((evaluate(c).missing as Array<{ field: string }>).map((m) => m.field), ['pay.saturdayPremiumPercent', 'pay.sundayPremiumPercent', 'tax.loonheffingskorting', 'deductions.mode'], 'C: only what is genuinely missing');
  const a = ctxWith(['Pracuję 7 dni w tygodniu, 56 godzin. Stawka 15,55 €. Ile dostanę?']);
  const aw = write(a, [{ op: 'set', field: 'work.regularWeekdayHours', value: 40 }, { op: 'set', field: 'work.saturdayHours', value: 8 }, { op: 'set', field: 'work.sundayHours', value: 8 }]);
  assert.equal(aw.recorded.length, 0, 'A: no silent 8-per-day allocation');
  assert.equal(write(c, [{ op: 'set', field: 'work.regularWeekdayHours', value: 44 }]).withheld[0]?.field, 'work.regularWeekdayHours', 'a value that is not the derivation still meets the guard');
  // F: a correction keeps the reliable data and replaces what changed - no double counting.
  const f = ctxWith(['Nie, w sobotę było 10 h, w niedzielę 6 h, a razem 56.']);
  f.scenario = { ...f.scenario, pay: { hourlyRate: user(15.55) } } as ScenarioV1;
  const fw = write(f, [{ op: 'set', field: 'work.saturdayHours', value: 10 }, { op: 'set', field: 'work.sundayHours', value: 6 }, { op: 'set', field: 'work.regularWeekdayHours', value: 40 }]);
  assert.deepEqual(fw.recorded.map((r) => r.field).sort(), ['work.saturdayHours', 'work.sundayHours']);
  assert.deepEqual(fw.withheld.map((w) => w.field), ['work.regularWeekdayHours'], 'F: "the rest" is asked, never derived from the total (R2 rule)');
  assert.deepEqual((f.scenario.pay.hourlyRate as { value: number }).value, 15.55, 'F: the earlier rate is kept');
});

// ---------------------------------------------------------------------------------------------
// Claims: an engine estimate is an estimate, and each figure keeps its name
// ---------------------------------------------------------------------------------------------

const ENGINE: ClaimSource[] = [
  { value: 640, kind: 'calculated_engine_estimate', topic: 'gross', key: 'gross_total' },
  { value: 60.14, kind: 'calculated_engine_estimate', topic: 'tax', key: 'total_tax' },
  { value: 558.94, kind: 'calculated_engine_estimate', topic: 'net', key: 'wage_net' },
  { value: 593.94, kind: 'calculated_engine_estimate', topic: 'payout', key: 'payout_amount' },
];
const codes = (text: string): ClaimIssueCode[] => [...new Set(checkClaims(text, ENGINE, []).map((i) => i.code))].sort();

test('FIN-03 claims: an engine figure as an estimate passes; as certain, verified or under another name it does not', () => {
  for (const ok of [
    'Według wyliczenia Loonto dostaniesz około 558,94 € netto, a przelew wyniesie mniej więcej 593,94 €.',
    'Brutto wychodzi 640,00 €, podatek 60,14 €, netto 558,94 €.',
    'Loonto estimates about €558.94 net wage and a payout of roughly €593.94 for that week.',
  ]) assert.deepEqual(codes(ok), [], ok);
  assert.deepEqual(codes('Dostaniesz 558,94 € netto.'), ['estimate_presented_as_certain']);
  assert.deepEqual(codes('Pracodawca wypłaci Ci 593,94 €.'), ['estimate_presented_as_certain']);
  assert.deepEqual(codes('To zweryfikowana kwota netto: 558,94 €.'), ['amount_described_as_verified']);
  assert.deepEqual(codes('Netto wyniesie około 640,00 €.'), ['calculation_mislabelled'], 'gross called net');
  assert.deepEqual(codes('Brutto to około 558,94 €.'), ['calculation_mislabelled'], 'net called gross');
  assert.deepEqual(codes('Na rękę około 60,14 €.'), ['calculation_mislabelled'], 'tax called take-home');
  // A past payslip amount is still never a forecast (P0-2 unchanged).
  const doc: ClaimSource[] = [{ value: 509.92, kind: 'document_reading', topic: 'net', key: 'net', period: 'week 41/2026' }];
  assert.deepEqual(checkClaims('W przyszłym tygodniu dostaniesz około 509,92 €.', doc, []).map((i) => i.code), ['document_amount_as_forecast'], 'E: history is not a forecast, "about" or not');
  // Engine figures are registered as engine estimates, with their own names.
  const sources = claimSourcesFromTool('evaluate_payroll_scenario', { figures: { gross_total: 640, total_tax: 60.14, wage_net: 558.94, payout_amount: 593.94, hours_worked: 40 }, inputs: [{ field: 'pay.hourlyRate', source: 'user_stated', value: 16 }] });
  assert.deepEqual(sources.filter((s) => s.kind === 'calculated_engine_estimate').map((s) => s.key), ['gross_total', 'total_tax', 'wage_net', 'payout_amount']);
});

test('FIN-03 instructions and capabilities say exactly what is available', () => {
  for (const rule of [
    /evaluate_payroll_scenario: Loonto's trusted payroll engine on the recorded scenario - the ONLY source of gross, wage tax, net wage and payout figures/,
    /accept one with update_scenario accept_assumption ONLY in a later turn, after the user said yes/,
    /Never call it the employer's verified or guaranteed payout/,
    /no false precision/,
    /it is not a verified contract or CAO rule/,
  ]) assert.match(ADVISOR_SYSTEM_PROMPT, rule);
  const caps = capabilitiesForModel();
  assert.match(caps.advisor_features.gross_or_net_pay_calculation, /ESTIMATE for one week when all inputs are known/);
  const pro = caps.modules.find((m) => m.id === 'pro_advisor');
  assert.equal(pro?.status, 'alpha', 'PRO is not labelled finished');
  assert.match(pro?.limits ?? '', /Not modelled: night \/ evening \/ shift premiums/);
});

// ---------------------------------------------------------------------------------------------
// Case D end to end (recorded model): blocked -> offer -> the user agrees -> engine estimate
// ---------------------------------------------------------------------------------------------

test('FIN-03 case D (RECORDED model): the engine figure reaches the user only via the tool, with its assumptions, as an estimate', async () => {
  // Turn 1: the user's values are recorded; the engine is blocked on deductions; the model offers the estimate.
  const t1 = ctxWith(['Pracuję 40 godzin od poniedziałku do piątku po 16 €, bez dodatków; mam loonheffingskorting. Ile mniej więcej netto?']);
  const m1 = recordedModel([
    callTools(['update_scenario', { ops: [{ op: 'set', field: 'work.regularWeekdayHours', value: 40 }, { op: 'set', field: 'pay.hourlyRate', value: 16 }, { op: 'set', field: 'tax.loonheffingskorting', value: 'applied' }] }], ['evaluate_payroll_scenario', {}]),
    say('Brakuje mi tylko potrąceń (emerytura, PAWW, składka sektorowa). Mogę je oszacować średnimi Loonto - zrobić to?'),
  ]);
  const r1 = await runAdvisorTurn({ locale: 'pl', message: t1.currentMessage, history: [], earlierClaims: [], today: '2026-10-23' }, t1, m1, advisorBudget());
  assert.equal(r1.status, 'ok');
  assert.equal(t1.calculation?.status, 'blocked');
  assert.deepEqual(t1.newlyOffered, ['deductions.mode']);
  // Turn 2: "tak" -> accept the offered assumption -> engine computes -> the model gives the estimate.
  const t2 = ctxWith(['Tak, oszacuj.'], { offeredAssumptions: t1.newlyOffered ?? [] });
  t2.scenario = t1.scenario;
  let figures: Record<string, number> = {};
  const m2 = recordedModel([
    callTools(['update_scenario', { ops: [{ op: 'accept_assumption', field: 'deductions.mode' }] }], ['evaluate_payroll_scenario', {}]),
    (request) => {
      const evaluation = JSON.parse(String(request.messages[request.messages.length - 1]?.content)) as { figures: Record<string, number> };
      figures = evaluation.figures;
      return say(`Według wyliczenia Loonto za ten tydzień wychodzi około ${figures.wage_net?.toFixed(2).replace('.', ',')} € netto (brutto ${figures.gross_total?.toFixed(2).replace('.', ',')} €, podatek ${figures.total_tax?.toFixed(2).replace('.', ',')} €). Potrącenia są szacunkiem Loonto, nie kwotami z Twojego paska.`);
    },
  ]);
  const r2 = await runAdvisorTurn({ locale: 'pl', message: 'Tak, oszacuj.', history: [], earlierClaims: [], today: '2026-10-23' }, t2, m2, advisorBudget());
  assert.equal(r2.status, 'ok', JSON.stringify(r2));
  assert.equal(t2.calculation?.status, 'computed');
  const direct = evaluateScenario(t2.scenario, RATES_2026);
  assert.ok(direct.status === 'computed' && direct.figures.wageNet === figures.wage_net, 'the figure the model wrote is the engine\'s');
  assert.ok(t2.calculation?.inputs.some((i) => i.field === 'deductions.mode' && i.source === 'loonto_assumption'), 'the assumption is labelled as one');
  assert.ok(r2.status === 'ok' && r2.claims.some((c) => c.kind === 'calculated_engine_estimate'), 'kept as an engine estimate for later turns');
});

test('FIN-03 a model that presents the engine figure as certain gets ONE rewrite, then the answer is withheld', async () => {
  const ctx = ctxWith(['Pracuję 40 godzin od poniedziałku do piątku po 16 €; mam loonheffingskorting; emerytura 0, PAWW 0, składka sektorowa 0.']);
  const model = recordedModel([
    callTools(['update_scenario', { ops: [{ op: 'set', field: 'work.regularWeekdayHours', value: 40 }, { op: 'set', field: 'pay.hourlyRate', value: 16 }, { op: 'set', field: 'tax.loonheffingskorting', value: 'applied' }, { op: 'set', field: 'deductions.mode', value: 'enter' }, { op: 'set', field: 'deductions.entered.pension', value: 0 }, { op: 'set', field: 'deductions.entered.paww', value: 0 }, { op: 'set', field: 'deductions.entered.sectorPremium', value: 0 }] }], ['evaluate_payroll_scenario', {}]),
    (request) => {
      const ev = JSON.parse(String(request.messages[request.messages.length - 1]?.content)) as { status: string; figures?: { wage_net: number } };
      assert.equal(ev.status, 'computed', JSON.stringify(ev));
      return say(`Dostaniesz ${ev.figures?.wage_net.toFixed(2).replace('.', ',')} € netto.`);
    },
    (request) => say(String(request.messages.find((m) => m.role === 'assistant' && typeof m.content === 'string')?.content)),
  ]);
  const r = await runAdvisorTurn({ locale: 'pl', message: ctx.currentMessage, history: [], earlierClaims: [], today: '2026-10-23' }, ctx, model, advisorBudget());
  assert.deepEqual([r.status, r.status === 'withheld' && r.reason, r.status !== 'unavailable' && r.checks], ['withheld', 'mislabelled_amount', ['estimate_presented_as_certain']]);
});
