import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appEntry } from './r3b-entry.ts';

/**
 * R3-B containment: since AI-001 R3-B is the `?r3b=1` fallback (the module shell is the default again); the
 * R3-B code calls exactly the existing endpoints (reader routes via the shared adapter, profile resolve, R2 turn),
 * stores nothing but the language preference, and never renders HTML from data.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(here, file), 'utf-8');
const sources = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts') && f !== 'r3b-test-support.ts');

test('AI-001 entry: the module shell is the default at `/`; R3-B at `?r3b=1`; the previous app at `?legacy=1`', () => {
  for (const search of ['', '?', '?r3a=0', '?legacy=0', '?legacy=true', '?LEGACY=1', '?diag=1', '?r3b=0', '?r3b=true']) assert.equal(appEntry(search), 'shell', search);
  for (const search of ['?auth=success', '?auth=expired', '?auth=invalid', '?auth=error', '?auth=success&legacy=1']) assert.equal(appEntry(search), 'shell', 'the magic-link sign-in returns to the module shell');
  assert.equal(appEntry('?legacy=1'), 'legacy');
  assert.equal(appEntry('?legacy=1&diag=1'), 'legacy');
  for (const search of ['?r3b=1', '?r3a=1', '?diag=1&r3a=1', '?diag=1&r3b=1']) assert.equal(appEntry(search), 'r3b', `${search}: R3-B stays reachable (old R3-A links included)`);
  assert.equal(appEntry('?r3a=demo'), 'r3a_demo');
  const main = readFileSync(path.join(here, '..', 'main.tsx'), 'utf-8');
  assert.match(main, /entry === 'shell' \? <App \/> : entry === 'legacy' \? <App proMode="documents" \/> : entry === 'r3a_demo' \? <Suspense fallback=\{null\}><R3AConversationDemo \/><\/Suspense> : <Suspense fallback=\{null\}><R3BDocumentConversation \/><\/Suspense>/);
  assert.match(main, /lazy\(\(\) => import\('\.\/r3b\/R3BDocumentConversation\.tsx'\)/, 'loaded on demand');
  assert.ok(!/r3b|R3B/.test(readFileSync(path.join(here, '..', 'App.tsx'), 'utf-8')), 'App.tsx does not know about R3-B');
  assert.match(read('R3BDocumentConversation.tsx'), /<a href="\/\?legacy=1">\{c\.backToCurrent\}<\/a>/, 'the R3-B banner still links to the previous app');
  // Crawler hygiene only - access control is Vercel Authentication on the whole deployment.
  assert.match(readFileSync(path.join(here, '..', '..', 'index.html'), 'utf-8'), /<meta name="robots" content="noindex, nofollow"\/>/);
});

test('R3-B entry: the only network calls are the existing endpoints, through the existing helpers', () => {
  const urls = new Set<string>();
  const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const file of sources) for (const m of code(file).matchAll(/['`](\/api\/[^'`]+)['`]/g)) urls.add(m[1] as string);
  // P0: plus the existing read-only `GET /api/ai/status` - whether THIS host has a configured reader, asked before any upload.
  assert.deepEqual([...urls].sort(), ['/api/ai/status', '/api/scenario/turn'], 'R2 turn directly; profile resolve via pro-profile-prefill.ts, reader routes via document-facts-reader.ts');
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
