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
  /** FIN-03: the engine-result card (labels only - every figure comes from the server's engine result). */
  calculation: {
    title: string;
    blockedTitle: string;
    unsupportedTitle: string;
    invalidTitle: string;
    ratesUnavailable: string;
    gross: string;
    tax: string;
    net: string;
    payout: string;
    range: (low: string, high: string) => string;
    basedOn: string;
    sources: Record<'user_stated' | 'document_reading' | 'loonto_assumption' | 'other', string>;
    assumptions: string;
    rates: (source: 'database' | 'static' | null, asOf: string) => string;
    estimateNote: string;
    missingAssumption: string;
    unsupported: Record<string, string>;
    choices: Record<string, string>;
  };
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
  scopeNote: 'Brutto, podatek i netto liczy tylko silnik Loonto — jako szacunek za 1 tydzień, gdy zna wszystkie potrzebne dane. To nie jest potwierdzona wypłata pracodawcy. Inne kwoty pochodzą tylko z Twoich wiadomości, Twoich dokumentów lub orientacyjnego narzędzia Loonto.',
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
      update_scenario: 'zapis Twoich danych', calculate_base_wage_orientation: 'orientacja: stawka × godziny', evaluate_payroll_scenario: 'wyliczenie Loonto',
      offer_navigation: 'przejście do modułu',
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
  calculation: {
    title: 'Wyliczenie Loonto — szacunek za 1 tydzień',
    blockedTitle: 'Do wyliczenia brakuje:',
    unsupportedTitle: 'Tego Loonto jeszcze nie liczy:',
    invalidTitle: 'Tych danych nie da się policzyć:',
    ratesUnavailable: 'Loonto nie ma teraz tabel podatkowych na dziś, więc niczego nie liczy.',
    gross: 'Brutto (wyliczone)',
    tax: 'Podatek (wyliczony)',
    net: 'Netto (wyliczone)',
    payout: 'Do wypłaty (wyliczone)',
    range: (low, high) => `Zakres do wypłaty: ${low} – ${high} (część danych ma warianty lub jest szacunkiem).`,
    basedOn: 'Na podstawie:',
    sources: { user_stated: 'podane przez Ciebie', document_reading: 'odczyt z dokumentu', loonto_assumption: 'założenie Loonto', other: 'inne' },
    assumptions: 'Założenia Loonto użyte w wyliczeniu — nie są to dane z Twojej umowy ani paska.',
    rates: (source, asOf) => (source === 'static'
      ? `Tabele podatkowe: zapasowe (mogą być nieaktualne), stan na ${asOf}.`
      : `Tabele podatkowe: aktualne z bazy Loonto, stan na ${asOf}.`),
    estimateNote: 'To szacunek z podanych danych — nie potwierdzona wypłata pracodawcy ani uprawnienie.',
    missingAssumption: 'Loonto może to oszacować, jeśli się zgodzisz.',
    unsupported: {
      night_premium: 'dodatek nocny', evening_premium: 'dodatek wieczorny', shift_premium: 'dodatek zmianowy', surcharge_on_counted_hours: 'dodatek od już liczonych godzin',
      percent_based_deduction: 'potrącenie procentowe', recurring_net_deduction: 'stałe potrącenie netto', recurring_net_addition: 'stały dodatek netto', vakantiegeld_paid_now: 'vakantiegeld wypłacany teraz',
      et_exchange: 'regulacja ET', monthly_salary: 'pensja miesięczna', guaranteed_hours: 'gwarantowane godziny', non_weekly_period: 'okres inny niż tydzień', too_many_variants: 'zbyt wiele wariantów naraz',
    },
    choices: { applied: 'stosowana', not_applied: 'niestosowana', estimate: 'szacunek Loonto', enter: 'podane kwoty', accruing: 'naliczany', none: 'brak' },
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
  scopeNote: 'Gross pay, tax and net pay are calculated only by the Loonto engine — as an estimate for 1 week, when it has every input it needs. It is not a confirmed employer payout. Other amounts come only from your messages, your documents or a Loonto orientation tool.',
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
      update_scenario: 'saving your details', calculate_base_wage_orientation: 'orientation: rate × hours', evaluate_payroll_scenario: 'Loonto calculation',
      offer_navigation: 'link to a module',
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
  calculation: {
    title: 'Loonto calculation — estimate for 1 week',
    blockedTitle: 'To calculate, Loonto still needs:',
    unsupportedTitle: 'Loonto does not calculate this yet:',
    invalidTitle: 'These values cannot be calculated:',
    ratesUnavailable: 'Loonto has no tax tables for today, so it calculates nothing.',
    gross: 'Gross (calculated)',
    tax: 'Tax (calculated)',
    net: 'Net wage (calculated)',
    payout: 'Payout (calculated)',
    range: (low, high) => `Payout range: ${low} – ${high} (some inputs have variants or are estimates).`,
    basedOn: 'Based on:',
    sources: { user_stated: 'stated by you', document_reading: 'read from a document', loonto_assumption: 'Loonto assumption', other: 'other' },
    assumptions: 'Loonto assumptions used in the calculation — not data from your contract or payslip.',
    rates: (source, asOf) => (source === 'static'
      ? `Tax tables: fallback (may be out of date), as of ${asOf}.`
      : `Tax tables: current, from Loonto's database, as of ${asOf}.`),
    estimateNote: 'An estimate from the stated inputs — not the employer\'s confirmed payout and not an entitlement.',
    missingAssumption: 'Loonto can estimate this if you agree.',
    unsupported: {
      night_premium: 'night premium', evening_premium: 'evening premium', shift_premium: 'shift premium', surcharge_on_counted_hours: 'premium on already counted hours',
      percent_based_deduction: 'percentage deduction', recurring_net_deduction: 'recurring net deduction', recurring_net_addition: 'recurring net addition', vakantiegeld_paid_now: 'vakantiegeld paid out now',
      et_exchange: 'ET arrangement', monthly_salary: 'monthly salary', guaranteed_hours: 'guaranteed hours', non_weekly_period: 'a period other than a week', too_many_variants: 'too many variants at once',
    },
    choices: { applied: 'applied', not_applied: 'not applied', estimate: 'Loonto estimate', enter: 'amounts given', accruing: 'accruing', none: 'none' },
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
