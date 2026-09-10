/**
 * Shared regex safety net for free-text fields returned by a vision-model extraction (audit R7/J3).
 * Used on both the contract path (contract-client.ts) and the payslip path (ocr-client.ts) - a
 * schema listing only the fields we want doesn't stop a model from stuffing PII into a free-text
 * field like a line-item description; this catches it independently of prompt compliance.
 */
export const BSN_PATTERN = /\b\d{9}\b/;
export const IBAN_PATTERN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/i;
export const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
export const PHONE_PATTERN = /\b(?:\+?31|0)[\s-]?6[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{2}\b/;

export function matchesPii(value: string): boolean {
  return BSN_PATTERN.test(value) || IBAN_PATTERN.test(value) || EMAIL_PATTERN.test(value) || PHONE_PATTERN.test(value);
}

/** Returns the value unchanged, or null (with `fieldName` pushed onto `redacted`) if it matches a PII pattern. */
export function sanitizeText(value: unknown, fieldName: string, redacted: string[]): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (matchesPii(value)) {
    redacted.push(fieldName);
    return null;
  }
  return value.trim();
}
