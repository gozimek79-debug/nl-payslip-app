/**
 * AI-001: the per-turn budget of the AI Advisor. Every limit is a hard server-side cap (configurable by environment,
 * never by the request): how many model calls one turn may make, how long each may take, how long the whole turn may
 * take, how much the model may write and how much conversation history it sees.
 */

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  return Number.isInteger(raw) && raw >= min && raw <= max ? raw : fallback;
}

export interface AdvisorBudget {
  /** Model calls in one turn, tool rounds and the one possible grounding rewrite included. */
  maxModelCalls: number;
  /** Tool calls the model may request in one round (extra calls are refused, not run). */
  maxToolCallsPerRound: number;
  /** Output tokens per model call. */
  maxOutputTokens: number;
  /** Timeout of one model call. */
  callTimeoutMs: number;
  /** Deadline of the whole turn (well inside the function limit, vercel.json maxDuration 300 s). */
  turnDeadlineMs: number;
  /** Earlier messages (user + advisor) the model sees; older ones are dropped. */
  historyMessages: number;
}

export function advisorBudget(): AdvisorBudget {
  return {
    maxModelCalls: intFromEnv('ADVISOR_MAX_MODEL_CALLS', 5, 1, 8),
    maxToolCallsPerRound: intFromEnv('ADVISOR_MAX_TOOL_CALLS_PER_ROUND', 4, 1, 8),
    maxOutputTokens: intFromEnv('ADVISOR_MAX_OUTPUT_TOKENS', 1200, 200, 4000),
    callTimeoutMs: intFromEnv('ADVISOR_CALL_TIMEOUT_MS', 30_000, 2_000, 90_000),
    turnDeadlineMs: intFromEnv('ADVISOR_TURN_DEADLINE_MS', 90_000, 5_000, 200_000),
    historyMessages: intFromEnv('ADVISOR_HISTORY_MESSAGES', 12, 2, 40),
  };
}

/** AI-001C gate: the bounded base-wage orientation tool. On unless explicitly switched off. */
export const orientationToolEnabled = () => process.env.ADVISOR_ORIENTATION_TOOL !== 'off';

export const MAX_USER_MESSAGE = 1000;
export const MAX_ADVISOR_MESSAGE_STORED = 3000;
