import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  crmConnections,
  orders,
  leads,
  integrations,
  targetWebsites,
  orderEvents,
} from "../../drizzle/schema";
import { and, asc, desc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { encrypt, decrypt } from "../encryption";
import {
  crmLogin,
  crmGetOrderStatus,
  extractExternalOrderId,
  sotuvchiGetOrdersPage,
  normalizeSotuvchiStatus,
  type Platform,
  type OrderPageResult,
} from "../services/crmService";
import { isFinalStatus } from "../../shared/crmStatuses";

// ─── Background sync state (single-instance safe) ─────────────────────────────
interface SyncResult {
  synced: number;
  errors: number;
  total: number;
  syncedAt: string;
  message?: string;
}
interface SyncProgress {
  current: number;
  total: number;
  platform: string;
  rateLimited: boolean;
}
export const syncState = {
  running: false,
  aborted: false,
  progress: null as SyncProgress | null,
  lastResult: null as SyncResult | null,
};

const REQUEST_DELAY_MS = 300;        // delay between requests within a burst
const BURST_SIZE = 20;               // requests per burst window
const BURST_PAUSE_MS = 15_000;       // cooldown after each burst (15 sec)
const CIRCUIT_BREAKER_HITS = 3;      // consecutive 429s before full stop
const CIRCUIT_BREAKER_PAUSE_MS = 120_000; // 2 min pause after circuit breaker trips

export async function performCrmSync(
  userId?: number,
  platform?: "sotuvchi" | "100k",
): Promise<SyncResult> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const accounts = await db
    .select()
    .from(crmConnections)
    .where(platform ? eq(crmConnections.platform, platform) : undefined);

  if (accounts.length === 0) {
    return { synced: 0, errors: 0, total: 0, syncedAt: new Date().toISOString(), message: "CRM akkaunt topilmadi" };
  }

  // Tier-based sync windows: ACTIVE orders every 2 min, MID orders every 10 min
  const twoMinAgo    = new Date(Date.now() -  2 * 60 * 1000);
  const tenMinAgo    = new Date(Date.now() - 10 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  /** `in_progress` with a recent sync (or never synced) — treat like ACTIVE so hot orders are not stuck on 10‑min tier only */
  const inProgressHotSince = new Date(Date.now() - 48 * 60 * 60 * 1000);

  // ACTIVE — funnel top (+ legacy) + unknown (remap fast) + recent in_progress: poll every ~2 min
  const activeDue = sql`(
    (
      ${orders.crmStatus} IS NULL
      OR ${orders.crmStatus} IN ('new','contacted','accepted','filling','callback')
      OR ${orders.crmStatus} = 'unknown'
      OR (
        ${orders.crmStatus} = 'in_progress'
        AND (
          ${orders.crmSyncedAt} IS NULL
          OR ${orders.crmSyncedAt} >= ${inProgressHotSince}
        )
      )
    )
    AND (${orders.crmSyncedAt} IS NULL OR ${orders.crmSyncedAt} <= ${twoMinAgo})
  )`;
  // MID — pipeline (+ legacy); stale in_progress (no sync in 48h) stays here at 10 min
  const midDue = sql`(
    ${orders.crmStatus} IN ('in_progress','success','unknown','sent','booked','preparing','recycling','on_argue')
    AND (${orders.crmSyncedAt} IS NULL OR ${orders.crmSyncedAt} <= ${tenMinAgo})
  )`;

  const pendingOrders = await db
    .select({
      orderId: orders.id,
      orderUserId: orders.userId,
      responseData: orders.responseData,
      crmSyncedAt: orders.crmSyncedAt,
      crmStatus: orders.crmStatus,
      appKey: targetWebsites.appKey,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        userId !== undefined ? eq(orders.userId, userId) : undefined,
        eq(orders.isFinal, false),
        isNotNull(orders.responseData),
        sql`(${activeDue} OR ${midDue})`,
        sql`${orders.createdAt} >= ${thirtyDaysAgo}`,
        platform
          ? eq(targetWebsites.appKey, platform)
          : or(eq(targetWebsites.appKey, "sotuvchi"), eq(targetWebsites.appKey, "100k")),
      ),
    )
    .orderBy(asc(orders.crmSyncedAt))   // oldest-synced first (NULLs first in MySQL ASC)
    .limit(200);

  const accountByPlatform = new Map<Platform, typeof accounts[number]>();
  for (const acc of accounts) {
    if (!accountByPlatform.has(acc.platform as Platform)) {
      accountByPlatform.set(acc.platform as Platform, acc);
    }
  }

  let synced = 0;
  let errors = 0;

  // Per-platform: timestamp until which we must not send requests (global pause)
  const pausedUntil = new Map<Platform, number>();
  const consecutiveHits = new Map<Platform, number>();

  // Detect the dominant platform for progress display
  const platformLabel = platform ?? (pendingOrders[0]?.appKey ?? "sotuvchi");

  // Initialise progress
  syncState.progress = { current: 0, total: pendingOrders.length, platform: platformLabel, rateLimited: false };

  async function waitIfPaused(plat: Platform): Promise<void> {
    const until = pausedUntil.get(plat) ?? 0;
    const remaining = until - Date.now();
    if (remaining > 0) {
      if (syncState.progress) syncState.progress.rateLimited = true;
      await new Promise((r) => setTimeout(r, remaining));
      if (syncState.progress) syncState.progress.rateLimited = false;
    }
  }

  function applyRateLimit(plat: Platform, hits: number): void {
    const isCircuitBreaker = hits >= CIRCUIT_BREAKER_HITS;
    const pauseMs = isCircuitBreaker
      ? CIRCUIT_BREAKER_PAUSE_MS
      : Math.min(5000 * 2 ** (hits - 1), 30_000); // 5s, 10s, 20s
    pausedUntil.set(plat, Date.now() + pauseMs);
    const tag = isCircuitBreaker ? " ⚡ CIRCUIT BREAKER" : "";
    console.warn(`[CrmSync] 429 on ${plat} (hit #${hits}) — pausing ${pauseMs / 1000}s${tag}`);
  }

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

  for (let i = 0; i < pendingOrders.length; i++) {
    if (syncState.aborted) {
      console.log(`[CrmSync] Aborted at ${i}/${pendingOrders.length}`);
      break;
    }

    const row = pendingOrders[i];
    const plat = row.appKey as Platform;
    if (plat !== "sotuvchi" && plat !== "100k") continue;
    const acc = accountByPlatform.get(plat);
    if (!acc) continue;
    const externalId = extractExternalOrderId(row.responseData);
    if (!externalId) continue;

    await waitIfPaused(plat);
    if (syncState.aborted) break;

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
        if (err?.response?.status === 429) {
          const hits = (consecutiveHits.get(plat) ?? 0) + 1;
          consecutiveHits.set(plat, hits);
          applyRateLimit(plat, hits);
          await waitIfPaused(plat);
          return tryFetch(bearerToken); // one retry after backoff
        }
        throw err;
      });
      consecutiveHits.set(plat, 0);
      const terminal = isFinalStatus(statusResult.status);
      const statusChanged = statusResult.status !== row.crmStatus;
      await db!.update(orders)
        .set({
          crmStatus: statusResult.status,
          crmRawStatus: statusResult.rawStatus,
          crmSyncedAt: new Date(),
          ...(statusChanged ? { isFinal: terminal } : {}),
        })
        .where(eq(orders.id, row.orderId));
      if (statusChanged) {
        console.log(`[CrmSync] status change orderId=${row.orderId}: ${row.crmStatus ?? "null"} → ${statusResult.status}${terminal ? " [FINAL]" : ""}`);
        void db!.insert(orderEvents).values({
          orderId: row.orderId,
          userId: row.orderUserId,
          oldStatus: row.crmStatus ?? null,
          newStatus: statusResult.status,
          source: "sync",
        }).catch(() => {});
      }
      synced++;
    } catch {
      errors++;
    }

    if (syncState.progress) syncState.progress.current = synced + errors;

    if (i < pendingOrders.length - 1 && !syncState.aborted) {
      const burstIndex = i + 1; // 1-based count of completed requests
      if (burstIndex % BURST_SIZE === 0) {
        // End of burst window — long cooldown so API rate window can reset
        console.log(`[CrmSync] Burst pause ${BURST_PAUSE_MS / 1000}s after ${burstIndex} requests`);
        if (syncState.progress) syncState.progress.rateLimited = true;
        await new Promise((r) => setTimeout(r, BURST_PAUSE_MS));
        if (syncState.progress) syncState.progress.rateLimited = false;
      } else {
        await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
      }
    }
  }

  console.log(`[CrmSync] Done — synced=${synced} errors=${errors} total=${pendingOrders.length}`);
  return { synced, errors, total: pendingOrders.length, syncedAt: new Date().toISOString() };
}

// ─── Pagination sync (bulk: 200 orders/page, stops at oldest non-final order) ──

const PAGE_LIMIT = 200;
const PAGE_DELAY_MS = 800;

export async function performPaginationSync(): Promise<SyncResult> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  const [acc] = await db
    .select()
    .from(crmConnections)
    .where(eq(crmConnections.platform, "sotuvchi"))
    .limit(1);

  if (!acc) {
    return { synced: 0, errors: 0, total: 0, syncedAt: new Date().toISOString(), message: "Sotuvchi akkaunt topilmadi" };
  }

  // Find our oldest non-final Sotuvchi order — everything older than this can be skipped
  const [oldestRow] = await db
    .select({ createdAt: orders.createdAt })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(targetWebsites, eq(integrations.targetWebsiteId, targetWebsites.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        eq(orders.isFinal, false),
        isNotNull(orders.responseData),
        eq(targetWebsites.appKey, "sotuvchi"),
      ),
    )
    .orderBy(asc(orders.createdAt))
    .limit(1);

  // Stop 1 day before oldest active order (buffer for clock drift)
  const stopBefore = oldestRow
    ? new Date(oldestRow.createdAt.getTime() - 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  console.log(`[PaginationSync] Stop boundary: ${stopBefore.toISOString()}`);

  let bearerToken = decrypt(acc.bearerTokenEncrypted);
  let page = 1;
  let synced = 0;
  let errors = 0;
  let pagesProcessed = 0;

  syncState.progress = { current: 0, total: 0, platform: "sotuvchi", rateLimited: false };

  while (!syncState.aborted) {
    // Fetch one page from Sotuvchi
    let pageResult: OrderPageResult;
    try {
      pageResult = await sotuvchiGetOrdersPage(bearerToken, page, PAGE_LIMIT)
        .catch(async (err) => {
          if (err?.response?.status === 401) {
            const password = decrypt(acc.passwordEncrypted);
            const r = await crmLogin("sotuvchi", acc.phone, password);
            bearerToken = r.bearerToken;
            await db!.update(crmConnections)
              .set({ bearerTokenEncrypted: encrypt(r.bearerToken), status: "active", lastLoginAt: new Date() })
              .where(eq(crmConnections.id, acc.id));
            return sotuvchiGetOrdersPage(bearerToken, page, PAGE_LIMIT);
          }
          if (err?.response?.status === 429) {
            console.warn(`[PaginationSync] 429 on page ${page} — pausing 30s`);
            if (syncState.progress) syncState.progress.rateLimited = true;
            await new Promise((r) => setTimeout(r, 30_000));
            if (syncState.progress) syncState.progress.rateLimited = false;
            return sotuvchiGetOrdersPage(bearerToken, page, PAGE_LIMIT);
          }
          throw err;
        });
    } catch (err) {
      console.error(`[PaginationSync] Failed on page ${page}:`, err instanceof Error ? err.message : err);
      errors++;
      break;
    }

    if (!pageResult.data.length) break;

    if (page === 1) {
      console.log(`[PaginationSync] ${pageResult.total.toLocaleString()} total Sotuvchi orders, ${pageResult.last_page.toLocaleString()} pages`);
      if (syncState.progress) syncState.progress.total = pageResult.last_page;
    }
    if (syncState.progress) syncState.progress.current = page;

    // Bulk match against our DB using JSON_EXTRACT
    const externalIds = pageResult.data.map((o) => String(o.id));
    try {
      const matches = await db
        .select({
          orderId: orders.id,
          orderUserId: orders.userId,
          crmStatus: orders.crmStatus,
          externalId: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.id'))`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.isFinal, false),
            isNotNull(orders.responseData),
            sql`JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.id')) IN (${sql.join(
              externalIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        );

      const sotuvchiMap = new Map(pageResult.data.map((o) => [String(o.id), o]));

      for (const match of matches) {
        const so = sotuvchiMap.get(match.externalId);
        if (!so) continue;
        const normalized = normalizeSotuvchiStatus(so.status);
        const terminal = isFinalStatus(normalized);
        const statusChanged = normalized !== match.crmStatus;
        await db.update(orders)
          .set({
            crmStatus: normalized,
            crmRawStatus: so.status,
            crmSyncedAt: new Date(),
            ...(statusChanged ? { isFinal: terminal } : {}),
          })
          .where(eq(orders.id, match.orderId));
        if (statusChanged) {
          console.log(`[PaginationSync] orderId=${match.orderId}: ${match.crmStatus ?? "null"} → ${normalized}${terminal ? " [FINAL]" : ""}`);
          void db.insert(orderEvents).values({
            orderId: match.orderId,
            userId: match.orderUserId,
            oldStatus: match.crmStatus ?? null,
            newStatus: normalized,
            source: "sync",
          }).catch(() => {});
        }
        synced++;
      }
    } catch (err) {
      console.error(`[PaginationSync] DB error on page ${page}:`, err instanceof Error ? err.message : err);
      errors++;
    }

    pagesProcessed++;

    // Stop when oldest order on this page is older than our stop boundary
    const oldestOnPage = new Date(pageResult.data.at(-1)!.created_at);
    if (oldestOnPage < stopBefore) {
      console.log(`[PaginationSync] Reached stop boundary at page ${page} (${oldestOnPage.toISOString()}) — done`);
      break;
    }
    if (page >= pageResult.last_page) break;
    page++;

    if (!syncState.aborted) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  }

  const result: SyncResult = {
    synced,
    errors,
    total: pagesProcessed * PAGE_LIMIT,
    syncedAt: new Date().toISOString(),
    message: `${pagesProcessed} sahifa, ${synced} order yangilandi`,
  };
  console.log(`[PaginationSync] Done — pages=${pagesProcessed} synced=${synced} errors=${errors}`);
  return result;
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
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };

      const where = and(
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
        input.platform
          ? eq(targetWebsites.appKey, input.platform)
          : or(eq(targetWebsites.appKey, "sotuvchi"), eq(targetWebsites.appKey, "100k")),
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
            crmRawStatus: orders.crmRawStatus,
            crmSyncedAt: orders.crmSyncedAt,
            isFinal: orders.isFinal,
            createdAt: orders.createdAt,
            leadName: leads.fullName,
            leadPhone: leads.phone,
            integrationName: integrations.name,
            appKey: targetWebsites.appKey,
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
    .mutation(({ }) => {
      if (syncState.running) {
        return { started: false, running: true, message: "Sync allaqachon ishlayapti..." };
      }
      syncState.running = true;
      syncState.aborted = false;
      syncState.progress = null;
      syncState.lastResult = null;
      void performPaginationSync()
        .then((r) => {
          syncState.running = false;
          syncState.progress = null;
          syncState.lastResult = r;
        })
        .catch((err: unknown) => {
          console.error("[PaginationSync] fatal error:", err);
          syncState.running = false;
          syncState.progress = null;
          syncState.lastResult = {
            synced: 0, errors: 1, total: 0,
            syncedAt: new Date().toISOString(),
            message: err instanceof Error ? err.message : String(err),
          };
        });
      return { started: true, running: true };
    }),

  stopSync: adminProcedure.mutation(() => {
    if (!syncState.running) return { ok: false, message: "Sync ishlamayapti" };
    syncState.aborted = true;
    console.log("[CrmSync] Stop requested by admin");
    return { ok: true };
  }),

  // ─── Poll sync state ───────────────────────────────────────────────────────

  getSyncStatus: adminProcedure.query(() => ({
    running: syncState.running,
    aborted: syncState.aborted,
    progress: syncState.progress,
    lastResult: syncState.lastResult,
  })),
});
