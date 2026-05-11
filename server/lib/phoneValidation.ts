/**
 * Permissive phone pre-validation. Catches *obviously broken* numbers before
 * we burn a partner API round-trip on them. Intentionally permissive: we
 * don't try to enforce per-country rules here (e.g. "100k.uz wants UZ only")
 * because that decision belongs to the partner and varies per destination.
 *
 * What we catch (cheap to detect, expensive if it slips through):
 *   - empty / null / whitespace-only input
 *   - fewer than 7 digits after stripping non-digit characters (truncated
 *     numbers are very common from misconfigured forms)
 *   - more than 15 digits (the E.164 hard limit — `+9992023509168874` style
 *     mangled inputs are real prod data)
 *
 * What we do NOT enforce (would cause false rejections):
 *   - country code (partners disagree on which they accept)
 *   - operator code (telecoms add new ones over time)
 *   - formatting (some partners normalise, others don't)
 *
 * Tested against real Railway prod failure samples; see
 * orderRetryPolicy.test.ts for similar style.
 */

export type PhoneCheckResult =
  | { valid: true }
  | { valid: false; reason: "empty" | "too_short" | "too_long" | "no_digits" };

const MIN_DIGITS = 7;  // shortest realistic phone (some country short codes)
const MAX_DIGITS = 15; // E.164 hard limit

export function checkPhone(phone: string | null | undefined): PhoneCheckResult {
  if (phone == null) return { valid: false, reason: "empty" };
  const trimmed = String(phone).trim();
  if (trimmed === "") return { valid: false, reason: "empty" };

  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length === 0) return { valid: false, reason: "no_digits" };
  if (digits.length < MIN_DIGITS) return { valid: false, reason: "too_short" };
  if (digits.length > MAX_DIGITS) return { valid: false, reason: "too_long" };

  return { valid: true };
}

/**
 * Convenience: synthetic delivery result for a pre-validation rejection.
 * Same shape the adapters return so callers don't need a special branch.
 */
export function syntheticInvalidPhoneResult(reason: string): {
  success: false;
  error: string;
  errorType: "validation";
  durationMs: 0;
} {
  return {
    success: false,
    error: `Pre-check: phone format invalid (${reason})`,
    errorType: "validation",
    durationMs: 0,
  };
}
