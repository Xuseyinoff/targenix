import { Queue } from "bullmq";
import { getRedisConnection } from "./redisConnection";

export interface LeadJobData {
  leadId: number;
  leadgenId: string;
  pageId: string;
  formId: string;
  userId: number;
}

let _leadQueue: Queue<LeadJobData> | undefined;

export function getLeadQueue(): Queue<LeadJobData> {
  if (!_leadQueue) {
    _leadQueue = new Queue<LeadJobData>("lead-processing", {
      connection: getRedisConnection() as any,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 5000,
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return _leadQueue;
}

export async function enqueueLeadJob(data: LeadJobData): Promise<void> {
  try {
    const queue = getLeadQueue();
    const jobId = `lead-${data.leadId}`;

    // If a job with this ID already exists in "failed" state, retry it directly.
    // BullMQ silently ignores add() when a jobId already exists (any state),
    // so we must check and handle failed jobs explicitly.
    const existing = await queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "failed") {
        await existing.retry();
        console.log(`[Queue] Retried failed job ${jobId} for leadgenId=${data.leadgenId}`);
        return;
      }
      if (state === "waiting" || state === "active" || state === "delayed") {
        // Already queued or running — nothing to do
        return;
      }
      // "completed" or unknown — remove stale job so we can re-add
      await existing.remove();
    }

    await queue.add("process-lead", data, { jobId });
    console.log(`[Queue] Enqueued lead job for leadgenId=${data.leadgenId}`);
  } catch (err) {
    console.error("[Queue] Failed to enqueue lead job:", err);
    // Don't throw — webhook must always return 200
  }
}
