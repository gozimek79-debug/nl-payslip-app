/**
 * AI-001 client of `POST /api/advisor/v1/turn`. The interface sends the user's words, the locale and two opaque
 * server references (conversation, document context) - never facts, values or provenance. The answer it gets back is
 * the advisor MODEL's own text; the interface adds nothing to it but chrome.
 */

export type AdvisorLocale = 'pl' | 'en';

export interface OrientationView {
  resultType: 'indicative_base_wage_only';
  hours: number;
  hourlyRate: number;
  amount: number;
  currency: 'EUR';
  hoursBasis: string;
  rateSource: string;
  excludes: string[];
}

export interface NavigationOffer {
  target: 'calculator_free' | 'calculator_pro' | 'analysis_contract' | 'analysis_payslip' | 'glossary' | 'account';
  status: 'available' | 'alpha' | 'coming_soon';
}

export interface AdvisorTurnOk {
  status: 'ok';
  conversationRef: string | null;
  memory: 'server_session' | 'unavailable';
  answer: { text: string; author: 'model' };
  meta: { provider: string; model: string; modelCalls: number; tools: Array<{ name: string; status: string }>; groundingRewrite: boolean; latencyMs: number };
  orientation: OrientationView | null;
  navigation: NavigationOffer[];
  documentStatus: 'none' | 'available' | 'expired';
}

export type AdvisorFailure =
  | 'advisor_unavailable' | 'advisor_not_configured' | 'answer_withheld' | 'conversation_invalid' | 'document_context_invalid'
  | 'rate_limited' | 'invalid' | 'timeout' | 'network' | 'server';

export interface AdvisorTurnRequest {
  message: string;
  locale: AdvisorLocale;
  conversationRef?: string;
  documentContextRef?: string;
}

export async function postAdvisorTurn(body: AdvisorTurnRequest, fetchImpl: typeof fetch, timeoutMs = 120_000): Promise<{ ok: true; result: AdvisorTurnOk } | { ok: false; reason: AdvisorFailure }> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl('/api/advisor/v1/turn', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(controller ? { signal: controller.signal } : {}) });
    let data: Record<string, unknown> = {};
    try { data = (await res.json()) as Record<string, unknown>; } catch { /* non-JSON: classified by status below */ }
    if (res.ok && data.status === 'ok' && typeof (data.answer as { text?: unknown } | undefined)?.text === 'string') return { ok: true, result: data as unknown as AdvisorTurnOk };
    if (res.status === 503) return { ok: false, reason: data.reason === 'not_configured' ? 'advisor_not_configured' : 'advisor_unavailable' };
    if (res.status === 502 && data.error_code === 'answer_withheld') return { ok: false, reason: 'answer_withheld' };
    if (res.status === 409) return { ok: false, reason: data.error_code === 'document_context_invalid' ? 'document_context_invalid' : 'conversation_invalid' };
    if (res.status === 429) return { ok: false, reason: 'rate_limited' };
    if (res.status === 400) return { ok: false, reason: 'invalid' };
    if (res.status === 504) return { ok: false, reason: 'timeout' };
    return { ok: false, reason: 'server' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Whether this host can run the advisor and read documents (`GET /api/ai/status`); null = could not tell. */
export async function fetchAvailability(fetchImpl: typeof fetch): Promise<{ advisor: boolean | null; reader: boolean | null }> {
  try {
    const res = await fetchImpl('/api/ai/status');
    if (!res.ok) return { advisor: null, reader: null };
    const data = (await res.json()) as { advisorAvailable?: unknown; visionAvailable?: unknown };
    return { advisor: typeof data.advisorAvailable === 'boolean' ? data.advisorAvailable : null, reader: typeof data.visionAvailable === 'boolean' ? data.visionAvailable : null };
  } catch {
    return { advisor: null, reader: null };
  }
}
