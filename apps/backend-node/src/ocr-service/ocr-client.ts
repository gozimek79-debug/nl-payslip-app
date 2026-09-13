import { groqClient, VISION_MODEL } from '../ai-service/groq.js';
import type { FullPayslipExtraction } from '../payroll-engine/full-payslip.js';
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

// Klucze skrócone celowo — model wizyjny Groq ma bardzo niski limit tokenów wyjściowych
// na darmowym planie (1000/min), a pełny pasek wypłaty może mieć kilkanaście pozycji.
const FULL_SYSTEM_PROMPT = `
Jesteś systemem ekstrakcji danych wyspecjalizowanym w holenderskich paskach wypłaty (salarisspecificatie),
które mogą pochodzić od różnych dostawców oprogramowania płacowego i mieć różne układy oraz nazwy pozycji.

Przeanalizuj WSZYSTKIE strony dokumentu i wypisz KAŻDĄ pojedynczą pozycję z tabeli płacowej, od pierwszej do ostatniej
sekcji na dokumencie — dokument zwykle kończy się sekcją "Netto" (dodatki/potrącenia netto, np. reiskostenvergoeding,
inhouding, personeelsvereniging) TUŻ PRZED wierszem "Totaal netto"/"Totalen". NIE KOŃCZ odpowiedzi, dopóki nie
przetworzysz również tej ostatniej sekcji — pominięcie jej jest błędem krytycznym.
Pomijaj wyłącznie wiersze będące czystymi podsumowaniami/subtotalami sekcji (bez własnego opisu pozycji, np. sam
wiersz z liczbami bez nazwy).

Zwróć WYŁĄCZNIE zwarty obiekt JSON (bez spacji, bez markdown, bez komentarzy, KRÓTKIE klucze) o strukturze:
{"per":string|null,"ped":string|null,"hr":number|null,"mw":number|null,"hpw":number|null,"ct":string|null,"tpr":boolean,
"li":[{"s":string,"d":string,"q":number|null,"r":number|null,"p":number|null,"x":number|null}],
"rtg":number|null,"rtn":number|null,"rnp":number|null}

Znaczenie kluczy: per=okres jako opisany na dokumencie (np. "week 36" albo "2026-8"), ped=OSTATNI dzień
okresu rozliczeniowego jako data ISO YYYY-MM-DD (np. dla "week 36 2026" to 2026-09-06; dla miesiąca
sierpień 2026 to 2026-08-31) — wywnioskuj z numeru tygodnia/miesiąca i roku widocznych na dokumencie,
hr=stawka godzinowa, mw=minimumloon WYDRUKOWANE na dokumencie (do celów informacyjnych — może być
nieaktualne, nie licz z tego żadnej zgodności), hpw=godziny/tydzień, ct=typ umowy,
tpr=aktywna ulga 30% (true tylko jeśli wyraźnie widoczna), li=lista pozycji, s=sekcja, d=opis pozycji,
q=ilość/liczba godzin, r=stawka za jednostkę, p=kwota Betaling (zawsze dodatnia), x=kwota Inhouding (zawsze dodatnia),
rtg=wydrukowana suma brutto, rtn=wydrukowana suma netto, rnp=faktycznie wypłacona kwota (Betalen/Per Bank).

Zasady: kropka jako separator dziesiętny; brak wartości = null (nie 0); opisy pozycji ("d") maks. kilka słów,
bez zbędnych dopisków.
`.trim();

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function extractFullPayslip(imageDataUrls: string[]): Promise<FullPayslipExtraction> {
  const completion = await groqClient().chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    max_tokens: 1000,
    messages: [
      { role: 'system', content: FULL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Odczytaj wszystkie ${imageDataUrls.length} stron(y) tego paska wypłaty i zwróć zwarty JSON zgodny z opisaną strukturą.` },
          ...imageDataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const hitLengthLimit = completion.choices[0]?.finish_reason === 'length';
  const { value, truncated: parseNeededRepair } = extractJsonWithTruncationFlag(raw);
  const parsed = value as Record<string, unknown>;
  const rawLineItems = Array.isArray(parsed.li) ? parsed.li : [];
  // Audit R7/J3: the extraction schema deliberately has no employee-name/address fields, but a
  // free-text line description has no such schema-level protection - the same regex safety net
  // used on the contract path catches it here too, independent of prompt compliance.
  const redactedFields: string[] = [];

  return {
    truncated: hitLengthLimit || parseNeededRepair,
    period: typeof parsed.per === 'string' ? parsed.per : null,
    periodEndDate: typeof parsed.ped === 'string' ? parsed.ped : null,
    hourlyRate: toNullableNumber(parsed.hr),
    minimumWage: toNullableNumber(parsed.mw),
    hoursPerWeek: toNullableNumber(parsed.hpw),
    contractType: typeof parsed.ct === 'string' ? parsed.ct : null,
    thirtyPercentRuling: parsed.tpr === true,
    lineItems: rawLineItems.map((item, index) => {
      const record = item as Record<string, unknown>;
      return {
        section: sanitizeText(record.s, `lineItems[${index}].section`, redactedFields) ?? 'Inne',
        description: sanitizeText(record.d, `lineItems[${index}].description`, redactedFields) ?? '',
        quantity: toNullableNumber(record.q),
        rate: toNullableNumber(record.r),
        payment: toNullableNumber(record.p),
        deduction: toNullableNumber(record.x),
      };
    }),
    redactedFields,
    reportedTotalGross: toNullableNumber(parsed.rtg),
    reportedTotalNet: toNullableNumber(parsed.rtn),
    reportedNetPaid: toNullableNumber(parsed.rnp),
  };
}

/**
 * Tier C's extraction (audit BP1) - a genuinely wider schema than extractFullPayslip() above, since
 * populating PayslipPeriod (payslip-model.ts) needs per-line category/tax_treatment/adds_hours that
 * the old flat lineItems list never captured (see tier-c.ts's own mapping-gap comment block for the
 * full field-by-field account of what is and is not reliably extractable this way). NOT
 * independently verified against a live model call in this round - the mapping/computation/
 * discrepancy pipeline downstream of this is fully tested against hand-built fixtures shaped as this
 * function's own output (tier-c.test.ts), since an AI vision call cannot be run deterministically in
 * a test environment; this specific function's real-world reliability is the acknowledged open risk.
 *
 * Short keys and terse category codes throughout, same reason as extractFullPayslip's own comment:
 * the vision model's OUTPUT token budget is the binding constraint, not the (much cheaper) input
 * system-prompt length - so the codes are explained verbosely here and requested tersely in the JSON.
 */
const TIER_C_SYSTEM_PROMPT = `
Jesteś systemem ekstrakcji danych wyspecjalizowanym w holenderskich paskach wypłaty (salarisspecificatie).
Przeanalizuj WSZYSTKIE strony dokumentu, od pierwszej do ostatniej sekcji (dokument zwykle kończy się
sekcją "Netto" tuż przed wierszem "Totaal netto"/"Totalen" - NIE pomijaj jej).

Zwróć WYŁĄCZNIE zwarty obiekt JSON (bez spacji, bez markdown) o strukturze:
{"per":string|null,"ped":string|null,"pt":"w"|"4w"|"m"|null,"ic":boolean,"ver":number,
"emp":string[],"hir":string|null,"hpw":number|null,"mw":number|null,"btp":number|null,"btj":number|null,
"hl":[{"d":string,"h":number|null,"r":number|null,"pc":number|null,"a":number,"c":string,"tt":string,"ah":boolean,"ei":number}],
"pdl":[{"d":string,"a":number,"c":string,"b":number|null,"pc":number|null}],
"sdl":[{"d":string,"a":number,"c":string,"pc":number|null}],
"etx":number|null,"etr":[{"d":string,"a":number}],
"nl":[{"d":string,"a":number,"c":string}],
"pa":[{"d":string,"a":number}],
"rl":[{"t":string,"o":number,"p":number}],
"ptt":number|null,"pbt":number|null,"pahk":number|null,"pak":number|null,
"rtn":number|null,"rnp":number|null}

Znaczenie pól: per=okres jako opisany na dokumencie, ped=OSTATNI dzień okresu jako data ISO YYYY-MM-DD,
pt=typ okresu ("w"=tydzień, "4w"=4 tygodnie, "m"=miesiąc), ic=czy to KOREKTA/herziening (true tylko
gdy wyraźnie oznaczone), ver=numer wersji dokumentu (1, jeśli nie widać innego), emp=nazwa(-y)
pracodawcy jak wydrukowane (może być więcej niż jedna - np. dwa równoległe zatrudnienia), hir=nazwa
zleceniodawcy/opdrachtgever jeśli WYRAŹNIE inna niż pracodawca, hpw=godziny/tydzień z umowy, mw=minimumloon
WYDRUKOWANE, btp=procent bijzonder tarief. Może być wydrukowany jako JEDNA liczba (np. "50,47%") ALBO
jako DWIE składowe rozdzielone znakiem "+" (np. "35,75 + 4,45%") - w tym drugim przypadku ZSUMUJ obie
liczby i zwróć JEDNĄ wartość (35,75+4,45=40,20), nigdy tylko jedną z dwóch połówek. btj=jaarloon/roczny
dochód użyty do ustalenia stawki bijzonder tarief, jeśli wydrukowany wprost (np. "Jaarloon BT: 38.000,00"
albo "Jaarloon bijz. beloning 46074") - null jeśli nie widać takiej wartości.

hl=linie godzinowe/brutto: d=opis TAK JAK WYDRUKOWANY (nie tłumacz), h=liczba godzin, r=stawka za
godzinę, pc=procent dodatku (np. 100 dla "100%"), a=kwota, c=kategoria jednym znakiem: "r"=zwykłe
godziny, "o"=nadgodziny (nowe, dodatkowe godziny), "i"=dodatek za nieregularne godziny (na już
policzonych godzinach), "a"=dodatek ADV, "x"=inne. tt=sposób opodatkowania: "t"=tabela (zwykła stawka
podatkowa), "b"=bijzonder tarief/specjalna stawka, "u"=nie wiadomo z dokumentu (NIGDY nie zgaduj "t"
jako domyślne - nadgodziny i dodatki bywają opodatkowane tabelą, nie tylko BT). ah=true tylko jeśli to
GENUINE dodatkowe godziny (prawdziwe nadgodziny), false jeśli to dodatek/toeslag na już policzonych
godzinach. ei=numer pracodawcy z listy "emp" (0 dla pierwszego), do którego należy ta linia.

pdl=potrącenia PRZED opodatkowaniem (StiPP/pensioen, PAWW, Ziektewet/AZW/WGA-Gat/WHK - to co
pomniejsza podstawę opodatkowania): c="p"=pensja/StiPP, "w"=PAWW, "z"=Ziektewet/AZW (składka
sektorowa), "g"=WGA-Gat, "o"=inne. b=baza z której liczono (jeśli wydrukowana), pc=procent.
sdl=potrącenia PO opodatkowaniu (WGA, gediff. WGA, WHK własny wkład - jeśli te linie występują PO
podatku na dokumencie, nie przed): c="wg"=WGA, "gw"=gediff. WGA, "wh"=WHK, "o"=inne.

etx=kwota redukcji podstawy z tytułu regulacji ET/extraterritorialne (jeśli obecna - szukaj "ET",
"extraterritoriale", "nieopodatkowana część wynagrodzenia"), etr=zwroty netto ET (np. verblijfskosten,
huisvesting ET) jako lista {d,a}.

nl=pozycje na poziomie netto (dodatki/potrącenia niepodatkowe): c="rm"=zwrot/dodatek (np.
reiskosten), "l"=pożyczka, "h"=zakwaterowanie, "t"=przewóz, "hi"=ubezpieczenie zdrowotne,
"u"=związek/personeelsvereniging, "o"=inne.
pa=korekty wypłaty (np. "eerder betaald", "verrekening schuld") jako lista {d,a} - a może być ujemne.
rl=rezerwacje (vakantiegeld/vakantiedagen NALICZANE w tym okresie, nie wypłacane): t="vg"=vakantiegeld,
"vd"=vakantiedagen, "vb"=vakantiedagen bovenwettelijk, "vl"=verlofuren, "o"=inne. o=naliczono w tym
okresie, p=wypłacono w tym okresie (0 jeśli to czysta rezerwacja).

ptt=wydrukowana kwota "loonheffing"/podatek wg tabeli, pbt=wydrukowana kwota podatku wg bijzonder
tarief (jeśli osobna linia), pahk=wydrukowana algemene heffingskorting (jeśli widoczna osobno),
pak=wydrukowana arbeidskorting (jeśli widoczna osobno), rtn=wydrukowana suma netto, rnp=faktycznie
wypłacona kwota.

Zasady: kropka jako separator dziesiętny; brak wartości = null (nie 0 i nie zgadywanie); "d" to opis
DOKŁADNIE jak wydrukowany na dokumencie, nigdy tłumaczony ani skracany ponad потrzebę.
`.trim();

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function mapHourCategory(code: unknown): HourLineCategory {
  if (code === 'o') return 'overtime';
  if (code === 'i') return 'irregular_surcharge';
  if (code === 'a') return 'adv_compensation';
  if (code === 'r') return 'regular';
  return 'other';
}

function mapTaxTreatment(code: unknown): TaxTreatment {
  if (code === 't') return 'table';
  if (code === 'b') return 'bt';
  return 'unknown';
}

function mapPreTaxCategory(code: unknown): PreTaxDeductionCategory {
  if (code === 'p') return 'pension';
  if (code === 'w') return 'paww';
  if (code === 'z') return 'ziektewet';
  if (code === 'g') return 'wga_gat';
  return 'other';
}

function mapPostTaxCategory(code: unknown): PostTaxSocialCategory {
  if (code === 'wg') return 'wga';
  if (code === 'gw') return 'gediff_wga';
  if (code === 'wh') return 'whk';
  return 'other';
}

function mapNetCategory(code: unknown): NetDeductionCategory | 'reimbursement' {
  if (code === 'rm') return 'reimbursement';
  if (code === 'l') return 'loan';
  if (code === 'h') return 'housing';
  if (code === 't') return 'transport';
  if (code === 'hi') return 'health_insurance';
  if (code === 'u') return 'union';
  return 'other';
}

function mapReservationType(code: unknown): ReservationType {
  if (code === 'vg') return 'vakantiegeld';
  if (code === 'vd') return 'vakantiedagen';
  if (code === 'vb') return 'vakantiedagen_bovenwettelijk';
  if (code === 'vl') return 'verlofuren';
  return 'other';
}

function mapPeriodType(code: unknown): TierCPeriodType | null {
  if (code === 'w') return 'week';
  if (code === '4w') return '4-weekly';
  if (code === 'm') return 'month';
  return null;
}

export async function extractTierCPayslip(imageDataUrls: string[]): Promise<TierCExtraction> {
  const completion = await groqClient().chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    max_tokens: 2000,
    messages: [
      { role: 'system', content: TIER_C_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Odczytaj wszystkie ${imageDataUrls.length} stron(y) tego paska wypłaty i zwróć zwarty JSON zgodny z opisaną strukturą.` },
          ...imageDataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const hitLengthLimit = completion.choices[0]?.finish_reason === 'length';
  const { value, truncated: parseNeededRepair } = extractJsonWithTruncationFlag(raw);
  const parsed = value as Record<string, unknown>;
  const redactedFields: string[] = [];

  const rawHourLines = Array.isArray(parsed.hl) ? parsed.hl : [];
  const hourLines: TierCHourLine[] = rawHourLines.map((item, index) => {
    const r = item as Record<string, unknown>;
    return {
      employer_index: typeof r.ei === 'number' ? r.ei : 0,
      description: sanitizeText(r.d, `hl[${index}].d`, redactedFields) ?? '',
      hours: toNullableNumber(r.h),
      rate: toNullableNumber(r.r),
      percent: toNullableNumber(r.pc),
      amount: toNumber(r.a),
      category: mapHourCategory(r.c),
      tax_treatment: mapTaxTreatment(r.tt),
      adds_hours: toBoolean(r.ah),
    };
  });

  const mapDeductionLines = (raw: unknown, keyPrefix: string, categoryMapper: (code: unknown) => PreTaxDeductionCategory | PostTaxSocialCategory): TierCDeductionLine[] => {
    const list = Array.isArray(raw) ? raw : [];
    return list.map((item, index) => {
      const r = item as Record<string, unknown>;
      return {
        description: sanitizeText(r.d, `${keyPrefix}[${index}].d`, redactedFields) ?? '',
        amount: toNumber(r.a),
        category: categoryMapper(r.c),
        placement: keyPrefix === 'pdl' ? ('pre_tax' as const) : ('post_tax' as const),
        base: toNullableNumber(r.b),
        percent: toNullableNumber(r.pc),
      };
    });
  };

  const mapNetLines = (raw: unknown, keyPrefix: string): TierCNetLine[] => {
    const list = Array.isArray(raw) ? raw : [];
    return list.map((item, index) => {
      const r = item as Record<string, unknown>;
      return {
        description: sanitizeText(r.d, `${keyPrefix}[${index}].d`, redactedFields) ?? '',
        amount: toNumber(r.a),
        category: mapNetCategory(r.c),
      };
    });
  };

  const rawEtr = Array.isArray(parsed.etr) ? parsed.etr : [];
  const etReimbursementLines: TierCNetLine[] = rawEtr.map((item, index) => {
    const r = item as Record<string, unknown>;
    return {
      description: sanitizeText(r.d, `etr[${index}].d`, redactedFields) ?? '',
      amount: toNumber(r.a),
      category: 'reimbursement' as const,
    };
  });

  const rawPa = Array.isArray(parsed.pa) ? parsed.pa : [];
  const payoutAdjustmentLines = rawPa.map((item, index) => {
    const r = item as Record<string, unknown>;
    return { description: sanitizeText(r.d, `pa[${index}].d`, redactedFields) ?? '', amount: toNumber(r.a) };
  });

  const rawRl = Array.isArray(parsed.rl) ? parsed.rl : [];
  const reservationLines: TierCReservationLine[] = rawRl.map((item) => {
    const r = item as Record<string, unknown>;
    return { type: mapReservationType(r.t), opgebouwd: toNumber(r.o), paid_out: toNumber(r.p) };
  });

  return {
    period_label: typeof parsed.per === 'string' ? parsed.per : null,
    period_end_date: typeof parsed.ped === 'string' ? parsed.ped : null,
    period_type: mapPeriodType(parsed.pt),
    is_correction: toBoolean(parsed.ic),
    version: typeof parsed.ver === 'number' && parsed.ver > 0 ? parsed.ver : 1,
    employer_names: toStringArray(parsed.emp),
    hirer_name: typeof parsed.hir === 'string' ? parsed.hir : null,
    hours_per_week: toNullableNumber(parsed.hpw),
    minimum_wage_printed: toNullableNumber(parsed.mw),
    hour_lines: hourLines,
    pre_tax_deduction_lines: mapDeductionLines(parsed.pdl, 'pdl', mapPreTaxCategory),
    post_tax_deduction_lines: mapDeductionLines(parsed.sdl, 'sdl', mapPostTaxCategory),
    bijzonder_tarief_printed_percent: toNullableNumber(parsed.btp),
    bijzonder_tarief_jaarloon: toNullableNumber(parsed.btj),
    et_exchange_amount: toNullableNumber(parsed.etx),
    et_reimbursement_lines: etReimbursementLines,
    net_lines: mapNetLines(parsed.nl, 'nl'),
    payout_adjustment_lines: payoutAdjustmentLines,
    reservation_lines: reservationLines,
    printed_table_tax: toNullableNumber(parsed.ptt),
    printed_bt_tax: toNullableNumber(parsed.pbt),
    printed_algemene_heffingskorting: toNullableNumber(parsed.pahk),
    printed_arbeidskorting: toNullableNumber(parsed.pak),
    reported_total_net: toNullableNumber(parsed.rtn),
    reported_net_paid: toNullableNumber(parsed.rnp),
    truncated: hitLengthLimit || parseNeededRepair,
    redacted_fields: redactedFields,
  };
}
