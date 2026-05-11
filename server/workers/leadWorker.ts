import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../queues/redisConnection";
import { processLead } from "../services/leadService";
import type { LeadJobData } from "../queues/leadQueue";

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
      console.log(`[Worker:${replicaId}] ▶ START job=${job.id} leadId=${leadId} userId=${userId} leadgenId=${leadgenId}`);

      await processLead({
        leadId,
        leadgenId,
        pageId: job.data.pageId,
        formId: job.data.formId ?? "",
        userId,
      });

      console.log(`[Worker:${replicaId}] ✓ DONE  job=${job.id} leadId=${leadId}`);
    },
    {
      connection: getRedisConnection() as any,
      concurrency,
    }
  );

  _worker.on("completed", (job) => {
    console.log(`[Worker:${replicaId}] ✓ Job ${job.id} completed leadId=${job.data.leadId}`);
  });

  _worker.on("failed", (job, err) => {
    const cause = (err as { cause?: unknown }).cause;
    console.error(
      `[Worker:${replicaId}] ✗ Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
      cause ? `| cause: ${(cause as Error).message ?? String(cause)}` : "",
    );
    // Sprint 5 / Item 5.1 — escalate sustained failures to Sentry. BullMQ
    // already retried `attemptsMade` times, so a failed event means the
    // lead is in DLQ. Page operators.
    if (job && job.attemptsMade >= 3) {
      void import("../monitoring/sentry").then(({ captureCritical }) => {
        captureCritical(err, {
          tags: { category: "WORKER", replicaId, attemptsMade: job.attemptsMade },
          user: { id: job.data.userId },
          extra: { leadId: job.data.leadId, leadgenId: job.data.leadgenId, jobId: job.id },
        });
      });
    }
  });

  _worker.on("error", (err) => {
    console.error(`[Worker:${replicaId}] Worker error:`, err.message);
  });

  console.log(
    `[Worker:${replicaId}] Lead worker started — concurrency=${concurrency}` +
      (process.env.RAILWAY_REPLICA_ID ? ` replica=${process.env.RAILWAY_REPLICA_ID}` : ""),
  );
  return _worker;
}

export async function stopLeadWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
    console.log("[Worker] Lead worker stopped");
  }
}
