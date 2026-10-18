import { isR3aDemoRequested } from '../r3a/r3a-entry.ts';

/**
 * The private owner-review entry points (Alpha). `/` stays the existing application for every other URL.
 *   `/?r3a=1`    -> R3-B: document-first conversation (real reader / Payroll Profile / R2 conversation)
 *   `/?r3a=demo` -> the earlier R3-A scripted demonstration, kept for comparison (synthetic, no network)
 */
export type AlphaEntry = 'r3b' | 'r3a_demo';

export function alphaEntry(search: string): AlphaEntry | null {
  if (isR3aDemoRequested(search)) return 'r3b';
  return new URLSearchParams(search).get('r3a') === 'demo' ? 'r3a_demo' : null;
}
