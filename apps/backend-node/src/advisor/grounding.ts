/**
 * AI-001 money-grounding guard. The advisor's answer is written by the model, but no money amount in it may come from
 * the model itself: every amount must be one Loonto already has - a tool result of this conversation, a document fact
 * the server holds, or a number the user typed. An amount that is none of these ("about EUR 620 net") is ungrounded:
 * the turn asks the model once to rewrite without it, and withholds the answer if it still appears (fail closed).
 *
 * What counts as an amount: a number next to a currency marker (EUR, euro, the euro sign) or a decimal with exactly two
 * fraction digits ("870,80", "1.931,95", "15.55"). Hour counts and percentages are not money and are not checked.
 */

const CURRENCY_NEAR = /(?:€|\beur\b|\beuro\w*)/i;

/** "1.931,95" / "1 931,95" / "1,931.95" / "870,80" / "870.80" / "15" -> number. */
export function parseAmountToken(token: string): number | null {
  const t = token.replace(/[\s ]/g, '');
  if (!/^\d[\d.,]*$/.test(t)) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = /,\d{1,2}$/.test(t) && (t.match(/,/g) ?? []).length === 1 ? t.replace(',', '.') : t.replace(/,/g, '');
  } else if (lastDot >= 0) {
    normalized = /\.\d{1,2}$/.test(t) && (t.match(/\./g) ?? []).length === 1 ? t : t.replace(/\./g, '');
  } else {
    normalized = t;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export interface Mention {
  value: number;
  start: number;
  end: number;
}

/** Every money-like amount written in a text (see the module comment), with its position. */
export function moneyMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const numberRe = /\d{1,3}(?:[ . ]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d+)?/g;
  for (const m of text.matchAll(numberRe)) {
    const raw = m[0];
    const start = m.index ?? 0;
    const before = text.slice(Math.max(0, start - 6), start);
    const after = text.slice(start + raw.length, start + raw.length + 7);
    // "15,55 €/h" and "€15,55" are money; "56 h" or "25%" are not.
    const nearCurrency = CURRENCY_NEAR.test(before) || CURRENCY_NEAR.test(after);
    const twoDecimals = /[.,]\d{2}$/.test(raw) && !/^\d{1,3}[.]\d{3}$/.test(raw);
    if (!nearCurrency && !twoDecimals) continue;
    if (/^\s*%/.test(after)) continue;
    // A number of hours next to an amount ("870,80 € (56 h × ...") is still hours, not money.
    if (/^\s*(?:h|godz|hours?|hrs?|uur)(?![\p{L}])/iu.test(after)) continue;
    // Part of a date or a longer token ("16.10.2026", "05-10-2026"), not an amount.
    if (/^[.\-/]\d/.test(after) || /\d[.\-/]$/.test(before)) continue;
    const value = parseAmountToken(raw);
    if (value !== null) out.push({ value, start, end: start + raw.length });
  }
  return out;
}

/** Every money-like amount written in a text (see the module comment). */
export function moneyAmountsIn(text: string): number[] {
  return moneyMentions(text).map((m) => m.value);
}

/** Every percentage written in a text ("150%", "50 %", "25 procent", "25 percent"). */
export function percentMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:%|procent\p{L}*|percent\p{L}*)/giu)) {
    const value = parseAmountToken(m[1] as string);
    if (value !== null) out.push({ value, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** Every number in a JSON-like value (tool results, document facts). */
export function numbersInValue(value: unknown, into: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersInValue(v, into));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => numbersInValue(v, into));
  return into;
}

/** Every number a person typed ("15,55", "56", "1.931,95"). */
export function numbersInText(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d{1,3}(?:[ . ]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d+)?/g)) {
    const v = parseAmountToken(m[0]);
    if (v !== null) out.push(v);
  }
  return out;
}

export function ungroundedAmounts(answer: string, allowed: readonly number[]): number[] {
  const near = (a: number) => allowed.some((b) => Math.abs(Math.abs(a) - Math.abs(b)) < 0.005);
  return [...new Set(moneyAmountsIn(answer).filter((a) => !near(a)))];
}
