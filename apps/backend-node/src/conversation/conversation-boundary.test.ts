import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConversationTurn } from './conversation-turn.js';
import { RATES_2026, out, readyScenario, scriptedAgent } from '../test-support/conversation-fixtures.js';

/**
 * RT-002 - the Tier A boundary, as an architectural guard over the SOURCE of the Conversation Core plus a
 * runtime check. Conversation Core reaches money only through Scenario Core (R1). It never imports the Tier
 * A engine, never names the public /api/tier-a/calculate route, never performs its own HTTP call (the one
 * network dependency is the model client inside conversation-agent.ts), and never turns a Tier A result
 * into verified provenance.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** The guard inspects CODE: documentation that names the forbidden route is fine, calling it is not. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const srcDir = path.join(here, '..', '..', 'src', 'conversation');
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ file: f, code: stripComments(readFileSync(path.join(srcDir, f), 'utf-8')) }));
const controller = stripComments(readFileSync(path.join(here, '..', '..', 'src', 'controllers', 'conversation.controller.ts'), 'utf-8'));
const importsOf = (code: string) => [...code.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)].map((m) => ({ typeOnly: Boolean(m[1]), from: m[2] as string }));

test('RT-002: the Conversation Core never imports the Tier A engine or its controller', () => {
  assert.ok(sources.length >= 8, `found ${sources.length} modules`);
  for (const { file, code } of sources) {
    for (const imp of importsOf(code)) {
      assert.ok(!/payroll-engine\/tier-a|tier-a\.controller|hour-grid/.test(imp.from), `${file} imports ${imp.from}`);
      if (/payroll-engine\//.test(imp.from)) {
        assert.ok(imp.typeOnly || imp.from.endsWith('payroll-profile.js'), `${file}: only types (or the profile resolver output type) from the engine layer - got ${imp.from}`);
      }
    }
    assert.ok(!/computeTierAResult|buildTierAPeriod|computePayslipPeriod/.test(code), `${file} references an engine entry point`);
  }
});

test('RT-002: no Conversation Core module names the Tier A route or makes its own HTTP call', () => {
  for (const { file, code } of sources) {
    assert.ok(!code.includes('/api/tier-a'), `${file} mentions /api/tier-a`);
    assert.ok(!/\bfetch\s*\(|axios|node:http|node:https|XMLHttpRequest/.test(code), `${file} performs HTTP itself`);
    if (file !== 'conversation-agent.ts') assert.ok(!/ai-service|openai|groqClient/.test(code), `${file} reaches a model client`);
  }
  // The one model dependency is the existing Groq text client, in exactly one module.
  const agent = sources.find((s) => s.file === 'conversation-agent.ts');
  assert.ok(agent && importsOf(agent.code).some((i) => i.from === '../ai-service/groq.js'));
  assert.ok(!sources.some((s) => /gemini-client|extractPayslip|extractContract/.test(s.code)), 'no document reader / Gemini in the conversation path');
});

test('RT-002: money reaches the Conversation Core only through Scenario Core (R1)', () => {
  const turn = sources.find((s) => s.file === 'conversation-turn.ts');
  assert.ok(turn);
  const froms = importsOf(turn.code).map((i) => i.from);
  assert.ok(froms.includes('../scenario/scenario-evaluate.js') && froms.includes('../scenario/scenario-public.js'));
  // The controller only borrows the shared rate lookup from the Tier A controller module - never its route.
  const tierAImport = controller.match(/import\s+\{([^}]*)\}\s+from\s+'\.\/tier-a\.controller\.js';/);
  assert.ok(tierAImport, 'the controller reuses fetchRates');
  assert.deepEqual(tierAImport[1]?.split(',').map((s) => s.trim()).filter(Boolean), ['fetchRates']);
  assert.ok(!controller.includes('/api/tier-a') && !/computeTierAResult/.test(controller));
  // There is no request field for trusted context, and the public route passes none.
  assert.ok(/trusted:\s*null/.test(controller));
  assert.ok(!/trusted\w*\s*:\s*z\./i.test(controller), 'no trusted-context field in the request schema');
});

test('RT-002 (runtime): a full turn makes no HTTP call - the engine runs in-process inside R1', async () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    throw new Error('no network');
  }) as typeof fetch;
  try {
    const r = await runConversationTurn({ scenario: readyScenario(), message: 'I now earn 18', locale: 'en' }, { agent: scriptedAgent([out('correction', [{ op: 'set', field: 'pay.hourlyRate', value: 18 }])]), rates: RATES_2026 });
    assert.equal(r.status, 'updated');
    assert.ok(r.evaluation?.status === 'computed');
    assert.deepEqual(urls, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});
