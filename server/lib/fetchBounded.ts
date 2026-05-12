/**
 * Bounded response-body reading helpers.
 *
 * The HTTP delivery adapters POST to user-supplied destination URLs. Without
 * a body size cap, a hostile target can return an unbounded response (or
 * just a very large legitimate one) and OOM the worker. Both adapters now
 * read the body through `readBoundedJson` which aborts the stream once the
 * cap is hit.
 *
 * Default cap (1 MiB) is generous for JSON API responses — Stripe, HubSpot,
 * Bitrix24, Telegram all return < 10 KiB on a typical lead-create call.
 */

const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Read `res.body` up to `maxBytes` and JSON-parse it. Returns `null` on
 * empty / non-JSON content. Throws when the stream exceeds the cap.
 */
export async function readBoundedJson(
  res: Response,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<unknown> {
  // Fast-path: if Content-Length advertises a size over the cap, refuse
  // before reading any bytes.
  const cl = res.headers.get("content-length");
  if (cl) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`Response body exceeds ${maxBytes} bytes (Content-Length=${n})`);
    }
  }

  if (!res.body) {
    // Some non-HTTP/2 stacks may report no body — fall back to text() which
    // is bounded by Undici's default `bodyTimeout`/`bodyMaxSize`.
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new Error(`Response body exceeds ${maxBytes} bytes`);
    }
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  if (total === 0) return null;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  const text = new TextDecoder("utf-8").decode(buf);
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}
