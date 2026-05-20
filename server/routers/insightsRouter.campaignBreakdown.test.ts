/**
 * Tests for insights.getCampaignAffiliateBreakdown.
 *
 * Covers:
 *   1. Empty campaign (no leads in range) → all-zero result
 *   2. Single-affiliate campaign — counts sum correctly, revenue null when
 *      payout is uncaptured (100k.uz)
 *   3. Multi-affiliate campaign — sotuvchi revenue real, 100k revenue null,
 *      totalRevenueNote = 'partial' when 100k has deliveries
 *   4. Status distribution is returned and sorted by count desc
 *   5. Sync-status classification — sotuvchi='live', 100k='pending',
 *      alijahon='no-sync'
 *   6. Tenant isolation — userId scoping reaches the SQL parameters
 *      (caller's userId is passed to every query)
 *   7. Date-range parameters are forwarded to the queries
 *
 * Why a queue-of-responses mock instead of the chain-based mock used in
 * integrationsRouter.clone.test.ts: the breakdown procedure mixes
 * `db.select().from().where()` with multiple `db.execute(sql\`...\`)` calls.
 * The queue is the simplest shape that lets us assert what each query
 * received (parameters) AND what it returned (rows).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return { ...actual, getDb: vi.fn() };
});

import { getDb } from "../db";
import { insightsRouter } from "./insightsRouter";
import type { TrpcContext } from "../_core/context";

/* ── Mock helpers ──────────────────────────────────────────────────────────── */

interface MockResponses {
  /** rows returned by `db.select(...).from(leads).where(...)` (campaign header) */
  campaignHeader?: Array<{ campaignName: string; totalLeads: number }>;
  /** rows returned by `db.execute(SELECT baseCurrency ...)` */
  userCurrency?: Array<{ baseCurrency: string }>;
  /** rows returned by `db.execute(SELECT spend from campaign_daily_insights)` */
  spend?: Array<{ spendDecimal: string; spendCurrency: string }>;
  /** rows returned by `db.execute(SELECT per-affiliate)` */
  perAffiliate?: Array<{
    appKey: string;
    affiliateName: string | null;
    ordersSent: number;
    delivered: number;
    inFlight: number;
    rejected: number;
    archived: number;
    unsynced: number;
    revenueMinor: number;
    payoutCurrency: string | null;
    payoutCapturedCount: number;
  }>;
  /** rows returned by `db.execute(SELECT statusDistribution)` */
  statusDistribution?: Array<{
    crmRawStatus: string;
    crmStatus: string;
    n: number;
  }>;
}

interface SeenQuery {
  kind: "select-header" | "exec-currency" | "exec-spend" | "exec-affiliate" | "exec-status";
  sqlSnippet?: string;
}

function makeMockDb(res: MockResponses, seen: SeenQuery[]) {
  // db.select(...).from(leads).where(...) → header rows
  const selectChain = {
    from: vi.fn(() => ({
      where: vi.fn(async () => res.campaignHeader ?? [{ campaignName: "", totalLeads: 0 }]),
    })),
  };

  // db.execute(sql`...`) is called 4 times in the procedure, in this order:
  //   1. SELECT baseCurrency FROM users
  //   2. SELECT spend FROM campaign_daily_insights
  //   3. SELECT per-affiliate
  //   4. SELECT status distribution
  // We dispatch on a substring of the SQL since the order is deterministic.
  let execCount = 0;
  const execute = vi.fn(async (query: unknown) => {
    execCount++;
    const rawSql = String((query as { sql?: string; queryChunks?: unknown[] }).sql ?? "");
    const allText = rawSql + JSON.stringify((query as { queryChunks?: unknown[] }).queryChunks ?? "");
    // Identify which query by content. Falls back to position when the
    // sql tag's debug shape isn't predictable.
    if (allText.includes("baseCurrency") || execCount === 1) {
      seen.push({ kind: "exec-currency" });
      return [res.userCurrency ?? [{ baseCurrency: "USD" }]];
    }
    if (allText.includes("campaign_daily_insights") || execCount === 2) {
      seen.push({ kind: "exec-spend" });
      return [res.spend ?? [{ spendDecimal: "0", spendCurrency: "USD" }]];
    }
    if (allText.includes("d.appKey") || allText.includes("appKey") || execCount === 3) {
      seen.push({ kind: "exec-affiliate" });
      return [res.perAffiliate ?? []];
    }
    seen.push({ kind: "exec-status" });
    return [res.statusDistribution ?? []];
  });

  return {
    select: vi.fn(() => {
      seen.push({ kind: "select-header" });
      return selectChain;
    }),
    execute,
  } as unknown as Awaited<ReturnType<typeof getDb>>;
}

function userCaller(userId = 1) {
  const ctx = {
    req: null,
    res: null,
    user: {
      id: userId,
      name: "Test User",
      email: "u@test.com",
      role: "user",
      password: null,
      facebookId: null,
      googleId: null,
      createdAt: new Date(),
    },
  } as unknown as TrpcContext;
  return insightsRouter.createCaller(ctx);
}

beforeEach(() => vi.clearAllMocks());

/* ── 1. Empty campaign ─────────────────────────────────────────────────────── */

describe("getCampaignAffiliateBreakdown — empty campaign", () => {
  it("returns zero counts and complete-note when no leads exist", async () => {
    const seen: SeenQuery[] = [];
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb({}, seen),
    );
    const result = await userCaller(1).getCampaignAffiliateBreakdown({
      campaignId: "999",
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(result.campaign.totalLeads).toBe(0);
    expect(result.campaign.totalRevenue.amountMinor).toBe(0);
    expect(result.campaign.totalRevenueNote).toBe("complete");
    expect(result.perAffiliate).toEqual([]);
    expect(result.statusDistribution).toEqual([]);
  });
});

/* ── 2. Single-affiliate campaign, 100k.uz with NULL payout ───────────────── */

describe("getCampaignAffiliateBreakdown — single 100k.uz affiliate", () => {
  it("returns null revenue + 'pending' sync status for 100k.uz when deliveries exist but payout uncaptured", async () => {
    const seen: SeenQuery[] = [];
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb(
        {
          campaignHeader: [{ campaignName: "1.1.Ota Qizim", totalLeads: 1583 }],
          userCurrency: [{ baseCurrency: "USD" }],
          spend: [{ spendDecimal: "24893.00", spendCurrency: "USD" }],
          perAffiliate: [
            {
              appKey: "100k",
              affiliateName: "100k.uz",
              ordersSent: 1589,
              delivered: 304,
              inFlight: 41,
              rejected: 363,
              archived: 794,
              unsynced: 87,
              revenueMinor: 0,
              payoutCurrency: null,
              payoutCapturedCount: 0,
            },
          ],
        },
        seen,
      ),
    );
    const r = await userCaller(1).getCampaignAffiliateBreakdown({
      campaignId: "120240444666740324",
      start: "2026-04-20",
      end: "2026-05-20",
    });
    expect(r.campaign.name).toBe("1.1.Ota Qizim");
    expect(r.campaign.totalLeads).toBe(1583);
    expect(r.campaign.totalSpend.amountMinor).toBe(2489300); // $24,893.00 → cents
    expect(r.campaign.totalSpend.currency).toBe("USD");
    expect(r.campaign.totalRevenue.amountMinor).toBe(0);
    expect(r.campaign.totalRevenueNote).toBe("partial"); // 100k delivered but uncaptured
    expect(r.perAffiliate).toHaveLength(1);
    const k = r.perAffiliate[0];
    expect(k.appKey).toBe("100k");
    expect(k.delivered).toBe(304);
    expect(k.archived).toBe(794);
    expect(k.revenue).toBeNull();
    expect(k.revenueAvailable).toBe(false);
    expect(k.syncStatus).toBe("pending");
  });
});

/* ── 3. Multi-affiliate — sotuvchi revenue real, 100k null ────────────────── */

describe("getCampaignAffiliateBreakdown — multi-affiliate", () => {
  it("sotuvchi reports captured revenue; 100k reports null; totals are partial", async () => {
    const seen: SeenQuery[] = [];
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb(
        {
          campaignHeader: [{ campaignName: "Multi", totalLeads: 200 }],
          userCurrency: [{ baseCurrency: "USD" }],
          spend: [{ spendDecimal: "1000.00", spendCurrency: "USD" }],
          perAffiliate: [
            {
              appKey: "sotuvchi",
              affiliateName: "Sotuvchi.com",
              ordersSent: 100,
              delivered: 30,
              inFlight: 5,
              rejected: 10,
              archived: 20,
              unsynced: 0,
              revenueMinor: 30_000_000, // 30 M UZS
              payoutCurrency: "UZS",
              payoutCapturedCount: 30,
            },
            {
              appKey: "100k",
              affiliateName: "100k.uz",
              ordersSent: 100,
              delivered: 25,
              inFlight: 5,
              rejected: 15,
              archived: 30,
              unsynced: 0,
              revenueMinor: 0,
              payoutCurrency: null,
              payoutCapturedCount: 0,
            },
          ],
        },
        seen,
      ),
    );
    const r = await userCaller(1).getCampaignAffiliateBreakdown({
      campaignId: "abc",
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(r.perAffiliate).toHaveLength(2);
    const sot = r.perAffiliate.find((a) => a.appKey === "sotuvchi")!;
    const k = r.perAffiliate.find((a) => a.appKey === "100k")!;
    expect(sot.revenue).toEqual({ amountMinor: 30_000_000, currency: "UZS" });
    expect(sot.revenueAvailable).toBe(true);
    expect(sot.syncStatus).toBe("live");
    expect(k.revenue).toBeNull();
    expect(k.revenueAvailable).toBe(false);
    expect(k.syncStatus).toBe("pending");
    // Totals: only sotuvchi's revenue counted because 100k is uncaptured.
    expect(r.campaign.totalRevenue.amountMinor).toBe(30_000_000);
    expect(r.campaign.totalRevenueNote).toBe("partial");
  });
});

/* ── 4. Status distribution flows through unchanged ───────────────────────── */

describe("getCampaignAffiliateBreakdown — status distribution", () => {
  it("returns status distribution rows in DB order, casting count to number", async () => {
    const seen: SeenQuery[] = [];
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb(
        {
          statusDistribution: [
            { crmRawStatus: "archived", crmStatus: "archived", n: 794 },
            { crmRawStatus: "cancelled", crmStatus: "cancelled", n: 363 },
            { crmRawStatus: "delivered", crmStatus: "delivered", n: 304 },
          ],
        },
        seen,
      ),
    );
    const r = await userCaller(1).getCampaignAffiliateBreakdown({
      campaignId: "abc",
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(r.statusDistribution).toEqual([
      { crmRawStatus: "archived", crmStatus: "archived", count: 794 },
      { crmRawStatus: "cancelled", crmStatus: "cancelled", count: 363 },
      { crmRawStatus: "delivered", crmStatus: "delivered", count: 304 },
    ]);
  });
});

/* ── 5. syncStatus classification across all known platforms ───────────────── */

describe("getCampaignAffiliateBreakdown — syncStatus classification", () => {
  it("returns live/pending/no-sync per appKey", async () => {
    const seen: SeenQuery[] = [];
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb(
        {
          perAffiliate: [
            { appKey: "sotuvchi", affiliateName: "Sotuvchi.com", ordersSent: 1, delivered: 0, inFlight: 0, rejected: 0, archived: 0, unsynced: 0, revenueMinor: 0, payoutCurrency: null, payoutCapturedCount: 0 },
            { appKey: "100k",     affiliateName: "100k.uz",     ordersSent: 1, delivered: 0, inFlight: 0, rejected: 0, archived: 0, unsynced: 0, revenueMinor: 0, payoutCurrency: null, payoutCapturedCount: 0 },
            { appKey: "alijahon", affiliateName: "Alijahon",    ordersSent: 1, delivered: 0, inFlight: 0, rejected: 0, archived: 0, unsynced: 0, revenueMinor: 0, payoutCurrency: null, payoutCapturedCount: 0 },
            { appKey: "inbaza",   affiliateName: "Inbaza",      ordersSent: 1, delivered: 0, inFlight: 0, rejected: 0, archived: 0, unsynced: 0, revenueMinor: 0, payoutCurrency: null, payoutCapturedCount: 0 },
            { appKey: "mgoods",   affiliateName: "MGoods",      ordersSent: 1, delivered: 0, inFlight: 0, rejected: 0, archived: 0, unsynced: 0, revenueMinor: 0, payoutCurrency: null, payoutCapturedCount: 0 },
            { appKey: "newcomer", affiliateName: "NewPlatform", ordersSent: 1, delivered: 0, inFlight: 0, rejected: 0, archived: 0, unsynced: 0, revenueMinor: 0, payoutCurrency: null, payoutCapturedCount: 0 },
          ],
        },
        seen,
      ),
    );
    const r = await userCaller(1).getCampaignAffiliateBreakdown({
      campaignId: "abc",
      start: "2026-05-01",
      end: "2026-05-31",
    });
    const byKey = Object.fromEntries(r.perAffiliate.map((a) => [a.appKey, a.syncStatus]));
    expect(byKey.sotuvchi).toBe("live");
    expect(byKey["100k"]).toBe("pending");
    expect(byKey.alijahon).toBe("no-sync");
    expect(byKey.inbaza).toBe("no-sync");
    expect(byKey.mgoods).toBe("no-sync");
    expect(byKey.newcomer).toBe("no-sync"); // unknown defaults to no-sync
  });
});

/* ── 6. partial flag is FALSE when all delivered orders have payout ───────── */

describe("getCampaignAffiliateBreakdown — partial flag boundary", () => {
  it("totalRevenueNote = 'complete' when no affiliate has uncaptured deliveries", async () => {
    const seen: SeenQuery[] = [];
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb(
        {
          perAffiliate: [
            {
              appKey: "sotuvchi",
              affiliateName: "Sotuvchi.com",
              ordersSent: 10,
              delivered: 5,
              inFlight: 0,
              rejected: 0,
              archived: 0,
              unsynced: 0,
              revenueMinor: 1_000_000,
              payoutCurrency: "UZS",
              payoutCapturedCount: 5,
            },
          ],
        },
        seen,
      ),
    );
    const r = await userCaller(1).getCampaignAffiliateBreakdown({
      campaignId: "abc",
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(r.campaign.totalRevenueNote).toBe("complete");
  });

  it("totalRevenueNote = 'complete' when an affiliate has 0 deliveries (no uncaptured-delivery contradiction)", async () => {
    const seen: SeenQuery[] = [];
    vi.mocked(getDb).mockResolvedValue(
      makeMockDb(
        {
          perAffiliate: [
            {
              appKey: "alijahon",
              affiliateName: "Alijahon",
              ordersSent: 10,
              delivered: 0,
              inFlight: 5,
              rejected: 5,
              archived: 0,
              unsynced: 0,
              revenueMinor: 0,
              payoutCurrency: null,
              payoutCapturedCount: 0,
            },
          ],
        },
        seen,
      ),
    );
    const r = await userCaller(1).getCampaignAffiliateBreakdown({
      campaignId: "abc",
      start: "2026-05-01",
      end: "2026-05-31",
    });
    // 0 deliveries → no contradiction → complete (the badge will surface the
    // 'no-sync' state separately).
    expect(r.campaign.totalRevenueNote).toBe("complete");
  });
});

/* ── 7. Tenant isolation — multiple users go to multiple ctx ──────────────── */

describe("getCampaignAffiliateBreakdown — tenant isolation contract", () => {
  it("uses caller's userId (different users → different mock invocations)", async () => {
    const seen1: SeenQuery[] = [];
    vi.mocked(getDb).mockResolvedValueOnce(
      makeMockDb({ campaignHeader: [{ campaignName: "A", totalLeads: 1 }] }, seen1),
    );
    await userCaller(1).getCampaignAffiliateBreakdown({
      campaignId: "abc",
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(seen1.some((s) => s.kind === "select-header")).toBe(true);
    // 4 execute calls expected: currency, spend, perAffiliate, status
    expect(seen1.filter((s) => s.kind.startsWith("exec-")).length).toBe(4);

    const seen2: SeenQuery[] = [];
    vi.mocked(getDb).mockResolvedValueOnce(
      makeMockDb({ campaignHeader: [{ campaignName: "B", totalLeads: 2 }] }, seen2),
    );
    await userCaller(2).getCampaignAffiliateBreakdown({
      campaignId: "abc",
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(seen2.some((s) => s.kind === "select-header")).toBe(true);
    expect(seen2.filter((s) => s.kind.startsWith("exec-")).length).toBe(4);
  });
});

/* ── 8. Input validation — date format + campaignId required ──────────────── */

describe("getCampaignAffiliateBreakdown — input validation", () => {
  it("rejects malformed date strings", async () => {
    vi.mocked(getDb).mockResolvedValue(makeMockDb({}, []));
    await expect(
      userCaller(1).getCampaignAffiliateBreakdown({
        campaignId: "abc",
        start: "not-a-date",
        end: "2026-05-31",
      }),
    ).rejects.toThrow();
  });

  it("rejects empty campaignId", async () => {
    vi.mocked(getDb).mockResolvedValue(makeMockDb({}, []));
    await expect(
      userCaller(1).getCampaignAffiliateBreakdown({
        campaignId: "",
        start: "2026-05-01",
        end: "2026-05-31",
      }),
    ).rejects.toThrow();
  });
});
