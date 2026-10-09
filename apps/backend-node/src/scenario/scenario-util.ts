import { createHash } from 'node:crypto';
import {
  WEEKDAY_KEYS,
  type NumberValue,
  type OvertimeDistribution,
  type WeekdayKey,
} from './scenario-types.js';

/**
 * Small pure helpers shared by the validator, the mapper and the evaluator. Nothing here is payroll
 * arithmetic: it addresses fields, makes JSON canonical, classifies a value's state, and ALLOCATES hours
 * to day cells. Allocation moves hours around - it never prices them (pricing is the engine's job).
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

export function getAt(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split('.')) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

/** Returns a deep copy of `root` with `path` set to `value` (intermediate objects are created). */
export function withValueAt<T>(root: T, path: string, value: unknown): T {
  const copy = structuredClone(root) as Record<string, unknown>;
  const keys = path.split('.');
  let node = copy;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (!isRecord(next)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1] as string] = value;
  return copy as T;
}

// ---------------------------------------------------------------------------------------------
// Canonical JSON + digest (engine-input digest, deterministic normalisation)
// ---------------------------------------------------------------------------------------------

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Value states
// ---------------------------------------------------------------------------------------------

/** What the Scenario says about a field, independent of its numeric content. */
export type ValueStatus = 'missing' | 'unknown' | 'conflict' | 'present';

export function valueStatus(value: unknown): ValueStatus {
  if (value === undefined || value === null) return 'missing';
  if (!isRecord(value)) return 'present'; // malformed - the validator reports it, relevance logic treats it as present
  if (value.state === 'unknown') return 'unknown';
  if (value.state === 'conflict') return 'conflict';
  return 'present';
}

/** Every number a NumberValue may take (known value, both range ends, every conflict candidate). */
export function numericEndpoints(value: unknown): number[] {
  if (!isRecord(value)) return [];
  if (value.state === 'known' && typeof value.value === 'number') return [value.value];
  if (value.state === 'range') return [value.low, value.high].filter((n): n is number => typeof n === 'number');
  if (value.state === 'conflict' && Array.isArray(value.candidates)) {
    return value.candidates.map((c) => (isRecord(c) ? c.value : undefined)).filter((n): n is number => typeof n === 'number');
  }
  return [];
}

/** Does a category contribute work? `none` (absent or zero), `some` (can be positive), `unknown` (a
 * value is required but not given/resolved - the field itself is then the requirement). */
export type Relevance = 'none' | 'some' | 'unknown';

export function hoursRelevance(value: NumberValue | undefined): Relevance {
  const status = valueStatus(value);
  if (status === 'missing') return 'none';
  if (status === 'unknown' || status === 'conflict') return 'unknown';
  const high = Math.max(...numericEndpoints(value));
  return Number.isFinite(high) && high > 0 ? 'some' : 'none';
}

// ---------------------------------------------------------------------------------------------
// Hour allocation
// ---------------------------------------------------------------------------------------------

const MICRO = 1_000_000;

/** Splits `total` into `parts` shares whose sum is EXACTLY `total` in micro-hours (no float drift in the
 * allocation itself); the first `remainder` shares carry one extra micro-hour. */
export function splitEvenly(total: number, parts: number): number[] {
  const micro = Math.round(total * MICRO);
  const base = Math.floor(micro / parts);
  const remainder = micro - base * parts;
  return Array.from({ length: parts }, (_, i) => (base + (i < remainder ? 1 : 0)) / MICRO);
}

export interface WeekdayHours {
  regular: number;
  overtime: number;
}

/** Allocates weekday regular and overtime hours to Monday-Friday cells. Regular hours are priced flat, so
 * how they are spread cannot change any amount (verified by test); overtime is tiered per day by the
 * engine, so its allocation follows the (visible, editable) distribution. Callers guarantee a
 * distribution whenever overtime > 0. */
export function expandWeekdayHours(regular: number, overtime: number, distribution: OvertimeDistribution | null): Record<WeekdayKey, WeekdayHours> {
  const regularShares = splitEvenly(regular, WEEKDAY_KEYS.length);
  let overtimeShares: number[] = WEEKDAY_KEYS.map(() => 0);
  if (overtime > 0 && distribution) {
    if (distribution.kind === 'even') {
      const days = splitEvenly(overtime, distribution.days);
      overtimeShares = WEEKDAY_KEYS.map((_, i) => days[i] ?? 0);
    } else {
      overtimeShares = WEEKDAY_KEYS.map((day) => distribution.byDay[day]);
    }
  }
  const out = {} as Record<WeekdayKey, WeekdayHours>;
  WEEKDAY_KEYS.forEach((day, i) => {
    out[day] = { regular: regularShares[i] ?? 0, overtime: overtimeShares[i] ?? 0 };
  });
  return out;
}

/** Public-holiday hours go into their own bucket of day cells (each <= 24 h, filled in order). Holiday
 * hours are flat-priced by the engine regardless of the day they sit on, so the cell layout is
 * money-neutral. */
export function holidayDayCells(hours: number): number[] {
  const cells: number[] = [];
  let remainingMicro = Math.round(hours * MICRO);
  while (remainingMicro > 0) {
    const take = Math.min(remainingMicro, 24 * MICRO);
    cells.push(take / MICRO);
    remainingMicro -= take;
  }
  return cells;
}
