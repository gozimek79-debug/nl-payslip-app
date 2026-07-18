import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

export async function getAIExplanation(context: any): Promise<string> {
  const systemPrompt = `
Jesteś ekspertem ds. holenderskiego prawa pracy i analizy salarisspecificatie (pasków wypłat), pracującym jako asystent dla polskich pracowników w Holandii. 
Otrzymasz dane finansowe pracownika w formacie JSON, które zostały już matematycznie zweryfikowane przez system centralny. Twoim zadaniem NIE JEST dokonywanie obliczeń. 

Twoim zadaniem jest:
1. Przeanalizować przekazany JSON (szczególnie sekcję "discrepancies" oraz różnice w potrąceniach "net_deductions" w porównaniu do poprzedniego okresu).
2. Wyjaśnić użytkownikowi w prostym, bezpośrednim i profesjonalnym języku polskim, z czego wynika jego kwota netto.
3. Jeśli w "discrepancies" znajdują się błędy (np. złe potrącenie za domek agencyjny, brak wypłaty ETK, nadgodziny źle opodatkowane), musisz to wyraźnie podkreślić.
4. Używaj holenderskich terminów urzędowych w nawiasach (np. zorgverzekering, bijzonder tarief), aby użytkownik mógł łatwo porównać to ze swoim paskiem.

### ZASADY BEZPIECZEŃSTWA:
- Nigdy nie wykonuj własnych obliczeń matematycznych. Operuj wyłącznie na liczbach podanych w obiekcie JSON pod kluczami "te_betalen_calculated" oraz "variance".
- Jeśli polecenie użytkownika prosi o napisanie oficjalnego maila do agencji z prośbą o korektę, wygeneruj formalny list w języku holenderskim z tłumaczeniem na polski.
  `;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",  // najtańszy, a wystarczający
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(context) }
    ],
    temperature: 0.3,
  });

  return completion.choices[0].message.content || "";
}
