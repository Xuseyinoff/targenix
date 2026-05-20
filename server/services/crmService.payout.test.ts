/**
 * Tests for the 100k.uz adapter's payoutAmount extraction (Phase 3.1).
 *
 * Both adapter entry points pull payoutAmount from the same field:
 *   SUM(order_items[].to_withdraw) → orders.payoutAmount (UZS so'm, integer).
 *
 * The bulk feed (/users/:profileId/advertiser-orders) and the single-order
 * endpoint (/shop/v1/orders/:id) return identical row shape — verified via
 * Phase 1 probe 2026-05-20.
 *
 * Coverage:
 *   1. Single-item order → payoutAmount = single to_withdraw value
 *   2. Multi-item order → SUM across items
 *   3. Empty order_items array → null (no payout captured)
 *   4. Missing order_items field entirely → null (defensive)
 *   5. Archived order with non-zero to_withdraw still captures payout
 *      (proves we do NOT gate on status — pipeline coverage requires this)
 *   6. Single-order endpoint identical extraction (contract pin)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => ({
  default: { get: vi.fn(), post: vi.fn() },
}));

import axios from "axios";
import {
  hundredKGetAdvertiserOrdersPage,
  crmGetOrderStatus,
} from "./crmService";

const mockGet = vi.mocked(axios.get);

beforeEach(() => vi.clearAllMocks());

/* ── Bulk feed parser — hundredKGetAdvertiserOrdersPage ─────────────────── */

describe("hundredKGetAdvertiserOrdersPage — payoutAmount extraction", () => {
  it("single-item order returns to_withdraw as payoutAmount in UZS", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 17135644,
            status: "new",
            created_at: "2026-05-20T10:48:10.000000Z",
            order_items: [{ to_withdraw: 12600 }],
          },
        ],
        meta: { current_page: 1, last_page: 1, total: 1 },
      },
    });
    const result = await hundredKGetAdvertiserOrdersPage("token", "6430448", 1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].payoutAmount).toBe(12600);
    expect(result.data[0].payoutCurrency).toBe("UZS");
  });

  it("multi-item order sums to_withdraw across items", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 17135700,
            status: "accepted",
            created_at: "2026-05-20T11:00:00Z",
            order_items: [
              { to_withdraw: 5000 },
              { to_withdraw: 7000 },
              { to_withdraw: 3500 },
            ],
          },
        ],
        meta: { current_page: 1, last_page: 1, total: 1 },
      },
    });
    const result = await hundredKGetAdvertiserOrdersPage("token", "6430448", 1);
    expect(result.data[0].payoutAmount).toBe(15500);
    expect(result.data[0].payoutCurrency).toBe("UZS");
  });

  it("empty order_items array → payoutAmount=null, currency=null", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 17135800,
            status: "new",
            created_at: "2026-05-20T11:30:00Z",
            order_items: [],
          },
        ],
        meta: { current_page: 1, last_page: 1, total: 1 },
      },
    });
    const result = await hundredKGetAdvertiserOrdersPage("token", "6430448", 1);
    expect(result.data[0].payoutAmount).toBeNull();
    expect(result.data[0].payoutCurrency).toBeNull();
  });

  it("missing order_items field entirely → null (defensive against future API shape changes)", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 17135900,
            status: "new",
            created_at: "2026-05-20T12:00:00Z",
            // no order_items field at all
          },
        ],
        meta: { current_page: 1, last_page: 1, total: 1 },
      },
    });
    const result = await hundredKGetAdvertiserOrdersPage("token", "6430448", 1);
    expect(result.data[0].payoutAmount).toBeNull();
    expect(result.data[0].payoutCurrency).toBeNull();
  });

  it("archived order with non-zero to_withdraw still captures payout (status-agnostic)", async () => {
    // 100k.uz keeps to_withdraw committed on archived/cancelled rows. We
    // capture it anyway so the Pipeline KPI surfaces in-flight money for
    // archived orders that might later be revived. The rollup writer is
    // responsible for filtering by crmStatus when computing Revenue vs
    // Pipeline — the adapter never makes that decision.
    mockGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 17136000,
            status: "archived",
            created_at: "2026-05-20T12:30:00Z",
            order_items: [{ to_withdraw: 25000 }],
          },
        ],
        meta: { current_page: 1, last_page: 1, total: 1 },
      },
    });
    const result = await hundredKGetAdvertiserOrdersPage("token", "6430448", 1);
    expect(result.data[0].status).toBe("archived");
    expect(result.data[0].payoutAmount).toBe(25000);
    expect(result.data[0].payoutCurrency).toBe("UZS");
  });

  it("non-numeric to_withdraw values are ignored (defensive)", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 17136100,
            status: "new",
            created_at: "2026-05-20T13:00:00Z",
            order_items: [
              { to_withdraw: 12600 },
              { to_withdraw: null },         // skipped
              { to_withdraw: "garbage" },    // skipped (parseInt fails)
              { to_withdraw: -500 },         // skipped (negative)
            ],
          },
        ],
        meta: { current_page: 1, last_page: 1, total: 1 },
      },
    });
    const result = await hundredKGetAdvertiserOrdersPage("token", "6430448", 1);
    expect(result.data[0].payoutAmount).toBe(12600);
  });

  it("string-typed to_withdraw is parsed (defensive)", async () => {
    // Some Laravel APIs serialize integers as strings depending on driver
    // settings; accept both shapes.
    mockGet.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 17136200,
            status: "new",
            created_at: "2026-05-20T13:30:00Z",
            order_items: [{ to_withdraw: "12600" }, { to_withdraw: "7000" }],
          },
        ],
        meta: { current_page: 1, last_page: 1, total: 1 },
      },
    });
    const result = await hundredKGetAdvertiserOrdersPage("token", "6430448", 1);
    expect(result.data[0].payoutAmount).toBe(19600);
  });
});

/* ── Single-order endpoint — crmGetOrderStatus("100k", ...) ─────────────── */

describe("crmGetOrderStatus('100k') — payoutAmount extraction", () => {
  it("single-order endpoint extracts payoutAmount identically to bulk", async () => {
    // The single-order response wraps the order under res.data.data per
    // the 100k.uz API; the adapter unwraps it. SUM(order_items[].to_withdraw)
    // should match the same value the bulk feed would have returned.
    mockGet.mockResolvedValueOnce({
      data: {
        data: {
          id: 17129178,
          status: "booked",
          created_at: "2026-05-20T05:38:00Z",
          order_items: [{ to_withdraw: 12600 }, { to_withdraw: 3500 }],
        },
      },
    });
    const result = await crmGetOrderStatus("100k", "token", "17129178", "6430448");
    expect(result.externalId).toBe("17129178");
    expect(result.rawStatus).toBe("booked");
    expect(result.payoutAmount).toBe(16100);
    expect(result.payoutCurrency).toBe("UZS");
  });

  it("single-order endpoint returns null payout when order_items is absent", async () => {
    mockGet.mockResolvedValueOnce({
      data: {
        data: {
          id: 17129200,
          status: "new",
          created_at: "2026-05-20T06:00:00Z",
        },
      },
    });
    const result = await crmGetOrderStatus("100k", "token", "17129200", "6430448");
    expect(result.payoutAmount).toBeNull();
    expect(result.payoutCurrency).toBeNull();
  });
});
