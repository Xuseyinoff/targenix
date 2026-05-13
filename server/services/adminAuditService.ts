/**
 * adminAuditService — append-only record of every admin-protected tRPC
 * mutation. Roadmap #12.
 *
 * Source of truth lives in `admin_audit_log`. This service exposes two
 * pieces of behaviour:
 *
 *   - `sanitizeAuditInput(value)` — defense-in-depth scrub for the input
 *     payload: strips keys that look like secrets, truncates strings,
 *     caps array length, and clamps the total serialized size. The audit
 *     row is structured forensic evidence — we never want to be the
 *     reason a credential leaked.
 *
 *   - `recordAdminAction(db, params)` — best-effort insert. Never throws.
 *     A failure to write the audit row is itself logged via the regular
 *     appLogger so an oncall can see "audit subsystem is down" without
 *     the audit subsystem trying to log to itself.
 *
 * The middleware wiring lives in `server/_core/trpc.ts`; this file is
 * deliberately oblivious to the tRPC type machinery so it can be unit-
 * tested without a tRPC harness.
 */

import type { DbClient } from "../db";
import { adminAuditLogs } from "../../drizzle/schema";
import { log } from "./appLogger";

// ─── Sanitization knobs ─────────────────────────────────────────────────────

/** Keys whose presence anywhere in the input causes the value to be replaced
 *  with the literal string "[REDACTED]". Keys are first normalized to
 *  alnum-lowercase (strip dashes/underscores/etc.) so "api_key", "apiKey",
 *  "API-KEY", and "ApiKey" all reduce to "apikey" and match the same
 *  canonical pattern. */
const SENSITIVE_KEY_PATTERNS = [
  "password",
  "secret",
  "token",
  "apikey",
  "credential",
  "private",
  "passcode",
  "authorization",
];

const MAX_STRING_LEN = 500;
const MAX_ARRAY_LEN = 50;
const MAX_SERIALIZED_BYTES = 8 * 1024; // 8 KB hard cap on the JSON payload
const MAX_DEPTH = 6;

/**
 * Recursively redact secrets and truncate large values. Returns a value
 * safe to serialize into the JSON column.
 */
export function sanitizeAuditInput(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function walk(v: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) return "[TRUNCATED depth]";
    if (v === null || v === undefined) return v;
    if (typeof v === "string") {
      return v.length > MAX_STRING_LEN ? v.slice(0, MAX_STRING_LEN) + "…" : v;
    }
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return String(v);
    if (typeof v === "function" || typeof v === "symbol") return undefined;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      const limit = Math.min(v.length, MAX_ARRAY_LEN);
      for (let i = 0; i < limit; i++) out.push(walk(v[i], depth + 1));
      if (v.length > MAX_ARRAY_LEN) out.push(`[…+${v.length - MAX_ARRAY_LEN} more]`);
      return out;
    }
    if (typeof v === "object") {
      if (seen.has(v as object)) return "[CIRCULAR]";
      seen.add(v as object);
      const obj: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (isSensitiveKey(k)) {
          obj[k] = "[REDACTED]";
        } else {
          obj[k] = walk(child, depth + 1);
        }
      }
      return obj;
    }
    return undefined;
  }

  const walked = walk(value, 0);
  return clampSerializedSize(walked);
}

function isSensitiveKey(key: string): boolean {
  const canonical = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PATTERNS.some((p) => canonical.includes(p));
}

/**
 * If JSON-stringified payload exceeds MAX_SERIALIZED_BYTES, replace with a
 * shape marker so the row remains insertable. The full payload is presumed
 * to be too noisy to capture in an audit log anyway; the row's path + admin
 * + timestamp are still useful for forensics.
 */
function clampSerializedSize(v: unknown): unknown {
  try {
    const serialized = JSON.stringify(v);
    if (serialized && Buffer.byteLength(serialized, "utf8") <= MAX_SERIALIZED_BYTES) {
      return v;
    }
    return { __truncated: true, bytes: Buffer.byteLength(serialized ?? "", "utf8") };
  } catch {
    return { __unserializable: true };
  }
}

// ─── Recording ──────────────────────────────────────────────────────────────

export interface RecordAdminActionParams {
  adminId: number;
  path: string;
  type: "mutation" | "query";
  input: unknown;
  resultStatus: "success" | "failure";
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Insert one audit row. Never throws — failures are logged via the regular
 * application log so oncall sees "audit broken" but the original admin
 * action still succeeds. Callers may `void`-discard the promise.
 */
export async function recordAdminAction(
  db: DbClient,
  params: RecordAdminActionParams,
): Promise<void> {
  try {
    const sanitizedInput = params.input === undefined
      ? null
      : (sanitizeAuditInput(params.input) as Record<string, unknown> | null);
    const errorMessage = params.errorMessage
      ? params.errorMessage.slice(0, 500)
      : null;
    const userAgent = params.userAgent ? params.userAgent.slice(0, 256) : null;
    const ipAddress = params.ipAddress ? params.ipAddress.slice(0, 64) : null;

    await db.insert(adminAuditLogs).values({
      adminId: params.adminId,
      path: params.path.slice(0, 128),
      type: params.type,
      input: sanitizedInput,
      resultStatus: params.resultStatus,
      errorCode: params.errorCode ?? null,
      errorMessage,
      durationMs: Math.max(0, Math.round(params.durationMs)),
      ipAddress,
      userAgent,
    });
  } catch (err) {
    void log.error(
      "SYSTEM",
      "Failed to write admin_audit_log row",
      {
        path: params.path,
        adminId: params.adminId,
        error: err instanceof Error ? err.message : String(err),
      },
      null,
      null,
      params.adminId,
    );
  }
}
