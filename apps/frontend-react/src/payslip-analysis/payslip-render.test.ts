import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { analysed, payslipHarness, pdf } from './payslip-test-support.ts';

/**
 * FIN-02: the REAL Payslip Analysis screen rendered to markup (esbuild + react-dom/server), driven through its store by
 * the RECORDED real backend. Assertions are what the user reads: printed figures kept apart, "not read" never shown as
 * a zero, the payslip's own arithmetic with its difference, Loonto's comparison only when substantiated, the limits,
 * and honest failures - in Polish and English.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
type Store = ReturnType<typeof payslipHarness>['store'];
let render: (store: Store, lang: 'pl' | 'en', withAdvisor: boolean) => string;
let renderApp: () => string;
let tmp = '';

before(async () => {
  const posix = (p: string) => JSON.stringify(path.join(here, p).replace(/\\/g, '/'));
  const entry = `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PayslipAnalysis } from ${posix('PayslipAnalysis.tsx')};
import { App } from ${posix('../App.tsx')};
export const render = (store, lang, withAdvisor) => renderToStaticMarkup(createElement(PayslipAnalysis, { store, lang, ...(withAdvisor ? { onAskAdvisor: () => {} } : {}) }));
export const renderApp = () => renderToStaticMarkup(createElement(App, {}));`;
  const result = await build({
    stdin: { contents: entry, resolveDir: here, sourcefile: 'entry.mjs', loader: 'js' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'stub-browser-reader',
      setup(b) {
        b.onResolve({ filter: /local-ocr\.ts$/ }, () => ({ path: 'local-ocr', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'const no = () => { throw new Error("browser only"); }; export const renderPageImages = no, readDocumentSource = no, photoWithinBudget = no, recognizeText = no;', loader: 'js' }));
      },
    }],
  });
  tmp = mkdtempSync(path.join(tmpdir(), 'payslip-render-'));
  const file = path.join(tmp, 'bundle.mjs');
  writeFileSync(file, (result.outputFiles[0] as { text: string }).text);
  ({ render, renderApp } = (await import(pathToFileURL(file).href)) as { render: typeof render; renderApp: typeof renderApp });
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const textOf = (markup: string) => decode(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const amountBox = (markup: string, kind: string) => textOf(new RegExp(`<div class="payslip-amount[^"]*" data-amount="${kind}">([\\s\\S]*?)</div>`).exec(markup)?.[1] ?? '');

test('FIN-02 render: the first screen - one payslip, sample-only note, reading consent before any read (PL/EN)', async () => {
  const h = payslipHarness('normal');
  await h.store.checkReader();
  const pl = textOf(render(h.store, 'pl', true));
  for (const part of ['Analiza paska wypłaty', 'Wybierz pasek wypłaty', 'używaj wyłącznie pasków przykładowych', 'jeden pasek naraz']) assert.ok(pl.includes(part), part);
  assert.ok(!pl.includes('W przygotowaniu'), 'not a placeholder');
  h.store.selectFile(pdf('synthetic-payslip-week41.pdf'));
  const selected = render(h.store, 'en', true);
  const en = textOf(selected);
  for (const part of ['Payslip analysis', 'Selected file: synthetic-payslip-week41.pdf', 'Before I read', 'Google Gemini', 'Read the payslip with Gemini']) assert.ok(en.includes(part), part);
});

test('FIN-02 render: the week-41 payslip - printed figures apart, gross "not read" (not 0), payout vs net explained, NO comparison without printed tax', async () => {
  const h = await analysed('normal');
  const markup = render(h.store, 'pl', true);
  const t = textOf(markup);
  for (const part of ['Okres: week 41/2026 (05.10.2026 – 11.10.2026).', 'Stawka godzinowa (wydrukowana): €15,55/h.', 'Opłacone godziny (wydrukowane): zwykłe 36 h.', 'Odczytano jedyną stronę.']) assert.ok(t.includes(part), part);
  assert.match(amountBox(markup, 'gross'), /nie odczytano z paska — to nie znaczy 0/);
  assert.match(amountBox(markup, 'net'), /€509,92 na pasku: „Totaal netto”/);
  assert.match(amountBox(markup, 'payout'), /€584,92 na pasku: „Overgemaakt”/);
  assert.ok(t.includes('Kwota przelana różni się od netto o €75,00.'));
  assert.ok(t.includes('nie prognoza przyszłej wypłaty'));
  // Itemised view with provenance.
  for (const part of ['Loon normaal', '36 h · €559,80', 'ADV toeslag', '1,54%', 'Onb. Reiskosten', '€75,00', 'str. 1']) assert.ok(t.includes(part), part);
  // Checks: the payslip's arithmetic is fine; the comparison is withheld and the reason is named.
  assert.match(markup, /data-checks="limited"/);
  assert.ok(t.includes('Tego porównania nie pokazujemy'));
  assert.ok(t.includes('Nie udało się odczytać wydrukowanego podatku'));
  assert.ok(!/data-status="finding"|data-status="confirm"/.test(markup), 'no unsubstantiated "difference" is shown');
  assert.ok(!t.includes('€528,43'), 'Loonto\'s own net estimate is not presented');
  // Limits and the hand-off.
  for (const part of ['Czego ta analiza nie sprawdza', 'CAO', 'To nie jest porada prawna ani podatkowa.', 'Zapytaj doradcę AI o ten pasek']) assert.ok(t.includes(part), part);
});

test('FIN-02 render: a known mismatch - what was compared, the difference, possible causes, and "not proof" (EN)', async () => {
  const h = await analysed('known_mismatch');
  const markup = render(h.store, 'en', true);
  const t = textOf(markup);
  assert.match(markup, /data-issues="arithmetic"[\s\S]*data-code="net_does_not_reconcile"/);
  assert.ok(t.includes('Possible causes: a misread, an item that was not read'));
  assert.match(markup, /data-checks="substantiated"/);
  assert.match(markup, /<li data-code="table_tax_mismatch" data-status="finding">/);
  assert.match(t, /Loonto: €39\.99 · on the payslip: €30\.00 · difference: €9\.99/);
  assert.ok(t.includes('a different tax table or tax-credit setting'));
  assert.ok(t.indexOf('The comparisons below') < t.indexOf('Loonto: €39.99'), 'the rates note that says "below" sits above the list');
  assert.ok(t.includes('not proof of an error or of a legal breach'));
});

test('FIN-02 render: no mismatch - three printed totals, and Loonto\'s calculation matches within tolerance', async () => {
  const h = await analysed('no_mismatch');
  const markup = render(h.store, 'pl', true);
  const t = textOf(markup);
  for (const kind of ['gross', 'net', 'payout']) assert.doesNotMatch(amountBox(markup, kind), /nie odczytano/, kind);
  assert.ok(t.includes('Nie znaleźliśmy niezgodności w sumach'));
  assert.ok(t.includes('Wyliczenie Loonto zgadza się z wydrukowanymi kwotami w granicach tolerancji.'));
  assert.ok(!/data-status=/.test(markup));
});

test('FIN-02 render: unknown premium and partial read - named as unread, and the comparison is withheld', async () => {
  const premium = textOf(render((await analysed('unknown_premium')).store, 'pl', true));
  assert.ok(premium.includes('Nie udało się odczytać kwoty w polu "Nachttoeslag"'), 'the unread line is named by its printed label');
  assert.ok(premium.includes('Tego porównania nie pokazujemy'));
  const partialMarkup = render((await analysed('partial')).store, 'en', true);
  const partial = textOf(partialMarkup);
  assert.ok(partial.includes('Pages 2 of 2 were not read'));
  assert.match(partialMarkup, /data-code="pages_not_read"/);
});

test('FIN-02 render: no period type -> no recalculation, said plainly; facts are still shown', async () => {
  const t = textOf(render((await analysed('period_unknown')).store, 'pl', true));
  assert.ok(t.includes('nie odczytano rodzaju okresu'));
  assert.ok(t.includes('€509,92'));
});

test('FIN-02 render: failures are honest and recoverable - reader unavailable, provider error, expired reading', async () => {
  const none = payslipHarness('normal', { vision: false });
  await none.store.checkReader();
  none.store.selectFile(pdf());
  const noneMarkup = render(none.store, 'pl', true);
  assert.ok(textOf(noneMarkup).includes('czytnik (Gemini) nie jest tu skonfigurowany'));
  assert.match(noneMarkup, /<button type="button" class="payslip-read"[^>]*disabled/);
  const provider = textOf(render((await analysed('normal', { read: { status: 'error', errorCode: 'reader_provider_error' } })).store, 'en', true));
  assert.ok(provider.includes('The payslip could not be read'));
  assert.ok(provider.includes('Try reading again'));
  const expired = textOf(render((await analysed('normal', { replay: { status: 409, body: { error_code: 'document_reference_invalid' } } })).store, 'pl', true));
  assert.ok(expired.includes('Odczyt wygasł'));
  assert.ok(expired.includes('Spróbuj odczytać ponownie'));
});

test('FIN-02 render: no PRO hand-off where PRO is not the advisor (?legacy=1)', async () => {
  const t = textOf(render((await analysed('normal')).store, 'pl', false));
  assert.ok(!t.includes('Zapytaj doradcę AI'));
});

test('FIN-02 shell: the Payslips card is a live module and the route renders the real screen', () => {
  const app = readFileSync(path.join(here, '..', 'App.tsx'), 'utf-8');
  assert.match(app, /analizaModule === 'paski' && \([\s\S]*?<PayslipAnalysis lang=\{lang\}/);
  assert.doesNotMatch(app, /tier-card-disabled/, 'no module is marked "coming soon" any more');
  assert.match(app, /data-module="analysis_payslip"/);
  assert.match(app, /initialDocumentContextRef=\{advisorDocumentRef\}/, 'the hand-off passes the server reference only');
  assert.match(app, /data-module="calculator_pro" onClick=\{\(\) => \{ setAdvisorDocumentRef\(null\);/, 'opening PRO from its own card never re-attaches an earlier payslip');
  assert.ok(renderApp().length > 0);
});
