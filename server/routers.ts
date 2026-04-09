import { router } from "./_core/trpc";
import { authRouter } from "./routers/emailAuthRouter";
import { leadsRouter } from "./routers/leadsRouter";
import { integrationsRouter } from "./routers/integrationsRouter";
import { facebookRouter } from "./routers/facebookRouter";
import { facebookAccountsRouter } from "./routers/facebookAccountsRouter";
import { targetWebsitesRouter } from "./routers/targetWebsitesRouter";
import { webhookRouter } from "./routers/webhookRouter";
import { logsRouter } from "./routers/logsRouter";
import { telegramRouter } from "./routers/telegramRouter";
import { adminBackfillRouter } from "./routers/adminBackfillRouter";
import { adAnalyticsRouter } from "./routers/adAnalyticsRouter";
import { systemRouter } from "./_core/systemRouter";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  leads: leadsRouter,
  integrations: integrationsRouter,
  facebook: facebookRouter,
  facebookAccounts: facebookAccountsRouter,
  targetWebsites: targetWebsitesRouter,
  webhook: webhookRouter,
  logs: logsRouter,
  telegram: telegramRouter,
  adminBackfill: adminBackfillRouter,
  adAnalytics: adAnalyticsRouter,
});

export type AppRouter = typeof appRouter;
