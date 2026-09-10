import { groqClient, VISION_MODEL } from '../ai-service/groq.js';
import type { ContractExtraction } from '../payroll-engine/contract.js';
import { sanitizeText } from './pii-patterns.js';

// Klucze skrócone celowo — ten sam powód co przy pełnej analizie paska wypłaty: limit tokenów
// wyjściowych modelu wizyjnego na darmowym planie Groq.
const SYSTEM_PROMPT = `
Jesteś systemem ekstrakcji danych z holenderskich umów o pracę (arbeidsovereenkomst/uitzendovereenkomst),
działającym w trybie ochrony prywatności.

BEZWZGLĘDNY ZAKAZ: NIGDY nie odczytuj ani nie zwracaj imienia, nazwiska, adresu zamieszkania,
numeru BSN, numeru konta bankowego/IBAN, daty urodzenia, numeru telefonu, adresu e-mail ani
podpisu — nawet jeśli są widoczne w dokumencie. Całkowicie je pomiń, jakby nie istniały.
Zwróć WYŁĄCZNIE dane dotyczące warunków zatrudnienia istotne dla wynagrodzenia, wymienione niżej.

Zwróć WYŁĄCZNIE zwarty obiekt JSON (bez spacji, bez markdown, bez komentarzy):
{"ct":string|null,"emp":string|null,"fn":string|null,"sd":string|null,"ed":string|null,
"hpw":number|null,"hr":number|null,"ms":number|null,"cao":string|null,"pf":string|null,
"pp":number|null,"np":number|null,"tpr":boolean}

Znaczenie kluczy: ct=typ umowy (np. "Bepaalde tijd"/"Onbepaalde tijd"/"Uitzendovereenkomst fase A"),
emp=WYŁĄCZNIE nazwa firmy pracodawcy (nigdy nazwisko osoby), fn=nazwa stanowiska/funkcji,
sd=data rozpoczęcia (YYYY-MM-DD), ed=data zakończenia jeśli określona (YYYY-MM-DD lub null),
hpw=godziny w tygodniu, hr=stawka godzinowa w EUR (null jeśli umowa miesięczna), ms=wynagrodzenie
miesięczne brutto w EUR (null jeśli stawka godzinowa), cao=nazwa układu zbiorowego (CAO),
pf=nazwa funduszu emerytalnego, pp=długość okresu próbnego w tygodniach, np=okres wypowiedzenia
w tygodniach, tpr=czy umowa wspomina o uldze 30% (30%-regeling).

Kropka jako separator dziesiętny. Brak danej = null (nie 0, nie pusty string).
`.trim();

function extractJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Siatka bezpieczeństwa: nawet gdyby model złamał instrukcję, te wzorce nie trafią do odpowiedzi.
// Shared with the payslip extraction path (audit R7/J3) — see pii-patterns.ts.

export async function extractContract(imageDataUrls: string[]): Promise<ContractExtraction> {
  const completion = await groqClient().chat.completions.create({
    model: VISION_MODEL,
    temperature: 0,
    max_tokens: 900,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Odczytaj wszystkie ${imageDataUrls.length} stron(y) tej umowy i zwróć zwarty JSON zgodny z opisaną strukturą. Pamiętaj o zakazie danych osobowych.` },
          ...imageDataUrls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  const parsed = extractJson(raw);
  const redactedFields: string[] = [];

  return {
    contractType: sanitizeText(parsed.ct, 'contractType', redactedFields),
    employerName: sanitizeText(parsed.emp, 'employerName', redactedFields),
    functionTitle: sanitizeText(parsed.fn, 'functionTitle', redactedFields),
    startDate: sanitizeText(parsed.sd, 'startDate', redactedFields),
    endDate: sanitizeText(parsed.ed, 'endDate', redactedFields),
    hoursPerWeek: toNullableNumber(parsed.hpw),
    hourlyRate: toNullableNumber(parsed.hr),
    monthlySalary: toNullableNumber(parsed.ms),
    caoName: sanitizeText(parsed.cao, 'caoName', redactedFields),
    pensionFund: sanitizeText(parsed.pf, 'pensionFund', redactedFields),
    probationPeriodWeeks: toNullableNumber(parsed.pp),
    noticePeriodWeeks: toNullableNumber(parsed.np),
    thirtyPercentRuling: parsed.tpr === true,
    redactedFields,
  };
}
