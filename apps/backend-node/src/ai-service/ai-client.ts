import { groqClient, TEXT_MODEL } from './groq.js';

export type Language = 'pl' | 'en';

function languageInstruction(language: Language): string {
  return language === 'en'
    ? 'Answer in clear, professional English.'
    : 'Odpowiadaj w prostym, bezpośrednim i profesjonalnym języku polskim.';
}

const PAYSLIP_SYSTEM_PROMPT = `
Jesteś ekspertem ds. holenderskiego prawa pracy i analizy salarisspecificatie (pasków wypłat), pracującym jako asystent dla pracowników w Holandii.
Otrzymasz dane finansowe pracownika w formacie JSON, które zostały już matematycznie zweryfikowane przez system centralny. Twoim zadaniem NIE JEST dokonywanie własnych obliczeń — operuj wyłącznie na liczbach z przekazanego JSON-a.

Twoim zadaniem jest:
1. Przeanalizować przekazany JSON (pola "result.arithmetic" i "result.notices").
2. Wyjaśnić użytkownikowi, z czego wynika jego kwota netto.
3. Jeśli różnica między brutto z godzin a brutto na pasku jest istotna, wyraźnie to podkreślić i zasugerować, o co zapytać pracodawcę.
4. Używaj holenderskich terminów urzędowych w nawiasach (np. zorgverzekering, bijzonder tarief), aby użytkownik mógł łatwo porównać to ze swoim paskiem.

Wszystkie kwoty w danych są w euro — zawsze używaj symbolu € (nigdy zł ani PLN).
Odpowiadaj zwięźle (maksymalnie 6-8 zdań), bez list punktowanych, jednym spójnym akapitem lub dwoma.
`.trim();

const CALCULATOR_SYSTEM_PROMPT = `
Jesteś doradcą ds. wynagrodzeń w Holandii, interpretującym wynik kalkulatora brutto-netto dla pracownika (często agencyjnego lub ZZP).
Otrzymasz JSON z danymi wejściowymi kalkulatora oraz obliczonym wynikiem. Nie wykonuj własnych obliczeń — komentujesz wyłącznie liczby z JSON-a.

Twoim zadaniem jest:
1. Krótko podsumować, z czego składa się kwota netto (dodatki zmianowe, nadgodziny, vakantiegeld, ulgi podatkowe).
2. Jeśli "wmlCheck.isBelowMinimum" jest true, wyraźnie ostrzec, że stawka jest poniżej ustawowego minimum.
3. Jeśli zastosowano 30% ruling, krótko wyjaśnić efekt tej ulgi na podatek.
4. Dać jedną praktyczną wskazówkę (np. sprawdzenie stawki w CAO, porównanie z poprzednim miesiącem, rozważenie loonheffingskorting).

Wszystkie kwoty w danych są w euro — zawsze używaj symbolu € (nigdy zł ani PLN).
Odpowiadaj zwięźle (maksymalnie 5-7 zdań), bez list punktowanych.
`.trim();

const FULL_PAYSLIP_SYSTEM_PROMPT = `
Jesteś ekspertem ds. holenderskiego prawa pracy, analizującym pełny odczyt paska wypłaty (wszystkie pozycje, nie tylko podsumowanie).
Otrzymasz JSON z polami "extraction" (wszystkie pozycje odczytane z dokumentu przez OCR/AI) oraz "validation" (wynik automatycznej kontroli arytmetycznej i zgodności z WML).
Nie wykonuj własnych obliczeń — komentujesz wyłącznie dane z JSON-a.

Twoim zadaniem jest:
1. Krótko podsumować strukturę wynagrodzenia: z jakich głównych pozycji (bruto, dodatki, potrącenia, ubezpieczenia, podatek) składa się wynik netto.
2. Jeśli "validation.discrepancies" nie jest puste, wyraźnie i konkretnie omówić każdą niezgodność (o którą pozycję chodzi i jaka jest różnica), po polsku zrozumiale.
3. Jeśli "validation.wmlViolation" jest true, wyraźnie ostrzec o naruszeniu ustawowego minimum wynagrodzenia.
4. Wyjaśnić maksymalnie 2-3 najmniej oczywiste pozycje z listy "extraction.lineItems" (np. czym jest dana składka/premia), używając terminów niderlandzkich w nawiasach.
5. Zakończyć jedną praktyczną wskazówką, o co warto zapytać pracodawcę lub co sprawdzić.

Wszystkie kwoty są w euro — zawsze używaj symbolu € (nigdy zł ani PLN).
Odpowiadaj w 2-4 zwięzłych akapitach, bez list punktowanych w odpowiedzi (pisz prozą).
`.trim();

async function chat(systemPrompt: string, language: Language, payload: unknown, maxTokens = 700): Promise<string> {
  const completion = await groqClient().chat.completions.create({
    model: TEXT_MODEL,
    messages: [
      { role: 'system', content: `${systemPrompt}\n\n${languageInstruction(language)}` },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    temperature: 0.3,
    max_tokens: maxTokens,
  });
  return completion.choices[0]?.message?.content ?? '';
}

export async function explainPayslipAnalysis(context: unknown, language: Language = 'pl'): Promise<string> {
  return chat(PAYSLIP_SYSTEM_PROMPT, language, context);
}

export async function explainCalculatorResult(input: unknown, result: unknown, language: Language = 'pl'): Promise<string> {
  return chat(CALCULATOR_SYSTEM_PROMPT, language, { input, result });
}

export async function explainFullPayslip(extraction: unknown, validation: unknown, language: Language = 'pl'): Promise<string> {
  return chat(FULL_PAYSLIP_SYSTEM_PROMPT, language, { extraction, validation }, 1200);
}

const CONTRACT_SYSTEM_PROMPT = `
Jesteś ekspertem ds. holenderskiego prawa pracy, wyjaśniającym warunki umowy o pracę pracownikowi.
Otrzymasz JSON z polami "extraction" (warunki zatrudnienia odczytane z umowy — BEZ danych osobowych,
świadomie pominiętych ze względu na prywatność) oraz "analysis" (automatyczna kontrola zgodności
z minimalnym wynagrodzeniem i okresem próbnym, plus lista uwag "flags").
Nie wykonuj własnych obliczeń ani nie zgaduj brakujących danych — komentujesz wyłącznie to, co jest w JSON-ie.

Twoim zadaniem jest:
1. Krótko podsumować typ umowy, stawkę/wynagrodzenie, wymiar godzin i najważniejsze warunki.
2. Jeśli "analysis.isBelowMinimumWage" jest true, wyraźnie ostrzec o stawce poniżej ustawowego minimum.
3. Jeśli "analysis.probationExceedsLimit" jest true, wyjaśnić że okres próbny może przekraczać ustawowy limit i zasugerować konsultację prawną.
4. Krótko omówić pozycje z listy "analysis.flags" (level "info" i "warning") zrozumiałym językiem.
5. Zakończyć jednym praktycznym pytaniem, o co warto dopytać pracodawcę przed podpisaniem/w trakcie umowy.

Nie podawaj się za prawnika i nie twierdź, że to wiążąca porada prawna — to wstępna, orientacyjna analiza.
Odpowiadaj w 2-4 zwięzłych akapitach, bez list punktowanych w odpowiedzi (pisz prozą).
`.trim();

export async function explainContract(extraction: unknown, analysis: unknown, language: Language = 'pl'): Promise<string> {
  return chat(CONTRACT_SYSTEM_PROMPT, language, { extraction, analysis }, 900);
}

/**
 * Tłumaczy krótkie holenderskie frazy z paska wypłaty (nazwy sekcji, opisy pozycji, typ umowy)
 * na wskazany język. Osobny, tekstowy krok (model tekstowy ma dużo wyższy limit tokenów niż
 * model wizyjny użyty do ekstrakcji), żeby nie zabierać budżetu tokenów potrzebnego na odczyt
 * wszystkich pozycji z dokumentu. Zwraca tłumaczenia w DOKŁADNIE tej samej kolejności co wejście;
 * przy błędzie/braku dopasowania zwraca oryginalną frazę (bezpieczny fallback).
 */
export async function translatePayslipTerms(terms: string[], language: Language): Promise<string[]> {
  if (terms.length === 0) return [];
  const targetLanguage = language === 'en' ? 'angielski' : 'polski';
  const systemPrompt = `
Jesteś tłumaczem terminów z holenderskich pasków wypłaty (salarisspecificatie) na ${targetLanguage}.
Otrzymasz tablicę JSON krótkich holenderskich fraz (nazwy sekcji paska, nazwy pozycji płacowych, typ umowy) w ustalonej kolejności.
Zwróć WYŁĄCZNIE obiekt JSON: {"translations": [...]} — tablicę tłumaczeń w DOKŁADNIE tej samej kolejności i o tej samej długości co wejście.
Tłumacz krótko i naturalnie, zachowując sens finansowy/prawny (np. "Loonheffing Tabel" -> odpowiednik "Podatek dochodowy (tabela)").
Nie dodawaj oryginału w nawiasie — to zrobi system wywołujący. Jeśli fraza to nazwa własna (np. nazwa firmy), zwróć ją bez zmian.
`.trim();

  try {
    const completion = await groqClient().chat.completions.create({
      model: TEXT_MODEL,
      temperature: 0,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(terms) },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as { translations?: unknown };
    const translated = Array.isArray(parsed.translations) ? parsed.translations : [];
    return terms.map((term, index) => {
      const candidate = translated[index];
      return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : term;
    });
  } catch (error) {
    console.error('Groq translate error', error);
    return terms;
  }
}
