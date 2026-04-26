/**
 * Built-in function whitelist for the transform engine.
 *
 * All functions are pure (no side effects, no I/O).
 * Unknown function names → empty string (soft miss, same as unknown variables).
 *
 * Categories:
 *   Text    — upper, lower, trim, length, concat, replace, substring,
 *             splitAt, capitalize, padStart, padEnd
 *   Logic   — if, coalesce, isEmpty, not
 *   Phone   — stripPhone, formatPhone
 *   Math    — add, subtract, multiply, divide, round, floor, ceil, abs,
 *             toNumber, toString
 *   Date    — formatDate, now
 */

export type FnImpl = (args: string[], raw: unknown[]) => string;

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

export const FUNCTIONS: Record<string, FnImpl> = {
  // ── Text ────────────────────────────────────────────────────────────────
  upper:      ([a]) => str(a).toUpperCase(),
  lower:      ([a]) => str(a).toLowerCase(),
  trim:       ([a]) => str(a).trim(),
  length:     ([a]) => String(str(a).length),
  capitalize: ([a]) => {
    const s = str(a);
    return s.length === 0 ? "" : s[0]!.toUpperCase() + s.slice(1).toLowerCase();
  },

  concat: (args) => args.map(str).join(""),

  replace: ([a, search, rep = ""]) =>
    str(a).split(str(search)).join(str(rep)),

  substring: ([a, start, end]) => {
    const s = str(a);
    const st = Math.max(0, num(start));
    return end !== undefined ? s.slice(st, num(end)) : s.slice(st);
  },

  // split(str, separator) → returns first part. Use splitAt for a specific index.
  split: ([a, sep]) => str(a).split(str(sep))[0] ?? "",

  // splitAt(str, separator, index) → returns part at index
  splitAt: ([a, sep, idx]) => {
    const parts = str(a).split(str(sep));
    const i = Math.max(0, num(idx));
    return parts[i] ?? "";
  },

  padStart: ([a, len, pad = " "]) => str(a).padStart(num(len), str(pad) || " "),
  padEnd:   ([a, len, pad = " "]) => str(a).padEnd(num(len), str(pad) || " "),

  // ── Logic ────────────────────────────────────────────────────────────────
  /**
   * if(condition, trueValue, falseValue?)
   * Condition is truthy when it is not: "", "false", "0", undefined, null.
   * Works with binary expression results ("true" / "false" strings).
   */
  if: ([cond, trueVal, falseVal = ""]) => {
    const truthy = cond !== "" && cond !== "false" && cond !== "0";
    return truthy ? str(trueVal) : str(falseVal);
  },

  /** coalesce(a, b, …) — returns first non-empty argument. */
  coalesce: (args) => args.find((a) => str(a) !== "") ?? "",

  isEmpty: ([a]) => (str(a).trim() === "" ? "true" : "false"),

  not: ([a]) =>
    a === "" || a === "false" || a === "0" ? "true" : "false",

  // ── Phone ────────────────────────────────────────────────────────────────
  /** stripPhone(phone) → digits only, e.g. "+998 90 123-45-67" → "998901234567" */
  stripPhone: ([a]) => str(a).replace(/\D/g, ""),

  /**
   * formatPhone(phone, countryCode?)
   * Ensures the number starts with countryCode (default "998").
   * Strips non-digits, removes leading 0, prepends country code if missing.
   */
  formatPhone: ([a, country = "998"]) => {
    const digits = str(a).replace(/\D/g, "");
    const prefix = str(country);
    if (digits.startsWith(prefix)) return digits;
    if (digits.startsWith("0")) return prefix + digits.slice(1);
    if (digits.length <= 9) return prefix + digits;
    return digits;
  },

  // ── Math ─────────────────────────────────────────────────────────────────
  add:      ([a, b]) => String(num(a) + num(b)),
  subtract: ([a, b]) => String(num(a) - num(b)),
  multiply: ([a, b]) => String(num(a) * num(b)),
  divide:   ([a, b]) => {
    const d = num(b);
    return d === 0 ? "0" : String(num(a) / d);
  },
  round: ([a, decimals = "0"]) => {
    const factor = Math.pow(10, Math.max(0, num(decimals)));
    return String(Math.round(num(a) * factor) / factor);
  },
  floor:    ([a]) => String(Math.floor(num(a))),
  ceil:     ([a]) => String(Math.ceil(num(a))),
  abs:      ([a]) => String(Math.abs(num(a))),
  toNumber: ([a]) => String(num(a)),
  toString: (args: string[]) => str(args[0]),

  // ── Date ──────────────────────────────────────────────────────────────────
  /** now() → current UTC ISO timestamp */
  now: () => new Date().toISOString(),

  /**
   * formatDate(dateString, format?)
   * Tokens: YYYY MM DD HH mm SS
   * Default format: "DD.MM.YYYY"
   */
  formatDate: ([a, fmt = "DD.MM.YYYY"]) => {
    const d = new Date(str(a));
    if (isNaN(d.getTime())) return str(a);
    const p = (n: number) => String(n).padStart(2, "0");
    return str(fmt)
      .replace("YYYY", String(d.getFullYear()))
      .replace("MM",   p(d.getMonth() + 1))
      .replace("DD",   p(d.getDate()))
      .replace("HH",   p(d.getHours()))
      .replace("mm",   p(d.getMinutes()))
      .replace("SS",   p(d.getSeconds()));
  },
};

/** All registered function names — used by preview to detect unknown functions. */
export const FUNCTION_NAMES: ReadonlySet<string> = new Set(Object.keys(FUNCTIONS));
