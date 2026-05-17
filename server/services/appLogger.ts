/**
 * appLogger.ts
 * Lightweight structured logger that writes to the `app_logs` DB table.
 * Falls back to console.* if the DB is unavailable (never throws).
 *
 * Fields:
 *   userId    — owner of the log; auto-sets logType = 'USER' when present
 *   logType   — 'USER' | 'SYSTEM' (auto-assigned; override only when needed)
 *   eventType — structured event name: 'lead_received', 'sent_to_telegram', etc.
 *   source    — origin: 'facebook' | 'retry' | 'manual' | 'system'
 *   duration  — elapsed ms for timed operations
 *   meta      — arbitrary JSON (request body, response, stack trace, etc.)
 *
 * Secret redaction: every `meta` payload is walked by `redactSecrets()`
 * BEFORE it lands in the DB, the console, or Sentry. Any property whose
 * KEY matches a sensitive-name pattern (password, secret, token, api_key,
 * authorization, cookie, bearer, …) is replaced with `"[REDACTED]"`
 * regardless of value type. This is defense in depth — today no caller
 * deliberately logs secrets, but the redaction guarantees that an
 * accidental `log.error("HTTP", "...", { headers })` cannot leak an
 * Authorization header. Mirrors the redaction list in the HTTP request
 * logger (`server/_core/index.ts`).
 */
import { appLogs, type InsertAppLog } from "../../drizzle/schema";
import { getDb } from "../db";

/**
 * Regex of property keys whose values must be redacted from logs.
 * Union of the historical HTTP request-body redaction list
 * (password / currentPassword / newPassword / confirmNewPassword / token /
 * secret / accessToken) and AUDIT_REPORT.md F.6 recommended additions
 * (apiKey / refreshToken / authorization / cookie / bearer /
 * clientSecret). Case-insensitive, substring-match against the key name.
 */
const SECRET_KEY_RE =
  /password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|bearer|client[_-]?secret/i;

/**
 * Walks `value` and returns a deep copy with every secret-shaped key's
 * value replaced by `"[REDACTED]"`. Pass-through for non-object inputs.
 * Cycle-safe via a WeakSet.
 */
export function redactSecrets(value: unknown, _seen?: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  const seen = _seen ?? new WeakSet<object>();
  if (seen.has(value as object)) return "[CIRCULAR]";
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k)) {
      // Redact regardless of value type — an object literal under a
      // secret-shaped key (e.g. `secrets: { aws: "..." }`) must NOT be
      // walked into, or the secret leaks through the nested keys.
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactSecrets(v, seen);
    }
  }
  return out;
}

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";
export type LogCategory =
  | "WEBHOOK"
  | "LEAD"
  | "ORDER"
  | "SYSTEM"
  | "HTTP"
  | "FACEBOOK"
  | "TELEGRAM"
  | "AFFILIATE"
  | "GOOGLE"
  | "OAUTH"
  | "CONNECTIONS"
  | "WORKFLOW"
  /**
   * Multi-tenant security violations (owner mismatches, cross-tenant
   * credential exposure attempts, etc.). Always paired with log.error so
   * the AdminLogs page and any future SIEM / pager integration fires
   * loudly — silent fallbacks are how breaches get missed.
   */
  | "SECURITY";

export type LogType = "USER" | "SYSTEM";

/** Structured event names for observability */
export type EventType =
  | "lead_received"
  | "lead_saved"
  | "lead_enriched"
  | "lead_routing_matched"
  | "lead_routing_skipped"
  | "sent_to_affiliate"
  | "sent_to_telegram"
  | "sent_to_target_website"
  | "order_created"
  | "order_updated"
  | "webhook_verified"
  | "webhook_rejected"
  | "webhook_dispatched"
  | "facebook_token_validated"
  | "facebook_leads_fetched"
  | "retry_triggered"
  | "error"
  | string; // allow ad-hoc event types

export type LogSource = "facebook" | "retry" | "manual" | "system" | string;

export interface LogEventParams {
  level?: LogLevel;
  category: LogCategory;
  /** Structured event type for observability */
  eventType?: EventType;
  /** Source of the event */
  source?: LogSource;
  /** Duration in milliseconds for timed operations */
  duration?: number;
  /** Human-readable message */
  message: string;
  /** Arbitrary structured metadata (response body, error stack, etc.) */
  meta?: Record<string, unknown> | null;
  /** Owner of this log — auto-sets logType = 'USER' when provided */
  userId?: number | null;
  /** Override logType; defaults to 'USER' if userId present, else 'SYSTEM' */
  logType?: LogType;
  /** Optional reference to a lead */
  leadId?: number | null;
  /** Optional reference to a page */
  pageId?: string | null;
}

/**
 * Write a structured log entry to the database.
 * Never throws — logs to console as fallback.
 */
export async function logEvent(params: LogEventParams): Promise<void> {
  const {
    level = "INFO",
    category,
    eventType,
    source,
    duration,
    message,
    meta,
    userId,
    leadId,
    pageId,
  } = params;

  // Auto-assign logType: USER if userId present, SYSTEM otherwise
  const logType: LogType = params.logType ?? (userId != null ? "USER" : "SYSTEM");

  // Redact secret-shaped keys from the caller's meta before any sink
  // touches it. Defense in depth: today no caller deliberately logs a
  // secret, but `log.error("HTTP", msg, { headers })` would otherwise
  // smuggle an Authorization header through every path below.
  const safeMeta = redactSecrets(meta ?? null) as Record<string, unknown> | null;

  // Pull the ambient trace id off the AsyncLocalStorage if one is active
  // (set by the HTTP middleware, scheduler wrappers, or worker wrappers).
  // Stamped on every emitted row so an operator can grep `app_logs.meta`
  // for the entire chain of work behind a single request / tick / job.
  // Import is lazy to keep the requestContext module out of any boot-time
  // import cycles through appLogger.
  let traceId: string | undefined;
  try {
    const { getTraceId } = await import("../lib/requestContext");
    traceId = getTraceId();
  } catch {
    traceId = undefined;
  }
  const enrichedMeta: Record<string, unknown> | null = traceId
    ? { ...(safeMeta ?? {}), traceId }
    : safeMeta;

  // Always mirror to console for dev visibility
  const consoleFn =
    level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  const traceTag = traceId ? ` ${traceId}` : "";
  consoleFn(`[${category}${eventType ? `/${eventType}` : ""}${traceTag}] ${message}`, safeMeta ?? "");

  try {
    const db = await getDb();
    if (!db) return;
    const entry: InsertAppLog = {
      level,
      logType,
      category,
      eventType: eventType ?? null,
      source: source ?? null,
      duration: duration ?? null,
      message,
      meta: enrichedMeta,
      userId: userId ?? null,
      leadId: leadId ?? null,
      pageId: pageId ?? null,
    };
    await db.insert(appLogs).values(entry);
  } catch {
    // Silently swallow DB errors so logging never breaks the main flow
  }

  // Sprint 5 / Item 5.1 — escalate SECURITY logs to Sentry. Tenant-boundary
  // violations (Sprint 2.3) must page operators, not just sit in the
  // AdminLogs feed. ERROR-level SECURITY rows are the only ones promoted
  // — INFO / WARN under SECURITY stay local (audit-only).
  if (category === "SECURITY" && level === "ERROR") {
    try {
      const { captureSecurityEvent } = await import("../monitoring/sentry");
      captureSecurityEvent(message, {
        tags: { eventType: eventType ?? "unknown" },
        user: userId != null ? { id: userId } : undefined,
        extra: { meta: safeMeta, leadId, pageId },
      });
    } catch {
      // ignore — telemetry never breaks the main flow
    }
  }
}

/**
 * Convenience wrappers — positional args for quick calls.
 * For full observability fields (eventType, source, duration), use logEvent() directly.
 */
export const log = {
  info: (
    category: LogCategory,
    message: string,
    meta?: Record<string, unknown> | null,
    leadId?: number | null,
    pageId?: string | null,
    userId?: number | null,
    eventType?: EventType,
    source?: LogSource,
    duration?: number,
  ) => logEvent({ level: "INFO", category, message, meta, userId, leadId, pageId, eventType, source, duration }),

  warn: (
    category: LogCategory,
    message: string,
    meta?: Record<string, unknown> | null,
    leadId?: number | null,
    pageId?: string | null,
    userId?: number | null,
    eventType?: EventType,
    source?: LogSource,
    duration?: number,
  ) => logEvent({ level: "WARN", category, message, meta, userId, leadId, pageId, eventType, source, duration }),

  error: (
    category: LogCategory,
    message: string,
    meta?: Record<string, unknown> | null,
    leadId?: number | null,
    pageId?: string | null,
    userId?: number | null,
    eventType?: EventType,
    source?: LogSource,
    duration?: number,
  ) => logEvent({ level: "ERROR", category, message, meta, userId, leadId, pageId, eventType, source, duration }),

  debug: (
    category: LogCategory,
    message: string,
    meta?: Record<string, unknown> | null,
    leadId?: number | null,
    pageId?: string | null,
    userId?: number | null,
    eventType?: EventType,
    source?: LogSource,
    duration?: number,
  ) => logEvent({ level: "DEBUG", category, message, meta, userId, leadId, pageId, eventType, source, duration }),
};
