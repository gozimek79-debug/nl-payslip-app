import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { advisorHarness, okTurn } from './advisor-test-support.ts';

/**
 * AI-001: the REAL module shell (App.tsx) and the REAL advisor screen rendered to markup (esbuild + react-dom/server, as
 * r3b-render.test.ts), the advisor driven through its store with a RECORDED backend. Assertions are what the owner
 * reads: all five modules with honest statuses, the advisor as PRO, the model's own text, a bounded orientation card,
 * links that never present a module in preparation as live, and an honest outage - never a substitute answer.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
type Store = ReturnType<typeof advisorHarness>['store'];
let renderApp: (props: Record<string, unknown>) => string;
let renderAdvisor: (store: Store, lang: 'pl' | 'en') => string;
let tmp = '';

before(async () => {
  const posix = (p: string) => JSON.stringify(path.join(here, p).replace(/\\/g, '/'));
  const entry = `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { App } from ${posix('../App.tsx')};
import { AdvisorPro } from ${posix('AdvisorPro.tsx')};
export const renderApp = (props) => renderToStaticMarkup(createElement(App, props));
export const renderAdvisor = (store, lang) => renderToStaticMarkup(createElement(AdvisorPro, { store, lang, onNavigate: () => {}, onOpenDocumentsPro: () => {} }));`;
  const result = await build({
    stdin: { contents: entry, resolveDir: here, sourcefile: 'entry.mjs', loader: 'js' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
    // The browser-only reader (pdf.js / tesseract) is never run here: a stub with the same exports stands in for it.
    plugins: [{
      name: 'stub-browser-reader',
      setup(b) {
        b.onResolve({ filter: /local-ocr\.ts$/ }, () => ({ path: 'local-ocr', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'const no = () => { throw new Error("browser only"); }; export const renderPageImages = no, readDocumentSource = no, photoWithinBudget = no, recognizeText = no;', loader: 'js' }));
      },
    }],
  });
  tmp = mkdtempSync(path.join(tmpdir(), 'advisor-render-'));
  const file = path.join(tmp, 'bundle.mjs');
  writeFileSync(file, (result.outputFiles[0] as { text: string }).text);
  ({ renderApp, renderAdvisor } = (await import(pathToFileURL(file).href)) as { renderApp: typeof renderApp; renderAdvisor: typeof renderAdvisor });
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;| | /g, ' ');
const textOf = (markup: string) => decode(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const buttonsText = (markup: string) => [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => textOf(m[1] as string));

test('AI-001 shell: the default app is the module shell - Free and PRO (advisor, Alpha) cards, Analysis / Dictionary / Account in the navigation', () => {
  const pl = renderApp({});
  const t = textOf(pl);
  for (const label of ['Kalkulator', 'Analiza', 'Słownik', 'Zaloguj się', 'Darmowy kalkulator', 'Bezpłatny', 'Kalkulator PRO — doradca AI', 'Alpha']) assert.ok(t.includes(label), label);
  assert.match(pl, /data-module="calculator_free"/);
  assert.match(pl, /data-module="calculator_pro"/);
  assert.match(t, /nie oblicza jeszcze wynagrodzenia brutto, netto ani podatku/, 'the PRO card promises nothing the advisor cannot do');
  assert.ok(!/nie szacunku|not an estimate/.test(t), 'the old over-promise is not on the advisor card');
  assert.ok(!/<textarea|r3a-composer|advisor-thread/.test(pl), 'not a chat-only homepage');
});

test('AI-001 shell: `?legacy=1` keeps the previous application exactly (PRO = documents screen, old card)', () => {
  const t = textOf(renderApp({ proMode: 'documents' }));
  assert.ok(t.includes('Mam umowę i paski wypłaty'));
  assert.ok(t.includes('Szybki'));
  assert.ok(!t.includes('doradca AI'));
});

test('Loonto shell: payslip analysis (FIN-02) and the glossary are live, contract analysis stays live', () => {
  const app = readFileSync(path.join(here, '..', 'App.tsx'), 'utf-8');
  assert.match(app, /analizaModule === 'paski' && \([\s\S]*?<PayslipAnalysis lang=\{lang\}/, 'payslips -> the real Payslip Analysis screen');
  assert.doesNotMatch(app, /t\.comingSoon\.title/, 'no module shows the in-preparation notice any more');
  assert.match(app, /mode === 'slownik' && \([\s\S]*?<Glossary lang=\{lang\}\/>/, 'glossary renders real component');
  assert.match(app, /analizaModule === 'umowa' && \([\s\S]*?<ContractAnalysis lang=\{lang\}\/>/);
  assert.match(app, /kalkulatorTier === 'szybki' && \([\s\S]*?<TierACalculator lang=\{lang\}/, 'the free calculator is the unchanged Tier A component');
  assert.match(app, /proMode === 'advisor'\s*\? <AdvisorPro /);
  assert.match(app, /kalkulatorTier === 'pro_documents' && \([\s\S]*?<ProDocuments /, 'the previous PRO screen stays reachable from the advisor');
});

test('AI-001 advisor: the first screen - Alpha label, privacy note, documents optional, an empty thread and an open composer', async () => {
  const h = advisorHarness([]);
  await h.store.checkAvailability();
  for (const lang of ['pl', 'en'] as const) {
    h.store.setLang(lang);
    const markup = renderAdvisor(h.store, lang);
    const t = textOf(markup);
    assert.ok(t.includes(lang === 'pl' ? 'Wersja testowa (Alpha)' : 'Test version (Alpha)'));
    assert.ok(t.includes(lang === 'pl' ? 'Nie wpisuj imienia' : 'Do not type your name'));
    assert.ok(t.includes(lang === 'pl' ? 'Dokumenty (opcjonalnie)' : 'Documents (optional)'));
    assert.match(markup, /<input id="advisor-input"(?![^>]*disabled)/, 'the composer is open');
    assert.ok(!/data-author="model"/.test(markup), 'no answer before the user asks');
    assert.match(markup, /href="\/\?r3b=1"/, 'the previous R3-B conversation stays reachable');
  }
});

test('AI-001 advisor: a conversation - the model text as written, the orientation card from the tool result, honest module links', async () => {
  const h = advisorHarness([
    okTurn('Przy 7 dniach pracujesz też w sobotę i niedzielę.\n\n- Podstawa: 56 h × 15,55 €.\n- Dodatków nie znam.', {
      conversationRef: 'c1',
      meta: { provider: 'recorded', model: 'recorded-test-model', modelCalls: 2, tools: [{ name: 'get_scenario_state', status: 'ok' }, { name: 'calculate_base_wage_orientation', status: 'ok' }], groundingRewrite: false, latencyMs: 9 },
      orientation: { resultType: 'indicative_base_wage_only', hours: 56, hourlyRate: 15.55, amount: 870.8, currency: 'EUR', hoursBasis: 'total_stated_by_user', rateSource: 'document_reading', excludes: ['weekend_night_overtime_holiday_premiums', 'holiday_pay_vakantiegeld', 'tax_loonheffing', 'deductions_pension_and_other', 'gross_and_net_pay'] },
    }),
    okTurn('Analizę umowy znajdziesz w module Analiza dokumentów. Analiza pasków jest dopiero w przygotowaniu.', {
      conversationRef: 'c2',
      navigation: [{ target: 'analysis_contract', status: 'available' }, { target: 'analysis_payslip', status: 'coming_soon' }, { target: 'glossary', status: 'coming_soon' }],
    }),
  ]);
  await h.store.checkAvailability();
  await h.store.send('Pracuję 7 dni w tygodniu, 56 godzin. Ile dostanę?');
  await h.store.send('Gdzie mogę przeanalizować umowę?');
  const markup = renderAdvisor(h.store, 'pl');
  const t = textOf(markup);
  assert.equal([...markup.matchAll(/data-author="model"/g)].length, 2);
  assert.ok(t.includes('Przy 7 dniach pracujesz też w sobotę i niedzielę.'));
  assert.match(markup, /<li>Podstawa: 56 h × 15,55 €.<\/li>/, 'bullets rendered as a list, as text');
  assert.ok(t.includes('Odpowiedź napisał model AI (recorded-test-model).'), 'authorship is visible');
  // Orientation: a bounded figure from the server tool, with what it does NOT include.
  assert.match(markup, /data-result-type="indicative_base_wage_only"/);
  assert.match(t, /56 h × 15,55 €\/h = 870,80 €/);
  for (const part of ['Orientacyjnie: tylko stawka podstawowa', 'Nie obejmuje:', 'podatku (loonheffing)', 'wynagrodzenia brutto i netto', 'nie jest to Twoja wypłata', 'odczytana z Twojego dokumentu (nie zweryfikowana)']) assert.ok(t.includes(part), part);
  assert.match(t, /Użyte narzędzia: stan rozmowy orientacja: stawka × godziny/, 'the tools used are named');
  // Navigation: a live module is a button; a module in preparation is a label, never a button.
  const buttons = buttonsText(markup);
  assert.ok(buttons.some((b) => b === 'Otwórz: Analiza umowy'));
  assert.ok(!buttons.some((b) => /Analiza pasków|Słownik/.test(b)), 'no button for a module in preparation');
  assert.match(t, /Analiza pasków wypłat · W przygotowaniu/);
  assert.match(t, /Słownik · W przygotowaniu/);
});

test('AI-001 advisor: no model on this host -> the honest outage, the composer locked, no answer, ways forward offered', async () => {
  const h = advisorHarness([], { status: { advisorAvailable: false, visionAvailable: false } });
  await h.store.checkAvailability();
  for (const lang of ['pl', 'en'] as const) {
    const markup = renderAdvisor(h.store, lang);
    const t = textOf(markup);
    assert.ok(t.includes(lang === 'pl' ? 'AI doradca jest chwilowo niedostępny' : 'The AI advisor is temporarily unavailable'));
    assert.match(markup, /data-advisor-unavailable="true"/);
    assert.match(markup, /<input id="advisor-input"[^>]*disabled/);
    assert.ok(!/data-author="model"/.test(markup));
    const buttons = buttonsText(markup);
    assert.ok(buttons.some((b) => b === (lang === 'pl' ? 'Darmowy kalkulator' : 'Free calculator')), 'the free calculator does not need AI');
    assert.ok(t.includes(lang === 'pl' ? 'czytnik (Gemini) nie jest tu skonfigurowany' : 'the reader (Gemini) is not configured here'));
  }
});

test('AI-001 advisor: a model failure mid-conversation -> the notice and a retry, never a made-up reply', async () => {
  const h = advisorHarness([okTurn('Pierwsza odpowiedź modelu.'), { status: 503, body: { error_code: 'advisor_unavailable', reason: 'timeout' } }]);
  await h.store.checkAvailability();
  await h.store.send('hej');
  await h.store.send('a dalej?');
  const markup = renderAdvisor(h.store, 'pl');
  assert.equal([...markup.matchAll(/data-author="model"/g)].length, 1);
  assert.match(markup, /data-failure="advisor_unavailable"/);
  assert.ok(textOf(markup).includes('AI doradca jest chwilowo niedostępny. Spróbuj ponownie za chwilę.'));
  assert.ok(buttonsText(markup).includes('Spróbuj ponownie'));
});
