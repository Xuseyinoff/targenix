import { enqueueLeadJob } from "../queues/leadQueue";
import { processLead } from "./leadService";

export interface LeadDispatchPayload {
  leadId: number;
  leadgenId: string;
  pageId: string;
  formId: string;
  userId: number;
}

function isQueueEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/**
 * Queue-backed dispatch when Redis is configured; otherwise fall back to in-process async work.
 * This keeps local development simple while allowing production to opt into durable workers.
 */
export async function dispatchLeadProcessing(payload: LeadDispatchPayload): Promise<void> {
  if (isQueueEnabled()) {
    await enqueueLeadJob(payload);
    return;
  }

  setImmediate(() => {
    void processLead(payload).catch((err) => {
      console.error(`[LeadDispatch] processLead failed for leadId=${payload.leadId}:`, err);
    });
  });
}

export function getLeadDispatchMode(): "queue" | "in-process" {
  return isQueueEnabled() ? "queue" : "in-process";
}
