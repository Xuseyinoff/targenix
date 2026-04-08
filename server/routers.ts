import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { leadsRouter } from "./routers/leadsRouter";
import { integrationsRouter } from "./routers/integrationsRouter";
import { facebookRouter } from "./routers/facebookRouter";
import { facebookAccountsRouter } from "./routers/facebookAccountsRouter";
import { targetWebsitesRouter } from "./routers/targetWebsitesRouter";
import { webhookRouter } from "./routers/webhookRouter";
import { logsRouter } from "./routers/logsRouter";
import { emailAuthRouter } from "./routers/emailAuthRouter";
import { telegramRouter } from "./routers/telegramRouter";
import { adminBackfillRouter } from "./routers/adminBackfillRouter";
import { adAnalyticsRouter } from "./routers/adAnalyticsRouter";

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  leads: leadsRouter,
  integrations: integrationsRouter,
  facebook: facebookRouter,
  facebookAccounts: facebookAccountsRouter,
  targetWebsites: targetWebsitesRouter,
  webhook: webhookRouter,
  logs: logsRouter,
  emailAuth: emailAuthRouter,
  telegram: telegramRouter,
  adminBackfill: adminBackfillRouter,
  adAnalytics: adAnalyticsRouter,
});

export type AppRouter = typeof appRouter;
