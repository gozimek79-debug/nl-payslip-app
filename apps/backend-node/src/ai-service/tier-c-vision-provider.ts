import OpenAI from 'openai';

/**
 * Stage 2c (audit "CONSOLIDATED ASSIGNMENT" v13): PRO's payslip extraction stops being hardwired to
 * Groq's free tier. The Olympia failures (§Stage 2a) were model-class, not prompt-class - no
 * instruction fixes a model that reads "AZW" as "A29" - so the fix is a procurement decision (which
 * model reads documents well) made revisable at the config layer, not another prompt patch.
 *
 * Every candidate below exposes an OpenAI-compatible chat-completions endpoint (confirmed directly
 * from each vendor's own docs this round, not assumed): Groq's own API is OpenAI-compatible by
 * design; Mistral's La Plateforme follows the OpenAI wire format (change base URL and model, no SDK
 * swap); Google's Gemini API added a documented OpenAI-compatible endpoint
 * (generativelanguage.googleapis.com/v1beta/openai); OpenAI is, definitionally, itself. One thin
 * client covers all four - selecting a candidate is an environment variable, not a rewrite.
 *
 * DeepSeek (raised by the owner, per Stage 2c's "include it or say why not") is deliberately NOT one
 * of the wired candidates this round: as of this round's research, DeepSeek's hosted vision path is
 * experimental (V4-Flash-Vision-Exp, released 2026-08-21) with a documented ~384-token-per-image
 * ceiling targeting roughly 800x800px input - built for screenshots/charts, not the resolution a
 * printed payslip's small-print tax figures need. Their main hosted V4 model accepts text only, not
 * image pixels. Worth revisiting once DeepSeek ships a production document-vision offering; not
 * worth spending one of three test slots on an experimental path this round.
 */
export type VisionProviderName = 'groq' | 'mistral' | 'openai' | 'gemini';

interface VisionProviderConfig {
  label: string;
  baseURL: string;
  apiKeyEnvVar: string;
  defaultModel: string;
  modelEnvVar: string;
  /** Sourced this round, not from memory (§2.2) - see the round's report for citations and dates. */
  euHosted: boolean;
}

const PROVIDERS: Record<VisionProviderName, VisionProviderConfig> = {
  groq: {
    label: 'Groq (current default - free-tier Qwen vision)',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnvVar: 'GROQ_API_KEY',
    defaultModel: 'qwen/qwen3.8-27b',
    modelEnvVar: 'GROQ_VISION_MODEL',
    euHosted: false,
  },
  mistral: {
    label: 'Mistral La Plateforme (Mistral Large 3, EU-hosted)',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-large-3',
    modelEnvVar: 'MISTRAL_VISION_MODEL',
    euHosted: true,
  },
  openai: {
    label: 'OpenAI (frontier general model)',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
    modelEnvVar: 'OPENAI_VISION_MODEL',
    euHosted: false,
  },
  gemini: {
    label: 'Google Gemini (OpenAI-compatible endpoint)',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.1-pro-preview',
    modelEnvVar: 'GEMINI_VISION_MODEL',
    euHosted: false,
  },
};

function activeProviderName(): VisionProviderName {
  const requested = process.env.TIER_C_VISION_PROVIDER as VisionProviderName | undefined;
  if (requested && requested in PROVIDERS) return requested;
  return 'groq'; // unchanged default until Stage 2c's live comparison picks a winner
}

export function activeTierCVisionConfig(): VisionProviderConfig & { name: VisionProviderName } {
  const name = activeProviderName();
  return { name, ...PROVIDERS[name] };
}

export function tierCVisionModel(): string {
  const config = activeTierCVisionConfig();
  return process.env[config.modelEnvVar] || config.defaultModel;
}

export function isTierCVisionConfigured(): boolean {
  const config = activeTierCVisionConfig();
  return Boolean(process.env[config.apiKeyEnvVar]);
}

export function tierCVisionClient(): OpenAI {
  const config = activeTierCVisionConfig();
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) throw new Error(`${config.apiKeyEnvVar} is not configured for provider "${config.name}".`);
  return new OpenAI({ apiKey, baseURL: config.baseURL });
}
