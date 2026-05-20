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
/**
 * Recurring window — every 15-min tick rebuilds today + yesterday only.
 * Two days are enough to catch same-day status flips AND status changes
 * that arrived after yesterday's UTC midnight (sotuvchi often updates an
 * order within a few hours of delivery).
 */
const RECURRING_WINDOW_DAYS = 2;
/**
 * Nightly window — once per day rebuild the full 7-day window to catch
 * Sotuvchi's 3–5 day delivery lag (a status that flips from 'sent' →
 * 'delivered' three days after the lead is rolled up here at the next
 * nightly tick).
 */
const NIGHTLY_REBUILD_WINDOW_DAYS = 7;
/**
 * UTC hour at which the nightly full-window rebuild runs. 02:00 UTC = 07:00
 * Tashkent (UZB+5) — before the marketer day starts, after the previous
 * day's CRM final statuses have settled.
 */
const NIGHTLY_HOUR_UTC = 2;

// ── Concurrency guard ───────────────────────────────────────────────────────
let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/**
 * Compute YYYY-MM-DD strings for the rebuild window, ending at "today" in
 * Asia/Tashkent (UTC+5). The whole insights pipeline buckets by the
 * marketer's local day — leads.createdAt is stored in UTC but the
 * rebuildOneDay SQL CONVERT_TZ's it to +05:00 before applying DATE(),
 * and the frontend rangeFor sends Tashkent dates too. Picking dates here
 * with `today` defined as Tashkent's current calendar day keeps the
 * scheduler in lockstep with the read path — picking a UTC date would
 * silently miss the 05:00–23:59 UTC range of "Tashkent today" until the
 * next tick crossed UTC midnight.
 */
const TZ_OFFSET_HOURS = 5; // Asia/Tashkent — no DST since 1992.
function tashkentDayStr(d: Date): string {
  const shifted = new Date(d.getTime() + TZ_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
function rebuildDates(windowDays: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = 0; i < windowDays; i++) {
    out.push(tashkentDayStr(new Date(now.getTime() - i * 86_400_000)));
  }
  return out;
}

/**
 * Pick the rebuild window for this tick. 02:00 UTC tick → full 7-day
 * reconciliation; every other tick → today + yesterday only. Reduces RAM /
 * CPU spikes ~4-5× at the cost of a one-day reconciliation lag for status
 * changes 2-7 days old (next 02:00 UTC tick catches them).
 */
function pickWindowForThisTick(now: Date): number {
  return now.getUTCHours() === NIGHTLY_HOUR_UTC
    ? NIGHTLY_REBUILD_WINDOW_DAYS
    : RECURRING_WINDOW_DAYS;
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
  // Phase 4: pre-fetch the FX rate for this day. We use "most recent rate
  // on or before `date`" so weekends/holidays inherit the prior business
  // day's CBU publish (CBU does the same fallback on its own endpoint).
  // null means we have no rate yet → cross-currency CASE branches return 0,
  // which matches the v1 "no FX = skip" safety guard.
  const fxRowRaw = await db.execute(sql`
    SELECT uzs_per_usd FROM fx_rates
    WHERE \`date\` <= ${date}
    ORDER BY \`date\` DESC
    LIMIT 1
  `);
  const fxList = ((fxRowRaw as unknown as [Array<{ uzs_per_usd?: string }>, unknown])?.[0] ?? []) as Array<{ uzs_per_usd?: string }>;
  const fxRate = fxList[0]?.uzs_per_usd ?? null;

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
    // Phase 4 rollup SQL changes vs Phase 2:
    //   • leads counter: COUNT(DISTINCT) now gated on o.status='SENT' so
    //     leads that never made it past dispatch don't inflate the funnel
    //     top. The "real leads we sent to the CRM" definition.
    //   • pipelineAmount: new money column summing sotuvchi pay_for for
    //     orders past `new` but not yet `delivered` (contacted /
    //     in_progress / sent / callback / success). Surfaces on the UI
    //     as "in-flight" revenue; intentionally excluded from Profit.
    //   • FX conversion: revenueAmount, spendAmount and pipelineAmount now
    //     pass through a same-currency / UZS→USD / USD→UZS branch each.
    //     The fxRate variable is pre-fetched from fx_rates above; null
    //     means "no rate on file" → the conversion branches return 0,
    //     matching the v1 "no FX = skip" safety guard.
    await tx.execute(sql`
      INSERT INTO fact_attribution_daily (
        userId, date,
        bmId, adAccountId, campaignId, adsetId, adId, pageId, formId, offerId,
        leads, enriched, enrichErrors,
        sent, failed,
        accepted, delivered, held, rejected, trash,
        spendAmount, revenueAmount, pipelineAmount, currency
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

        -- Phase 4: leads = only those that made it to SENT. PENDING /
        -- FAILED dispatches don't count toward "leads received by the CRM".
        COUNT(DISTINCT CASE WHEN o.status = 'SENT' THEN l.id END)                                     AS leads,
        COUNT(DISTINCT CASE WHEN l.dataStatus = 'ENRICHED' THEN l.id END)                             AS enriched,
        COUNT(DISTINCT CASE WHEN l.dataStatus = 'ERROR'    THEN l.id END)                             AS enrichErrors,

        SUM(CASE WHEN o.status    = 'SENT'   THEN 1 ELSE 0 END)                                       AS sent,
        SUM(CASE WHEN o.status    = 'FAILED' THEN 1 ELSE 0 END)                                       AS failed,

        SUM(CASE WHEN o.crmStatus IN ('contacted','in_progress','sent','callback','not_delivered','out_of_stock','success','delivered') THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN o.crmStatus = 'delivered'                                  THEN 1 ELSE 0 END)   AS delivered,
        SUM(CASE WHEN o.crmStatus IN ('callback','in_progress','not_delivered','out_of_stock')  THEN 1 ELSE 0 END) AS held,
        SUM(CASE WHEN o.crmStatus IN ('cancelled','returned','not_sold')          THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN o.crmStatus = 'trash'                                      THEN 1 ELSE 0 END)   AS trash,

        -- Phase 4: proportional spend allocation WITH FX conversion. The
        -- conversion happens BEFORE the per-row allocation, then the
        -- allocation ratio splits the converted spend across the rollup
        -- rows under that campaign+date. Same-currency case is the fast
        -- path (no math). Cross-currency rounds to the target currency's
        -- smallest unit.
        COALESCE(
          ROUND(
            (CASE
               WHEN cs.currency = ${currency} THEN CAST(cs.spend AS UNSIGNED)
               WHEN cs.currency = 'UZS' AND ${currency} = 'USD' AND ${fxRate} IS NOT NULL
                 THEN CAST(cs.spend AS UNSIGNED) * 100.0 / ${fxRate}
               WHEN cs.currency = 'USD' AND ${currency} = 'UZS' AND ${fxRate} IS NOT NULL
                 THEN CAST(cs.spend AS UNSIGNED) / 100.0 * ${fxRate}
               ELSE NULL
             END)
            * COUNT(DISTINCT l.id) / NULLIF(clt.totalLeads, 0)
          ),
          0
        )                                                                                             AS spendAmount,

        -- Phase 4: revenue = SUM(payout) for delivered orders, with FX.
        COALESCE(SUM(
          CASE WHEN o.crmStatus = 'delivered' AND o.payoutAmount IS NOT NULL THEN
            CASE
              WHEN o.payoutCurrency = ${currency} THEN o.payoutAmount
              WHEN o.payoutCurrency = 'UZS' AND ${currency} = 'USD' AND ${fxRate} IS NOT NULL
                THEN ROUND(o.payoutAmount * 100.0 / ${fxRate})
              WHEN o.payoutCurrency = 'USD' AND ${currency} = 'UZS' AND ${fxRate} IS NOT NULL
                THEN ROUND(o.payoutAmount / 100.0 * ${fxRate})
              ELSE 0
            END
          ELSE 0 END
        ), 0)                                                                                         AS revenueAmount,

        -- Phase 4: pipelineAmount = SUM(payout) for in-flight orders, with FX.
        -- Same FX logic as revenue. Status set is "past new, not yet
        -- delivered" — these have a committed pay_for but haven't fully
        -- converted to cash. Excluded from Profit by design.
        COALESCE(SUM(
          CASE WHEN o.crmStatus IN ('contacted','in_progress','sent','callback','success')
                AND o.payoutAmount IS NOT NULL THEN
            CASE
              WHEN o.payoutCurrency = ${currency} THEN o.payoutAmount
              WHEN o.payoutCurrency = 'UZS' AND ${currency} = 'USD' AND ${fxRate} IS NOT NULL
                THEN ROUND(o.payoutAmount * 100.0 / ${fxRate})
              WHEN o.payoutCurrency = 'USD' AND ${currency} = 'UZS' AND ${fxRate} IS NOT NULL
                THEN ROUND(o.payoutAmount / 100.0 * ${fxRate})
              ELSE 0
            END
          ELSE 0 END
        ), 0)                                                                                         AS pipelineAmount,

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
           AND DATE(CONVERT_TZ(createdAt, '+00:00', '+05:00')) = ${date}
           AND campaignId IS NOT NULL
           AND campaignId != ''
         GROUP BY userId, campaignId
      ) clt              ON clt.userId       = l.userId
                         AND clt.campaignId   = l.campaignId
      WHERE l.userId = ${userId}
        AND DATE(CONVERT_TZ(l.createdAt, '+00:00', '+05:00')) = ${date}
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

/**
 * One full pass — every user with activity in the window, every date in the
 * window. `forceFullWindow` overrides the time-of-day check so admin
 * tooling (runInsightsRollupOnce) always rebuilds the full 7 days.
 */
async function runRollup(opts: { forceFullWindow?: boolean } = {}): Promise<void> {
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

    const windowDays = opts.forceFullWindow
      ? NIGHTLY_REBUILD_WINDOW_DAYS
      : pickWindowForThisTick(new Date());
    const dates = rebuildDates(windowDays);
    const earliest = dates[dates.length - 1];
    console.log(
      `[InsightsRollup] Tick — windowDays=${windowDays} ` +
        `(${windowDays === NIGHTLY_REBUILD_WINDOW_DAYS ? "nightly/forced" : "recurring"})`,
    );

    // Pick the set of users with any lead activity in the window. Avoids
    // scanning users with zero leads — they have nothing to roll up.
    const activeUsers = (await db.execute(sql`
      SELECT DISTINCT u.id AS userId, COALESCE(u.baseCurrency, 'USD') AS currency
      FROM users u
      JOIN leads l ON l.userId = u.id
        AND DATE(CONVERT_TZ(l.createdAt, '+00:00', '+05:00')) >= ${earliest}
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
    `[InsightsRollup] Scheduler armed — first run in ${INITIAL_DELAY_MS / 1000}s, then every ${ROLLUP_INTERVAL_MS / 1000}s, ` +
      `window=${RECURRING_WINDOW_DAYS}d recurring / ${NIGHTLY_REBUILD_WINDOW_DAYS}d at ${NIGHTLY_HOUR_UTC.toString().padStart(2, "0")}:00 UTC`,
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

/**
 * Manual single-pass trigger — exported for admin tooling and tests. Always
 * rebuilds the full 7-day window since the caller's intent is explicit
 * "reconcile now", regardless of the time-of-day window split.
 */
export async function runInsightsRollupOnce(): Promise<void> {
  await runRollup({ forceFullWindow: true });
}
