import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { DocumentReadOutcome } from '../document-facts-reader.ts';
import type { R3BDeps } from './r3b-flow.ts';

/**
 * TEST-ONLY (R3-B): the recorded backend contract (fixtures/r3b-contract-fixtures.json, generated and re-checked
 * against the REAL reader mapping, Payroll Profile and R2 by apps/backend-node/src/conversation/r3b-document-first
 * .test.ts) and a fake network that answers ONLY requests identical to the recorded ones. Never imported by the app.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Recorded { request: unknown; response: unknown }
export interface Fixtures {
  outOfGoalFields: string[];
  technicalAsOfDate: string;
  batches: Record<string, unknown[]>;
  profiles: Record<string, Recorded>;
  turns: Record<string, Recorded[]>;
  probes: Array<{ context: string; locale: 'pl' | 'en'; message: string; question: string | null; agentStatus: string; status: string; written: string[]; next: string | null }>;
}

export const fixtures = JSON.parse(readFileSync(path.join(here, 'fixtures', 'r3b-contract-fixtures.json'), 'utf-8')) as Fixtures;

export const response = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json }) as unknown as Response;

export function readOk(fixtureId: string, coverage: { totalPages: number; notProcessedPages: number[]; reason: 'document_too_long' | 'batch_failed' | null } = { totalPages: 1, notProcessedPages: [], reason: null }): DocumentReadOutcome {
  const batches = fixtures.batches[fixtureId];
  assert.ok(batches, `fixture ${fixtureId}`);
  return { status: 'done', factBatches: structuredClone(batches), coverage };
}

export const pdf = (name: string, size = 4096, type = 'application/pdf') => new File([new Uint8Array(size)], name, { type });

export interface Harness {
  deps: R3BDeps;
  readCalls: Array<{ name: string; kind: string }>;
  resolveBodies: unknown[];
  turnBodies: Array<Record<string, unknown>>;
  remainingTurns: () => number;
}

/**
 * `reads`: what the reader adapter returns per file name. `turns`: the recorded R2 turns, answered in order, each only
 * when the interface sends exactly the recorded request. Profile requests are answered only when identical to one of
 * the recorded profile requests. Anything else fails the test.
 */
export function harness(opts: { reads?: Record<string, DocumentReadOutcome | 'throw'>; turns?: Recorded[]; profileOverride?: (body: unknown) => unknown | undefined; turnFailure?: number } = {}): Harness {
  const queue = [...(opts.turns ?? [])];
  const h: Harness = {
    readCalls: [], resolveBodies: [], turnBodies: [], remainingTurns: () => queue.length,
    deps: {
      readFacts: async (file, kind) => {
        h.readCalls.push({ name: file.name, kind });
        const outcome = opts.reads?.[file.name];
        if (outcome === 'throw') throw new Error('cannot open');
        assert.ok(outcome, `no read outcome for ${file.name}`);
        return outcome;
      },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (url === '/api/profile/resolve') {
          h.resolveBodies.push(body);
          const override = opts.profileOverride?.(body);
          if (override !== undefined) return response(200, override);
          const match = Object.values(fixtures.profiles).find((p) => isDeepStrictEqual(p.request, body));
          assert.ok(match, `unrecorded profile request: ${JSON.stringify({ ...body, documents: (body.documents as Array<Record<string, unknown>>)?.map((d) => ({ ...d, factBatches: '…' })) })}`);
          return response(200, structuredClone(match.response));
        }
        if (url === '/api/scenario/turn') {
          h.turnBodies.push(body);
          if (opts.turnFailure !== undefined && h.turnBodies.length === opts.turnFailure) return response(503, { error_code: 'tax_rates_unavailable' });
          const next = queue.shift();
          assert.ok(next, `unexpected turn request: ${JSON.stringify(body).slice(0, 400)}`);
          assert.deepEqual(body, next.request, 'the interface must send exactly the recorded request');
          return response(200, structuredClone(next.response));
        }
        throw new Error(`unexpected request to ${url}`);
      }) as unknown as typeof fetch,
      today: () => fixtures.technicalAsOfDate,
      now: () => '2026-10-18T10:00:00.000Z',
      newDecisionId: () => 'd-r3b-1',
    },
  };
  return h;
}
