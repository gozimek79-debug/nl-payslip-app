import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { fixtures, harness, pdf, readByRef, readOk } from './r3b-test-support.ts';

/**
 * R3-B: the REAL screen rendered to markup (esbuild + react-dom/server, as r3a-render.test.ts) after driving the real
 * state machine with the recorded backend. Assertions are about what the owner reads: the document offer first, the
 * test-version label, the Gemini notice, the evidence-aware summary, the honest "no result" - and never an amount.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
type Store = { getState: () => unknown; addFiles: (f: File[], t: string) => void; read: () => Promise<void>; send: (t: string) => Promise<void>; continueWithoutDocuments: () => void; setPanel: (o: boolean) => void; setLang: (l: 'pl' | 'en') => void };
let render: (store: Store) => string;
let createStore: (deps: unknown, lang: 'pl' | 'en') => Store;
let tmp = '';

before(async () => {
  const entry = `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { R3BDocumentConversation } from ${JSON.stringify(path.join(here, 'R3BDocumentConversation.tsx').replace(/\\/g, '/'))};
import { createR3BStore } from ${JSON.stringify(path.join(here, 'r3b-flow.ts').replace(/\\/g, '/'))};
export const render = (store) => renderToStaticMarkup(createElement(R3BDocumentConversation, { store }));
export const createStore = createR3BStore;`;
  const result = await build({
    stdin: { contents: entry, resolveDir: here, sourcefile: 'entry.mjs', loader: 'js' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
    // The browser-only reader (pdf.js / tesseract) is loaded lazily by the screen and never in these tests.
    plugins: [{ name: 'no-browser-reader', setup(b) { b.onResolve({ filter: /local-ocr\.ts$/ }, (args) => ({ path: args.path, external: true })); } }],
  });
  tmp = mkdtempSync(path.join(tmpdir(), 'r3b-render-'));
  const file = path.join(tmp, 'bundle.mjs');
  writeFileSync(file, (result.outputFiles[0] as { text: string }).text);
  ({ render, createStore } = (await import(pathToFileURL(file).href)) as { render: typeof render; createStore: typeof createStore });
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const textOf = (markup: string) => decode(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
/** Pay wording next to a euro amount: "netto: €1.234", "wypłata ok. €600", "payout €...". */
const PAYOUT = /(netto|net pay|wypłat\w*|do wypłaty|payout|estimated pay|brutto razem|gross total)\s*:?\s*(ok\.|około|about)?\s*€/i;
/** Any euro figure that is not an hourly rate ("€16,80/h") - R3-B shows no other money at all. */
const NON_RATE_EURO = /€\s?\d[\d.,]*(?![\d.,]*\/h)/;
const NO_FIELD_PATHS = /\b(pay|work|tax|deductions|extras)\.[a-z]/;

function assertHonest(markup: string) {
  const text = textOf(markup);
  assert.doesNotMatch(text, PAYOUT, 'never a payout');
  assert.doesNotMatch(text, NON_RATE_EURO, 'the only euro figures are hourly rates');
  assert.doesNotMatch(text, NO_FIELD_PATHS, 'no internal field paths');
  assert.ok(!markup.includes('dangerouslySetInnerHTML'));
}

test('R3-B screen: the first view offers payslip / contract / annex / continue without documents, with the test-version label', () => {
  const store = createStore(harness().deps, 'pl');
  const markup = render(store);
  const text = textOf(markup);
  for (const label of ['Dodaj pasek wypłaty', 'Dodaj umowę', 'Dodaj aneks', 'Kontynuuj bez dokumentów']) assert.ok(text.includes(label), label);
  assert.ok(text.includes('Wersja testowa — używaj wyłącznie dokumentów przykładowych, bez danych osobowych'));
  assert.ok(text.includes('Alpha R3-B'));
  assert.match(markup, /accept="application\/pdf,image\/jpeg,image\/png"/);
  assert.match(markup, /role="log"/);
  assert.ok(!text.includes('Odczytaj dokument') && !text.includes('Zanim odczytam'), 'no read action before a file is chosen');
  assert.ok(!text.includes('Pokaż przykład z dokumentem'), 'the R3-A sample-document script is not offered as a read');
  assertHonest(markup);
});

test('R3-B screen: a chosen file shows its state and the explicit Gemini read action - file names are escaped text', () => {
  const store = createStore(harness().deps, 'pl');
  store.addFiles([pdf('<img src=x onerror=alert(1)>.pdf')], 'payslip');
  const markup = render(store);
  const text = textOf(markup);
  assert.ok(!markup.includes('<img src=x'), 'no markup injection from a file name');
  assert.ok(text.includes('<img src=x onerror=alert(1)>.pdf'), 'shown as plain text');
  assert.ok(text.includes('Wybrany — jeszcze nieodczytany'));
  assert.ok(text.includes('zewnętrznego czytnika AI — Google Gemini, przetwarzanie poza UE'), 'the reader and where it processes are named');
  assert.ok(text.includes('Odczytaj dokument przez Gemini'));
  assert.ok(text.includes('Nic nie jest wysyłane, dopóki nie klikniesz przycisku poniżej'));
});

test('R3-B screen: after reading - a short summary with the source on demand, then "Co chcesz policzyć?"', async () => {
  const store = createStore(harness({ reads: { 'pasek.pdf': readOk('payslip_week33_1680') } }).deps, 'pl');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  const markup = render(store);
  const text = textOf(markup);
  assert.ok(text.includes('Pasek wypłaty 1: odczytany.'));
  assert.ok(text.includes('Co wynika z dokumentów'));
  assert.match(text, /Stawka godzinowa €16,80\/h odczyt z dokumentu — wymaga weryfikacji/);
  assert.match(text, /Wypłata co tydzień/);
  assert.match(text, /Skąd to wiem Dokument: Pasek wypłaty 1 · ID doc-1 Okres: 10\.08\.2026–16\.08\.2026 Strona 1 Zapis w dokumencie: „Uren normaal 40,00 16,80 672,00”/);
  assert.ok(text.includes('Odczyt pokazuje, co jest w dokumencie — nie potwierdza, że naliczenie jest prawidłowe.'));
  assert.ok(text.includes('Co chcesz policzyć?'));
  assert.ok(text.includes('40 godzin w tygodniu'), 'an example goal');
  assertHonest(markup);
});

test('R3-B screen: the conversation ends with "wynik jeszcze niedostępny" and the provisional reading in the scenario - no amount, no rate question', async () => {
  const store = createStore(harness({ reads: { 'pasek.pdf': readOk('payslip_week33_1680') }, turns: fixtures.turns.case1_goal_model }).deps, 'pl');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  await store.send('Ile dostanę za 40 godzin?');
  await store.send('40 godzin od poniedziałku do piątku');
  store.setPanel(true);
  const markup = render(store);
  const text = textOf(markup);
  assert.ok(text.includes('Zapisuję: zwykłe godziny pon.–pt. — 40 h (Twoja informacja).'));
  assert.ok(!text.includes('Ile wynosi Twoja stawka'), 'the rate is not asked');
  assert.ok(text.includes('Wynik jeszcze niedostępny'));
  assert.match(text, /stawka godzinowa brutto €16,80\/h Dokument — odczyt, wymaga weryfikacji/);
  assert.ok(text.includes('Wartości z dokumentów są odczytem, którego serwer jeszcze nie weryfikuje — nie liczę z nich kwoty.'));
  assert.ok(text.includes('Analizator w przygotowaniu'));
  assert.match(markup, /aria-disabled="true"/);
  assertHonest(markup);
});

test('R3-B screen: a rate conflict shows both values and their documents, and asks once', async () => {
  const store = createStore(harness({ reads: { 'umowa.pdf': readOk('contract_base_1720'), 'pasek.pdf': readOk('payslip_week33_1680') } }).deps, 'pl');
  store.addFiles([pdf('umowa.pdf')], 'contract_base');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  await store.send('40 godzin w tygodniu');
  const text = textOf(render(store));
  assert.match(text, /Stawka godzinowa dwie różne wartości — nie wybieram żadnej rozbieżność/);
  assert.ok(text.includes('€17,20/h — Umowa 1'));
  assert.ok(text.includes('€16,80/h — Pasek wypłaty 1 (10.08.2026–16.08.2026)'));
  assert.ok(text.includes('Nie wybieram żadnej z nich automatycznie. Która dotyczy tygodnia, który chcesz policzyć?'));
});

test('R3-B screen: a failed read is named with its reason - no summary, continuing without documents stays possible', async () => {
  const store = createStore(harness({ reads: { 'pasek.pdf': { status: 'error', errorCode: 'vision_unavailable' } } }).deps, 'pl');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  const text = textOf(render(store));
  assert.ok(text.includes('Pasek wypłaty 1: nie udało się odczytać — czytnik dokumentów (Gemini) jest teraz niedostępny. Niczego z niego nie przyjmuję.'));
  assert.ok(!text.includes('Co wynika z dokumentów'));
  assert.ok(text.includes('Kontynuuj bez dokumentów'));
  assert.ok(text.includes('Nie udało się odczytać'), 'the document status');
});

test('R3-B screen: printed text from a document is rendered as text, never as markup', async () => {
  const conflict = fixtures.profiles.payslip_only?.response as { profile: { employment: { hourlyRate: { sources: Array<{ printedLabel: string | null; rawValue: string | null }> } } } };
  const tampered = structuredClone(conflict);
  const src = tampered.profile.employment.hourlyRate.sources[0] as { printedLabel: string | null; rawValue: string | null };
  src.rawValue = '<script>alert(1)</script> 16,80';
  const store = createStore(harness({ reads: { 'pasek.pdf': readOk('payslip_week33_1680') }, profileOverride: () => tampered }).deps, 'pl');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  const markup = render(store);
  assert.ok(!markup.includes('<script>alert(1)</script>'));
  assert.ok(markup.includes('&lt;script&gt;alert(1)&lt;/script&gt; 16,80'));
});

test('R3-B screen: English', async () => {
  const store = createStore(harness().deps, 'en');
  const text = textOf(render(store));
  for (const label of ['Add a payslip', 'Add a contract', 'Add an annex', 'Continue without documents', 'Test version — use sample documents only, without personal data']) assert.ok(text.includes(label), label);
  store.continueWithoutDocuments();
  assert.ok(textOf(render(store)).includes('What would you like to calculate?'));
});

/** R3-B.2: figures PRINTED on the user's document may appear only inside the labelled reading blocks. */
const withoutReadings = (markup: string) => markup.replace(/<div class="r3b-doc-answer"[^>]*>[\s\S]*?<\/div>/g, ' ').replace(/<div class="r3b-printed">[\s\S]*?<\/div>/g, ' ');

test('R3-B.2 screen: document answers are labelled readings, the trusted rate shows its server source - and outside the readings no amount', async () => {
  const store = createStore(harness({ reads: { 'pasek.pdf': readByRef('payslip_week41_1555') }, turns: fixtures.turns.r3b2_document_questions }).deps, 'pl');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  for (const message of ['Jaka jest moja stawka?', 'Ile faktycznie przelano?', 'Dlaczego netto jest niższe?', 'Ile dostanę za 40 godzin?', '40 godzin od poniedziałku do piątku']) await store.send(message);
  store.setPanel(true);
  const markup = render(store);
  const text = textOf(markup);
  assert.ok(text.includes('Wydrukowane na dokumencie'), 'the summary lists the printed facts');
  assert.ok(text.includes('Na dokumencie widzę:'));
  assert.ok(text.includes('Stawka godzinowa: €15,55/h („Uurloon / Loon normaal”) — Pasek wypłaty 1, week 41/2026'));
  assert.ok(text.includes('Przelano na konto: €584,92 („Overgemaakt”) — Pasek wypłaty 1, week 41/2026'));
  assert.ok(text.includes('To odczyt z dokumentu, nie przeliczenie Loonto — wymaga weryfikacji.'));
  assert.ok(text.includes('Różnicy między brutto a netto nie wyliczam w tej wersji'));
  assert.ok(text.includes('Stawkę biorę z Twojego dokumentu: €15,55/h — nie pytam o nią ponownie.'));
  assert.ok(text.includes('Zablokowane jest wyliczenie netto dla tego wariantu (prognoza)'));
  assert.ok(text.includes('Na pasku (week 41/2026) wydrukowano netto €509,92 — to historyczny odczyt dokumentu, nie prognoza dla tego wariantu.'));
  assert.ok(text.includes('Stawka godzinowa brutto: uwzględniam odczyt z Twojego dokumentu'), 'the server-trusted value is announced in words');
  assert.ok(!text.includes('Część odpowiedzi pomijam'), 'no misleading generic note');
  assert.ok(!text.includes('Ile wynosi Twoja stawka'), 'the rate is never asked');
  assert.match(text, /stawka godzinowa brutto €15,55\/h Z dokumentu \(odczyt serwera\) — wymaga weryfikacji/);
  assert.ok(text.includes('Wynik jeszcze niedostępny'));
  assert.ok(!markup.includes(fixtures.documentRefs.context), 'the context reference is never rendered');
  assert.match(markup, /data-answer-source="document_facts"/);
  assertHonest(withoutReadings(markup));
});

test('R3-B.2 screen (EN): the same answers in English', async () => {
  const store = createStore(harness({ reads: { 'pasek.pdf': readByRef('payslip_week41_1555') }, turns: fixtures.turns.r3b2_document_questions_en }).deps, 'en');
  store.addFiles([pdf('pasek.pdf')], 'payslip');
  await store.read();
  await store.send('What is my hourly rate?');
  await store.send('How many hours was I paid?');
  const markup = render(store);
  const text = textOf(markup);
  assert.ok(text.includes('On the document I can see:'));
  assert.ok(text.includes('Hourly rate: €15.55/h („Uurloon / Loon normaal”) — Payslip 1, week 41/2026'));
  assert.ok(text.includes('Regular hours paid: 36 h („Loon normaal”)'));
  assert.ok(text.includes('This is what the document prints, not a Loonto calculation — it needs verification.'));
  assertHonest(withoutReadings(markup));
});
