# RAPORT WYKONAWCY — LOONTO R3-B: Document-First Intelligent Conversation

**Status: `R3-B DOCUMENT-FIRST VERTICAL SLICE IMPLEMENTED — HOLD FOR CTO/CEO REVIEW`**

Date: 2026-10-18 · Repository `gozimek79-debug/nl-payslip-app` · Branch `r3-b-document-first-conversation`
Behaviour contract: Appendix A of the task (Contract v1.1, CEO-approved 2026-10-16), applied in full.
No Production deploy, no alias change, no merge, no R3-C. Provider cost incurred by the executor: **0** (no Gemini call, no Groq call).

---

## 1. Commits, files, tree

| | |
|---|---|
| Baseline (R3-A) | `36b24f984df1241f1b0e6d8b927b485c6f295a9e` |
| Implementation | `a1122b3e4c37b3442e230cce31255d37fcc9e120` — feat(r3-b): document-first conversation vertical slice |
| Copy fix | `00e2a5f9eaa0fe49e404c703adaa350ea8e8533f` — the read notice names where Gemini processes (outside the EU) |
| This report | one docs-only commit on top of `00e2a5f` (its SHA is the branch head; given in the hand-over message) |
| Author | `Gregor <gozimek79@gmail.com>`, trailer `Co-Authored-By: Claude Opus 5.5` |
| Pushed | only `r3-b-document-first-conversation`. `main` = `b5847a0…` and `r3-a-conversational-ui-foundation` = `36b24f9…` unchanged |
| Working tree | clean (0 real diffs, 0 untracked files) |

33 files changed relative to the baseline, +27 977 / −58 lines. 24 115 of those lines are the generated contract-fixture JSON.

**Backend** (R2, narrow — see §4):
- `apps/backend-node/src/conversation/next-question.ts` (+11): `deferredFields` input.
- `conversation-turn.ts` (+40): opt-in deferral and the "nie wiem" loop guard.
- `conversation-types.ts` (+9).
- `controllers/conversation.controller.ts` (+2): schema.
- `deterministic-interpreter.ts` (+3): "nie wiem" to an offer.
- `message-evidence.ts` (+7): L1-subset vocabulary.
- `package.json`: test list.
- New: `conversation/r3b-document-first.test.ts` (11 tests) and `test-support/r3b-fixtures.ts`. Plus 3 HTTP tests in `controllers/conversation.controller.test.ts`.

**Frontend:**
- New shared adapter `src/document-facts-reader.ts` and its test.
- `ProDocuments.tsx` now calls the adapter (−47/+…, behaviour unchanged).
- `main.tsx`: entry routing.
- New folder `src/r3b/`:
  - `R3BDocumentConversation.tsx` (screen);
  - `r3b-flow.ts` (state machine);
  - `r3b-turn.ts` (R2 client);
  - `r3b-profile-projection.ts` (typed read-only Profile projection);
  - `r3b-documents.ts`;
  - `r3b-describe.ts`;
  - `r3b-copy.ts` (PL/EN);
  - `r3b.css`;
  - `r3b-entry.ts`;
  - tests, and `fixtures/r3b-contract-fixtures.json`.
- Updated tests (explained in §7): `pro-profile-prefill.test.ts`, `pro-profile-questions.test.ts`, `r3a/r3a-entry.test.ts`, `package.json` test list.

## 2. Inventory (§B) — the module boundaries actually used

| Concern | Existing module (reused) | How R3-B uses it |
|---|---|---|
| File reading, render, batch plan | `local-ocr.ts` (`readDocumentSource`, `renderPageImages`, `photoWithinBudget`), `document-batches.ts` (`planDocumentBatches`: 30-page cap, 3 images / 20 text pages per call, 180k chars) | Unchanged. Loaded lazily by R3-B only when the user presses the read button. |
| Reader loop (one call per batch, unread pages reported) | was inline `readDocument` in `ProDocuments.tsx` | **Extracted unchanged** into `document-facts-reader.ts` (dependency-injected). PRO and R3-B both call it. ProDocuments keeps its diagnostic replay. |
| Document type and annex rule | `pro-documents-policy.ts` (`addDocument`, `removeDocument`, `setEffectiveDate`, `routeForDocument`, `isReadyToSubmit`) | Unchanged, called by `r3b-documents.ts`. |
| Gemini fact extraction | `POST /api/pro/payslip-facts`, `POST /api/pro/contract-facts` (zod validation, budgets, rate limit 10 per 300 s fail-closed, no content logging) | Unchanged. No second reader or prompt. |
| Payroll Profile | `POST /api/profile/resolve` + `pro-profile-prefill.resolveProfile` + `pro-profile-questions.resolveWithDecisions` / `buildPendingDecisions` (existing `confirm_candidate` decision) | Unchanged. The R3-B summary, question suppression and conflict question come from its response only. |
| Conversation | `POST /api/scenario/turn` → `runConversationTurn` → trust checks (RT-001 / F3) → deterministic interpreter, or ONE model call → support guard (M3/M4/I2/C1) → patch authority → R1 `evaluateScenario` → public projection → `selectNextQuestion` | Reused. One narrow selection-only input added (§4). |
| UI shell | `src/r3a/r3a.css` (R3-A visual direction) | Reused as the base. `r3b.css` adds only the document offer, summary and tags. No cosmetic redesign (Loonto Glass is separate). |

## 3. What is genuinely connected, what is mocked or limited

**Connected — real code, unchanged engines:**
- Real file selection: PDF, JPG, PNG; type and size checked (§9).
- Real pdf.js text and page rendering.
- The real batch planner and the real reader adapter.
- The real fact-route request shape.
- The real Payroll Profile: evidence states, conflicts, regimes, as-of date, readiness and issues, user decisions.
- The real R2 turn route: trust checks, deterministic interpreter, guards, R1 evaluation, question selector.

**Mocked in executor tests and the walkthrough (no paid call):**
- The Gemini reader. Fixture fact batches are built through the real reader mapping (`map*FactsResponse`). The local walkthrough server answers the two fact routes with them, after running the real `validateFactRead` on each request.
- The Groq model. It is absent, or scripted in backend tests.

**Deliberately NOT integrated (trust boundary, §5):**
- Document values do not enter the R2 Scenario. They are shown as "odczyt z dokumentu — wymaga weryfikacji", and they only defer the matching question. The evaluation therefore stays `blocked`, and **no amount is shown anywhere** ("Wynik jeszcze niedostępny").
- No verified / `document` source is ever produced or sent.

**Limited by scope:**
- Weekly base-pay goal only. Tax, deductions and extras are not asked (deferred as out-of-goal).
- No Analyzer ("Analizator w przygotowaniu", disabled control).
- No multi-month reconciliation. Several payslips are resolved by the existing resolver, which applies no recency rule.

## 4. Backend changes — narrow, each tied to an acceptance requirement

1. **`conversation.deferredFields`** (request and response digest, at most 40 strings, validated against the Scenario field table plus `work.hours`).
   - It is selection only: the R2 selector does not ask about those requirements now. It is never a value, never a source, and never an input to R1. An `invalid` correction question is never hidden.
   - Carrying the list opts the turn into **loop prevention**. After "nie wiem", or a declined offered assumption, the field the selector would only ask again is put aside (unknown, never zero) and the next question is asked.
   - Without the list, R2 behaves exactly as before: all 724 baseline tests pass unchanged.
   - Needed for C3 (do not re-ask a document-known rate; no "nie wiem" loop; G03/G23) without writing document values into the Scenario.
2. **"nie wiem" to an offered assumption** is now answered deterministically: nothing written, not an acceptance (CEO Decision 10). Previously this went to the model.
3. **L1 subset (Contract §5.5 / §8.3, task C3 "night allowance cannot become Saturday"):**
   - Found during R3-B: with a model, "dodatek nocny 50%" on the Saturday question **was written as the Saturday premium**, because the C1 vocabulary had no night-allowance word. This was reproduced in the fixture generator.
   - Fix: night, evening, shift and irregular-hours words (PL/EN/NL) are now their own component in the C1 guard → `component_mismatch_withheld`.
   - L1 in general (any unrecognised allowance name) **remains OPEN**.

**Why no server-owned document binding:** `trustedContextFromProfile` exists, but it is server-internal. The facts the Profile is built from are client-echoed fact batches: unsigned, with no persistence. Binding them to a turn would be exactly the "insecure client-origin trust" the task forbids, and signing or persisting them is F6 / new persistence (out of scope). So the conservative path of C4 was implemented.

## 5. Trust and evidence status (do not read as closure)

- **RT-001: OPEN** (public `/api/scenario/evaluate` still accepts self-declared sources).
  - R3-B never calls `/evaluate` and never sends `source: document` (asserted on every recorded request).
  - The public `/turn` still rejects a self-declared document source, including with `deferredFields` (HTTP plus domain tests).
- **RT-002: OPEN.** No new authority for model or untrusted paths. No Tier A result is presented.
- **P1 (ambiguous 125/150/200%): OPEN in R2.**
  - The R3-B interface **blocks** it: on a premium question, any percentage ≥ 100 (bare or with words) is not sent. The user is asked "łącznie czy ponad stawkę?". Their explicit choice is then sent as a deterministic `50%` or `150%`.
  - Other clients of R2 are still exposed (the deterministic path writes a bare 150).
- **L1: OPEN.** Narrow night/evening/shift subset fixed (§4.3).
- **F6 (trusted document context): OPEN.** **PII redaction: OPEN.**
- Document readings are labelled "odczyt z dokumentu — wymaga weryfikacji" with "Odczyt pokazuje, co jest w dokumencie — nie potwierdza, że naliczenie jest prawidłowe."
- A user's choice between conflicting candidates is the Profile's own `user_confirmed` state, with its decision date.
- A user's edit is a separate `source: user` value with `enteredAt`, shown next to the unchanged document reading.

## 6. As-of date and periods (C2)

- Only a **dated annex** makes the Profile depend on the as-of date (contract timeline). With an annex, R3-B **asks the week first** ("Tydzień przed / od 01.09.2026", any other day, or "Nie wiem") and never chooses today silently.
- Without an annex, the resolver result is identical for every date. This is proven by a backend test at 2025-01-06 and 2027-12-31. A technical date is therefore used, and every value keeps its own document period in the summary.
- Disjoint periods do not conflict:
  - week before the annex → €16.80 "zgodne w dokumentach";
  - week from 01.09.2026 → €17.20, with the August payslip shown as "dotyczy innego okresu — to nie jest rozbieżność".

## 7. Tests

| Suite | Baseline `36b24f9` | Final |
|---|---|---|
| Backend `npm test` (build + node test) | 724 / 724 | **738 / 738** (+11 R3-B domain/contract, +3 HTTP) |
| Frontend `npm test` | 140 / 140 | **182 / 182** (+5 adapter, +12 turn/projection/documents, +12 flow, +8 render, +5 containment) |
| Typecheck backend / frontend | clean / clean | clean / clean |
| Frontend build | OK | OK. New lazy chunks `R3BDocumentConversation` 75.2 kB JS + 5.9 kB CSS; shared `r3a.css` chunk 11.2 kB; main JS 881.5 kB (+3.2 kB: adapter + router); main CSS unchanged 30.9 kB |

**Contract fixtures.** `src/r3b/fixtures/r3b-contract-fixtures.json` contains:
- the synthetic fact batches;
- 8 recorded Profile resolves;
- 9 recorded R2 conversation flows (requests and responses);
- 34 deterministic-reply probes.

It is **generated by the backend suite from the real code**, and re-checked on every backend run (drift fails the test). The frontend tests replay those exact responses and **require byte-identical requests**. Regenerate with `R3B_WRITE_FIXTURES=1 npm test`.

**Mutation checks** (each injected, test run, file restored and md5-verified):
- **Frontend 12/12 killed:**
  - document rate not deferred;
  - conflict defers;
  - bare 150% sent;
  - file sent on selection;
  - contract hours defer the hours question;
  - edit written as `document`;
  - file name sent to the profile;
  - today chosen silently with an annex;
  - failed read shown as read;
  - "nie wiem" deferral forgotten;
  - adapter drops failed pages;
  - amount shown in the result card.
- **Backend 7/7 killed:**
  - selector ignores deferral;
  - no loop guard;
  - deferral list not validated;
  - deferral always on (legacy R2 changed);
  - "nie wiem" to an offer goes to the model;
  - night vocabulary removed;
  - public route drops the hint.

**Existing tests updated, intent kept:**
- (a) `pro-profile-prefill.test.ts` P2.17 #18/#3 and #15, and `pro-profile-questions.test.ts` S5 §20. They asserted the reader-loop source text inside `ProDocuments.tsx`. They now assert the same rules in `document-facts-reader.ts`, plus that ProDocuments calls it.
- (b) `r3a/r3a-entry.test.ts`: the `main.tsx` routing assertion now reflects `/?r3a=1` → R3-B and `/?r3a=demo` → R3-A. Its file and import containment checks are unchanged.

No unrelated old code was repaired.

## 8. The five acceptance cases

| # | Case | Automated proof | Browser walkthrough (screenshot) |
|---|---|---|---|
| 1 | Payslip €16.80/h weekly | Read only after the explicit action. Summary with source (document doc-1, period 10.08–16.08.2026, page 1, printed line). "Ile dostanę za 40 godzin?" → hours clarified (model path) or hours question (no model). **The rate is never asked.** No document value in any request. Result "niedostępny". | r3b-05, r3b-06, r3b-07, r3b-08 |
| 2 | No documents | "Kontynuuj bez dokumentów" → real R2 deterministic steps (hours composition → rate question without "documents" wording) → "Nie wiem" → unknown, put aside, not re-asked. PL and EN. No reader or profile call. | r3b-09 |
| 3 | Contract + payslip | Same-period €17.20 vs €16.80 stays `conflict` (no winner). ONE grounded question before calculating; a choice = existing `confirm_candidate` decision (`user_confirmed`, dated); "Nie wiem" keeps both and defers. Annex 01.09.2026: week asked first; before/after → no conflict. | r3b-10, r3b-11, r3b-12, r3b-13 |
| 4 | Reader fails / partial | 21-page document: pages 1–20 read, page 21 failed → "nie odczytano stron 21 z 21 (błąd odczytu)"; facts kept. Reader unavailable → document "Nie udało się odczytać — czytnik dokumentów (Gemini) jest teraz niedostępny"; no summary, no profile call; continue without documents works. Unopenable file → "nie udało się otworzyć pliku". | r3b-14, r3b-15 |
| 5 | Trust and ambiguity | Client `source: document` → rejected (HTTP and domain). Instruction text printed in a document: inert (rate still 16.80; never in a turn request). Bare "150%" → not sent, meaning asked → "łącznie" saved as +50%. "dodatek nocny 50%" on the Saturday question → not written (with model: `component_mismatch_withheld`; without model: "nie umiem automatycznie zrozumieć"). Repeated "nie wiem" → assumption only *offered*, never applied; second "nie wiem" ends without a loop. | r3b-16, r3b-17, r3b-18, r3b-19 |

**Screenshots:** `C:\Users\48661\Desktop\Loonto\R3B-screenshots\` (28 PNG + metrics). They are of the actual branch build: the walkthrough server serves `apps/frontend-react/dist` and runs the real backend app in-process. Coverage:
- first screen at 360 / 390 / 768 / 1280 (`r3b-01-*`); all four document actions visible on a 360×780 phone;
- keyboard focus (`r3b-02`);
- Gemini notice (`r3b-03`); file-type error (`r3b-04`);
- missing-rate wording (`r3b-20`);
- EN (`r3b-21`, `r3b-22`);
- existing app unchanged (`existing-app-*`); R3-A demo reachable (`r3a-demo-*`).

Metrics on every R3-B screen:
- horizontal overflow: none;
- tap targets under 44 px: none (the existing app's header targets 34–40 px are pre-existing and untouched);
- euro figures that are not hourly rates: none. The two hits are the contract's own printed text "Uurloon: € 17,20" inside "Skąd to wiem".

Console errors: 0. Mock reader calls: 23. Real Gemini calls: 0.

## 9. Security posture (reported, not assumed adequate)

**Files:**
- Only PDF, JPEG or PNG. Empty files rejected; files over 20 MB rejected. That is a new client guard: there was no raw-size limit before.
- The reader's own 30-page, 3-image and 180k-character budgets still apply, as do the server's zod budgets.
- Files are held in memory only, are never stored, and are dropped on removal or "Zacznij od nowa".
- The profile receives technical labels (`payslip-1`) and opaque ids (`doc-1`), never the file name.

**Network:**
- R3-B calls only the existing endpoints (asserted).
- Document content goes only to the reader routes, and only on the explicit read action, after the notice "Google Gemini, przetwarzanie poza UE".
- No document text or facts are sent to the conversation route or the model.

**Browser storage:** only the `loonto-lang` key (asserted). No `innerHTML`; React text rendering only. A file name or printed text containing `<img onerror>` / `<script>` renders as text (tested).

**Endpoints as deployed today:**

| Endpoint | Auth | Rate limit | Other |
|---|---|---|---|
| `/api/pro/*-facts` | none | 10 per 300 s per IP, fail-closed | zod validation, no content logging, Gemini **outside the EU** |
| `/api/profile/resolve` | none | none (pure, at most 30 documents) | — |
| `/api/scenario/turn` | none | 30 per 300 s per IP, fail-closed | — |

- The Preview shares Production's `DATABASE_URL` (Neon). R3-B writes only rate-limit counters there.
- This posture is **not adequate for real personal documents** (§11).

## 10. Protected Preview and how the CEO opens it

Auto-created by GitHub→Vercel on push (no manual deploy, no alias, no Production change; Production alias still `dpl_6Vr2sfac2i81XMwW9EfH4GK3qUae`):
- `a1122b3` → `dpl_6tDLbruookww8Tc2pbk8m5XYpq4V` — `https://nl-payslip-b5m1egvan-gregor-s-projects2.vercel.app/?r3a=1`
- `00e2a5f` → `dpl_HVVoF9t1PAcrPS1KMaMs8kX31BkZ` — `https://nl-payslip-k2kidjeyj-gregor-s-projects2.vercel.app/?r3a=1`
- **Stable branch URL (always the newest R3-B build):** `https://nl-payslip-app-git-r3-b-document-firs-de50fe-gregor-s-projects2.vercel.app/?r3a=1`
- All of these return **302 to Vercel login** (protected). The report commit will produce one more Preview with identical application code; the branch URL follows it.

**On a phone:** open the branch URL in the phone browser and sign in with a Vercel account that is a member of the "gregor-s-projects2" team. The page then opens at `?r3a=1`. `/?r3a=demo` shows the old R3-A scripted demo; `/` is the unchanged app. No shareable or bypass link was created; making a Preview public is a CEO/CTO decision.

**Important — Preview environment (checked by variable names, values not read):**
- `GEMINI_API_KEY`, `GEMINI_READER_ENABLED` and `GROQ_API_KEY` are configured for **Production only**.
- On the Preview, "Odczytaj przez Gemini" therefore shows the honest error "czytnik dokumentów (Gemini) jest teraz niedostępny" (case 4 path).
- The conversation is deterministic: free text such as "Ile dostanę za 40 godzin?" gets the honest "nie umiem automatycznie zrozumieć" and the hours question. The example buttons work fully.
- Seeing a **real** document reading on the Preview needs a separate CEO/CTO decision: adding the Gemini key to the Preview environment. That is an infrastructure change, billable, with processing outside the EU, so I did not make it. The estimated scale would be one Gemini call per synthetic document of up to 3 pages. The document path is shown in the walkthrough screenshots instead.

## 11. Open risks and no-go conditions for real personal documents

**No-go until separate gates:**
- PII / privacy / access gate (no consent record, no account binding, no DPA).
- Gemini processing outside the EU.
- No PII redaction.
- Unauthenticated public reader and profile endpoints.
- Facts held by the client unsigned (F6).
- RT-001 / RT-002 open.

**Other open points:**
- P1 is blocked only in this interface, not in R2.
- L1 general remains open.
- The free-text goal needs the model (Groq) to be understood directly; without it R2 falls back to the hours question.
- An edit in the scenario panel is applied on the next message; no extra turn is sent.
- Several payslips with different rates are a conflict in the existing resolver (no recency rule).
- The fixture JSON is large (≈0.76 MB) but test-only.
- The as-of policy depends on the annex being the only date-dependent input of the current resolver; it is tested, and must be revisited if the resolver changes.

## 12. Krótki scenariusz testu dla CEO (3–5 minut)

1. Otwórz na telefonie link oddziałowy z §10 (z `?r3a=1`) i zaloguj się do Vercel. U góry widać „Wersja testowa — używaj wyłącznie dokumentów przykładowych, bez danych osobowych” oraz cztery przyciski: **Dodaj pasek wypłaty / Dodaj umowę / Dodaj aneks / Kontynuuj bez dokumentów**.
2. Dotknij **Dodaj pasek wypłaty** i wybierz plik przykładowy z folderu `Desktop\Loonto\R3B-synthetic-documents` (np. `synthetic-payslip-week33.pdf`). Plik pojawia się jako „Wybrany — jeszcze nieodczytany”. Nic nie zostało wysłane, a pod listą jest informacja o Gemini (poza UE) i przycisk odczytu.
3. Dotknij **Odczytaj dokument przez Gemini**. Na Preview zobaczysz uczciwy komunikat „czytnik dokumentów (Gemini) jest teraz niedostępny”: na Preview nie ma klucza Gemini. Nie ma przy tym fałszywego podsumowania. Pełny odczyt z podsumowaniem i źródłem pokazują zrzuty `r3b-05…r3b-08`.
4. Dotknij **Kontynuuj bez dokumentów**, potem przykładów: **40 godzin w tygodniu** → **Nie** → **32 godziny od poniedziałku do piątku i 8 godzin w sobotę**. Loonto pyta o jedną rzecz na raz; teraz pyta o stawkę.
5. Odpowiedz **Nie wiem**. Loonto zostawia stawkę jako nieustaloną (nie wpisuje zera), nie pyta o nią w kółko i przechodzi do dodatku za sobotę.
6. Dotknij **150%**. Loonto nie zgaduje i pyta, czy to łącznie, czy ponad stawkę. Wybierz **Łącznie 150% stawki (dodatek +50%)**: zapisuje dodatek +50% jako Twoją informację.
7. Dotknij **Scenariusz**: widać Twoje wartości z oznaczeniem źródła, „Wynik jeszcze niedostępny” bez żadnej kwoty i „Analizator w przygotowaniu”. **Zacznij od nowa** czyści wszystko.
8. (Opcjonalnie) Zrzuty `r3b-10…r3b-13` pokazują rozbieżność umowa €17,20 / pasek €16,80 i aneks od 01.09.2026 bez fałszywej rozbieżności.

---
**`R3-B DOCUMENT-FIRST VERTICAL SLICE IMPLEMENTED — HOLD FOR CTO/CEO REVIEW`** — no deploy, no merge, R3-C not started.
