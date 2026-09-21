import OpenAI from 'openai';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';

export function isGroqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

// Stage 2h (audit v28, §2h.6): DELETED - `VISION_MODEL`, `isVisionConfigured`. Stage 2g (§2g.0f) kept
// these because `ai.controller.ts`'s `GET /api/ai/status` was still their one live caller, and
// reported the resulting staleness (this field checked GROQ_API_KEY for a "vision" model no longer
// used for reading since stage 2c moved that to Mistral). This round's own fix to that same finding
// (`readingProviderStatus()` instead) removed that last caller - grepped again to confirm: no other
// reference anywhere in the backend. `isGroqConfigured`/`groqClient`/`TEXT_MODEL` stay - `/explain`
// still uses Groq for text explanation, a genuinely different, live feature.
export function groqClient(): OpenAI {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY nie jest skonfigurowany.');
  return new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
}
