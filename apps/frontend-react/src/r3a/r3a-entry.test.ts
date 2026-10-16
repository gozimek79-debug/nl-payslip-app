import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isR3aDemoRequested } from './r3a-entry.ts';

/**
 * R3-A containment: the demo is reachable only through `/?r3a=1`, the existing application stays the default entry
 * point and is not touched, and the demo code makes no network call and imports nothing from payroll / backend code.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(here, file), 'utf-8');

test('R3-A entry: only exactly r3a=1 opens the demo', () => {
  assert.equal(isR3aDemoRequested('?r3a=1'), true);
  assert.equal(isR3aDemoRequested('?diag=1&r3a=1'), true);
  for (const search of ['', '?', '?r3a=0', '?r3a=true', '?r3a', '?R3A=1', '?diag=1']) assert.equal(isR3aDemoRequested(search), false, search);
});

test('R3-A entry: the existing app remains the default entry point and is not modified', () => {
  const main = read('../main.tsx');
  assert.match(main, /isR3aDemoRequested\(window\.location\.search\) \? <Suspense fallback=\{null\}><R3AConversationDemo \/><\/Suspense> : <App \/>/, 'App renders for every other URL');
  assert.match(main, /lazy\(\(\) => import\('\.\/r3a\/R3AConversationDemo\.tsx'\)/, 'the demo is loaded on demand only');
  assert.match(main, /import '\.\/styles\.css';/);
  const app = read('../App.tsx');
  assert.ok(!/r3a|R3A/.test(app), 'App.tsx does not know about R3-A');
  for (const entry of ['TierACalculator', 'ProDocuments', 'ContractAnalysis', 'AccountPage', 'TierBFlow']) assert.ok(app.includes(entry), `existing entry ${entry} still wired`);
});

test('R3-A entry: the demo makes no network call and imports nothing outside React, icons and its own files', () => {
  const files = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'));
  assert.deepEqual(files.sort(), ['R3AConversationDemo.tsx', 'r3a-copy.ts', 'r3a-demo.ts', 'r3a-entry.ts']);
  for (const file of files) {
    const source = read(file);
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', '/api/', 'EventSource']) assert.ok(!source.includes(forbidden), `${file}: ${forbidden}`);
    const imports = [...source.matchAll(/from '([^']+)'|import '([^']+)'/g)].map((m) => m[1] ?? m[2]);
    for (const specifier of imports) assert.ok(['react', 'lucide-react', './r3a-demo.ts', './r3a-copy.ts', './r3a.css'].includes(specifier as string), `${file}: imports ${specifier}`);
  }
});
