/**
 * Lower-case alpha-num slug used for `appKey` and similar identifiers.
 *
 * Output is guaranteed to match `/^[a-z0-9][a-z0-9_-]{0,maxLen-1}$/` or to be
 * the empty string when the input has no usable characters. Callers must
 * handle the empty-string case (typically with a "name is required" error).
 */
export function slugifyAppKey(input: string, opts?: { maxLen?: number }): string {
  const max = Math.max(1, opts?.maxLen ?? 64);
  return input
    .toLowerCase()
    .normalize("NFKD")
    // collapse any non [a-z0-9_-] run into a single hyphen
    .replace(/[^a-z0-9_-]+/g, "-")
    // collapse consecutive separators
    .replace(/[-_]{2,}/g, "-")
    // trim leading/trailing separators (regex must start with [a-z0-9])
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, max);
}
