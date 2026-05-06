/**
 * adminBackfillRouter.ts
 *
 * Admin-only procedures for the Lead Backfill panel.
 * Allows admins to:
 *   1. List all users
 *   2. List LEAD_ROUTING integrations for a given user
 *   3. Preview leads for a given integration (by count / hours / manual selection)
 *   4. Send selected leads through processLead with isAdmin=true
 */

import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { users, integrations, leads, orders, facebookConnections, facebookAccounts, targetWebsites } from "../../drizzle/schema";
import { and, eq, lt, gte, desc, inArray } from "drizzle-orm";
import { dispatchLeadProcessing } from "../services/leadDispatch";
import { retryAllFailedLeads } from "../services/retryScheduler";

export const adminBackfillRouter = router({
  // ── 1. List all users ──────────────────────────────────────────────────────
  listUsers: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new Error("DB not available");
    return db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .orderBy(users.name);
  }),

  // ── 2. List LEAD_ROUTING integrations for a user ───────────────────────────
  listIntegrations: adminProcedure
    .input(z.object({ userId: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const rows = await db
        .select()
        .from(integrations)
        .where(and(eq(integrations.userId, input.userId), eq(integrations.type, "LEAD_ROUTING")))
        .orderBy(desc(integrations.createdAt));

      // Enrich with target website name
      const enriched = await Promise.all(
        rows.map(async (intg) => {
          const cfg = intg.config as Record<string, unknown>;
          const twId = intg.targetWebsiteId ?? (cfg.targetWebsiteId ? Number(cfg.targetWebsiteId) : null);
          let targetWebsiteName: string | null = cfg.targetWebsiteName as string ?? null;
          let targetWebsiteUrl: string | null = null;

          if (twId) {
            const [tw] = await db
              .select({ name: targetWebsites.name, url: targetWebsites.url })
              .from(targetWebsites)
              .where(eq(targetWebsites.id, twId))
              .limit(1);
            if (tw) { targetWebsiteName = tw.name; targetWebsiteUrl = tw.url; }
          }

          // Resolve account name
          const accountId = (cfg.facebookAccountId ?? cfg.accountId) as number | undefined;
          let accountName: string | null = null;
          if (accountId) {
            const [acct] = await db
              .select({ fbUserName: facebookAccounts.fbUserName })
              .from(facebookAccounts)
              .where(eq(facebookAccounts.id, accountId))
              .limit(1);
            accountName = acct?.fbUserName ?? null;
          }

          return {
            id: intg.id,
            name: intg.name,
            pageId: intg.pageId,
            formId: intg.formId,
            pageName: cfg.pageName as string ?? null,
            formName: intg.formName ?? cfg.formName as string ?? null,
            accountName,
            targetWebsiteName,
            targetWebsiteUrl,
            isActive: intg.isActive,
            createdAt: intg.createdAt,
          };
        })
      );

      return enriched;
    }),

  // ── 3. Preview leads for backfill ──────────────────────────────────────────
  previewLeads: adminProcedure
    .input(
      z.object({
        integrationId: z.number(),
        mode: z.enum(["count", "hours", "manual"]),
        /** For mode=count: how many leads before integration creation */
        count: z.number().min(1).max(200).optional(),
        /** For mode=hours: leads from last N hours before integration creation */
        hours: z.number().min(1).max(720).optional(),
        /** For mode=manual: explicit lead IDs */
        leadIds: z.array(z.number()).optional(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [intg] = await db
        .select()
        .from(integrations)
        .where(eq(integrations.id, input.integrationId))
        .limit(1);

      if (!intg) throw new Error("Integration not found");

      const cfg = intg.config as Record<string, unknown>;
      const pageId = intg.pageId ?? (cfg.pageId as string);
      const formId = intg.formId ?? (cfg.formId as string);
      const createdAt = intg.createdAt;

      // IMPORTANT: scope all lead queries to intg.userId so admin only previews
      // leads belonging to that specific user, not all users who share the page+form.
      const ownerId = intg.userId;

      let rows;

      if (input.mode === "manual" && input.leadIds?.length) {
        rows = await db
          .select({ id: leads.id, fullName: leads.fullName, phone: leads.phone, createdAt: leads.createdAt, dataStatus: leads.dataStatus, deliveryStatus: leads.deliveryStatus })
          .from(leads)
          .where(and(eq(leads.userId, ownerId), eq(leads.pageId, pageId), eq(leads.formId, formId), inArray(leads.id, input.leadIds)))
          .orderBy(desc(leads.createdAt));
      } else if (input.mode === "hours" && input.hours) {
        const cutoff = new Date(createdAt.getTime() - input.hours * 3600 * 1000);
        rows = await db
          .select({ id: leads.id, fullName: leads.fullName, phone: leads.phone, createdAt: leads.createdAt, dataStatus: leads.dataStatus, deliveryStatus: leads.deliveryStatus })
          .from(leads)
          .where(and(eq(leads.userId, ownerId), eq(leads.pageId, pageId), eq(leads.formId, formId), lt(leads.createdAt, createdAt), gte(leads.createdAt, cutoff)))
          .orderBy(desc(leads.createdAt));
      } else {
        // Default: count mode
        const limit = input.count ?? 15;
        rows = await db
          .select({ id: leads.id, fullName: leads.fullName, phone: leads.phone, createdAt: leads.createdAt, dataStatus: leads.dataStatus, deliveryStatus: leads.deliveryStatus })
          .from(leads)
          .where(and(eq(leads.userId, ownerId), eq(leads.pageId, pageId), eq(leads.formId, formId), lt(leads.createdAt, createdAt)))
          .orderBy(desc(leads.createdAt))
          .limit(limit);
      }

      return {
        integration: {
          id: intg.id,
          name: intg.name,
          pageId,
          formId,
          pageName: cfg.pageName as string ?? null,
          formName: intg.formName ?? cfg.formName as string ?? null,
          createdAt,
        },
        leads: rows,
        total: rows.length,
      };
    }),

  // ── 4. Send leads (backfill) ───────────────────────────────────────────────
  sendLeads: adminProcedure
    .input(
      z.object({
        integrationId: z.number(),
        leadIds: z.array(z.number()).min(1).max(200),
        /** If false, skip Telegram notification */
        sendTelegram: z.boolean().default(true),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [intg] = await db
        .select()
        .from(integrations)
        .where(eq(integrations.id, input.integrationId))
        .limit(1);

      if (!intg) throw new Error("Integration not found");

      const cfg = intg.config as Record<string, unknown>;
      const pageId = intg.pageId ?? (cfg.pageId as string);
      const formId = intg.formId ?? (cfg.formId as string);
      const userId = intg.userId;

      // Fetch the leads — scope to userId so admin only processes the integration
      // owner's leads, not any other user who may share the same page+form.
      const leadRows = await db
        .select()
        .from(leads)
        .where(and(eq(leads.userId, userId), eq(leads.pageId, pageId), eq(leads.formId, formId), inArray(leads.id, input.leadIds)));

      // Enqueue all leads in parallel — worker processes them with proper retry
      await Promise.all(
        leadRows.map((lead) =>
          dispatchLeadProcessing({
            leadId: lead.id,
            leadgenId: lead.leadgenId,
            pageId: lead.pageId,
            formId: lead.formId,
            userId,
          }),
        ),
      );

      return { queued: leadRows.length, total: input.leadIds.length };
    }),

  // ── 5. Manually trigger retry of all FAILED leads ─────────────────────────
  triggerRetry: adminProcedure.mutation(async () => {
    return retryAllFailedLeads();
  }),

  // ── 6. Retry all failed BullMQ queue jobs (one-shot recovery) ──────────────
  retryFailedQueueJobs: adminProcedure.mutation(async () => {
    const { Queue } = await import("bullmq");
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) return { retried: 0, errors: 0, message: "REDIS_URL not set — queue not active" };

    const url = new URL(redisUrl);
    const connection = {
      host: url.hostname,
      port: Number(url.port) || 6379,
      password: url.password || undefined,
      db: url.pathname ? Number(url.pathname.replace("/", "")) || 0 : 0,
      tls: url.protocol === "rediss:" ? {} : undefined,
    };

    const queue = new Queue("lead-processing", { connection });

    const failedCount = await queue.getFailedCount();
    if (failedCount === 0) {
      await queue.close();
      return { retried: 0, errors: 0, message: "No failed jobs in queue" };
    }

    let retried = 0;
    let errors = 0;
    const jobs = await queue.getFailed(0, failedCount + 50);

    await Promise.all(
      jobs.map(async (job) => {
        try { await job.retry(); retried++; }
        catch { errors++; }
      })
    );

    await queue.close();
    return { retried, errors, total: failedCount };
  }),
});
