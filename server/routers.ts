import { router } from "./_core/trpc";
import { authRouter } from "./routers/emailAuthRouter";
import { leadsRouter } from "./routers/leadsRouter";
import { integrationsRouter } from "./routers/integrationsRouter";
import { facebookAccountsRouter } from "./routers/facebookAccountsRouter";
import { targetWebsitesRouter } from "./routers/targetWebsitesRouter";
import { webhookRouter } from "./routers/webhookRouter";
import { logsRouter } from "./routers/logsRouter";
import { telegramRouter } from "./routers/telegramRouter";
import { adminBackfillRouter } from "./routers/adminBackfillRouter";
import { adminTemplatesRouter } from "./routers/adminTemplatesRouter";
import { adminAppsRouter } from "./routers/adminAppsRouter";
import { adminAppActionsRouter } from "./routers/adminAppActionsRouter";
import { adminLeadsRouter } from "./routers/adminLeadsRouter";
import { adAnalyticsRouter } from "./routers/adAnalyticsRouter";
import { systemRouter } from "./_core/systemRouter";
import { googleAccountsRouter } from "./routers/googleAccountsRouter";
import { googleRouter } from "./routers/googleRouter";
import { appsRouter } from "./routers/appsRouter";
import { connectionsRouter } from "./routers/connectionsRouter";
import { crmRouter } from "./routers/crmRouter";

export const appRouter = router({
  system: systemRouter,
  auth: authRouter,
  leads: leadsRouter,
  integrations: integrationsRouter,
  apps: appsRouter,
  connections: connectionsRouter,
  facebookAccounts: facebookAccountsRouter,
  googleAccounts: googleAccountsRouter,
  google: googleRouter,
  targetWebsites: targetWebsitesRouter,
  webhook: webhookRouter,
  logs: logsRouter,
  telegram: telegramRouter,
  adminBackfill: adminBackfillRouter,
  adminTemplates: adminTemplatesRouter,
  adminApps: adminAppsRouter,
  adminAppActions: adminAppActionsRouter,
  adminLeads: adminLeadsRouter,
  adAnalytics: adAnalyticsRouter,
  adminCrm: crmRouter,
});

export type AppRouter = typeof appRouter;
