import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractPayslipFacts, extractContractFacts, geminiModel } from '../apps/backend-node/src/ai-service/gemini-client.js';
import {
  CONFIRM_HEADER, CONFIRM_VALUE, gate, loadFrozenRequests, preflight, runAcceptance, type FrozenRequest, type RuntimeFacts,
} from '../apps/backend-node/src/p2-live/preview-acceptance.js';
import { FROZEN_REQUESTS_JSON, FROZEN_REQUESTS_SHA256 } from '../apps/backend-node/src/p2-live/frozen-requests.js';

/**
 * P2 LIVE (ZADANIE-P2-LIVE-VERCEL.md) - TEMPORARY Preview-only acceptance runner, removed after the run.
 * Not part of the Express app; reachable only behind the project's Vercel Deployment Protection.
 *   GET  -> preflight (no Gemini call): environment, key presence, model lock, plan, budget, corpus hash.
 *   POST -> with the confirmation header, runs the frozen synthetic plan once and streams NDJSON events.
 * Accepts no document input: the only documents it can send are the frozen synthetic requests.
 */

function runtimeFacts(): RuntimeFacts {
  return {
    vercelEnv: process.env.VERCEL_ENV,
    geminiKeyPresent: Boolean(process.env.GEMINI_API_KEY),
    model: geminiModel(),
    sensitivePatchProbePresent: Boolean(process.env.P2_PATCH_PROBE),
    now: new Date(),
  };
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
  if (req.method !== 'POST') return reply(res, 405, { refused: 'method_not_allowed' });
  if (req.headers[CONFIRM_HEADER] !== CONFIRM_VALUE) return reply(res, 400, { refused: 'confirmation_missing' });
  const refusal = gate(rt, requests.length);
  if (refusal) return reply(res, 412, { refused: refusal });

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
