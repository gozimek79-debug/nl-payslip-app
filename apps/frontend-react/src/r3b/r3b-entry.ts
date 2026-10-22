/**
 * AI-001 (owner-only Private Alpha): the Loonto module shell is the DEFAULT application again - all five modules, with
 * Kalkulator PRO opening the model-led AI advisor. Earlier versions stay reachable for rollback and comparison:
 *   `/`                      -> module shell (App.tsx), PRO = AI advisor
 *   `/?auth=...`             -> the same shell: its magic-link sign-in returns there with a notice
 *   `/?legacy=1`             -> the previous Loonto application exactly as it was (PRO = ProDocuments)
 *   `/?r3b=1` (`/?r3a=1`)    -> the R3-B document-first conversation (the previous default)
 *   `/?r3a=demo`             -> the earlier R3-A scripted demonstration (synthetic, no network)
 * These are routing conveniences, never access control - the whole deployment is protected by Vercel Authentication.
 */
export type AppEntry = 'shell' | 'legacy' | 'r3b' | 'r3a_demo';

export function appEntry(search: string): AppEntry {
  const params = new URLSearchParams(search);
  if (params.has('auth')) return 'shell';
  if (params.get('legacy') === '1') return 'legacy';
  if (params.get('r3a') === 'demo') return 'r3a_demo';
  if (params.get('r3b') === '1' || params.get('r3a') === '1') return 'r3b';
  return 'shell';
}
