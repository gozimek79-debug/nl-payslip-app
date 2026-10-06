import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { ProfileQuestionsProps } from './ProfileQuestions.tsx';
import type { ProfileIssueView } from './pro-profile-prefill.ts';
import { translations } from './translations.ts';

/**
 * P3.1 S5 (ZADANIE-P3.1-S5-RESOLUTION-UI.md §28-§31): the REAL ProfileQuestions component, rendered to
 * markup. This project has no DOM runner, so the component is bundled with esbuild (already in the tree
 * through Vite) and rendered with react-dom/server - assertions are about actual output, not source
 * text. Issue payloads are REAL S4 output captured from the backend (pro-profile-questions.fixtures.json):
 * A2 sources_disagree, A3a payslip_period_unplaceable, A4 later_document_unclear, overtime, stale, resolved.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
type Fixture = { issues: ProfileIssueView[]; readiness: ProfileQuestionsProps['readiness'] };
const F = JSON.parse(readFileSync(path.join(here, 'pro-profile-questions.fixtures.json'), 'utf-8')) as {
  a2: Fixture; a3a: Fixture; a4: Fixture; rich: Fixture;
  stale: Record<'confirmMatching' | 'correction' | 'confirmGone' | 'confirmNotCandidate', { issue: ProfileIssueView }>;
  resolved: Fixture & { profile: unknown };
};

let render: (props: ProfileQuestionsProps) => string;
let tmp = '';

before(async () => {
  const entry = `import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ProfileQuestions } from ${JSON.stringify(path.join(here, 'ProfileQuestions.tsx').replace(/\\/g, '/'))};
export const render = (props) => renderToStaticMarkup(createElement(ProfileQuestions, props));`;
  const result = await build({
    stdin: { contents: entry, resolveDir: here, sourcefile: 'entry.mjs', loader: 'js' },
    bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', logLevel: 'silent',
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  tmp = mkdtempSync(path.join(tmpdir(), 'pq-render-'));
  const file = path.join(tmp, 'bundle.mjs');
  writeFileSync(file, (result.outputFiles[0] as { text: string }).text);
  ({ render } = (await import(pathToFileURL(file).href)) as { render: typeof render });
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const noop = () => undefined;
function props(overrides: Partial<ProfileQuestionsProps> = {}): ProfileQuestionsProps {
  return {
    lang: 'pl', issues: [], readiness: null, pending: {}, resolved: [], problems: {}, busy: false,
    onChooseCandidate: noop, onManualChange: noop, onSkip: noop, onUseSuggestion: noop, onApply: noop, onUndo: noop, ...overrides,
  };
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const textOf = (markup: string) => decode(markup.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const count = (haystack: string, needle: RegExp | string) => (typeof needle === 'string' ? haystack.split(needle).length - 1 : (haystack.match(needle) ?? []).length);
const cards = (markup: string) => markup.split('<li class="pq-card"').slice(1);
const withIssue = (issue: ProfileIssueView, patch: Partial<ProfileIssueView>): ProfileIssueView => ({ ...issue, ...patch });
const rate = (fx: Fixture) => fx.issues.find((i) => i.fieldPath === 'employment.hourlyRate') as ProfileIssueView;

/** Everything a backend payload carries that must never be user-facing text. */
const RAW_CODES = [
  'sources_disagree', 'timeline_disagreement', 'annex_effective_date_disputed', 'payslip_period_unplaceable', 'later_document_unclear', 'no_evidence_source',
  'no_documents', 'no_contract_document', 'no_payslip_document', 'not_in_contract_extraction', 'not_on_payslips', 'not_on_documents', 'only_excluded_evidence',
  'no_weekday_evidence', 'not_a_separate_extraction_field', 'tier_identity_not_evidenced',
  'annex_effective_date_missing', 'amount_unreadable', 'percent_semantics_ambiguous', 'percent_not_printed', 'period_type_unconfirmed', 'not_a_forward_rate',
  'multiple_employers_on_payslip', 'ambiguous_on_document', 'implausible_value', 'adds_hours_unclear', 'superseded_by_later_document', 'outside_as_of_regime',
  'pay_period_straddles_change', 'reader_marked_ambiguous', 'observed_premium', 'superseded_value', 'unplaceable_matching_value', 'excluded_value',
  'document_exact', 'corroborated', 'user_confirmed', 'user_corrected', 'confirm_candidate', 'correct_value', 'select_candidate', 'enter_value', 'leave_unresolved',
  'fieldPath', 'employment.', 'payroll.', 'recurringItems.', 'contractual', 'employer_applied', 'blocking', 'informational', 'eur_per_hour', 'premium_percent',
];
function assertNoRawCodes(markup: string, issues: readonly ProfileIssueView[], where: string): void {
  // `class="…"` attributes legitimately carry css names (pq-severity-blocking); everything else is content.
  const withoutClasses = markup.replace(/ class="[^"]*"/g, '');
  const visible = withoutClasses.replace(/ (?:value|name|id|for|aria-[a-z]+)="[^"]*"/g, ' ');
  for (const code of RAW_CODES) assert.ok(!visible.includes(code), `${where}: raw code "${code}" leaked into the markup`);
  for (const issue of issues) {
    assert.ok(!markup.includes(issue.fieldPath), `${where}: field path ${issue.fieldPath} leaked`);
    assert.ok(!markup.includes(issue.evidenceFingerprint), `${where}: evidence fingerprint leaked`);
    assert.ok(!visible.includes(issue.meaning), `${where}: meaning code ${issue.meaning} leaked`);
  }
}

// ---------------------------------------------------------------------------------------------
// Canonical #36 - card content for A2 / A3a / A4
// ---------------------------------------------------------------------------------------------

test('S5 #36 (A2 sources_disagree): translated label and reason, candidate values, basis tags and source chips - no raw code', () => {
  const issues = F.a2.issues;
  const pl = render(props({ lang: 'pl', issues, readiness: F.a2.readiness }));
  const plText = textOf(pl);
  assert.ok(plText.includes('Do uzupełnienia'));
  assert.ok(plText.includes('Stawka godzinowa brutto'), 'translated field label');
  assert.ok(plText.includes('Dokumenty pokazują różne wartości dla tego parametru.'), 'translated reason (spec wording)');
  assert.ok(plText.includes('16,80') && plText.includes('16,20'), 'both candidate values, formatted');
  assert.ok(plText.includes('/ godz.'), 'unit');
  assert.ok(plText.includes('Umowa / aneks') && plText.includes('Zastosowane przez pracodawcę'), 'basis tags');
  assert.ok(plText.includes('aneks.pdf · Aneks od 01.09.2026'), 'annex chip with its effective date');
  assert.ok(plText.includes('pasek-wrzesien.pdf · Pasek: 07.09.2026 – 13.09.2026'), 'payslip chip with its pay period');
  assert.ok(plText.includes('Wymagane do obliczenia'), 'human-readable severity');
  assertNoRawCodes(pl, issues, 'pl');
  const en = textOf(render(props({ lang: 'en', issues, readiness: F.a2.readiness })));
  assert.ok(en.includes('To resolve') && en.includes('Gross hourly rate') && en.includes('The documents show different values for this parameter.'));
  assert.ok(en.includes('Annex from 2026-09-01') && en.includes('Payslip: 2026-09-07 – 2026-09-13') && en.includes('Contract / annex') && en.includes('Applied by employer') && en.includes('Required for the calculation'));
});

test('S5 #36 (A3a payslip_period_unplaceable): the translated reason and the unknown-period chip on the undated payslip', () => {
  const issues = F.a3a.issues;
  const pl = render(props({ lang: 'pl', issues, readiness: F.a3a.readiness }));
  const plText = textOf(pl);
  assert.ok(plText.includes('Nie można ustalić, do którego okresu umowy należy ten pasek wynagrodzenia.'));
  assert.ok(plText.includes('pasek-bez-daty.pdf · Pasek') && plText.includes('Okres nieznany'), 'unknown-period chip');
  assert.equal(count(pl, 'Okres nieznany'), 1, 'exactly the one undated payslip');
  assert.ok(plText.includes('Aneks od 01.09.2026'));
  assertNoRawCodes(pl, issues, 'pl');
  const en = textOf(render(props({ lang: 'en', issues, readiness: F.a3a.readiness })));
  assert.ok(en.includes('The payslip cannot be reliably assigned to the relevant contract period.') && en.includes('Period unknown'));
});

test('S5 #36 (A4 later_document_unclear): the translated reason; the unclear annex fact is collapsed excluded evidence with a translated reason', () => {
  const issues = F.a4.issues;
  const pl = render(props({ lang: 'pl', issues, readiness: F.a4.readiness }));
  const plText = textOf(pl);
  assert.ok(plText.includes('Nowszy dokument dotyczy tego parametru, ale jego wartość nie jest wystarczająco czytelna.'));
  assert.ok(plText.includes('Pominięte dane z dokumentów (1)') && plText.includes('niejasne na dokumencie'));
  assert.ok(plText.includes('Okres rozliczeniowy paska') && plText.includes('Brak paska wypłaty, z którego można odczytać ten parametr.'), 'the unknown period type is a second, translated question');
  assertNoRawCodes(pl, issues, 'pl');
  const en = textOf(render(props({ lang: 'en', issues, readiness: F.a4.readiness })));
  assert.ok(en.includes('A newer document covers this parameter, but its value is not clear enough.') && en.includes('unclear on the document'));
});

// ---------------------------------------------------------------------------------------------
// §31 - visibility, order, identity
// ---------------------------------------------------------------------------------------------

test('S5 §31.1/31.2/32: informational issues never render; the backend order is kept', () => {
  const { issues, readiness } = F.rich;
  const informational = issues.filter((i) => i.severity === 'informational');
  assert.ok(informational.length >= 20, 'the real payload carries ~20+ informational issues');
  const pl = render(props({ issues, readiness }));
  assert.equal(cards(pl).length, issues.length - informational.length);
  assert.ok(!textOf(pl).includes('Układ zbiorowy (CAO)'), 'an informational unknown (CAO) is not a question');
  const visibleTitles = ['Próg nadgodzin (godziny dziennie)', 'Dopłata za nadgodziny, 1. próg', 'Dopłata za nadgodziny, 2. próg', 'Zastosowanie loonheffingskorting', 'Składka emerytalna pracownika', 'Pomniejszenie podstawy opodatkowania (ET) na okres', 'Stałe potrącenie netto: huisvesting'];
  const html = pl;
  const positions = visibleTitles.map((title) => html.indexOf(title));
  assert.ok(positions.every((p) => p >= 0), `all visible titles are present: ${JSON.stringify(positions)}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'rendered in exactly the backend order (blocking first, then optional) - no client re-sort');
  assert.deepEqual(issues.filter((i) => i.severity !== 'informational').map((i) => i.severity), ['blocking', 'blocking', 'blocking', 'blocking', 'optional', 'optional', 'optional']);
  // Nothing visible at all: no panel.
  assert.equal(render(props({ issues: informational, readiness })), '');
  assert.equal(render(props({ issues: [], readiness: null })), '');
});

test('S5 §31.5/31.6/31.7 (P1.1): radios are the candidates only, identified by candidateId; hints and observed premiums never become a choice', () => {
  const rich = F.rich.issues;
  const html = render(props({ issues: F.a2.issues, readiness: F.a2.readiness }));
  const a2Rate = rate(F.a2);
  for (const c of a2Rate.candidates) assert.ok(html.includes(`value="${c.candidateId}"`), 'the radio value is the candidateId');
  const card = cards(html)[0] as string;
  assert.equal(count(card, 'type="radio"'), a2Rate.candidates.length + 1, 'each candidate + the single "enter another value" radio - the 2 superseded hints add none');
  assert.ok(a2Rate.hints.length === 2 && card.includes('class="pq-hints"'), 'the hints exist, in their own collapsed block');
  // Overtime tiers: an observed premium is a hint - and the card has no candidate radio at all.
  const tiers = rich.filter((i) => i.fieldPath.startsWith('payroll.overtimeTier'));
  assert.equal(tiers.length, 2);
  for (const tier of tiers) {
    assert.deepEqual(tier.candidates, []);
    assert.deepEqual(tier.hints.map((h) => [h.kind, h.value]), [['observed_premium', 50]]);
    const tierCard = cards(render(props({ issues: [tier], readiness: F.rich.readiness })))[0] as string;
    assert.equal(count(tierCard, 'type="radio"'), 0, 'no radio: the observed premium cannot be chosen as the tier');
    assert.ok(tierCard.includes('Zaobserwowana dopłata za nadgodziny (nie wiadomo, który to próg)') && tierCard.includes('+50%'));
    assert.ok(tierCard.includes('<input id="pq-manual-0" type="number"'), 'the only way to state the tier is typing it');
    assert.ok(!tierCard.includes('checked'), 'nothing is pre-selected');
  }
});

test('S5 §31.3/31.4: Skip appears exactly where the backend offers leave_unresolved - never on a blocking issue', () => {
  const { issues, readiness } = F.rich;
  const visible = issues.filter((i) => i.severity !== 'informational');
  const html = render(props({ issues, readiness }));
  const cs = cards(html);
  visible.forEach((issue, i) => {
    assert.equal((cs[i] as string).includes('pq-skip'), issue.actions.includes('leave_unresolved'), `${issue.severity} issue ${i}`);
    if (issue.severity === 'blocking') assert.ok(!issue.actions.includes('leave_unresolved') && !(cs[i] as string).includes('Pomiń na razie'));
  });
  assert.equal(count(html, 'Pomiń na razie'), visible.filter((i) => i.severity === 'optional').length);
  // The UI follows the backend `actions`, not the severity: strip the action from an optional issue -> no Skip.
  const optional = visible.find((i) => i.severity === 'optional') as ProfileIssueView;
  assert.ok(!render(props({ issues: [withIssue(optional, { actions: ['enter_value'] })], readiness })).includes('Pomiń na razie'));
  assert.ok(render(props({ issues: [withIssue(rate(F.a2), { actions: ['select_candidate', 'enter_value', 'leave_unresolved'] })], readiness })).includes('Pomiń na razie'), 'and the reverse: it shows when the backend says so');
});

// ---------------------------------------------------------------------------------------------
// Readiness summary, Apply
// ---------------------------------------------------------------------------------------------

test('S5 §6: the readiness summary is the backend\'s - blocking wording, ready wording, counts, nothing recomputed', () => {
  const blocking = textOf(render(props({ issues: F.a2.issues, readiness: { activeGroups: ['core_pay'], ready: false, blockingCount: 1, optionalCount: 0 } })));
  assert.ok(blocking.includes('Profil wymaga uzupełnienia przed obliczeniem.') && blocking.includes('Wymagane: 1 · Opcjonalne: 0'));
  const optionalOnly = F.rich.issues.filter((i) => i.severity === 'optional');
  const ready = textOf(render(props({ issues: optionalOnly, readiness: { activeGroups: ['core_pay'], ready: true, blockingCount: 0, optionalCount: 3 } })));
  assert.ok(ready.includes('Profil jest gotowy; poniższe dane są opcjonalne.') && ready.includes('Wymagane: 0 · Opcjonalne: 3'));
  // The numbers come from `readiness`, not from the issue list: an inconsistent readiness is shown as given.
  const given = textOf(render(props({ issues: F.a2.issues, readiness: { activeGroups: ['core_pay'], ready: true, blockingCount: 0, optionalCount: 9 } })));
  assert.ok(given.includes('Profil jest gotowy') && given.includes('Opcjonalne: 9'));
  assert.ok(!textOf(render(props({ issues: F.rich.issues, readiness: F.rich.readiness }))).match(/informacyjn|informational/i), 'no informational count in normal UX');
  const en = textOf(render(props({ lang: 'en', issues: F.a2.issues, readiness: { activeGroups: ['core_pay'], ready: false, blockingCount: 1, optionalCount: 0 } })));
  assert.ok(en.includes('The profile needs input before calculation.') && en.includes('Required: 1 · Optional: 0'));
  assert.ok(render(props({ issues: F.a2.issues, readiness: null })).includes('pq-card'), 'without a readiness the cards still render, with no summary');
});

test('S5 §31.13: Apply is disabled with nothing pending (or only invalid/skipped/suggested), enabled with a valid choice, busy while applying', () => {
  const issue = rate(F.a2);
  const button = (markup: string) => (/<button type="button" class="primary"([^>]*)>([^<]*)<\/button>/.exec(markup) ?? []) as string[];
  const idle = button(render(props({ issues: F.a2.issues, readiness: F.a2.readiness })));
  assert.deepEqual([idle[1]?.includes('disabled'), idle[2]], [true, 'Zastosuj']);
  for (const pending of [{ [issue.fieldPath]: { kind: 'manual', raw: '' } }, { [issue.fieldPath]: { kind: 'manual', raw: 'abc' } }, { [issue.fieldPath]: { kind: 'skip' } }] as const) {
    assert.ok(button(render(props({ issues: F.a2.issues, pending }))) [1]?.includes('disabled'), JSON.stringify(pending));
  }
  const chosen = button(render(props({ issues: F.a2.issues, pending: { [issue.fieldPath]: { kind: 'candidate', candidateId: (issue.candidates[0] as { candidateId: string }).candidateId } } })));
  assert.equal(chosen[1]?.includes('disabled'), false, 'a valid candidate choice enables Apply');
  const manual = button(render(props({ issues: F.a2.issues, pending: { [issue.fieldPath]: { kind: 'manual', raw: '-95' } } })));
  assert.equal(manual[1]?.includes('disabled'), false, 'a typed number (even -95: the backend judges it) enables Apply');
  const busy = button(render(props({ issues: F.a2.issues, busy: true, pending: { [issue.fieldPath]: { kind: 'manual', raw: '17' } } })));
  assert.deepEqual([busy[1]?.includes('disabled'), busy[2]], [true, 'Stosowanie…']);
  assert.ok(render(props({ issues: F.a2.issues, busy: true })).includes('aria-busy="true"'));
});

// ---------------------------------------------------------------------------------------------
// §31.8-31.12 - typed manual inputs
// ---------------------------------------------------------------------------------------------

test('S5 §12/§31.8-31.12: the manual control follows issue.input - number (min/max/step), enum, boolean, date, text - and a negative amount is shown as typed', () => {
  const base = rate(F.a2);
  const manualOnly = (patch: Partial<ProfileIssueView>, pending = {}) => render(props({ issues: [withIssue(base, { candidates: [], actions: ['enter_value'], ...patch })], pending }));
  const number = manualOnly({});
  assert.ok(/<input id="pq-manual-0" type="number" inputMode="decimal" step="0.01" min="0.01" max="200" value=""/.test(number) || (number.includes('type="number"') && number.includes('step="0.01"') && number.includes('min="0.01"') && number.includes('max="200"')));
  const noMax = manualOnly({ unit: 'eur_per_period', input: { kind: 'number', min: 0, step: 0.01 } });
  assert.ok(noMax.includes('min="0"') && !/ max=/.test(noMax), 'no max attribute when the backend has none');
  // -95 is never normalised: the field shows exactly what was typed.
  const negative = manualOnly({ unit: 'eur_per_period', input: { kind: 'number', min: 0, step: 0.01 } }, { [base.fieldPath]: { kind: 'manual', raw: '-95' } });
  assert.ok(negative.includes('value="-95"') && !negative.includes('value="95"'));
  // enum: exactly the backend's values, with translated labels per language.
  const periodIssue = F.a4.issues.find((i) => i.fieldPath === 'payroll.periodType') as ProfileIssueView;
  const enumPl = render(props({ issues: [periodIssue] }));
  assert.ok(enumPl.includes('<select id="pq-manual-0"'));
  assert.deepEqual([...enumPl.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]), [['', 'Wybierz…'], ['week', 'tydzień'], ['4-weekly', '4 tygodnie'], ['month', 'miesiąc']]);
  assert.deepEqual([...render(props({ lang: 'en', issues: [periodIssue] })).matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]), ['', 'week', '4-weekly', 'month']);
  const custom = manualOnly({ unit: 'period_type', input: { kind: 'enum', enumValues: ['a', 'b'] } });
  assert.deepEqual([...custom.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]), ['', 'a', 'b'], 'the options are whatever enumValues says');
  // boolean
  const lhk = F.rich.issues.find((i) => i.fieldPath === 'payroll.loonheffingskorting') as ProfileIssueView;
  const bool = render(props({ issues: [lhk] }));
  assert.deepEqual([...bool.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]), [['', 'Wybierz…'], ['true', 'Tak'], ['false', 'Nie']]);
  assert.ok(render(props({ issues: [lhk], pending: { [lhk.fieldPath]: { kind: 'manual', raw: 'false' } } })).includes('<option value="false" selected="">Nie</option>'));
  // date and text
  assert.ok(manualOnly({ unit: 'date', input: { kind: 'date' } }).includes('type="date"'));
  const text = manualOnly({ unit: 'text', input: { kind: 'text', min: 1, max: 200 } }, { [base.fieldPath]: { kind: 'manual', raw: 'ABU' } });
  assert.ok(text.includes('type="text"') && text.includes('maxLength="200"') && text.includes('value="ABU"'));
});

// ---------------------------------------------------------------------------------------------
// Pending choices: exclusivity, stale suggestion
// ---------------------------------------------------------------------------------------------

test('S5 §17/§31.14: a card shows ONE choice - the candidate or the manual value, never both', () => {
  const issue = rate(F.a2);
  const [first] = issue.candidates as [{ candidateId: string }];
  const candidate = render(props({ issues: [issue], pending: { [issue.fieldPath]: { kind: 'candidate', candidateId: first.candidateId } } }));
  assert.equal(count(candidate, 'checked=""'), 1);
  assert.ok(/<input type="radio" name="pq-choice-0" checked="" value="[0-9a-f]{16}"/.test(candidate) && candidate.includes('pq-candidate-chosen') && !candidate.includes('pq-manual-chosen'));
  assert.ok(/id="pq-manual-0" type="number"[^>]*value=""/.test(candidate), 'the manual field is empty while a candidate is chosen');
  const manual = render(props({ issues: [issue], pending: { [issue.fieldPath]: { kind: 'manual', raw: '17.1' } } }));
  assert.equal(count(manual, 'checked=""'), 1);
  assert.ok(manual.includes('pq-manual-chosen') && !manual.includes('pq-candidate-chosen') && manual.includes('value="17.1"'));
  assert.equal(count(render(props({ issues: [issue] })), 'checked=""'), 0, 'with nothing chosen nothing is checked');
});

test('S5 §16/§31.15-31.17: a stale previousDecision is SUGGESTED - warning shown, confirmation pre-selected, correction prefilled, nothing fabricated, nothing submitted', () => {
  const warn = 'Dokumenty się zmieniły. Sprawdź poprzedni wybór ponownie.';
  // confirm_candidate whose value is still a candidate: pre-selected.
  const matching = F.stale.confirmMatching.issue;
  assert.deepEqual(matching.previousDecision, { kind: 'confirm_candidate', value: 16.2 });
  const m = render(props({ issues: [matching], readiness: null }));
  assert.ok(textOf(m).includes(warn) && textOf(m).includes('Użyj poprzedniego wyboru'));
  const preselected = matching.candidates.find((c) => c.value === 16.2) as { candidateId: string };
  assert.ok(m.includes(`checked="" value="${preselected.candidateId}"`), 'the matching candidate is pre-selected');
  assert.equal(count(m, 'checked=""'), 1);
  // correct_value: the manual field prefilled with the previous value.
  const corrected = F.stale.correction.issue;
  const c = render(props({ issues: [corrected] }));
  assert.ok(c.includes('value="17.1"') && c.includes('pq-manual-chosen') && textOf(c).includes(warn));
  assert.ok(!corrected.candidates.some((cand) => cand.value === 17.1), 'the correction is not a candidate...');
  assert.equal(count(c, 'type="radio"'), corrected.candidates.length + 1, '...and no candidate is fabricated for it');
  // confirm_candidate whose value is NOT a candidate any more: the manual view, prefilled; again no new candidate.
  const gone = F.stale.confirmNotCandidate.issue;
  assert.deepEqual(gone.previousDecision, { kind: 'confirm_candidate', value: 99 });
  const g = render(props({ issues: [gone] }));
  assert.ok(g.includes('value="99"') && g.includes('pq-manual-chosen'));
  assert.equal(count(g, 'type="radio"'), gone.candidates.length + 1);
  // The user acted on it (own choice): the button is gone, the warning stays.
  const acted = render(props({ issues: [matching], pending: { [matching.fieldPath]: { kind: 'manual', raw: '16.5' } } }));
  assert.ok(textOf(acted).includes(warn) && !textOf(acted).includes('Użyj poprzedniego wyboru'));
  // Skipping dismisses the suggestion.
  const skipped = render(props({ issues: [matching], pending: { [matching.fieldPath]: { kind: 'skip' } } }));
  assert.equal(count(skipped, 'checked=""'), 0);
  // A suggestion alone does not enable Apply.
  assert.ok(/<button type="button" class="primary" disabled="">/.test(m), 'a stale suggestion is never submitted by itself');
  const en = textOf(render(props({ lang: 'en', issues: [matching] })));
  assert.ok(en.includes('The documents changed. Please review your previous choice again.') && en.includes('Use previous choice'));
});

test('S5 §19/§31.21: "Resolved by you" lists user-resolved fields with Undo; it is absent otherwise', () => {
  const resolved = [
    { fieldPath: 'payroll.pensionEmployeePercent', key: 'pensionEmployeePercent', meaning: 'pension_employee_contribution', unit: 'percent_of_printed_base', value: 7.5, kind: 'confirm_candidate' as const },
    { fieldPath: 'recurringItems.netDeductions.net_deduction:housing:huisvesting', key: 'net_deduction:housing:huisvesting', meaning: 'recurring_net_deduction', unit: 'eur_per_period', value: 90, kind: 'correct_value' as const },
  ];
  const html = render(props({ issues: F.resolved.issues, readiness: F.resolved.readiness, resolved }));
  const text = textOf(html);
  assert.ok(text.includes('Rozstrzygnięte przez Ciebie') && text.includes('Składka emerytalna pracownika') && text.includes('7,5%'));
  assert.ok(text.includes('Stałe potrącenie netto: huisvesting') && text.includes('90,00'));
  assert.ok(text.includes('wybrano spośród wartości z dokumentów') && text.includes('wpisano własną wartość'));
  assert.equal(count(html, '>Cofnij</button>'), 2);
  assert.ok(html.includes('aria-label="Cofnij wybór: Składka emerytalna pracownika"'), 'each Undo names its field for assistive tech');
  assertNoRawCodes(html, F.resolved.issues, 'resolved');
  assert.ok(!textOf(render(props({ issues: F.a2.issues, readiness: F.a2.readiness }))).includes('Rozstrzygnięte przez Ciebie'));
  // Only resolved entries and no open question still shows the section (so Undo stays reachable).
  const onlyResolved = render(props({ issues: [], resolved }));
  assert.ok(onlyResolved.includes('pq-resolved') && !onlyResolved.includes('pq-list') && !onlyResolved.includes('class="primary"'));
  const busy = render(props({ issues: [], resolved, busy: true }));
  assert.equal(count(busy, '<button type="button" class="secondary pq-small" disabled=""'), 2, 'Undo is disabled while a resolve is in flight');
});

test('S5 §20: a decision the backend said was rejected shows a translated message on its card, never the raw problem code', () => {
  const issue = rate(F.a2);
  const html = render(props({ issues: [issue], problems: { [issue.fieldPath]: 'invalid_value' }, pending: { [issue.fieldPath]: { kind: 'manual', raw: '-95' } } }));
  assert.ok(textOf(html).includes('Ta wartość nie jest dozwolona dla tego parametru. Popraw ją i zastosuj ponownie.') && html.includes('role="alert"'));
  assert.ok(!html.includes('invalid_value'));
  assert.ok(textOf(render(props({ lang: 'en', issues: [issue], problems: { [issue.fieldPath]: 'unit_mismatch' } }))).includes('This value is not allowed for this parameter.'));
  assert.ok(textOf(render(props({ issues: [issue], problems: { [issue.fieldPath]: 'evidence_changed' } }))).includes('Nie udało się zastosować tego wyboru.'), 'any other problem: the generic message');
});

// ---------------------------------------------------------------------------------------------
// Collapsed evidence, accessibility, languages
// ---------------------------------------------------------------------------------------------

test('S5 §14/§15/§24 (§31.20): hints, excluded evidence and source details are collapsed <details> - none is open by default', () => {
  const html = render(props({ issues: [...F.a2.issues, ...F.a4.issues, ...F.rich.issues], readiness: F.rich.readiness }));
  const details = html.match(/<details[^>]*>/g) ?? [];
  assert.ok(details.length >= 6);
  for (const tag of details) assert.ok(!/ open/.test(tag), `collapsed by default: ${tag}`);
  assert.ok(html.includes('<summary>Wcześniejsze lub dodatkowe dane</summary>') && html.includes('<summary>Szczegóły źródeł</summary>') && html.includes('<summary>Pominięte dane z dokumentów (2)</summary>'));
  const a2 = textOf(render(props({ issues: F.a2.issues })));
  assert.ok(a2.includes('Wcześniejsza wartość, zastąpiona nowszym dokumentem') && a2.includes('zastąpione nowszym dokumentem'), 'translated hint and exclusion wording');
  const detail = textOf(render(props({ issues: F.a2.issues })));
  assert.ok(detail.includes('Fragment dokumentu:') && detail.includes('str. 1') && detail.includes('Etykieta na dokumencie: Uurloon'), 'provenance details (page, printed label, raw fragment) are available inside the collapsed block');
});

test('S5 §24/§31.27: accessibility - labelled radios and inputs, a legend per group, named buttons, native details, status not by colour alone', () => {
  const html = render(props({ issues: [...F.a2.issues, ...F.a4.issues, ...F.rich.issues.filter((i) => i.severity !== 'informational')], readiness: F.rich.readiness, resolved: [{ fieldPath: 'payroll.pensionEmployeePercent', key: 'k', meaning: 'pension_employee_contribution', unit: 'percent', value: 7.5, kind: 'confirm_candidate' }] }));
  // every radio sits inside a <label>
  const radios = html.match(/<label[^>]*>(?:(?!<\/label>)[\s\S])*?<input type="radio"[\s\S]*?<\/label>/g) ?? [];
  assert.equal(radios.length, count(html, 'type="radio"'), 'every radio is wrapped by its label');
  // every text/number/date/select control has an id with a matching <label for>
  const controls = [...html.matchAll(/<(?:input|select) id="(pq-manual-\d+)"/g)].map((m) => m[1]);
  assert.ok(controls.length >= 5);
  for (const id of controls) assert.ok(html.includes(`<label class="pq-manual-label" for="${id}">`) || html.includes(`<label class="pq-sr" for="${id}">`), `${id} has an associated label`);
  assert.equal(count(html, '<fieldset'), count(html, '<legend'), 'every choice group has a legend');
  assert.ok(html.includes('aria-labelledby="pq-title"') && count(html, 'aria-labelledby="pq-title-') === cards(html).length);
  for (const m of html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)) assert.ok((m[1] ?? '').trim() !== '' || /aria-label=/.test(m[0]), `a button without a name: ${m[0]}`);
  // severity is words (and a glyph via CSS for blocking), never colour only
  assert.ok(html.includes('>Wymagane do obliczenia<') && html.includes('>Opcjonalne<'));
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('<details class="pq-details">') && html.includes('<summary>'));
  assert.ok(!/ tabindex="[1-9]/.test(html) && !/onclick|onChange/i.test(html), 'native controls only; no positive tabindex');
  // The icon is decorative.
  assert.ok(!html.includes('<svg') || html.includes('aria-hidden="true"'));
});

test('S5 #19/§29: PL and EN render the whole panel in their own language - no raw codes, no Polish in EN, no English in PL', () => {
  const issues = [...F.a2.issues, ...F.a3a.issues, ...F.a4.issues, ...F.rich.issues.filter((i) => i.severity !== 'informational'), F.stale.confirmMatching.issue];
  const resolved = [{ fieldPath: 'payroll.pensionEmployeePercent', key: 'k', meaning: 'pension_employee_contribution', unit: 'percent', value: 7.5, kind: 'confirm_candidate' as const }];
  const pl = render(props({ lang: 'pl', issues, readiness: F.rich.readiness, resolved, problems: { 'employment.hourlyRate': 'invalid_value' } }));
  const en = render(props({ lang: 'en', issues, readiness: F.rich.readiness, resolved, problems: { 'employment.hourlyRate': 'invalid_value' } }));
  assertNoRawCodes(pl, issues, 'pl');
  assertNoRawCodes(en, issues, 'en');
  const plText = textOf(pl);
  const enText = textOf(en);
  for (const english of ['To resolve', 'Apply', 'Skip for now', 'Undo', 'Required', 'Optional', 'Enter another value', 'Applied by employer', 'Contract / annex', 'Resolved by you', 'Earlier or additional', 'Period unknown', 'Source details']) {
    assert.ok(!plText.includes(english), `PL panel contains English "${english}"`);
  }
  for (const polish of ['Do uzupełnienia', 'Zastosuj', 'Pomiń', 'Cofnij', 'Wymagane', 'Opcjonalne', 'Wpisz inną wartość', 'Rozstrzygnięte', 'Wcześniejsze', 'Okres nieznany', 'Szczegóły', 'Dokumenty']) {
    assert.ok(!enText.includes(polish), `EN panel contains Polish "${polish}"`);
  }
  assert.notEqual(plText, enText);
  // The same structure in both languages: same number of cards, radios, details, buttons, inputs.
  for (const tag of ['<li class="pq-card"', 'type="radio"', '<details', '<button', '<input', '<select', '<fieldset']) assert.equal(count(pl, tag), count(en, tag), tag);
  // Both languages cover every visible reason / field label used above (the translation tables are complete).
  const q = { pl: translations.pl.proDocuments.questions, en: translations.en.proDocuments.questions };
  assert.deepEqual(Object.keys(q.pl.fields).sort(), Object.keys(q.en.fields).sort());
});
