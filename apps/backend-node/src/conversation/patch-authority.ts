import { SCENARIO_FIELDS, UNSUPPORTED_CONCEPTS, type ScenarioFieldPath, type ScenarioV1, type UnsupportedConcept } from '../scenario/scenario-types.js';
import { canonicalJson, getAt, isRecord, withValueAt } from '../scenario/scenario-util.js';
import { validateScenario } from '../scenario/scenario-validate.js';
import { assumptionFor, assumptionNode } from './assumption-catalog.js';
import { isVerifiedSource, type AppliedOp, type PatchIssue, type PatchIssueCode, type PatchNote } from './conversation-types.js';
import { MAX_PATCH_OPS, type PatchOp, type PatchValue, type ScenarioPatchV1 } from './scenario-patch.js';
import { EXPLICIT_OVERRIDE_REF } from './trusted-context.js';

/**
 * Patch authority / provenance guard + deterministic, atomic application (R2 §7, §8).
 *
 * Input: an UNTRUSTED patch (from the deterministic interpreter or the LLM) and the current Scenario.
 * Output: either the operations as the SERVER will apply them - with provenance the server assigned - or a
 * rejection listing every problem. One bad operation rejects the whole patch (R2 V1: no partial apply).
 *
 * Provenance rules (RT-001):
 *   - an untrusted op writes `user` values only; claiming document / cao_rule / official_rule /
 *     intelligence_memory is `untrusted_provenance_elevation` (rejected, never downgraded);
 *   - a Loonto assumption enters only through `accept_assumption`, with the catalogued value, and stays
 *     `loonto_assumption` - re-stating the same value does not launder it into a user fact;
 *   - a verified value is never silently replaced or erased: a differing user value becomes a CONFLICT
 *     [verified, user] that R1 blocks on; replacing it with an assumption, a range, `unknown` or a removal
 *     is rejected; only an explicit `resolve_conflict` pick can override it, and that is recorded.
 * Nothing here calls Tier A or any network service.
 */

/** Names that belong to Tier A / the engine, never to the Scenario contract. */
const ENGINE_FIELD_NAMES = new Set([
  'engineInput', 'engineResult', 'engineInputDigest', 'runs', 'variants', 'figures', 'range', 'outcome', 'period', 'consumption',
  'week_grids', 'hour_lines', 'hourly_rate', 'period_type', 'apply_loonheffingskorting', 'travel_allowance', 'surcharge_lines',
  'saturday_percent', 'sunday_percent', 'holiday_percent', 'overtime_tier_threshold_hours', 'overtime_tier_1_percent', 'overtime_tier_2_percent',
  'payout_amount', 'wage_net', 'gross_total', 'total_tax', 'pre_tax_deductions', 'net_additions', 'net_deductions',
]);

function fieldIssue(field: string): PatchIssueCode | null {
  if (Object.prototype.hasOwnProperty.call(SCENARIO_FIELDS, field)) return null;
  const leaf = field.split(/[./[\]]/).filter(Boolean).pop() ?? field;
  return ENGINE_FIELD_NAMES.has(field) || ENGINE_FIELD_NAMES.has(leaf) || /_/.test(field) ? 'engine_field_forbidden' : 'unknown_field';
}

function sourceIssue(source: string | undefined): PatchIssueCode | null {
  if (source === undefined || source === 'user') return null;
  if (isVerifiedSource(source)) return 'untrusted_provenance_elevation';
  if (source === 'loonto_assumption') return 'assumption_must_use_catalog';
  return 'invalid_source';
}

function valueIssue(field: ScenarioFieldPath, value: PatchValue): PatchIssueCode | null {
  const spec = SCENARIO_FIELDS[field];
  if (spec.kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? null : 'value_type_mismatch';
  if (field === 'work.overtimeDistribution') return isRecord(value) ? null : 'value_type_mismatch';
  if (typeof value !== 'string') return 'value_type_mismatch';
  const allowed: readonly string[] | undefined = 'allowed' in spec ? spec.allowed : undefined;
  return allowed && !allowed.includes(value) ? 'choice_not_allowed' : null;
}

function isVerifiedNode(node: unknown): boolean {
  if (!isRecord(node)) return false;
  if (node.state === 'conflict') return Array.isArray(node.candidates) && node.candidates.some((c) => isRecord(c) && isVerifiedSource(c.source));
  return isVerifiedSource(node.source);
}

function verifiedCandidates(node: unknown): Array<Record<string, unknown>> {
  if (!isRecord(node)) return [];
  if (node.state === 'conflict' && Array.isArray(node.candidates)) return node.candidates.filter((c): c is Record<string, unknown> => isRecord(c) && isVerifiedSource(c.source)).map((c) => structuredClone(c));
  if (node.state === 'known' && isVerifiedSource(node.source)) return [{ value: node.value, source: node.source, ...(typeof node.ref === 'string' ? { ref: node.ref } : {}) }];
  return [];
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export type AuthorizationResult =
  | { status: 'authorized'; ops: AppliedOp[]; notes: PatchNote[] }
  | { status: 'rejected'; issues: PatchIssue[] };

export function authorizePatch(patch: ScenarioPatchV1, scenario: ScenarioV1): AuthorizationResult {
  const issues: PatchIssue[] = [];
  const ops: AppliedOp[] = [];
  const notes: PatchNote[] = [];
  if (patch.ops.length > MAX_PATCH_OPS) return { status: 'rejected', issues: [{ code: 'too_many_ops', params: { count: patch.ops.length, max: MAX_PATCH_OPS } }] };

  const touched = new Set<string>();
  const reject = (code: PatchIssueCode, opIndex: number, field?: string, params?: PatchIssue['params']) => issues.push({ code, opIndex, ...(field ? { field } : {}), ...(params ? { params } : {}) });

  patch.ops.forEach((op: PatchOp, i) => {
    if (op.op === 'request_concept' || op.op === 'withdraw_concept') {
      if (!(UNSUPPORTED_CONCEPTS as readonly string[]).includes(op.concept)) return reject('unknown_concept', i, undefined, { concept: op.concept });
      const key = `concept:${op.concept}`;
      if (touched.has(key)) return reject('duplicate_field_in_patch', i, key);
      touched.add(key);
      const present = (scenario.requestedConcepts ?? []).some((c) => c.concept === op.concept);
      if (op.op === 'request_concept' && !present) ops.push({ op: 'request_concept', concept: op.concept as UnsupportedConcept });
      if (op.op === 'withdraw_concept' && present) ops.push({ op: 'withdraw_concept', concept: op.concept as UnsupportedConcept });
      return;
    }
    if (op.op === 'set_label') {
      if (touched.has('label')) return reject('duplicate_field_in_patch', i, 'label');
      touched.add('label');
      ops.push({ op: 'set_label', label: op.label.trim() });
      return;
    }

    const badField = fieldIssue(op.field);
    if (badField) return reject(badField, i, op.field);
    const field = op.field as ScenarioFieldPath;
    if (touched.has(field)) return reject('duplicate_field_in_patch', i, field);
    touched.add(field);
    const spec = SCENARIO_FIELDS[field];
    const existing = getAt(scenario, field);
    const verified = isVerifiedNode(existing);

    switch (op.op) {
      case 'set': {
        const s = sourceIssue(op.source) ?? valueIssue(field, op.value);
        if (s) return reject(s, i, field, op.source ? { source: op.source } : undefined);
        if (verified) {
          const pool = verifiedCandidates(existing);
          if (pool.some((c) => same(c.value, op.value))) {
            notes.push({ code: 'value_already_verified', field });
            return;
          }
          ops.push({ op: 'write', field, node: { state: 'conflict', candidates: [...pool, { value: op.value, source: 'user' }] } });
          notes.push({ code: 'verified_value_kept_in_conflict', field });
          return;
        }
        if (isRecord(existing) && existing.state === 'known' && existing.source === 'loonto_assumption' && same(existing.value, op.value)) {
          notes.push({ code: 'assumption_kept_as_assumption', field });
          return;
        }
        ops.push({ op: 'write', field, node: { state: 'known', value: op.value, source: 'user' } });
        return;
      }
      case 'set_range': {
        if (spec.kind !== 'number') return reject('range_not_allowed_for_choice', i, field);
        const s = sourceIssue(op.source) ?? valueIssue(field, op.low) ?? valueIssue(field, op.high);
        if (s) return reject(s, i, field, op.source ? { source: op.source } : undefined);
        if (verified) return reject('cannot_override_verified', i, field);
        ops.push({ op: 'write', field, node: { state: 'range', low: op.low, high: op.high, source: 'user' } });
        return;
      }
      case 'set_alternatives': {
        if (spec.kind !== 'choice') return reject('alternatives_not_allowed_for_number', i, field);
        const s = sourceIssue(op.source) ?? op.options.map((o) => valueIssue(field, o)).find((x) => x !== null) ?? null;
        if (s) return reject(s, i, field, op.source ? { source: op.source } : undefined);
        if (verified) return reject('cannot_override_verified', i, field);
        ops.push({ op: 'write', field, node: { state: 'alternatives', options: op.options, source: 'user' } });
        return;
      }
      case 'set_conflict': {
        const s = op.candidates.map((c) => sourceIssue(c.source) ?? valueIssue(field, c.value)).find((x) => x !== null) ?? null;
        if (s) return reject(s, i, field);
        if (verified) return reject('cannot_override_verified', i, field);
        ops.push({ op: 'write', field, node: { state: 'conflict', candidates: op.candidates.map((c) => ({ value: c.value, source: 'user' })) } });
        return;
      }
      case 'set_unknown': {
        if (verified) return reject('cannot_erase_verified', i, field);
        ops.push({ op: 'write', field, node: { state: 'unknown' } });
        return;
      }
      case 'remove': {
        if (verified) return reject('cannot_erase_verified', i, field);
        if (existing !== undefined) ops.push({ op: 'remove', field });
        return;
      }
      case 'accept_assumption': {
        const entry = assumptionFor(field);
        if (!entry) return reject('assumption_not_in_catalog', i, field);
        if (verified) return reject('cannot_replace_verified_with_assumption', i, field);
        const userStated = isRecord(existing) && ((existing.state !== 'unknown' && existing.source === 'user') || existing.state === 'conflict');
        if (userStated) return reject('assumption_field_already_known', i, field);
        ops.push({ op: 'write', field, node: assumptionNode(entry) });
        return;
      }
      case 'resolve_conflict': {
        if (!isRecord(existing) || existing.state !== 'conflict' || !Array.isArray(existing.candidates)) return reject('no_conflict_to_resolve', i, field);
        const picked = existing.candidates[op.pick];
        if (!isRecord(picked)) return reject('conflict_pick_out_of_range', i, field, { pick: op.pick, candidates: existing.candidates.length });
        if (isVerifiedSource(picked.source)) {
          // A verified candidate keeps its own (already trust-checked) origin.
          ops.push({ op: 'write', field, node: { state: 'known', value: picked.value, source: picked.source, ...(typeof picked.ref === 'string' ? { ref: picked.ref } : {}) } });
        } else {
          ops.push({ op: 'write', field, node: { state: 'known', value: picked.value, source: 'user', ...(verified ? { ref: EXPLICIT_OVERRIDE_REF } : {}) } });
          if (verified) notes.push({ code: 'explicit_override_of_verified', field });
        }
        return;
      }
    }
  });

  return issues.length > 0 ? { status: 'rejected', issues } : { status: 'authorized', ops, notes };
}

// ---------------------------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------------------------

const REQUIRED_SECTIONS = new Set(['work', 'pay', 'tax']);

/** Deep copy with `path` deleted; optional sections left empty by the removal are pruned. */
function withoutValueAt(scenario: ScenarioV1, path: string): ScenarioV1 {
  const copy = structuredClone(scenario) as unknown as Record<string, unknown>;
  const keys = path.split('.');
  const chain: Array<[Record<string, unknown>, string]> = [];
  let node: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (!isRecord(next)) return copy as unknown as ScenarioV1;
    chain.push([node, key]);
    node = next;
  }
  delete node[keys[keys.length - 1] as string];
  for (let i = chain.length - 1; i >= 0; i--) {
    const [parent, key] = chain[i] as [Record<string, unknown>, string];
    const child = parent[key];
    if (isRecord(child) && Object.keys(child).length === 0 && !(i === 0 && REQUIRED_SECTIONS.has(key))) delete parent[key];
  }
  return copy as unknown as ScenarioV1;
}

/** Pure and order-stable: applies already-authorized operations to a copy of the Scenario. */
export function applyAuthorizedOps(scenario: ScenarioV1, ops: readonly AppliedOp[]): ScenarioV1 {
  let out = structuredClone(scenario);
  for (const op of ops) {
    if (op.op === 'write') out = withValueAt(out, op.field, structuredClone(op.node));
    else if (op.op === 'remove') out = withoutValueAt(out, op.field);
    else if (op.op === 'request_concept') out = { ...out, requestedConcepts: [...(out.requestedConcepts ?? []), { concept: op.concept, source: 'user' }] };
    else if (op.op === 'withdraw_concept') {
      const rest = (out.requestedConcepts ?? []).filter((c) => c.concept !== op.concept);
      out = { ...out, requestedConcepts: rest };
      if (rest.length === 0) delete (out as { requestedConcepts?: unknown }).requestedConcepts;
    } else if (op.op === 'set_label') {
      out = { ...out, label: op.label };
      if (op.label === '') delete (out as { label?: unknown }).label;
    }
  }
  return out;
}

export type PatchResult =
  | { status: 'applied'; scenario: ScenarioV1; applied: AppliedOp[]; notes: PatchNote[] }
  | { status: 'unchanged'; scenario: ScenarioV1; notes: PatchNote[] }
  | { status: 'rejected'; scenario: ScenarioV1; issues: PatchIssue[] };

const issueKey = (i: { code: string; path: string; params?: unknown }) => `${i.code}|${i.path}|${canonicalJson(i.params ?? null)}`;

/**
 * Guard + apply + R1 validation, atomically. A patch that would make the Scenario NEWLY invalid under R1's
 * own validator is rejected as a whole (the Scenario is returned unchanged) with R1's issue codes - a turn
 * never moves the Scenario into an invalid state.
 */
export function applyScenarioPatch(scenario: ScenarioV1, patch: ScenarioPatchV1): PatchResult {
  const authorization = authorizePatch(patch, scenario);
  if (authorization.status === 'rejected') return { status: 'rejected', scenario, issues: authorization.issues };
  if (authorization.ops.length === 0) return { status: 'unchanged', scenario, notes: authorization.notes };

  const next = applyAuthorizedOps(scenario, authorization.ops);
  const after = validateScenario(next);
  if (after.status === 'invalid') {
    const before = new Set(validateScenario(scenario).issues.map(issueKey));
    const introduced = after.issues.filter((issue) => !before.has(issueKey(issue)));
    if (introduced.length > 0) {
      return {
        status: 'rejected',
        scenario,
        issues: introduced.map((issue) => ({ code: 'scenario_validation_failed' as const, field: issue.path, params: { issue: issue.code, ...(issue.params ?? {}) } })),
      };
    }
  }
  return { status: 'applied', scenario: next, applied: authorization.ops, notes: authorization.notes };
}
