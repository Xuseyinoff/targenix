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
import { startLeadWorker } from "./leadWorker";
import { startRetryScheduler } from "../services/retryScheduler";
import { startLogRetentionScheduler } from "../services/logRetentionScheduler";
import { startFormsRefreshScheduler } from "../services/formsRefreshScheduler";
import { startAdsSyncScheduler } from "../services/adsSyncScheduler";
import { startCrmSyncScheduler } from "../services/crmSyncScheduler";
import { startLeadPollingScheduler } from "../services/leadPollingService";
import { getDb } from "../db";

if (!process.env.REDIS_URL) {
  console.error("[Worker] FATAL: REDIS_URL is required. Worker process cannot run without Redis.");
  process.exit(1);
}

async function boot() {
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

  console.log("[Worker] Starting lead processing worker...");
  const worker = startLeadWorker();

  console.log("[Worker] Starting background schedulers...");
  startRetryScheduler();
  startLogRetentionScheduler();
  startFormsRefreshScheduler();
  startAdsSyncScheduler();
  startCrmSyncScheduler();
  // Zapier-style polling fallback: harmless no-op unless ENABLE_LEAD_POLLING=true.
  // When enabled, every 10 min it reconciles each active (user, page, form)
  // against Facebook and saves + dispatches any leadgen the webhook missed.
  startLeadPollingScheduler();

  console.log("[Worker] All systems running. Waiting for jobs...");

  // Graceful shutdown
  async function shutdown(signal: string) {
    console.log(`[Worker] Received ${signal}, shutting down gracefully...`);
    await worker.close();
    console.log("[Worker] Worker closed. Exiting.");
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void boot();
