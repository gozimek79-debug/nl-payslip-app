import { groqClient, VISION_MODEL } from '../ai-service/groq.js';
import type { FullPayslipExtraction } from '../payroll-engine/full-payslip.js';

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
{"per":string|null,"hr":number|null,"mw":number|null,"hpw":number|null,"ct":string|null,"tpr":boolean,
"li":[{"s":string,"d":string,"q":number|null,"r":number|null,"p":number|null,"x":number|null}],
"rtg":number|null,"rtn":number|null,"rnp":number|null}

Znaczenie kluczy: per=okres, hr=stawka godzinowa, mw=minimumloon, hpw=godziny/tydzień, ct=typ umowy,
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

  return {
    truncated: hitLengthLimit || parseNeededRepair,
    employer: null,
    employeeName: null,
    period: typeof parsed.per === 'string' ? parsed.per : null,
    hourlyRate: toNullableNumber(parsed.hr),
    minimumWage: toNullableNumber(parsed.mw),
    hoursPerWeek: toNullableNumber(parsed.hpw),
    contractType: typeof parsed.ct === 'string' ? parsed.ct : null,
    thirtyPercentRuling: parsed.tpr === true,
    lineItems: rawLineItems.map((item) => {
      const record = item as Record<string, unknown>;
      return {
        section: typeof record.s === 'string' ? record.s : 'Inne',
        description: typeof record.d === 'string' ? record.d : '',
        quantity: toNullableNumber(record.q),
        rate: toNullableNumber(record.r),
        payment: toNullableNumber(record.p),
        deduction: toNullableNumber(record.x),
      };
    }),
    reportedTotalGross: toNullableNumber(parsed.rtg),
    reportedTotalNet: toNullableNumber(parsed.rtn),
    reportedNetPaid: toNullableNumber(parsed.rnp),
  };
}
