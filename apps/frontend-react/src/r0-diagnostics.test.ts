import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isDiagnosticsRequested, readDiagnosticsFlag } from './diagnostics-flag.ts';

/**
 * R0 (LOONTO-ARCHITECTURE-UX-LOCK-v1.1 §37, ZADANIE-LOONTO-R0-UX-HYGIENE): developer / S5 surfaces are hidden
 * from the normal view and shown only under `?diag=1`. The resolve/profile pipeline is untouched. The real
 * 375px page-overflow measurement is done in a browser (see RAPORT-wykonawca-R0-UX-HYGIENE.md); the CSS
 * that fixes it is asserted here.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(path.join(here, f), 'utf-8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const source = strip(read('ProDocuments.tsx'));

/** The three gated JSX blocks, in source order: each starts at `{showDiagnostics && ... && (` and ends at its balanced `)`. */
const gated = [...source.matchAll(/\{showDiagnostics && [^\r\n]*\(\r?\n/g)].map((m) => {
  let depth = 1;
  for (let i = (m.index ?? 0) + m[0].length; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(m.index, i + 1);
  }
  throw new Error('unbalanced');
});

test('R0: the flag is on only for exactly diag=1', () => {
  assert.equal(isDiagnosticsRequested(''), false);
  assert.equal(isDiagnosticsRequested('?diag=1'), true);
  assert.equal(isDiagnosticsRequested('?a=b&diag=1'), true);
  for (const off of ['?diag=0', '?diag=true', '?diag=', '?diag', '?DIAG=1', '?xdiag=1', '?diag=11']) assert.equal(isDiagnosticsRequested(off), false, off);
  assert.equal(readDiagnosticsFlag(), false, 'outside a browser (no window) it is off');
});

test('R0: the flag is read once from the URL - no env, secret, backend flag, storage or customer toggle', () => {
  assert.ok(source.includes('const [showDiagnostics] = useState(readDiagnosticsFlag);'), 'read once, as a lazy state initializer, with no setter');
  assert.equal([...source.matchAll(/showDiagnostics/g)].length, 4, 'one definition and exactly three gated surfaces');
  const flagModule = strip(read('diagnostics-flag.ts'));
  assert.ok(!/import\.meta\.env|process\.env|localStorage|sessionStorage|fetch\(|cookie/i.test(flagModule), 'URL only');
  assert.ok(!/setShowDiagnostics/.test(source), 'no customer toggle');
});

test('R0 #1/#2: the default view does not render the S5 panel, the developer profile table, the extraction table or the legacy replay', () => {
  assert.equal(gated.length, 3, 'exactly three gated blocks');
  const [panel, developer, replay] = gated as [string, string, string];
  assert.ok(panel.includes('<ProfileQuestions') && !panel.includes('pro-payroll-profile'));
  assert.ok(developer.includes('pro-effective-contract pro-payroll-profile') && developer.includes('<table>') && developer.includes('<details className="pro-extraction-table">'), 'profile table and extraction table are inside the one gated block');
  assert.ok(replay.includes('pro-developer-diagnostics pro-legacy-replay') && replay.includes('renderLegacyReplayCard(entry)'));
  // Nothing else renders them: each marker occurs only inside its gated block.
  assert.equal([...source.matchAll(/<ProfileQuestions/g)].length, 1);
  assert.equal([...source.matchAll(/<table/g)].length, 2);
  assert.equal([...source.matchAll(/pro-developer-diagnostics/g)].length, 1);
});

test('R0 #3: the diagnostic surfaces still exist unchanged (nothing deleted or rewritten)', () => {
  for (const kept of ['issues={issues}', 'readiness={readiness}', 'onApply={applyPendingDecisions}', 'onUndo={undoUserDecision}', '{profileRows.map(', '{extractionTable.map(', 'renderLegacyReplayCard(entry)', '{decisionResults.map(']) {
    assert.ok(source.includes(kept), kept);
  }
});

test('R0 #4: the resolve / profile / decision pipeline and the projection are not gated by the flag', () => {
  const pipeline = source.slice(source.indexOf('async function replayPayslip'), source.indexOf('const legacyReplayEntries'));
  assert.ok(pipeline.length > 3000);
  assert.ok(!pipeline.includes('showDiagnostics'), 'reading, resolving, decisions and prefill run identically with or without the flag');
  for (const kept of ['resolveWithDecisions(', 'decisionsRef', 'setProfile(', 'setIssues(', 'setReadiness(', 'setDecisionResults(']) assert.ok(pipeline.includes(kept), kept);
  const projection = source.slice(source.indexOf('<div className="pro-projection">'));
  assert.ok(!projection.includes('showDiagnostics') && projection.includes('<TierACalculator key={submitCount}'), 'the calculator projection is unconditional');
  assert.ok(source.includes('const contractPrefill') && source.indexOf('const contractPrefill') < source.indexOf('return (\n    <section className="flow-page">'));
});

test('R0 #5: CSS - long names wrap, the PRO calculator grid item can shrink, diagnostic tables scroll in their own container (Free calculator untouched)', () => {
  const css = strip(read('styles.css'));
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
  const body = (sel: string) => rules.find((r) => r.selector === sel)?.body ?? '';
  assert.match(body('.pro-document-name'), /overflow-wrap:anywhere/);
  assert.match(body('.pro-document-row,.pro-document-row-main'), /min-width:0/);
  assert.match(body('.pro-projection .review-grid>*'), /min-width:0/);
  assert.match(body('.pro-payroll-profile,.pro-extraction-table'), /overflow-x:auto/);
  assert.match(body('.pro-payroll-profile,.pro-extraction-table'), /max-width:100%/);
  // The shared (Free) calculator selectors are not changed by R0: every new rule is scoped to PRO classes.
  const r0 = ['.pro-document-name', '.pro-document-row,.pro-document-row-main', '.pro-projection .review-grid>*', '.pro-payroll-profile,.pro-extraction-table'];
  for (const sel of r0) assert.ok(sel.split(',').every((s) => /\.pro-/.test(s)), sel);
  assert.ok(!/\.review-grid\s*\{[^}]*min-width:0/.test(css), 'the global .review-grid rule is unchanged');
});
