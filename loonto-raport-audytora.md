# Loonto — jak działa aplikacja i jak jest zbudowana

**Raport techniczny i architektoniczny — do przeglądu przez audytora zewnętrznego**

- Środowisko produkcyjne: https://nl-payslip-app.vercel.app
- Repozytorium: gozimek79-debug/nl-payslip-app
- Rok podatkowy w bazie: 2026, tabela H2 (od 2026-07-01)
- Data raportu: 8 września 2026
- Stos: React 19 · Express 5 · Postgres (Neon) · hosting Vercel (serverless) · AI: Groq (OpenAI-compatible) · Języki UI: PL/EN

---

## 00. Streszczenie wykonawcze

**Loonto** to aplikacja webowa pomagająca pracownikom w Holandii zweryfikować własny pasek wypłaty (salarisspecificatie), obliczyć wynagrodzenie netto z brutto oraz sprawdzić warunki umowy o pracę pod kątem zgodności z ustawowym minimum. Aplikacja łączy trzy niezależne moduły funkcjonalne osadzone we wspólnym froncie i backendzie:

- **Analiza pasków wypłaty** — odczyt dokumentu przez model wizyjny AI, ręczna weryfikacja przez użytkownika, kontrola arytmetyczna i wyjaśnienie w języku naturalnym.
- **Kalkulator brutto–netto** — silnik liczący podatek dochodowy, ulgi podatkowe, składki i dodatki zmianowe według oficjalnych stawek na 2026 r., z opcjonalnym uwzględnieniem funduszu emerytalnego StiPP.
- **Analiza umowy o pracę** — odczyt warunków zatrudnienia z umowy przez AI z **wbudowanym, trójwarstwowym zakazem ekstrakcji danych osobowych** oraz automatyczna kontrola zgodności z Kodeksem Cywilnym (BW) w zakresie okresu próbnego i wypowiedzenia.

Dane referencyjne (stawki podatkowe, składki StiPP, terminy ustawowe) są przechowywane w wersjonowanej bazie danych niezależnej od kodu aplikacji, co pozwala aktualizować je bez wdrożenia nowej wersji. Uwierzytelnianie odbywa się bez haseł — metodą magic-link wysyłanego e-mailem. Aplikacja działa produkcyjnie pod adresem `nl-payslip-app.vercel.app`, z bazą Postgres (Neon), wysyłką e-maili (Resend) i wnioskowaniem AI (Groq) skonfigurowanymi jako usługi zewnętrzne.

Rozdział 10 zawiera pełną listę otwartych punktów i zaleceń wykrytych w trakcie przygotowania tego raportu — żaden z nich nie dotyczy bezpieczeństwa danych osobowych w module analizy umów, który został odrębnie zweryfikowany testem adwersarialnym (zob. rozdział 04).

---

## 01. Architektura i stos technologiczny

Monorepo npm workspaces z rozdzielonym frontendem, backendem i pakietami współdzielonymi.

**Struktura repozytorium:**

| Katalog | Opis |
|---|---|
| `apps/frontend-react` | React 19 + Vite 6, TypeScript. Brak routera — nawigacja przez stan trybu (`analyze / calculator / contract / account`). OCR lokalny (pdf.js + tesseract.js) jako ścieżka pomocnicza. |
| `apps/backend-node` | Express 5 + TypeScript (moduły NodeNext), walidacja wejścia Zod, jedna funkcja serverless (`api/index.ts`) eksportująca całą aplikację Express. |
| `packages/database` | `schema.sql` + migracje przyrostowe (sesje, magic links). |
| `packages/tax-tables` | Statyczny plik JSON ze stawkami podatkowymi — działa jako *fallback*, gdy baza reguł jest niedostępna. |
| `packages/shared-types` | Typy współdzielone między frontendem a backendem. |

**Wersje kluczowych zależności:**

| Warstwa | Biblioteka | Wersja | Rola |
|---|---|---|---|
| Frontend | react / react-dom | 19.0 | UI |
| Frontend | vite | 6.0 | Bundler / dev server |
| Frontend | pdfjs-dist | 6.2 | Render PDF → obraz (w przeglądarce) |
| Frontend | tesseract.js | 7.0 | Lokalny OCR (ścieżka pomocnicza, bez AI) |
| Backend | express | 5.0 | Serwer HTTP / routing API |
| Backend | zod | 4.5 | Walidacja i sanityzacja wejścia |
| Backend | helmet | 8.0 | Nagłówki bezpieczeństwa HTTP |
| Backend | pg | 8.13 | Klient Postgres (pula połączeń) |
| Backend | openai | 5.0 | Klient SDK — używany do połączenia z API Groq |
| Runtime | node | ≥ 20 | Wymagana wersja środowiska |

Brak frameworka routingu po stronie frontu jest decyzją świadomą — aplikacja ma cztery tryby ekranu, nie strony wymagające adresowalnych URL-i.

---

## 02. Przepływy danych

### A. Analiza pasków wypłaty (pełna, przez AI)

1. **Upload dokumentu** — użytkownik wgrywa PDF/JPG/PNG (limit 10 MB). Plik jest przetwarzany w pamięci (`multer.memoryStorage()`) — **nie trafia na dysk ani do trwałego magazynu** po stronie serwera. `POST /api/payslips/upload`
2. **Render do obrazu w przeglądarce** — pdf.js renderuje strony PDF na obrazy, które trafiają do modelu wizyjnego jako `data:image/…;base64`.
3. **Ekstrakcja przez AI** — model wizyjny Groq zwraca zwarty JSON z pozycjami paska wypłaty (sekcje, kwoty, stawki). Odpowiedź jest naprawiana automatycznie, jeśli model urwie ją w połowie z powodu limitu tokenów. `POST /api/payslips/analyze-full`
4. **Weryfikacja przez użytkownika** — wyodrębnione pola są prezentowane do ręcznej korekty — użytkownik jest ostatnią instancją potwierdzającą poprawność liczb przed zapisem.
5. **Kontrola arytmetyczna i zapis** — serwer porównuje kwotę brutto z iloczynem godzin i stawki, zapisuje wynik i zdarzenie w bazie, generuje wyjaśnienie AI w wybranym języku. `POST /api/payslips/analyze`

### B. Kalkulator brutto–netto

1. **Formularz wejściowy** — godziny wg typu (normalne / sobota / niedziela / święto / noc), nadgodziny w dwóch progach, dodatki procentowe, opcje zaawansowane (składki, 30% ruling, bijzonder tarief).
2. **Pobranie aktualnych stawek** — serwer odpytuje bazę reguł referencyjnych o aktualnie obowiązującą wersję tabeli podatkowej (`getCurrentRule('loonheffing_nl')`); przy braku bazy używa statycznego pliku JSON w repozytorium.
3. **Obliczenie** — silnik liczy brutto → składki pracownicze → podstawę opodatkowania → podatek progresywny + bijzonder tarief → ulgi podatkowe → netto. Szczegóły metodologii w rozdziale 06. `POST /api/calculator/calculate`
4. **Wynik i eksport** — pełny rozkład kwot jest zwracany do interfejsu wraz ze źródłem zastosowanych stawek (`database`/`static`) oraz opcjonalnym wyjaśnieniem AI; wynik można pobrać jako CSV.

### C. Analiza umowy o pracę

1. **Upload skanu umowy** — 1–5 stron jako obraz. Ten sam wzorzec przetwarzania w pamięci co dla pasków wypłaty.
2. **Ekstrakcja z zakazem PII** — model wizyjny działa pod systemowym promptem zabraniającym odczytu danych osobowych, zwraca wyłącznie pola dotyczące warunków zatrudnienia. Zob. rozdział 04. `POST /api/contracts/analyze`
3. **Kontrola prawna** — wynik jest sprawdzany względem: ustawowej płacy minimalnej, maksymalnego okresu próbnego (art. 7:652 BW) i minimalnego okresu wypowiedzenia pracodawcy wg stażu (art. 7:672 BW) — obie reguły pobierane z bazy referencyjnej.
4. **Wynik i wyjaśnienie** — flagi ostrzegawcze/informacyjne oraz opisowe wyjaśnienie AI w wybranym języku.

### D. Logowanie (magic link)

1. **Żądanie linku** — użytkownik podaje e-mail. Serwer sprawdza 60-sekundowy cooldown na ten adres, generuje token (32 losowe bajty), zapisuje w bazie **tylko jego skrót SHA-256**. `POST /api/auth/session`
2. **Wysyłka e-maila** — link ważny 15 minut, jednorazowy, wysyłany przez Resend.
3. **Weryfikacja i sesja** — kliknięcie linku oznacza go jako użyty, tworzy/aktualizuje konto użytkownika i zakłada sesję (ciasteczko httpOnly, 30 dni). `GET /api/auth/verify`

---

## 03. Logowanie i zarządzanie sesją

Uwierzytelnianie bezhasłowe — nie ma żadnego pola hasła w systemie.

| Mechanizm | Implementacja |
|---|---|
| Token magic-linku | `crypto.randomBytes(32)`, przechowywany w bazie wyłącznie jako `SHA-256`; ważność 15 minut; jednorazowy (`used_at`). |
| Ochrona przed spamem | 60-sekundowy cooldown wysyłki na ten sam adres e-mail (sprawdzany przed wygenerowaniem nowego tokenu). |
| Ciasteczko sesji | `loonto_session` — `httpOnly`, `SameSite=Lax`, `Secure` w produkcji, 30 dni ważności; wartość w bazie przechowywana jako skrót, nie jawny token. |
| Wylogowanie | `DELETE /api/auth/session` usuwa rekord sesji w bazie i czyści ciasteczko. |
| Nagłówki HTTP | Middleware `helmet()` na wszystkich odpowiedziach; `x-powered-by` wyłączony; CORS ograniczony do `FRONTEND_URL`. |
| Proxy / HTTPS | `app.set('trust proxy', 1)` — wymagane przez Vercel, aby wygenerowany link logowania poprawnie wskazywał `https://`. |

Żaden endpoint chroniony (`requireUser`) nie wykonuje obecnie operacji zapisu poza odczytem własnej historii (`GET /api/auth/history`) — ryzyko CSRF na stan konta jest z tego powodu ograniczone; patrz uwaga w rozdziale 10.

---

## 04. Prywatność danych osobowych

Najbardziej wrażliwy obszar aplikacji: odczyt umów o pracę przez model AI bez ekstrakcji danych osobowych.

> **Wymóg źródłowy:** analiza umowy ma być bezpiecznie skanowana bez pobierania danych osobowych i innych danych wrażliwych (imię, nazwisko, adres, BSN, numer konta itd.). Poniżej opisano jak wymóg ten jest wymuszony technicznie — nie tylko deklaratywnie.

**Warstwa 1 — Schemat wyjścia bez pól PII.** Model zwraca wyłącznie zdefiniowany, zwarty JSON (typ umowy, pracodawca jako nazwa firmy, stanowisko, daty, stawka, CAO, fundusz emerytalny, okresy próbny/wypowiedzenia, ulga 30%). W schemacie **nie istnieje** pole na imię/nazwisko pracownika, adres, BSN ani dane bankowe.

**Warstwa 2 — Jawny zakaz w prompcie.** System prompt zawiera bezwzględny zakaz odczytu i zwracania imienia, nazwiska, adresu, numeru BSN, IBAN, daty urodzenia, telefonu, e-maila i podpisu — „nawet jeśli są widoczne w dokumencie”.

**Warstwa 3 — Filtr regex po stronie serwera.** Każde pole tekstowe zwrócone przez model jest skanowane wzorcami PESEL/BSN (9 cyfr), IBAN, e-mail i telefon NL. Dopasowanie → pole zostaje wyzerowane (`null`) i odnotowane w `redactedFields`, niezależnie od tego, co zwrócił model.

Trzecia warstwa działa jako **siatka bezpieczeństwa niezależna od jakości promptu** — nawet gdyby model AI zignorował instrukcję, dane pasujące do wzorca danych osobowych nigdy nie opuszczają serwera w odpowiedzi do przeglądarki. Mechanizm ten został przetestowany testem adwersarialnym (dokument testowy z celowo podstawionymi fikcyjnymi danymi PII) — wynik: brak wycieku.

### Przechowywanie plików źródłowych

Wgrane pliki (paski wypłaty i umowy) są przetwarzane **wyłącznie w pamięci procesu** na czas żądania (`multer.memoryStorage()`) i przesyłane do dostawcy AI jako obraz zakodowany base64. Baza danych Loonto przechowuje tylko metadane (nazwa pliku, typ MIME, status, znacznik czasu retencji), nie sam plik ani jego treść.

| Tabela | Co przechowuje | Retencja |
|---|---|---|
| `payslips` | Metadane wgranego pliku (bez treści) | `retention_until = now() + 24h` |
| `analyses` | Wynik analizy arytmetycznej (JSON) | bez automatycznego wygaszania |
| `payslip_fields` | Wartości liczbowe potwierdzone przez użytkownika | bez automatycznego wygaszania |

Pole `retention_until` jest ustawiane przy zapisie, ale w kodzie nie znaleziono zadania czyszczącego (cron), które by je faktycznie egzekwowało — patrz zalecenia (rozdział 10).

### Podmiot przetwarzający (sub-processor)

Obrazy dokumentów są przesyłane do **Groq** (dostawca inferencji AI, USA) w celu jednorazowej ekstrakcji danych — nie są tam trwale przechowywane przez Loonto, ale transfer danych do zewnętrznego, zagranicznego przetwórcy powinien być ujęty w polityce prywatności i rejestrze podmiotów przetwarzających.

---

## 05. Integracja AI (Groq)

Wnioskowanie modelowe wykorzystywane do odczytu dokumentów, tłumaczenia terminów i generowania wyjaśnień — nigdy do samego liczenia podatku.

| Zastosowanie | Model | Uwagi |
|---|---|---|
| Tekst (tłumaczenia, wyjaśnienia) | `openai/gpt-oss-120b` | Domyślny, nadpisywalny zmienną `GROQ_TEXT_MODEL` |
| Wizja (odczyt dokumentów) | `qwen/qwen3.8-27b` | Limit darmowego planu Groq: **1000 tokenów wyjściowych/min** |

Ograniczenie tokenów wymusiło dwa zabezpieczenia inżynieryjne, istotne dla oceny niezawodności ekstrakcji:

- **Zwarte schematy JSON** — krótkie klucze jednoliterowe/dwuliterowe zamiast opisowych nazw pól, aby zmieścić więcej danych w limicie.
- **Naprawa ucię­tego JSON-a** — jeśli model przerwie odpowiedź w połowie (limit tokenów), serwer domyka nawiasy algorytmicznie i odzyskuje kompletne, poprawne elementy; wynik jest oznaczany flagą `truncated: true`, widoczną dalej w odpowiedzi API.

Silnik obliczeniowy (kalkulator) **nie korzysta z AI do liczenia kwot** — AI jest używane wyłącznie do odczytu dokumentu, tłumaczenia terminów niderlandzkich i generowania opisowego wyjaśnienia wyniku już policzonego deterministycznie w kodzie.

---

## 06. Silnik obliczeń wynagrodzeń

Deterministyczny, w pełni testowalny moduł TypeScript — bez udziału AI. Kolejność odliczeń odzwierciedla rzeczywiste paski wypłaty.

**Kolejność obliczeń:**

1. Brutto: godziny normalne + dodatki zmianowe (sobota/niedziela/święto/noc) + nadgodziny w dwóch progach mnożnika.
2. Vakantiegeld: +8% od sumy pośredniej (opcjonalnie).
3. Składki pracownicze odjęte od brutto: PAWW → emerytalna (brak / % / StiPP) → ubezpieczenie chorobowe (ZW) → WGA.
4. Podstawa opodatkowania = powyższe minus ewentualne zwolnienie 30% ruling.
5. Rozdział na część regularną i „bijzondere beloningen” (nadgodziny + vakantiegeld) dla celu bijzonder tarief, jeśli włączone.
6. Podatek progresywny (tabela roczna, przeliczona na okres) + bijzonder tarief od części nieregularnej.
7. Ulgi: algemene heffingskorting + arbeidskorting (z fazą narastania i wygaszania).
8. Netto = brutto − składki − podatek po uldze + reiskosten − inne potrącenia.

**Fundusz emerytalny — tryby:**

| Tryb | Wzór |
|---|---|
| `none` | 0 |
| `percent` | brutto całkowite × wskazany procent |
| `stipp` | `min(max(stawka/h − franczyza/h, 0), max_podstawa/h − franczyza/h) × godziny × stawka pracownika` |

Parametry StiPP (franczyza, maksymalna podstawa, stawka pracownika) pochodzą z bazy reguł referencyjnych — zob. rozdział 07.

**Stawki podatkowe — 2026 H2 (obowiązujące od 2026-07-01):**

| Próg dochodu rocznego | Stawka |
|---|---|
| €0 – €38 883 | 35,75% |
| €38 883 – €78 426 | 37,56% |
| powyżej €78 426 | 49,50% |

| Parametr | Wartość |
|---|---|
| Płaca minimalna (dorosły), na godzinę | €14,99 |
| Płaca minimalna (dorosły), miesięcznie | €2 337,00 |
| Algemene heffingskorting — maks. / próg wygaszania / stawka | €3 115 / €29 736 / 6,398% |
| Arbeidskorting — maks. / próg wygaszania / stawka | €5 685 / €45 592 / 6,51% |
| Dodatek do bijzonder tarief przy loonheffingskorting | +4,45 pp |

Źródła danych (zacytowane w pliku stawek): rijksoverheid.nl (minimumloon), belastingdienst.nl (tabela box 1) oraz oficjalna tabela bijzondere beloningen Belastingdienst 2026. Ostatnia weryfikacja źródeł: `2026-09-07`. Progi narastania arbeidskorting (8,425% / 31,433% / 2,537%) zweryfikowano krzyżowo z kilku źródeł wtórnych wobec spójności algebraicznej z oficjalnie podanym maksimum — oznaczone w kodzie jako przybliżenie, do potwierdzenia z oficjalną tabelą rekenregels Belastingdienst.

> **Zastrzeżenie wbudowane w wynik API:** „Kalkulacja ma charakter orientacyjny i wykorzystuje uproszczone tabele podatkowe. Ostateczne rozliczenie zależy od pracodawcy i Belastingdienst.” — zwracane w każdej odpowiedzi kalkulatora jako pole `disclaimer`.

---

## 07. Baza reguł referencyjnych

Mechanizm pozwalający aktualizować dane podatkowe, składkowe i prawne bez wdrażania nowej wersji kodu.

Tabele `legal_rules` / `legal_rule_versions` przechowują wersjonowane, oznaczone datą ważności (`valid_from`/`valid_to`) parametry JSON wraz z URL-em źródła. Moduł `rules-repository.ts` udostępnia funkcję `getCurrentRule(code)`, która:

1. sprawdza pamięć podręczną w procesie (TTL 5 minut),
2. odpytuje bazę o wersję ważną na *dziś* dla danego kodu reguły,
3. przy braku połączenia z bazą lub braku wpisu — zwraca `null`, a wywołujący kod korzysta z bezpiecznej wartości statycznej wbudowanej w repozytorium.

Dzięki temu **żadna awaria bazy danych nie powoduje przerwy w działaniu kalkulatora** — jedynie przełącza źródło stawek na statyczne, co jest raportowane w wyniku jako `ratesSource: "static"`.

| Kod reguły | Zawartość | Wykorzystanie w kodzie |
|---|---|---|
| `loonheffing_nl` | Progi podatkowe, płaca minimalna, ulgi podatkowe | Kalkulator, minimalna stawka w analizie umowy |
| `pensioenfonds_stipp` | Franczyza, maks. podstawa, stawka pracownika StiPP | Tryb emerytalny „stipp” w kalkulatorze |
| `arbeidsrecht_proeftijd` | Maks. okres próbny wg długości umowy (art. 7:652 BW) | Analiza umowy |
| `arbeidsrecht_opzegtermijn_werkgever` | Minimalny okres wypowiedzenia wg stażu, w progach lat (art. 7:672 BW) | Analiza umowy |
| `cao_abu_uitzendkrachten` | Domyślne stawki dodatków zmianowych CAO dla pracy tymczasowej | Wartości domyślne w kalkulatorze (referencyjnie) |

**Przykład: reguła okresu wypowiedzenia** (`arbeidsrecht_opzegtermijn_werkgever`):

| Staż pracownika | Minimalny okres wypowiedzenia (pracodawca) |
|---|---|
| do 5 lat | 1 miesiąc |
| 5–10 lat | 2 miesiące |
| 10–15 lat | 3 miesiące |
| powyżej 15 lat | 4 miesiące |

Moduł analizy umowy przelicza staż z dat umowy (lub przyjmuje umowę na czas nieokreślony), znajduje właściwy próg i porównuje go z zadeklarowanym w umowie okresem wypowiedzenia (przeliczonym na tygodnie, ×4,33/mies.) — rozbieżność generuje flagę ostrzegawczą.

> **Otwarty punkt:** funkcja `listRuleFreshness()`, która wylicza „świeżość” każdej reguły, istnieje w kodzie, ale nie jest jeszcze podłączona do żadnego harmonogramu (np. Vercel Cron) ani powiadomienia — aktualizacja co pół roku jest obecnie procesem ręcznym. Szczegóły w rozdziale 10.

---

## 08. Schemat bazy danych

Postgres (Neon), 9 tabel, bez ORM — zapytania SQL parametryzowane bezpośrednio przez klienta `pg`.

| Tabela | Przeznaczenie |
|---|---|
| `users` | Konto użytkownika (e-mail, język, status); brak pola hasła. |
| `auth_sessions` | Aktywne sesje — token przechowywany jako skrót SHA-256, z datą wygaśnięcia. |
| `magic_links` | Wystawione, jeszcze nieużyte lub użyte tokeny logowania (skrót + wygaśnięcie 15 min). |
| `payslips` | Metadane wgranego dokumentu i status analizy; bez treści pliku. |
| `payslip_fields` | Pola liczbowe potwierdzone przez użytkownika, z flagą korekty ręcznej. |
| `analyses` | Wynik kontroli arytmetycznej (JSON) powiązany z paskiem wypłaty. |
| `legal_rules` | Katalog reguł referencyjnych (kod, tytuł, jurysdykcja). |
| `legal_rule_versions` | Wersje parametrów reguł z oknem ważności i URL-em źródła. |
| `user_events` | Zdarzenia telemetryczne (np. `payslip_uploaded`) do analizy użycia. |

Indeksy pokrywają najczęstsze wzorce odczytu: historia użytkownika po dacie, ważność wersji reguł, zdarzenia po użytkowniku. Wszystkie klucze obce z kaskadowym usuwaniem (`ON DELETE CASCADE`) tam, gdzie dane są zależne od istnienia użytkownika lub paska wypłaty.

---

## 09. Infrastruktura i wdrożenie

W pełni serverless, bez własnych serwerów do utrzymania.

| Element | Opis |
|---|---|
| Hosting | Vercel, projekt `gregor-s-projects2/nl-payslip-app`. Frontend budowany statycznie (Vite), backend jako jedna funkcja serverless (`api/index.ts`) eksportująca aplikację Express; przekierowanie `/api/*` zdefiniowane w `vercel.json`. |
| Baza danych | Neon Postgres podłączony przez integrację Vercel Storage — zmienne połączenia (`DATABASE_URL`, `POSTGRES_*`) ustawiane automatycznie. |
| E-mail | Resend, wywoływany bezpośrednio przez `fetch` (brak dodatkowej zależności SDK). Domena nadawcy: domyślna domena Resend. |
| AI | Groq — endpoint zgodny z OpenAI SDK, klucz i model wizyjny skonfigurowane jako zmienne środowiskowe produkcyjne. |
| Zmienne środowiskowe (produkcja) | Potwierdzono obecność (bez odczytu wartości): `DATABASE_URL`, komplet zmiennych `POSTGRES_*`/`PG*` z integracji Neon, `GROQ_API_KEY`, `GROQ_VISION_MODEL`, `RESEND_API_KEY`. |

---

## 10. Znane ograniczenia i zalecenia

Stan na dzień przygotowania raportu — pogrupowane wg statusu.

### ✅ Zweryfikowane jako zgodne

- **Ochrona danych osobowych w analizie umów** — trójwarstwowy mechanizm (schemat, prompt, filtr regex) potwierdzony testem adwersarialnym — brak wycieku danych podstawionych celowo w dokumencie testowym.
- **Odporność kalkulatora na awarię bazy danych** — wzorzec „baza z bezpiecznym fallbackiem statycznym” zastosowany konsekwentnie we wszystkich odczytach reguł referencyjnych.
- **Tokeny logowania i sesji przechowywane jako skróty** — ani token magic-linku, ani token sesji nie są zapisywane w bazie w postaci jawnej — wyłącznie SHA-256.

### 🟣 Otwarte — do zaadresowania

- **Brak automatyzacji aktualizacji reguł co pół roku** — `listRuleFreshness()` istnieje, ale nie jest podłączona do żadnego harmonogramu (Vercel Cron) ani powiadomienia — proces aktualizacji jest obecnie ręczny.
- **Brak testów automatycznych i CI** — nie znaleziono plików testowych ani pipeline'u CI (np. GitHub Actions) w kodzie aplikacji — poprawność weryfikowana obecnie ręcznie i przez typechecking.
- **Stan repozytorium Git** — znaczna część bieżącej funkcjonalności (moduł kont, kalkulator, analiza umów, baza reguł) nie jest jeszcze scommitowana w historii Git — zalecane commitowanie przed formalnym audytem dla pełnej identyfikowalności zmian.

### 🟡 Do rozważenia

- **Dostarczalność e-maili logowania** — wysyłka z domyślnej domeny Resend (`onboarding@resend.dev`) — obserwowano trafianie do SPAM. Świadomie odłożone przez właściciela produktu do czasu podłączenia własnej domeny.
- **Brak limitu żądań wg adresu IP przy wysyłce magic-linku** — istnieje cooldown 60 s na adres e-mail, ale brak ograniczenia po adresie IP — teoretyczne ryzyko wykorzystania endpointu do masowej wysyłki e-maili na dowolne adresy.
- **Ujawnienie sub-processora AI w polityce prywatności** — obrazy dokumentów są przesyłane do Groq (USA) w celu jednorazowej ekstrakcji — wymaga odzwierciedlenia w polityce prywatności / rejestrze podmiotów przetwarzających, mimo że dane nie są tam trwale składowane.
- **Przybliżone progi narastania arbeidskorting** — wartości progów (8,425% / 31,433% / 2,537%) pochodzą ze źródeł wtórnych, zweryfikowanych krzyżowo pod kątem spójności algebraicznej — oznaczone w kodzie jako przybliżenie do potwierdzenia z oficjalną tabelą rekenregels Belastingdienst.

---

*Raport przygotowany na podstawie przeglądu kodu źródłowego, konfiguracji wdrożeniowej (Vercel) i stanu produkcyjnego aplikacji Loonto. Nie stanowi porady prawnej ani podatkowej — kalkulacje i kontrole zgodności mają charakter orientacyjny, zgodnie z zastrzeżeniem widocznym w interfejsie aplikacji.*
