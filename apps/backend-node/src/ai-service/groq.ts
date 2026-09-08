import OpenAI from 'openai';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

export const TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'openai/gpt-oss-120b';
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
