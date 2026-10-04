import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractPayslipFacts, extractContractFacts, geminiModel } from '../apps/backend-node/src/ai-service/gemini-client.js';
import {
  CONFIRM_HEADER, authorizeRun, loadFrozenRequests, patchProbeMatches, preflight, runAcceptance, type FrozenRequest, type RuntimeFacts,
} from '../apps/backend-node/src/p2-live/preview-acceptance.js';
import { upstashOneShotStore, type OneShotStore } from '../apps/backend-node/src/p2-live/one-shot-store.js';
import { FROZEN_REQUESTS_JSON, FROZEN_REQUESTS_SHA256 } from '../apps/backend-node/src/p2-live/frozen-requests.js';

/**
 * P2 LIVE (ZADANIE-P2-LIVE-VERCEL.md) - TEMPORARY Preview-only acceptance runner, removed after the run.
 * Not part of the Express app; reachable only behind the project's Vercel Deployment Protection.
 *   GET  -> preflight (no Gemini call, no lock): environment, key/store presence, model lock, plan, corpus hash.
 *   POST -> with the confirmation header, every gate, then the atomic one-shot lock (P2 LIVE.3), then the
 *           frozen synthetic plan once, streamed as NDJSON. A repeated/concurrent/retried POST gets 409.
 * Accepts no document input: the only documents it can send are the frozen synthetic requests.
 */

function runtimeFacts(): RuntimeFacts {
  return {
    vercelEnv: process.env.VERCEL_ENV,
    geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY),
    model: geminiModel(),
    sensitivePatchProbePresent: Boolean(process.env.P2_PATCH_PROBE),
    sensitivePatchProbeMatches: patchProbeMatches(process.env.P2_PATCH_PROBE),
    oneShotStoreConfigured: Boolean(process.env.P2_LOCK_REDIS_URL && process.env.P2_LOCK_REDIS_TOKEN),
    now: new Date(),
  };
}

/** The P2-specific lock store settings; their values go only into the adapter, never into a response. */
function oneShotStore(): OneShotStore | null {
  const url = process.env.P2_LOCK_REDIS_URL;
  const token = process.env.P2_LOCK_REDIS_TOKEN;
  return url && token ? upstashOneShotStore({ url, token }) : null;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (process.env.VERCEL_ENV !== 'preview') return reply(res, 403, { refused: 'not_preview' });
  const rt = runtimeFacts();
  let requests: FrozenRequest[];
  try {
    requests = loadFrozenRequests(FROZEN_REQUESTS_JSON, FROZEN_REQUESTS_SHA256);
  } catch {
    return reply(res, 500, { refused: 'frozen_corpus_invalid' });
  }
  if (req.method === 'GET') return reply(res, 200, preflight(rt, requests, FROZEN_REQUESTS_SHA256));
  const decision = await authorizeRun({
    rt,
    method: req.method,
    confirmation: req.headers[CONFIRM_HEADER],
    plannedCalls: requests.length,
    corpusSha256: FROZEN_REQUESTS_SHA256,
    store: oneShotStore(),
  });
  if (!decision.ok) return reply(res, decision.status, { refused: decision.refused });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  await runAcceptance(requests, {
    readPayslip: extractPayslipFacts,
    readContract: extractContractFacts,
    model: geminiModel,
    emit: (event) => { res.write(`${JSON.stringify(event)}\n`); },
  });
  res.end();
}
