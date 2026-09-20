import OpenAI from 'openai';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';
// Stage 2g (§2g.0f): kept - grepping every reference before deleting found a SECOND, live caller
// (ai.controller.ts's GET /api/ai/status, mounted and reachable) beyond the deleted
// extractPayslipFieldsFromImage(). Per 2g.0f's own instruction ("if one is live, stop and report
// it") this is reported, not deleted - see this round's report. The report also flags that this
// makes /api/ai/status's `visionAvailable` field report the wrong thing: it has checked
// GROQ_API_KEY since before stage 2c moved reading to Mistral, and nothing in the frontend calls
// this route today (grepped `apps/frontend-react/src` for "ai/status" - no matches), so the field
// is both stale and currently unread by the product.
export const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b';

export function isGroqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

export function isVisionConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY) && Boolean(VISION_MODEL);
}

export function groqClient(): OpenAI {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY nie jest skonfigurowany.');
  return new OpenAI({ apiKey, baseURL: GROQ_BASE_URL });
}
