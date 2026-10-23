import { moneyMentions, percentMentions, type Mention } from './grounding.js';

/**
 * AI-001 P0-2 / P0-3: the financial-claim check. Number matching (grounding.ts) proves an amount came from somewhere;
 * this check proves it is DESCRIBED as what it is. Every amount Loonto can supply is registered with its kind:
 *   - indicative_base_wage_only  the orientation tool's hours x base rate (never gross, net, payout, premium or verified)
 *   - document_reading           a figure printed on the user's document (topic, component, period) - historical, unverified
 *   - user_stated                a number the user typed
 *   - tool_value                 any other number a tool returned (scenario state, capabilities)
 *   - calculated_engine_estimate FIN-03: a figure Loonto's canonical engine computed from the stated inputs (gross,
 *                                tax, net wage, payout) - an ESTIMATE, never the employer's verified payout
 * There is no `verified_calculation` kind: nothing the advisor can say is verified, guaranteed or final.
 *
 * The answer stays the model's own text. The check reads it sentence by sentence, assigns each label cue ("netto",
 * "brutto", "dodatek", "zweryfikowane") to the nearest amount, reads sentence-level cues (a forecast "dostaniesz", a
 * historical "na pasku", an orientation "orientacyjnie"), honours negations ("to nie jest kwota netto"), and reports
 * issues. The turn then asks the model for ONE rewrite and withholds the answer if an issue remains.
 *
 * P0-3: Loonto has no verified labour-law / CAO / tax source in AI-001, so a sentence that asserts an entitlement or
 * a CAO's applicability as fact ("przysługuje Ci dodatek 50%", "you are entitled to...", "podlegasz CAO ABU") without
 * hedging it as general, nonbinding information is an issue too, as is a premium percentage no source provides.
 *
 * Bounded and deterministic: closed cue lists, no model call, no network. It can produce false positives (then the
 * model rewrites once); it is a guard rail on top of the instructions, not a substitute for them.
 */

export type ClaimKind = 'indicative_base_wage_only' | 'document_reading' | 'user_stated' | 'tool_value' | 'calculated_engine_estimate';

export interface ClaimSource {
  value: number;
  kind: ClaimKind;
  /** document_reading: the knowledge topic (hourly_rate, gross, net, payout, reimbursement, deductions, hours, period). */
  topic?: string | null;
  /** document_reading: the fact key (gross_total, wage_line_amount, net, payout, ...). */
  key?: string | null;
  /** document_reading: the wage line's component (night_premium, regular_wage, ...). */
  component?: string | null;
  /** document_reading: the period the document covers ("week 41/2026"). */
  period?: string | null;
}

export type ClaimIssueCode =
  | 'ungrounded_amount'
  | 'orientation_mislabelled'
  | 'orientation_presented_as_pay'
  | 'amount_described_as_verified'
  | 'document_amount_as_forecast'
  | 'document_amount_mislabelled'
  | 'premium_without_source'
  | 'net_forecast'
  | 'premium_percent_without_source'
  | 'unsupported_entitlement'
  | 'estimate_presented_as_certain'
  | 'calculation_mislabelled';

export interface ClaimIssue {
  code: ClaimIssueCode;
  /** The amount or percentage concerned (for the rewrite instruction; never logged). */
  value?: number;
  source?: ClaimSource;
}

// ---------------------------------------------------------------------------------------------
// Cues (PL + EN). `(?<!\p{L})` instead of \b: \b is ASCII-only and Polish words start with letters like "ś".
// ---------------------------------------------------------------------------------------------

const cue = (alternatives: string[]) => new RegExp(`(?<![\\p{L}])(?:${alternatives.join('|')})`, 'giu');
const END = '(?![\\p{L}])';

/** Net / take-home / payout wording. */
const NET_STRICT = cue([`netto${END}`, `net${END}`, `net pay`, `take[- ]home`, `na rękę`, `na reke`]);
const PAYOUT = cue([`wypłat\\p{L}*`, `do wypłaty`, `payout`, `paid out`, `na konto`, `na twoje konto`, `przelew\\p{L}*`]);
const GROSS = cue([`brutto${END}`, `gross${END}`]);
const PREMIUM = cue([`dodat\\p{L}*`, `premi\\p{L}*`, `toeslag\\p{L}*`, `surcharge\\p{L}*`, `premium\\p{L}*`, `bonus\\p{L}*`, `nadgodzin\\p{L}*`, `overtime`, `overwerk\\p{L}*`, `allowance`]);
const VERIFIED = cue([`zweryfikowan\\p{L}*`, `verified`, `gwarantowan\\p{L}*`, `guarantee\\p{L}*`, `na pewno`, `for sure`, `definitely`, `ostateczn\\p{L}*`, `final${END}`]);
/** Sentence-level: the amount is presented as what the user WILL get. */
const FORECAST = cue([
  `dostaniesz`, `zarobisz`, `otrzymasz`, `wyniesie`, `wypłacą`, `przelej\\p{L}*`, `będziesz (?:miał\\p{L}*|mieć|dostawać|zarabiać|otrzymywać)`,
  `dostał(?:byś|abyś)`, `zarobił(?:byś|abyś)`, `otrzymał(?:byś|abyś)`, `w przyszłym tygodniu`, `za ten tydzień dostaniesz`,
  `you(?:'ll| will| would) (?:get|earn|receive|be paid|take home)`, `you(?:'ll| will) have`, `next week`, `will be paid`,
  `pracodawca (?:wypłaci|przeleje|zapłaci)`, `your employer (?:will|is going to) pay`,
]);
/** Sentence-level: the figure is presented as an estimate / Loonto's calculation (FIN-03). */
const ESTIMATE = cue([
  `szacun\\p{L}*`, `szacunkow\\p{L}*`, `oszacow\\p{L}*`, `około`, `ok\\.`, `mniej więcej`, `orientacyjn\\p{L}*`, `przybliż\\p{L}*`, `wylicz\\p{L}*`, `wyliczeni\\p{L}*`,
  `według (?:loonto|wyliczenia|kalkulacji)`, `kalkulac\\p{L}*`, `wychodzi`, `wyszłoby`, `wyjdzie`, `loonto (?:liczy|wylicza|policzył\\p{L}*|szacuje)`,
  `estimat\\p{L}*`, `approximately`, `approx\\.`, `about`, `around`, `roughly`, `calculat\\p{L}*`, `comes to`, `works out`, `according to (?:loonto|the calculation)`,
]);
/** Sentence-level: the amount is a reading of a past document. */
const HISTORICAL = cue([
  `na (?:twoim |tym )?pasku`, `z paska`, `pas(?:ek|ka|ku)${END}`, `payslip\\p{L}*`, `na dokumencie`, `w dokumencie`, `dokument\\p{L}*`, `wydrukowan\\p{L}*`,
  `printed`, `odczytan\\p{L}*`, `wypłacono`, `wypłacon\\p{L}*`, `otrzymał(?:eś|aś)`, `dostał(?:eś|aś)`, `you (?:got|received|were paid)`, `was paid`, `were paid`,
  `tygodni\\p{L}* \\d+`, `tydzień \\d+`, `week \\d+`, `w okresie`, `period`, `za okres`, `ostatni\\p{L}*`, `last (?:week|month|period)`, `previous`, `poprzedni\\p{L}*`,
]);
/** Sentence-level: the orientation is called an orientation / base-rate figure. */
const ORIENTATION = cue([`orientacyjn\\p{L}*`, `indicative`, `orientation`, `podstawow\\p{L}*`, `base (?:rate|wage|pay)`, `basic (?:rate|wage|pay)`, `sam(?:a|ej) stawk\\p{L}*`, `only the base`, `godzin\\p{L}* (?:×|x|razy) stawk\\p{L}*`, `hours (?:×|x|times) (?:the )?(?:base )?rate`]);
/** A negation or exclusion shortly before a cue turns it off ("to nie jest kwota netto", "not net pay", "bez dodatków",
 * "before any weekend premiums", "przed dodatkami", "nie licząc podatku"). */
const NEGATION = /(?<![\p{L}])(?:nie|not|no|bez|without|ani|nor|neither|excluding|exclude\p{L}*|except|oprócz|poza|nie obejmuje|does not include|isn't|is not|n't|before|przed|nie licząc|not counting|apart from|w odróżnieniu od|unlike)(?![\p{L}])/iu;
const NEGATION_LOOKBACK = 32;
/** "870,80 EUR plus dodatki" adds premiums to the amount - it does not call the amount a premium. */
const ADDITIVE = /(?<![\p{L}])(?:plus|oraz|do tego|on top of|and|i|\+)(?![\p{L}])\s*(?:\p{L}+\s+){0,2}$/iu;
/** A label cue describes an amount only when it is close to it (same clause). */
const MAX_LABEL_DISTANCE = 30;

/** P0-3: entitlement / legal-certainty wording and what it would be about. */
const ENTITLEMENT = cue([
  `należ\\p{L}* (?:ci|się)`, `przysługuj\\p{L}*`, `masz prawo do`, `pracodawca (?:musi|ma obowiązek|jest zobowiązany|powinien zapłacić)`, `zgodnie z prawem`, `ustawow\\p{L}*`,
  `z mocy prawa`, `prawnie`, `gwarantuj\\p{L}*`, `zgodnie z (?:cao|układem)`, `według cao`, `cao (?:przewiduje|gwarantuje|stanowi|daje)`,
  `you(?:'re| are) entitled`, `entitled to`, `you have (?:a|the) (?:legal )?right to`, `legally`, `by law`, `your employer (?:must|has to|is required|is obliged)`,
  `required by law`, `the law (?:requires|guarantees|says)`, `under (?:the|your) cao`, `the cao (?:says|guarantees|gives|provides)`,
]);
const CAO_APPLIES = cue([`podlegasz`, `obowiązuje (?:cię|ciebie|w twojej)`, `dotyczy (?:cię|ciebie)`, `twoje cao to`, `twoim cao jest`, `your cao is`, `applies to you`, `you fall under`, `you are covered by`]);
const CAO_NAME = cue([`cao${END}`, `abu${END}`, `nbbu${END}`, `układ\\p{L}* zbiorow\\p{L}*`]);
const BENEFIT = cue([`dodat\\p{L}*`, `premi\\p{L}*`, `toeslag\\p{L}*`, `wynagrodz\\p{L}*`, `stawk\\p{L}*`, `urlop\\p{L}*`, `vakantiegeld`, `wypłat\\p{L}*`, `nadgodzin\\p{L}*`, `pay${END}`, `premium\\p{L}*`, `allowance`, `bonus\\p{L}*`, `wage\\p{L}*`, `overtime`, `holiday pay`, `€`, `euro`, `eur${END}`, `%`]);
/** General, nonbinding phrasing - allowed (P0-3 distinguishes it from an asserted entitlement). */
const HEDGE = cue([
  `zwykle`, `zazwyczaj`, `często`, `może`, `mogą`, `zależ\\p{L}*`, `sprawdź`, `sprawdzić`, `ogólnie`, `nie mogę potwierdzić`, `nie wiem`, `jeśli`, `jeżeli`, `o ile`,
  `prawdopodobnie`, `w wielu`, `niektór\\p{L}*`, `czy${END}`, `nie jest pewne`, `bez weryfikacji`, `niezweryfikowan\\p{L}*`,
  `usually`, `typically`, `often`, `may${END}`, `might`, `can vary`, `depends`, `depending`, `check`, `in general`, `generally`, `if your`, `if the`, `whether`,
  `not verified`, `cannot confirm`, `can't confirm`, `some cao\\p{L}*`, `many`,
]);

interface Hit { start: number; end: number }

function hits(re: RegExp, text: string): Hit[] {
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
}

/** "Netto nie umiem policzyć", "net is not something I can give": a negation right AFTER the cue. */
const NEGATION_AFTER = /^\s*[:,\-–—]?\s*(?:nie|not|isn't|is not|cannot|can't)(?![\p{L}])/iu;

function negated(sentence: string, hit: Hit): boolean {
  return NEGATION.test(sentence.slice(Math.max(0, hit.start - NEGATION_LOOKBACK), hit.start)) || NEGATION_AFTER.test(sentence.slice(hit.end, hit.end + 14));
}

/** Un-negated cue hits in a sentence. */
function liveHits(re: RegExp, sentence: string): Hit[] {
  return hits(re, sentence).filter((h) => !negated(sentence, h));
}

const distance = (a: Hit, b: Hit) => (a.end <= b.start ? b.start - a.end : b.end <= a.start ? a.start - b.end : 0);

/** The cues of a kind that are close to this amount, in the same clause (no ";" between) and nearer to it than to any
 * other amount of the sentence. */
function assigned(cues: Hit[], amount: Mention, all: Mention[], sentence: string): boolean {
  return cues.some((c) => {
    const mine = distance(c, amount);
    const between = sentence.slice(Math.min(c.end, amount.end), Math.max(c.start, amount.start));
    return mine <= MAX_LABEL_DISTANCE && !between.includes(';') && all.every((other) => other === amount || mine <= distance(c, other));
  });
}

/** Premium cues that are added to an amount ("plus dodatki") rather than naming it. */
function premiumLabels(sentence: string): Hit[] {
  return liveHits(PREMIUM, sentence).filter((h) => !ADDITIVE.test(sentence.slice(Math.max(0, h.start - 16), h.start)));
}

/** Sentences, keeping decimals ("870.80") and abbreviations ("pon.") intact - splits only on ". " / "! " / "? " / newlines. */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/u).map((s) => s.trim()).filter((s) => s.length > 0);
}

const near = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b)) < 0.005;
const PREMIUM_COMPONENTS = new Set(['night_premium', 'saturday_premium', 'sunday_premium', 'public_holiday_premium', 'overtime', 'shift_premium', 'adv']);
const NET_TOPICS = new Set(['net', 'payout']);
const GROSS_KEYS = new Set(['gross_total', 'wage_line_amount']);
/** Document figures that belong to a past period (a rate is reusable; a payout is not). */
const PERIOD_TOPICS = new Set(['gross', 'net', 'payout', 'reimbursement', 'deductions']);

interface AmountContext {
  estimate: boolean;
  netStrict: boolean;
  payout: boolean;
  gross: boolean;
  premium: boolean;
  verified: boolean;
  forecast: boolean;
  historical: boolean;
  orientation: boolean;
}

/** Why this source does NOT support the amount as written (empty = it does). */
function problemsFor(source: ClaimSource, c: AmountContext, sentence: string): ClaimIssueCode[] {
  const out: ClaimIssueCode[] = [];
  if (c.verified) out.push('amount_described_as_verified');
  switch (source.kind) {
    case 'indicative_base_wage_only':
      if (c.netStrict || c.payout || c.gross || c.premium) out.push('orientation_mislabelled');
      if (c.forecast && !c.orientation) out.push('orientation_presented_as_pay');
      break;
    case 'document_reading': {
      const historical = c.historical || (source.period ? sentence.toLowerCase().includes(source.period.toLowerCase()) : false);
      if (c.forecast && !historical && PERIOD_TOPICS.has(source.topic ?? '')) out.push('document_amount_as_forecast');
      if (c.netStrict && (GROSS_KEYS.has(source.key ?? '') || source.topic === 'hourly_rate')) out.push('document_amount_mislabelled');
      if (c.gross && NET_TOPICS.has(source.topic ?? '')) out.push('document_amount_mislabelled');
      if (c.premium && !PREMIUM_COMPONENTS.has(source.component ?? '') && source.key !== 'surcharge_percent') out.push('premium_without_source');
      break;
    }
    case 'user_stated':
    case 'tool_value':
      if (c.forecast && c.netStrict) out.push('net_forecast');
      break;
    case 'calculated_engine_estimate':
      // An engine figure may be what the user "will get" - as an ESTIMATE from the stated inputs, never as certain.
      if (c.forecast && !c.estimate) out.push('estimate_presented_as_certain');
      if (source.topic === 'gross' && (c.netStrict || c.payout)) out.push('calculation_mislabelled');
      if ((source.topic === 'net' || source.topic === 'payout') && c.gross) out.push('calculation_mislabelled');
      if (source.topic === 'tax' && (c.netStrict || c.gross || c.payout)) out.push('calculation_mislabelled');
      break;
  }
  return out;
}

const PRIORITY: ClaimKind[] = ['calculated_engine_estimate', 'indicative_base_wage_only', 'document_reading', 'user_stated', 'tool_value'];

/**
 * Checks a drafted answer against the registered sources. `allowedPercents` are percentages the user, a document or a
 * tool provided (a premium percentage in the answer must be one of them, or 100 more / less - "150%" read as "50% on top").
 * `supported`: for each amount that passed, the sources that support it AS WRITTEN (what later turns may build on).
 */
export function analyzeClaims(answer: string, sources: readonly ClaimSource[], allowedPercents: readonly number[]): { issues: ClaimIssue[]; supported: ClaimSource[] } {
  const issues: ClaimIssue[] = [];
  const supported: ClaimSource[] = [];
  const seen = new Set<string>();
  const add = (issue: ClaimIssue) => {
    const key = `${issue.code}:${issue.value ?? ''}`;
    if (!seen.has(key)) { seen.add(key); issues.push(issue); }
  };

  for (const sentence of sentencesOf(answer)) {
    const amounts = moneyMentions(sentence);
    const netCues = liveHits(NET_STRICT, sentence);
    const payoutCues = liveHits(PAYOUT, sentence);
    const grossCues = liveHits(GROSS, sentence);
    const premiumCues = premiumLabels(sentence);
    const anyPremium = liveHits(PREMIUM, sentence).length > 0;
    const verifiedCues = liveHits(VERIFIED, sentence);
    const forecast = liveHits(FORECAST, sentence).length > 0;
    const estimate = hits(ESTIMATE, sentence).length > 0;
    const historical = hits(HISTORICAL, sentence).length > 0;
    const orientation = hits(ORIENTATION, sentence).length > 0;

    for (const amount of amounts) {
      const matches = sources.filter((s) => near(s.value, amount.value));
      if (matches.length === 0) {
        add({ code: 'ungrounded_amount', value: amount.value });
        continue;
      }
      const context: AmountContext = {
        estimate,
        netStrict: assigned(netCues, amount, amounts, sentence), payout: assigned(payoutCues, amount, amounts, sentence), gross: assigned(grossCues, amount, amounts, sentence),
        premium: assigned(premiumCues, amount, amounts, sentence), verified: assigned(verifiedCues, amount, amounts, sentence), forecast, historical, orientation,
      };
      const evaluated = matches.map((source) => ({ source, problems: problemsFor(source, context, sentence) }));
      // An amount several sources can explain is fine if ANY of them supports it as written.
      const passing = evaluated.filter((e) => e.problems.length === 0).map((e) => e.source);
      if (passing.length > 0) {
        for (const source of passing) if (!supported.includes(source)) supported.push(source);
        continue;
      }
      evaluated.sort((a, b) => PRIORITY.indexOf(a.source.kind) - PRIORITY.indexOf(b.source.kind));
      const worst = evaluated[0] as (typeof evaluated)[number];
      for (const code of worst.problems) add({ code, value: amount.value, source: worst.source });
    }

    // A premium percentage nobody provided ("w soboty zwykle 50% dodatku").
    if (anyPremium) {
      for (const p of percentMentions(sentence)) {
        const ok = allowedPercents.some((a) => near(a, p.value) || near(a - 100, p.value) || near(a + 100, p.value));
        if (!ok) add({ code: 'premium_percent_without_source', value: p.value });
      }
    }

    // P0-3: an entitlement or a CAO's applicability asserted as fact.
    if (!sentence.endsWith('?') && hits(HEDGE, sentence).length === 0) {
      const entitlement = hits(ENTITLEMENT, sentence).length > 0 && hits(BENEFIT, sentence).length > 0;
      const caoClaim = hits(CAO_NAME, sentence).length > 0 && hits(CAO_APPLIES, sentence).length > 0;
      if (entitlement || caoClaim) add({ code: 'unsupported_entitlement' });
    }
  }
  return { issues, supported };
}

export function checkClaims(answer: string, sources: readonly ClaimSource[], allowedPercents: readonly number[]): ClaimIssue[] {
  return analyzeClaims(answer, sources, allowedPercents).issues;
}

/** The sources behind the amounts of an answer that passed the check - kept so later turns keep their kind. */
export function claimsUsed(answer: string, sources: readonly ClaimSource[]): ClaimSource[] {
  return analyzeClaims(answer, sources, sources.map((s) => s.value)).supported;
}

const money = (v: number | undefined) => (v === undefined ? '' : v.toFixed(2));

/** The ONE rewrite instruction (Loonto's check -> the model). Short, factual; the model keeps writing the answer. */
export function rewriteInstruction(issues: readonly ClaimIssue[]): string {
  const lines = new Set<string>();
  for (const i of issues) {
    const v = money(i.value);
    switch (i.code) {
      case 'ungrounded_amount': lines.add(`- ${v} EUR is not in any tool result, document fact or user message: remove it; where an amount cannot be calculated yet, say so instead of estimating.`); break;
      case 'orientation_mislabelled': lines.add(`- ${v} EUR is an indicative base-wage orientation (hours x base rate only): do not call it net, gross, payout, a premium or verified.`); break;
      case 'orientation_presented_as_pay': lines.add(`- When you give ${v} EUR, say it is an orientation (hours x base rate), not the pay the user will receive.`); break;
      case 'amount_described_as_verified': lines.add(`- Nothing in this version is verified, guaranteed or final (${v} EUR included): do not describe amounts that way.`); break;
      case 'document_amount_as_forecast': lines.add(`- ${v} EUR is a reading of the user's past document${i.source?.period ? ` (${i.source.period})` : ''}: do not present it as what the user will get; say which document or period it comes from.`); break;
      case 'document_amount_mislabelled': lines.add(`- ${v} EUR is printed on the document as ${i.source?.key ?? i.source?.topic ?? 'another item'}: describe it as that, not as net or gross.`); break;
      case 'premium_without_source': lines.add(`- No document line or rule shows ${v} EUR as a premium or bonus: do not call it one.`); break;
      case 'net_forecast': lines.add(`- Net / take-home pay cannot be forecast in this version: do not present ${v} EUR as the user's future net pay.`); break;
      case 'premium_percent_without_source': lines.add(`- No document, tool or user message gives a premium of ${i.value}%: do not state premium percentages; say it depends on the contract or CAO and ask the user if it matters.`); break;
      case 'estimate_presented_as_certain': lines.add(`- ${v} EUR is Loonto's engine ESTIMATE from the stated inputs: present it as an estimate (e.g. "about", "according to Loonto's calculation"), never as what the employer will certainly pay.`); break;
      case 'calculation_mislabelled': lines.add(`- ${v} EUR is the engine's ${i.source?.key ?? 'figure'}: call it exactly that (gross total / total tax / net wage / payout), not another figure.`); break;
      case 'unsupported_entitlement': lines.add('- Loonto has no verified labour-law, CAO or tax source in this version: give rules only as general, nonbinding information (e.g. "often", "depends on your contract or CAO"), never as an entitlement, a guarantee or the CAO that applies; suggest checking the contract or CAO.'); break;
    }
  }
  return `Loonto check - rewrite your answer, keeping it natural and in the same language:\n${[...lines].join('\n')}`;
}
