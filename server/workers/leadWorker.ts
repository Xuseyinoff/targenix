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
      const { leadId, leadgenId, userId } = job.data;
      console.log(`[Worker] ▶ START job=${job.id} leadId=${leadId} userId=${userId} leadgenId=${leadgenId}`);

      await processLead({
        leadId,
        leadgenId,
        pageId: job.data.pageId,
        formId: job.data.formId ?? "",
        userId,
      });

      console.log(`[Worker] ✓ DONE  job=${job.id} leadId=${leadId}`);
    },
    {
      connection: getRedisConnection() as any,
      concurrency: 5,
    }
  );

  _worker.on("completed", (job) => {
    console.log(`[Worker] ✓ Job ${job.id} completed leadId=${job.data.leadId}`);
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
