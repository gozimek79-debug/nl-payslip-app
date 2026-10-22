/**
 * AI-001 App / Capability Registry - the SERVER's map of Loonto's customer-facing modules (CEO product map v1.0,
 * `LOONTO-AI-ADVISOR-ARCHITEKTURA-v1.0-PL.md` §1). The advisor learns what exists and what really works only from here;
 * a module that is `coming_soon` is never described as available. Navigation targets are the interface's own module
 * keys (apps/frontend-react/src/App.tsx), nothing else can be navigated to.
 */

export const NAVIGATION_TARGETS = ['calculator_free', 'calculator_pro', 'analysis_contract', 'analysis_payslip', 'glossary', 'account'] as const;
export type NavigationTarget = (typeof NAVIGATION_TARGETS)[number];

export type ModuleStatus = 'available' | 'alpha' | 'coming_soon';

export interface AppModule {
  id: string;
  group: 'calculator' | 'document_analysis' | 'glossary' | 'account';
  status: ModuleStatus;
  target: NavigationTarget;
  /** Pricing is decided per stage (AI-005); only the free calculator is fixed as free. */
  priceTier: 'free' | 'pro' | 'not_decided';
  usesAi: boolean;
  requiresLogin: boolean;
  /** What the module is for, in plain English - for the model to explain in the user's language. */
  purpose: string;
  /** What it does NOT do (yet) - so the model never over-promises. */
  limits: string;
}

export const APP_MODULES: readonly AppModule[] = [
  {
    id: 'free_calculator', group: 'calculator', status: 'available', target: 'calculator_free', priceTier: 'free', usesAi: false, requiresLogin: false,
    purpose: 'Free quick calculator: the user enters hours, hourly rate and a few settings and gets an estimate of weekly pay from Loonto\'s deterministic payroll engine (incl. an estimated tax). No AI, no documents, no login.',
    limits: 'Uses only what the user types; does not read documents; no conversation.',
  },
  {
    id: 'pro_advisor', group: 'calculator', status: 'alpha', target: 'calculator_pro', priceTier: 'pro', usesAi: true, requiresLogin: false,
    purpose: 'Calculator PRO with this AI advisor: conversation about pay, reading the user\'s payslip or contract (Gemini reader), answering from the printed facts, and a base-wage orientation (hours x base hourly rate).',
    limits: 'Private alpha. Cannot yet calculate gross pay, net / take-home pay, tax, premiums or holiday pay; the orientation excludes all of them.',
  },
  {
    id: 'contract_analysis', group: 'document_analysis', status: 'available', target: 'analysis_contract', priceTier: 'not_decided', usesAi: true, requiresLogin: false,
    purpose: 'Contract analysis: upload an employment contract to read its key terms (hourly rate, hours, contract type, CAO name, notice and similar).',
    limits: 'Shows what the contract says; it is not legal advice and does not judge whether terms are lawful.',
  },
  {
    id: 'payslip_analysis', group: 'document_analysis', status: 'available', target: 'analysis_payslip', priceTier: 'not_decided', usesAi: true, requiresLogin: false,
    purpose: 'Payslip analysis: upload ONE payslip; Loonto reads it (Gemini reader, explicit consent) and shows what is printed - period, rate, hours, pay lines, deductions, reimbursements, printed gross / net / payout kept apart - plus where the payslip\'s own figures do not add up, and, only when every input is readable, how its tax / net / payout compare with Loonto\'s calculation.',
    limits: 'One payslip at a time - no comparison of periods yet. It checks arithmetic and reading, not legal entitlements, the CAO, premium rates or the correctness of the employer\'s pay; a difference is a reason to check, never proof of an error. The user can then ask this advisor about the same payslip.',
  },
  {
    id: 'glossary', group: 'glossary', status: 'available', target: 'glossary', priceTier: 'free', usesAi: false, requiresLogin: false,
    purpose: 'Searchable PL/EN glossary of 25 Dutch employment and payroll terms, with Dutch, Polish and English names and general explanations.',
    limits: 'General educational explanations only, not legal advice or verified individual CAO entitlements.',
  },
  {
    id: 'account', group: 'account', status: 'available', target: 'account', priceTier: 'free', usesAi: false, requiresLogin: true,
    purpose: 'Account: sign in with an e-mail link, see history, delete own data.',
    limits: 'Optional.',
  },
];

export function capabilitiesForModel() {
  return {
    modules: APP_MODULES.map((m) => ({ id: m.id, group: m.group, status: m.status, navigation_target: m.target, price_tier: m.priceTier, uses_ai: m.usesAi, requires_login: m.requiresLogin, purpose: m.purpose, limits: m.limits })),
    advisor_features: {
      read_uploaded_document: 'available (the user attaches it in this module; reading is an explicit user action)',
      answer_from_document_facts: 'available',
      base_wage_orientation: 'available - hours x base hourly rate only',
      gross_or_net_pay_calculation: 'not_available_yet',
      cao_or_legal_rule_lookup: 'not_available_yet',
    },
    // AI-001 P0-3: what the advisor's knowledge rests on. There is no verified legal / CAO / tax source behind it yet.
    knowledge_sources: {
      verified_dutch_labour_law: 'none in this version',
      cao_texts_or_rates: 'none in this version - Loonto does not know which CAO applies to the user or what it pays',
      tax_tables_for_the_advisor: 'none - the advisor does not calculate tax or net pay',
      general_explanations: 'allowed only as general, nonbinding information, never as the user\'s entitlement or a guarantee',
    },
  };
}

export function moduleByTarget(target: NavigationTarget): AppModule | undefined {
  return APP_MODULES.find((m) => m.target === target);
}
