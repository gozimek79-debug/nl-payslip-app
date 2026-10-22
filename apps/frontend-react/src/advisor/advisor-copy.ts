import { R3B_COPY, type R3BCopy } from '../r3b/r3b-copy.ts';
import type { AdvisorFailure, AdvisorLocale, NavigationOffer, OrientationView } from './advisor-client.ts';
import type { ThreadItem } from './advisor-store.ts';

/**
 * AI-001 AI Advisor - interface chrome ONLY: headings, labels, error and safety notices. Nothing here answers the user:
 * every advisor message is the model's own text. The document list, file rejections and the reader consent are the
 * existing R3-B wording (the same reader, the same consent), reused rather than rewritten.
 */

type InfoKind = Extract<ThreadItem, { kind: 'info' }>['info'];

export interface AdvisorCopy {
  pageTitle: string;
  title: string;
  badge: string;
  lead: string;
  alphaNote: string;
  privacyNote: string;
  scopeNote: string;
  threadLabel: string;
  advisorName: string;
  youName: string;
  emptyThread: string;
  composer: { inputLabel: string; placeholder: string; send: string; busy: string; tooLong: string };
  failures: Record<AdvisorFailure, string>;
  info: Record<InfoKind, string>;
  retry: string;
  reset: string;
  unavailableTitle: string;
  unavailableBody: string;
  checking: string;
  tools: { label: string; names: Record<string, string>; refused: string };
  modelLabel: (model: string) => string;
  orientation: {
    title: string;
    formula: (hours: string, rate: string, amount: string) => string;
    basis: (basis: string) => string;
    rateSource: (source: string) => string;
    excludesTitle: string;
    excludes: Record<string, string>;
    note: string;
  };
  navigation: { title: string; targets: Record<NavigationOffer['target'], string>; status: Record<NavigationOffer['status'], string>; open: (label: string) => string };
  documents: {
    title: string;
    lead: string;
    addPayslip: string;
    addContract: string;
    read: (n: number) => string;
    reading: string;
    readerUnavailable: string;
    inContext: string;
  };
  /** The R3-B document wording, reused as is (document names, statuses, rejections, reader errors, consent). */
  r3b: R3BCopy;
  fallback: { title: string; documentsPro: string; r3b: string };
}

const money = (value: number, lang: AdvisorLocale) => new Intl.NumberFormat(lang === 'pl' ? 'pl-PL' : 'en-GB', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(value);
const hoursText = (value: number, lang: AdvisorLocale) => new Intl.NumberFormat(lang === 'pl' ? 'pl-PL' : 'en-GB', { maximumFractionDigits: 2 }).format(value);

export function orientationFigures(o: OrientationView, lang: AdvisorLocale): { hours: string; rate: string; amount: string } {
  return { hours: hoursText(o.hours, lang), rate: money(o.hourlyRate, lang), amount: money(o.amount, lang) };
}

const perDay = /^per_day_([\d.]+)_x_(\d+)_days$/;

const pl: AdvisorCopy = {
  pageTitle: 'Loonto — Kalkulator PRO (doradca AI)',
  title: 'Kalkulator PRO — doradca AI',
  badge: 'Wersja testowa (Alpha)',
  lead: 'Zapytaj o godziny, stawki, dodatki albo o swoje dokumenty. Odpowiedź pisze model AI.',
  alphaNote: 'Wersja testowa dostępna tylko dla właściciela. Używaj wyłącznie danych i dokumentów przykładowych.',
  privacyNote: 'Twoje wiadomości trafiają do modelu AI (Groq). Nie wpisuj imienia, numeru BSN, IBAN ani nazwy pracodawcy. Z dokumentów model dostaje tylko odczytane pozycje (np. „dodatek nocny”), bez danych osobowych i bez treści pliku.',
  scopeNote: 'Doradca nie oblicza wynagrodzenia brutto, netto ani podatku. Kwoty pochodzą tylko z Twoich wiadomości, Twoich dokumentów lub orientacyjnego narzędzia Loonto.',
  threadLabel: 'Rozmowa z doradcą',
  advisorName: 'Doradca AI',
  youName: 'Ty',
  emptyThread: 'Napisz pytanie poniżej. Możesz też najpierw dodać pasek wypłaty lub umowę.',
  composer: { inputLabel: 'Twoja wiadomość', placeholder: 'Napisz pytanie…', send: 'Wyślij', busy: 'Doradca pisze odpowiedź…', tooLong: 'Maksymalnie 1000 znaków.' },
  failures: {
    advisor_unavailable: 'AI doradca jest chwilowo niedostępny. Spróbuj ponownie za chwilę.',
    advisor_not_configured: 'AI doradca jest chwilowo niedostępny w tym środowisku — nie ma skonfigurowanego modelu. Darmowy kalkulator działa bez AI.',
    answer_withheld: 'Odpowiedź doradcy nie przeszła kontroli Loonto (kwota bez źródła albo opisana niezgodnie ze źródłem, albo uprawnienie podane jako pewne bez weryfikacji), więc jej nie pokazujemy. Spróbuj ponownie albo zapytaj inaczej.',
    conversation_invalid: 'Nie udało się wznowić rozmowy. Zacznij nową rozmowę.',
    document_context_invalid: 'Odczyt dokumentów nie jest już dostępny. Odczytaj dokumenty ponownie.',
    rate_limited: 'Za dużo pytań w krótkim czasie. Odczekaj kilka minut.',
    invalid: 'Tej wiadomości nie da się wysłać (najwyżej 1000 znaków).',
    timeout: 'Doradca nie odpowiedział na czas. Spróbuj ponownie.',
    network: 'Brak połączenia z Loonto. Sprawdź internet i spróbuj ponownie.',
    server: 'Coś poszło nie tak po stronie Loonto. Spróbuj ponownie.',
  },
  info: {
    conversation_restarted: 'Poprzednia rozmowa wygasła — zaczynamy nową. Wcześniejsze ustalenia trzeba podać jeszcze raz.',
    document_expired: 'Odczyt dokumentów wygasł — doradca już ich nie widzi. Możesz odczytać je ponownie.',
    document_read: 'Dokumenty odczytane. Doradca może teraz odpowiadać na ich podstawie.',
    document_partial: 'Dokumenty odczytane, ale nie wszystkie strony — doradca widzi tylko odczytaną część.',
    document_from_analysis: 'Doradca widzi pasek odczytany w Analizie pasków (ten sam odczyt, bez ponownego wysyłania pliku). Możesz o niego zapytać.',
    document_failed: 'Nie udało się odczytać co najmniej jednego dokumentu — doradca go nie widzi.',
  },
  retry: 'Spróbuj ponownie',
  reset: 'Nowa rozmowa',
  unavailableTitle: 'AI doradca jest chwilowo niedostępny',
  unavailableBody: 'W tym środowisku nie ma skonfigurowanego modelu AI, więc doradca nie może odpowiadać. Nie pokazujemy zastępczych odpowiedzi. Możesz skorzystać z darmowego kalkulatora albo z poprzedniej wersji PRO.',
  checking: 'Sprawdzam dostępność doradcy…',
  tools: {
    label: 'Użyte narzędzia:',
    names: {
      get_app_capabilities: 'moduły Loonto', get_document_facts: 'Twoje dokumenty', get_scenario_state: 'stan rozmowy',
      update_scenario: 'zapis Twoich danych', calculate_base_wage_orientation: 'orientacja: stawka × godziny', offer_navigation: 'przejście do modułu',
    },
    refused: 'odmowa',
  },
  modelLabel: (model) => `Odpowiedź napisał model AI (${model}).`,
  orientation: {
    title: 'Orientacyjnie: tylko stawka podstawowa',
    formula: (hours, rate, amount) => `${hours} h × ${rate}/h = ${amount}`,
    basis: (basis) => {
      const m = perDay.exec(basis);
      if (m) return `Godziny: podane przez Ciebie, ${m[1]} h dziennie × ${m[2]} dni.`;
      return basis === 'total_stated_by_user' ? 'Godziny: łączna liczba podana przez Ciebie.' : 'Godziny: podane przez Ciebie.';
    },
    rateSource: (source) => (source === 'document_reading' ? 'Stawka: odczytana z Twojego dokumentu (nie zweryfikowana).' : source === 'user' || source === 'correction' ? 'Stawka: podana przez Ciebie.' : 'Stawka: z bieżącej rozmowy.'),
    excludesTitle: 'Nie obejmuje:',
    excludes: {
      weekend_night_overtime_holiday_premiums: 'dodatków za weekend, noc, nadgodziny i święta',
      holiday_pay_vakantiegeld: 'dodatku urlopowego (vakantiegeld)',
      tax_loonheffing: 'podatku (loonheffing)',
      deductions_pension_and_other: 'potrąceń, w tym emerytalnych',
      gross_and_net_pay: 'wynagrodzenia brutto i netto',
    },
    note: 'To zwykłe mnożenie godzin przez stawkę — nie jest to Twoja wypłata.',
  },
  navigation: {
    title: 'Moduły Loonto',
    targets: { calculator_free: 'Darmowy kalkulator', calculator_pro: 'Kalkulator PRO', analysis_contract: 'Analiza umowy', analysis_payslip: 'Analiza pasków wypłat', glossary: 'Słownik', account: 'Konto i historia' },
    status: { available: 'dostępne', alpha: 'wersja testowa', coming_soon: 'W przygotowaniu' },
    open: (label) => `Otwórz: ${label}`,
  },
  documents: {
    title: 'Dokumenty (opcjonalnie)',
    lead: 'Dodaj pasek wypłaty lub umowę, a doradca odpowie na ich podstawie.',
    addPayslip: 'Dodaj pasek wypłaty',
    addContract: 'Dodaj umowę',
    read: R3B_COPY.pl.offer.read,
    reading: R3B_COPY.pl.offer.reading,
    readerUnavailable: R3B_COPY.pl.offer.readerUnavailable,
    inContext: 'Doradca widzi odczytane dokumenty.',
  },
  r3b: R3B_COPY.pl,
  fallback: { title: 'Poprzednie wersje', documentsPro: 'Poprzednia wersja PRO (dokumenty)', r3b: 'Poprzednia rozmowa testowa (R3-B)' },
};

const en: AdvisorCopy = {
  pageTitle: 'Loonto — PRO calculator (AI advisor)',
  title: 'PRO calculator — AI advisor',
  badge: 'Test version (Alpha)',
  lead: 'Ask about hours, rates, premiums or your documents. The answer is written by an AI model.',
  alphaNote: 'Test version for the owner only. Use sample data and sample documents only.',
  privacyNote: 'Your messages go to an AI model (Groq). Do not type your name, BSN, IBAN or employer name. From documents the model only receives the read items (e.g. "night premium"), without personal data and without the file content.',
  scopeNote: 'The advisor does not calculate gross pay, net pay or tax. Amounts come only from your messages, your documents or a Loonto orientation tool.',
  threadLabel: 'Conversation with the advisor',
  advisorName: 'AI advisor',
  youName: 'You',
  emptyThread: 'Type a question below. You can also add a payslip or a contract first.',
  composer: { inputLabel: 'Your message', placeholder: 'Type a question…', send: 'Send', busy: 'The advisor is writing…', tooLong: 'At most 1000 characters.' },
  failures: {
    advisor_unavailable: 'The AI advisor is temporarily unavailable. Please try again shortly.',
    advisor_not_configured: 'The AI advisor is temporarily unavailable in this environment — no model is configured. The free calculator works without AI.',
    answer_withheld: 'The advisor\'s answer did not pass Loonto\'s check (an amount without a source or described differently from its source, or an entitlement stated as certain without verification), so it is not shown. Try again or ask differently.',
    conversation_invalid: 'The conversation could not be resumed. Start a new conversation.',
    document_context_invalid: 'The document reading is no longer available. Read the documents again.',
    rate_limited: 'Too many questions in a short time. Please wait a few minutes.',
    invalid: 'This message cannot be sent (1000 characters at most).',
    timeout: 'The advisor did not answer in time. Please try again.',
    network: 'No connection to Loonto. Check your internet and try again.',
    server: 'Something went wrong on Loonto\'s side. Please try again.',
  },
  info: {
    conversation_restarted: 'The previous conversation expired — starting a new one. Earlier details need to be given again.',
    document_expired: 'The document reading expired — the advisor no longer sees it. You can read the documents again.',
    document_read: 'Documents read. The advisor can now answer from them.',
    document_partial: 'Documents read, but not every page — the advisor only sees the part that was read.',
    document_from_analysis: 'The advisor sees the payslip read in Payslip analysis (the same reading, no file sent again). You can ask about it.',
    document_failed: 'At least one document could not be read — the advisor does not see it.',
  },
  retry: 'Try again',
  reset: 'New conversation',
  unavailableTitle: 'The AI advisor is temporarily unavailable',
  unavailableBody: 'No AI model is configured in this environment, so the advisor cannot answer. We do not show substitute answers. You can use the free calculator or the previous PRO version.',
  checking: 'Checking whether the advisor is available…',
  tools: {
    label: 'Tools used:',
    names: {
      get_app_capabilities: 'Loonto modules', get_document_facts: 'your documents', get_scenario_state: 'conversation state',
      update_scenario: 'saving your details', calculate_base_wage_orientation: 'orientation: rate × hours', offer_navigation: 'link to a module',
    },
    refused: 'refused',
  },
  modelLabel: (model) => `Answer written by an AI model (${model}).`,
  orientation: {
    title: 'Indicative: base rate only',
    formula: (hours, rate, amount) => `${hours} h × ${rate}/h = ${amount}`,
    basis: (basis) => {
      const m = perDay.exec(basis);
      if (m) return `Hours: given by you, ${m[1]} h a day × ${m[2]} days.`;
      return basis === 'total_stated_by_user' ? 'Hours: the total you gave.' : 'Hours: given by you.';
    },
    rateSource: (source) => (source === 'document_reading' ? 'Rate: read from your document (not verified).' : source === 'user' || source === 'correction' ? 'Rate: given by you.' : 'Rate: from this conversation.'),
    excludesTitle: 'Does not include:',
    excludes: {
      weekend_night_overtime_holiday_premiums: 'weekend, night, overtime and holiday premiums',
      holiday_pay_vakantiegeld: 'holiday allowance (vakantiegeld)',
      tax_loonheffing: 'tax (loonheffing)',
      deductions_pension_and_other: 'deductions, including pension',
      gross_and_net_pay: 'gross and net pay',
    },
    note: 'This is plain hours × rate — it is not your pay.',
  },
  navigation: {
    title: 'Loonto modules',
    targets: { calculator_free: 'Free calculator', calculator_pro: 'PRO calculator', analysis_contract: 'Contract analysis', analysis_payslip: 'Payslip analysis', glossary: 'Dictionary', account: 'Account and history' },
    status: { available: 'available', alpha: 'test version', coming_soon: 'In preparation' },
    open: (label) => `Open: ${label}`,
  },
  documents: {
    title: 'Documents (optional)',
    lead: 'Add a payslip or a contract and the advisor will answer from them.',
    addPayslip: 'Add a payslip',
    addContract: 'Add a contract',
    read: R3B_COPY.en.offer.read,
    reading: R3B_COPY.en.offer.reading,
    readerUnavailable: R3B_COPY.en.offer.readerUnavailable,
    inContext: 'The advisor sees the read documents.',
  },
  r3b: R3B_COPY.en,
  fallback: { title: 'Previous versions', documentsPro: 'Previous PRO version (documents)', r3b: 'Previous test conversation (R3-B)' },
};

export const ADVISOR_COPY: Record<AdvisorLocale, AdvisorCopy> = { pl, en };
