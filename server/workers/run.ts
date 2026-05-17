/**
 * run.ts — Standalone BullMQ worker entry point.
 *
 * This process is deployed separately from the web server on Railway.
 * It is responsible for:
 *   1. Processing lead jobs from the BullMQ queue (Redis-backed)
 *   2. Running all background schedulers (retry, log retention, forms refresh)
 *
 * Web server (index.ts) does NOT run schedulers — only this process does.
 * This prevents duplicate scheduler runs when the web server scales to 2+ instances.
 *
 * Start command: node dist/worker.js
 */

import "dotenv/config";
import { installGlobalErrorHandlers } from "../_core/globalErrorHandlers";
// Install before any scheduler/worker boot so a stray rejection during
// startup is caught too. The handlers themselves no-op on Sentry calls
// until initSentry() runs inside boot() below.
installGlobalErrorHandlers("Worker");
import { initSentry, flushSentry } from "../monitoring/sentry";
import { createServer as createHttpServer } from "http";
import { sql } from "drizzle-orm";
import { startLeadWorker } from "./leadWorker";
import { startRetryScheduler } from "../services/retryScheduler";
import { startLogRetentionScheduler } from "../services/logRetentionScheduler";
import { startFormsRefreshScheduler } from "../services/formsRefreshScheduler";
import { startAdsSyncScheduler } from "../services/adsSyncScheduler";
import { startCrmSyncScheduler } from "../services/crmSyncScheduler";
import { startConnectionHealthScheduler } from "../services/connectionHealthScheduler";
import { startLeadPollingScheduler } from "../services/leadPollingService";
import { startTriggerScheduler } from "../services/triggerScheduler";
import { startOAuthStateCleanupScheduler, stopOAuthStateCleanupScheduler } from "../services/oauthStateCleanupScheduler";
import {
  startDestinationFlushScheduler,
  stopDestinationFlushScheduler,
} from "../services/destinationFlushScheduler";
import { startMetricSnapshotScheduler } from "../services/metricSnapshotScheduler";
import { startInsightsRollupScheduler } from "../services/insightsRollupScheduler";
import { startFxRateScheduler } from "../services/fxRateScheduler";
import { getDb } from "../db";
import { getRedisConnection } from "../queues/redisConnection";

if (!process.env.REDIS_URL) {
  console.error("[Worker] FATAL: REDIS_URL is required. Worker process cannot run without Redis.");
  process.exit(1);
}

/**
 * Minimal HTTP health server so Railway can detect hangs (not just crashes).
 * Uses Node's built-in `http` to avoid pulling Express into the worker
 * bundle. Honors `PORT` (Railway injects it) and falls back to
 * `WORKER_HEALTH_PORT` or 8080 for local dev. Logs but does NOT exit on
 * bind failure — a degraded health endpoint is preferable to a worker that
 * refuses to process jobs because port 8080 is taken locally.
 */
function startHealthServer(): void {
  const portRaw = process.env.PORT ?? process.env.WORKER_HEALTH_PORT ?? "8080";
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    console.warn(`[Worker] Health server disabled — invalid port "${portRaw}"`);
    return;
  }

  const server = createHttpServer(async (req, res) => {
    if (req.url !== "/health" && req.url !== "/api/health" && req.url !== "/") {
      res.statusCode = 404;
      res.end();
      return;
    }

    let dbOk = false;
    let redisOk = false;
    try {
      const db = await getDb();
      if (db) {
        await db.execute(sql`SELECT 1`);
        dbOk = true;
      }
    } catch {
      dbOk = false;
    }
    try {
      const conn = getRedisConnection();
      redisOk = (await conn.ping()) === "PONG";
    } catch {
      redisOk = false;
    }

    const healthy = dbOk && redisOk;
    res.statusCode = healthy ? 200 : 503;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        status: healthy ? "ok" : "degraded",
        role: "worker",
        dbConnected: dbOk,
        redisConnected: redisOk,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      }),
    );
  });

  server.on("error", (err) => {
    console.error("[Worker] Health server error:", err instanceof Error ? err.message : err);
  });

  server.listen(port, () => {
    console.log(`[Worker] Health endpoint listening on :${port}/health`);
  });
}

async function boot() {
  // Initialize Sentry FIRST so any boot-time error (DB connect failure,
  // scheduler arming, etc.) flows to telemetry. Without this, the
  // captureCritical() calls inside leadWorker.ts and the schedulers
  // would be silent no-ops in production — every BullMQ job error and
  // scheduler crash was being lost prior to this fix.
  // No-op when SENTRY_DSN is unset (local dev keeps working).
  await initSentry({ processTag: "worker" });

  // Verify DB is actually reachable before starting — if not, exit so Railway restarts us.
  // createPool/drizzle are lazy; this SELECT 1 proves the connection works.
  const db = await getDb();
  if (!db) {
    const candidates = [
      process.env.MYSQL_URL?.trim(),
      process.env.MYSQL_PUBLIC_URL?.trim(),
      process.env.DATABASE_URL?.trim(),
    ].filter(Boolean);
    console.error(
      "[Worker] FATAL: Cannot connect to database.",
      candidates.length === 0
        ? "No DB URL found (MYSQL_URL / MYSQL_PUBLIC_URL / DATABASE_URL)."
        : `Tried: ${candidates.map((u) => (u ?? "").replace(/:\/\/[^@]+@/, "://<hidden>@")).join(", ")} — connection failed.`
    );
    process.exit(1);
  }
  console.log("[Worker] Database connection verified.");

  // Bring up the health endpoint BEFORE workers/schedulers so Railway can
  // probe it during the rest of the boot sequence — avoids a race where
  // Railway thinks the service is unhealthy while schedulers are still
  // arming.
  startHealthServer();

  console.log("[Worker] Starting lead processing worker...");
  const worker = startLeadWorker();

  console.log("[Worker] Starting background schedulers...");
  startRetryScheduler();
  startLogRetentionScheduler();
  startFormsRefreshScheduler();
  startAdsSyncScheduler();
  startCrmSyncScheduler();
  // Sprint 5 / Item 5.3 — re-probes stale connections every 10 min so
  // expired/error states surface in the dashboard banner before deliveries
  // start failing.
  startConnectionHealthScheduler();
  // Zapier-style polling fallback: harmless no-op unless ENABLE_LEAD_POLLING=true.
  // When enabled, every 10 min it reconciles each active (user, page, form)
  // against Facebook and saves + dispatches any leadgen the webhook missed.
  startLeadPollingScheduler();
  startTriggerScheduler();
  // Universal oauth_states: hourly sweep of expired CSRF rows. Replaces the
  // per-provider hourly intervals removed in Sprint B Step 4.
  startOAuthStateCleanupScheduler();
  // Roadmap #7 phase C: persist failed_orders / oauth_errors / retry_queue
  // / failed_orders_db every 5 min so AdminMetrics has graphable history.
  startMetricSnapshotScheduler();
  // Insights Phase 1: rebuild fact_attribution_daily every 15 min over a
  // 7-day window. Reads leads/orders/campaign_insights → writes only the
  // rollup table; never modifies the source tables.
  startInsightsRollupScheduler();
  // Insights Phase 4: pull CBU USD/UZS rate every 6 hours so the rollup
  // worker has fresh FX data to convert cross-currency Revenue / Spend.
  startFxRateScheduler();
  // Yuboraman parity PR 4/4 Phase A: per-minute scan of
  // destination_schedules. Applies pause/start transitions at hour
  // boundaries; logs flush + TTL intent (Phase B will wire the actual
  // lead dispatch).
  startDestinationFlushScheduler();

  console.log("[Worker] All systems running. Waiting for jobs...");

  // Graceful shutdown
  async function shutdown(signal: string) {
    console.log(`[Worker] Received ${signal}, shutting down gracefully...`);
    // Cancel pending scheduler timers BEFORE worker.close() so an
    // in-flight setTimeout can't fire a cleanup query against a closing
    // DB. The other schedulers' timers are unref()'d and exit cleanly
    // when the process does; oauthStateCleanup uses an active timer
    // tied to msUntilNextHour() and needs explicit cancellation.
    stopOAuthStateCleanupScheduler();
    stopDestinationFlushScheduler();
    await worker.close();
    // Flush any in-flight Sentry events before exit so a deploy-triggered
    // SIGTERM doesn't drop the last few errors. Capped at 2s so a hung
    // Sentry never blocks Railway from cycling us.
    await flushSentry(2000);
    console.log("[Worker] Worker closed. Exiting.");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void boot();
