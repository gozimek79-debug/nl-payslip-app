import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alphaEntry } from './r3b-entry.ts';

/**
 * R3-B containment: reachable only through the private owner-review URLs; the existing app stays the default; the
 * R3-B code calls exactly the existing endpoints (reader routes via the shared adapter, profile resolve, R2 turn),
 * stores nothing but the language preference, and never renders HTML from data.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(here, file), 'utf-8');
const sources = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts') && f !== 'r3b-test-support.ts');

test('R3-B entry: `?r3a=1` opens R3-B, `?r3a=demo` the R3-A demo, everything else the existing app', () => {
  assert.equal(alphaEntry('?r3a=1'), 'r3b');
  assert.equal(alphaEntry('?diag=1&r3a=1'), 'r3b');
  assert.equal(alphaEntry('?r3a=demo'), 'r3a_demo');
  for (const search of ['', '?', '?r3a=0', '?r3a=true', '?r3a', '?R3A=1', '?r3a=DEMO', '?diag=1']) assert.equal(alphaEntry(search), null, search);
  const main = readFileSync(path.join(here, '..', 'main.tsx'), 'utf-8');
  assert.match(main, /lazy\(\(\) => import\('\.\/r3b\/R3BDocumentConversation\.tsx'\)/, 'loaded on demand only');
  assert.ok(!/r3b|R3B/.test(readFileSync(path.join(here, '..', 'App.tsx'), 'utf-8')), 'App.tsx does not know about R3-B');
});

test('R3-B entry: the only network calls are the existing endpoints, through the existing helpers', () => {
  const urls = new Set<string>();
  const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of sources) for (const m of code(file).matchAll(/['`](\/api\/[^'`]+)['`]/g)) urls.add(m[1] as string);
  assert.deepEqual([...urls], ['/api/scenario/turn'], 'R2 turn directly; profile resolve via pro-profile-prefill.ts, reader routes via document-facts-reader.ts');
  const fetchers = sources.filter((f) => /\bfetch\(/.test(read(f)));
  assert.deepEqual(fetchers.sort(), ['R3BDocumentConversation.tsx'], 'the browser fetch is bound once, in the screen\'s dependencies');
  for (const file of sources) {
    const source = read(file);
    for (const forbidden of ['XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource', 'dangerouslySetInnerHTML', 'innerHTML', 'sessionStorage', 'indexedDB', 'document.cookie']) assert.ok(!source.includes(forbidden), `${file}: ${forbidden}`);
  }
});

test('R3-B entry: localStorage holds the language preference only - no document, value or conversation', () => {
  const uses = sources.flatMap((f) => [...read(f).matchAll(/localStorage\.(\w+)\(([^)]*)\)/g)].map((m) => `${f}:${m[1]}(${m[2]})`));
  assert.deepEqual(uses.sort(), ['R3BDocumentConversation.tsx:getItem(LANG_KEY)', 'R3BDocumentConversation.tsx:setItem(LANG_KEY, state.lang)']);
  assert.match(read('R3BDocumentConversation.tsx'), /const LANG_KEY = 'loonto-lang';/);
});

test('R3-B entry: never a self-declared verified source - the interface writes only `source: user`', () => {
  for (const file of sources) {
    const source = read(file);
    assert.ok(!/source:\s*'(document|cao_rule|official_rule|intelligence_memory)'/.test(source), `${file} never builds a verified source`);
  }
  assert.match(read('r3b-turn.ts'), /\{ state: 'known', value, source: 'user' \}/);
});

test('R3-B entry: the R3-A demo files are untouched and the reader is reused, not copied', () => {
  assert.deepEqual(readdirSync(path.join(here, '..', 'r3a')).filter((f) => !f.endsWith('.test.ts')).sort(), ['R3AConversationDemo.tsx', 'r3a-copy.ts', 'r3a-demo.ts', 'r3a-entry.ts', 'r3a.css']);
  const all = sources.map(read).join('\n');
  assert.ok(!all.includes('planDocumentBatches'), 'batch planning only in the shared adapter');
  assert.match(read('R3BDocumentConversation.tsx'), /readDocumentFacts\(file, kind, browserReaderDeps\(await import\('\.\.\/local-ocr\.ts'\)\)\)/);
});
