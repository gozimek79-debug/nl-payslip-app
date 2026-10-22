import { R3B_COPY } from '../r3b/r3b-copy.ts';
import type { Lang } from '../translations.ts';

/**
 * FIN-02 Payslip Analysis - interface copy (PL/EN). Sentences are assembled from PRINTED facts and from the existing
 * replay's structured results - nothing here is a model answer, a forecast or a legal verdict. The reader's error
 * messages, file rejections and the reading consent are the existing R3-B wording (the same reader, the same consent);
 * the discrepancy labels and arithmetic messages come from `translations.tierC` via tier-c-shared.ts.
 */

type DiscrepancyCode = 'table_tax_mismatch' | 'bt_tax_mismatch' | 'algemene_heffingskorting_mismatch' | 'arbeidskorting_mismatch' | 'net_mismatch' | 'payout_mismatch' | 'minimum_wage_stale_on_document' | 'minimum_wage_violation';

export interface PayslipCopy {
  title: string;
  lead: string;
  sampleOnly: string;
  oneAtATime: string;
  select: string;
  change: string;
  remove: string;
  types: string;
  selected: (name: string) => string;
  rejected: (typeof R3B_COPY)['pl']['offer']['rejected'];
  consentTitle: string;
  consent: string;
  read: string;
  reading: string;
  analysing: string;
  readerUnavailable: string;
  readError: (reason: string) => string;
  readErrors: Record<string, string>;
  retryRead: string;
  referenceUnavailable: string;
  analysisFailed: string;
  retryAnalysis: string;
  summaryTitle: string;
  period: (label: string | null, start: string | null, end: string | null) => string;
  periodUnknown: string;
  rate: (value: string) => string;
  rateConflict: (values: string[]) => string;
  rateUnknown: string;
  hours: (regular: string | null, overtime: string | null) => string;
  hoursUnknown: string;
  grossLabel: string;
  netLabel: string;
  payoutLabel: string;
  notRead: string;
  asPrinted: (label: string) => string;
  payoutVsNet: (difference: string) => string;
  printedNote: string;
  coverageFull: (total: number) => string;
  coveragePartial: (pages: string, total: number) => string;
  itemsTitle: string;
  payLinesTitle: string;
  surchargesTitle: string;
  deductionsTitle: string;
  taxTitle: string;
  reimbursementsTitle: string;
  noItems: string;
  page: (n: number) => string;
  unlabelled: string;
  checksTitle: string;
  arithmeticTitle: string;
  arithmeticIntro: string;
  arithmeticNone: string;
  arithmeticCauses: string;
  comparisonTitle: string;
  comparisonIntro: string;
  comparisonLimited: string;
  gapPagesNotRead: (pages: string) => string;
  gapIncomplete: string;
  comparisonUnavailable: (reason: string) => string;
  comparisonNone: string;
  discrepancyLine: (computed: string, printed: string, difference: string) => string;
  discrepancyNoComputed: (printed: string) => string;
  statusConfirm: string;
  statusFinding: string;
  causes: Record<DiscrepancyCode, string>;
  causesLabel: string;
  notProof: string;
  uncertainTitle: string;
  replayProblem: Record<'document_expired' | 'tax_rates_unavailable' | 'replay_failed', string>;
  limitsTitle: string;
  limits: string[];
  notAdvice: string;
  askAdvisor: string;
  askAdvisorNote: string;
  another: string;
}

const date = (iso: string | null, lang: Lang) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split('-');
  return lang === 'pl' ? `${d}.${m}.${y}` : `${d}/${m}/${y}`;
};

const pl: PayslipCopy = {
  title: 'Analiza paska wypłaty',
  lead: 'Dodaj jeden pasek wypłaty. Pokażemy, co jest na nim wydrukowane, czy jego liczby się sumują i czego nie da się sprawdzić.',
  sampleOnly: 'Wersja testowa: używaj wyłącznie pasków przykładowych.',
  oneAtATime: 'Na razie analizujemy jeden pasek naraz — porównanie kilku okresów jeszcze nie jest dostępne.',
  select: 'Wybierz pasek wypłaty',
  change: 'Zmień plik',
  remove: 'Usuń plik',
  types: R3B_COPY.pl.offer.types,
  selected: (name) => `Wybrany plik: ${name}`,
  rejected: R3B_COPY.pl.offer.rejected,
  consentTitle: R3B_COPY.pl.offer.consentTitle,
  consent: R3B_COPY.pl.offer.consent,
  read: 'Odczytaj pasek przez Gemini',
  reading: 'Czytam pasek… To może potrwać do minuty.',
  analysing: 'Sprawdzam odczytane liczby…',
  readerUnavailable: 'Na tym adresie odczyt dokumentów nie działa: czytnik (Gemini) nie jest tu skonfigurowany. Analiza paska wymaga odczytu, więc tutaj jej nie wykonamy.',
  readError: (reason) => `Nie udało się odczytać paska: ${reason}.`,
  readErrors: R3B_COPY.pl.readReport.errors,
  retryRead: 'Spróbuj odczytać ponownie',
  referenceUnavailable: 'Pasek został odczytany, ale serwer nie mógł bezpiecznie zachować odczytu dla tej sesji. Danych przesłanych z przeglądarki nie analizujemy — spróbuj ponownie za chwilę.',
  analysisFailed: 'Nie udało się przygotować analizy odczytu (możliwe, że odczyt wygasł). Spróbuj ponownie albo odczytaj pasek jeszcze raz.',
  retryAnalysis: 'Spróbuj ponownie',
  summaryTitle: 'Co jest na pasku',
  period: (label, start, end) => {
    const range = start && end ? ` (${date(start, 'pl')} – ${date(end, 'pl')})` : '';
    return `Okres: ${label ?? 'bez nazwy'}${range}.`;
  },
  periodUnknown: 'Okresu nie odczytano z paska.',
  rate: (value) => `Stawka godzinowa (wydrukowana): ${value}/h.`,
  rateConflict: (values) => `Na pasku wydrukowano różne stawki godzinowe: ${values.join(' i ')}. Loonto nie wybiera żadnej z nich.`,
  rateUnknown: 'Stawki godzinowej nie odczytano z paska.',
  hours: (regular, overtime) => `Opłacone godziny (wydrukowane): ${[regular ? `zwykłe ${regular} h` : null, overtime ? `nadgodziny ${overtime} h` : null].filter(Boolean).join(', ')}.`,
  hoursUnknown: 'Liczby godzin nie odczytano z paska.',
  grossLabel: 'Brutto razem (wydrukowane)',
  netLabel: 'Netto (wydrukowane)',
  payoutLabel: 'Przelano / do wypłaty (wydrukowane)',
  notRead: 'nie odczytano z paska — to nie znaczy 0',
  asPrinted: (label) => `na pasku: „${label}”`,
  payoutVsNet: (difference) => `Kwota przelana różni się od netto o ${difference}. Taką różnicę tworzą zwykle pozycje netto — zwroty kosztów albo potrącenia po opodatkowaniu (lista poniżej).`,
  printedNote: 'Kwoty powyżej to odczyt wydrukowanego paska za ten jeden okres — nie prognoza przyszłej wypłaty i nie wynik obliczeń Loonto.',
  coverageFull: (total) => `Odczytano ${total === 1 ? 'jedyną stronę' : `wszystkie strony (${total})`}.`,
  coveragePartial: (pages, total) => `Nie odczytano stron ${pages} z ${total} — pozycji z tych stron tu nie ma.`,
  itemsTitle: 'Wszystkie odczytane pozycje',
  payLinesTitle: 'Linie wynagrodzenia',
  surchargesTitle: 'Dodatki procentowe',
  deductionsTitle: 'Potrącenia',
  taxTitle: 'Podatek (wydrukowany)',
  reimbursementsTitle: 'Zwroty i dodatki netto',
  noItems: 'brak odczytanych pozycji',
  page: (n) => `str. ${n}`,
  unlabelled: 'pozycja bez opisu',
  checksTitle: 'Kontrola liczb',
  arithmeticTitle: 'Czy liczby na pasku się sumują',
  arithmeticIntro: 'Porównujemy wydrukowane sumy z odczytanymi pozycjami tego samego paska (bez żadnych założeń Loonto).',
  arithmeticNone: 'Nie znaleźliśmy niezgodności w sumach, które da się sprawdzić z odczytanych pozycji.',
  arithmeticCauses: 'Możliwe przyczyny: błąd odczytu, pozycja, której nie odczytano, albo pozycja rozliczona inaczej. Sprawdź te kwoty na oryginale.',
  comparisonTitle: 'Porównanie z wyliczeniem Loonto',
  comparisonIntro: 'Loonto przelicza podatek, netto i wypłatę z odczytanych pozycji i aktualnych tabel, a potem porównuje z kwotami wydrukowanymi.',
  comparisonLimited: 'Tego porównania nie pokazujemy, bo brakuje danych, od których zależy wyliczenie:',
  gapPagesNotRead: (pages) => `Nie odczytano stron ${pages} — pozycje z tych stron mogłyby wyjaśnić każdą różnicę.`,
  gapIncomplete: 'Wyliczenie Loonto jest niepełne dla tego paska.',
  comparisonUnavailable: (reason) => (reason === 'period_type_unknown'
    ? 'Na pasku nie odczytano rodzaju okresu (tydzień, 4 tygodnie, miesiąc), więc Loonto niczego nie przelicza.'
    : 'Tego paska nie da się przeliczyć — porównania nie ma.'),
  comparisonNone: 'Wyliczenie Loonto zgadza się z wydrukowanymi kwotami w granicach tolerancji.',
  discrepancyLine: (computed, printed, difference) => `Loonto: ${computed} · na pasku: ${printed} · różnica: ${difference}`,
  discrepancyNoComputed: (printed) => `Na pasku: ${printed} — Loonto nie ma kwoty do porównania.`,
  statusConfirm: 'Mała różnica — warto sprawdzić',
  statusFinding: 'Różnica',
  causes: {
    table_tax_mismatch: 'inna tabela podatkowa lub inne ustawienie ulgi (loonheffingskorting), dodatki opodatkowane osobno, błąd odczytu',
    bt_tax_mismatch: 'inna stawka specjalna (bijzonder tarief) lub inna podstawa, błąd odczytu',
    algemene_heffingskorting_mismatch: 'inny sposób naliczenia ulgi przez pracodawcę, błąd odczytu',
    arbeidskorting_mismatch: 'inny sposób naliczenia ulgi przez pracodawcę, błąd odczytu',
    net_mismatch: 'potrącenia lub dodatki, których nie odczytano, składka emerytalna, inne ustawienie podatku, błąd odczytu',
    payout_mismatch: 'pozycje netto, których nie odczytano (zwroty, zaliczki, potrącenia), błąd odczytu',
    minimum_wage_stale_on_document: 'na pasku wydrukowano starszą kwotę minimalnego wynagrodzenia; to informacja na pasku, nie wyliczenie Twojej płacy',
    minimum_wage_violation: 'minimalna stawka zależy m.in. od wieku i okresu — Loonto nie zna Twojego wieku i nie stwierdza naruszenia',
  },
  causesLabel: 'Możliwe przyczyny:',
  notProof: 'Różnica to powód, żeby sprawdzić pasek albo zapytać pracodawcę — nie dowód błędu ani naruszenia prawa.',
  uncertainTitle: 'Odczyt do sprawdzenia',
  replayProblem: {
    document_expired: 'Odczyt wygasł (po 2 godzinach). Odczytaj pasek ponownie, żeby sprawdzić liczby.',
    tax_rates_unavailable: 'Tabele podatkowe są chwilowo niedostępne, więc nie ma kontroli liczb. Odczyt powyżej jest kompletny.',
    replay_failed: 'Kontrola liczb nie powiodła się. Odczyt powyżej jest poprawny — spróbuj kontroli ponownie.',
  },
  limitsTitle: 'Czego ta analiza nie sprawdza',
  limits: [
    'czy stawka, dodatki i nadgodziny zgadzają się z Twoją umową lub CAO,',
    'czy należą Ci się konkretne świadczenia (np. dodatki, urlop, vakantiegeld),',
    'poprawności ustawień podatkowych pracodawcy i składek emerytalnych,',
    'przyszłych wypłat — to odczyt jednego, minionego okresu.',
  ],
  notAdvice: 'To nie jest porada prawna ani podatkowa.',
  askAdvisor: 'Zapytaj doradcę AI o ten pasek',
  askAdvisorNote: 'Doradca w Kalkulatorze PRO (wersja testowa) zobaczy ten sam odczyt — bez ponownego wysyłania pliku.',
  another: 'Analizuj inny pasek',
};

const en: PayslipCopy = {
  title: 'Payslip analysis',
  lead: 'Add one payslip. We show what is printed on it, whether its figures add up and what cannot be checked.',
  sampleOnly: 'Test version: use sample payslips only.',
  oneAtATime: 'For now we analyse one payslip at a time - comparing several periods is not available yet.',
  select: 'Choose a payslip',
  change: 'Change file',
  remove: 'Remove file',
  types: R3B_COPY.en.offer.types,
  selected: (name) => `Selected file: ${name}`,
  rejected: R3B_COPY.en.offer.rejected,
  consentTitle: R3B_COPY.en.offer.consentTitle,
  consent: R3B_COPY.en.offer.consent,
  read: 'Read the payslip with Gemini',
  reading: 'Reading the payslip… This can take up to a minute.',
  analysing: 'Checking the figures that were read…',
  readerUnavailable: 'Document reading does not work at this address: the reader (Gemini) is not configured here. Payslip analysis needs a read, so it cannot run here.',
  readError: (reason) => `The payslip could not be read: ${reason}.`,
  readErrors: R3B_COPY.en.readReport.errors,
  retryRead: 'Try reading again',
  referenceUnavailable: 'The payslip was read, but the server could not keep the reading safely for this session. Data sent from the browser is not analysed - please try again shortly.',
  analysisFailed: 'The analysis of the reading could not be prepared (the reading may have expired). Try again or read the payslip once more.',
  retryAnalysis: 'Try again',
  summaryTitle: 'What the payslip shows',
  period: (label, start, end) => {
    const range = start && end ? ` (${date(start, 'en')} – ${date(end, 'en')})` : '';
    return `Period: ${label ?? 'unnamed'}${range}.`;
  },
  periodUnknown: 'The period was not read from the payslip.',
  rate: (value) => `Hourly rate (as printed): ${value}/h.`,
  rateConflict: (values) => `The payslip prints different hourly rates: ${values.join(' and ')}. Loonto does not pick one.`,
  rateUnknown: 'The hourly rate was not read from the payslip.',
  hours: (regular, overtime) => `Paid hours (as printed): ${[regular ? `regular ${regular} h` : null, overtime ? `overtime ${overtime} h` : null].filter(Boolean).join(', ')}.`,
  hoursUnknown: 'The number of hours was not read from the payslip.',
  grossLabel: 'Gross total (as printed)',
  netLabel: 'Net (as printed)',
  payoutLabel: 'Transferred / payable (as printed)',
  notRead: 'not read from the payslip - this does not mean 0',
  asPrinted: (label) => `printed as "${label}"`,
  payoutVsNet: (difference) => `The amount transferred differs from net by ${difference}. Such a difference usually comes from net items - reimbursements or post-tax deductions (listed below).`,
  printedNote: 'The amounts above are a reading of the printed payslip for this one period - not a forecast of future pay and not a Loonto calculation.',
  coverageFull: (total) => (total === 1 ? 'The only page was read.' : `All ${total} pages were read.`),
  coveragePartial: (pages, total) => `Pages ${pages} of ${total} were not read - items from those pages are missing here.`,
  itemsTitle: 'Everything that was read',
  payLinesTitle: 'Pay lines',
  surchargesTitle: 'Percentage premiums',
  deductionsTitle: 'Deductions',
  taxTitle: 'Tax (as printed)',
  reimbursementsTitle: 'Reimbursements and net additions',
  noItems: 'nothing read',
  page: (n) => `p. ${n}`,
  unlabelled: 'item without a description',
  checksTitle: 'Checking the figures',
  arithmeticTitle: 'Do the payslip\'s figures add up',
  arithmeticIntro: 'We compare the printed totals with the items read from the same payslip (no Loonto assumptions).',
  arithmeticNone: 'We found no mismatch in the totals that can be checked from the items read.',
  arithmeticCauses: 'Possible causes: a misread, an item that was not read, or an item settled differently. Check these amounts on the original.',
  comparisonTitle: 'Comparison with Loonto\'s calculation',
  comparisonIntro: 'Loonto recalculates tax, net and payout from the items read and the current tables, then compares them with the printed amounts.',
  comparisonLimited: 'This comparison is not shown because the calculation lacks data it depends on:',
  gapPagesNotRead: (pages) => `Pages ${pages} were not read - items on those pages could explain any difference.`,
  gapIncomplete: 'Loonto\'s calculation is incomplete for this payslip.',
  comparisonUnavailable: (reason) => (reason === 'period_type_unknown'
    ? 'The type of period (week, 4 weeks, month) was not read from the payslip, so Loonto recalculates nothing.'
    : 'This payslip cannot be recalculated - there is no comparison.'),
  comparisonNone: 'Loonto\'s calculation matches the printed amounts within tolerance.',
  discrepancyLine: (computed, printed, difference) => `Loonto: ${computed} · on the payslip: ${printed} · difference: ${difference}`,
  discrepancyNoComputed: (printed) => `On the payslip: ${printed} - Loonto has no amount to compare.`,
  statusConfirm: 'Small difference - worth checking',
  statusFinding: 'Difference',
  causes: {
    table_tax_mismatch: 'a different tax table or tax-credit setting (loonheffingskorting), premiums taxed separately, a misread',
    bt_tax_mismatch: 'a different special rate (bijzonder tarief) or base, a misread',
    algemene_heffingskorting_mismatch: 'the employer calculates the credit differently, a misread',
    arbeidskorting_mismatch: 'the employer calculates the credit differently, a misread',
    net_mismatch: 'deductions or additions that were not read, pension contribution, a different tax setting, a misread',
    payout_mismatch: 'net items that were not read (reimbursements, advances, deductions), a misread',
    minimum_wage_stale_on_document: 'the payslip prints an older minimum-wage figure; this is information on the payslip, not a calculation of your pay',
    minimum_wage_violation: 'the minimum rate depends on age and period, among other things - Loonto does not know your age and does not establish a breach',
  },
  causesLabel: 'Possible causes:',
  notProof: 'A difference is a reason to check the payslip or ask the employer - not proof of an error or of a legal breach.',
  uncertainTitle: 'Reading to check',
  replayProblem: {
    document_expired: 'The reading has expired (after 2 hours). Read the payslip again to check its figures.',
    tax_rates_unavailable: 'The tax tables are temporarily unavailable, so the figures are not checked. The reading above is complete.',
    replay_failed: 'Checking the figures failed. The reading above is valid - try the check again.',
  },
  limitsTitle: 'What this analysis does not check',
  limits: [
    'whether the rate, premiums and overtime match your contract or CAO,',
    'whether you are entitled to specific benefits (e.g. premiums, leave, vakantiegeld),',
    'whether the employer\'s tax settings and pension contributions are right,',
    'future pay - this is a reading of one past period.',
  ],
  notAdvice: 'This is not legal or tax advice.',
  askAdvisor: 'Ask the AI advisor about this payslip',
  askAdvisorNote: 'The advisor in Calculator PRO (test version) will see the same reading - without sending the file again.',
  another: 'Analyse another payslip',
};

export const PAYSLIP_COPY: Record<Lang, PayslipCopy> = { pl, en };
