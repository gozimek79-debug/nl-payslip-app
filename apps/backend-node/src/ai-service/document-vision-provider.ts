import OpenAI from 'openai';

/**
 * Stage 2c (audit "CONSOLIDATED ASSIGNMENT" v13-15): document READING - payslip extraction
 * (ocr-client.ts's extractTierCPayslip) and contract extraction (contract-client.ts's
 * extractContract) - stops being hardwired to Groq's free tier. Renamed from this round's earlier
 * tier-c-vision-provider.ts once the owner's decision ("one paid tier, one extraction quality")
 * made clear this config was never really Tier-C-specific - both document-reading paths belong on
 * the same procurement decision. The env var name (TIER_C_VISION_PROVIDER) is UNCHANGED - it is
 * already live in Vercel production, and renaming it would silently break that configuration.
 *
 * v15: models are decided. Mistral (EU-hosted) reads documents; Gemini analyses already-extracted,
 * de-identified figures (see payslip-analysis-payload.ts) and NEVER receives a document image - so
 * Gemini is deliberately not a selectable value here. This is not a placeholder gap; it is the
 * privacy boundary itself, enforced by the type system rather than by a comment someone could miss.
 * If Gemini ever needs document vision for some future reason, that is a new decision, not an
 * oversight to quietly fix by adding it back.
 */
export type DocumentVisionProviderName = 'groq' | 'mistral' | 'openai';

interface DocumentVisionProviderConfig {
  label: string;
  baseURL: string;
  apiKeyEnvVar: string;
  defaultModel: string;
  modelEnvVar: string;
  /** Sourced in the Stage 2c round, not from memory (§2.2) - see that round's report for citations. */
  euHosted: boolean;
}

const PROVIDERS: Record<DocumentVisionProviderName, DocumentVisionProviderConfig> = {
  groq: {
    label: 'Groq (free-tier Qwen vision - superseded, kept as a local-dev fallback)',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnvVar: 'GROQ_API_KEY',
    defaultModel: 'qwen/qwen3.8-27b',
    modelEnvVar: 'GROQ_VISION_MODEL',
    euHosted: false,
  },
  mistral: {
    label: 'Mistral La Plateforme (Mistral Large 3, EU-hosted) - decided reading model, v15',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-large-3',
    modelEnvVar: 'MISTRAL_VISION_MODEL',
    euHosted: true,
  },
  openai: {
    label: 'OpenAI (frontier general model, evaluated as a candidate)',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5',
    modelEnvVar: 'OPENAI_VISION_MODEL',
    euHosted: false,
  },
};

function activeProviderName(): DocumentVisionProviderName {
  const requested = process.env.TIER_C_VISION_PROVIDER as DocumentVisionProviderName | undefined;
  if (requested && requested in PROVIDERS) return requested;
  return 'mistral'; // v15: the decided reading model, now the default whenever the env var is unset
}

export function activeDocumentVisionConfig(): DocumentVisionProviderConfig & { name: DocumentVisionProviderName } {
  const name = activeProviderName();
  return { name, ...PROVIDERS[name] };
}

export function documentVisionModel(): string {
  const config = activeDocumentVisionConfig();
  return process.env[config.modelEnvVar] || config.defaultModel;
}

export function isDocumentVisionConfigured(): boolean {
  const config = activeDocumentVisionConfig();
  return Boolean(process.env[config.apiKeyEnvVar]);
}

export function documentVisionClient(): OpenAI {
  const config = activeDocumentVisionConfig();
  const apiKey = process.env[config.apiKeyEnvVar];
  if (!apiKey) throw new Error(`${config.apiKeyEnvVar} is not configured for provider "${config.name}".`);
  return new OpenAI({ apiKey, baseURL: config.baseURL });
}
