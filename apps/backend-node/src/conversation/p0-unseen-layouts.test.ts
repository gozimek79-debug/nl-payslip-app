import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePayslipBatches, type PayslipDocumentFacts } from '../payroll-engine/document-facts.js';
import { resolvePayrollProfile, type ProfileDocumentInput } from '../payroll-engine/payroll-profile.js';
import { buildDocumentKnowledge, type DocumentKnowledge } from '../document-context/knowledge.js';
import { trustedContextFromProfile } from './trusted-context.js';
import { runConversationTurn } from './conversation-turn.js';
import { RATES_2026, scriptedAgent } from '../test-support/conversation-fixtures.js';
import { absent, found, hourLine, payslipBatch, rawPayslip } from '../test-support/fact-fixtures.js';

/**
 * P0 STAGING (MOCK, no AI): the CTO's four UNSEEN synthetic layouts (LOONTO-4-Rozne-Paski-Syntetyczne.zip) - weekly with the
 * rate only on the regular line (A), four-weekly landscape with a header rate (B), a two-page monthly slip whose header and
 * line rates conflict (C), and an image-only scan with a night premium (D).
 *
 * Each `raw*` below is a HAND-WRITTEN reader answer in the exact JSON shape the Gemini fact schema asks for, transcribing
 * what the page prints. It is NOT observed Gemini output: it proves only that the generic mapping -> Profile -> Document
 * Knowledge -> conversation path handles these layouts. Whether Gemini itself reads them is the separate, live test.
 * Nothing here is used at runtime - the app has no knowledge of these files, names or values.
 */

const employer = (name: string) => [found(name, name, 1, null)];
const line = (o: Record<string, unknown>) => hourLine({ adds_hours: 'yes', tax_treatment: 'table', percent: null, amount: null, rate: null, hours: null, unclear_fields: [], page: 1, ...o });

/** A - weekly, embedded text, rate ONLY in the regular line; ADV printed as percent + amount. */
const rawA = rawPayslip({
  period_label: found('week 43 / 2026', 'Periode: week 43 / 2026', 1, 'Periode'),
  period_start: absent, period_end: absent,
  payment_date: found('2026-10-26', 'Betaaldatum: 26-10-2026', 1, 'Betaaldatum'),
  period_type: found('week', 'Periode: week 43 / 2026', 1, 'Periode'),
  employer_names: employer('Fictieve Uitzendgroep BV'),
  hourly_rate: absent,
  hour_lines: [
    line({ description: 'Loon normaal', kind: 'regular', hours: 35, rate: 17.3, amount: 605.5, raw: 'Loon normaal 35,00 17,30 605,50' }),
    line({ description: 'ADV toeslag', kind: 'adv_compensation', adds_hours: 'no', percent: 1.5, amount: 9.08, raw: 'ADV toeslag 1,50% 9,08' }),
  ],
  deduction_lines: [{ description: 'Pensioen premie', placement: 'pre_tax', category: 'pension', percent: null, base: null, amount: 18.4, raw: 'Pensioen premie -18,40', page: 1, unclear_fields: [] }],
  printed_table_tax: found(104.18, 'Loonheffing tabel -104,18', 1, 'Loonheffing tabel'),
  printed_net: found(492, 'Netto loon 492,00', 1, 'Netto loon'),
  net_lines: [{ description: 'Onbelaste reiskosten', category: 'reimbursement', amount: 30, raw: 'Onbelaste reiskosten 30,00', page: 1, unclear_fields: [] }],
  printed_payout: found(522, 'Overgemaakt 522,00', 1, 'Overgemaakt'),
});

/** B - four-weekly landscape, split panels, header "Uurloon bruto"; the regular line prints no amount. */
const rawB = rawPayslip({
  period_label: found('Periode 10 - 4 weken', 'Periode 10 - 4 weken | 28-09-2026 t/m 25-10-2026', 1, 'Periode'),
  period_start: found('2026-09-28', '28-09-2026', 1, 'Periode'),
  period_end: found('2026-10-25', 't/m 25-10-2026', 1, 'Periode'),
  payment_date: absent,
  period_type: found('4-weekly', 'Periode 10 - 4 weken', 1, 'Periode'),
  employer_names: employer('ProefPayroll Noord BV'),
  hourly_rate: found(16.25, 'Uurloon bruto: 16,25 EUR', 1, 'Uurloon bruto'),
  hour_lines: [
    line({ description: 'Normale uren', kind: 'regular', hours: 148, rate: 16.25, raw: 'Normale uren 148 x 16,25' }),
    line({ description: 'Ploegentoeslag', kind: 'irregular_surcharge', adds_hours: 'no', amount: 72.15, raw: 'Ploegentoeslag 72,15' }),
  ],
  deduction_lines: [{ description: 'Pensioen inhouding', placement: 'pre_tax', category: 'pension', percent: null, base: null, amount: 83, raw: 'Pensioen inhouding 83,00', page: 1, unclear_fields: [] }],
  printed_gross_total: found(2477.15, 'Totaal bruto 2.477,15', 1, 'Totaal bruto'),
  printed_table_tax: found(462.2, 'Loonheffing 462,20', 1, 'Loonheffing'),
  printed_net: found(1931.95, 'Totaal netto 1.931,95', 1, 'Totaal netto'),
  net_lines: [{ description: 'Reiskosten onbelast', category: 'reimbursement', amount: 96, raw: 'Reiskosten onbelast 96,00', page: 1, unclear_fields: [] }],
  printed_payout: found(2027.95, 'UITBETAALD: 2.027,95 EUR', 1, 'UITBETAALD'),
});

/** C - monthly, TWO pages read in one batch; header 18,20 against the regular line 18,75 (deliberate conflict). */
const rawC = rawPayslip({
  period_label: found('oktober 2026', 'Loonperiode: oktober 2026', 1, 'Loonperiode'),
  period_start: absent, period_end: absent, payment_date: absent,
  period_type: found('month', 'Loonperiode: oktober 2026', 1, 'Loonperiode'),
  employer_names: employer('Demo Verloning Delta BV'),
  hourly_rate: found(18.2, 'Uurloon: 18,20', 1, 'Uurloon'),
  hour_lines: [
    line({ description: 'Normale gewerkte uren', kind: 'regular', hours: 152, rate: 18.75, amount: 2850, raw: 'Normale gewerkte uren 152,00 18,75 2.850,00' }),
    line({ description: 'Zondag toeslag', kind: 'irregular_surcharge', adds_hours: 'no', hours: 8, percent: 50, amount: 75, raw: 'Zondag toeslag 8,00 50% 75,00' }),
  ],
  deduction_lines: [{ description: 'Ziektewet premie', placement: 'pre_tax', category: 'sector_premium', percent: null, base: null, amount: 12, raw: 'Ziektewet premie -12,00', page: 2, unclear_fields: [] }],
  reservation_lines: [{ description: 'Vakantiegeld opbouw', type: 'vakantiegeld', accrued: 234, paid_out: null, raw: 'Vakantiegeld opbouw 234,00', page: 2, unclear_fields: [] }],
  printed_gross_total: found(2925, 'Totaal bruto 2.925,00', 1, 'Totaal bruto'),
  printed_table_tax: found(580, 'Loonheffing -580,00', 1, 'Loonheffing'),
  printed_net: found(2345, 'Netto loon 2.345,00', 1, 'Netto loon'),
});

/** D - image-only scan, dot decimals, header "Uurloon 15.80 EUR" and a NIGHT premium (never a Saturday premium). */
const rawD = rawPayslip({
  period_label: found('WEEK 45 / 2026', 'LOONSTROOK - WEEK 45 / 2026', 1, null),
  period_start: found('2026-11-02', '02-11-2026', 1, 'Betalingsperiode'),
  period_end: found('2026-11-08', 't/m 08-11-2026', 1, 'Betalingsperiode'),
  payment_date: absent,
  period_type: found('week', 'WEEK 45 / 2026', 1, null),
  employer_names: employer('Proef Nachtwerk BV'),
  hourly_rate: found(15.8, '15.80 EUR', 1, 'Uurloon'),
  hour_lines: [
    line({ description: 'Loon normaal', kind: 'regular', hours: 24, rate: 15.8, amount: 379.2, raw: 'Loon normaal 24.00 uur x 15.80 = 379.20' }),
    line({ description: 'Nachttoeslag', kind: 'irregular_surcharge', adds_hours: 'no', hours: 4, percent: 25, amount: 15.8, raw: 'Nachttoeslag 4.00 uur x 25% = 15.80' }),
  ],
  printed_table_tax: found(54, 'Loonheffing -54.00', 1, 'Loonheffing'),
  printed_net: found(341, 'Netto loon 341.00', 1, 'Netto loon'),
  net_lines: [{ description: 'Onbelaste reiskosten', category: 'reimbursement', amount: 25, raw: 'Onbelaste reiskosten +25.00', page: 1, unclear_fields: [] }],
  printed_payout: found(366, 'Overgemaakt 366.00', 1, 'Overgemaakt'),
});

function doc(raw: Record<string, unknown>, pages = [1], totalPages = pages.length): ProfileDocumentInput & { facts: PayslipDocumentFacts } {
  return { index: 0, documentId: 'doc-1', label: 'payslip-1', role: 'payslip', effectiveDate: null, facts: mergePayslipBatches([payslipBatch(raw, pages, totalPages)]) };
}
function context(d: ProfileDocumentInput) {
  const profile = resolvePayrollProfile({ asOfDate: '2026-10-20', documents: [d] });
  return { profile, trusted: trustedContextFromProfile(profile), knowledge: buildDocumentKnowledge([d], profile) };
}
const facts = (k: DocumentKnowledge, key: string) => k.facts.filter((f) => f.key === key).map((f) => f.value);
async function ask(message: string, ctx: ReturnType<typeof context>) {
  const agent = scriptedAgent([]);
  const r = await runConversationTurn({ message, locale: 'pl', conversation: { deferredFields: [] } }, { agent, rates: RATES_2026, trusted: ctx.trusted, documentKnowledge: ctx.knowledge });
  assert.equal(agent.calls, 0, 'document questions need no model');
  return r;
}

test('P0 staging A (mock reading): the rate printed ONLY on the regular line is the base rate; ADV adds no hours', async () => {
  const d = doc(rawA);
  assert.deepEqual(d.facts.hourLines.map((l) => [l.kind, l.hours, l.rate, l.amount]), [['regular', 35, 17.3, 605.5], ['adv_compensation', null, null, 9.08]], 'every printed number survives the raw-evidence check');
  const ctx = context(d);
  assert.deepEqual([ctx.profile.employment.hourlyRate.state, ctx.profile.employment.hourlyRate.value], ['document_exact', 17.3]);
  assert.deepEqual([ctx.profile.payroll.periodType.value], ['week']);
  assert.deepEqual([facts(ctx.knowledge, 'regular_hours'), facts(ctx.knowledge, 'net'), facts(ctx.knowledge, 'payout'), facts(ctx.knowledge, 'reimbursement')], [[35], [492], [522], [30]]);
  const rate = await ask('Jaka jest moja stawka?', ctx);
  assert.deepEqual(rate.documentAnswer?.items.map((i) => [i.value, i.label]), [[17.3, 'Loon normaal']]);
  assert.deepEqual(rate.scenario.pay.hourlyRate, { state: 'known', value: 17.3, source: 'document', ref: 'doc-1' });
});

test('P0 staging B (mock reading): four-weekly landscape - header and line agree as ONE source; gross / net / payout / reimbursement kept', async () => {
  const ctx = context(doc(rawB));
  const rate = ctx.profile.employment.hourlyRate;
  assert.deepEqual([rate.state, rate.value, rate.candidates.length], ['document_exact', 16.25, 2]);
  assert.equal(ctx.profile.payroll.periodType.value, '4-weekly');
  assert.deepEqual([facts(ctx.knowledge, 'regular_hours'), facts(ctx.knowledge, 'gross_total'), facts(ctx.knowledge, 'net'), facts(ctx.knowledge, 'payout'), facts(ctx.knowledge, 'reimbursement')], [[148], [2477.15], [1931.95], [2027.95], [96]]);
  const payout = await ask('Ile faktycznie przelano?', ctx);
  assert.deepEqual(payout.documentAnswer?.items.map((i) => [i.key, i.value]), [['payout', 2027.95], ['net', 1931.95], ['reimbursement', 96]]);
});

test('P0 staging C (mock reading): two pages, conflicting header / line rates - a conflict, never a silent pick; page 2 facts kept', async () => {
  const d = doc(rawC, [1, 2], 2);
  assert.deepEqual(d.facts.coverage, { totalPages: 2, processedPages: [1, 2], notProcessedPages: [] }, 'both pages read');
  assert.equal(d.facts.deductionLines[0]?.evidence.page, 2, 'a fact from page 2 keeps its page');
  const ctx = context(d);
  const rate = ctx.profile.employment.hourlyRate;
  assert.deepEqual([rate.state, rate.value, rate.candidates.map((c) => c.value).sort()], ['conflict', null, [18.2, 18.75]]);
  assert.equal(ctx.profile.payroll.periodType.value, 'month');
  assert.deepEqual(facts(ctx.knowledge, 'net'), [2345]);
  const answer = await ask('Jaka jest moja stawka?', ctx);
  assert.deepEqual(answer.documentAnswer?.items.map((i) => [i.value, i.status]).sort(), [[18.2, 'conflict'], [18.75, 'conflict']]);
  assert.equal(answer.scenario.pay.hourlyRate?.state, 'conflict', 'the conversation carries the conflict, it does not choose');
  assert.notEqual(answer.evaluation?.status, 'computed');
});

test('P0 staging D (mock reading of an image-only scan): dot decimals, header + line one source, the night premium is never the Saturday premium', async () => {
  const d = doc(rawD);
  assert.deepEqual(d.facts.hourLines.map((l) => [l.kind, l.hours, l.rate, l.percent, l.amount]), [['regular', 24, 15.8, null, 379.2], ['irregular_surcharge', 4, null, 25, 15.8]]);
  const ctx = context(d);
  assert.deepEqual([ctx.profile.employment.hourlyRate.state, ctx.profile.employment.hourlyRate.value], ['document_exact', 15.8]);
  assert.equal(ctx.profile.payroll.saturdayPremium.state, 'unknown', 'a payslip premium line never establishes a Saturday premium');
  assert.equal(ctx.trusted.facts.some((f) => f.field === 'pay.saturdayPremiumPercent'), false);
  assert.deepEqual([facts(ctx.knowledge, 'regular_hours'), facts(ctx.knowledge, 'net'), facts(ctx.knowledge, 'payout'), facts(ctx.knowledge, 'surcharge_percent')], [[24], [341], [366], [25]]);
  const hours = await ask('Ile godzin mi zapłacono?', ctx);
  assert.deepEqual(hours.documentAnswer?.items.map((i) => [i.key, i.value]), [['regular_hours', 24]], 'the 4 night-premium hours are not paid hours');
  assert.equal(hours.scenario.pay.saturdayPremiumPercent, undefined);
});
