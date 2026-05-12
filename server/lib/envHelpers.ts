/**
 * Shared parsers for `process.env.*` values.
 *
 * Previously duplicated across `orderRetryPolicy.ts`, `retryScheduler.ts`,
 * `orderRetryScheduler.ts`, `connectionHealthScheduler.ts`,
 * `webhookRateLimit.ts`, `password.ts`, etc. — each with its own subtle
 * quirks (some accepted `0`, some didn't; some trimmed, some didn't). This
 * module is the single canonical implementation; new code should consume
 * these helpers rather than re-implementing the regex-and-Number-dance.
 *
 * Conventions:
 *   - All helpers return the `fallback` when the env var is missing,
 *     empty, or fails parsing — never throw. Callers should never have
 *     to wrap reads in try/catch.
 *   - Numeric parsers reject 0 and negatives unless explicitly noted;
 *     a "limit of 0" is almost always a typo.
 *   - Booleans accept: `1`, `true`, `yes`, `on` (case-insensitive).
 *     Anything else parses as `false`.
 */

/**
 * Parse a positive integer from env; fall back to `fallback` when the var
 * is unset, empty, non-numeric, or non-positive.
 */
export function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse a non-negative integer (zero is allowed). Useful for "disable
 * this feature by setting it to 0" knobs (e.g. concurrency caps).
 */
export function envIntNonNegative(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Parse a comma-separated list of positive integers. Malformed entries
 * are logged via console.warn and skipped, never poison the whole list.
 *
 * Example: `MULTI_DEST_USER_IDS=1,42,100,bogus` → `[1, 42, 100]` (with one
 * warning).
 */
export function envIntList(key: string): number[] {
  const raw = process.env[key];
  if (!raw) return [];
  const out: number[] = [];
  for (const chunk of raw.split(",")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      out.push(n);
    } else {
      console.warn(
        `[envHelpers] Ignoring non-numeric entry "${trimmed}" in env var ${key}`,
      );
    }
  }
  return out;
}

/** Parse a boolean-ish env value. Defaults to `false` when unset/empty. */
export function envBool(key: string, fallback = false): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

/**
 * Read a trimmed string. Returns `fallback` (default empty string) when
 * the var is missing or contains only whitespace.
 */
export function envString(key: string, fallback = ""): string {
  const raw = process.env[key];
  if (raw == null) return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}
