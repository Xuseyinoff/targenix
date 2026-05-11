/**
 * Operational helper — prints the current worker/scheduler scaling config
 * so operators can verify Railway env vars without grepping source code.
 *
 *   pnpm exec tsx tooling/show-scaling-config.ts
 *   railway run -- pnpm exec tsx tooling/show-scaling-config.ts
 */

import "dotenv/config";

function envOr(key: string, fallback: string): string {
  const v = process.env[key]?.trim();
  return v && v !== "" ? v : `${fallback} (default)`;
}

function envIntOr(key: string, fallback: number): string {
  const v = process.env[key]?.trim();
  const n = v != null && v !== "" ? parseInt(v, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return String(n);
  return `${fallback} (default)`;
}

console.log("=== Targenix scaling configuration ===\n");

console.log("WORKER (server/workers/leadWorker.ts):");
console.log(`  WORKER_CONCURRENCY     = ${envIntOr("WORKER_CONCURRENCY", 10)}    in-flight jobs per worker process`);
console.log(`  RAILWAY_REPLICA_ID     = ${envOr("RAILWAY_REPLICA_ID", "n/a")}    set by Railway in multi-replica mode`);
console.log("");

console.log("RETRY SCHEDULER (server/services/orderRetryScheduler.ts):");
console.log(`  RETRY_BATCH_SIZE       = ${envIntOr("RETRY_BATCH_SIZE", 500)}    orders examined per sweep cycle`);
console.log(`  RETRY_CONCURRENCY      = ${envIntOr("RETRY_CONCURRENCY", 10)}    parallel deliveries within a sweep`);
console.log(`  RETRY_RATE_PER_SEC     = ${envIntOr("RETRY_RATE_PER_SEC", 20)}    rate cap (req/s) per sweep`);
console.log("");

console.log("CONNECTION HEALTH (server/services/connectionHealthScheduler.ts):");
console.log(`  CONN_HEALTH_STALE_MS         = ${envIntOr("CONN_HEALTH_STALE_MS", 60 * 60 * 1000)}    ms; row re-probed when older than this`);
console.log(`  CONN_HEALTH_SWEEP_INTERVAL_MS = ${envIntOr("CONN_HEALTH_SWEEP_INTERVAL_MS", 10 * 60 * 1000)}    sweep loop period`);
console.log(`  CONN_HEALTH_BATCH            = ${envIntOr("CONN_HEALTH_BATCH", 100)}    connections per sweep`);
console.log(`  CONN_HEALTH_CONCURRENCY      = ${envIntOr("CONN_HEALTH_CONCURRENCY", 5)}    parallel probes`);
console.log("");

console.log("OBSERVABILITY (Sprint 5 / Item 5.1):");
console.log(`  SENTRY_DSN                   = ${process.env.SENTRY_DSN ? "<set>" : "(unset → telemetry disabled)"}`);
console.log(`  SENTRY_TRACES_SAMPLE_RATE    = ${envOr("SENTRY_TRACES_SAMPLE_RATE", "0.1")}`);
console.log("");

console.log("INFRASTRUCTURE:");
console.log(`  REDIS_URL              = ${process.env.REDIS_URL ? "<set>" : "(unset → in-process queue, NOT durable)"}`);
console.log(`  NODE_ENV               = ${envOr("NODE_ENV", "development")}`);
console.log(`  START_WORKER           = ${envOr("START_WORKER", "false")}`);
console.log("");

console.log("=== Scaling recipes ===\n");
console.log("Light traffic (default):");
console.log("  WORKER_CONCURRENCY=10, 1 replica, RETRY_CONCURRENCY=10");
console.log("  → handles ~100K leads/day comfortably\n");
console.log("Heavy traffic (1M+ leads/month):");
console.log("  WORKER_CONCURRENCY=20, 2-3 replicas, RETRY_CONCURRENCY=20, RETRY_RATE_PER_SEC=50");
console.log("  → Sprint 1 FOR UPDATE SKIP LOCKED makes multi-replica safe\n");
console.log("Burst-prone (Facebook batch deliveries):");
console.log("  WORKER_CONCURRENCY=30 + 2 replicas");
console.log("  → 60 in-flight slots absorb a 60 leads/sec burst without backlog");
