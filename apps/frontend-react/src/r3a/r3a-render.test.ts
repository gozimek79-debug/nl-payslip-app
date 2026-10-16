import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { initialState, reduce, type ChoiceId, type DemoAction, type DemoState } from './r3a-demo.ts';

/**
 * R3-A: the REAL R3AConversationDemo component rendered to markup (same approach as profile-questions.render.test.ts:
 * bundled with esbuild, rendered with react-dom/server - no DOM runner in this project). Assertions are about what
 * a customer would actually read. Clicking through the live page is shown in the report's browser screenshots.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
let render: (props: { initial?: DemoState; initialLang?: 'pl' | 'en' }) => string;
let tmp = '';

before(async () => {
  const entry = `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { R3AConversationDemo } from ${JSON.stringify(path.join(here, 'R3AConversationDemo.tsx').replace(/\\/g, '/'))};
export const render = (props) => renderToStaticMarkup(createElement(R3AConversationDemo, props));`;
  const result = await build({
    stdin: { contents: entry, resolveDir: here, sourcefile: 'entry.mjs', loader: 'js' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  tmp = mkdtempSync(path.join(tmpdir(), 'r3a-render-'));
  const file = path.join(tmp, 'bundle.mjs');
  writeFileSync(file, (result.outputFiles[0] as { text: string }).text);
  ({ render } = (await import(pathToFileURL(file).href)) as { render: typeof render });
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const textOf = (markup: string) => decode(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const run = (...actions: Array<ChoiceId | DemoAction>) => actions.reduce<DemoState>((s, a) => reduce(s, typeof a === 'string' ? { type: 'choose', choice: a } : a), initialState());
/** The markup of one section marked with data-state="…" (sections do not nest each other). */
function section(markup: string, state: string): string {
  const start = markup.indexOf(`data-state="${state}"`);
  assert.ok(start >= 0, `section ${state} is rendered`);
  const open = markup.lastIndexOf('<', start);
  const tag = /^<(\w+)/.exec(markup.slice(open))?.[1] as string;
  const end = markup.indexOf(`</${tag}>`, start);
  return markup.slice(open, end + tag.length + 3);
}
const classTexts = (markup: string, cls: string) => [...markup.matchAll(new RegExp(`<span class="${cls}[^"]*">([^<]*)</span>`, 'g'))].map((m) => decode(m[1] as string));

const JOURNEYS: Record<string, DemoState> = {
  opening: initialState(),
  noDocumentDone: run('goal_40h', 'hours_weekdays', 'rate_1680', 'extras_none'),
  weekend150: run('goal_40h', 'hours_with_saturday', 'split_32_8', 'sat_150'),
  dontKnowEverything: run('goal_40h', 'hours_with_saturday', 'split_32_8', 'sat_dont_know', 'rate_dont_know', 'extras_night'),
  sampleDocument: run('sample_document', 'goal_40h', 'hours_weekdays', 'extras_none', 'why_no_result'),
  edited: reduce(run('goal_40h', 'hours_weekdays', 'rate_1680'), { type: 'edit_row', id: 'hourly_rate', raw: '17,50' }),
};

test('R3-A render: the first screen asks "Co chcesz policzyć?" - conversation first, no document required, honest demo labels', () => {
  const html = render({ initial: JOURNEYS.opening, initialLang: 'pl' });
  const text = textOf(html);
  assert.match(html, /<h1 id="r3a-title">Co chcesz policzyć\?<\/h1>/);
  assert.ok(text.includes('Możesz zacząć bez dokumentów'));
  assert.ok(text.includes('Wersja pokazowa') && text.includes('niezweryfikowanych') && text.includes('nic nie jest liczone'), 'demo banner');
  for (const chip of ['Ile dostanę za 40 godzin w tygodniu?', 'Pokaż przykład z dokumentem', 'Jak to działa?']) assert.ok(text.includes(chip), chip);
  assert.ok(text.includes('Własny tekst nie jest jeszcze analizowany'), 'the composer says free text is not interpreted');
  assert.match(html, /<label for="r3a-input"[^>]*>Twoja wiadomość<\/label>/);
  assert.match(html, /<a href="\/">Obecna wersja Loonto<\/a>/, 'the current app stays one click away');
  assert.ok(section(html, 'SCENARIO').includes('Na razie pusto'));
  assert.ok(textOf(section(html, 'RESULT')).includes('Niedostępny w wersji pokazowej'));
  assert.ok(!html.includes('type="file"'), 'no upload control in R3-A');
});

test('R3-A render: no journey ever shows a payout - the RESULT section has no amount, no currency, no "netto"/"brutto" figure', () => {
  for (const [name, state] of Object.entries(JOURNEYS)) {
    for (const lang of ['pl', 'en'] as const) {
      const html = render({ initial: state, initialLang: lang });
      const result = textOf(section(html, 'RESULT'));
      assert.ok(!result.includes('€'), `${name}/${lang}: no currency in the result`);
      assert.doesNotMatch(result, /\d+[.,]\d{2}/, `${name}/${lang}: no money-like figure in the result`);
      // payout wording followed by a figure (the rate row "Stawka godzinowa brutto €16,80/h" is an input, not a payout)
      assert.doesNotMatch(textOf(html), /(netto|net pay|wypłat\w*|payout|estimated pay)\s*:?\s*(ok\.|około|about)?\s*€?\s*\d/i, `${name}/${lang}: no payout anywhere`);
      assert.ok(/Niedostępny w wersji pokazowej|Wymaga wyjaśnienia|Not available in the preview|Needs clarification/.test(result), `${name}/${lang}: pending state`);
    }
  }
});

test('R3-A render: every scenario value carries an example / unverified source - never a verified "Dokument", CAO or rule label', () => {
  const allowed = new Set(['Twoja odpowiedź (przykład)', 'Przykładowy dokument · niezweryfikowane', 'Twoja zmiana (przykład)']);
  for (const [name, state] of Object.entries(JOURNEYS)) {
    const html = render({ initial: state, initialLang: 'pl' });
    const sources = classTexts(html, 'r3a-source');
    assert.equal(sources.length, state.rows.length, `${name}: one source per row`);
    for (const source of sources) assert.ok(allowed.has(source), `${name}: ${source}`);
    if (state.rows.length > 0) assert.ok(textOf(section(html, 'SCENARIO')).includes('Przykład · niezweryfikowane'), `${name}: scenario tagged as example`);
  }
  const doc = render({ initial: JOURNEYS.sampleDocument, initialLang: 'pl' });
  assert.ok(textOf(section(doc, 'READ')).includes('Symulacja odczytu — nic nie zostało wgrane ani przeczytane'));
  assert.ok(textOf(section(doc, 'SUMMARY')).includes('Przykład · niezweryfikowane'));
  const edited = textOf(render({ initial: JOURNEYS.edited, initialLang: 'pl' }));
  assert.ok(edited.includes('€17,50/h') && edited.includes('Twoja zmiana (przykład)') && edited.includes('wcześniej: Twoja odpowiedź (przykład)'), 'an edit keeps the earlier source visible');
});

test('R3-A render: "Nie wiem" is shown as unknown, never 0; 150% needs clarification; night allowance is unsupported; the assumption is display-only', () => {
  const unknown = render({ initial: JOURNEYS.dontKnowEverything, initialLang: 'pl' });
  const text = textOf(unknown);
  assert.ok(text.includes('nieznane') && text.includes('Nieznane — to nie znaczy 0'));
  assert.doesNotMatch(textOf(section(unknown, 'SCENARIO')), /€\s?0|\b0 h\b|\+0%/, 'no zero values');
  assert.ok(text.includes('Nieobsługiwane — nie liczone') && text.includes('nie zamienię go na dodatek weekendowy'));
  assert.ok(text.includes('Założenie Loonto — jeszcze nieaktywne') && text.includes('W tej wersji pokazowej nie jest stosowany'));
  assert.ok(!/<button[^>]*>[^<]*(Akceptuj|Przyjmij|Accept)/.test(unknown), 'no fake acceptance control');
  const p1 = render({ initial: JOURNEYS.weekend150, initialLang: 'pl' });
  assert.ok(textOf(p1).includes('150% (jak podano)'));
  assert.ok(textOf(section(p1, 'RESULT')).includes('Wymaga wyjaśnienia'));
  assert.ok(textOf(section(p1, 'RESULT')).includes('„150%” wymaga wyjaśnienia'));
});

test('R3-A render: the Analyzer is honestly unavailable and does not link anywhere', () => {
  const html = render({ initial: JOURNEYS.noDocumentDone, initialLang: 'pl' });
  assert.match(html, /<button type="button" class="r3a-analyzer-button" aria-disabled="true"[^>]*>.*Analizator w przygotowaniu<\/button>/);
  assert.ok(!/<a [^>]*>[^<]*Analizator/.test(html), 'not a link to a pretend Analyzer');
  assert.ok(textOf(html).includes('Ten przycisk jeszcze niczego nie otwiera'));
  assert.ok(textOf(render({ initial: reduce(JOURNEYS.noDocumentDone, { type: 'analyzer' }), initialLang: 'pl' })).includes('Analizator nie jest jeszcze dostępny w tej wersji'));
});

test('R3-A render: all six experience states are marked in one journey', () => {
  const html = render({ initial: JOURNEYS.sampleDocument, initialLang: 'pl' });
  for (const state of ['READ', 'SUMMARY', 'CONVERSATION', 'SCENARIO', 'RESULT', 'EXPLAIN']) assert.ok(html.includes(`data-state="${state}"`), state);
  assert.match(section(html, 'EXPLAIN'), /<details class="r3a-explain" data-state="EXPLAIN" open="">/, '"Dlaczego nie ma kwoty?" opens the explanation');
});

test('R3-A render: natural copy only - no field paths, codes or provenance terms in visible text (PL and EN)', () => {
  const fieldPath = /\b(pay|work|tax|deductions|extras)\.[a-z]/;
  const internal = ['hourlyRate', 'regularWeekdayHours', 'saturdayPremiumPercent', 'loonto_assumption', 'provenance', 'cao_rule', 'official_rule', 'user_example', 'sample_document', 'needs_clarification', 'to_classify', 'ScenarioPatch', 'undefined', 'null', 'NaN'];
  for (const [name, state] of Object.entries(JOURNEYS)) {
    for (const lang of ['pl', 'en'] as const) {
      const text = textOf(render({ initial: state, initialLang: lang }));
      for (const word of internal) assert.ok(!text.includes(word), `${name}/${lang}: "${word}"`);
      assert.doesNotMatch(text, fieldPath, `${name}/${lang}: a field path`);
    }
  }
  const en = textOf(render({ initial: JOURNEYS.opening, initialLang: 'en' }));
  assert.ok(en.includes('What would you like to calculate?') && en.includes('Analyzer in preparation') && en.includes('Preview version'));
});

test('R3-A render: accessible structure - live conversation log, labelled controls, expandable details, panel toggle state', () => {
  const html = render({ initial: JOURNEYS.noDocumentDone, initialLang: 'pl' });
  assert.match(html, /<ol class="r3a-thread" role="log" aria-live="polite" aria-label="Rozmowa \(przykład\)" data-state="CONVERSATION">/);
  assert.match(html, /<button type="button" class="r3a-panel-toggle" aria-expanded="false" aria-controls="r3a-panel">/);
  assert.match(html, /<aside id="r3a-panel" class="r3a-panel"/);
  assert.match(render({ initial: reduce(JOURNEYS.noDocumentDone, { type: 'set_panel', open: true }), initialLang: 'pl' }), /aria-expanded="true" aria-controls="r3a-panel"/);
  assert.match(html, /<button type="submit" class="r3a-send" disabled="" aria-label="Wyślij">/, 'the send button is labelled and disabled while empty');
  assert.ok(html.includes('<summary>Skąd ta wartość?</summary>'));
  for (const button of html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []) assert.ok(textOf(button).length > 0 || /aria-label="[^"]+"/.test(button), `button has a name: ${button.slice(0, 80)}`);
  assert.match(html, /<fieldset class="r3a-choices"><legend>Przykładowe odpowiedzi<\/legend>/, 'example answers are announced as examples');
});

test('R3-A render: typed text is shown escaped, exactly as typed', () => {
  const html = render({ initial: run('goal_40h', { type: 'free_text', text: '<script>alert(1)</script> 40 godzin' }), initialLang: 'pl' });
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; 40 godzin'));
  assert.ok(textOf(html).includes('nie analizuję jeszcze własnych wiadomości'));
});
