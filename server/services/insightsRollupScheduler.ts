/**
 * insightsRollupScheduler.ts
 *
 * Rebuilds `fact_attribution_daily` rows for every active user on a rolling
 * 7-day window. Single pass over (leads ⨯ orders ⨯ campaigns ⨯ ad_accounts)
 * per (user, date), grouped by the full FB attribution chain + offer.
 *
 * Why 15-min cadence + 7-day window
 *   - 15 min keeps "today" fresh enough for a marketer-facing dashboard
 *     without piling on top of the 5-min crmSyncScheduler.
 *   - 7 days covers sotuvchi.com's 3–5 day delivery lag: when a status
 *     flips from 'sent' → 'delivered' three days after the lead, the
 *     rollup of the lead's original date is re-derived next tick.
 *
 * Why DELETE + INSERT per (user, date)
 *   - Every output row is fully recomputable from the source tables —
 *     no incremental merging math, no double-count risk.
 *   - Idempotent: re-running the same window any number of times produces
 *     the same rows.
 *   - DELETE is bounded by the composite UNIQUE: small, fast, no table
 *     lock at the row counts we care about.
 *
 * Known Phase 1 limitation
 *   - When ONE lead fans out to multiple destinations with DIFFERENT
 *     offers, the lead is counted once per offer-row (because the grain
 *     of the table is (date, attribution, offer)). This over-counts the
 *     `leads` metric when the UI sums across offers in the same day.
 *     The Overview KPI tile sidesteps this by running a direct
 *     COUNT(leads) query rather than summing rollup rows.
 *   - Spend (FB ad spend) is not yet rolled up: `campaign_insights`
 *     today stores preset-aggregated values, not daily breakdowns.
 *     Phase 2 will widen the FB sync to pull daily insights.
 *
 * Registered in:
 *   server/workers/run.ts          (standalone worker)
 *   server/_core/index.ts          (embedded worker when START_WORKER=true)
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db";
import { log } from "./appLogger";

// ── Cadence ─────────────────────────────────────────────────────────────────
const ROLLUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const INITIAL_DELAY_MS = 2 * 60 * 1000; // delay first run so CRM sync goes first
const REBUILD_WINDOW_DAYS = 7;

// ── Concurrency guard ───────────────────────────────────────────────────────
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/**
 * Compute YYYY-MM-DD strings for the rebuild window, ending at "today" in
 * UTC. We use UTC consistently because leads.createdAt is stored in UTC
 * (MySQL TIMESTAMP) and DATE() returns its UTC date; mixing local
 * timezones here would silently mis-bucket rows around midnight.
 */
function rebuildDates(): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = 0; i < REBUILD_WINDOW_DAYS; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Rebuild every row in fact_attribution_daily for a single (userId, date).
 *
 * Sequence (one transaction per call):
 *   1. DELETE existing rows for (userId, date).
 *   2. INSERT fresh rows from a single GROUP-BY over the source tables.
 *
 * Step 2's grouping uses the same '' sentinel that the table's NOT NULL
 * default uses for "unknown / not applicable" — matches the UNIQUE index
 * semantics expected by future writes.
 */
async function rebuildOneDay(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
  date: string,
  currency: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // Wipe today's slate.
    await tx.execute(sql`
      DELETE FROM fact_attribution_daily
      WHERE userId = ${userId} AND date = ${date}
    `);

    // Rebuild from source. LEFT JOIN orders → leads without orders still
    // contribute a row (all order counters = 0, offerId = '').
    //
    // Lead counters use COUNT(DISTINCT l.id) so the orders-side fan-out
    // (one lead → N orders) does not multi-count leads / enriched / errors.
    //
    // Order counters use SUM(CASE WHEN …) so each order row is counted
    // exactly once. NULL on the orders side (no order yet) contributes 0
    // to every order counter — the CASE returns 0 for NULL inputs.
    //
    // Money:
    //   • revenueAmount sums payoutAmount only for delivered orders.
    //   • spendAmount is allocated proportionally — campaign_daily_insights
    //     gives us the FB spend per (campaign, date), and each rollup row
    //     within that campaign+date claims spend × (row_leads / campaign_leads).
    //     The currency-mismatch guard short-circuits to 0 when the ad
    //     account's currency differs from the user's reporting currency
    //     (v1: no FX). Fan-out leads can slightly over-attribute spend
    //     across offer slices — same caveat that affects leads counters.
    await tx.execute(sql`
      INSERT INTO fact_attribution_daily (
        userId, date,
        bmId, adAccountId, campaignId, adsetId, adId, pageId, formId, offerId,
        leads, enriched, enrichErrors,
        sent, failed,
        accepted, delivered, held, rejected, trash,
        spendAmount, revenueAmount, currency
      )
      SELECT
        l.userId,
        ${date}                                              AS date,
        COALESCE(aa.bmId,             '')                    AS bmId,
        COALESCE(c.fbAdAccountId,     '')                    AS adAccountId,
        COALESCE(l.campaignId,        '')                    AS campaignId,
        COALESCE(l.adsetId,           '')                    AS adsetId,
        COALESCE(l.adId,              '')                    AS adId,
        COALESCE(l.pageId,            '')                    AS pageId,
        COALESCE(l.formId,            '')                    AS formId,
        COALESCE(o.offerId,           '')                    AS offerId,

        COUNT(DISTINCT l.id)                                                                          AS leads,
        COUNT(DISTINCT CASE WHEN l.dataStatus = 'ENRICHED' THEN l.id END)                             AS enriched,
        COUNT(DISTINCT CASE WHEN l.dataStatus = 'ERROR'    THEN l.id END)                             AS enrichErrors,

        SUM(CASE WHEN o.status    = 'SENT'   THEN 1 ELSE 0 END)                                       AS sent,
        SUM(CASE WHEN o.status    = 'FAILED' THEN 1 ELSE 0 END)                                       AS failed,

        SUM(CASE WHEN o.crmStatus IN ('contacted','in_progress','sent','callback','success','delivered') THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN o.crmStatus = 'delivered'                                  THEN 1 ELSE 0 END)   AS delivered,
        SUM(CASE WHEN o.crmStatus IN ('callback','in_progress')                  THEN 1 ELSE 0 END)   AS held,
        SUM(CASE WHEN o.crmStatus IN ('cancelled','returned','not_delivered','not_sold') THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN o.crmStatus = 'trash'                                      THEN 1 ELSE 0 END)   AS trash,

        -- Proportional spend allocation. cs.spend & clt.total_leads are
        -- constants across the GROUP BY rows for the same campaign+date,
        -- so the per-row share is exact for non-fan-out leads.
        COALESCE(
          CASE
            WHEN cs.currency = ${currency} AND clt.totalLeads > 0
            THEN ROUND(CAST(cs.spend AS UNSIGNED) * COUNT(DISTINCT l.id) / clt.totalLeads)
            ELSE 0
          END,
          0
        )                                                                                             AS spendAmount,
        COALESCE(SUM(CASE WHEN o.crmStatus = 'delivered'
                            AND o.payoutAmount IS NOT NULL
                            AND o.payoutCurrency = ${currency}
                           THEN o.payoutAmount ELSE 0 END), 0)                                        AS revenueAmount,

        ${currency}                                                                                   AS currency
      FROM leads l
      LEFT JOIN orders      o  ON o.leadId = l.id        AND o.userId = l.userId
      LEFT JOIN campaigns   c  ON c.userId = l.userId    AND c.fbCampaignId   = l.campaignId
      LEFT JOIN ad_accounts aa ON aa.userId = l.userId   AND aa.fbAdAccountId = c.fbAdAccountId
      LEFT JOIN campaign_daily_insights cs
                                ON cs.userId      = l.userId
                                AND cs.fbCampaignId = l.campaignId
                                AND cs.date        = ${date}
      LEFT JOIN (
        SELECT userId, campaignId, COUNT(DISTINCT id) AS totalLeads
          FROM leads
         WHERE userId = ${userId}
           AND DATE(createdAt) = ${date}
           AND campaignId IS NOT NULL
           AND campaignId != ''
         GROUP BY userId, campaignId
      ) clt              ON clt.userId       = l.userId
                         AND clt.campaignId   = l.campaignId
      WHERE l.userId = ${userId}
        AND DATE(l.createdAt) = ${date}
      GROUP BY
        l.userId,
        bmId, adAccountId,
        l.campaignId, l.adsetId, l.adId,
        l.pageId, l.formId,
        offerId,
        cs.spend, cs.currency, clt.totalLeads
    `);
  });
}

/** One full pass — every user with activity in the window, every date in the window. */
async function runRollup(): Promise<void> {
  if (running) {
    console.log("[InsightsRollup] Skipping — previous run still in progress");
    return;
  }
  running = true;
  const startedAt = Date.now();

  try {
    const db = await getDb();
    if (!db) {
      await log.warn("SYSTEM", "[InsightsRollup] DB unavailable — skip", {});
      return;
    }

    const dates = rebuildDates();
    const earliest = dates[dates.length - 1];

    // Pick the set of users with any lead activity in the window. Avoids
    // scanning users with zero leads — they have nothing to roll up.
    const activeUsers = (await db.execute(sql`
      SELECT DISTINCT u.id AS userId, COALESCE(u.baseCurrency, 'USD') AS currency
      FROM users u
      JOIN leads l ON l.userId = u.id AND DATE(l.createdAt) >= ${earliest}
    `)) as unknown as Array<{ userId: number; currency: string }> | [Array<{ userId: number; currency: string }>, unknown];

    const rows = Array.isArray(activeUsers[0])
      ? (activeUsers[0] as Array<{ userId: number; currency: string }>)
      : (activeUsers as Array<{ userId: number; currency: string }>);

    let userCount = 0;
    let dayCount = 0;
    let errorCount = 0;

    for (const row of rows) {
      userCount++;
      for (const date of dates) {
        try {
          await rebuildOneDay(db, row.userId, date, row.currency ?? "USD");
          dayCount++;
        } catch (err) {
          errorCount++;
          await log.error(
            "SYSTEM",
            "[InsightsRollup] Failed to rebuild day",
            {
              userId: row.userId,
              date,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    console.log(
      `[InsightsRollup] Done — users=${userCount} day-runs=${dayCount} errors=${errorCount} ${durationMs}ms`,
    );
  } catch (err) {
    await log.error(
      "SYSTEM",
      "[InsightsRollup] Pass failed",
      { error: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    running = false;
  }
}

function scheduleNext(): void {
  schedulerTimer = setTimeout(() => {
    void runRollup().finally(() => {
      schedulerTimer = null;
      scheduleNext();
    });
  }, ROLLUP_INTERVAL_MS);
}

/** Start the periodic rollup. Idempotent — calling twice is a no-op. */
export function startInsightsRollupScheduler(): void {
  if (schedulerTimer !== null) return;
  console.log(
    `[InsightsRollup] Scheduler armed — first run in ${INITIAL_DELAY_MS / 1000}s, then every ${ROLLUP_INTERVAL_MS / 1000}s, window=${REBUILD_WINDOW_DAYS}d`,
  );
  schedulerTimer = setTimeout(() => {
    void runRollup().finally(() => {
      schedulerTimer = null;
      scheduleNext();
    });
  }, INITIAL_DELAY_MS);
}

/** Stop the scheduler — used by tests / graceful shutdown. */
export function stopInsightsRollupScheduler(): void {
  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

/** Manual single-pass trigger — exported for admin tooling and tests. */
export async function runInsightsRollupOnce(): Promise<void> {
  await runRollup();
}
