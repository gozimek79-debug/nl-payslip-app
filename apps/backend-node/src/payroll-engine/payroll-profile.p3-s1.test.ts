import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePayrollProfile, canonicalProfileAmount, applySignPolicy, calibrationPrintedAmount, PROFILE_AMOUNT_SIGN_POLICY,
  type ProfileDocumentInput, type ProfileAmountSite,
} from './payroll-profile.js';
import { mergePayslipBatches, type PayslipDocumentFacts } from './document-facts.js';
import { buildExtractionTable } from './fact-table.js';
import { PAYSLIP_PERIOD_SIGN_POLICY } from './sign-policy.js';
import { payslipBatch, rawPayslip, found, hourLine } from '../test-support/fact-fixtures.js';

/**
 * P3.1 S1 (LOONTO-PRO-P3-DECISION-LOCK.md, decision F2; ZADANIE-P3.1-S1-SIGN-NORMALIZATION.md):
 * canonical amount sign at the Payroll Profile boundary. Facts stay as read, the printed sign stays in
 * the evidence, and the profile's own amounts are magnitudes - normalised BEFORE candidates are compared.
 * Synthetic reader responses only, mapped by the production mapper.
 */

const AS_OF = '2026-06-01';

function payslip(index: number, label: string, raw: Record<string, unknown>): ProfileDocumentInput {
  return { index, label, role: 'payslip', effectiveDate: null, facts: mergePayslipBatches([payslipBatch(raw)]) };
}

function housing(amount: number, raw: string): Record<string, unknown> {
  return { description: 'Huisvesting', category: 'housing', amount, raw, page: 1, unclear_fields: [] };
}

const WEEK_11 = { period_label: found('week 11/2026', 'Periode: week 11/2026', 1, 'Periode') };

// ---------------------------------------------------------------------------------------------
// #17 - sign normalisation / false-conflict prevention
// ---------------------------------------------------------------------------------------------

test('P3.1 S1 #17: "95,00-" read as -95 and "95,00" read as 95 are the same recurring deduction - canonical 95, corroborated, no sign-only conflict', () => {
  const minus = payslip(0, 'pasek-10.pdf', rawPayslip({ net_lines: [housing(-95, 'Huisvesting 95,00-')] }));
  const plain = payslip(1, 'pasek-11.pdf', rawPayslip({ ...WEEK_11, net_lines: [housing(95, 'Huisvesting 95,00')] }));
  // The facts are exactly as the reader gave them (P2 is untouched).
  assert.equal((minus.facts as PayslipDocumentFacts).netLines[0]?.amount, -95);
  assert.equal((plain.facts as PayslipDocumentFacts).netLines[0]?.amount, 95);

  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [minus, plain] });
  assert.equal(profile.recurringItems.netDeductions.length, 1, 'one semantic item, not two');
  const [field] = profile.recurringItems.netDeductions;
  assert.equal(field?.key, 'net_deduction:housing:huisvesting');
  assert.deepEqual([field?.state, field?.value, field?.reason], ['corroborated', 95, null], 'a sign-only difference is not a conflict');
  assert.deepEqual(field?.candidates.map((c) => c.value), [95, 95]);
  assert.deepEqual(field?.candidates.map((c) => c.detail?.amount), [95, 95]);
  assert.deepEqual(field?.sources.map((s) => s.documentLabel), ['pasek-10.pdf', 'pasek-11.pdf']);
});

test('P3.1 S1 #17: normalisation is idempotent - feeding already-canonical amounts changes nothing', () => {
  const signed = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslip(0, 'a.pdf', rawPayslip({ net_lines: [housing(-95, 'Huisvesting 95,00-')] }))] });
  const canonical = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslip(0, 'a.pdf', rawPayslip({ net_lines: [housing(95, 'Huisvesting 95,00-')] }))] });
  const view = (p: typeof signed) => p.recurringItems.netDeductions.map((f) => [f.key, f.state, f.value, f.candidates.map((c) => [c.value, c.detail?.amount])]);
  assert.deepEqual(view(signed), view(canonical), 'the profile does not depend on the sign the reader returned');
  assert.deepEqual(view(signed), [['net_deduction:housing:huisvesting', 'document_exact', 95, [[95, 95]]]]);
});

test('P3.1 S1: net additions and ET reimbursements are canonical magnitudes too; a genuinely different amount is still a conflict', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [
      payslip(0, 'a.pdf', rawPayslip({
        net_lines: [{ description: 'Reiskosten', category: 'reimbursement', amount: -12.5, raw: 'Reiskosten 12,50-', page: 1, unclear_fields: [] }, housing(95, 'Huisvesting 95,00')],
        et_reimbursement_lines: [{ description: 'ET vergoeding', amount: -42, raw: 'ET vergoeding 42,00-', page: 1, unclear_fields: [] }],
      })),
      payslip(1, 'b.pdf', rawPayslip({ ...WEEK_11, net_lines: [housing(96, 'Huisvesting 96,00-')] })),
    ],
  });
  assert.deepEqual(profile.recurringItems.netAdditions.map((f) => [f.key, f.value]), [['net_addition:reimbursement:reiskosten', 12.5], ['net_addition:et_reimbursement:et vergoeding', 42]]);
  const [h] = profile.recurringItems.netDeductions;
  assert.equal(h?.state, 'conflict', '95 vs 96 is a real difference - normalisation hides only the sign');
  assert.deepEqual(h?.candidates.map((c) => c.value), [95, 96]);
});

test('P3.1 S1: ET exchange amount and jaarloon BT are canonical magnitudes - a sign-only difference across payslips corroborates', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [
      payslip(0, 'a.pdf', rawPayslip({ et_exchange_amount: found(-60, 'ET ruil 60,00-', 1, 'ET'), jaarloon_bt: found(-31200, 'Jaarloon 31.200,00-', 1, 'Jaarloon') })),
      payslip(1, 'b.pdf', rawPayslip({ ...WEEK_11, et_exchange_amount: found(60, 'ET ruil 60,00', 1, 'ET'), jaarloon_bt: found(31200, 'Jaarloon 31.200,00', 1, 'Jaarloon') })),
    ],
  });
  assert.deepEqual([profile.payroll.etExchangeAmount.state, profile.payroll.etExchangeAmount.value], ['corroborated', 60]);
  assert.deepEqual([profile.payroll.jaarloonBt.state, profile.payroll.jaarloonBt.value], ['corroborated', 31200]);
});

// ---------------------------------------------------------------------------------------------
// #18 - helper contract only (user decisions do not exist until S3)
// ---------------------------------------------------------------------------------------------

test('P3.1 S1 #18 (helper contract): canonicalProfileAmount is magnitude where direction is carried by the list, idempotent, null-safe and coerces nothing', () => {
  // The full "user correction of -95 is rejected / invalid_value" test belongs to S3, when user
  // decisions exist (documented deferral). S1 only pins the reusable helper S3 will call.
  const magnitudeSites: ProfileAmountSite[] = ['recurringItems.netAdditions', 'recurringItems.netDeductions', 'payroll.etExchangeAmount', 'payroll.jaarloonBt', 'detail.deductionLineAmount', 'detail.reservationAmount'];
  for (const site of magnitudeSites) {
    assert.equal(PROFILE_AMOUNT_SIGN_POLICY[site], 'magnitude');
    for (const x of [-95, -0.01, 0, 12.5, 95, 1e6]) {
      const once = canonicalProfileAmount(site, x);
      assert.ok(once >= 0 && Object.is(canonicalProfileAmount(site, once), once), `${site}: magnitude of ${x} is idempotent`);
      assert.equal(once, Math.abs(x));
    }
    assert.ok(Object.is(canonicalProfileAmount(site, -0), 0), 'minus zero is plain zero');
  }
  // Hour-line amounts keep their sign (a correction line can reverse gross), as the engine policy has it.
  assert.equal(PROFILE_AMOUNT_SIGN_POLICY['detail.hourLineAmount'], 'keep');
  assert.equal(canonicalProfileAmount('detail.hourLineAmount', -64.8), -64.8);
  // An unread amount is never turned into a number, and nothing non-finite is coerced.
  for (const site of Object.keys(PROFILE_AMOUNT_SIGN_POLICY) as ProfileAmountSite[]) assert.equal(canonicalProfileAmount(site, null), null);
  assert.ok(Number.isNaN(canonicalProfileAmount('recurringItems.netDeductions', Number.NaN)));
  assert.equal(canonicalProfileAmount('recurringItems.netDeductions', Number.NEGATIVE_INFINITY), Number.POSITIVE_INFINITY);
  assert.equal(applySignPolicy('not_an_amount', -3), -3);
  assert.deepEqual(Object.keys(PROFILE_AMOUNT_SIGN_POLICY).sort(), [
    'detail.deductionLineAmount', 'detail.hourLineAmount', 'detail.reservationAmount', 'payroll.etExchangeAmount', 'payroll.jaarloonBt',
    'recurringItems.netAdditions', 'recurringItems.netDeductions',
  ]);
});

// ---------------------------------------------------------------------------------------------
// #34 - calibration sign policy
// ---------------------------------------------------------------------------------------------

test('P3.1 S1 #34: calibrationOnly follows the engine sign policy (tax/gross/LvH magnitude; net, payout, credits keep the printed sign) and is never a field', () => {
  const doc = payslip(0, 'pasek.pdf', rawPayslip({
    printed_table_tax: found(-98.22, 'Loonheffing 98,22-', 1, 'Loonheffing'),
    printed_bt_tax: found(-3.1, 'BT 3,10-', 1, 'BT'),
    printed_gross_total: found(-939.6, 'Bruto 939,60-', 1, 'Bruto'),
    printed_loon_voor_heffingen: found(-892.91, 'LvH 892,91-', 1, 'LvH'),
    printed_net: found(-53.89, 'Netto -53,89', 1, 'Netto'),
    printed_payout: found(-53.89, 'Uit te betalen -53,89', 1, 'Uit te betalen'),
    printed_algemene_heffingskorting: found(-12.34, 'Heffingskorting 12,34-', 1, 'Heffingskorting'),
    printed_arbeidskorting: found(-5.6, 'Arbeidskorting 5,60-', 1, 'Arbeidskorting'),
    minimum_wage_printed: found(14.71, 'WML 14,71', 1, 'WML'),
  }));
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [doc] });
  const printed = profile.calibrationOnly.payslips[0]?.printed;
  assert.deepEqual(printed, {
    table_tax: 98.22, bt_tax: 3.1, gross_total: 939.6, loon_voor_heffingen: 892.91, // magnitude (printed_table_tax / _bt_tax / _gross_total / _loon_voor_heffingen)
    net: -53.89, payout: -53.89, // keep: a printed net/payout can be an amount owed
    algemene_heffingskorting: -12.34, arbeidskorting: -5.6, // keep (policy: no confirmed negative case, nothing to correct)
    minimum_wage: 14.71, // a rate, as read
  });
  // The numbers are the engine policy's own: nothing here is a second convention.
  assert.deepEqual(
    ['printed_table_tax', 'printed_bt_tax', 'printed_gross_total', 'printed_loon_voor_heffingen', 'printed_net', 'printed_payout', 'printed_algemene_heffingskorting', 'printed_arbeidskorting'].map((k) => PAYSLIP_PERIOD_SIGN_POLICY[k as keyof typeof PAYSLIP_PERIOD_SIGN_POLICY]),
    ['magnitude', 'magnitude', 'magnitude', 'magnitude', 'keep', 'keep', 'keep', 'keep'],
  );
  assert.equal(calibrationPrintedAmount('table_tax', null), null);
  assert.equal(calibrationPrintedAmount('table_tax', -98.22), 98.22);
  assert.equal(calibrationPrintedAmount('payout', -53.89), -53.89);
  // Still calibration-only: no field carries any printed figure, and the table keeps the as-read values.
  const allFields = [...Object.values(profile.employment), ...Object.values(profile.payroll), ...Object.values(profile.recurringItems).flat(), ...profile.observedOvertimePremiums.fields];
  for (const f of allFields) for (const v of [98.22, -98.22, 3.1, 939.6, 892.91, -53.89]) assert.notEqual(f.value, v, `${f.key} must not carry a printed calibration figure`);
  const table = buildExtractionTable([{ documentIndex: 0, documentLabel: 'pasek.pdf', role: 'payslip', facts: doc.facts }]);
  assert.equal(table.find((r) => r.key === 'payslip.printedTableTax')?.value, -98.22, 'the extraction table keeps the value as read');
  assert.equal(table.find((r) => r.key === 'payslip.printedTableTax')?.destination, 'calibrationOnly');
});

// ---------------------------------------------------------------------------------------------
// #35 - raw sign preservation
// ---------------------------------------------------------------------------------------------

test('P3.1 S1 #35: for "Huisvesting 95,00-" the profile amount is 95 while the P2 fact stays -95 and the evidence keeps the printed minus', () => {
  const doc = payslip(0, 'pasek.pdf', rawPayslip({ net_lines: [housing(-95, 'Huisvesting 95,00-')] }));
  const facts = doc.facts as PayslipDocumentFacts;
  assert.equal(facts.netLines[0]?.amount, -95, 'the P2 fact is exactly as read');
  assert.equal(facts.netLines[0]?.evidence.rawValue, 'Huisvesting 95,00-');

  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [doc] });
  const [field] = profile.recurringItems.netDeductions;
  assert.equal(field?.value, 95);
  assert.equal(field?.candidates[0]?.value, 95);
  assert.equal(field?.candidates[0]?.detail?.amount, 95);
  const source = field?.sources[0];
  assert.deepEqual([source?.rawValue, source?.printedLabel, source?.page, source?.documentLabel], ['Huisvesting 95,00-', 'Huisvesting', 1, 'pasek.pdf']);
  assert.ok(source?.rawValue?.endsWith('-'), 'the printed trailing minus is preserved in the evidence');

  const table = buildExtractionTable([{ documentIndex: 0, documentLabel: 'pasek.pdf', role: 'payslip', facts: doc.facts }]);
  const row = table.find((r) => r.key === 'payslip.netLine.housing.amount');
  assert.deepEqual([row?.value, row?.rawValue, row?.destination], [-95, 'Huisvesting 95,00-', 'recurringItems.netDeductions'], 'the extraction table is unchanged: as read');
});

// ---------------------------------------------------------------------------------------------
// Focused regressions
// ---------------------------------------------------------------------------------------------

test('P3.1 S1: a positive amount is unchanged, and a printed zero stays a legal zero (never -0, never missing)', () => {
  const positive = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslip(0, 'a.pdf', rawPayslip({ net_lines: [housing(95, 'Huisvesting 95,00')] }))] });
  assert.equal(positive.recurringItems.netDeductions[0]?.value, 95);
  const zero = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslip(0, 'a.pdf', rawPayslip({ net_lines: [housing(0, 'Huisvesting 0,00')] }))] });
  const field = zero.recurringItems.netDeductions[0];
  assert.equal(field?.state, 'document_exact');
  assert.ok(Object.is(field?.value, 0), 'zero stays +0');
  assert.ok(Object.is(field?.candidates[0]?.detail?.amount, 0));
});

test('P3.1 S1: an unreadable amount stays an excluded reading - no number, no NaN, no zero is invented', () => {
  const unreadable = { description: 'Huisvesting', category: 'housing', amount: null, raw: 'Huisvesting 9?,00-', page: 1, unclear_fields: ['amount'] };
  const profile = resolvePayrollProfile({ asOfDate: AS_OF, documents: [payslip(0, 'a.pdf', rawPayslip({ net_lines: [unreadable] }))] });
  const field = profile.recurringItems.netDeductions[0];
  assert.equal(field?.state, 'unknown');
  assert.equal(field?.value, null);
  assert.deepEqual(field?.candidates, []);
  assert.equal(field?.excluded[0]?.reason, 'amount_unreadable');
  assert.equal(field?.excluded[0]?.detail?.amount, null);
});

test('P3.1 S1: percentages and hour-line amounts are unaffected - deduction rates unchanged, a negative correction line keeps its sign, deduction detail amounts are magnitudes', () => {
  const profile = resolvePayrollProfile({
    asOfDate: AS_OF,
    documents: [payslip(0, 'a.pdf', rawPayslip({
      hour_lines: [hourLine({ description: 'Correctie uren', hours: 4, rate: 16.2, amount: -64.8, raw: 'Correctie uren 4,00 16,20 -64,80' })],
      deduction_lines: [{ description: 'Pensioen StiPP', placement: 'pre_tax', category: 'pension', percent: 7.5, base: 295.06, amount: -22.13, raw: 'Pensioen StiPP 7,50% 295,06 22,13-', page: 1, unclear_fields: [] }],
    }))],
  });
  assert.equal(profile.payroll.pensionEmployeePercent.value, 7.5, 'a printed RATE is never touched by amount normalisation');
  assert.equal(profile.payroll.pensionEmployeePercent.candidates[0]?.detail?.amount, 22.13, 'the deduction line amount is a canonical magnitude');
  assert.equal(profile.payroll.pensionEmployeePercent.candidates[0]?.detail?.base, 295.06);
  assert.equal(profile.employment.hourlyRate.value, 16.2);
  assert.equal(profile.employment.hourlyRate.candidates[0]?.detail?.amount, -64.8, 'hour-line amounts keep their sign (engine policy: keep)');
});
