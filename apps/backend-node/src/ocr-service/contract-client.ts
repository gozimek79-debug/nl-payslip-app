import { documentVisionClient, documentVisionModel } from '../ai-service/document-vision-provider.js';
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
"pp":number|null,"np":number|null,"tpr":boolean,"ott":number|null,"gh":number|null,"ghpw":number|null}

Znaczenie kluczy: ct=typ umowy (np. "Bepaalde tijd"/"Onbepaalde tijd"/"Uitzendovereenkomst fase A"),
emp=WYŁĄCZNIE nazwa firmy pracodawcy (nigdy nazwisko osoby), fn=nazwa stanowiska/funkcji,
sd=data rozpoczęcia (YYYY-MM-DD), ed=data zakończenia jeśli określona (YYYY-MM-DD lub null),
hr=stawka godzinowa w EUR (null jeśli umowa miesięczna), ms=wynagrodzenie
miesięczne brutto w EUR (null jeśli stawka godzinowa), cao=nazwa układu zbiorowego (CAO),
pf=nazwa funduszu emerytalnego, pp=długość okresu próbnego w tygodniach, np=okres wypowiedzenia
w tygodniach, tpr=czy umowa wspomina o uldze 30% (30%-regeling). ott=próg nadgodzin: liczba godzin
PO KTÓRYCH stawka nadgodzin rośnie na wyższy próg (NIE lista procentów samych w sobie - szukaj
zdania mówiącego "po X godzinach" albo podobnego; jeśli umowa wymienia tylko same procenty
nadgodzin bez podanej liczby godzin granicznej, zwróć null - nie zgaduj tej wartości).

hpw=godziny W TYGODNIU. UWAGA - umowy uitzendkracht CZĘSTO podają liczbę godzin za DŁUŻSZY okres,
np. "64,00 uren per 4 weken" (64 godziny na 4 TYGODNIE, nie 64 godziny na tydzień i nie 64 dni).
W takim przypadku PRZELICZ na tydzień: hpw = 64 / 4 = 16. NIGDY nie zwracaj liczby dni jako godzin
i nigdy nie zwracaj liczby z dłuższego okresu bez podzielenia przez liczbę tygodni tego okresu.
Jeśli nie jesteś pewien jednostki lub okresu, zwróć null zamiast zgadywać.

gh=liczba godzin z takiej klauzuli "gwarantowanych godzin" TAK JAK WYDRUKOWANA, BEZ przeliczania
(np. dla "64,00 uren per 4 weken" gh=64) - to jest zobowiązanie pracodawcy do wypłaty za tę liczbę
godzin nawet jeśli zleceniodawca zaoferuje mniej, osobne pojęcie od hpw. ghpw=liczba tygodni tego
okresu (np. 4 dla "per 4 weken", 1 dla "per week"). Zwróć oba jako null, jeśli umowa nie zawiera
takiej klauzuli o gwarancji godzin.

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
  // v15 (audit "CONSOLIDATED ASSIGNMENT"): "one paid tier, one extraction quality" - contract
  // extraction moves onto the same decided reading model (Mistral, EU-hosted) as payslip extraction,
  // instead of staying on Groq's free tier while the payslip path moved on.
  const completion = await documentVisionClient().chat.completions.create({
    model: documentVisionModel(),
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
    overtimeTierThresholdHours: toNullableNumber(parsed.ott),
    guaranteedHours: toNullableNumber(parsed.gh),
    guaranteedHoursPeriodWeeks: toNullableNumber(parsed.ghpw),
    redactedFields,
  };
}
