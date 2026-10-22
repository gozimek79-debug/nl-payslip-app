import { groqClient, isGroqConfigured, TEXT_MODEL } from '../ai-service/groq.js';

/**
 * AI-001: the advisor's generative model, behind a minimal provider-neutral interface. The model writes the
 * user-visible answer; it may ask for tools in between (OpenAI-compatible function calling). This is the ONLY advisor
 * module that reaches a provider - it reuses the project's existing Groq client (`ai-service/groq.ts`), no new key, no
 * client-side secret. Tests inject a recorded/scripted implementation; acceptance needs the real one.
 */

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the model produced it - parsed and validated by the tool registry, never trusted. */
  arguments: string;
}

export type AdvisorMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  messages: AdvisorMessage[];
  tools: ToolSpec[];
  /** 'none' forces a written answer (no further tool calls). */
  toolChoice: 'auto' | 'none';
  maxOutputTokens: number;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ModelResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number } | null;
}

export interface AdvisorModel {
  provider: string;
  model: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

type OpenAIMessage = Record<string, unknown>;

function toOpenAI(message: AdvisorMessage): OpenAIMessage {
  if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  if (message.role === 'assistant') {
    return {
      role: 'assistant', content: message.content ?? '',
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) } : {}),
    };
  }
  return { role: message.role, content: message.content };
}

export function createGroqAdvisorModel(): AdvisorModel {
  return {
    provider: 'groq',
    model: TEXT_MODEL,
    async complete(request) {
      const completion = await groqClient().chat.completions.create(
        {
          model: TEXT_MODEL,
          temperature: 0.3,
          max_tokens: request.maxOutputTokens,
          messages: request.messages.map(toOpenAI) as never,
          tools: request.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: request.toolChoice,
        },
        { signal: request.signal, timeout: request.timeoutMs, maxRetries: 0 },
      );
      const message = completion.choices[0]?.message;
      const toolCalls = (message?.tool_calls ?? [])
        .filter((c): c is typeof c & { type: 'function'; function: { name: string; arguments: string } } => c.type === 'function' && 'function' in c)
        .map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments ?? '{}' }));
      const usage = completion.usage ? { promptTokens: completion.usage.prompt_tokens ?? 0, completionTokens: completion.usage.completion_tokens ?? 0 } : null;
      return { content: typeof message?.content === 'string' ? message.content : null, toolCalls, usage };
    },
  };
}

/** The production advisor model, or null when no provider is configured (the advisor is then honestly unavailable). */
export function defaultAdvisorModel(): AdvisorModel | null {
  return isGroqConfigured() ? createGroqAdvisorModel() : null;
}
