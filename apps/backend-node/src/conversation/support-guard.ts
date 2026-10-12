import { SCENARIO_FIELDS, type ScenarioFieldPath } from '../scenario/scenario-types.js';
import type { NextQuestionSpec, PatchNote } from './conversation-types.js';
import { answerFitsField, unitsFitField } from './deterministic-interpreter.js';
import {
  analyzeMessage,
  describesDistribution,
  HOURS_FIELD_CATEGORY,
  isHoursBucket,
  mentionsNumber,
  mentionsOtherHours,
  namesCategory,
  pureQuantityAnswer,
  sameNumber,
  supportsHoursQuantity,
  unclassifiedHoursTotal,
  type MessageEvidence,
  type NumberMention,
} from './message-evidence.js';
import type { PatchOp, ScenarioPatchV1 } from './scenario-patch.js';

/**
 * The message-to-field support guard (Cursor re-review M3, M4, m1; replaces the F1 weekday-only backstop).
 *
 * Runs on the MODEL's patch, after interpretation and BEFORE the authority guard / atomic application. A
 * schema-valid `source: user` op is not accepted merely because the model produced it; an op is withheld - never
 * applied, never "repaired" into another value - when the user's present message contradicts it or does not
 * support it:
 *   - M3: a number the user stated with a unit the field cannot take ("40 hours" as an hourly rate, "€16.80"
 *     as hours, "50 hours" as a premium); and, when the reply's only number has a unit that contradicts the
 *     question asked ("40 hours", "40 hours thanks"), that number written to ANY field (I2: also with extra words);
 *   - I2: a number written to a non-hours field that the user did not state in this message with a fitting unit
 *     ("40 hours thanks" -> no hourly rate 99, 16.80 or any other value the model supplies);
 *   - M4 / M1: an hours bucket (weekday / Saturday / Sunday / public holiday / overtime) without the kind AND
 *     the quantity in the message - unless the reply is just that number to the server's own question about
 *     that bucket; a model never splits a stated, unclassified total ("40 total, including 8 Saturday" ->
 *     no Saturday 8 and no weekday 32 from that message: the composition is asked instead);
 *   - m1: a kind the message denies ("not weekdays") is never evidence for that kind;
 *   - the overtime distribution without the server asking it or the message describing it.
 * Every withheld op gets a diagnostic note. The remaining ops then go through the unchanged authority guard,
 * which still accepts or rejects them ATOMICALLY. An op that claims a non-user source is never filtered here: it
 * goes to the authority guard, which rejects the WHOLE patch for it (RT-001).
 */

export interface GuardResult {
  patch: ScenarioPatchV1;
  notes: PatchNote[];
  /** A model write of an hours VALUE was withheld for lack of support (not a unit mismatch, not set_unknown). */
  hoursValueWithheld: boolean;
}

const TARGETED_KINDS: ReadonlySet<NextQuestionSpec['kind']> = new Set(['provide_value', 'correct_value', 'resolve_conflict']);

function numbersOf(op: PatchOp): number[] {
  switch (op.op) {
    case 'set':
      return typeof op.value === 'number' ? [op.value] : [];
    case 'set_range':
      return [op.low, op.high];
    case 'set_alternatives':
      return op.options.filter((o): o is number => typeof o === 'number');
    case 'set_conflict':
      return op.candidates.map((c) => c.value).filter((v): v is number => typeof v === 'number');
    default:
      return [];
  }
}

const isScenarioField = (field: string): field is ScenarioFieldPath => Object.prototype.hasOwnProperty.call(SCENARIO_FIELDS, field);

/** M3: the user stated this number, but only with units this field cannot take. */
function contradicted(e: MessageEvidence, field: ScenarioFieldPath, value: number): boolean {
  if (SCENARIO_FIELDS[field].kind !== 'number') return false;
  const said = e.numbers.filter((n) => sameNumber(n.value, value) || (n.high !== null && sameNumber(n.high, value)));
  return said.length > 0 && said.every((n) => !unitsFitField(field, n.units));
}

/**
 * M3 / I2: the reply's ONLY number carries a unit that contradicts the question asked ("40 hours" or "40 hours
 * thanks" to the hourly-rate question). That number is no value of anything here - except of an hours bucket the
 * message itself classifies it as ("... Monday to Friday").
 */
function contradictedReply(e: MessageEvidence, current: NextQuestionSpec | null): NumberMention | null {
  if (!current || current.field === 'work.hours' || e.numbers.length !== 1) return null;
  const only = e.numbers[0] as NumberMention;
  if (only.units.size === 0) return null;
  return answerFitsField(current.field, only.units) ? null : only;
}

const isMention = (n: NumberMention, value: number) => sameNumber(n.value, value) || (n.high !== null && sameNumber(n.high, value));

/**
 * I2: the user stated this value for this (non-hours) field in this message - a number with a unit the field can
 * take, or a bare number. The one conversion recognised is the documented premium convention: a stated total
 * percentage of at least 100% ("150%") also states the premium above base (50).
 */
function statedFor(e: MessageEvidence, field: ScenarioFieldPath, value: number): boolean {
  const spec = SCENARIO_FIELDS[field];
  return e.numbers.some(
    (n) =>
      (isMention(n, value) && unitsFitField(field, n.units)) ||
      (spec.kind === 'number' && spec.unit === 'premium_percent' && n.high === null && n.units.has('percent') && n.value >= 100 && sameNumber(n.value - 100, value)),
  );
}

/** RT-001: an op claiming a non-user source is left to the authority guard, which rejects the whole patch. */
function claimsProvenance(op: PatchOp): boolean {
  if (op.op === 'set' || op.op === 'set_range' || op.op === 'set_alternatives') return op.source !== undefined && op.source !== 'user';
  if (op.op === 'set_conflict') return op.candidates.some((c) => c.source !== undefined && c.source !== 'user');
  return false;
}

function matchesAnswer(op: PatchOp, answer: NumberMention): boolean {
  if (op.op === 'set') return typeof op.value === 'number' && answer.high === null && sameNumber(op.value, answer.value);
  if (op.op === 'set_range') return answer.high !== null && sameNumber(op.low, answer.value) && sameNumber(op.high, answer.high);
  return false;
}

/** M4 / M1 / m1: the message supports this hours-bucket write - kind AND quantity. */
function hoursWriteSupported(op: PatchOp & { field: string }, field: keyof typeof HOURS_FIELD_CATEGORY, e: MessageEvidence, current: NextQuestionSpec | null): boolean {
  const category = HOURS_FIELD_CATEGORY[field];
  const targeted = current?.field === field && TARGETED_KINDS.has(current.kind);
  if (op.op === 'set_unknown') return targeted || namesCategory(e, category);
  if (e.categories.some((m) => m.category === category && m.negated)) return false;
  // The server asked exactly this bucket and the reply is just a fitting number ("40", "between 30 and 40").
  const answer = targeted ? pureQuantityAnswer(e) : null;
  if (answer && answerFitsField(field, answer.units) && matchesAnswer(op, answer)) return true;
  // A stated total that the user did not classify is not split by a model.
  if (unclassifiedHoursTotal(e) !== null) return false;
  if (op.op === 'set') return typeof op.value === 'number' && supportsHoursQuantity(e, category, op.value, null);
  if (op.op === 'set_range') return supportsHoursQuantity(e, category, op.low, op.high);
  if (op.op === 'set_alternatives' || op.op === 'set_conflict') {
    const values = numbersOf(op);
    const all = op.op === 'set_alternatives' ? op.options.length : op.candidates.length;
    return values.length === all && values.every((v) => supportsHoursQuantity(e, category, v, null));
  }
  return true;
}

function distributionSupported(e: MessageEvidence, current: NextQuestionSpec | null): boolean {
  if (current?.field === 'work.overtimeDistribution') return true;
  return describesDistribution(e) && namesCategory(e, 'overtime');
}

export function guardModelPatch(patch: ScenarioPatchV1, message: string, current: NextQuestionSpec | null): GuardResult {
  const e = analyzeMessage(message);
  const contradiction = contradictedReply(e, current);
  const notes: PatchNote[] = [];
  let hoursValueWithheld = false;
  const ops = patch.ops.filter((op) => {
    if (!('field' in op) || !isScenarioField(op.field)) return true; // unknown fields: the authority guard rejects them
    if (op.op !== 'set' && op.op !== 'set_range' && op.op !== 'set_alternatives' && op.op !== 'set_conflict' && op.op !== 'set_unknown') return true;
    if (claimsProvenance(op)) return true;
    const field = op.field;
    const values = numbersOf(op);
    const bucketSupported = isHoursBucket(field) && hoursWriteSupported(op, field, e, current);
    const laundered = contradiction !== null && !bucketSupported && values.some((v) => isMention(contradiction, v));
    if (laundered || values.some((v) => contradicted(e, field, v))) {
      notes.push({ code: 'unit_mismatch_withheld', field });
      return false;
    }
    if (isHoursBucket(field) && !bucketSupported) {
      notes.push({ code: field === 'work.regularWeekdayHours' ? 'weekday_hours_withheld' : 'hours_withheld', field });
      if (op.op !== 'set_unknown') hoursValueWithheld = true;
      return false;
    }
    if (field === 'work.overtimeDistribution' && op.op !== 'set_unknown' && !distributionSupported(e, current)) {
      notes.push({ code: 'hours_withheld', field });
      return false;
    }
    // I2: a non-hours number the user did not state is the model's own value - never a user fact.
    if (!isHoursBucket(field) && SCENARIO_FIELDS[field].kind === 'number' && values.some((v) => !statedFor(e, field, v))) {
      notes.push({ code: 'value_not_stated_withheld', field });
      return false;
    }
    return true;
  });
  return { patch: ops.length === patch.ops.length ? patch : { ...patch, ops }, notes, hoursValueWithheld };
}

/**
 * What the present message says about the composition of the hours (display data for the one clarification):
 * an unclassified total stated in it (or the model's `statedWeeklyHours` only when that number is literally in
 * the message), and whether it names other kinds of hours / denies weekday hours.
 */
export function hoursCompositionEvidence(message: string, modelStated: number | undefined): { statedTotal: number | null; otherCategories: boolean } {
  const e = analyzeMessage(message);
  const fromMessage = unclassifiedHoursTotal(e);
  const statedTotal = fromMessage ?? (modelStated !== undefined && mentionsNumber(e, modelStated) ? modelStated : null);
  return { statedTotal, otherCategories: mentionsOtherHours(e) };
}
