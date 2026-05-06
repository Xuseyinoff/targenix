import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  crmConnections,
  orders,
  leads,
  integrations,
  targetWebsites,
} from "../../drizzle/schema";
import { and, desc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { encrypt, decrypt } from "../encryption";
import {
  crmLogin,
  crmGetOrderStatus,
  extractExternalOrderId,
  type Platform,
} from "../services/crmService";

// ─── Background sync state (single-instance safe) ─────────────────────────────
interface SyncResult {
  synced: number;
  errors: number;
  total: number;
  syncedAt: string;
  message?: string;
}
const syncState = {
  running: false,
  lastResult: null as SyncResult | null,
};

async function performCrmSync(platform?: "sotuvchi" | "100k"): Promise<SyncResult> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const accounts = await db
    .select()
    .from(crmConnections)
    .where(platform ? eq(crmConnections.platform, platform) : undefined);

  if (accounts.length === 0) {
    return { synced: 0, errors: 0, total: 0, syncedAt: new Date().toISOString(), message: "CRM akkaunt topilmadi" };
  }

  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const pendingOrders = await db
    .select({
      orderId: orders.id,
      responseData: orders.responseData,
      crmSyncedAt: orders.crmSyncedAt,
      templateType: targetWebsites.templateType,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
        or(isNull(orders.crmSyncedAt), lte(orders.crmSyncedAt, tenMinAgo)),
        sql`${orders.createdAt} >= ${thirtyDaysAgo}`,
        platform
          ? eq(targetWebsites.templateType, platform)
          : or(eq(targetWebsites.templateType, "sotuvchi"), eq(targetWebsites.templateType, "100k")),
      ),
    )
    .limit(200);

  const accountByPlatform = new Map<Platform, typeof accounts[number]>();
  for (const acc of accounts) {
    if (!accountByPlatform.has(acc.platform as Platform)) {
      accountByPlatform.set(acc.platform as Platform, acc);
    }
  }

  let synced = 0;
  let errors = 0;

  async function refreshToken(acc: typeof accounts[number]): Promise<string | null> {
    try {
      const password = decrypt(acc.passwordEncrypted);
      const result = await crmLogin(acc.platform as Platform, acc.phone, password);
      const newToken = encrypt(result.bearerToken);
      await db!
        .update(crmConnections)
        .set({ bearerTokenEncrypted: newToken, status: "active", lastLoginAt: new Date() })
        .where(eq(crmConnections.id, acc.id));
      acc.bearerTokenEncrypted = newToken;
      return result.bearerToken;
    } catch {
      await db!.update(crmConnections).set({ status: "error" }).where(eq(crmConnections.id, acc.id));
      return null;
    }
  }

  const CONCURRENCY = 5;
  for (let i = 0; i < pendingOrders.length; i += CONCURRENCY) {
    const batch = pendingOrders.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (row) => {
        const plat = row.templateType as Platform;
        if (plat !== "sotuvchi" && plat !== "100k") return;
        const acc = accountByPlatform.get(plat);
        if (!acc) return;
        const externalId = extractExternalOrderId(row.responseData);
        if (!externalId) return;
        let bearerToken = decrypt(acc.bearerTokenEncrypted);
        const tryFetch = (token: string) => crmGetOrderStatus(plat, token, externalId, acc.platformUserId);
        try {
          const statusResult = await tryFetch(bearerToken).catch(async (err) => {
            if (err?.response?.status === 401) {
              const newToken = await refreshToken(acc);
              if (!newToken) throw new Error("re-login failed");
              bearerToken = newToken;
              return tryFetch(newToken);
            }
            throw err;
          });
          await db!.update(orders).set({ crmStatus: statusResult.status, crmSyncedAt: new Date() }).where(eq(orders.id, row.orderId));
          synced++;
        } catch {
          errors++;
        }
      }),
    );
    if (i + CONCURRENCY < pendingOrders.length) {
      await new Promise((r) => setTimeout(r, 700));
    }
  }

  console.log(`[CrmSync] Done — synced=${synced} errors=${errors} total=${pendingOrders.length}`);
  return { synced, errors, total: pendingOrders.length, syncedAt: new Date().toISOString() };
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

export const crmRouter = router({
  listAccounts: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({
        id: crmConnections.id,
        platform: crmConnections.platform,
        displayName: crmConnections.displayName,
        phone: crmConnections.phone,
        platformUserId: crmConnections.platformUserId,
        status: crmConnections.status,
        lastLoginAt: crmConnections.lastLoginAt,
        createdAt: crmConnections.createdAt,
      })
      .from(crmConnections)
      .orderBy(desc(crmConnections.createdAt));
    return rows;
  }),

  addAccount: adminProcedure
    .input(
      z.object({
        platform: z.enum(["sotuvchi", "100k"]),
        displayName: z.string().trim().min(1).max(64),
        phone: z.string().trim().min(3).max(64),
        password: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      // Login to platform and get bearer token
      const loginResult = await crmLogin(
        input.platform as Platform,
        input.phone,
        input.password,
      );

      const now = new Date();
      await db.insert(crmConnections).values({
        userId: 0, // admin-global, not per-user
        platform: input.platform,
        displayName: input.displayName,
        phone: input.phone,
        passwordEncrypted: encrypt(input.password),
        bearerTokenEncrypted: encrypt(loginResult.bearerToken),
        platformUserId: loginResult.platformUserId,
        status: "active",
        lastLoginAt: now,
      });

      return { ok: true };
    }),

  deleteAccount: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");
      await db.delete(crmConnections).where(eq(crmConnections.id, input.id));
      return { ok: true };
    }),

  // ─── Orders ───────────────────────────────────────────────────────────────

  listOrders: adminProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(200).default(50),
        offset: z.number().min(0).default(0),
        platform: z.enum(["sotuvchi", "100k"]).optional(),
        crmStatus: z.string().optional(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };

      const where = and(
        eq(orders.status, "SENT"),
        eq(orders.userId, ctx.user.id),
        isNotNull(orders.responseData),
        input.platform
          ? eq(targetWebsites.templateType, input.platform)
          : undefined,
        input.crmStatus
          ? eq(orders.crmStatus, input.crmStatus)
          : undefined,
      );

      const [items, [{ total }]] = await Promise.all([
        db
          .select({
            orderId: orders.id,
            leadId: orders.leadId,
            integrationId: orders.integrationId,
            responseData: orders.responseData,
            crmStatus: orders.crmStatus,
            crmSyncedAt: orders.crmSyncedAt,
            createdAt: orders.createdAt,
            leadName: leads.fullName,
            leadPhone: leads.phone,
            integrationName: integrations.name,
            templateType: targetWebsites.templateType,
          })
          .from(orders)
          .innerJoin(leads, eq(orders.leadId, leads.id))
          .innerJoin(integrations, eq(orders.integrationId, integrations.id))
          .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
          .where(where)
          .orderBy(desc(orders.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ total: sql<number>`COUNT(*)` })
          .from(orders)
          .innerJoin(integrations, eq(orders.integrationId, integrations.id))
          .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
          .where(where),
      ]);

      return { items, total };
    }),

  // ─── Sync: start background job, return immediately ──────────────────────

  syncOrderStatuses: adminProcedure
    .input(z.object({ platform: z.enum(["sotuvchi", "100k"]).optional() }))
    .mutation(({ input }) => {
      if (syncState.running) {
        return { started: false, running: true, message: "Sync allaqachon ishlayapti..." };
      }
      syncState.running = true;
      syncState.lastResult = null;
      void performCrmSync(input.platform)
        .then((r) => {
          syncState.running = false;
          syncState.lastResult = r;
        })
        .catch((err: unknown) => {
          console.error("[CrmSync] fatal error:", err);
          syncState.running = false;
          syncState.lastResult = {
            synced: 0, errors: 1, total: 0,
            syncedAt: new Date().toISOString(),
            message: err instanceof Error ? err.message : String(err),
          };
        });
      return { started: true, running: true };
    }),

  // ─── Poll sync state ───────────────────────────────────────────────────────

  getSyncStatus: adminProcedure.query(() => ({ ...syncState })),
});
