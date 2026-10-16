/**
 * R3-A Conversational UI Foundation - the demo's state machine (ZADANIE-LOONTO-R3-A-CONVERSATIONAL-UI-FOUNDATION.md).
 *
 * This is a SCRIPTED, SYNTHETIC demonstration of how the Loonto conversation will feel. It is deliberately not
 * connected to R2 (no ScenarioPatch, no model, no /api call) and never calculates:
 *   - Loonto's replies are a fixed script, advanced ONLY by the example answers (choices) offered on screen;
 *   - text the user types is shown, but never interpreted: the reply says plainly that understanding free text is
 *     not connected yet, and the scenario does not change;
 *   - every value is an example ("przykład"), sample-document values are explicitly unverified;
 *   - "Nie wiem" leaves a value unknown (null) - never 0;
 *   - an ambiguous "150%" premium stays "needs clarification" until the user picks a meaning (R2 P1);
 *   - a night / shift allowance is recorded as unsupported, never turned into a weekend premium (R2 L1);
 *   - a Loonto assumption is only EXPLAINED (display-only card), never applied (CEO decision 10);
 *   - the result is always unavailable / needs clarification - there is no payout field at all.
 * Pure functions only: the React view (R3AConversationDemo.tsx) renders this state and dispatches actions.
 */

export type ExperienceState = 'READ' | 'SUMMARY' | 'CONVERSATION' | 'SCENARIO' | 'RESULT' | 'EXPLAIN';

export type ChoiceId =
  | 'goal_40h' | 'sample_document' | 'how_it_works'
  | 'hours_weekdays' | 'hours_with_saturday' | 'hours_dont_know'
  | 'split_32_8' | 'split_dont_know'
  | 'sat_plus_50' | 'sat_150' | 'sat_dont_know'
  | 'clarify_150_plus_50' | 'clarify_150_plus_150'
  | 'rate_1680' | 'rate_dont_know'
  | 'extras_night' | 'extras_none'
  | 'show_scenario' | 'why_no_result' | 'start_over';

export type Step = 'goal' | 'hours_kind' | 'split' | 'sat_premium' | 'clarify_150' | 'rate' | 'extras' | 'done';

export type LoontoMessageKey =
  | 'opening' | 'how_it_works' | 'free_text_not_connected'
  | 'doc_read' | 'doc_summary' | 'goal_after_doc'
  | 'ask_hours_kind' | 'hours_dont_know' | 'ask_split' | 'split_dont_know'
  | 'ask_sat_premium' | 'clarify_150' | 'sat_dont_know'
  | 'ask_rate' | 'rate_from_document' | 'rate_dont_know'
  | 'ask_extras' | 'night_unsupported' | 'done' | 'why_no_result';

export type RowId = 'total_hours' | 'weekday_hours' | 'saturday_hours' | 'saturday_premium' | 'hourly_rate' | 'pay_period' | 'night_allowance';
/** Where an example value came from. There is deliberately no "document" / "cao" / "official" source: nothing here is verified. */
export type RowSource = 'user_example' | 'sample_document' | 'user_edit_example';
export type RowStatus = 'given' | 'to_classify' | 'needs_clarification' | 'unknown' | 'unsupported' | 'unverified_example';
/** `premium_above_base`: 50 means +50%. `percent_as_said`: a percentage exactly as the user typed it, meaning still unclear. */
export type RowUnit = 'hours' | 'eur_per_hour' | 'premium_above_base' | 'percent_as_said' | 'period' | 'none';

export interface ScenarioRow {
  id: RowId;
  /** null = unknown. Never replaced by 0. */
  value: number | 'week' | null;
  unit: RowUnit;
  source: RowSource;
  status: RowStatus;
  /** The source before a demo edit, kept visible. */
  previousSource?: RowSource;
}

export type Message =
  | { id: number; from: 'loonto'; key: LoontoMessageKey }
  | { id: number; from: 'user'; choice: ChoiceId }
  | { id: number; from: 'user'; text: string };

export type EditError = 'invalid_number' | 'hours_out_of_range' | 'must_be_positive';

export interface DemoState {
  step: Step;
  messages: Message[];
  rows: ScenarioRow[];
  /** The optional, clearly fictitious sample-document path (READ + SUMMARY). */
  sampleDocument: boolean;
  /** A display-only card explaining a FUTURE Loonto assumption. Never applied to anything. */
  assumptionInfo: boolean;
  /** The secondary scenario / result panel (a toggle on narrow screens; always shown on wide ones). */
  panelOpen: boolean;
  explainOpen: boolean;
  analyzerNotice: boolean;
  editErrors: Partial<Record<RowId, EditError>>;
  nextId: number;
}

export type DemoAction =
  | { type: 'choose'; choice: ChoiceId }
  | { type: 'free_text'; text: string }
  | { type: 'set_panel'; open: boolean }
  | { type: 'set_explain'; open: boolean }
  | { type: 'edit_row'; id: RowId; raw: string }
  | { type: 'clear_edit_error'; id: RowId }
  | { type: 'analyzer' }
  | { type: 'reset' };

export const EDITABLE_ROWS: ReadonlySet<RowId> = new Set(['total_hours', 'weekday_hours', 'saturday_hours', 'hourly_rate']);

export function initialState(): DemoState {
  return {
    step: 'goal',
    messages: [{ id: 1, from: 'loonto', key: 'opening' }],
    rows: [],
    sampleDocument: false,
    assumptionInfo: false,
    panelOpen: false,
    explainOpen: false,
    analyzerNotice: false,
    editErrors: {},
    nextId: 2,
  };
}

/** The example answers offered at this point of the script - the ONLY way the script moves forward. */
export function availableChoices(state: DemoState): ChoiceId[] {
  switch (state.step) {
    case 'goal':
      return state.sampleDocument || state.rows.length > 0 ? ['goal_40h', 'how_it_works'] : ['goal_40h', 'sample_document', 'how_it_works'];
    case 'hours_kind':
      return ['hours_weekdays', 'hours_with_saturday', 'hours_dont_know'];
    case 'split':
      return ['split_32_8', 'split_dont_know'];
    case 'sat_premium':
      return ['sat_plus_50', 'sat_150', 'sat_dont_know'];
    case 'clarify_150':
      return ['clarify_150_plus_50', 'clarify_150_plus_150', 'sat_dont_know'];
    case 'rate':
      return ['rate_1680', 'rate_dont_know'];
    case 'extras':
      return ['extras_night', 'extras_none'];
    case 'done':
      return ['show_scenario', 'why_no_result', 'start_over'];
  }
}

const row = (id: RowId, value: ScenarioRow['value'], unit: RowUnit, source: RowSource, status: RowStatus): ScenarioRow => ({ id, value, unit, source, status });

function upsert(rows: ScenarioRow[], next: ScenarioRow): ScenarioRow[] {
  return rows.some((r) => r.id === next.id) ? rows.map((r) => (r.id === next.id ? next : r)) : [...rows, next];
}
const without = (rows: ScenarioRow[], id: RowId) => rows.filter((r) => r.id !== id);
const has = (state: DemoState, id: RowId) => state.rows.some((r) => r.id === id);

/** After the hours (and any Saturday premium), the rate is asked - unless the sample document already "had" it. */
function afterHours(state: DemoState): { step: Step; keys: LoontoMessageKey[] } {
  return has(state, 'hourly_rate') ? { step: 'extras', keys: ['rate_from_document', 'ask_extras'] } : { step: 'rate', keys: ['ask_rate'] };
}

function say(state: DemoState, userMessage: Message | null, keys: LoontoMessageKey[], patch: Partial<DemoState> = {}): DemoState {
  let nextId = state.nextId;
  const added: Message[] = [];
  if (userMessage) added.push({ ...userMessage, id: nextId++ } as Message);
  for (const key of keys) added.push({ id: nextId++, from: 'loonto', key });
  return { ...state, ...patch, messages: [...state.messages, ...added], nextId };
}

function choose(state: DemoState, choice: ChoiceId): DemoState {
  if (!availableChoices(state).includes(choice)) return state; // not offered now - ignored
  if (choice === 'start_over') return { ...initialState(), panelOpen: state.panelOpen };
  if (choice === 'show_scenario') return { ...state, panelOpen: true };
  const picked: Message = { id: 0, from: 'user', choice };
  switch (choice) {
    case 'goal_40h':
      return say(state, picked, ['ask_hours_kind'], { step: 'hours_kind', rows: upsert(state.rows, row('total_hours', 40, 'hours', 'user_example', 'to_classify')) });
    case 'sample_document':
      return say(state, picked, ['doc_read', 'doc_summary', 'goal_after_doc'], {
        sampleDocument: true,
        rows: [...state.rows, row('hourly_rate', 16.8, 'eur_per_hour', 'sample_document', 'unverified_example'), row('pay_period', 'week', 'period', 'sample_document', 'unverified_example')],
      });
    case 'how_it_works':
      return say(state, picked, ['how_it_works'], { explainOpen: true });
    case 'hours_weekdays': {
      const rows = upsert(without(state.rows, 'total_hours'), row('weekday_hours', 40, 'hours', 'user_example', 'given'));
      const next = afterHours({ ...state, rows });
      return say(state, picked, next.keys, { step: next.step, rows });
    }
    case 'hours_with_saturday':
      return say(state, picked, ['ask_split'], { step: 'split' });
    case 'hours_dont_know':
      return say(state, picked, ['hours_dont_know']);
    case 'split_32_8': {
      const rows = [...without(state.rows, 'total_hours'), row('weekday_hours', 32, 'hours', 'user_example', 'given'), row('saturday_hours', 8, 'hours', 'user_example', 'given')];
      return say(state, picked, ['ask_sat_premium'], { step: 'sat_premium', rows });
    }
    case 'split_dont_know':
      return say(state, picked, ['split_dont_know']);
    case 'sat_plus_50':
    case 'clarify_150_plus_50':
    case 'clarify_150_plus_150': {
      const value = choice === 'clarify_150_plus_150' ? 150 : 50;
      const rows = upsert(state.rows, row('saturday_premium', value, 'premium_above_base', 'user_example', 'given'));
      const next = afterHours({ ...state, rows });
      return say(state, picked, next.keys, { step: next.step, rows });
    }
    case 'sat_150':
      // R2 P1: "150%" is ambiguous (rate 150% = +50%, or +150%). Kept exactly as said, never converted silently.
      return say(state, picked, ['clarify_150'], { step: 'clarify_150', rows: upsert(state.rows, row('saturday_premium', 150, 'percent_as_said', 'user_example', 'needs_clarification')) });
    case 'sat_dont_know': {
      const rows = upsert(state.rows, row('saturday_premium', null, 'premium_above_base', 'user_example', 'unknown'));
      const next = afterHours({ ...state, rows });
      return say(state, picked, ['sat_dont_know', ...next.keys], { step: next.step, rows, assumptionInfo: true });
    }
    case 'rate_1680':
      return say(state, picked, ['ask_extras'], { step: 'extras', rows: upsert(state.rows, row('hourly_rate', 16.8, 'eur_per_hour', 'user_example', 'given')) });
    case 'rate_dont_know':
      return say(state, picked, ['rate_dont_know', 'ask_extras'], { step: 'extras', rows: upsert(state.rows, row('hourly_rate', null, 'eur_per_hour', 'user_example', 'unknown')) });
    case 'extras_night':
      // R2 L1: recorded as unsupported - never mapped onto a Saturday / Sunday premium, never calculated.
      return say(state, picked, ['night_unsupported', 'done'], { step: 'done', rows: upsert(state.rows, row('night_allowance', null, 'none', 'user_example', 'unsupported')) });
    case 'extras_none':
      return say(state, picked, ['done'], { step: 'done' });
    case 'why_no_result':
      return say(state, picked, ['why_no_result'], { explainOpen: true });
  }
  return state;
}

/** Parses an edited number ("36", "16,80", "€ 16.80", "36 h"); null when it is not one number. */
export function parseEditedNumber(raw: string): number | null {
  const cleaned = raw.replace(/€|eur|\/\s*h|h\b|godz\.?/gi, ' ').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Why an edited value cannot be saved, or null when it can. */
export function validateEdit(target: ScenarioRow, raw: string): EditError | null {
  const value = parseEditedNumber(raw);
  if (value === null) return 'invalid_number';
  if (target.unit === 'hours' && (value < 0 || value > 168)) return 'hours_out_of_range';
  if (target.unit === 'eur_per_hour' && value <= 0) return 'must_be_positive';
  return null;
}

/** A demo edit: changes only this example value, keeps where it came from visible, never restarts the conversation. */
function editRow(state: DemoState, id: RowId, raw: string): DemoState {
  const target = state.rows.find((r) => r.id === id);
  if (!target || !EDITABLE_ROWS.has(id)) return state;
  const error = validateEdit(target, raw);
  if (error) return { ...state, editErrors: { ...state.editErrors, [id]: error } };
  const value = parseEditedNumber(raw) as number;
  const edited: ScenarioRow = {
    ...target,
    value,
    source: 'user_edit_example',
    previousSource: target.source === 'user_edit_example' ? target.previousSource : target.source,
    status: target.status === 'to_classify' ? 'to_classify' : 'given',
  };
  const editErrors = { ...state.editErrors };
  delete editErrors[id];
  return { ...state, rows: state.rows.map((r) => (r.id === id ? edited : r)), editErrors };
}

export function reduce(state: DemoState, action: DemoAction): DemoState {
  switch (action.type) {
    case 'choose':
      return choose(state, action.choice);
    case 'free_text': {
      const text = action.text.trim();
      if (!text) return state;
      // Shown as typed, never interpreted: no step, row or result changes.
      return say(state, { id: 0, from: 'user', text: text.slice(0, 500) }, ['free_text_not_connected']);
    }
    case 'set_panel':
      return { ...state, panelOpen: action.open };
    case 'set_explain':
      return { ...state, explainOpen: action.open };
    case 'edit_row':
      return editRow(state, action.id, action.raw);
    case 'clear_edit_error': {
      const editErrors = { ...state.editErrors };
      delete editErrors[action.id];
      return { ...state, editErrors };
    }
    case 'analyzer':
      return { ...state, analyzerNotice: true };
    case 'reset':
      return initialState();
  }
}

// ---------------------------------------------------------------------------------------------
// Result: never a payout
// ---------------------------------------------------------------------------------------------

export type ResultReason =
  | 'demo_engine_not_connected'
  | 'hours_missing' | 'hours_unclassified'
  | 'rate_missing' | 'rate_unknown' | 'rate_unverified_example'
  | 'saturday_premium_missing' | 'saturday_premium_unknown' | 'premium_150_ambiguous'
  | 'allowance_unsupported'
  | 'tax_and_deductions_not_asked';

/** The R3-A result: there is no amount in this type - not even an optional one. */
export interface ResultView {
  status: 'unavailable' | 'needs_clarification';
  reasons: ResultReason[];
}

const NEEDS_CLARIFICATION: ReadonlySet<ResultReason> = new Set(['hours_unclassified', 'rate_unknown', 'saturday_premium_unknown', 'premium_150_ambiguous', 'allowance_unsupported']);

export function resultView(state: DemoState): ResultView {
  const get = (id: RowId) => state.rows.find((r) => r.id === id);
  const reasons: ResultReason[] = ['demo_engine_not_connected'];
  const total = get('total_hours');
  if (!total && !get('weekday_hours') && !get('saturday_hours')) reasons.push('hours_missing');
  if (total?.status === 'to_classify') reasons.push('hours_unclassified');
  const rate = get('hourly_rate');
  if (!rate) reasons.push('rate_missing');
  else if (rate.value === null) reasons.push('rate_unknown');
  else if (rate.status === 'unverified_example') reasons.push('rate_unverified_example');
  const premium = get('saturday_premium');
  if (get('saturday_hours') && !premium) reasons.push('saturday_premium_missing');
  if (premium?.status === 'needs_clarification') reasons.push('premium_150_ambiguous');
  if (premium?.status === 'unknown') reasons.push('saturday_premium_unknown');
  if (get('night_allowance')) reasons.push('allowance_unsupported');
  reasons.push('tax_and_deductions_not_asked');
  return { status: reasons.some((r) => NEEDS_CLARIFICATION.has(r)) ? 'needs_clarification' : 'unavailable', reasons };
}

/** Which of the six experience states the screen currently shows. RESULT (pending) is always visible. */
export function experienceStates(state: DemoState): ExperienceState[] {
  const out: ExperienceState[] = [];
  if (state.sampleDocument) out.push('READ', 'SUMMARY');
  out.push('CONVERSATION');
  if (state.rows.length > 0) out.push('SCENARIO');
  out.push('RESULT');
  if (state.explainOpen) out.push('EXPLAIN');
  return out;
}
