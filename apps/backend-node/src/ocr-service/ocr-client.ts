import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { groqClient, VISION_MODEL } from '../ai-service/groq.js';
import { documentVisionClient, documentVisionModel, activeDocumentVisionConfig } from '../ai-service/document-vision-provider.js';
import type { TierCExtraction, TierCHourLine, TierCDeductionLine, TierCNetLine, TierCReservationLine, TierCPeriodType } from '../payroll-engine/tier-c.js';
import type { HourLineCategory, TaxTreatment, PreTaxDeductionCategory, PostTaxSocialCategory, NetDeductionCategory, ReservationType } from '../payroll-engine/payslip-model.js';
import { sanitizeText } from './pii-patterns.js';

export interface AiOcrFields {
  hours: number;
  hourlyRate: number;
  grossBase: number;
  additions: number;
  deductions: number;
  netPaid: number;
}

const SYSTEM_PROMPT = `
Jesteś systemem OCR wyspecjalizowanym w holenderskich paskach wypłaty (salarisspecificatie).
Zwróć WYŁĄCZNIE obiekt JSON (bez markdown, bez komentarzy) z dokładnie tymi kluczami liczbowymi:
hours (liczba przepracowanych godzin), hourlyRate (stawka za godzinę w EUR), grossBase (wynagrodzenie brutto),
additions (suma dodatków netto, np. reiskosten), deductions (suma potrąceń netto, np. zorgverzekering),
netPaid (kwota wypłacona na konto, "te betalen").
Używaj kropki jako separatora dziesiętnego. Jeśli nie widzisz danej wartości na dokumencie, wstaw 0.
`.trim();

/** Znajduje ostatni punkt obcięcia (tuż po zamkniętym `}`), przy którym doklejenie
 * brakujących nawiasów zamykających da poprawny JSON — ratuje kompletne elementy
 * tablicy, gdy model urwał odpowiedź w połowie z powodu limitu tokenów. */
function computeClosingSuffix(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of text) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}') { if (stack.pop() !== '{') return null; }
    else if (ch === ']') { if (stack.pop() !== '[') return null; }
  }
  if (inString) return null;
  return stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
}

function repairTruncatedJson(raw: string): unknown {
  for (let cut = raw.length; cut > 0; cut--) {
    if (raw[cut - 1] !== '}') continue;
    const candidate = raw.slice(0, cut);
    const closing = computeClosingSuffix(candidate);
    if (closing === null) continue;
    try {
      return JSON.parse(candidate + closing);
    } catch {
      continue;
    }
  }
  throw new Error('AI zwróciło niepoprawny lub zbyt długi JSON.');
}

function extractJson(raw: string): unknown {
  return extractJsonWithTruncationFlag(raw).value;
}

function extractJsonWithTruncationFlag(raw: string): { value: unknown; truncated: boolean } {
  try {
    return { value: JSON.parse(raw), truncated: false };
  } catch {
    // ignore, try next strategy
  }
  const match = raw.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : raw;
  try {
    return { value: JSON.parse(candidate), truncated: false };
  } catch {
    return { value: repairTruncatedJson(candidate), truncated: true };
  }
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Stage 2f (audit v26, §2f.8): "an unreadable amount is not a zero." Hour, net, ET-reimbursement,
 * payout-adjustment and reservation amounts are plain `number` fields on the shared model (not
 * `Field<number>` like pre/post-tax deductions - see the comment above `mapDeductionLines`), so this
 * does not widen any shared type: it keeps `toNumber`'s 0 as the STORED value (the field still needs
 * a number to exist at all) but records, alongside it, which field genuinely could not be read - a
 * non-finite parse is never "the model said zero", it is "nothing usable was there". The caller
 * (tier-c.controller.ts) raises `amount_unreadable` from this list and blocks before showing any
 * comparison, the same way it already does for an unread period_type.
 */
function toNumberTracked(value: unknown, fieldName: string, unreadable: string[]): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  unreadable.push(fieldName);
  return 0;
}

export async function extractPayslipFieldsFromImage(imageDataUrl: string): Promise<AiOcrFields> {
  const completion = await groqClient().chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    max_tokens: 400,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Odczytaj dane z tego paska wypłaty i zwróć czysty JSON.' },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const parsed = extractJson(raw) as Record<string, unknown>;
  return {
    hours: toNumber(parsed.hours),
    hourlyRate: toNumber(parsed.hourlyRate),
    grossBase: toNumber(parsed.grossBase),
    additions: toNumber(parsed.additions),
    deductions: toNumber(parsed.deductions),
    netPaid: toNumber(parsed.netPaid),
  };
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Tier C's extraction (audit BP1) - a genuinely wider schema than extractFullPayslip() above, since
 * populating PayslipPeriod (payslip-model.ts) needs per-line category/tax_treatment/adds_hours that
 * the old flat lineItems list never captured (see tier-c.ts's own mapping-gap comment block for the
 * full field-by-field account of what is and is not reliably extractable this way).
 *
 * Stage 2c (audit v13): the abbreviated single/two-letter JSON keys and category codes this prompt
 * used through round v12 existed ONLY because Groq's free-tier vision model (qwen/qwen3.8-27b) caps
 * OUTPUT at 1000 tokens/minute (confirmed in this repo's own prior audit report) - not because short
 * keys extract better. That cap goes away with a paid model (document-vision-provider.ts), so the keys
 * below now match TierCExtraction's own field names directly: one fewer translation layer, and one
 * less place for a key to silently drift from what tier-c.ts actually expects. The EXPLANATORY
 * guidance text is otherwise unchanged from v12 - Stage 2c's own instruction is to stop patching
 * prompts for extraction quality, not to touch the parts already earning their keep.
 */
const TIER_C_SYSTEM_PROMPT = `
Jesteś systemem ekstrakcji danych wyspecjalizowanym w holenderskich paskach wypłaty (salarisspecificatie).
Przeanalizuj WSZYSTKIE strony dokumentu, od pierwszej do ostatniej sekcji (dokument zwykle kończy się
sekcją "Netto" tuż przed wierszem "Totaal netto"/"Totalen" - NIE pomijaj jej).

Zwróć WYŁĄCZNIE obiekt JSON (bez markdown) o strukturze:
{"period_label":string|null,"period_end_date":string|null,"payment_date":string|null,
"period_type":"week"|"4-weekly"|"month"|null,"is_correction":boolean,"version":number,
"employer_names":string[],"hirer_name":string|null,"hours_per_week":number|null,
"minimum_wage_printed":number|null,
"bijzonder_tarief_printed_percent":number|null,"bijzonder_tarief_jaarloon":number|null,
"hour_lines":[{"description":string,"hours":number|null,"rate":number|null,"percent":number|null,"amount":number,"category":string,"tax_treatment":string,"adds_hours":boolean,"employer_index":number}],
"pre_tax_deduction_lines":[{"description":string,"amount":number,"category":string,"base":number|null,"percent":number|null}],
"post_tax_deduction_lines":[{"description":string,"amount":number,"category":string,"percent":number|null}],
"et_exchange_amount":number|null,"et_reimbursement_lines":[{"description":string,"amount":number}],
"net_lines":[{"description":string,"amount":number,"category":string}],
"payout_adjustment_lines":[{"description":string,"amount":number}],
"reservation_lines":[{"type":string,"accrued":number,"paid_out":number}],
"printed_table_tax":number|null,"printed_bt_tax":number|null,
"printed_algemene_heffingskorting":number|null,"printed_arbeidskorting":number|null,
"printed_gross_total":number|null,"printed_loon_voor_heffingen":number|null,
"reported_total_net":number|null,"reported_net_paid":number|null,
"printed_table_tax_label":string|null,"printed_bt_tax_label":string|null,
"printed_algemene_heffingskorting_label":string|null,"printed_arbeidskorting_label":string|null,
"printed_net_label":string|null,"printed_payout_label":string|null}

Znaczenie pól: period_label=okres jako opisany na dokumencie DOKŁADNIE tak jak wydrukowany (np. "week
36/2026", nigdy nie zamieniaj na wymyślony zakres dat, jeśli dokument podaje numer tygodnia/miesiąca
wprost). period_end_date=OSTATNI dzień OKRESU ROZLICZENIOWEGO jako data ISO YYYY-MM-DD - to jest jeden
tydzień/4 tygodnie/miesiąc, NIGDY zakres wielu okresów (np. cała ważność umowy czy zakres z nagłówka
niezwiązany z tą konkretną wypłatą). Jeśli dokument podaje numer tygodnia (np. "week 36" albo "W36")
ORAZ rok, oblicz period_end_date z TEGO roku i tygodnia - nie zgaduj roku z innego miejsca dokumentu,
jeśli się różni. payment_date=data WYPŁATY/druku dokumentu jeśli wydrukowana osobno (np.
"betaaldatum", "datum", pole przy numerze wypłaty) - to jest INNA data niż period_end_date; null jeśli
nie widać osobnej daty wypłaty. Rok w period_end_date i rok w payment_date zwykle się zgadzają - jeśli
Twój odczyt daje różne lata, sprawdź OBIE daty jeszcze raz, to częsty sygnał błędnego odczytu roku.
period_type=typ okresu, is_correction=czy to KOREKTA/herziening (true tylko gdy wyraźnie oznaczone),
version=numer wersji dokumentu (1, jeśli nie widać innego), employer_names=nazwa(-y) pracodawcy jak
wydrukowane (może być więcej niż jedna - np. dwa równoległe zatrudnienia), hirer_name=nazwa
zleceniodawcy/opdrachtgever jeśli WYRAŹNIE inna niż pracodawca, hours_per_week=godziny/tydzień z umowy,
minimum_wage_printed=minimumloon WYDRUKOWANE, bijzonder_tarief_printed_percent=procent bijzonder
tarief. Może być wydrukowany jako JEDNA liczba (np. "50,47%") ALBO jako DWIE składowe rozdzielone
znakiem "+" (np. "35,75 + 4,45%") - w tym drugim przypadku ZSUMUJ obie liczby i zwróć JEDNĄ wartość
(35,75+4,45=40,20), nigdy tylko jedną z dwóch połówek. bijzonder_tarief_jaarloon=jaarloon/roczny
dochód użyty do ustalenia stawki bijzonder tarief, jeśli wydrukowany wprost (np. "Jaarloon BT: 38.000,00"
albo "Jaarloon bijz. beloning 46074") - null jeśli nie widać takiej wartości.

hour_lines=linie godzinowe/brutto: description=opis TAK JAK WYDRUKOWANY (nie tłumacz), hours=liczba
godzin, rate=stawka za godzinę, percent=procent dodatku (np. 100 dla "100%"), amount=kwota,
category=jedna z: "regular"=zwykłe godziny, "overtime"=nadgodziny (nowe, dodatkowe godziny),
"irregular_surcharge"=dodatek za nieregularne godziny (na już policzonych godzinach),
"adv_compensation"=dodatek ADV, "other"=inne. tax_treatment=sposób opodatkowania: "table"=tabela
(zwykła stawka podatkowa), "bt"=bijzonder tarief/specjalna stawka, "unknown"=nie wiadomo z dokumentu
(NIGDY nie zgaduj "table" jako domyślne - nadgodziny i dodatki bywają opodatkowane tabelą, nie tylko
BT). adds_hours=true tylko jeśli to GENUINE dodatkowe godziny (prawdziwe nadgodziny), false jeśli to
dodatek/toeslag na już policzonych godzinach. employer_index=numer pracodawcy z listy
"employer_names" (0 dla pierwszego), do którego należy ta linia.

pre_tax_deduction_lines=potrącenia PRZED opodatkowaniem (StiPP/pensioen, PAWW, Ziektewet/AZW/WGA-Gat/
WHK - to co pomniejsza podstawę opodatkowania): category=jedna z "pension"=pensja/StiPP,
"paww"=PAWW, "ziektewet"=Ziektewet/AZW (składka sektorowa), "wga_gat"=WGA-Gat, "other"=inne. WAŻNE:
jeśli opis linii zawiera "StiPP", "pensioen" lub "pensioenpremie" - ZAWSZE category="pension", nigdy
"other", nawet jeśli reszta etykiety jest niejasna lub zawiera literówkę OCR. To samo dla
"PAWW"->"paww" i "Ziektewet"/"AZW"->"ziektewet". "other" jest tylko dla linii, które NIE pasują do
żadnego z tych czterech słów kluczowych. base=baza z której liczono (jeśli wydrukowana), percent=procent.
post_tax_deduction_lines=potrącenia PO opodatkowaniu (WGA, gediff. WGA, WHK własny wkład - jeśli te
linie występują PO podatku na dokumencie, nie przed): category=jedna z "wga", "gediff_wga", "whk",
"other". Ta sama zasada: etykieta zawierająca "WHK"/"WGA" dostaje właściwą kategorię, nie "other".

et_exchange_amount=kwota redukcji podstawy z tytułu regulacji ET/extraterritorialne (jeśli obecna -
szukaj "ET", "extraterritoriale", "nieopodatkowana część wynagrodzenia"), et_reimbursement_lines=
zwroty netto ET (np. verblijfskosten, huisvesting ET) jako lista {description,amount}.

net_lines=pozycje na poziomie netto (dodatki/potrącenia niepodatkowe): category=jedna z
"reimbursement"=zwrot/dodatek (np. reiskosten), "loan"=pożyczka, "housing"=zakwaterowanie,
"transport"=przewóz, "health_insurance"=ubezpieczenie zdrowotne, "union"=związek/
personeelsvereniging, "other"=inne.
payout_adjustment_lines=korekty wypłaty (np. "eerder betaald", "verrekening schuld") jako lista
{description,amount} - amount może być ujemne.
reservation_lines=rezerwacje (vakantiegeld/vakantiedagen NALICZANE w tym okresie, nie wypłacane):
type=jedna z "vakantiegeld", "vakantiedagen", "vakantiedagen_bovenwettelijk", "verlofuren", "other".
accrued=naliczono w tym okresie, paid_out=wypłacono w tym okresie (0 jeśli to czysta rezerwacja).

printed_table_tax=wydrukowana kwota "loonheffing"/podatek wg tabeli, printed_bt_tax=wydrukowana kwota
podatku wg bijzonder tarief (jeśli osobna linia), printed_algemene_heffingskorting=wydrukowana
algemene heffingskorting (jeśli widoczna osobno), printed_arbeidskorting=wydrukowana arbeidskorting
(jeśli widoczna osobno).

printed_gross_total i printed_loon_voor_heffingen to DWIE RÓŻNE liczby w tym samym łańcuchu - określ
każdą WYŁĄCZNIE po jej POZYCJI w łańcuchu (co jest PRZED nią i co PO niej), NIGDY po konkretnym słowie
w etykiecie, ponieważ TA SAMA etykieta bywa użyta dla RÓŻNYCH pozycji na różnych dokumentach (patrz
przykład Olympia niżej - to prawdziwa, potwierdzona pułapka, nie hipotetyczna).

Łańcuch, zawsze w tej kolejności: [linie godzinowe/brutto] -> printed_gross_total -> [potrącenia przed
opodatkowaniem: StiPP/PAWW/etc.] -> printed_loon_voor_heffingen -> [podatek] -> netto.

printed_gross_total = liczba wydrukowana WPROST na dokumencie zaraz PO wszystkich liniach
brutto/godzinowych, PRZED jakąkolwiek linią potrącenia. Zanim potrącenia jeszcze nie odjęto.
printed_loon_voor_heffingen = liczba wydrukowana zaraz PO liniach potrąceń przed opodatkowaniem,
PRZED podatkiem. Potrącenia już odjęte, podatek jeszcze nie.

Przykłady z prawdziwych dokumentów, żeby POZYCJA była jasna, nie etykieta:
- Randstad: "TOTAAL BRUTO LOON" (970,89) = printed_gross_total; "LOON VOOR HEFFINGEN" (927,25) =
  printed_loon_voor_heffingen. Różnica 43,64 to potrącenia przed opodatkowaniem.
- PKF: "BRUTTO" (3515,56) = printed_gross_total; "PODSTAWA" (3277,02) = printed_loon_voor_heffingen.
- Olympia - UWAGA, PUŁAPKA ETYKIETY: "LOON IN GELD" (885,50) = printed_gross_total (etykieta różna od
  pozostałych dwóch dokumentów). Na TYM dokumencie etykieta "TOTAAL BRUTO" (844,92) NIE oznacza gross -
  to jest printed_loon_voor_heffingen (885,50 minus potrącenia przedpodatkowe 40,58 = 844,92). Ta sama
  fraza "TOTAAL BRUTO", która na innym dokumencie mogłaby sugerować brutto, tutaj oznacza coś innego -
  licz się z POZYCJĄ w łańcuchu (co jest przed i po tej liczby), nigdy z samym słowem "brutto" w
  etykiecie.

Oba pola null, jeśli dokument nie drukuje osobnej liczby w tej pozycji (np. przechodzi od razu z
pojedynczej linii brutto do podatku, bez osobnego podsumowania po każdym etapie).

reported_total_net=wydrukowana kwota przy etykiecie "Totaal netto"/"Nettoloon"/"Netto loon" - to jest
suma PRZED doliczeniem zwrotów kosztów (reiskosten), dodatków netto i korekt wypłaty.
reported_net_paid=wydrukowana kwota przy etykiecie "Totaal"/"Netto te betalen"/"Uit te betalen" - to
jest OSTATECZNA kwota wypłaty, PO doliczeniu tych zwrotów/dodatków, zwykle inna liczba niż
reported_total_net i zwykle niżej na dokumencie. Jeśli widzisz na dokumencie DWIE różne liczby w tej
okolicy, "Totaal netto" zawsze idzie do reported_total_net, a ta niżej oznaczona po prostu "Totaal"
(albo z dopiskiem po zwrotach/reiskosten) zawsze idzie do reported_net_paid - NIGDY nie zwracaj tej
samej liczby dla obu, chyba że dokument naprawdę drukuje tylko jedną sumę netto. Jeśli szukasz
"Totaal netto" i nie widzisz jej jako OSOBNEJ, wyraźnie podpisanej liczby (odróżnialnej od "Totaal")
- zwróć null. NIGDY nie zwracaj 0 jako "nie znalazłem" - 0 oznacza dosłownie zero euro netto, co na
realnym pasku wypłaty z niezerowym brutto prawie nigdy nie jest prawdą. null i 0 znaczą co innego:
null pyta użytkownika, 0 twierdzi błędnie że nic nie zostało wypłacone.

printed_table_tax_label/printed_bt_tax_label/printed_algemene_heffingskorting_label/
printed_arbeidskorting_label/printed_net_label/printed_payout_label=DOKŁADNA etykieta wydrukowana na
TYM dokumencie obok odpowiednio printed_table_tax/printed_bt_tax/printed_algemene_heffingskorting/
printed_arbeidskorting/reported_total_net/reported_net_paid (np. "Loonheffing", "Bijzondere
beloningen", "Algemene heffingskorting", "Arbeidskorting", "Netto loon", "Uit te betalen") - skopiuj
TAK JAK WYDRUKOWANA, nigdy nie tłumacz i nie ujednolicaj do kanonicznej nazwy. null, jeśli dana kwota
nie ma własnej, osobnej etykiety na dokumencie (np. jest częścią zbiorczego bloku podsumowania bez
własnego podpisu).

Zasady: kropka jako separator dziesiętny; brak wartości = null (nie 0 i nie zgadywanie);
"description" to opis DOKŁADNIE jak wydrukowany na dokumencie, nigdy tłumaczony ani skracany ponad
potrzebę.

KRYTYCZNE - przepisuj, nigdy nie licz: każda kwota ("amount", "printed_table_tax", "printed_bt_tax",
"printed_gross_total", "printed_loon_voor_heffingen", "reported_total_net", "reported_net_paid" itd.)
to liczba WYDRUKOWANA na dokumencie, przepisana DOKŁADNIE - NIGDY wynik własnego mnożenia/dodawania
(np. godziny × stawka), nawet jeśli wynik wydaje się "powinien" pasować. Jeśli wydrukowana liczba jest
nieczytelna, zwróć null - NIGDY nie zastępuj jej obliczonym przybliżeniem.

KRYTYCZNE - znak liczby: przepisz kwotę TAK JAK WYDRUKOWANA, ze znakiem minus jeśli dokument go drukuje
(albo w nawiasie, co też oznacza liczbę ujemną) - backend, nie ty, decyduje która kwota staje się
wartością bezwzględną. Nie "poprawiaj" znaku samodzielnie w żadnym polu, włącznie z
"pre_tax_deduction_lines"/"post_tax_deduction_lines" (potrącenie zwykle drukowane ze znakiem minus -
przepisz to minus), "et_exchange_amount", "printed_table_tax", "printed_bt_tax",
"printed_gross_total", "printed_loon_voor_heffingen".
`.trim();

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** v17 (audit): live Olympia run on Mistral - "AZW werknemer" was recognised as ziektewet by
 * extraction-consistency.ts's OWN keyword backstop, yet the extraction itself put it in category
 * "other". The prompt DOES ask for "ziektewet"/"AZW"->"ziektewet" explicitly (see the guidance
 * above); a strict `===` match against a lowercase literal is exactly the kind of place a model
 * returning "Ziektewet" or " ziektewet " (correct semantically, wrong casing/whitespace) would
 * silently fall through to "other" with no trace of what was actually said. Normalizing case/
 * whitespace here is a MAPPING-layer robustness fix, not a prompt change - it does not try to make
 * the model smarter, only stops throwing away an answer it already got right. Logs the raw value
 * whenever it still doesn't match anything known, so the next such case shows the actual model
 * output instead of just "other". */
export function normalizeCode(code: unknown): string | null {
  return typeof code === 'string' ? code.trim().toLowerCase() : null;
}

function logUnrecognizedCode(field: string, raw: unknown): void {
  if (raw !== null && raw !== undefined && raw !== '') {
    console.error(`[category-mapping] unrecognized ${field} value from extraction:`, JSON.stringify(raw));
  }
}

export function mapHourCategory(code: unknown): HourLineCategory {
  const normalized = normalizeCode(code);
  if (normalized === 'overtime' || normalized === 'irregular_surcharge' || normalized === 'adv_compensation' || normalized === 'regular') return normalized;
  logUnrecognizedCode('hour_lines[].category', code);
  return 'other';
}

export function mapTaxTreatment(code: unknown): TaxTreatment {
  const normalized = normalizeCode(code);
  if (normalized === 'table' || normalized === 'bt') return normalized;
  logUnrecognizedCode('hour_lines[].tax_treatment', code);
  return 'unknown';
}

export function mapPreTaxCategory(code: unknown): PreTaxDeductionCategory {
  const normalized = normalizeCode(code);
  if (normalized === 'pension' || normalized === 'paww' || normalized === 'ziektewet' || normalized === 'wga_gat') return normalized;
  logUnrecognizedCode('pre_tax_deduction_lines[].category', code);
  return 'other';
}

export function mapPostTaxCategory(code: unknown): PostTaxSocialCategory {
  const normalized = normalizeCode(code);
  if (normalized === 'wga' || normalized === 'gediff_wga' || normalized === 'whk') return normalized;
  logUnrecognizedCode('post_tax_deduction_lines[].category', code);
  return 'other';
}

export function mapNetCategory(code: unknown): NetDeductionCategory | 'reimbursement' {
  const normalized = normalizeCode(code);
  if (normalized === 'reimbursement' || normalized === 'loan' || normalized === 'housing' || normalized === 'transport' || normalized === 'health_insurance' || normalized === 'union') return normalized;
  logUnrecognizedCode('net_lines[].category', code);
  return 'other';
}

export function mapReservationType(code: unknown): ReservationType {
  const normalized = normalizeCode(code);
  if (normalized === 'vakantiegeld' || normalized === 'vakantiedagen' || normalized === 'vakantiedagen_bovenwettelijk' || normalized === 'verlofuren') return normalized;
  logUnrecognizedCode('reservation_lines[].type', code);
  return 'other';
}

export function mapPeriodType(code: unknown): TierCPeriodType | null {
  const normalized = normalizeCode(code);
  if (normalized === 'week' || normalized === '4-weekly' || normalized === 'month') return normalized;
  return null;
}

/**
 * TEMPORARY diagnostic (v16, live Mistral-cutover failure): the openai SDK's APIError only exposes
 * `error.error` (see node_modules/openai/core/error.mjs: `errorResponse?.['error']`), an assumption
 * baked in for OpenAI's own {error:{message,type,code,param}} shape. If a provider's error body
 * doesn't have that top-level "error" key, the SDK silently produces "400 status code (no body)"
 * even though a real body was returned - exactly what production logged. Rather than patch blind,
 * this re-issues the SAME failed request via raw fetch (bypassing the SDK entirely) purely to log
 * the actual response text server-side, plus a models-list auth/existence check - then re-throws the
 * ORIGINAL error unchanged, so user-facing behavior is untouched. Never logs the API key. Remove once
 * the real failure is identified and fixed.
 */
async function logVisionProviderFailure(requestBody: unknown): Promise<void> {
  const config = activeDocumentVisionConfig();
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) { console.error('[vision-diagnostic] no API key configured for', config.name); return; }
  try {
    const modelsRes = await fetch(`${config.baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const modelsText = await modelsRes.text();
    let visionModelIds: string[] = [];
    try {
      const parsed = JSON.parse(modelsText) as { data?: Array<{ id: string; capabilities?: { vision?: boolean } }> };
      visionModelIds = (parsed.data ?? []).filter((m) => m.capabilities?.vision).map((m) => m.id);
    } catch { /* fall through to raw snippet below */ }
    console.error('[vision-diagnostic] models-list status', modelsRes.status, 'vision-capable model IDs (live API, not docs):', JSON.stringify(visionModelIds));
    if (visionModelIds.length === 0) console.error('[vision-diagnostic] raw body (first 500 chars):', modelsText.slice(0, 500));
  } catch (error) {
    console.error('[vision-diagnostic] models-list call itself failed:', error instanceof Error ? error.message : error);
  }
  try {
    const chatRes = await fetch(`${config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const chatText = await chatRes.text();
    console.error('[vision-diagnostic] chat/completions raw status', chatRes.status, 'body (first 1500 chars):', chatText.slice(0, 1500));
  } catch (error) {
    console.error('[vision-diagnostic] raw chat/completions call itself failed:', error instanceof Error ? error.message : error);
  }
}

export async function extractTierCPayslip(imageDataUrls: string[]): Promise<TierCExtraction> {
  const requestBody: ChatCompletionCreateParamsNonStreaming = {
    model: documentVisionModel(),
    temperature: 0,
    max_tokens: 4000,
    messages: [
      { role: 'system', content: TIER_C_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Odczytaj wszystkie ${imageDataUrls.length} stron(y) tego paska wypłaty i zwróć JSON zgodny z opisaną strukturą.` },
          ...imageDataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      },
    ],
  };
  let completion;
  try {
    completion = await documentVisionClient().chat.completions.create(requestBody);
  } catch (error) {
    await logVisionProviderFailure(requestBody);
    throw error;
  }

  const raw = completion.choices[0]?.message?.content ?? '{}';
  // Stage 2c: no more truncation-repair fallback for this path (extractJsonWithTruncationFlag stays
  // in this file only for the orphaned extractPayslipFieldsFromImage() below - see this round's NEW
  // FINDINGS). The 1000-token/minute free-tier cap that made partial responses routine is gone on a
  // paid model; a response that fails to parse now is a genuine extraction failure, surfaced as one
  // (the controller's existing try/catch -> extraction_failed), not silently patched back together.
  const hitLengthLimit = completion.choices[0]?.finish_reason === 'length';
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const redactedFields: string[] = [];
  const unreadableAmountFields: string[] = [];

  const rawHourLines = Array.isArray(parsed.hour_lines) ? parsed.hour_lines : [];
  const hourLines: TierCHourLine[] = rawHourLines.map((item, index) => {
    const r = item as Record<string, unknown>;
    return {
      employer_index: typeof r.employer_index === 'number' ? r.employer_index : 0,
      description: sanitizeText(r.description, `hour_lines[${index}].description`, redactedFields) ?? '',
      hours: toNullableNumber(r.hours),
      rate: toNullableNumber(r.rate),
      percent: toNullableNumber(r.percent),
      amount: toNumberTracked(r.amount, `hour_lines[${index}].amount`, unreadableAmountFields),
      category: mapHourCategory(r.category),
      tax_treatment: mapTaxTreatment(r.tax_treatment),
      adds_hours: toBoolean(r.adds_hours),
    };
  });

  // Stage 2e (§2e.5): a pre/post-tax deduction amount the model genuinely could not read must stay
  // unknown, not become a silent 0 that then understates the taxable base or net - unlike hour_lines/
  // net_lines/reservations below, PreTaxDeduction/PostTaxSocialDeduction (payslip-model.ts) already
  // carry a Field<number>, so null threads cleanly through to unknownField() in tier-c.ts without
  // widening the shared model's plain-number fields (out of scope for this round - see this round's
  // report for the ones deliberately deferred).
  const mapDeductionLines = (raw: unknown, keyPrefix: string, placement: 'pre_tax' | 'post_tax', categoryMapper: (code: unknown) => PreTaxDeductionCategory | PostTaxSocialCategory): TierCDeductionLine[] => {
    const list = Array.isArray(raw) ? raw : [];
    return list.map((item, index) => {
      const r = item as Record<string, unknown>;
      return {
        description: sanitizeText(r.description, `${keyPrefix}[${index}].description`, redactedFields) ?? '',
        amount: toNullableNumber(r.amount),
        category: categoryMapper(r.category),
        placement,
        base: toNullableNumber(r.base),
        percent: toNullableNumber(r.percent),
      };
    });
  };

  const mapNetLines = (raw: unknown, keyPrefix: string): TierCNetLine[] => {
    const list = Array.isArray(raw) ? raw : [];
    return list.map((item, index) => {
      const r = item as Record<string, unknown>;
      return {
        description: sanitizeText(r.description, `${keyPrefix}[${index}].description`, redactedFields) ?? '',
        amount: toNumberTracked(r.amount, `${keyPrefix}[${index}].amount`, unreadableAmountFields),
        category: mapNetCategory(r.category),
      };
    });
  };

  const rawEtr = Array.isArray(parsed.et_reimbursement_lines) ? parsed.et_reimbursement_lines : [];
  const etReimbursementLines: TierCNetLine[] = rawEtr.map((item, index) => {
    const r = item as Record<string, unknown>;
    return {
      description: sanitizeText(r.description, `et_reimbursement_lines[${index}].description`, redactedFields) ?? '',
      amount: toNumberTracked(r.amount, `et_reimbursement_lines[${index}].amount`, unreadableAmountFields),
      category: 'reimbursement' as const,
    };
  });

  const rawPa = Array.isArray(parsed.payout_adjustment_lines) ? parsed.payout_adjustment_lines : [];
  const payoutAdjustmentLines = rawPa.map((item, index) => {
    const r = item as Record<string, unknown>;
    return {
      description: sanitizeText(r.description, `payout_adjustment_lines[${index}].description`, redactedFields) ?? '',
      amount: toNumberTracked(r.amount, `payout_adjustment_lines[${index}].amount`, unreadableAmountFields),
    };
  });

  const rawRl = Array.isArray(parsed.reservation_lines) ? parsed.reservation_lines : [];
  const reservationLines: TierCReservationLine[] = rawRl.map((item, index) => {
    const r = item as Record<string, unknown>;
    return {
      type: mapReservationType(r.type),
      opgebouwd: toNumberTracked(r.accrued, `reservation_lines[${index}].accrued`, unreadableAmountFields),
      paid_out: toNumberTracked(r.paid_out, `reservation_lines[${index}].paid_out`, unreadableAmountFields),
    };
  });

  return {
    period_label: typeof parsed.period_label === 'string' ? parsed.period_label : null,
    period_end_date: typeof parsed.period_end_date === 'string' ? parsed.period_end_date : null,
    payment_date: typeof parsed.payment_date === 'string' ? parsed.payment_date : null,
    period_type: mapPeriodType(parsed.period_type),
    is_correction: toBoolean(parsed.is_correction),
    version: typeof parsed.version === 'number' && parsed.version > 0 ? parsed.version : 1,
    employer_names: toStringArray(parsed.employer_names),
    hirer_name: typeof parsed.hirer_name === 'string' ? parsed.hirer_name : null,
    hours_per_week: toNullableNumber(parsed.hours_per_week),
    minimum_wage_printed: toNullableNumber(parsed.minimum_wage_printed),
    hour_lines: hourLines,
    pre_tax_deduction_lines: mapDeductionLines(parsed.pre_tax_deduction_lines, 'pre_tax_deduction_lines', 'pre_tax', mapPreTaxCategory),
    post_tax_deduction_lines: mapDeductionLines(parsed.post_tax_deduction_lines, 'post_tax_deduction_lines', 'post_tax', mapPostTaxCategory),
    bijzonder_tarief_printed_percent: toNullableNumber(parsed.bijzonder_tarief_printed_percent),
    bijzonder_tarief_jaarloon: toNullableNumber(parsed.bijzonder_tarief_jaarloon),
    et_exchange_amount: toNullableNumber(parsed.et_exchange_amount),
    et_reimbursement_lines: etReimbursementLines,
    net_lines: mapNetLines(parsed.net_lines, 'net_lines'),
    payout_adjustment_lines: payoutAdjustmentLines,
    reservation_lines: reservationLines,
    printed_table_tax: toNullableNumber(parsed.printed_table_tax),
    printed_bt_tax: toNullableNumber(parsed.printed_bt_tax),
    printed_algemene_heffingskorting: toNullableNumber(parsed.printed_algemene_heffingskorting),
    printed_arbeidskorting: toNullableNumber(parsed.printed_arbeidskorting),
    printed_gross_total: toNullableNumber(parsed.printed_gross_total),
    printed_loon_voor_heffingen: toNullableNumber(parsed.printed_loon_voor_heffingen),
    reported_total_net: toNullableNumber(parsed.reported_total_net),
    reported_net_paid: toNullableNumber(parsed.reported_net_paid),
    printed_table_tax_label: sanitizeText(parsed.printed_table_tax_label, 'printed_table_tax_label', redactedFields),
    printed_bt_tax_label: sanitizeText(parsed.printed_bt_tax_label, 'printed_bt_tax_label', redactedFields),
    printed_algemene_heffingskorting_label: sanitizeText(parsed.printed_algemene_heffingskorting_label, 'printed_algemene_heffingskorting_label', redactedFields),
    printed_arbeidskorting_label: sanitizeText(parsed.printed_arbeidskorting_label, 'printed_arbeidskorting_label', redactedFields),
    printed_net_label: sanitizeText(parsed.printed_net_label, 'printed_net_label', redactedFields),
    printed_payout_label: sanitizeText(parsed.printed_payout_label, 'printed_payout_label', redactedFields),
    truncated: hitLengthLimit,
    redacted_fields: redactedFields,
    unreadable_amount_fields: unreadableAmountFields,
  };
}
