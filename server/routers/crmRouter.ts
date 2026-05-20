import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  crmConnections,
  orders,
  leads,
  integrations,
  integrationRoutes,
  destinations,
  orderEvents,
  users,
} from "../../drizzle/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { encrypt, decrypt } from "../encryption";
import {
  crmLogin,
  crmGetOrderStatus,
  extractExternalOrderId,
  sotuvchiGetOrdersPage,
  hundredKGetAdvertiserOrdersPage,
  type Platform,
  type OrderPageResult,
} from "../services/crmService";
import {
  shouldSkipCrmAccount,
  recordCrmFailure,
  recordCrmSuccess,
} from "../services/crmCircuitBreaker";
import {
  isFinalStatus,
  mapSotuvchiRawToNormalized,
  mapHundredKRawToNormalized,
} from "../../shared/crmStatuses";

/**
 * Affiliate platformalar — /admin/crm/orders filterida ishlatiladi.
 * Yangi platforma qo'shilsa shu ro'yxatga qo'shing. crmStatus polling
 * faqat sotuvchi + 100k uchun ulangan; qolganlari ko'rinishida null/raw
 * sifatida ko'rsatiladi (sync hozircha yo'q).
 */
const AFFILIATE_APP_KEYS = ["sotuvchi", "100k", "alijahon", "inbaza", "mgoods"] as const;

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
  running100k: false,
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
      appKey: destinations.appKey,
    })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(destinations, eq(integrations.destinationId, destinations.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        userId !== undefined ? eq(orders.userId, userId) : undefined,
        eq(orders.isFinal, false),
        isNotNull(orders.responseData),
        sql`(${activeDue} OR ${midDue})`,
        sql`${orders.createdAt} >= ${thirtyDaysAgo}`,
        platform
          ? eq(destinations.appKey, platform)
          : or(eq(destinations.appKey, "sotuvchi"), eq(destinations.appKey, "100k")),
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
      // Phase 3: capture payout when the adapter surfaces it (sotuvchi:
      // order.pay_for). Only write when present; null leaves any prior
      // captured value untouched.
      const payoutPatch =
        statusResult.payoutAmount != null && statusResult.payoutCurrency
          ? {
              payoutAmount: statusResult.payoutAmount,
              payoutCurrency: statusResult.payoutCurrency,
            }
          : {};
      await db!.update(orders)
        .set({
          crmStatus: statusResult.status,
          crmRawStatus: statusResult.rawStatus,
          crmSyncedAt: new Date(),
          ...(statusChanged ? { isFinal: terminal } : {}),
          ...payoutPatch,
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

  console.log(
    `[CrmSync/per-order] Done — synced=${synced} errors=${errors} total=${pendingOrders.length} (max 200 queue)`,
  );
  return { synced, errors, total: pendingOrders.length, syncedAt: new Date().toISOString() };
}

// ─── Pagination sync (bulk: 200 orders/page, stops at oldest non-final order) ──

const PAGE_LIMIT = 200;
const PAGE_DELAY_MS = 800;

/** 100k advertiser list: smaller pages (~20) — pause longer to stay under rate limits. */
const HUNDREDK_PAGE_DELAY_MS = 2000;
/** ±jitter on top of the page delay — randomises traffic so it doesn't look bot-like. */
const HUNDREDK_PAGE_JITTER_MS = 700;
/** Fallback when API omits `meta.total` (approx rows scanned). */
const HUNDREDK_FALLBACK_PAGE_ROWS = 20;
/**
 * Daily request budget (UTC day) — once we've burned this many advertiser-
 * orders requests in a 24h window we bail until the counter rolls over. At
 * worst case this caps load at 5000 requests/day = 100k orders scanned/day,
 * which is plenty for incremental sync once initial backfill is finished.
 */
const HUNDREDK_DAILY_REQUEST_BUDGET = 5000;
/**
 * Consecutive non-429 errors before circuit-breaker trips and we abort the
 * cycle entirely. Keeps a misbehaving server (or our network) from
 * hammering 100k.uz with retry storms.
 */
const HUNDREDK_CIRCUIT_BREAKER_HITS = 5;
/**
 * Single allowed value for the API's `lead_source_grouped` parameter. Tested
 * against api.100k.uz: alternative buckets ("new"/"completed") return HTTP
 * 422, but with `in_progress` the response actually contains EVERY funnel
 * status (new, accepted, booked, sent, archived, delivered, cancelled, …) —
 * the parameter does not filter, it's just a required incantation.
 */
const HUNDREDK_LEAD_SOURCE_GROUPED = "in_progress";
/**
 * Hard ceiling on pages walked per cycle. The advertiser-orders feed for
 * an established advertiser can have 10k+ pages of historical orders; we
 * stop early either when we cross the `stopBefore` boundary OR when this
 * cap fires, whichever comes first. 1000 pages × 20 rows = ~20k orders ≈
 * the last 60 days of activity for a heavy advertiser, plus a 33-min
 * worst-case wall time at HUNDREDK_PAGE_DELAY_MS — comfortable headroom.
 */
const HUNDREDK_MAX_PAGES_PER_CYCLE = 1000;

function hundredK429BackoffMs(err: unknown): number {
  const ax = err as {
    response?: { headers?: Record<string, string | undefined>; status?: number };
  };
  if (ax?.response?.status !== 429) return 45_000;
  const raw =
    ax.response.headers?.["retry-after"] ??
    ax.response.headers?.["Retry-After"] ??
    "";
  const sec = parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(sec) || sec < 1) return 45_000;
  return Math.min(Math.max(sec, 5), 120) * 1000;
}

/**
 * Module-scope daily request budget for the 100k.uz advertiser-orders feed.
 * Persists across sync cycles within the same process so a single greedy
 * cycle can't blow past the daily cap. Resets at the next UTC midnight.
 */
const hundredKBudget = {
  spent: 0,
  /** UTC YYYY-MM-DD of the day the counter belongs to. */
  day: "",
};

function hundredKBudgetCheck(): { allowed: boolean; remaining: number; day: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (hundredKBudget.day !== today) {
    hundredKBudget.day = today;
    hundredKBudget.spent = 0;
  }
  const remaining = HUNDREDK_DAILY_REQUEST_BUDGET - hundredKBudget.spent;
  return { allowed: remaining > 0, remaining, day: today };
}

function hundredKBudgetSpend(n = 1): void {
  const today = new Date().toISOString().slice(0, 10);
  if (hundredKBudget.day !== today) {
    hundredKBudget.day = today;
    hundredKBudget.spent = 0;
  }
  hundredKBudget.spent += n;
}

/** Sleep for `base` plus uniform random jitter in ±jitter range. */
async function hundredKPagePause(base: number, jitter: number): Promise<void> {
  const offset = (Math.random() * 2 - 1) * jitter;
  const ms = Math.max(0, base + offset);
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Sync one Sotuvchi crm_connections account. Walks that account's
 * /getOrders feed and updates ONLY orders belonging to destinations
 * owned by `acc.userId`. Each Targenix user has their own Sotuvchi
 * webmaster account (separate platformUserId + bearer), so without
 * per-user scoping the sync sees only one account's orders.
 */
async function syncOneSotuvchiAccount(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  acc: typeof crmConnections.$inferSelect,
): Promise<{ synced: number; errors: number; pagesProcessed: number; message?: string }> {
  const skip = shouldSkipCrmAccount(acc.id);
  if (skip.skip) {
    console.warn(`[PaginationSync] Skipping sotuvchi account ${acc.id} (user ${acc.userId}) — ${skip.reason}`);
    return { synced: 0, errors: 0, pagesProcessed: 0, message: `Skipped: ${skip.reason}` };
  }

  // Stop boundary is per-user — anchor to THIS user's oldest pending
  // order so we don't walk further back than needed for this account.
  const [oldestRow] = await db
    .select({ createdAt: orders.createdAt })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(destinations, eq(integrations.destinationId, destinations.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        eq(orders.isFinal, false),
        isNotNull(orders.responseData),
        eq(destinations.appKey, "sotuvchi"),
        eq(destinations.userId, acc.userId),
      ),
    )
    .orderBy(asc(orders.createdAt))
    .limit(1);

  const stopBefore = oldestRow
    ? new Date(oldestRow.createdAt.getTime() - 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  console.log(`[PaginationSync] acc=${acc.id} user=${acc.userId} stopBefore=${stopBefore.toISOString()}`);

  let bearerToken = decrypt(acc.bearerTokenEncrypted);
  let page = 1;
  let synced = 0;
  let errors = 0;
  let pagesProcessed = 0;

  while (!syncState.aborted) {
    let pageResult: OrderPageResult;
    try {
      pageResult = await sotuvchiGetOrdersPage(bearerToken, page, PAGE_LIMIT)
        .catch(async (err) => {
          if (err?.response?.status === 401) {
            const password = decrypt(acc.passwordEncrypted);
            const r = await crmLogin("sotuvchi", acc.phone, password);
            bearerToken = r.bearerToken;
            await db.update(crmConnections)
              .set({ bearerTokenEncrypted: encrypt(r.bearerToken), status: "active", lastLoginAt: new Date() })
              .where(eq(crmConnections.id, acc.id));
            return sotuvchiGetOrdersPage(bearerToken, page, PAGE_LIMIT);
          }
          if (err?.response?.status === 429) {
            console.warn(`[PaginationSync] 429 on page ${page} (acc=${acc.id}) — pausing 30s`);
            if (syncState.progress) syncState.progress.rateLimited = true;
            await new Promise((r) => setTimeout(r, 30_000));
            if (syncState.progress) syncState.progress.rateLimited = false;
            return sotuvchiGetOrdersPage(bearerToken, page, PAGE_LIMIT);
          }
          throw err;
        });
    } catch (err) {
      console.error(`[PaginationSync] acc=${acc.id} failed on page ${page}:`, err instanceof Error ? err.message : err);
      errors++;
      break;
    }

    if (!pageResult.data.length) break;

    if (page === 1) {
      console.log(`[PaginationSync] acc=${acc.id} ${pageResult.total.toLocaleString()} total Sotuvchi orders, ${pageResult.last_page.toLocaleString()} pages`);
      if (syncState.progress) syncState.progress.total = pageResult.last_page;
    }
    if (syncState.progress) syncState.progress.current = page;

    const externalIds = pageResult.data.map((o) => String(o.id));
    try {
      // Scope match query to this account's user — without this, an account's
      // bearer would silently update orders belonging to OTHER Targenix users.
      // The previous query had no destinations join at all; matches relied on
      // sotuvchi extIds being globally unique. Adding the join + userId filter
      // is correct + defensive.
      const matches = await db
        .select({
          orderId: orders.id,
          orderUserId: orders.userId,
          crmStatus: orders.crmStatus,
          externalId: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.id'))`,
        })
        .from(orders)
        .innerJoin(integrations, eq(orders.integrationId, integrations.id))
        .innerJoin(destinations, eq(integrations.destinationId, destinations.id))
        .where(
          and(
            eq(destinations.appKey, "sotuvchi"),
            eq(destinations.userId, acc.userId),
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
        const normalized = mapSotuvchiRawToNormalized(so.status);
        const terminal = isFinalStatus(normalized);
        const statusChanged = normalized !== match.crmStatus;
        const payoutPatch =
          so.payoutAmount != null && so.payoutCurrency
            ? { payoutAmount: so.payoutAmount, payoutCurrency: so.payoutCurrency }
            : {};
        const offerNamePatch = so.offerName ? { offerName: so.offerName } : {};
        const offerIdPatch = so.offerId ? { offerId: so.offerId } : {};
        await db.update(orders)
          .set({
            crmStatus: normalized,
            crmRawStatus: so.status,
            crmSyncedAt: new Date(),
            ...(statusChanged ? { isFinal: terminal } : {}),
            ...payoutPatch,
            ...offerNamePatch,
            ...offerIdPatch,
          })
          .where(eq(orders.id, match.orderId));
        if (statusChanged) {
          console.log(`[PaginationSync] acc=${acc.id} orderId=${match.orderId}: ${match.crmStatus ?? "null"} → ${normalized}${terminal ? " [FINAL]" : ""}`);
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
      console.error(`[PaginationSync] acc=${acc.id} DB error on page ${page}:`, err instanceof Error ? err.message : err);
      errors++;
    }

    pagesProcessed++;

    const oldestOnPage = new Date(pageResult.data.at(-1)!.created_at);
    if (oldestOnPage < stopBefore) {
      console.log(`[PaginationSync] acc=${acc.id} reached stop boundary at page ${page} (${oldestOnPage.toISOString()}) — done`);
      break;
    }
    if (page >= pageResult.last_page) break;
    page++;

    if (!syncState.aborted) {
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }
  }

  if (errors > 0 && synced === 0) {
    recordCrmFailure(acc.id);
  } else {
    recordCrmSuccess(acc.id);
  }

  console.log(`[PaginationSync] acc=${acc.id} user=${acc.userId} done — pages=${pagesProcessed} synced=${synced} errors=${errors}`);
  return { synced, errors, pagesProcessed };
}

export async function performPaginationSync(): Promise<SyncResult> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // Iterate ALL active sotuvchi accounts (one per Targenix user). Same
  // architectural fix as 100k.uz — see syncOneHundredKAccount.
  const accounts = await db
    .select()
    .from(crmConnections)
    .where(
      and(
        eq(crmConnections.platform, "sotuvchi"),
        eq(crmConnections.status, "active"),
      ),
    );

  if (accounts.length === 0) {
    return { synced: 0, errors: 0, total: 0, syncedAt: new Date().toISOString(), message: "Sotuvchi akkaunt topilmadi" };
  }

  syncState.progress = { current: 0, total: 0, platform: "sotuvchi", rateLimited: false };

  let totalSynced = 0;
  let totalErrors = 0;
  let totalPages = 0;

  for (const acc of accounts) {
    if (syncState.aborted) break;
    const { synced, errors, pagesProcessed } = await syncOneSotuvchiAccount(db, acc);
    totalSynced += synced;
    totalErrors += errors;
    totalPages += pagesProcessed;
  }

  const result: SyncResult = {
    synced: totalSynced,
    errors: totalErrors,
    total: totalPages * PAGE_LIMIT,
    syncedAt: new Date().toISOString(),
    message: `${accounts.length} akkaunt, ${totalPages} sahifa, ${totalSynced} order yangilandi`,
  };
  console.log(`[PaginationSync] all-accounts done — accounts=${accounts.length} pages=${totalPages} synced=${totalSynced} errors=${totalErrors}`);
  return result;
}

// ─── 100k.uz pagination sync (bulk list → match DB orders by external id) ───────

/**
 * Sync one 100k.uz crm_connections account. Walks that account's
 * advertiser-orders feed and updates ONLY orders belonging to destinations
 * owned by `acc.userId`. Each Targenix user has their own 100k.uz advertiser
 * profile (separate api_key + bearer), so without per-user scoping the sync
 * sees only the account whose bearer token it holds.
 */
async function syncOneHundredKAccount(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  acc: typeof crmConnections.$inferSelect,
): Promise<{ synced: number; errors: number; pagesProcessed: number; apiReportedTotal: number; message?: string }> {
  const profileId = acc.platformUserId?.trim();
  if (!profileId) {
    return { synced: 0, errors: 0, pagesProcessed: 0, apiReportedTotal: 0, message: `platformUserId bo'sh (acc=${acc.id})` };
  }

  const skip = shouldSkipCrmAccount(acc.id);
  if (skip.skip) {
    console.warn(`[PaginationSync/100k] Skipping 100k account ${acc.id} (user ${acc.userId}) — ${skip.reason}`);
    return { synced: 0, errors: 0, pagesProcessed: 0, apiReportedTotal: 0, message: `Skipped: ${skip.reason}` };
  }

  // Stop boundary is per-user: walk back until the oldest pending order
  // belonging to THIS user. With one shared boundary across users the loop
  // would chase an unreachable depth set by whichever user has the oldest
  // backlog.
  const [oldestRow] = await db
    .select({ createdAt: orders.createdAt })
    .from(orders)
    .innerJoin(integrations, eq(orders.integrationId, integrations.id))
    .innerJoin(destinations, eq(integrations.destinationId, destinations.id))
    .where(
      and(
        eq(orders.status, "SENT"),
        eq(orders.isFinal, false),
        isNotNull(orders.responseData),
        eq(destinations.appKey, "100k"),
        eq(destinations.userId, acc.userId),
      ),
    )
    .orderBy(asc(orders.createdAt))
    .limit(1);

  const stopBefore = oldestRow
    ? new Date(oldestRow.createdAt.getTime() - 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  console.log(`[PaginationSync/100k] acc=${acc.id} user=${acc.userId} profile=${profileId} stopBefore=${stopBefore.toISOString()}`);

  let bearerToken = decrypt(acc.bearerTokenEncrypted);
  let page = 1;
  let synced = 0;
  let errors = 0;
  let pagesProcessed = 0;
  let consecutiveErrors = 0;
  let apiReportedTotal = 0;

  while (!syncState.aborted) {
    const budget = hundredKBudgetCheck();
    if (!budget.allowed) {
      console.warn(
        `[PaginationSync/100k] Daily budget exhausted (${HUNDREDK_DAILY_REQUEST_BUDGET}/day, day=${budget.day}) — stopping until next UTC midnight`,
      );
      break;
    }

    let pageResult: OrderPageResult;
    try {
      hundredKBudgetSpend(1);
      pageResult = await hundredKGetAdvertiserOrdersPage(
        bearerToken,
        profileId,
        page,
        HUNDREDK_LEAD_SOURCE_GROUPED,
      ).catch(async (err: unknown) => {
        const axiosErr = err as { response?: { status?: number } };
        if (axiosErr?.response?.status === 401) {
          const password = decrypt(acc.passwordEncrypted);
          const r = await crmLogin("100k", acc.phone, password);
          bearerToken = r.bearerToken;
          await db.update(crmConnections)
            .set({
              bearerTokenEncrypted: encrypt(r.bearerToken),
              status: "active",
              lastLoginAt: new Date(),
            })
            .where(eq(crmConnections.id, acc.id));
          return hundredKGetAdvertiserOrdersPage(
            bearerToken,
            profileId,
            page,
            HUNDREDK_LEAD_SOURCE_GROUPED,
          );
        }
        if (axiosErr?.response?.status === 429) {
          const pauseMs = hundredK429BackoffMs(err);
          console.warn(
            `[PaginationSync/100k] 429 on page ${page} (acc=${acc.id}) — pausing ${pauseMs / 1000}s`,
          );
          if (syncState.progress) syncState.progress.rateLimited = true;
          await new Promise((r) => setTimeout(r, pauseMs));
          if (syncState.progress) syncState.progress.rateLimited = false;
          return hundredKGetAdvertiserOrdersPage(
            bearerToken,
            profileId,
            page,
            HUNDREDK_LEAD_SOURCE_GROUPED,
          );
        }
        throw err;
      });
    } catch (err) {
      console.error(
        `[PaginationSync/100k] acc=${acc.id} failed on page ${page}:`,
        err instanceof Error ? err.message : err,
      );
      errors++;
      consecutiveErrors++;
      if (consecutiveErrors >= HUNDREDK_CIRCUIT_BREAKER_HITS) {
        console.warn(
          `[PaginationSync/100k] Circuit breaker tripped for acc=${acc.id} (${consecutiveErrors} consecutive errors) — bailing out`,
        );
        break;
      }
      await hundredKPagePause(HUNDREDK_PAGE_DELAY_MS * 3, HUNDREDK_PAGE_JITTER_MS);
      page++;
      continue;
    }
    consecutiveErrors = 0;

    if (!pageResult.data.length) break;

    if (page === 1) {
      apiReportedTotal = pageResult.total > 0 ? pageResult.total : 0;
      console.log(
        `[PaginationSync/100k] acc=${acc.id} ${pageResult.total.toLocaleString()} orders (API), ${pageResult.last_page.toLocaleString()} sahifa`,
      );
      if (syncState.progress) syncState.progress.total = pageResult.last_page;
    }
    if (syncState.progress) syncState.progress.current = page;

    const externalIds = pageResult.data.map((o) => String(o.id));
    const externalIdExpr = sql<string>`COALESCE(
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.order_id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.data.id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.data.order_id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.data.data.id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.order.id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.order_id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.data.id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.data.order_id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.data.data.id')), ''),
      NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.body.order.id')), '')
    )`;
    try {
      // Scope match query to this account's user — without this, an account's
      // bearer token would silently update orders belonging to OTHER Targenix
      // users that happen to share the same 100k order_id (which can happen
      // because 100k.uz returns an existing order_id for duplicate phones).
      const matches = await db
        .select({
          orderId: orders.id,
          orderUserId: orders.userId,
          crmStatus: orders.crmStatus,
          crmRawStatus: orders.crmRawStatus,
          externalId: externalIdExpr,
        })
        .from(orders)
        .innerJoin(integrations, eq(orders.integrationId, integrations.id))
        .innerJoin(destinations, eq(integrations.destinationId, destinations.id))
        .where(
          and(
            eq(destinations.appKey, "100k"),
            eq(destinations.userId, acc.userId),
            eq(orders.isFinal, false),
            isNotNull(orders.responseData),
            sql`${externalIdExpr} IN (${sql.join(
              externalIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        );

      const hundredKMap = new Map(pageResult.data.map((o) => [String(o.id), o]));

      for (const match of matches) {
        const ho = hundredKMap.get(match.externalId);
        if (!ho) continue;
        const normalized = mapHundredKRawToNormalized(ho.status) as string;
        const rawIncoming = String(ho.status ?? "");
        const rawStored = String(match.crmRawStatus ?? "");
        if (normalized === match.crmStatus && rawIncoming === rawStored) {
          continue;
        }

        const terminal = isFinalStatus(normalized);
        const statusChanged = normalized !== match.crmStatus;
        // Phase 3.1: 100k.uz bulk feed now returns SUM(order_items[].to_withdraw)
        // as payoutAmount + "UZS" currency on every row (verified 2026-05-20).
        // Mirror the Sotuvchi pattern: write payoutAmount whenever the parser
        // captured it. The skip-when-unchanged guard above means historic rows
        // whose status never changes after this PR ships won't get backfilled
        // here — the tooling/backfill-100k-payouts.mjs one-shot covers those.
        const payoutPatch =
          ho.payoutAmount != null && ho.payoutCurrency
            ? { payoutAmount: ho.payoutAmount, payoutCurrency: ho.payoutCurrency }
            : {};
        await db
          .update(orders)
          .set({
            crmStatus: normalized,
            crmRawStatus: ho.status,
            crmSyncedAt: new Date(),
            ...(statusChanged ? { isFinal: terminal } : {}),
            ...payoutPatch,
          })
          .where(eq(orders.id, match.orderId));
        if (statusChanged) {
          console.log(
            `[PaginationSync/100k] acc=${acc.id} orderId=${match.orderId}: ${match.crmStatus ?? "null"} → ${normalized}${terminal ? " [FINAL]" : ""}`,
          );
          void db
            .insert(orderEvents)
            .values({
              orderId: match.orderId,
              userId: match.orderUserId,
              oldStatus: match.crmStatus ?? null,
              newStatus: normalized,
              source: "sync",
            })
            .catch(() => {});
        }
        synced++;
      }
    } catch (err) {
      console.error(
        `[PaginationSync/100k] acc=${acc.id} DB error on page ${page}:`,
        err instanceof Error ? err.message : err,
      );
      errors++;
    }

    pagesProcessed++;

    if (pagesProcessed % 25 === 0) {
      console.log(
        `[PaginationSync/100k] acc=${acc.id} progress page=${page}, oldestOnPage=${pageResult.data.at(-1)!.created_at}, synced=${synced}`,
      );
    }

    const oldestOnPage = new Date(pageResult.data.at(-1)!.created_at);
    if (oldestOnPage < stopBefore) {
      console.log(
        `[PaginationSync/100k] acc=${acc.id} stop boundary at page ${page} (oldest=${oldestOnPage.toISOString()}, stopBefore=${stopBefore.toISOString()}) — done`,
      );
      break;
    }
    if (page >= pageResult.last_page) break;
    if (page >= HUNDREDK_MAX_PAGES_PER_CYCLE) {
      console.warn(
        `[PaginationSync/100k] acc=${acc.id} hit max-pages cap (${HUNDREDK_MAX_PAGES_PER_CYCLE}) at oldest=${oldestOnPage.toISOString()} — bailing for next cycle`,
      );
      break;
    }
    page++;

    if (!syncState.aborted) {
      await hundredKPagePause(HUNDREDK_PAGE_DELAY_MS, HUNDREDK_PAGE_JITTER_MS);
    }
  }

  if (errors > 0 && synced === 0) {
    recordCrmFailure(acc.id);
  } else {
    recordCrmSuccess(acc.id);
  }

  console.log(`[PaginationSync/100k] acc=${acc.id} user=${acc.userId} done — pages=${pagesProcessed} synced=${synced} errors=${errors}`);
  return { synced, errors, pagesProcessed, apiReportedTotal };
}

export async function performPaginationSync100k(): Promise<SyncResult> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  // Iterate ALL active 100k accounts (one per Targenix user) — earlier code
  // picked LIMIT 1, which meant only that user's orders ever synced. Other
  // users' destinations push to their own 100k profiles with their own
  // api_keys; the shared bearer can't see those orders.
  const accounts = await db
    .select()
    .from(crmConnections)
    .where(
      and(
        eq(crmConnections.platform, "100k"),
        eq(crmConnections.status, "active"),
      ),
    );

  if (accounts.length === 0) {
    return {
      synced: 0,
      errors: 0,
      total: 0,
      syncedAt: new Date().toISOString(),
      message: "100k.uz akkaunt topilmadi",
    };
  }

  syncState.progress = { current: 0, total: 0, platform: "100k", rateLimited: false };

  let totalSynced = 0;
  let totalErrors = 0;
  let totalPages = 0;
  let aggApiReported = 0;

  for (const acc of accounts) {
    if (syncState.aborted) break;
    const { synced, errors, pagesProcessed, apiReportedTotal } =
      await syncOneHundredKAccount(db, acc);
    totalSynced += synced;
    totalErrors += errors;
    totalPages += pagesProcessed;
    aggApiReported += apiReportedTotal;
  }

  const scannedApprox =
    aggApiReported > 0 ? aggApiReported : totalPages * HUNDREDK_FALLBACK_PAGE_ROWS;

  const result: SyncResult = {
    synced: totalSynced,
    errors: totalErrors,
    total: scannedApprox,
    syncedAt: new Date().toISOString(),
    message: `${accounts.length} akkaunt, ${totalPages} sahifa (100k), ${totalSynced} order yangilandi`,
  };
  console.log(`[PaginationSync/100k] all-accounts done — accounts=${accounts.length} pages=${totalPages} synced=${totalSynced} errors=${totalErrors}`);
  return result;
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

export const crmRouter = router({
  listUsers: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .orderBy(asc(users.id));
    return rows;
  }),

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
        platform: z.enum(AFFILIATE_APP_KEYS).optional(),
        crmStatus: z.string().optional(),
        userId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };

      // Resolve destinationId per order:
      //   – Multi-destination orders carry `orders.destinationId` →
      //     `integration_routes.destinationId` (fan-out path).
      //   – Legacy single-destination orders only have
      //     `integrations.destinationId` (old path).
      // COALESCE picks whichever is set. The INNER JOIN on destinations
      // then drops any order whose destination was hard-deleted (visible
      // as "orphan" in the diagnostic — these need a separate UI affordance
      // if we ever want them shown, since their appKey is unknowable here).
      const twJoinExpr = sql`${destinations.id} = COALESCE(${integrationRoutes.destinationId}, ${integrations.destinationId})`;

      const where = and(
        eq(orders.status, "SENT"),
        isNotNull(orders.responseData),
        input.userId ? eq(orders.userId, input.userId) : undefined,
        input.platform
          ? eq(destinations.appKey, input.platform)
          : inArray(destinations.appKey, AFFILIATE_APP_KEYS),
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
            appKey: destinations.appKey,
          })
          .from(orders)
          .innerJoin(leads, eq(orders.leadId, leads.id))
          .leftJoin(integrations, eq(orders.integrationId, integrations.id))
          .leftJoin(
            integrationRoutes,
            eq(orders.destinationId, integrationRoutes.id),
          )
          .innerJoin(destinations, twJoinExpr)
          .where(where)
          .orderBy(desc(orders.createdAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ total: sql<number>`COUNT(*)` })
          .from(orders)
          .leftJoin(integrations, eq(orders.integrationId, integrations.id))
          .leftJoin(
            integrationRoutes,
            eq(orders.destinationId, integrationRoutes.id),
          )
          .innerJoin(destinations, twJoinExpr)
          .where(where),
      ]);

      return { items, total };
    }),

  // ─── Sync: start background job, return immediately ──────────────────────

  syncOrderStatuses: adminProcedure
    .input(z.object({ platform: z.enum(["sotuvchi", "100k"]).optional() }))
    .mutation(({ input }) => {
      const is100k = input.platform === "100k";
      if (is100k) {
        if (syncState.running100k) {
          return { started: false, running: true, message: "100k sync allaqachon ishlayapti..." };
        }
      } else {
        if (syncState.running) {
          return { started: false, running: true, message: "Sotuvchi sync allaqachon ishlayapti..." };
        }
      }
      if (!is100k) syncState.running = true;
      else syncState.running100k = true;
      syncState.aborted = false;
      syncState.progress = null;
      syncState.lastResult = null;
      const job = is100k ? performPaginationSync100k() : performPaginationSync();
      void job
        .then((r) => {
          if (!is100k) syncState.running = false;
          else syncState.running100k = false;
          syncState.progress = null;
          syncState.lastResult = r;
        })
        .catch((err: unknown) => {
          console.error("[CrmSync] fatal error:", err);
          if (!is100k) syncState.running = false;
          else syncState.running100k = false;
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
    if (!syncState.running && !syncState.running100k) {
      return { ok: false, message: "Sync ishlamayapti" };
    }
    syncState.aborted = true;
    console.log("[CrmSync] Stop requested by admin");
    return { ok: true };
  }),

  // ─── Poll sync state ───────────────────────────────────────────────────────

  getSyncStatus: adminProcedure.query(() => ({
    running: syncState.running,
    running100k: syncState.running100k,
    aborted: syncState.aborted,
    progress: syncState.progress,
    lastResult: syncState.lastResult,
  })),
});
