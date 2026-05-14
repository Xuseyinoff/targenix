import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../queues/redisConnection";
import { processLead } from "../services/leadService";
import type { LeadJobData } from "../queues/leadQueue";
import { log } from "../services/appLogger";
import { newWorkerTraceId, runWithRequestContext } from "../lib/requestContext";

let _worker: Worker | undefined;

/**
 * Sprint 6 / Item 6.1 — worker concurrency is now env-driven so the
 * Railway service can scale vertically (per-process concurrency) or
 * horizontally (multiple service replicas) without a code change.
 *
 * Defaults:
 *   WORKER_CONCURRENCY=10   in-flight jobs per worker process
 *
 * Horizontal scaling: bump Railway "replicas" to N. Each replica runs
 * its own Worker; BullMQ + Redis already coordinates the jobs so two
 * replicas pulling the same queue is safe by design. The Sprint 1
 * `FOR UPDATE SKIP LOCKED` in the retry scheduler guarantees no order
 * is processed twice across the fleet.
 *
 * Pick a number that keeps CPU < 70% and tail latency stable. 100k+
 * leads/day comfortably handled by 1 replica × concurrency=20, or
 * 2 replicas × concurrency=10.
 */
function readConcurrency(): number {
  const raw = process.env.WORKER_CONCURRENCY?.trim();
  const n = raw != null && raw !== "" ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n > 0 && n <= 200) return n;
  return 10; // sensible default for a single Railway replica
}

export function startLeadWorker(): Worker {
  if (_worker) return _worker;
  const concurrency = readConcurrency();
  const replicaId =
    process.env.RAILWAY_REPLICA_ID?.slice(0, 8) ??
    process.env.HOSTNAME?.slice(0, 8) ??
    "single";

  _worker = new Worker<LeadJobData>(
    "lead-processing",
    async (job: Job<LeadJobData>) => {
      const { leadId, leadgenId, userId } = job.data;
      // Wrap the entire processLead chain in a request context so every
      // log emitted inside (lead enrichment, deliveries, workflow fires)
      // carries the same trace id back up through appLogger.
      await runWithRequestContext(
        {
          traceId: newWorkerTraceId("lead-processing", job.id ?? "noid"),
          kind: "worker",
          name: "lead-processing",
        },
        async () => {
          void log.info("SYSTEM", `Job ${job.id} started`, {
            replicaId,
            jobId: job.id,
            leadId,
            leadgenId,
          }, leadId, job.data.pageId, userId);

          await processLead({
            leadId,
            leadgenId,
            pageId: job.data.pageId,
            formId: job.data.formId ?? "",
            userId,
          });

          void log.info("SYSTEM", `Job ${job.id} done`, {
            replicaId,
            jobId: job.id,
            leadId,
          }, leadId, job.data.pageId, userId);
        },
      );
    },
    {
      connection: getRedisConnection() as any,
      concurrency,
    }
  );

  _worker.on("completed", (job) => {
    void log.info("SYSTEM", `Job ${job.id} completed`, {
      replicaId,
      jobId: job.id,
      leadId: job.data.leadId,
    });
  });

  _worker.on("failed", (job, err) => {
    const cause = (err as { cause?: unknown }).cause;
    void log.error(
      "SYSTEM",
      `Job ${job?.id} failed (attempt ${job?.attemptsMade})`,
      {
        replicaId,
        jobId: job?.id,
        attemptsMade: job?.attemptsMade,
        error: err.message,
        cause: cause ? (cause as Error).message ?? String(cause) : null,
        leadId: job?.data.leadId,
      },
    );
    // Sprint 5 / Item 5.1 — escalate sustained failures to Sentry. BullMQ
    // already retried `attemptsMade` times, so a failed event means the
    // lead is in DLQ. Page operators.
    if (job && job.attemptsMade >= 3) {
      void import("../monitoring/sentry").then(({ captureCritical }) => {
        captureCritical(err, {
          tags: { category: "SYSTEM", replicaId, attemptsMade: job.attemptsMade },
          user: { id: job.data.userId },
          extra: { leadId: job.data.leadId, leadgenId: job.data.leadgenId, jobId: job.id },
        });
      });
    }
  });

  _worker.on("error", (err) => {
    void log.error("SYSTEM", "Worker error", {
      replicaId,
      error: err.message,
    });
  });

  void log.info("SYSTEM", "Lead worker started", {
    replicaId,
    concurrency,
    railwayReplica: process.env.RAILWAY_REPLICA_ID ?? null,
  });
  return _worker;
}

export async function stopLeadWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
    void log.info("SYSTEM", "Lead worker stopped");
  }
}
