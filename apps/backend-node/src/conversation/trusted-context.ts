import type { PayrollProfile, ProfileField } from '../payroll-engine/payroll-profile.js';
import { EMPLOYMENT_FIELD_ENGINE, PAYROLL_FIELD_ENGINE } from '../scenario/scenario-profile-gaps.js';
import { SCENARIO_FIELDS, SCENARIO_FIELD_PATHS, type ScenarioFieldPath, type ScenarioV1 } from '../scenario/scenario-types.js';
import { canonicalJson, getAt, isRecord, withValueAt } from '../scenario/scenario-util.js';
import { isVerifiedSource, type PatchNote, type VerifiedSource } from './conversation-types.js';

/**
 * The trusted / untrusted boundary (RT-001).
 *
 * A TrustedContext holds facts the SERVER itself established (today: document facts from a Payroll Profile
 * it resolved). It carries a module-private Symbol brand, so it cannot be produced by JSON.parse, by a
 * request body, by an LLM output or by a Tier A response - only by `createTrustedContext` /
 * `trustedContextFromProfile` in server code. The public `/api/scenario/turn` route passes NO trusted
 * context: in this stateless app a request-carried "trusted" payload would just be self-declared trust.
 *
 * Rule enforced at the start of every turn: every verified-source value in the incoming Scenario must be
 * backed, exactly, by the trusted context of that turn. With no trusted context, any verified source in a
 * request is self-declared and the turn is rejected - never silently accepted, never downgraded.
 */

const TRUSTED = Symbol('loonto.trustedContext');

/** `ref` of a user value that explicitly overrode a verified one via `resolve_conflict` (recorded, visible). */
export const EXPLICIT_OVERRIDE_REF = 'explicit_override';

type VerifiedKnown = { state: 'known'; value: number | string; source: VerifiedSource; ref?: string };
type VerifiedConflict = { state: 'conflict'; candidates: Array<{ value: number | string; source: VerifiedSource; ref?: string }> };

export interface TrustedFact {
  field: ScenarioFieldPath;
  node: VerifiedKnown | VerifiedConflict;
}

export interface TrustedContext {
  readonly [TRUSTED]: true;
  readonly facts: readonly TrustedFact[];
}

export function isTrustedContext(value: unknown): value is TrustedContext {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[TRUSTED] === true;
}

function checkFactNode(fact: TrustedFact): void {
  if (!(SCENARIO_FIELD_PATHS as readonly string[]).includes(fact.field)) throw new TypeError(`trusted fact on unknown field ${fact.field}`);
  const values = fact.node.state === 'known' ? [fact.node] : fact.node.candidates;
  if (fact.node.state === 'conflict' && values.length < 2) throw new TypeError('a trusted conflict needs two candidates');
  for (const v of values) {
    if (!isVerifiedSource(v.source)) throw new TypeError(`trusted fact with non-verified source ${String(v.source)}`);
    if (typeof v.value === 'number' && !Number.isFinite(v.value)) throw new TypeError('non-finite trusted value');
  }
}

/** Server-internal constructor. Facts are validated and frozen. */
export function createTrustedContext(facts: readonly TrustedFact[]): TrustedContext {
  const seen = new Set<string>();
  for (const fact of facts) {
    checkFactNode(fact);
    if (seen.has(fact.field)) throw new TypeError(`duplicate trusted fact for ${fact.field}`);
    seen.add(fact.field);
  }
  const frozen = facts.map((f) => Object.freeze(structuredClone(f)));
  return Object.freeze({ [TRUSTED]: true as const, facts: Object.freeze(frozen) });
}

// ---------------------------------------------------------------------------------------------
// Payroll Profile -> trusted facts (document-first, Lock §5.2 / R2 §14)
// ---------------------------------------------------------------------------------------------

/** Only these profile states are VERIFIED document evidence. `user_confirmed` / `user_corrected` are user
 * decisions and are deliberately NOT promoted; `unknown` contributes nothing. */
const VERIFIED_PROFILE_STATES = new Set(['document_exact', 'corroborated']);

/** Accruing vakantiegeld is money-neutral and needs a mode the profile does not state - left out on purpose. */
const EXCLUDED_FROM_TRUST: ReadonlySet<ScenarioFieldPath> = new Set<ScenarioFieldPath>(['extras.vakantiegeld.percent']);

function profileRef(field: ProfileField, index = 0): string | undefined {
  const source = field.sources[index] ?? field.candidates[index]?.source;
  if (!source) return undefined;
  const s = source as { documentId?: string | null; documentIndex?: number | null };
  if (typeof s.documentId === 'string' && s.documentId.length > 0) return s.documentId.slice(0, 80);
  if (typeof s.documentIndex === 'number') return `doc-${s.documentIndex}`;
  return undefined;
}

function scenarioValue(field: ScenarioFieldPath, value: unknown): number | string | null {
  if (field === 'tax.loonheffingskorting') return typeof value === 'boolean' ? (value ? 'applied' : 'not_applied') : null;
  const spec = SCENARIO_FIELDS[field];
  return spec.kind === 'number' && typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Builds the trusted facts of a server-resolved Payroll Profile, through R1's own drift-guarded
 * profile -> Scenario consumption table (only `consumed` fields). */
export function trustedContextFromProfile(profile: PayrollProfile): TrustedContext {
  const facts: TrustedFact[] = [];
  const tables: Array<[Record<string, ProfileField>, Record<string, { status: string; scenarioField?: ScenarioFieldPath }>]> = [
    [profile.employment as Record<string, ProfileField>, EMPLOYMENT_FIELD_ENGINE],
    [profile.payroll as Record<string, ProfileField>, PAYROLL_FIELD_ENGINE],
  ];
  for (const [fields, table] of tables) {
    for (const [key, classification] of Object.entries(table)) {
      const target = classification.scenarioField;
      if (classification.status !== 'consumed' || !target || EXCLUDED_FROM_TRUST.has(target)) continue;
      const field = fields[key];
      if (!field) continue;
      if (VERIFIED_PROFILE_STATES.has(field.state)) {
        const value = scenarioValue(target, field.value);
        if (value === null) continue;
        const ref = profileRef(field);
        facts.push({ field: target, node: { state: 'known', value, source: 'document', ...(ref ? { ref } : {}) } });
      } else if (field.state === 'conflict') {
        const candidates: VerifiedConflict['candidates'] = [];
        const seen = new Set<string>();
        field.candidates.forEach((candidate, index) => {
          const value = scenarioValue(target, candidate.value);
          if (value === null || seen.has(String(value))) return;
          seen.add(String(value));
          const ref = profileRef(field, index);
          candidates.push({ value, source: 'document', ...(ref ? { ref } : {}) });
        });
        if (candidates.length >= 2) facts.push({ field: target, node: { state: 'conflict', candidates } });
      }
    }
  }
  return createTrustedContext(facts);
}

// ---------------------------------------------------------------------------------------------
// Checks and merge
// ---------------------------------------------------------------------------------------------

function sameOrigin(a: Record<string, unknown>, b: { value: unknown; source: string; ref?: string }): boolean {
  return canonicalJson(a.value) === canonicalJson(b.value) && a.source === b.source && (a.ref ?? undefined) === (b.ref ?? undefined);
}

function backedBy(ctx: TrustedContext | null, field: string, candidate: Record<string, unknown>): boolean {
  const fact = ctx?.facts.find((f) => f.field === field);
  if (!fact) return false;
  const pool = fact.node.state === 'known' ? [fact.node] : fact.node.candidates;
  return pool.some((p) => sameOrigin(candidate, p));
}

/** Every verified-source value in the Scenario that is NOT backed exactly by the trusted context. */
export function findUnbackedVerifiedValues(scenario: unknown, ctx: TrustedContext | null): Array<{ field: string; source: string }> {
  const out: Array<{ field: string; source: string }> = [];
  for (const field of SCENARIO_FIELD_PATHS) {
    const node = getAt(scenario, field);
    if (!isRecord(node)) continue;
    if (node.state === 'conflict' && Array.isArray(node.candidates)) {
      for (const candidate of node.candidates) {
        if (isRecord(candidate) && isVerifiedSource(candidate.source) && !backedBy(ctx, field, candidate)) out.push({ field, source: candidate.source });
      }
    } else if (isVerifiedSource(node.source)) {
      // ranges / alternatives are never produced by trusted context, so a verified one is always self-declared
      if (node.state !== 'known' || !backedBy(ctx, field, node)) out.push({ field, source: node.source });
    }
  }
  const concepts = isRecord(scenario) && Array.isArray(scenario.requestedConcepts) ? scenario.requestedConcepts : [];
  concepts.forEach((entry, index) => {
    if (isRecord(entry) && isVerifiedSource(entry.source)) out.push({ field: `requestedConcepts.${index}`, source: entry.source });
  });
  return out;
}

function userCandidates(node: unknown): Array<{ value: number | string; source: 'user' }> {
  if (!isRecord(node)) return [];
  if (node.state === 'known' && node.source === 'user' && (typeof node.value === 'number' || typeof node.value === 'string')) return [{ value: node.value, source: 'user' }];
  if (node.state === 'conflict' && Array.isArray(node.candidates)) {
    return node.candidates.filter((c): c is { value: number | string; source: 'user' } => isRecord(c) && c.source === 'user' && (typeof c.value === 'number' || typeof c.value === 'string'));
  }
  return [];
}

/**
 * Brings server-trusted facts into the Scenario, deterministically:
 *   - absent / unknown / Loonto assumption / user range or alternatives -> the trusted value (better evidence);
 *   - user value equal to the trusted value -> provenance upgraded to the trusted source (there IS evidence);
 *   - user value different -> conflict [trusted, user]: the user's statement is kept, nothing is erased;
 *   - already-present identical trusted value -> unchanged.
 */
export function mergeTrustedContext(scenario: ScenarioV1, ctx: TrustedContext): { scenario: ScenarioV1; notes: PatchNote[] } {
  let out = scenario;
  const notes: PatchNote[] = [];
  for (const fact of ctx.facts) {
    const existing = getAt(out, fact.field);
    const trustedPool = fact.node.state === 'known' ? [fact.node] : fact.node.candidates;
    const users = userCandidates(existing);
    const alreadyMerged = isRecord(existing) && (existing.state === 'known' ? backedBy(ctx, fact.field, existing) : existing.state === 'conflict' && Array.isArray(existing.candidates) && existing.candidates.some((c) => isRecord(c) && backedBy(ctx, fact.field, c)));
    if (alreadyMerged) continue;
    // The user already chose their own value over this document value with an explicit resolve_conflict
    // pick: re-raising the same conflict every turn would silently undo that explicit decision.
    if (isRecord(existing) && existing.state === 'known' && existing.source === 'user' && existing.ref === EXPLICIT_OVERRIDE_REF) continue;

    const extraUsers = users.filter((u) => !trustedPool.some((t) => canonicalJson(t.value) === canonicalJson(u.value)));
    if (fact.node.state === 'known' && users.length > 0 && extraUsers.length === 0) {
      out = withValueAt(out, fact.field, structuredClone(fact.node));
      notes.push({ code: 'trusted_value_upgraded', field: fact.field });
    } else if (extraUsers.length > 0 || fact.node.state === 'conflict') {
      // A conflict candidate is a bare origin {value, source, ref} - never a whole value node.
      const candidates = [...trustedPool.map((t) => ({ value: t.value, source: t.source, ...(t.ref ? { ref: t.ref } : {}) })), ...extraUsers];
      out = withValueAt(out, fact.field, candidates.length >= 2 ? { state: 'conflict', candidates } : structuredClone(fact.node));
      notes.push({ code: extraUsers.length > 0 ? 'trusted_value_conflicts_with_user' : 'trusted_value_added', field: fact.field });
    } else {
      out = withValueAt(out, fact.field, structuredClone(fact.node));
      notes.push({ code: 'trusted_value_added', field: fact.field });
    }
  }
  return { scenario: out, notes };
}
