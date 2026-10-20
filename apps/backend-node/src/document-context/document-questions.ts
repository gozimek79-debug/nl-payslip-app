import type { DocumentTopic } from './knowledge.js';

/**
 * R3-B.2: recognises a QUESTION ABOUT THE DOCUMENT ("Jaka jest moja stawka?", "Ile faktycznie przelano?", "Co jest na
 * tym pasku?") without a model call, so the common case costs nothing and works when the model is unavailable.
 *
 * Deliberately narrow: it must look like a question, contain no number (a number is a statement or a calculation:
 * "moja stawka to 15,55", "ile dostanę za 40 godzin") and not ask about the future ("ile dostanę / zarobię"). Anything
 * else goes the normal way (deterministic interpreter, then at most one model call that may itself classify a
 * document question). The answer is built from server-held document facts only - this function never sees them.
 */

function fold(message: string): string {
  return message.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'l').toLowerCase().replace(/\s+/g, ' ').trim();
}

const QUESTION_START = /^(co|jaka|jaki|jakie|jakiej|ile|czy|dlaczego|czemu|gdzie|ktora|ktory|pokaz|powiedz|wyjasnij|podsumuj|what|whats|how|why|which|where|show|tell|explain|summari[sz]e|is|does|did|wat|hoeveel|waarom|welk|welke)\b/;
const DOCUMENT_REFERENCE = /\b(na pasku|z paska|w dokumencie|na dokumencie|w odczycie|on (the|my) (payslip|document)|in (the|my) (payslip|document)|op (de|mijn) loonstrook)\b/;
const FUTURE = /\b(dostane|dostaniesz|zarobie|zarobilbym|zarobilabym|bede|bedzie|wyjdzie|gdybym|jesli|jezeli|policz|oblicz|wylicz|would|will|if i|calculate|estimate|krijg ik|zou)\b/;

const TOPIC_PATTERNS: Array<[Exclude<DocumentTopic, 'summary'>, RegExp]> = [
  ['hourly_rate', /\b(stawk\w*|uurloon|uurtarief|hourly|rate|za godzine)\b/],
  ['hours', /\b(godzin\w*|godzine|uren|hours?)\b/],
  ['payout', /\b(przelan\w*|przelew\w*|przelal\w*|overgemaakt|wyplacon\w*|na konto|payout|paid out|transferred|uitbetaald|dostalem|dostalam|otrzymal\w*)\b/],
  ['reimbursement', /\b(reiskost\w*|dojazd\w*|zwrot\w*|reimburs\w*|travel)\b/],
  ['deductions', /\b(potrac\w*|odlicz\w*|podat\w*|inhouding\w*|deduct\w*|tax\w*|loonheffing\w*|skladk\w*|nizsz\w*|mniej|lower|less)\b/],
  ['gross', /\b(brutto|bruto|gross)\b/],
  ['net', /\b(netto|net)\b/],
  ['period', /\b(okres\w*|tydzien|tygodni\w*|period|which week|welke week)\b/],
];
const SUMMARY = /\b(co (jest|widac|widzisz|wynika|zawiera)|co na (nim|tym)|podsumuj|streszcz|what (does|is) (it|this|the|my) (say|show|contain)|what('s| is) (on|in) (it|this|the|my)|summari[sz]e|wat staat)\b/;

export function documentQuestionTopics(message: string): DocumentTopic[] {
  const text = fold(message);
  if (text.length === 0 || text.length > 300 || /\d/.test(text)) return [];
  const asks = text.includes('?') || QUESTION_START.test(text) || DOCUMENT_REFERENCE.test(text);
  if (!asks || FUTURE.test(text)) return [];
  const topics = TOPIC_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
  if (topics.length > 0) return topics;
  return SUMMARY.test(text) || DOCUMENT_REFERENCE.test(text) ? ['summary'] : [];
}
