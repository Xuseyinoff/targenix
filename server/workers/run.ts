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

if (!process.env.REDIS_URL) {
  console.error("[Worker] FATAL: REDIS_URL is required. Worker process cannot run without Redis.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("[Worker] FATAL: DATABASE_URL is required.");
  process.exit(1);
}

console.log("[Worker] Starting lead processing worker...");
const worker = startLeadWorker();

console.log("[Worker] Starting background schedulers...");
startRetryScheduler();
startLogRetentionScheduler();
startFormsRefreshScheduler();

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
