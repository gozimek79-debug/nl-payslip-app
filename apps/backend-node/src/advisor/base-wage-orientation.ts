/**
 * AI-001C: the ONE money tool of the first advisor slice - a bounded, explicitly ORIENTATIONAL product
 * "hours x base hourly rate". It is not a payroll calculation: no premiums (weekend, night, overtime, holiday), no
 * holiday pay, no tax, no deductions, not gross pay, not net pay, not a legal entitlement. The result type says so and
 * the list of exclusions travels with every result.
 *
 * Decimal-safe: hours are taken in hundredths and the rate in cents (both must be exactly representable at that
 * precision), the product is integer arithmetic, rounded half-up to whole cents once. Inputs are bounded to normal
 * values; anything else is refused with a reason - never clamped or guessed.
 */

export const ORIENTATION_RESULT_TYPE = 'indicative_base_wage_only' as const;
export const ORIENTATION_EXCLUDES = ['weekend_night_overtime_holiday_premiums', 'holiday_pay_vakantiegeld', 'tax_loonheffing', 'deductions_pension_and_other', 'gross_and_net_pay'] as const;

export const MAX_WEEKLY_HOURS = 112;
export const MAX_HOURS_PER_DAY = 16;
export const MIN_RATE = 1;
export const MAX_RATE = 200;

export type OrientationRefusal = 'hours_not_whole_hundredths' | 'hours_out_of_range' | 'rate_not_whole_cents' | 'rate_out_of_range';

export interface OrientationResult {
  resultType: typeof ORIENTATION_RESULT_TYPE;
  hours: number;
  hourlyRate: number;
  amount: number;
  currency: 'EUR';
  excludes: typeof ORIENTATION_EXCLUDES;
}

function exactly(value: number, scale: number): number | null {
  const scaled = Math.round(value * scale);
  return Math.abs(scaled / scale - value) < 1e-9 ? scaled : null;
}

export function baseWageOrientation(hours: number, hourlyRate: number): { ok: true; result: OrientationResult } | { ok: false; reason: OrientationRefusal } {
  const hoursHundredths = exactly(hours, 100);
  if (hoursHundredths === null) return { ok: false, reason: 'hours_not_whole_hundredths' };
  if (hoursHundredths <= 0 || hoursHundredths > MAX_WEEKLY_HOURS * 100) return { ok: false, reason: 'hours_out_of_range' };
  const rateCents = exactly(hourlyRate, 100);
  if (rateCents === null) return { ok: false, reason: 'rate_not_whole_cents' };
  if (rateCents < MIN_RATE * 100 || rateCents > MAX_RATE * 100) return { ok: false, reason: 'rate_out_of_range' };
  // hundredths-of-hours x cents = 1/100 cent units; half-up to whole cents (both factors are positive).
  const centsTimes100 = hoursHundredths * rateCents;
  const amountCents = Math.floor((centsTimes100 + 50) / 100);
  return { ok: true, result: { resultType: ORIENTATION_RESULT_TYPE, hours: hoursHundredths / 100, hourlyRate: rateCents / 100, amount: amountCents / 100, currency: 'EUR', excludes: ORIENTATION_EXCLUDES } };
}
