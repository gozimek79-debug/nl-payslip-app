/**
 * R3-A (feature branch, owner review only): `/?r3a=1` opens the conversational UI demo on synthetic data. Every other
 * URL renders the existing application unchanged. This is a convenience switch for review - NOT a security boundary
 * (the demo holds no secret and calls no API).
 */
export function isR3aDemoRequested(search: string): boolean {
  try {
    return new URLSearchParams(search).get('r3a') === '1';
  } catch {
    return false;
  }
}
