import type { ChoiceId, EditError, LoontoMessageKey, ResultReason, RowId, RowSource, RowStatus } from './r3a-demo.ts';

/**
 * R3-A demo copy (PL / EN). Natural, short sentences - no field paths, provenance objects or codes. Kept separate from
 * the existing app's translations.ts so the current screens and their tests are untouched.
 */

export type DemoLang = 'pl' | 'en';

export interface DemoCopy {
  pageTitle: string;
  badge: string;
  banner: string;
  backToCurrent: string;
  langLabel: string;
  title: string;
  lead: string;
  threadLabel: string;
  loontoName: string;
  youName: string;
  exampleTag: string;
  messages: Record<LoontoMessageKey, string>;
  docRead: { title: string; file: string; body: string };
  docSummary: { intro: string; facts: string[]; tag: string; note: string };
  choices: Record<ChoiceId, string>;
  choicesLegend: string;
  inputLabel: string;
  inputPlaceholder: string;
  inputNote: string;
  send: string;
  panelToggle: (count: number) => string;
  scenario: {
    title: string;
    tag: string;
    empty: string;
    labels: Record<RowId, string>;
    sources: Record<RowSource, string>;
    previous: (source: string) => string;
    statuses: Record<RowStatus, string>;
    unknownValue: string;
    unsupportedValue: string;
    week: string;
    asSaid: string;
    details: string;
    why: (source: RowSource, status: RowStatus) => string;
    edit: string;
    save: string;
    cancel: string;
    newValue: (label: string) => string;
    editNote: string;
    errors: Record<EditError, string>;
  };
  assumption: { title: string; body: string };
  result: {
    title: string;
    unavailable: string;
    needsClarification: string;
    lead: string;
    reasonsTitle: string;
    reasons: Record<ResultReason, string>;
    explainSummary: string;
    explainBody: string;
  };
  analyzer: { button: string; body: string; notice: string };
  reset: string;
}

const PL: DemoCopy = {
  pageTitle: 'Loonto — rozmowa (wersja pokazowa)',
  badge: 'Wersja pokazowa',
  banner: 'Wersja pokazowa na przykładowych, niezweryfikowanych danych. Odpowiedzi Loonto są zapisanym przykładem — nic nie jest liczone, wysyłane ani zapisywane.',
  backToCurrent: 'Obecna wersja Loonto',
  langLabel: 'Język',
  title: 'Co chcesz policzyć?',
  lead: 'Możesz zacząć bez dokumentów. Opisz swój tydzień pracy albo wybierz przykład poniżej.',
  threadLabel: 'Rozmowa (przykład)',
  loontoName: 'Loonto',
  youName: 'Ty',
  exampleTag: 'przykład',
  messages: {
    opening: 'Cześć! Pomogę Ci ułożyć tydzień pracy do wyliczenia wypłaty. Pytam zawsze o jedną rzecz naraz — a jeśli czegoś nie wiesz, to nic.',
    how_it_works: 'Opisujesz tydzień własnymi słowami, a ja dopytuję o jedną rzecz naraz. Każda wartość w scenariuszu ma widoczne źródło. Kwotę liczy wyłącznie sprawdzony silnik Loonto — nigdy sama rozmowa.',
    free_text_not_connected: 'Dziękuję! W tej wersji pokazowej nie analizuję jeszcze własnych wiadomości — rozumienie tekstu zostanie podłączone później. Wybierz jedną z przykładowych odpowiedzi poniżej, żeby zobaczyć dalszą część rozmowy.',
    doc_read: 'Pokażę, jak to wygląda z dokumentem — na fikcyjnym przykładzie.',
    doc_summary: 'Tak wyglądałoby krótkie podsumowanie:',
    goal_after_doc: 'Co chcesz policzyć?',
    ask_hours_kind: 'Jasne. Czy te 40 godzin to zwykłe godziny od poniedziałku do piątku, czy jest w nich też weekend?',
    hours_dont_know: 'Nie szkodzi — nie przyjmę niczego za Ciebie. Te 40 godzin zostaje w scenariuszu jako „do ustalenia”. Możesz wybrać, jak to wygląda, kiedy będziesz wiedzieć.',
    ask_split: 'Ile z tych 40 godzin przypada na sobotę, a ile na dni od poniedziałku do piątku?',
    split_dont_know: 'W porządku. Nie podzielę godzin za Ciebie — podział zmienia wynik, więc zostaje do ustalenia.',
    ask_sat_premium: 'Jaki dodatek dostajesz za pracę w sobotę?',
    clarify_150: '„150%” może znaczyć dwie różne rzeczy: stawkę 150%, czyli dodatek +50%, albo dodatek +150%. Która to opcja? Do tego czasu niczego z tym nie liczę.',
    sat_dont_know: 'Nie szkodzi. „Nie wiem” nie oznacza zera — dodatek zostaje nieznany. W pełnej wersji Loonto będzie mógł zaproponować orientacyjne założenie, ale tylko za Twoją wyraźną zgodą.',
    ask_rate: 'Jaka jest Twoja stawka godzinowa brutto?',
    rate_from_document: 'Stawkę mam już z przykładowego dokumentu (€16,80/h), więc nie pytam o nią drugi raz. To nadal przykład, niezweryfikowany.',
    rate_dont_know: 'W porządku — stawka zostaje nieznana. Nie wpisuję zera.',
    ask_extras: 'Czy dostajesz jeszcze jakieś inne dodatki, na przykład nocne albo zmianowe?',
    night_unsupported: 'Dodatku nocnego ani zmianowego jeszcze nie obsługujemy w wyliczeniach. Zapisuję go jako nieobsługiwany — nie zamienię go na dodatek weekendowy.',
    done: 'Mam przykładowy scenariusz. Kwoty wypłaty tu nie pokażę: w tej wersji pokazowej wyliczenia nie są podłączone. W części „Wynik” widać, czego jeszcze by brakowało.',
    why_no_result: 'Kwotę liczy wyłącznie sprawdzony silnik Loonto — nie zgaduję jej w rozmowie. Ta wersja pokazuje tylko, jak będzie wyglądać rozmowa i scenariusz. Podłączenie wyliczeń to kolejny etap.',
  },
  docRead: { title: 'Przykładowy dokument (fikcyjny)', file: 'umowa_przyklad_DEMO.pdf', body: 'Symulacja odczytu — nic nie zostało wgrane ani przeczytane.' },
  docSummary: {
    intro: 'Tak wyglądałoby krótkie podsumowanie:',
    facts: ['Stawka: €16,80/h', 'Wypłata: co tydzień', 'Dodatek za sobotę: nie znaleziono'],
    tag: 'Przykład · niezweryfikowane',
    note: 'W pełnej wersji fakty z Twoich dokumentów zostaną oznaczone jako „Dokument” dopiero po sprawdzeniu.',
  },
  choices: {
    goal_40h: 'Ile dostanę za 40 godzin w tygodniu?',
    sample_document: 'Pokaż przykład z dokumentem',
    how_it_works: 'Jak to działa?',
    hours_weekdays: 'Od poniedziałku do piątku',
    hours_with_saturday: 'Jest w nich też sobota',
    hours_dont_know: 'Nie wiem',
    split_32_8: '32 godziny pon–pt i 8 w sobotę',
    split_dont_know: 'Nie wiem',
    sat_plus_50: '+50% do stawki',
    sat_150: '150%',
    sat_dont_know: 'Nie wiem',
    clarify_150_plus_50: 'Stawka 150%, czyli +50%',
    clarify_150_plus_150: 'Dodatek +150%',
    rate_1680: '€16,80 za godzinę',
    rate_dont_know: 'Nie wiem',
    extras_night: 'Tak, dodatek nocny',
    extras_none: 'Nie, to wszystko',
    show_scenario: 'Pokaż scenariusz i wynik',
    why_no_result: 'Dlaczego nie ma kwoty?',
    start_over: 'Zacznij od nowa',
  },
  choicesLegend: 'Przykładowe odpowiedzi',
  inputLabel: 'Twoja wiadomość',
  inputPlaceholder: 'Napisz własnymi słowami…',
  inputNote: 'Własny tekst nie jest jeszcze analizowany — to wersja pokazowa.',
  send: 'Wyślij',
  panelToggle: (count) => `Scenariusz i wynik (${count})`,
  scenario: {
    title: 'Scenariusz',
    tag: 'Przykład · niezweryfikowane',
    empty: 'Na razie pusto. Wartości pojawią się tutaj, gdy odpowiesz w rozmowie.',
    labels: {
      total_hours: 'Godziny w tygodniu (razem)',
      weekday_hours: 'Zwykłe godziny (pon–pt)',
      saturday_hours: 'Godziny w sobotę',
      saturday_premium: 'Dodatek za sobotę',
      hourly_rate: 'Stawka godzinowa brutto',
      pay_period: 'Okres wypłaty',
      night_allowance: 'Dodatek nocny / zmianowy',
    },
    sources: { user_example: 'Twoja odpowiedź (przykład)', sample_document: 'Przykładowy dokument · niezweryfikowane', user_edit_example: 'Twoja zmiana (przykład)' },
    previous: (source) => `wcześniej: ${source}`,
    statuses: {
      given: 'Podane',
      to_classify: 'Do ustalenia: rodzaj godzin',
      needs_clarification: 'Wymaga wyjaśnienia',
      unknown: 'Nieznane — to nie znaczy 0',
      unsupported: 'Nieobsługiwane — nie liczone',
      unverified_example: 'Przykład — niezweryfikowany',
    },
    unknownValue: 'nieznane',
    unsupportedValue: 'nie liczone',
    week: 'tydzień',
    asSaid: 'jak podano',
    details: 'Skąd ta wartość?',
    why: (source, status) =>
      status === 'needs_clarification'
        ? 'Podano „150%”. To może być stawka 150% albo dodatek +150% — dlatego nic z tym nie liczę, dopóki nie zostanie wybrane znaczenie.'
        : status === 'unknown'
          ? 'Odpowiedź brzmiała „Nie wiem”. Wartość zostaje nieznana — nie wpisuję za Ciebie zera ani założenia.'
          : status === 'unsupported'
            ? 'Ten rodzaj dodatku nie jest jeszcze obsługiwany. Nie jest liczony i nie trafia do dodatków weekendowych.'
            : status === 'to_classify'
              ? 'Podano łączną liczbę godzin, ale nie wiadomo jeszcze, ile z nich to dni robocze, a ile weekend.'
              : source === 'sample_document'
                ? 'Wartość z fikcyjnego, przykładowego dokumentu. Nie została sprawdzona i nie jest faktem z Twoich dokumentów.'
                : source === 'user_edit_example'
                  ? 'Ta wartość została zmieniona w scenariuszu. Zmiana dotyczy tylko tego przykładu.'
                  : 'Wartość z Twojej przykładowej odpowiedzi w rozmowie.',
    edit: 'Zmień',
    save: 'Zapisz',
    cancel: 'Anuluj',
    newValue: (label) => `Nowa wartość: ${label}`,
    editNote: 'Zmiana dotyczy tylko tego przykładu — nie zmienia dokumentów ani danych na serwerze i nie zaczyna rozmowy od nowa.',
    errors: {
      invalid_number: 'Wpisz jedną liczbę, np. 36 albo 16,80.',
      hours_out_of_range: 'Liczba godzin musi być między 0 a 168.',
      must_be_positive: 'Stawka musi być większa od zera.',
    },
  },
  assumption: {
    title: 'Założenie Loonto — jeszcze nieaktywne',
    body: 'W pełnej wersji Loonto może zaproponować orientacyjny dodatek (np. +50% za sobotę). Zostanie on użyty tylko po Twojej wyraźnej zgodzie i zawsze będzie oznaczony. W tej wersji pokazowej nie jest stosowany.',
  },
  result: {
    title: 'Wynik',
    unavailable: 'Niedostępny w wersji pokazowej',
    needsClarification: 'Wymaga wyjaśnienia',
    lead: 'Kwota wypłaty nie jest tu liczona.',
    reasonsTitle: 'Czego brakuje do wyliczenia',
    reasons: {
      demo_engine_not_connected: 'Wyliczenia silnikiem Loonto nie są podłączone do tej wersji pokazowej.',
      hours_missing: 'Brakuje godzin pracy.',
      hours_unclassified: 'Nie wiadomo jeszcze, jak podzielić 40 godzin między dni robocze i weekend.',
      rate_missing: 'Brakuje stawki godzinowej.',
      rate_unknown: 'Stawka godzinowa jest nieznana.',
      rate_unverified_example: 'Stawka pochodzi z przykładowego dokumentu i nie jest sprawdzona.',
      saturday_premium_missing: 'Brakuje dodatku za sobotę.',
      saturday_premium_unknown: 'Dodatek za sobotę jest nieznany (to nie znaczy 0).',
      premium_150_ambiguous: '„150%” wymaga wyjaśnienia, zanim cokolwiek zostanie policzone.',
      allowance_unsupported: 'Dodatek nocny / zmianowy nie jest jeszcze obsługiwany.',
      tax_and_deductions_not_asked: 'Ulga podatkowa i potrącenia nie zostały ustalone w tym przykładzie.',
    },
    explainSummary: 'Dlaczego nie ma kwoty?',
    explainBody: 'Kwotę liczy wyłącznie sprawdzony silnik Loonto, nigdy rozmowa. Gdy wyliczenia zostaną podłączone, wynik pojawi się tutaj — z widocznymi założeniami, a przy niepewności jako zakres. Wartości „nie wiem” nigdy nie są liczone jako zero.',
  },
  analyzer: {
    button: 'Analizator w przygotowaniu',
    body: 'Sprawdzanie paska wypłaty względem umowy będzie dostępne później. Ten przycisk jeszcze niczego nie otwiera.',
    notice: 'Analizator nie jest jeszcze dostępny w tej wersji.',
  },
  reset: 'Zacznij od nowa',
};

const EN: DemoCopy = {
  pageTitle: 'Loonto — conversation (preview)',
  badge: 'Preview version',
  banner: 'Preview version on sample, unverified data. Loonto\'s replies are a recorded example — nothing is calculated, sent or saved.',
  backToCurrent: 'Current Loonto version',
  langLabel: 'Language',
  title: 'What would you like to calculate?',
  lead: 'You can start without documents. Describe your working week or pick an example below.',
  threadLabel: 'Conversation (example)',
  loontoName: 'Loonto',
  youName: 'You',
  exampleTag: 'example',
  messages: {
    opening: 'Hi! I\'ll help you set up your working week to estimate your pay. I always ask one thing at a time — and if you don\'t know something, that\'s fine.',
    how_it_works: 'You describe your week in your own words, and I ask about one thing at a time. Every value in the scenario shows where it came from. Only the verified Loonto engine calculates amounts — never the conversation itself.',
    free_text_not_connected: 'Thank you! This preview does not read your own messages yet — understanding free text will be connected later. Pick one of the example answers below to see how the conversation continues.',
    doc_read: 'Here is how it looks with a document — using a fictitious example.',
    doc_summary: 'A short summary would look like this:',
    goal_after_doc: 'What would you like to calculate?',
    ask_hours_kind: 'Sure. Are those 40 hours regular hours Monday to Friday, or do they include the weekend?',
    hours_dont_know: 'No problem — I won\'t assume anything for you. The 40 hours stay in the scenario as "to be decided". You can choose once you know.',
    ask_split: 'How many of those 40 hours fall on Saturday, and how many Monday to Friday?',
    split_dont_know: 'Fine. I won\'t split the hours for you — the split changes the result, so it stays to be decided.',
    ask_sat_premium: 'What premium do you get for working on Saturday?',
    clarify_150: '"150%" can mean two different things: a 150% rate, i.e. +50%, or a +150% premium. Which one is it? Until then I calculate nothing with it.',
    sat_dont_know: 'No problem. "I don\'t know" does not mean zero — the premium stays unknown. In the full version Loonto may suggest an indicative assumption, but only with your explicit consent.',
    ask_rate: 'What is your gross hourly rate?',
    rate_from_document: 'I already have the rate from the sample document (€16.80/h), so I won\'t ask again. It is still an unverified example.',
    rate_dont_know: 'Fine — the rate stays unknown. I won\'t enter zero.',
    ask_extras: 'Do you receive any other allowances, for example night or shift allowances?',
    night_unsupported: 'Night and shift allowances are not supported in calculations yet. I\'m recording it as unsupported — I won\'t turn it into a weekend premium.',
    done: 'I have an example scenario. I won\'t show a pay amount here: calculations are not connected in this preview. The "Result" section shows what would still be missing.',
    why_no_result: 'Only the verified Loonto engine calculates amounts — I never guess them in the conversation. This preview only shows how the conversation and scenario will look. Connecting calculations is the next stage.',
  },
  docRead: { title: 'Sample document (fictitious)', file: 'contract_example_DEMO.pdf', body: 'Simulated reading — nothing was uploaded or read.' },
  docSummary: {
    intro: 'A short summary would look like this:',
    facts: ['Rate: €16.80/h', 'Pay: weekly', 'Saturday premium: not found'],
    tag: 'Example · unverified',
    note: 'In the full version, facts from your documents are labelled "Document" only after they have been checked.',
  },
  choices: {
    goal_40h: 'How much will I get for 40 hours a week?',
    sample_document: 'Show an example with a document',
    how_it_works: 'How does it work?',
    hours_weekdays: 'Monday to Friday',
    hours_with_saturday: 'They include Saturday',
    hours_dont_know: 'I don\'t know',
    split_32_8: '32 hours Mon–Fri and 8 on Saturday',
    split_dont_know: 'I don\'t know',
    sat_plus_50: '+50% on the rate',
    sat_150: '150%',
    sat_dont_know: 'I don\'t know',
    clarify_150_plus_50: 'A 150% rate, i.e. +50%',
    clarify_150_plus_150: 'A +150% premium',
    rate_1680: '€16.80 an hour',
    rate_dont_know: 'I don\'t know',
    extras_night: 'Yes, a night allowance',
    extras_none: 'No, that\'s all',
    show_scenario: 'Show scenario and result',
    why_no_result: 'Why is there no amount?',
    start_over: 'Start over',
  },
  choicesLegend: 'Example answers',
  inputLabel: 'Your message',
  inputPlaceholder: 'Write in your own words…',
  inputNote: 'Your own text is not analysed yet — this is a preview.',
  send: 'Send',
  panelToggle: (count) => `Scenario and result (${count})`,
  scenario: {
    title: 'Scenario',
    tag: 'Example · unverified',
    empty: 'Empty for now. Values appear here as you answer in the conversation.',
    labels: {
      total_hours: 'Hours per week (total)',
      weekday_hours: 'Regular hours (Mon–Fri)',
      saturday_hours: 'Saturday hours',
      saturday_premium: 'Saturday premium',
      hourly_rate: 'Gross hourly rate',
      pay_period: 'Pay period',
      night_allowance: 'Night / shift allowance',
    },
    sources: { user_example: 'Your answer (example)', sample_document: 'Sample document · unverified', user_edit_example: 'Your change (example)' },
    previous: (source) => `before: ${source}`,
    statuses: {
      given: 'Given',
      to_classify: 'To decide: kind of hours',
      needs_clarification: 'Needs clarification',
      unknown: 'Unknown — this does not mean 0',
      unsupported: 'Unsupported — not calculated',
      unverified_example: 'Example — unverified',
    },
    unknownValue: 'unknown',
    unsupportedValue: 'not calculated',
    week: 'week',
    asSaid: 'as given',
    details: 'Where does this come from?',
    why: (source, status) =>
      status === 'needs_clarification'
        ? 'You said "150%". That can be a 150% rate or a +150% premium — so nothing is calculated with it until you choose.'
        : status === 'unknown'
          ? 'You answered "I don\'t know". The value stays unknown — I don\'t enter zero or an assumption for you.'
          : status === 'unsupported'
            ? 'This kind of allowance is not supported yet. It is not calculated and is not treated as a weekend premium.'
            : status === 'to_classify'
              ? 'You gave a total number of hours, but it is not yet known how many are weekdays and how many weekend.'
              : source === 'sample_document'
                ? 'A value from a fictitious sample document. It has not been checked and is not a fact from your documents.'
                : source === 'user_edit_example'
                  ? 'You changed this value in the scenario. The change applies only to this example.'
                  : 'A value from your example answer in the conversation.',
    edit: 'Change',
    save: 'Save',
    cancel: 'Cancel',
    newValue: (label) => `New value: ${label}`,
    editNote: 'The change applies only to this example — it does not change documents or server data and does not restart the conversation.',
    errors: {
      invalid_number: 'Enter one number, e.g. 36 or 16.80.',
      hours_out_of_range: 'Hours must be between 0 and 168.',
      must_be_positive: 'The rate must be greater than zero.',
    },
  },
  assumption: {
    title: 'Loonto assumption — not active yet',
    body: 'In the full version Loonto may suggest an indicative premium (e.g. +50% for Saturday). It will be used only after your explicit consent and will always be labelled. It is not applied in this preview.',
  },
  result: {
    title: 'Result',
    unavailable: 'Not available in the preview',
    needsClarification: 'Needs clarification',
    lead: 'No pay amount is calculated here.',
    reasonsTitle: 'What is missing for a calculation',
    reasons: {
      demo_engine_not_connected: 'Calculations by the Loonto engine are not connected to this preview.',
      hours_missing: 'Working hours are missing.',
      hours_unclassified: 'It is not yet known how the 40 hours split between weekdays and the weekend.',
      rate_missing: 'The hourly rate is missing.',
      rate_unknown: 'The hourly rate is unknown.',
      rate_unverified_example: 'The rate comes from a sample document and has not been checked.',
      saturday_premium_missing: 'The Saturday premium is missing.',
      saturday_premium_unknown: 'The Saturday premium is unknown (this does not mean 0).',
      premium_150_ambiguous: '"150%" needs clarification before anything is calculated.',
      allowance_unsupported: 'The night / shift allowance is not supported yet.',
      tax_and_deductions_not_asked: 'The tax credit and deductions were not set in this example.',
    },
    explainSummary: 'Why is there no amount?',
    explainBody: 'Only the verified Loonto engine calculates amounts, never the conversation. Once calculations are connected, the result will appear here — with visible assumptions, and as a range when something is uncertain. "I don\'t know" values are never counted as zero.',
  },
  analyzer: {
    button: 'Analyzer in preparation',
    body: 'Checking a payslip against the contract will be available later. This button does not open anything yet.',
    notice: 'The Analyzer is not available in this version yet.',
  },
  reset: 'Start over',
};

export const DEMO_COPY: Record<DemoLang, DemoCopy> = { pl: PL, en: EN };

/** Display text for a row value. Unknown is shown as "unknown" - never as 0. */
export function formatRowValue(copy: DemoCopy, lang: DemoLang, value: number | 'week' | null, unit: string, status: RowStatus): string {
  if (status === 'unsupported') return copy.scenario.unsupportedValue;
  if (value === null) return copy.scenario.unknownValue;
  if (value === 'week') return copy.scenario.week;
  const n = (digits: number) => value.toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  switch (unit) {
    case 'hours':
      return `${n(Number.isInteger(value) ? 0 : 1)} h`;
    case 'eur_per_hour':
      return `€${n(2)}/h`;
    case 'premium_above_base':
      return `+${n(0)}%`;
    case 'percent_as_said':
      return `${n(0)}% (${copy.scenario.asSaid})`;
    default:
      return n(0);
  }
}
