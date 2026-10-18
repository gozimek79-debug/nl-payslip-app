/**
 * R3-B.1 (owner-only Private Alpha on the canonical URL): R3-B is the DEFAULT application at `/`.
 *   `/`                      -> R3-B document-first conversation (also the old `/?r3a=1` links)
 *   `/?legacy=1`             -> the previous Loonto application (temporary fallback for the owner)
 *   `/?auth=...`             -> the previous application too: its magic-link sign-in returns there with a notice
 *   `/?r3a=demo`             -> the earlier R3-A scripted demonstration (synthetic, no network)
 * These are routing conveniences, never access control - the whole deployment is protected by Vercel Authentication.
 */
export type AppEntry = 'r3b' | 'r3a_demo' | 'legacy';

export function appEntry(search: string): AppEntry {
  const params = new URLSearchParams(search);
  if (params.get('legacy') === '1' || params.has('auth')) return 'legacy';
  return params.get('r3a') === 'demo' ? 'r3a_demo' : 'r3b';
}
