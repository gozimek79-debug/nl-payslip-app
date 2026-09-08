# NL Payslip — plan budowy produktu

## Cel produktu

NL Payslip pomaga polskim pracownikom w Holandii zrozumieć pasek wypłaty,
wykryć podejrzane pozycje i przygotować się do rozmowy z pracodawcą. Wynik
jest informacją i kontrolą spójności, a nie poradą prawną ani oficjalnym
wyliczeniem listy płac.

## Główny przepływ użytkownika

1. Użytkownik zakłada konto lub rozpoczyna analizę gościnną.
2. Przesyła PDF albo zdjęcie paska.
3. System odczytuje dane i pokazuje dokument obok prostego formularza korekty.
4. Użytkownik zatwierdza dane.
5. Silnik reguł pokazuje wynik, źródła prawne, poziom pewności i możliwe kroki.
6. Analiza trafia do prywatnej historii użytkownika zgodnie z polityką retencji.
7. Użytkownik może wygenerować wiadomość do pracodawcy lub porównać okresy.

## Architektura MVP

- Frontend: React, Vite, TypeScript, React Router i dostępne komponenty UI.
- API: Node.js, Express, TypeScript, Zod i uporządkowane moduły domenowe.
- Dane: PostgreSQL, migracje i ORM; Redis dopiero dla kolejek OCR/rate limitingu.
- Pliki: szyfrowany storage z automatycznym usuwaniem oryginałów.
- OCR: AWS Textract z adapterem, normalizacją liczb i confidence per pole.
- AI: tylko wyjaśnianie zatwierdzonych wyników; bez wykonywania obliczeń.
- Płatności: Stripe Checkout oraz webhooki jako źródło stanu subskrypcji.
- Obserwowalność: błędy, audyt zmian reguł i metryki bez treści dokumentów.

## Model danych

- `users`: konto, język, status i zgody.
- `auth_accounts` / `sessions`: logowanie i bezpieczne sesje.
- `payslips`: właściciel, okres, status analizy, retencja i wynik OCR.
- `payslip_fields`: rozpoznane wartości, confidence i korekty użytkownika.
- `analyses`: wynik, wersja silnika i zastosowany zestaw reguł.
- `legal_rules`: reguła, jurysdykcja, daty obowiązywania i źródło urzędowe.
- `legal_rule_versions`: historia zmian, autor i data zatwierdzenia.
- `user_events`: istotne zdarzenia produktu bez zbędnych danych osobowych.
- `subscriptions` / `payments`: plan, dostawca i stan rozliczeń.
- `audit_log`: dostęp administracyjny i zmiany danych prawnych.

## UI/UX

- Język prosty, spokojny i pozbawiony księgowego żargonu.
- Jeden główny cel na ekran; progres analizy widoczny w 3 krokach.
- Wynik w warstwach: podsumowanie, wyjaśnienie, szczegóły i źródła.
- Kolor nie może być jedynym nośnikiem informacji; pełna obsługa klawiatury.
- Na urządzeniach mobilnych najpierw wynik/formularz, potem podgląd dokumentu.
- Wyraźne komunikaty o prywatności, retencji pliku i ograniczeniach wyniku.

## Monetyzacja

### Free

- 1 podstawowa analiza miesięcznie.
- Odczyt pozycji i kontrola arytmetyczna.
- Brak trwałego przechowywania oryginalnego dokumentu.

### Jednorazowa analiza Plus

- Pełny raport, źródła i gotowa wiadomość do pracodawcy.
- Dobry punkt wejścia dla osób, które nie chcą abonamentu.

### Pro

- Historia i porównywanie miesięcy.
- Większy limit analiz.
- Alerty o zmianach prawa wpływających na wcześniejsze analizy.
- Eksport raportów i generator korespondencji.

Przed ustaleniem cen należy przeprowadzić test popytu. Dobrym punktem startowym
do testu jest 4,99–7,99 EUR za raport oraz 8,99–12,99 EUR miesięcznie za Pro.

## Etapy realizacji

### Etap 0 — fundament i bezpieczeństwo

- Rotacja ujawnionych kluczy i bezpieczna konfiguracja środowisk.
- Uruchamialne workspace, lint, typecheck, testy i CI.
- Kontrakt API oraz walidacja wszystkich wejść.

### Etap 1 — wertykalny MVP

- Upload, poprawny OCR, formularz korekty i wynik jednej analizy.
- Podstawowe reguły arytmetyczne oraz WML z oficjalnym źródłem.
- Brak logowania wymagany do pierwszego testu użyteczności.

### Etap 2 — konto i baza

- Logowanie e-mail magic link lub passkey.
- Historia analiz, retencja, eksport i usuwanie konta.
- Panel administracyjny do publikowania wersji reguł prawnych.

### Etap 3 — płatności

- Limity planów, Checkout, webhooki i portal rozliczeniowy.
- Pomiar konwersji bez przechowywania treści pasków w analityce.

### Etap 4 — gotowość produkcyjna

- Audyt RODO i bezpieczeństwa, testy E2E, backup/restore i monitoring.
- Pilotaż na zanonimizowanych paskach z kilku agencji i CAO.

## Kryteria ukończenia MVP

- Nowy użytkownik kończy analizę bez pomocy na telefonie i komputerze.
- Każde pole OCR ma confidence i może zostać ręcznie poprawione.
- Każdy komunikat prawny wskazuje wersję reguły i oficjalne źródło.
- Testy obejmują parser liczb, sumy paska, WML i kontrakt API.
- Dokument można usunąć, a polityka retencji działa automatycznie.
- AI nie otrzymuje identyfikatorów osobowych i nie oblicza wynagrodzenia.
