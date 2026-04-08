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
    await queue.add("process-lead", data, {
      jobId: `lead-${data.leadgenId}`,
    });
    console.log(`[Queue] Enqueued lead job for leadgenId=${data.leadgenId}`);
  } catch (err) {
    console.error("[Queue] Failed to enqueue lead job:", err);
    // Don't throw — webhook must always return 200
  }
}
