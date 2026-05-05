import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "../queues/redisConnection";
import { processLead } from "../services/leadService";
import type { LeadJobData } from "../queues/leadQueue";

let _worker: Worker | undefined;

export function startLeadWorker(): Worker {
  if (_worker) return _worker;

  _worker = new Worker<LeadJobData>(
    "lead-processing",
    async (job: Job<LeadJobData>) => {
      console.log(`[Worker] Processing job ${job.id} — leadgenId=${job.data.leadgenId}`);

      await processLead({
        leadId: job.data.leadId,
        leadgenId: job.data.leadgenId,
        pageId: job.data.pageId,
        formId: job.data.formId ?? "",
        userId: job.data.userId,
      });

      console.log(`[Worker] Job ${job.id} completed successfully`);
    },
    {
      connection: getRedisConnection() as any,
      concurrency: 5,
    }
  );

  _worker.on("completed", (job) => {
    console.log(`[Worker] ✓ Job ${job.id} completed`);
  });

  _worker.on("failed", (job, err) => {
    const cause = (err as { cause?: unknown }).cause;
    console.error(
      `[Worker] ✗ Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
      cause ? `| cause: ${(cause as Error).message ?? String(cause)}` : "",
    );
  });

  _worker.on("error", (err) => {
    console.error("[Worker] Worker error:", err.message);
  });

  console.log("[Worker] Lead worker started");
  return _worker;
}

export async function stopLeadWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
    console.log("[Worker] Lead worker stopped");
  }
}
