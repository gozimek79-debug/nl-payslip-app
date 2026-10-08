/**
 * R0 (LOONTO-ARCHITECTURE-UX-LOCK-v1.1 §37): the developer Payroll Profile / extraction tables, the S5
 * "To resolve" panel and the legacy replay diagnostics are not part of the normal customer flow. They stay
 * available for internal diagnostics behind the URL flag `?diag=1`. No auth, no env var, no backend flag,
 * no visible toggle - temporary R0 access only.
 */
export function isDiagnosticsRequested(search: string): boolean {
  try {
    return new URLSearchParams(search).get('diag') === '1';
  } catch {
    return false;
  }
}

/** Read once (at mount) from the browser URL; false outside a browser. */
export function readDiagnosticsFlag(): boolean {
  return typeof window === 'undefined' ? false : isDiagnosticsRequested(window.location.search);
}
