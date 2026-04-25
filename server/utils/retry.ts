/**
 * Retry on failure. Backoff: 300ms * (attempt index). `max` = extra attempts after the first.
 */
export async function withRetry<T>(fn: () => Promise<T>, max = 2): Promise<T> {
  let lastErr: unknown;
  for (let n = 0; n <= max; n++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (n >= max) break;
      await new Promise((r) => setTimeout(r, 300 * (n + 1)));
    }
  }
  throw lastErr;
}
