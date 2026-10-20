import type { ProDocumentType } from '../pro-documents-policy.ts';
import type { FileRejection, R3BDocStatus } from './r3b-documents.ts';
import type { FactStatus, SummaryFieldPath } from './r3b-profile-projection.ts';
import type { TurnFailure } from './r3b-turn.ts';
import { plHours } from './r3b-turn.ts';

/**
 * R3-B copy (PL / EN). Short human sentences - no field paths, codes or provenance objects. Polish is gender-neutral
 * (present tense for Loonto, no gendered past forms for the user). Every value the user sees is rendered by React as
 * text: nothing here is HTML.
 */

export type R3BLang = 'pl' | 'en';

const PL_MONTHS_FMT = new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const EN_MONTHS_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function formatDate(iso: string | null | undefined, lang: R3BLang): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso ?? '';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : (lang === 'pl' ? PL_MONTHS_FMT : EN_MONTHS_FMT).format(d);
}

const num = (n: number, lang: R3BLang, digits = 2) => {
  const fixed = Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  return lang === 'pl' ? fixed.replace('.', ',') : fixed;
};
export const money = (n: number, lang: R3BLang) => `€${lang === 'pl' ? n.toFixed(2).replace('.', ',') : n.toFixed(2)}`;

/** A value with its unit, as shown in the summary and the scenario. */
export function formatValue(unit: string, value: unknown, lang: R3BLang): string {
  if (typeof value === 'number') {
    if (unit === 'eur_per_hour') return `${money(value, lang)}/h`;
    if (unit === 'premium_percent') return `+${num(value, lang)}%`;
    if (unit === 'hours_per_week') return lang === 'pl' ? `${num(value, lang)} h/tydz.` : `${num(value, lang)} h/week`;
    if (unit === 'hours' || unit === 'hours_per_day') return `${num(value, lang)} h`;
    if (unit.startsWith('eur')) return money(value, lang);
    return num(value, lang);
  }
  if (unit === 'period_type' && typeof value === 'string') {
    const pl: Record<string, string> = { week: 'co tydzień', '4-weekly': 'co 4 tygodnie', month: 'co miesiąc' };
    const en: Record<string, string> = { week: 'weekly', '4-weekly': 'every 4 weeks', month: 'monthly' };
    return (lang === 'pl' ? pl : en)[value] ?? value;
  }
  return typeof value === 'string' ? value : String(value ?? '');
}

/** The Scenario unit of an R2 field, for formatting user values. */
export function scenarioUnit(field: string): string {
  if (field === 'pay.hourlyRate') return 'eur_per_hour';
  if (field.startsWith('pay.') && field.endsWith('Percent')) return 'premium_percent';
  if (field.startsWith('work.') || field === 'pay.overtime.thresholdHoursPerDay') return 'hours';
  if (field.startsWith('deductions.entered.') || field === 'extras.travelAllowance') return 'eur_per_week';
  return 'text';
}

type FieldLabels = Record<string, string>;

const FIELD_LABELS: Record<R3BLang, FieldLabels> = {
  pl: {
    'work.hours': 'godziny pracy', 'work.regularWeekdayHours': 'zwykłe godziny pon.–pt.', 'work.overtimeHours': 'nadgodziny',
    'work.saturdayHours': 'godziny w sobotę', 'work.sundayHours': 'godziny w niedzielę', 'work.publicHolidayHours': 'godziny w święto',
    'work.overtimeDistribution': 'rozkład nadgodzin', 'pay.hourlyRate': 'stawka godzinowa brutto', 'pay.saturdayPremiumPercent': 'dodatek za sobotę',
    'pay.sundayPremiumPercent': 'dodatek za niedzielę', 'pay.publicHolidayPremiumPercent': 'dodatek za święto',
    'pay.overtime.thresholdHoursPerDay': 'próg 2. poziomu nadgodzin (godzin dziennie)', 'pay.overtime.tier1Percent': 'dodatek za nadgodziny (1. poziom)',
    'pay.overtime.tier2Percent': 'dodatek za nadgodziny (2. poziom)', 'tax.loonheffingskorting': 'ulga podatkowa (loonheffingskorting)',
    'deductions.mode': 'potrącenia', 'deductions.entered.pension': 'składka emerytalna', 'deductions.entered.paww': 'składka PAWW',
    'deductions.entered.sectorPremium': 'składka sektorowa', 'deductions.entered.postTaxOther': 'inne potrącenia netto',
    'extras.travelAllowance': 'zwrot kosztów dojazdu', 'extras.vakantiegeld.mode': 'vakantiegeld', 'extras.vakantiegeld.percent': 'procent vakantiegeld',
  },
  en: {
    'work.hours': 'working hours', 'work.regularWeekdayHours': 'regular Mon–Fri hours', 'work.overtimeHours': 'overtime hours',
    'work.saturdayHours': 'Saturday hours', 'work.sundayHours': 'Sunday hours', 'work.publicHolidayHours': 'public-holiday hours',
    'work.overtimeDistribution': 'overtime distribution', 'pay.hourlyRate': 'gross hourly rate', 'pay.saturdayPremiumPercent': 'Saturday premium',
    'pay.sundayPremiumPercent': 'Sunday premium', 'pay.publicHolidayPremiumPercent': 'public-holiday premium',
    'pay.overtime.thresholdHoursPerDay': 'second overtime tier threshold (hours per day)', 'pay.overtime.tier1Percent': 'overtime premium (tier 1)',
    'pay.overtime.tier2Percent': 'overtime premium (tier 2)', 'tax.loonheffingskorting': 'tax credit (loonheffingskorting)',
    'deductions.mode': 'deductions', 'deductions.entered.pension': 'pension contribution', 'deductions.entered.paww': 'PAWW contribution',
    'deductions.entered.sectorPremium': 'sector contribution', 'deductions.entered.postTaxOther': 'other net deductions',
    'extras.travelAllowance': 'travel allowance', 'extras.vakantiegeld.mode': 'vakantiegeld', 'extras.vakantiegeld.percent': 'vakantiegeld percentage',
  },
};
export const fieldLabel = (field: string, lang: R3BLang) => FIELD_LABELS[lang][field] ?? (lang === 'pl' ? 'dodatkowa informacja' : 'additional information');

const SUMMARY_LABELS: Record<R3BLang, Record<SummaryFieldPath, string>> = {
  pl: {
    'employment.hourlyRate': 'Stawka godzinowa', 'payroll.periodType': 'Wypłata', 'employment.hoursPerWeek': 'Godziny w umowie',
    'payroll.saturdayPremium': 'Dodatek za sobotę', 'payroll.sundayPremium': 'Dodatek za niedzielę', 'payroll.publicHolidayPremium': 'Dodatek za święto',
    'payroll.overtimeTier1Premium': 'Nadgodziny (1. poziom)', 'payroll.overtimeTier2Premium': 'Nadgodziny (2. poziom)', 'employment.overtimeThresholdHours': 'Próg nadgodzin',
  },
  en: {
    'employment.hourlyRate': 'Hourly rate', 'payroll.periodType': 'Pay', 'employment.hoursPerWeek': 'Contract hours',
    'payroll.saturdayPremium': 'Saturday premium', 'payroll.sundayPremium': 'Sunday premium', 'payroll.publicHolidayPremium': 'Public-holiday premium',
    'payroll.overtimeTier1Premium': 'Overtime (tier 1)', 'payroll.overtimeTier2Premium': 'Overtime (tier 2)', 'employment.overtimeThresholdHours': 'Overtime threshold',
  },
};

export interface R3BCopy {
  pageTitle: string;
  badge: string;
  testBanner: string;
  bannerDetail: string;
  backToCurrent: string;
  langLabel: string;
  title: string;
  lead: string;
  threadLabel: string;
  loontoName: string;
  youName: string;
  welcome: string;
  docTypes: Record<ProDocumentType, string>;
  docName: (type: ProDocumentType, n: number) => string;
  offer: {
    title: string; addPayslip: string; addContract: string; addAnnex: string; continueWithout: string; addMore: string;
    listLabel: string; remove: (name: string) => string; annexDate: string; annexDateMissing: string; size: (bytes: number) => string;
    status: Record<R3BDocStatus, string>; rejected: Record<FileRejection, (name: string) => string>; types: string;
    consentTitle: string; consent: string; read: (n: number) => string; reading: string; unreadFirst: string; nothingToRead: string; contextExpired: string;
  };
  roles: Record<'payslip' | 'contract_base' | 'contract_annex' | 'user' | 'rules', string>;
  readReport: {
    ok: (doc: string) => string; partial: (doc: string, pages: string, total: number, tooLong: boolean) => string; failed: (doc: string, reason: string) => string;
    errors: Record<string, string>; noneRead: string; next: string;
  };
  period: { question: (dates: string[]) => string; before: (date: string) => string; from: (date: string) => string; otherDay: string; useDay: string; unknown: string; unknownNote: string; chosen: (date: string) => string };
  summary: {
    title: string; nothing: string; resolveFailed: string; labels: Record<SummaryFieldPath, string>; statuses: Record<FactStatus, string>;
    rateNotFound: string; conflict: string; contextOnly: string; details: string; detailDoc: (doc: string) => string; detailPeriod: (p: string) => string;
    detailEffective: (d: string) => string; detailPage: (n: number) => string; detailPrinted: (t: string) => string; detailDecided: (d: string) => string;
    otherPeriod: (value: string, where: string) => string; notLegal: string;
  };
  goal: { question: string; lead: string; leadNoDocs: string };
  conflict: { question: (a: string, b: string) => string; candidate: (value: string, where: string) => string; dontKnow: string; leftOpen: string; chosen: (value: string) => string; failed: string; pick: string };
  percent: { question: (value: number, label: string) => string; total: (value: number) => string; above: (value: number) => string; dontKnow: string; pick: string };
  turn: {
    saved: (label: string, value: string) => string; assumed: (label: string, value: string) => string; unknown: (label: string) => string; deferred: (label: string) => string;
    notes: Record<string, (label: string) => string>; hints: Record<string, string>; notApplied: Record<string, string>;
    failed: Record<TurnFailure, string>; done: string; open: (items: string) => string; noResult: string; unsupported: string; computedHidden: string;
    calculationGated: string; rateFromDocument: (value: string) => string;
  };
  /** R3-B.2: an answer from the document's printed facts. */
  answer: {
    intro: string; keys: Record<string, string>; conflict: string; note: string; whyNet: string; noContext: string; notFound: string; backTo: string;
    printedTitle: string; printedNote: string;
  };
  questions: {
    clarify: (total: number | null) => string; split: (total: number | null) => string; opening: (contractHours: number | null) => string;
    hours: (label: string) => string; rate: (docsRead: boolean) => string; premium: (label: string, docsRead: boolean) => string;
    offer: (label: string, value: string) => string; conflict: (label: string) => string; correct: (label: string) => string; generic: (label: string) => string;
    threshold: string; distribution: string;
  };
  composer: { legend: string; localLegend: string; inputLabel: string; placeholder: string; note: string; send: string; tooLong: string; busy: string };
  panel: {
    toggle: string; scenarioTitle: string; scenarioTag: string; empty: string; sources: Record<'user' | 'loonto_assumption' | 'correction' | 'document' | FactStatus, string>;
    documentLine: (value: string, status: string) => string; correctionNote: (date: string) => string; edit: string; correct: string; save: string; cancel: string;
    editLabel: (label: string) => string; editNote: string; editErrors: Record<'not_a_number' | 'out_of_range', string>; deferredTag: string;
    resultTitle: string; resultStatus: string; resultLead: string; reasons: { documentProvisional: string; missing: (items: string) => string; conflict: string; outOfGoal: string; gate: string };
    explainTitle: string; explain: string[]; analyzerTitle: string; analyzerButton: string; analyzerNote: string; reset: string;
  };
}

const PL: R3BCopy = {
  pageTitle: 'Loonto Alpha R3-B — rozmowa od dokumentów',
  badge: 'Alpha R3-B',
  testBanner: 'Wersja testowa — używaj wyłącznie dokumentów przykładowych, bez danych osobowych',
  bannerDetail: 'Odczyt dokumentów, profil płacowy i rozmowa działają naprawdę. Kwoty wypłaty nie są jeszcze pokazywane.',
  backToCurrent: 'Poprzednia wersja Loonto (tymczasowo)',
  langLabel: 'Język',
  title: 'Sprawdźmy, co już wiadomo',
  lead: 'Najpierw dokumenty (opcjonalnie), potem jedno pytanie na raz.',
  threadLabel: 'Rozmowa z Loonto',
  loontoName: 'Loonto',
  youName: 'Ty',
  welcome: 'Cześć! Zanim o coś zapytam, mogę sprawdzić, co już wynika z Twoich dokumentów. Dodaj pasek wypłaty lub umowę — albo zacznij bez dokumentów.',
  docTypes: { payslip: 'Pasek wypłaty', contract_base: 'Umowa', contract_annex: 'Aneks do umowy' },
  docName: (type, n) => `${PL.docTypes[type]} ${n}`,
  offer: {
    title: 'Dokumenty (opcjonalnie)',
    addPayslip: 'Dodaj pasek wypłaty', addContract: 'Dodaj umowę', addAnnex: 'Dodaj aneks', continueWithout: 'Kontynuuj bez dokumentów', addMore: 'Dodaj kolejny dokument',
    listLabel: 'Wybrane dokumenty', remove: (name) => `Usuń ${name}`, annexDate: 'Obowiązuje od', annexDateMissing: 'Podaj, od kiedy obowiązuje aneks — bez tej daty nie da się go umieścić w czasie.',
    size: (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`),
    status: { selected: 'Wybrany — jeszcze nieodczytany', reading: 'Czytam…', read: 'Odczytany', failed: 'Nie udało się odczytać' },
    rejected: {
      type: (name) => `„${name}”: ten typ pliku nie jest obsługiwany (PDF, JPG lub PNG).`,
      size: (name) => `„${name}”: plik jest za duży (maks. 20 MB).`,
      empty: (name) => `„${name}”: plik jest pusty.`,
    },
    types: 'PDF, JPG lub PNG · do 20 MB · do 30 stron',
    consentTitle: 'Zanim odczytam',
    consent: 'Odczyt wyśle treść wybranych plików (tekst i obrazy stron) do zewnętrznego czytnika AI — Google Gemini, przetwarzanie poza UE — który rozpozna dane potrzebne do wyliczenia. Nic nie jest wysyłane, dopóki nie klikniesz przycisku poniżej. Używaj wyłącznie dokumentów przykładowych.',
    read: (n) => (n === 1 ? 'Odczytaj dokument przez Gemini' : `Odczytaj dokumenty przez Gemini (${n})`),
    reading: 'Czytam dokumenty…',
    unreadFirst: 'Masz wybrane dokumenty, które nie zostały jeszcze odczytane. Odczytaj je albo usuń — albo wybierz „Kontynuuj bez dokumentów”.',
    nothingToRead: 'Nie ma nic do odczytania.',
    contextExpired: 'Odczyt dokumentów przechowywany na serwerze wygasł (po 2 godzinach). Rozmowę prowadzę dalej bez niego — aby znów odpowiadać z dokumentu, odczytaj go ponownie przyciskiem powyżej.',
  },
  roles: { payslip: 'pasek wypłaty', contract_base: 'umowa', contract_annex: 'aneks', user: 'Twoja decyzja', rules: 'przepis' },
  readReport: {
    ok: (doc) => `${doc}: odczytany.`,
    partial: (doc, pages, total, tooLong) => `${doc}: odczytany częściowo — nie odczytano stron ${pages} z ${total}${tooLong ? ' (dokument jest za długi)' : ' (błąd odczytu)'}. Korzystam z tego, co udało się odczytać.`,
    failed: (doc, reason) => `${doc}: nie udało się odczytać — ${reason}. Niczego z niego nie przyjmuję.`,
    errors: {
      vision_unavailable: 'czytnik dokumentów (Gemini) jest teraz niedostępny',
      extraction_failed: 'czytnik nie zwrócił danych',
      invalid_input: 'tych danych nie da się wysłać do odczytu',
      text_layer_too_large: 'tekst dokumentu jest za duży',
      rate_limit_exceeded: 'zbyt wiele odczytów w krótkim czasie — spróbuj za kilka minut',
      rate_limit_unknown: 'nie można teraz sprawdzić limitu odczytów',
      file_unreadable: 'nie udało się otworzyć pliku',
      unknown: 'brak połączenia lub nieoczekiwana odpowiedź',
    },
    noneRead: 'Nie udało się odczytać żadnego dokumentu. Możesz spróbować ponownie, usunąć plik albo kontynuować bez dokumentów.',
    next: 'Sprawdzam, co z tego wynika…',
  },
  period: {
    question: (dates) => `Aneks zmienia warunki od ${dates.join(', ')}. Którego tygodnia dotyczy wyliczenie?`,
    before: (date) => `Tydzień przed ${date}`, from: (date) => `Tydzień od ${date}`, otherDay: 'Albo podaj dzień z liczonego tygodnia', useDay: 'Użyj tej daty',
    unknown: 'Nie wiem',
    unknownNote: 'Bez daty nie wybieram wartości z dokumentów — obowiązują w różnych okresach. O stawkę zapytam wprost.',
    chosen: (date) => `Liczę według dokumentów obowiązujących ${date}.`,
  },
  summary: {
    title: 'Co wynika z dokumentów',
    nothing: 'W odczytanych dokumentach nie znajduję danych potrzebnych do wyliczenia tygodnia.',
    resolveFailed: 'Nie udało się zestawić danych z dokumentów (błąd serwera). Możesz kontynuować — zapytam o to, czego potrzebuję.',
    labels: SUMMARY_LABELS.pl,
    statuses: { document_reading: 'odczyt z dokumentu — wymaga weryfikacji', documents_agree: 'zgodne w dokumentach — wymaga weryfikacji', user_confirmed: 'Twój wybór', user_corrected: 'Twoja korekta', conflict: 'rozbieżność', unknown: 'nie znaleziono' },
    rateNotFound: 'nie znajduję jej w dokumentach',
    conflict: 'dwie różne wartości — nie wybieram żadnej',
    contextOnly: 'tylko informacja — i tak zapytam o liczony tydzień',
    details: 'Skąd to wiem',
    detailDoc: (doc) => `Dokument: ${doc}`,
    detailPeriod: (p) => `Okres: ${p}`,
    detailEffective: (d) => `Obowiązuje od: ${d}`,
    detailPage: (n) => `Strona ${n}`,
    detailPrinted: (t) => `Zapis w dokumencie: „${t}”`,
    detailDecided: (d) => `Twoja decyzja z ${d}`,
    otherPeriod: (value, where) => `${value} (${where}) dotyczy innego okresu — to nie jest rozbieżność.`,
    notLegal: 'Odczyt pokazuje, co jest w dokumencie — nie potwierdza, że naliczenie jest prawidłowe.',
  },
  goal: {
    question: 'Co chcesz policzyć?',
    lead: 'Napisz własnymi słowami albo wybierz przykład. W tej wersji zbieram dane do podstawy tygodnia (godziny i stawka, opcjonalnie sobota).',
    leadNoDocs: 'Dobrze, bez dokumentów. Napisz własnymi słowami albo wybierz przykład — zapytam tylko o to, czego brakuje.',
  },
  conflict: {
    question: (a, b) => `Zanim policzę tydzień: w dokumentach są dwie różne stawki dla tego samego okresu — ${a} i ${b}. Nie wybieram żadnej z nich automatycznie. Która dotyczy tygodnia, który chcesz policzyć?`,
    candidate: (value, where) => `${value} — ${where}`,
    dontKnow: 'Nie wiem',
    leftOpen: 'Dobrze — stawka zostaje nierozstrzygnięta, obie wartości pozostają widoczne. Nie liczę kwoty. Dokładniejsze sprawdzenie — Analizator (w przygotowaniu).',
    chosen: (value) => `Przyjmuję Twój wybór: ${value} — jako Twoją decyzję. Dokumenty i ich odczyt pozostają bez zmian.`,
    failed: 'Nie udało się zapisać wyboru (błąd serwera). Spróbuj jeszcze raz.',
    pick: 'Wybierz jedną z wartości albo „Nie wiem”.',
  },
  percent: {
    question: (value, label) => `„${value}%” — ${label} — może znaczyć dwie rzeczy. Czy to łącznie ${value}% zwykłej stawki (czyli dodatek +${Math.round((value - 100) * 100) / 100}%), czy dodatek +${value}% ponad zwykłą stawkę?`,
    total: (value) => `Łącznie ${value}% stawki (dodatek +${Math.round((value - 100) * 100) / 100}%)`,
    above: (value) => `Dodatek +${value}% ponad stawkę`,
    dontKnow: 'Nie wiem',
    pick: 'Wybierz, co oznacza ten procent, albo „Nie wiem”.',
  },
  turn: {
    saved: (label, value) => `Zapisuję: ${label} — ${value} (Twoja informacja).`,
    assumed: (label, value) => `Przyjmuję założenie Loonto: ${label} ${value}. Pozostaje oznaczone jako założenie.`,
    unknown: (label) => `${label[0]?.toUpperCase()}${label.slice(1)}: zostaje nieustalone — nie wpisuję zera.`,
    deferred: (label) => `Nie wracam do tego pytania w kółko — ${label} zostaje nieustalone. Możesz to uzupełnić później.`,
    notes: {
      component_mismatch_withheld: (label) => `Nie zapisuję tego jako „${label}” — ta wartość dotyczy innego składnika (np. dodatku nocnego), którego ta wersja nie liczy.`,
      value_not_stated_withheld: () => 'Nie zapisuję wartości, której nie ma w Twojej wiadomości.',
      unit_mismatch_withheld: () => 'Nie zapisuję wartości w innej jednostce niż pytanie.',
      hours_withheld: () => 'Nie przypisuję godzin do rodzaju, którego nie podano.',
      weekday_hours_withheld: () => 'Nie zakładam, że to godziny od poniedziałku do piątku.',
      trusted_value_added: (label) => `${label[0]?.toUpperCase()}${label.slice(1)}: uwzględniam odczyt z Twojego dokumentu — nie pytam o to, co dokument już podaje.`,
      trusted_value_upgraded: (label) => `${label[0]?.toUpperCase()}${label.slice(1)}: Twoja wartość zgadza się z dokumentem.`,
      trusted_value_conflicts_with_user: (label) => `${label[0]?.toUpperCase()}${label.slice(1)}: Twoja wartość różni się od dokumentu — zostawiam obie, niczego nie nadpisuję.`,
      other: () => 'Część odpowiedzi pomijam, bo nie wynika jednoznacznie z wiadomości.',
    },
    hints: {
      user_does_not_know: 'W porządku — nic nie wpisuję i nie zakładam zera.',
      agent_unavailable: 'Tej wiadomości nie umiem teraz zrozumieć automatycznie — niczego nie zapisuję. Spróbuj krótszej odpowiedzi albo jednego z przykładów.',
      message_unclear: 'Nie mam pewności, co oznacza ta odpowiedź — niczego nie zapisuję.',
      off_topic: 'To chyba nie dotyczy wyliczenia — wróćmy do pytania.',
      clarification_requested: 'Spróbuję zapytać prościej.',
      patch_rejected: 'Tej zmiany nie mogę przyjąć — niczego nie zapisuję.',
      untrusted_scenario: 'Odrzucam te dane: ich źródło nie zostało zweryfikowane po stronie serwera.',
      scenario_invalid: 'Jedna z wartości jest poza dopuszczalnym zakresem.',
      unsupported_concept: 'Tego składnika ta wersja jeszcze nie liczy — nie zamienię go na inny.',
    },
    notApplied: {
      unit_mismatch: 'To nie pasuje do pytania (inna jednostka) — niczego nie zapisuję.',
      weekly_total_not_category: 'To wygląda na łączną liczbę godzin, a pytam o jeden ich rodzaj — niczego nie zapisuję.',
      explicit_hours_required: 'Żeby niczego nie zgadywać: napisz liczbę i rodzaj godzin, np. „40 godzin od poniedziałku do piątku”.',
    },
    failed: {
      network: 'Brak połączenia z Loonto — niczego nie zapisano. Spróbuj ponownie.',
      timeout: 'Odpowiedź trwa zbyt długo — niczego nie zapisano. Spróbuj ponownie.',
      rate_limited: 'Zbyt wiele wiadomości w krótkim czasie — spróbuj za kilka minut.',
      unavailable: 'Rozmowa jest chwilowo niedostępna — spróbuj później.',
      invalid: 'Tej wiadomości nie da się wysłać (np. jest za długa).',
      server: 'Coś poszło nie tak po stronie serwera — niczego nie zapisano.',
      document_context_invalid: 'Odczyt dokumentu na serwerze wygasł — niczego nie zapisano. Odczytaj dokument ponownie.',
    },
    done: 'Na razie nie mam więcej pytań o ten tydzień.',
    open: (items) => `Otwarte: ${items}.`,
    noResult: 'Wynik jeszcze niedostępny — szczegóły w panelu „Scenariusz”.',
    unsupported: 'Tego wariantu ta wersja jeszcze nie liczy.',
    computedHidden: 'Mam komplet danych do wariantu, ale w tej wersji nie pokazuję kwoty.',
    calculationGated: 'Kwoty wypłaty w tej wersji jeszcze nie wyliczam — zbieram dane do wariantu, a wynik pokażę dopiero po weryfikacji obliczeń.',
    rateFromDocument: (value) => `Stawkę biorę z Twojego dokumentu: ${value} — nie pytam o nią ponownie.`,
  },
  answer: {
    intro: 'Na dokumencie widzę:',
    keys: {
      hourly_rate: 'Stawka godzinowa', regular_hours: 'Zapłacone godziny zwykłe', overtime_hours: 'Nadgodziny', contract_hours_per_week: 'Godziny w umowie',
      period_label: 'Okres', period_start: 'Początek okresu', period_end: 'Koniec okresu', period_type: 'Wypłata', wage_line_amount: 'Pozycja brutto',
      surcharge_percent: 'Dodatek (procent)', gross_total: 'Brutto razem', net: 'Netto', payout: 'Przelano na konto', reimbursement: 'Zwrot kosztów',
      net_deduction: 'Potrącenie z netto', deduction: 'Potrącenie', tax: 'Podatek', tax_special: 'Podatek (stawka szczególna)',
    },
    conflict: 'dokumenty podają różne wartości',
    note: 'To odczyt z dokumentu, nie przeliczenie Loonto — wymaga weryfikacji.',
    whyNet: 'Różnicy między brutto a netto nie wyliczam w tej wersji — pokazuję tylko to, co jest wydrukowane. Brak pozycji w odczycie nie oznacza zera.',
    noContext: 'W tej rozmowie nie mam odczytanego dokumentu, więc nie odpowiem z dokumentu. Dodaj i odczytaj dokument albo napisz wartość w wiadomości.',
    notFound: 'W odczycie dokumentu nie ma tej informacji — niczego nie zgaduję.',
    backTo: 'Wracając do wariantu:',
    printedTitle: 'Wydrukowane na dokumencie',
    printedNote: 'Odczyt, nie przeliczenie — wymaga weryfikacji.',
  },
  questions: {
    clarify: (total) => (total !== null ? `Czy te ${String(total).replace('.', ',')} ${plHours(total)} to zwykłe godziny od poniedziałku do piątku? Jeśli są wśród nich sobota, niedziela albo nadgodziny — odpowiedz „Nie”.` : 'Czy to zwykłe godziny od poniedziałku do piątku?'),
    split: (total) => `Jak dzielą się ${total !== null ? `te ${String(total).replace('.', ',')} ${plHours(total)}` : 'te godziny'}? Napisz np. „32 godziny od poniedziałku do piątku i 8 godzin w sobotę”.`,
    opening: (hours) => `${hours !== null ? `W umowie widzę ${String(hours).replace('.', ',')} ${plHours(hours)} tygodniowo, ale pytam o konkretny tydzień. ` : ''}Ile godzin chcesz policzyć i w jakie dni? Np. „40 godzin od poniedziałku do piątku”.`,
    hours: (label) => `Ile wynoszą ${label}?`,
    rate: (docsRead) => `${docsRead ? 'W dokumentach nie znajduję stawki godzinowej. ' : ''}Ile wynosi Twoja stawka brutto za godzinę?`,
    premium: (label, docsRead) => `${docsRead ? `W dokumentach nie widzę pozycji „${label}”. ` : ''}Ile procent ponad zwykłą stawkę wynosi ${label}?`,
    offer: (label, value) => `Rozumiem. Mogę przyjąć założenie Loonto: ${label} ${value} ponad stawkę. To tylko założenie — nie fakt z dokumentu ani przepis. Przyjąć je do wariantu?`,
    conflict: (label) => `Mam dwie różne wartości: ${label}. Która jest właściwa?`,
    correct: (label) => `Ta wartość wygląda na niepoprawną: ${label}. Podaj ją jeszcze raz.`,
    generic: (label) => `Potrzebuję jeszcze jednej informacji: ${label}.`,
    threshold: 'Po ilu godzinach dziennie zaczyna się drugi poziom nadgodzin?',
    distribution: 'Na ile dni w tygodniu rozkładają się nadgodziny?',
  },
  composer: {
    legend: 'Przykładowe odpowiedzi', localLegend: 'Wybierz', inputLabel: 'Twoja wiadomość', placeholder: 'Napisz własnymi słowami…',
    note: 'Krótkie odpowiedzi i pytania o dokument rozumiem bez modelu AI; dłuższe wiadomości może zinterpretować model językowy — widzi wtedy tylko liczby odczytane z dokumentu (np. stawkę, godziny), bez nazw, nazwisk i treści dokumentu.',
    send: 'Wyślij', tooLong: 'Wiadomość jest za długa (maks. 1000 znaków).', busy: 'Chwila…',
  },
  panel: {
    toggle: 'Scenariusz', scenarioTitle: 'Twój scenariusz tygodnia', scenarioTag: 'Wartości robocze',
    empty: 'Tu pojawią się dane do wyliczenia — z rozmowy i z dokumentów.',
    sources: {
      user: 'Twoja informacja', loonto_assumption: 'Założenie Loonto', correction: 'Twoja korekta', document_reading: 'Dokument — odczyt, wymaga weryfikacji',
      documents_agree: 'Dokumenty (zgodne) — wymaga weryfikacji', user_confirmed: 'Twój wybór spośród dokumentów', user_corrected: 'Twoja korekta w profilu', conflict: 'Rozbieżność', unknown: 'Nieustalone',
      document: 'Z dokumentu (odczyt serwera) — wymaga weryfikacji',
    },
    documentLine: (value, status) => `Dokument: ${value} — ${status}`,
    correctionNote: (date) => `Twoja korekta z ${date}. Odczyt dokumentu pozostaje bez zmian.`,
    edit: 'Zmień', correct: 'Popraw', save: 'Zapisz', cancel: 'Anuluj',
    editLabel: (label) => `Nowa wartość: ${label}`,
    editNote: 'Zmiana to Twoja deklaracja — nie zmienia dokumentu ani jego odczytu.',
    editErrors: { not_a_number: 'Wpisz liczbę, np. 16,80.', out_of_range: 'Ta wartość jest poza dopuszczalnym zakresem.' },
    deferredTag: 'Odłożone',
    resultTitle: 'Wynik', resultStatus: 'Wynik jeszcze niedostępny',
    resultLead: 'W tej wersji Loonto nie pokazuje kwoty wypłaty.',
    reasons: {
      documentProvisional: 'Wartości z dokumentów są odczytem, którego serwer jeszcze nie weryfikuje — nie liczę z nich kwoty.',
      missing: (items) => `Brakuje: ${items}.`,
      conflict: 'Stawka jest nierozstrzygnięta (dwie wartości w dokumentach).',
      outOfGoal: 'Podatek, potrącenia i dodatki netto nie są jeszcze częścią tej rozmowy.',
      gate: 'Kwoty pojawią się dopiero po zamknięciu bramek bezpieczeństwa wyliczeń (kolejny etap).',
    },
    explainTitle: 'Co działa w tej wersji?',
    explain: [
      'Dokumenty czyta istniejący czytnik Loonto (Google Gemini), a dane zestawia istniejący profil płacowy — z okresem, stroną i źródłem każdej wartości.',
      'Rozmowę prowadzi istniejący moduł rozmowy Loonto: kolejne pytanie wybiera kod, nie model AI, i nie pyta o to, co już widać w dokumentach.',
      'Na pytania o dokument (stawka, godziny, netto, przelew) odpowiadam z wydrukowanych wartości, które serwer odczytał i przechowuje dla tej sesji przeglądarki najwyżej 2 godziny.',
      'Odczyt z dokumentu nie jest zweryfikowanym faktem płacowym — dlatego, nawet gdy rozmowa z niego korzysta, kwota nie jest pokazywana.',
    ],
    analyzerTitle: 'Analizator', analyzerButton: 'Analizator w przygotowaniu',
    analyzerNote: 'Dokładne sprawdzenie rozbieżności i podstaw (umowa, CAO) — w kolejnym etapie. Teraz nic nie jest analizowane.',
    reset: 'Zacznij od nowa',
  },
};

const EN: R3BCopy = {
  pageTitle: 'Loonto Alpha R3-B — document-first conversation',
  badge: 'Alpha R3-B',
  testBanner: 'Test version — use sample documents only, without personal data',
  bannerDetail: 'Document reading, the payroll profile and the conversation are real. Pay amounts are not shown yet.',
  backToCurrent: 'Previous Loonto (temporary)',
  langLabel: 'Language',
  title: "Let's see what is already known",
  lead: 'Documents first (optional), then one question at a time.',
  threadLabel: 'Conversation with Loonto',
  loontoName: 'Loonto',
  youName: 'You',
  welcome: 'Hi! Before I ask anything, I can check what your documents already tell. Add a payslip or a contract — or start without documents.',
  docTypes: { payslip: 'Payslip', contract_base: 'Contract', contract_annex: 'Contract annex' },
  docName: (type, n) => `${EN.docTypes[type]} ${n}`,
  offer: {
    title: 'Documents (optional)',
    addPayslip: 'Add a payslip', addContract: 'Add a contract', addAnnex: 'Add an annex', continueWithout: 'Continue without documents', addMore: 'Add another document',
    listLabel: 'Selected documents', remove: (name) => `Remove ${name}`, annexDate: 'Effective from', annexDateMissing: 'Enter the date the annex takes effect — without it the annex cannot be placed in time.',
    size: (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`),
    status: { selected: 'Selected — not read yet', reading: 'Reading…', read: 'Read', failed: 'Could not be read' },
    rejected: {
      type: (name) => `“${name}”: this file type is not supported (PDF, JPG or PNG).`,
      size: (name) => `“${name}”: the file is too large (max. 20 MB).`,
      empty: (name) => `“${name}”: the file is empty.`,
    },
    types: 'PDF, JPG or PNG · up to 20 MB · up to 30 pages',
    consentTitle: 'Before I read',
    consent: 'Reading sends the content of the selected files (text and page images) to an external AI reader — Google Gemini, processed outside the EU — which recognises the data needed for the calculation. Nothing is sent until you press the button below. Use sample documents only.',
    read: (n) => (n === 1 ? 'Read the document with Gemini' : `Read the documents with Gemini (${n})`),
    reading: 'Reading the documents…',
    unreadFirst: 'You have selected documents that have not been read yet. Read or remove them — or choose “Continue without documents”.',
    nothingToRead: 'There is nothing to read.',
    contextExpired: 'The document reading kept on the server has expired (after 2 hours). I continue without it — to answer from the document again, read it again with the button above.',
  },
  roles: { payslip: 'payslip', contract_base: 'contract', contract_annex: 'annex', user: 'your decision', rules: 'rule' },
  readReport: {
    ok: (doc) => `${doc}: read.`,
    partial: (doc, pages, total, tooLong) => `${doc}: partly read — pages ${pages} of ${total} were not read${tooLong ? ' (the document is too long)' : ' (reading error)'}. I use what could be read.`,
    failed: (doc, reason) => `${doc}: could not be read — ${reason}. Nothing from it is used.`,
    errors: {
      vision_unavailable: 'the document reader (Gemini) is unavailable right now',
      extraction_failed: 'the reader returned no data',
      invalid_input: 'this data cannot be sent for reading',
      text_layer_too_large: 'the document text is too large',
      rate_limit_exceeded: 'too many reads in a short time — try again in a few minutes',
      rate_limit_unknown: 'the read limit cannot be checked right now',
      file_unreadable: 'the file could not be opened',
      unknown: 'no connection or an unexpected answer',
    },
    noneRead: 'No document could be read. You can try again, remove the file or continue without documents.',
    next: 'Checking what this tells…',
  },
  period: {
    question: (dates) => `An annex changes the terms from ${dates.join(', ')}. Which week is the calculation for?`,
    before: (date) => `A week before ${date}`, from: (date) => `A week from ${date}`, otherDay: 'Or enter a day of the week to calculate', useDay: 'Use this date',
    unknown: "I don't know",
    unknownNote: 'Without a date I do not pick values from the documents — they apply to different periods. I will ask for the rate directly.',
    chosen: (date) => `I use the documents in force on ${date}.`,
  },
  summary: {
    title: 'What the documents tell',
    nothing: 'The documents read contain no data needed for the weekly calculation.',
    resolveFailed: 'The document data could not be combined (server error). You can continue — I will ask for what I need.',
    labels: SUMMARY_LABELS.en,
    statuses: { document_reading: 'read from the document — needs verification', documents_agree: 'documents agree — needs verification', user_confirmed: 'your choice', user_corrected: 'your correction', conflict: 'conflict', unknown: 'not found' },
    rateNotFound: 'not found in the documents',
    conflict: 'two different values — I pick neither',
    contextOnly: 'information only — I will still ask about the week you calculate',
    details: 'How I know',
    detailDoc: (doc) => `Document: ${doc}`,
    detailPeriod: (p) => `Period: ${p}`,
    detailEffective: (d) => `Effective from: ${d}`,
    detailPage: (n) => `Page ${n}`,
    detailPrinted: (t) => `Printed as: “${t}”`,
    detailDecided: (d) => `Your decision of ${d}`,
    otherPeriod: (value, where) => `${value} (${where}) belongs to another period — this is not a conflict.`,
    notLegal: 'A reading shows what the document says — it does not confirm that the pay was calculated correctly.',
  },
  goal: {
    question: 'What would you like to calculate?',
    lead: 'Write in your own words or pick an example. This version collects the data for a weekly base pay (hours and rate, optionally Saturday).',
    leadNoDocs: 'Fine, without documents. Write in your own words or pick an example — I will only ask for what is missing.',
  },
  conflict: {
    question: (a, b) => `Before I calculate the week: the documents show two different rates for the same period — ${a} and ${b}. I do not pick one automatically. Which one applies to the week you want to calculate?`,
    candidate: (value, where) => `${value} — ${where}`,
    dontKnow: "I don't know",
    leftOpen: 'Fine — the rate stays unresolved and both values stay visible. No amount is calculated. A closer check — the Analyzer (in preparation).',
    chosen: (value) => `I take your choice: ${value} — as your decision. The documents and their reading stay unchanged.`,
    failed: 'Your choice could not be saved (server error). Please try again.',
    pick: "Choose one of the values or “I don't know”.",
  },
  percent: {
    question: (value, label) => `“${value}%” — ${label} — can mean two things. Is it ${value}% of the normal rate in total (a premium of +${Math.round((value - 100) * 100) / 100}%), or a premium of +${value}% on top of the normal rate?`,
    total: (value) => `${value}% of the rate in total (+${Math.round((value - 100) * 100) / 100}%)`,
    above: (value) => `+${value}% on top of the rate`,
    dontKnow: "I don't know",
    pick: "Choose what the percentage means, or “I don't know”.",
  },
  turn: {
    saved: (label, value) => `Saved: ${label} — ${value} (your information).`,
    assumed: (label, value) => `Loonto assumption accepted: ${label} ${value}. It stays marked as an assumption.`,
    unknown: (label) => `${label[0]?.toUpperCase()}${label.slice(1)}: stays unknown — not zero.`,
    deferred: (label) => `I will not keep asking — ${label} stays unknown. You can fill it in later.`,
    notes: {
      component_mismatch_withheld: (label) => `I do not save this as “${label}” — the value belongs to another component (e.g. a night allowance) this version does not calculate.`,
      value_not_stated_withheld: () => 'I do not save a value that is not in your message.',
      unit_mismatch_withheld: () => 'I do not save a value in another unit than the question.',
      hours_withheld: () => 'I do not assign hours to a kind you did not name.',
      weekday_hours_withheld: () => 'I do not assume these are Monday-to-Friday hours.',
      trusted_value_added: (label) => `${label[0]?.toUpperCase()}${label.slice(1)}: I use the reading of your document — I do not ask for what the document already shows.`,
      trusted_value_upgraded: (label) => `${label[0]?.toUpperCase()}${label.slice(1)}: your value matches the document.`,
      trusted_value_conflicts_with_user: (label) => `${label[0]?.toUpperCase()}${label.slice(1)}: your value differs from the document — I keep both and overwrite nothing.`,
      other: () => 'I leave part of the answer out because the message does not state it clearly.',
    },
    hints: {
      user_does_not_know: 'Fine — I write nothing and do not assume zero.',
      agent_unavailable: 'I cannot interpret this message automatically right now — nothing is saved. Try a shorter answer or one of the examples.',
      message_unclear: 'I am not sure what this answer means — nothing is saved.',
      off_topic: 'This does not seem to be about the calculation — back to the question.',
      clarification_requested: 'Let me ask more simply.',
      patch_rejected: 'I cannot accept this change — nothing is saved.',
      untrusted_scenario: 'I reject this data: its source has not been verified by the server.',
      scenario_invalid: 'One of the values is outside the allowed range.',
      unsupported_concept: 'This version does not calculate this component yet — I will not turn it into another one.',
    },
    notApplied: {
      unit_mismatch: 'That does not fit the question (another unit) — nothing is saved.',
      weekly_total_not_category: 'That looks like a total of hours, but I asked about one kind — nothing is saved.',
      explicit_hours_required: 'To avoid guessing, write the number and the kind of hours, e.g. “40 hours Monday to Friday”.',
    },
    failed: {
      network: 'No connection to Loonto — nothing was saved. Please try again.',
      timeout: 'The answer is taking too long — nothing was saved. Please try again.',
      rate_limited: 'Too many messages in a short time — try again in a few minutes.',
      unavailable: 'The conversation is temporarily unavailable — try again later.',
      invalid: 'This message cannot be sent (e.g. it is too long).',
      server: 'Something went wrong on the server — nothing was saved.',
      document_context_invalid: 'The document reading on the server has expired — nothing was saved. Read the document again.',
    },
    done: 'I have no more questions about this week for now.',
    open: (items) => `Open: ${items}.`,
    noResult: 'Result not available yet — details in the “Scenario” panel.',
    unsupported: 'This version does not calculate this variant yet.',
    computedHidden: 'I have all data for the variant, but this version does not show an amount.',
    calculationGated: 'This version does not calculate the pay amount yet — I collect the data for the variant, and the result will appear only after the calculation is verified.',
    rateFromDocument: (value) => `I take the rate from your document: ${value} — I will not ask for it again.`,
  },
  answer: {
    intro: 'On the document I can see:',
    keys: {
      hourly_rate: 'Hourly rate', regular_hours: 'Regular hours paid', overtime_hours: 'Overtime hours', contract_hours_per_week: 'Contract hours',
      period_label: 'Period', period_start: 'Period start', period_end: 'Period end', period_type: 'Pay', wage_line_amount: 'Gross line',
      surcharge_percent: 'Surcharge (percent)', gross_total: 'Gross total', net: 'Net', payout: 'Transferred to the account', reimbursement: 'Reimbursement',
      net_deduction: 'Deduction from net', deduction: 'Deduction', tax: 'Tax', tax_special: 'Tax (special rate)',
    },
    conflict: 'the documents print different values',
    note: 'This is what the document prints, not a Loonto calculation — it needs verification.',
    whyNet: 'This version does not calculate the difference between gross and net — I only show what is printed. A line missing from the reading does not mean zero.',
    noContext: 'There is no read document in this conversation, so I cannot answer from a document. Add and read a document, or write the value in a message.',
    notFound: 'The document reading does not contain this — I am not guessing.',
    backTo: 'Back to the variant:',
    printedTitle: 'Printed on the document',
    printedNote: 'A reading, not a calculation — needs verification.',
  },
  questions: {
    clarify: (total) => (total !== null ? `Are these ${total} hours regular Monday-to-Friday hours? If they include Saturday, Sunday or overtime, answer “No”.` : 'Are these regular Monday-to-Friday hours?'),
    split: (total) => `How do ${total !== null ? `these ${total} hours` : 'these hours'} split? Write e.g. “32 hours Monday to Friday and 8 hours on Saturday”.`,
    opening: (hours) => `${hours !== null ? `Your contract says ${hours} hours a week, but I ask about a specific week. ` : ''}How many hours do you want to calculate, and on which days? E.g. “40 hours Monday to Friday”.`,
    hours: (label) => `How many ${label}?`,
    rate: (docsRead) => `${docsRead ? 'I do not find an hourly rate in the documents. ' : ''}What is your gross hourly rate?`,
    premium: (label, docsRead) => `${docsRead ? `The documents show no ${label}. ` : ''}How many percent on top of the normal rate is the ${label}?`,
    offer: (label, value) => `I see. I can use a Loonto assumption: ${label} ${value} on top of the rate. It is only an assumption — not a document fact or a rule. Use it in the variant?`,
    conflict: (label) => `I have two different values: ${label}. Which one is right?`,
    correct: (label) => `This value looks wrong: ${label}. Please enter it again.`,
    generic: (label) => `I need one more piece of information: ${label}.`,
    threshold: 'After how many hours a day does the second overtime tier start?',
    distribution: 'Over how many days of the week is the overtime spread?',
  },
  composer: {
    legend: 'Example answers', localLegend: 'Choose', inputLabel: 'Your message', placeholder: 'Write in your own words…',
    note: 'Short answers and questions about the document are understood without an AI model; longer messages may be interpreted by a language model — it then sees only numbers read from the document (e.g. rate, hours), no names and no document text.',
    send: 'Send', tooLong: 'The message is too long (max. 1000 characters).', busy: 'One moment…',
  },
  panel: {
    toggle: 'Scenario', scenarioTitle: 'Your weekly scenario', scenarioTag: 'Working values',
    empty: 'The data for the calculation will appear here — from the conversation and the documents.',
    sources: {
      user: 'Your information', loonto_assumption: 'Loonto assumption', correction: 'Your correction', document_reading: 'Document — read, needs verification',
      documents_agree: 'Documents (agree) — needs verification', user_confirmed: 'Your choice among the documents', user_corrected: 'Your correction in the profile', conflict: 'Conflict', unknown: 'Unknown',
      document: 'From the document (server reading) — needs verification',
    },
    documentLine: (value, status) => `Document: ${value} — ${status}`,
    correctionNote: (date) => `Your correction of ${date}. The document reading stays unchanged.`,
    edit: 'Change', correct: 'Correct', save: 'Save', cancel: 'Cancel',
    editLabel: (label) => `New value: ${label}`,
    editNote: 'A change is your declaration — it does not change the document or its reading.',
    editErrors: { not_a_number: 'Enter a number, e.g. 16.80.', out_of_range: 'This value is outside the allowed range.' },
    deferredTag: 'Put aside',
    resultTitle: 'Result', resultStatus: 'Result not available yet',
    resultLead: 'This version of Loonto does not show a pay amount.',
    reasons: {
      documentProvisional: 'Document values are a reading the server does not verify yet — no amount is calculated from them.',
      missing: (items) => `Missing: ${items}.`,
      conflict: 'The rate is unresolved (two values in the documents).',
      outOfGoal: 'Tax, deductions and net items are not part of this conversation yet.',
      gate: 'Amounts appear only after the calculation safety gates are closed (next stage).',
    },
    explainTitle: 'What works in this version?',
    explain: [
      'Documents are read by the existing Loonto reader (Google Gemini) and combined by the existing payroll profile — with the period, page and source of every value.',
      'The conversation is the existing Loonto conversation module: code, not the AI model, picks the next question, and it does not ask for what the documents already show.',
      'Questions about the document (rate, hours, net, transfer) are answered from the printed values the server read and keeps for this browser session for at most 2 hours.',
      'A document reading is not a verified payroll fact — so even when the conversation uses it, no amount is shown.',
    ],
    analyzerTitle: 'Analyzer', analyzerButton: 'Analyzer in preparation',
    analyzerNote: 'A closer check of conflicts and their basis (contract, CAO) — in a later stage. Nothing is analysed now.',
    reset: 'Start over',
  },
};

export const R3B_COPY: Record<R3BLang, R3BCopy> = { pl: PL, en: EN };
