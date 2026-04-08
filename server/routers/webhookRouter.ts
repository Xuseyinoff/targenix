import { adminProcedure, router } from "../_core/trpc";
import { getRecentWebhookEvents, getWebhookStats } from "../db";

export const webhookRouter = router({
  recentEvents: adminProcedure.query(async () => {
    return getRecentWebhookEvents(30);
  }),

  stats: adminProcedure.query(async () => {
    return getWebhookStats();
  }),
});
