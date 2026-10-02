import {
  PAYSLIP_SCALAR_KEYS, CONTRACT_SCALAR_KEYS, CALIBRATION_ONLY_PAYSLIP_KEYS,
  type DocumentFacts, type PayslipDocumentFacts, type ContractDocumentFacts, type FactStatus, type FactEvidence,
  type LineIssue, type PayrollFact, type PayslipScalarKey, type ContractScalarKey,
} from './document-facts.js';
import type { ProfileDocumentRole } from './payroll-profile.js';

/**
 * P2 (ZADANIE-P2-LOONTO-PRO.md §P2.14): the developer/reference extraction table - one row per
 * extracted fact (and one `absent` row per expected scalar the document does not print), with its
 * normalised value, raw text, page, printed label, status/reason and the PayrollProfile field or
 * evidence bucket it feeds. Built from the same merged facts the resolver consumes, so what a
 * reviewer compares against the document is exactly what entered the profile. Not customer UX.
 */
export interface ExtractionTableRow {
  documentIndex: number;
  documentLabel: string;
  role: ProfileDocumentRole;
  key: string;
  value: string | number | null;
  rawValue: string | null;
  page: number | null;
  printedLabel: string | null;
  status: FactStatus;
  reason: string | null;
  /** Profile path / evidence bucket, e.g. `employment.hourlyRate`, `observedOvertimePremiums`,
   * `calibrationOnly`, `not_mapped` (a fact P2 extracts but no profile field consumes yet). */
  destination: string;
}

const PAYSLIP_DESTINATIONS: Record<PayslipScalarKey, string> = {
  periodLabel: 'documents[].payPeriod', periodStart: 'documents[].payPeriod', periodEnd: 'documents[].payPeriod',
  paymentDate: 'documents[].payPeriod', periodType: 'payroll.periodType', hirerName: 'employment.hirerName',
  hoursPerWeek: 'employment.hoursPerWeek', bijzonderTariefPercent: 'payroll.bijzonderTariefPrintedPercent',
  jaarloonBt: 'payroll.jaarloonBt', etExchangeAmount: 'payroll.etExchangeAmount',
  minimumWagePrinted: 'calibrationOnly', printedTableTax: 'calibrationOnly', printedBtTax: 'calibrationOnly',
  printedAlgemeneHeffingskorting: 'calibrationOnly', printedArbeidskorting: 'calibrationOnly', printedGrossTotal: 'calibrationOnly',
  printedLoonVoorHeffingen: 'calibrationOnly', printedTaxableBaseNormal: 'calibrationOnly', printedTaxableBaseSpecial: 'calibrationOnly',
  printedNet: 'calibrationOnly', printedPayout: 'calibrationOnly',
};

const CONTRACT_DESTINATIONS: Record<ContractScalarKey, string> = {
  employerName: 'employment.employerName', hirerName: 'employment.contractHirerName', contractType: 'employment.contractType',
  functionTitle: 'employment.functionTitle', caoName: 'employment.caoName', caoPhase: 'employment.phase',
  pensionFund: 'employment.pensionFundName', startDate: 'employment.contractStartDate', endDate: 'employment.contractEndDate',
  effectiveDate: 'contractContext.annexDates', hourlyRate: 'employment.hourlyRate', monthlySalary: 'employment.monthlySalary',
  hoursPerWeek: 'employment.hoursPerWeek', guaranteedHours: 'employment.guaranteedHours',
  guaranteedHoursPeriodWeeks: 'employment.guaranteedHoursPeriodWeeks', overtimeThresholdHours: 'employment.overtimeThresholdHours',
};

const DEDUCTION_DESTINATIONS: Record<string, string> = {
  'pre_tax:pension': 'payroll.pensionEmployeePercent', 'pre_tax:paww': 'payroll.pawwEmployeePercent',
  'pre_tax:ziektewet': 'payroll.sectorPremiumPercent', 'pre_tax:wga_gat': 'payroll.wgaGatEmployeePercent',
  'post_tax:wga': 'payroll.wgaEmployeePercent', 'post_tax:gediff_wga': 'payroll.gediffWgaEmployeePercent',
  'post_tax:whk': 'payroll.whkEmployeePercent',
};

interface DocMeta {
  documentIndex: number;
  documentLabel: string;
  role: ProfileDocumentRole;
}

function scalarRows(meta: DocMeta, key: string, occurrences: PayrollFact[], destination: string): ExtractionTableRow[] {
  if (occurrences.length === 0) {
    return [{ ...meta, key, value: null, rawValue: null, page: null, printedLabel: null, status: 'absent', reason: null, destination }];
  }
  return occurrences.map((f) => ({
    ...meta, key, value: f.value, rawValue: f.evidence.rawValue, page: f.evidence.page, printedLabel: f.evidence.printedLabel,
    status: f.status, reason: f.reason, destination,
  }));
}

/** One row for one line, reporting the sub-field that carries the line's forward meaning. */
function lineRow(meta: DocMeta, key: string, evidence: FactEvidence, value: number | null, issue: LineIssue | undefined, destination: string): ExtractionTableRow {
  return {
    ...meta, key, value, rawValue: evidence.rawValue, page: evidence.page, printedLabel: evidence.printedLabel,
    status: issue ? issue.status : value === null ? 'absent' : 'exact',
    reason: issue ? issue.reason : null,
    destination,
  };
}

function payslipRows(meta: DocMeta, facts: PayslipDocumentFacts): ExtractionTableRow[] {
  const rows: ExtractionTableRow[] = [];
  for (const key of PAYSLIP_SCALAR_KEYS) rows.push(...scalarRows(meta, `payslip.${key}`, facts.scalars[key], PAYSLIP_DESTINATIONS[key]));
  rows.push(...scalarRows(meta, 'payslip.employerName', facts.employerNames, 'employment.payslipEmployerName'));
  for (const l of facts.hourLines) {
    const issue = (f: LineIssue['field']) => l.issues.find((i) => i.field === f);
    if (l.kind === 'regular') rows.push(lineRow(meta, 'payslip.hourLine.regular.rate', l.evidence, l.rate, issue('rate'), 'employment.hourlyRate'));
    else if (l.kind === 'overtime' && l.addsHours === true) {
      const tier = l.explicitTier ? ` + payroll.overtimeTier${l.explicitTier}Premium` : '';
      rows.push(lineRow(meta, 'payslip.hourLine.overtime.percent', l.evidence, l.percent, issue('percent'), `observedOvertimePremiums${tier}`));
    } else if (l.kind === 'overtime' && l.addsHours === null) {
      rows.push({ ...lineRow(meta, 'payslip.hourLine.overtime.percent', l.evidence, l.percent, issue('percent'), 'observedOvertimePremiums.excluded'), status: 'ambiguous', reason: 'adds_hours_unclear' });
    } else if (l.kind === 'overtime' || l.kind === 'irregular_surcharge' || l.kind === 'adv_compensation') {
      rows.push(lineRow(meta, `payslip.hourLine.${l.kind === 'overtime' ? 'overtime_surcharge' : l.kind}.percent`, l.evidence, l.percent, issue('percent'), 'recurringItems.surcharges'));
    } else rows.push(lineRow(meta, 'payslip.hourLine.other.amount', l.evidence, l.amount, issue('amount'), 'not_mapped'));
  }
  for (const d of facts.deductionLines) {
    const destination = DEDUCTION_DESTINATIONS[`${d.placement}:${d.category}`] ?? (d.placement === 'pre_tax' ? 'recurringItems.otherPreTaxDeductions' : 'recurringItems.otherPostTaxDeductions');
    rows.push(lineRow(meta, `payslip.deduction.${d.placement}.${d.category}.percent`, d.evidence, d.percent, d.issues.find((i) => i.field === 'percent'), destination));
  }
  for (const n of facts.netLines) {
    rows.push(lineRow(meta, `payslip.netLine.${n.category}.amount`, n.evidence, n.amount, n.issues.find((i) => i.field === 'amount'), n.category === 'reimbursement' ? 'recurringItems.netAdditions' : 'recurringItems.netDeductions'));
  }
  for (const e of facts.etReimbursementLines) rows.push(lineRow(meta, 'payslip.etReimbursement.amount', e.evidence, e.amount, e.issues.find((i) => i.field === 'amount'), 'recurringItems.netAdditions'));
  for (const p of facts.payoutAdjustmentLines) rows.push(lineRow(meta, 'payslip.payoutAdjustment.amount', p.evidence, p.amount, p.issues.find((i) => i.field === 'amount'), 'replay_only'));
  for (const r of facts.reservationLines) {
    rows.push(lineRow(meta, `payslip.reservation.${r.type}.accrued`, r.evidence, r.accrued, r.issues.find((i) => i.field === 'accrued'), r.type === 'vakantiegeld' ? 'payroll.vakantiegeldAccrualPercent (excluded: not_a_forward_rate)' : 'not_mapped'));
  }
  return rows;
}

const PREMIUM_DESTINATIONS: Record<string, string> = {
  overtime: 'observedOvertimePremiums', irregular_hours: 'recurringItems.surcharges', saturday: 'payroll.saturdayPremium',
  sunday: 'payroll.sundayPremium', public_holiday: 'payroll.publicHolidayPremium', other: 'not_mapped',
};

function contractRows(meta: DocMeta, facts: ContractDocumentFacts): ExtractionTableRow[] {
  const rows: ExtractionTableRow[] = [];
  for (const key of CONTRACT_SCALAR_KEYS) rows.push(...scalarRows(meta, `contract.${key}`, facts.scalars[key], CONTRACT_DESTINATIONS[key]));
  for (const p of facts.premiums) {
    const tier = p.category === 'overtime' && p.explicitTier ? ` + payroll.overtimeTier${p.explicitTier}Premium` : '';
    rows.push({
      ...meta,
      key: `contract.premium.${p.category}.${p.semantics}`,
      value: p.percent,
      rawValue: p.evidence.rawValue,
      page: p.evidence.page,
      printedLabel: p.evidence.printedLabel,
      status: p.status,
      reason: p.reason ?? (p.status === 'exact' && p.semantics === 'unclear' ? 'percent_semantics_ambiguous' : null),
      destination: `${PREMIUM_DESTINATIONS[p.category] ?? 'not_mapped'}${tier}`,
    });
  }
  return rows;
}

export function buildExtractionTable(documents: Array<DocMeta & { facts: DocumentFacts }>): ExtractionTableRow[] {
  return documents.flatMap((d) => {
    const meta: DocMeta = { documentIndex: d.documentIndex, documentLabel: d.documentLabel, role: d.role };
    return d.facts.kind === 'payslip' ? payslipRows(meta, d.facts) : contractRows(meta, d.facts);
  });
}

export { CALIBRATION_ONLY_PAYSLIP_KEYS };
