import { enqueueLeadJob } from "../queues/leadQueue";
import { processLead } from "./leadService";
import { ENV } from "../_core/env";

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
 * Queue-backed dispatch when Redis is configured.
 *
 * Production MUST use the durable BullMQ queue: the in-process `setImmediate`
 * path drops every in-flight job on a crash or redeploy and offers no retry,
 * so it is a lead-loss hazard. When `NODE_ENV=production` and Redis is not
 * configured this function throws — the startup guard in `_core/index.ts`
 * already aborts boot in that case, and this throw is the defence-in-depth
 * backstop for any caller that still reaches here.
 *
 * The in-process fallback is retained for local development only, where
 * standing up Redis would be unnecessary friction.
 */
export async function dispatchLeadProcessing(payload: LeadDispatchPayload): Promise<void> {
  if (isQueueEnabled()) {
    await enqueueLeadJob(payload);
    return;
  }

  if (ENV.isProduction) {
    throw new Error(
      "[LeadDispatch] FATAL: REDIS_URL is not set in production. Lead processing " +
        "requires the durable queue — the in-process fallback is dev-only.",
    );
  }

  // Development only — keeps local dev simple without a Redis dependency.
  setImmediate(() => {
    void processLead(payload).catch((err) => {
      console.error(`[LeadDispatch] processLead failed for leadId=${payload.leadId}:`, err);
    });
  });
}

export function getLeadDispatchMode(): "queue" | "in-process" {
  return isQueueEnabled() ? "queue" : "in-process";
}
