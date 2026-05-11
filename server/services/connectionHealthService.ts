/**
 * connectionHealthService — Phase 8 of the Make.com-style refactor.
 *
 * Per-provider health checks and OAuth token refresh logic.
 * Called by connectionsRouter.verify (manual) and future scheduled jobs.
 *
 * Design principles:
 *   • Never throws — always returns a HealthCheckResult
 *   • Writes audit rows to connection_health_logs
 *   • Updates connections.status + lastVerifiedAt on every check
 *   • Google refresh is best-effort: on invalid_grant, marks as expired
 */

import { eq } from "drizzle-orm";
import type { DbClient } from "../db";
import { connections, connectionHealthLogs, oauthTokens } from "../../drizzle/schema";
import { decrypt } from "../encryption";
import { log } from "./appLogger";

export interface HealthCheckResult {
  ok:         boolean;
  latencyMs:  number;
  error?:     string;
  newStatus:  "active" | "expired" | "error";
  /** true when an OAuth token was refreshed as part of this check */
  tokenRefreshed?: boolean;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function verifyConnectionHealth(
  db: DbClient,
  connectionId: number,
  userId: number,
): Promise<HealthCheckResult> {
  const [conn] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  if (!conn) {
    return { ok: false, latencyMs: 0, error: "Connection not found", newStatus: "error" };
  }

  let result: HealthCheckResult;

  switch (conn.type) {
    case "google_sheets":
      result = await checkGoogle(db, conn);
      break;
    case "telegram_bot":
      result = await checkTelegram(conn);
      break;
    case "api_key":
    case "oauth2":
    default:
      result = { ok: true, latencyMs: 0, newStatus: "active" };
      break;
  }

  // Persist result
  const newStatus = result.ok ? "active" : result.newStatus;
  const prevStatus = conn.status;
  await db
    .update(connections)
    .set({ status: newStatus, lastVerifiedAt: new Date() })
    .where(eq(connections.id, connectionId));

  // Write audit log (granular per-check)
  try {
    await db.insert(connectionHealthLogs).values({
      connectionId,
      userId,
      checkStatus:  result.ok ? "ok" : result.newStatus,
      latencyMs:    result.latencyMs,
      errorMessage: result.error?.slice(0, 500) ?? null,
    });
  } catch (e) {
    // non-blocking — don't fail the check just because the log write failed
    void log.warn("CONNECTIONS", "health log write failed", { connectionId, err: String(e) });
  }

  // Sprint 5 / Item 5.3 — emit a `connection_events` row only when the
  // status TRANSITIONS. Per-check rows live in `connection_health_logs`;
  // the events table is reserved for state changes the UI cares about
  // (banner, history timeline). Skipping no-op events keeps the audit
  // signal-to-noise high.
  if (newStatus !== prevStatus) {
    const { appendConnectionEvent } = await import("./connectionEventsService");
    void appendConnectionEvent(db, {
      connectionId,
      userId,
      eventType: result.ok ? "status_changed" : "health_check_failed",
      source: "system",
      details: {
        from: prevStatus,
        to: newStatus,
        latencyMs: result.latencyMs,
        error: result.error?.slice(0, 500) ?? null,
        tokenRefreshed: result.tokenRefreshed ?? false,
      },
    });
  }

  return { ...result, newStatus };
}

// ─── Google Sheets ────────────────────────────────────────────────────────────

async function checkGoogle(
  dbClient: DbClient,
  conn: { id: number; oauthTokenId: number | null },
): Promise<HealthCheckResult> {
  if (!conn.oauthTokenId) {
    return { ok: false, latencyMs: 0, error: "No OAuth token linked", newStatus: "error" };
  }

  const [token] = await dbClient
    .select({
      id:           oauthTokens.id,
      accessToken:  oauthTokens.accessToken,
      refreshToken: oauthTokens.refreshToken,
      expiryDate:   oauthTokens.expiryDate,
    })
    .from(oauthTokens)
    .where(eq(oauthTokens.id, conn.oauthTokenId))
    .limit(1);

  if (!token) {
    return { ok: false, latencyMs: 0, error: "OAuth token row missing", newStatus: "expired" };
  }

  const now = Date.now();
  const isExpired = token.expiryDate ? token.expiryDate.getTime() < now : false;

  // Try refresh if expired and we have a refresh token
  if (isExpired && token.refreshToken) {
    const refreshed = await refreshGoogleToken(token.refreshToken);
    if (refreshed.ok && refreshed.accessToken) {
      // Update the oauth_tokens row
      await dbClient
        .update(oauthTokens)
        .set({
          accessToken: refreshed.accessToken,
          expiryDate:  refreshed.expiryDate ?? null,
        })
        .where(eq(oauthTokens.id, token.id));

      return { ok: true, latencyMs: refreshed.latencyMs, newStatus: "active", tokenRefreshed: true };
    }
    // Refresh failed — mark expired
    return {
      ok: false, latencyMs: refreshed.latencyMs,
      error: refreshed.error ?? "Token refresh failed",
      newStatus: "expired",
    };
  }

  if (isExpired) {
    return { ok: false, latencyMs: 0, error: "Access token expired (no refresh token)", newStatus: "expired" };
  }

  // Token not expired — verify with a lightweight API ping
  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token.accessToken)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const latencyMs = Date.now() - t0;
    if (res.ok) {
      return { ok: true, latencyMs, newStatus: "active" };
    }
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    return {
      ok: false, latencyMs,
      error: String(body.error_description ?? body.error ?? `HTTP ${res.status}`),
      newStatus: "expired",
    };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(e), newStatus: "error" };
  }
}

// ─── Google OAuth token refresh ───────────────────────────────────────────────

interface RefreshResult {
  ok:           boolean;
  latencyMs:    number;
  accessToken?: string;
  expiryDate?:  Date;
  error?:       string;
}

async function refreshGoogleToken(refreshToken: string): Promise<RefreshResult> {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { ok: false, latencyMs: 0, error: "Google OAuth credentials not configured" };
  }

  const t0 = Date.now();
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type:    "refresh_token",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - t0;
    const body = await res.json() as Record<string, unknown>;

    if (!res.ok || body.error) {
      return { ok: false, latencyMs, error: String(body.error_description ?? body.error ?? `HTTP ${res.status}`) };
    }

    const accessToken = typeof body.access_token === "string" ? body.access_token : undefined;
    const expiresIn   = typeof body.expires_in === "number" ? body.expires_in : 3600;
    const expiryDate  = new Date(Date.now() + expiresIn * 1000);

    return { ok: true, latencyMs, accessToken, expiryDate };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(e) };
  }
}

// ─── Telegram Bot ─────────────────────────────────────────────────────────────

async function checkTelegram(
  conn: { credentialsJson: unknown },
): Promise<HealthCheckResult> {
  const creds = (conn.credentialsJson ?? {}) as Record<string, unknown>;
  const botTokenEncrypted = typeof creds.botTokenEncrypted === "string" ? creds.botTokenEncrypted : null;

  if (!botTokenEncrypted) {
    return { ok: false, latencyMs: 0, error: "Bot token missing", newStatus: "error" };
  }

  let botToken: string;
  try {
    botToken = decrypt(botTokenEncrypted);
  } catch (e) {
    return { ok: false, latencyMs: 0, error: "Failed to decrypt bot token", newStatus: "error" };
  }

  const t0 = Date.now();
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getMe`,
      { signal: AbortSignal.timeout(8_000) },
    );
    const latencyMs = Date.now() - t0;
    const body = await res.json() as Record<string, unknown>;

    if (body.ok === true) {
      return { ok: true, latencyMs, newStatus: "active" };
    }
    return {
      ok: false, latencyMs,
      error: String(body.description ?? `HTTP ${res.status}`),
      newStatus: "error",
    };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(e), newStatus: "error" };
  }
}

// ─── Recent health logs ───────────────────────────────────────────────────────

export async function getRecentHealthLogs(
  dbClient: DbClient,
  connectionId: number,
  limit = 10,
) {
  const { desc } = await import("drizzle-orm");
  return dbClient
    .select()
    .from(connectionHealthLogs)
    .where(eq(connectionHealthLogs.connectionId, connectionId))
    .orderBy(desc(connectionHealthLogs.checkedAt))
    .limit(limit);
}
