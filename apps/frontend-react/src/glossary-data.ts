/** Human-reviewed, general terminology explanations; not a legal entitlement or a personalised calculation. */
export type GlossaryCategory = 'pay' | 'tax' | 'leave' | 'contract' | 'extras';
export interface GlossaryTerm {
  id: string; nl: string; pl: string; en: string;
  descriptionPl: string; descriptionEn: string; category: GlossaryCategory;
  source?: string;
}

export const GLOSSARY_TERMS: readonly GlossaryTerm[] = [
  {
    "id": "loonstrook",
    "nl": "loonstrook",
    "pl": "pasek wypłaty",
    "en": "payslip",
    "descriptionPl": "Dokument z rozliczeniem wynagrodzenia za dany okres. Zawiera m.in. składniki płacy i potrącenia.",
    "descriptionEn": "A statement of pay for a period, showing wage components and deductions.",
    "category": "pay",
    "source": "https://www.rijksoverheid.nl/vraag-en-antwoord/arbeidsovereenkomst-en-cao/waaraan-moet-mijn-werkgever-zich-houden-bij-een-arbeidsovereenkomst"
  },
  {
    "id": "brutoloon",
    "nl": "brutoloon",
    "pl": "wynagrodzenie brutto",
    "en": "gross pay",
    "descriptionPl": "Kwota wynagrodzenia przed potrąceniami. Nie musi być równa kwocie przelewu.",
    "descriptionEn": "Pay before deductions. It is not necessarily the amount transferred to your account.",
    "category": "pay"
  },
  {
    "id": "nettoloon",
    "nl": "nettoloon",
    "pl": "wynagrodzenie netto",
    "en": "net pay",
    "descriptionPl": "Wynagrodzenie po potrąceniach uwzględnionych w rozliczeniu. Sprawdź oddzielnie pozycję do wypłaty.",
    "descriptionEn": "Pay after deductions shown in payroll. The actual payout can be listed separately.",
    "category": "pay"
  },
  {
    "id": "uurloon",
    "nl": "uurloon",
    "pl": "stawka godzinowa",
    "en": "hourly rate",
    "descriptionPl": "Stawka przypisana do jednej godziny pracy. Dodatki i potrącenia mogą być wykazane osobno.",
    "descriptionEn": "Pay rate for one hour of work. Premiums and deductions may be shown separately.",
    "category": "pay"
  },
  {
    "id": "loonperiode",
    "nl": "loonperiode",
    "pl": "okres rozliczeniowy",
    "en": "pay period",
    "descriptionPl": "Tydzień, cztery tygodnie lub miesiąc, za który sporządzono dane rozliczenie.",
    "descriptionEn": "The week, four-week period or month covered by a payroll statement.",
    "category": "pay"
  },
  {
    "id": "uitbetaald-bedrag",
    "nl": "uitbetaald bedrag",
    "pl": "kwota wypłacona",
    "en": "amount paid out",
    "descriptionPl": "Kwota rzeczywiście wykazana jako wypłacona lub przeznaczona do przelewu. Może uwzględniać zwroty kosztów.",
    "descriptionEn": "The amount listed as paid or payable, which may include reimbursements.",
    "category": "pay"
  },
  {
    "id": "loonheffing",
    "nl": "loonheffing",
    "pl": "potrącenia podatkowe i składkowe",
    "en": "payroll withholding",
    "descriptionPl": "Łączna nazwa podatków i składek potrącanych w systemie holenderskich rozliczeń wynagrodzeń.",
    "descriptionEn": "A collective term for tax and national insurance withholding through payroll.",
    "category": "tax"
  },
  {
    "id": "loonheffingskorting",
    "nl": "loonheffingskorting",
    "pl": "ulga w potrąceniach od wynagrodzenia",
    "en": "payroll tax credit",
    "descriptionPl": "Ulga wpływająca na wysokość pobieranych zaliczek. Przy kilku dochodach zwykle stosuje się ją tylko przy jednym z nich; wybór należy sprawdzić.",
    "descriptionEn": "A tax credit affecting withholding. With multiple incomes, it is normally applied to one income only.",
    "category": "tax",
    "source": "https://www.belastingdienst.nl/wps/wcm/connect/nl/werk-en-inkomen/content/loonheffingskorting-toepassen-of-stoppen"
  },
  {
    "id": "arbeidskorting",
    "nl": "arbeidskorting",
    "pl": "ulga związana z pracą",
    "en": "employment tax credit",
    "descriptionPl": "Jedna z ulg podatkowych związanych z dochodem z pracy, uwzględniana według odpowiednich zasad podatkowych.",
    "descriptionEn": "A tax credit linked to earned income, applied under the relevant tax rules.",
    "category": "tax",
    "source": "https://www.belastingdienst.nl/wps/wcm/connect/nl/werk-en-inkomen/content/loonheffingskorting-toepassen-of-stoppen"
  },
  {
    "id": "pensioenpremie",
    "nl": "pensioenpremie",
    "pl": "składka emerytalna",
    "en": "pension contribution",
    "descriptionPl": "Składka na program emerytalny, jeśli dotyczy danego zatrudnienia. Zasady zależą od programu.",
    "descriptionEn": "Contribution to a pension scheme where applicable; rules depend on the scheme.",
    "category": "tax"
  },
  {
    "id": "inhouding",
    "nl": "inhouding",
    "pl": "potrącenie",
    "en": "deduction",
    "descriptionPl": "Kwota odjęta od rozliczenia, np. zgodnie z pozycją na pasku. Rodzaj i podstawa potrącenia wymagają sprawdzenia.",
    "descriptionEn": "An amount deducted in payroll; the reason and basis should be checked on the payslip.",
    "category": "tax"
  },
  {
    "id": "vakantiegeld",
    "nl": "vakantiegeld",
    "pl": "dodatek urlopowy",
    "en": "holiday allowance",
    "descriptionPl": "Dodatek do wynagrodzenia związany z urlopem, rozliczany według obowiązujących zasad. Data wypłaty może zależeć od ustaleń.",
    "descriptionEn": "Holiday allowance accrued and paid under the applicable rules. Payment timing may vary.",
    "category": "leave",
    "source": "https://www.rijksoverheid.nl/themas/werk/vakantiedagen-en-vakantiegeld/vakantiegeld/vraag-en-antwoord/vakantiedagen-en-vakantiegeld/hoe-hoog-is-mijn-vakantiegeld"
  },
  {
    "id": "vakantiedagen",
    "nl": "vakantiedagen",
    "pl": "dni urlopowe",
    "en": "holiday days",
    "descriptionPl": "Przysługujące lub zgromadzone dni wolne. Na pasku mogą występować jako saldo godzin urlopu.",
    "descriptionEn": "Holiday entitlement or accrued leave; a payslip may show a balance of leave hours.",
    "category": "leave"
  },
  {
    "id": "reserveringen",
    "nl": "reserveringen",
    "pl": "rezerwy / naliczone uprawnienia",
    "en": "accruals or reserves",
    "descriptionPl": "Pozycje pokazujące naliczanie lub saldo świadczeń, np. urlopu. Samo saldo nie musi oznaczać bieżącej wypłaty.",
    "descriptionEn": "Items showing accrued balances such as leave. A balance is not necessarily a current payout.",
    "category": "leave"
  },
  {
    "id": "arbeidsovereenkomst",
    "nl": "arbeidsovereenkomst",
    "pl": "umowa o pracę",
    "en": "employment contract",
    "descriptionPl": "Dokument ustalający warunki zatrudnienia między pracownikiem i pracodawcą.",
    "descriptionEn": "Agreement setting the terms of employment between an employee and employer.",
    "category": "contract",
    "source": "https://www.rijksoverheid.nl/vraag-en-antwoord/arbeidsovereenkomst-en-cao/waaraan-moet-mijn-werkgever-zich-houden-bij-een-arbeidsovereenkomst"
  },
  {
    "id": "uitzendovereenkomst",
    "nl": "uitzendovereenkomst",
    "pl": "umowa pracy tymczasowej",
    "en": "agency work contract",
    "descriptionPl": "Umowa z agencją pracy tymczasowej, gdy pracownik wykonuje pracę u innego podmiotu.",
    "descriptionEn": "A contract with a temporary employment agency while working at a client organisation.",
    "category": "contract"
  },
  {
    "id": "uitzendbeding",
    "nl": "uitzendbeding",
    "pl": "klauzula pracy tymczasowej",
    "en": "agency clause",
    "descriptionPl": "Szczególne postanowienie spotykane w niektórych umowach agencyjnych. Skutki zależą od rodzaju umowy i obowiązujących przepisów.",
    "descriptionEn": "A clause used in some agency contracts; its effects depend on contract type and applicable rules.",
    "category": "contract"
  },
  {
    "id": "cao",
    "nl": "cao",
    "pl": "układ zbiorowy pracy",
    "en": "collective labour agreement",
    "descriptionPl": "Zbiorowe porozumienie o warunkach zatrudnienia. To, czy i który CAO obowiązuje, trzeba ustalić dla konkretnej sytuacji.",
    "descriptionEn": "A collective agreement on employment terms. Whether and which CAO applies must be established for the particular job.",
    "category": "contract",
    "source": "https://www.rijksoverheid.nl/themas/werk/vakantiedagen-en-vakantiegeld/vakantiegeld/vraag-en-antwoord/arbeidsovereenkomst-en-cao/hoe-weet-ik-of-er-voor-mij-een-cao-geldt"
  },
  {
    "id": "proeftijd",
    "nl": "proeftijd",
    "pl": "okres próbny",
    "en": "probationary period",
    "descriptionPl": "Okres próbny uzgodniony w umowie, jeżeli jest dopuszczalny. Warunki zależą od rodzaju i długości umowy.",
    "descriptionEn": "A probationary period agreed in a contract where permitted; requirements depend on contract type and duration.",
    "category": "contract"
  },
  {
    "id": "opzegtermijn",
    "nl": "opzegtermijn",
    "pl": "okres wypowiedzenia",
    "en": "notice period",
    "descriptionPl": "Okres między wypowiedzeniem a zakończeniem zatrudnienia; zależy od obowiązujących zasad.",
    "descriptionEn": "The period between giving notice and employment ending; applicable rules vary.",
    "category": "contract"
  },
  {
    "id": "overuren",
    "nl": "overuren",
    "pl": "nadgodziny",
    "en": "overtime hours",
    "descriptionPl": "Godziny pracy poza przyjętym rozkładem lub limitem. Nie każda dodatkowa godzina daje automatycznie taki sam dodatek.",
    "descriptionEn": "Hours beyond an agreed schedule or threshold. Additional hours do not automatically attract one fixed premium.",
    "category": "extras"
  },
  {
    "id": "toeslag",
    "nl": "toeslag",
    "pl": "dodatek do wynagrodzenia",
    "en": "pay premium",
    "descriptionPl": "Dodatkowa kwota lub procent, np. za określoną porę pracy. Zasady i stawki trzeba ustalić z dokumentów lub CAO.",
    "descriptionEn": "An additional amount or percentage, for example for certain shifts. Eligibility and rates depend on applicable terms.",
    "category": "extras"
  },
  {
    "id": "onregelmatigheidstoeslag-ort",
    "nl": "onregelmatigheidstoeslag (ORT)",
    "pl": "dodatek za nieregularne godziny",
    "en": "irregular-hours premium",
    "descriptionPl": "Dodatek spotykany przy pracy w określonych godzinach lub zmianach. Jego wysokość zależy od zasad danego zatrudnienia.",
    "descriptionEn": "An allowance for certain irregular work hours or shifts; rates depend on applicable employment terms.",
    "category": "extras"
  },
  {
    "id": "reiskostenvergoeding",
    "nl": "reiskostenvergoeding",
    "pl": "zwrot kosztów dojazdu",
    "en": "travel reimbursement",
    "descriptionPl": "Kwota wypłacana z tytułu kosztów dojazdu według ustalonych zasad. To nie jest automatycznie wynagrodzenie za godziny.",
    "descriptionEn": "A payment for eligible travel costs under agreed rules; not automatically hourly wages.",
    "category": "extras"
  },
  {
    "id": "jaaropgave",
    "nl": "jaaropgave",
    "pl": "roczna informacja o wynagrodzeniu",
    "en": "annual income statement",
    "descriptionPl": "Roczne zestawienie danych o wynagrodzeniu i potrąceniach wystawiane przez pracodawcę.",
    "descriptionEn": "An annual summary of wages and payroll withholding issued by the employer.",
    "category": "tax"
  }
];

export function normalizeGlossary(text: string): string {
  return text.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLocaleLowerCase().trim();
}

export function filterGlossary(query: string, category: GlossaryCategory | 'all' = 'all'): GlossaryTerm[] {
  const needle = normalizeGlossary(query);
  return GLOSSARY_TERMS.filter((term) =>
    (category === 'all' || term.category === category) &&
    (!needle || normalizeGlossary([term.nl, term.pl, term.en, term.descriptionPl, term.descriptionEn].join(' ')).includes(needle))
  ).slice().sort((a,b) => a.nl.localeCompare(b.nl, 'nl'));
}
