import { resolvePayrollProfile, type PayrollProfile, type ProfileDocumentInput } from '../payroll-engine/payroll-profile.js';
import { mergeContractBatches, mergePayslipBatches } from '../payroll-engine/document-facts.js';
import type { AgentInput, AgentOutcome, ConversationAgent } from '../conversation/conversation-agent.js';
import type { AgentOutput } from '../conversation/scenario-patch.js';
import type { ScenarioV1 } from '../scenario/scenario-types.js';
import { contractBatch, found, payslipBatch, rawContract, rawPayslip } from './fact-fixtures.js';

export { RATES_2026 } from './scenario-fixtures.js';

/** A scripted model: returns the given outcomes in order and records every call (and its input). */
export interface ScriptedAgent extends ConversationAgent {
  calls: number;
  inputs: AgentInput[];
}

export function scriptedAgent(outcomes: AgentOutcome[]): ScriptedAgent {
  let i = 0;
  const agent: ScriptedAgent = {
    provider: 'scripted',
    model: 'scripted',
    calls: 0,
    inputs: [],
    async interpret(input: AgentInput): Promise<AgentOutcome> {
      agent.calls++;
      agent.inputs.push(structuredClone(input));
      return outcomes[i++] ?? { status: 'provider_error' };
    },
  };
  return agent;
}

export const ok = (output: AgentOutput): AgentOutcome => ({ status: 'ok', output });
export const out = (intent: AgentOutput['intent'], ops: AgentOutput['patch']['ops'], hint?: AgentOutput['hint']): AgentOutcome =>
  ok({ intent, patch: { version: 1, ops }, ...(hint ? { hint } : {}) });

/** A known value node. Typed loosely on purpose (tests build values of every field kind with it). */
export const known = (value: unknown, source = 'user', ref?: string): never => ({ state: 'known', value, source, ...(ref ? { ref } : {}) }) as never;

/** A Scenario built from plain parts (values are wrapped as `user` knowns unless already nodes). */
export function scenario(parts: { work?: Record<string, unknown>; pay?: Record<string, unknown>; tax?: Record<string, unknown>; deductions?: Record<string, unknown>; extras?: Record<string, unknown>; requestedConcepts?: unknown[] } = {}): ScenarioV1 {
  return {
    schemaVersion: 1,
    scenarioId: 'conv-test',
    periodType: 'week',
    work: (parts.work ?? {}) as ScenarioV1['work'],
    pay: (parts.pay ?? {}) as ScenarioV1['pay'],
    tax: (parts.tax ?? {}) as ScenarioV1['tax'],
    ...(parts.deductions ? { deductions: parts.deductions as ScenarioV1['deductions'] } : {}),
    ...(parts.extras ? { extras: parts.extras as ScenarioV1['extras'] } : {}),
    ...(parts.requestedConcepts ? { requestedConcepts: parts.requestedConcepts as ScenarioV1['requestedConcepts'] } : {}),
  };
}

/** 40 weekday hours, rate 16.80 (user), tax credit applied, deductions estimate - computes. */
export function readyScenario(): ScenarioV1 {
  return scenario({
    work: { regularWeekdayHours: known(40) },
    pay: { hourlyRate: known(16.8) },
    tax: { loonheffingskorting: known('applied') },
    deductions: { mode: known('estimate', 'loonto_assumption') },
  });
}

/** A REAL Payroll Profile resolved from synthetic document facts: contract + payslip agree on 16.20/h
 * (corroborated), contract states 40 h/week. */
export function documentProfile(): PayrollProfile {
  const docs: ProfileDocumentInput[] = [
    { index: 0, documentId: 'doc-contract-1', label: 'umowa.pdf', role: 'contract_base', effectiveDate: null, facts: mergeContractBatches([contractBatch(rawContract({ hourly_rate: found(16.2, '€ 16,20 bruto per uur', 1, 'Uurloon'), hours_per_week: found(40, '40 uur per week', 1, 'Arbeidsduur') }))]) },
    { index: 1, documentId: 'doc-payslip-1', label: 'pasek.pdf', role: 'payslip', effectiveDate: null, facts: mergePayslipBatches([payslipBatch(rawPayslip())]) },
  ];
  return resolvePayrollProfile({ asOfDate: '2026-06-01', documents: docs });
}

/** Every key anywhere in a JSON value. */
export function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, into));
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}
