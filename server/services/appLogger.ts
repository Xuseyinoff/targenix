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
 */
import { appLogs, type InsertAppLog } from "../../drizzle/schema";
import { getDb } from "../db";

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
  | "GOOGLE";

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

  // Always mirror to console for dev visibility
  const consoleFn =
    level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  consoleFn(`[${category}${eventType ? `/${eventType}` : ""}] ${message}`, meta ?? "");

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
      meta: meta ?? null,
      userId: userId ?? null,
      leadId: leadId ?? null,
      pageId: pageId ?? null,
    };
    await db.insert(appLogs).values(entry);
  } catch {
    // Silently swallow DB errors so logging never breaks the main flow
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
