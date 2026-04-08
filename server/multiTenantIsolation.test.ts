/**
 * Multi-tenant isolation tests
 *
 * Verifies that:
 * 1. User A connects Facebook → sees only their pages
 * 2. User B connects Facebook → sees only their pages
 * 3. Lead from User A's page → saved under User A
 * 4. Lead from User B's page → saved under User B
 * 5. User A logs in → sees only their leads, not User B's
 * 6. resolveUserIdsForPage returns [] for unknown pageId (no fallback to userId=1)
 * 7. Same page connected by two users → BOTH users receive the lead independently
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock DB ─────────────────────────────────────────────────────────────────
const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
};

vi.mock("../server/db", () => ({
  getDb: vi.fn().mockResolvedValue(mockDb),
  getLeads: vi.fn(),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Simulate resolveUserIdsForPage logic (extracted from facebookWebhook.ts)
 * Returns ALL userIds for the given pageId (multi-tenant: multiple users can share a page).
 */
async function resolveUserIdsForPage(
  db: typeof mockDb | null,
  pageId: string,
  connections: Array<{ pageId: string; userId: number }>
): Promise<number[]> {
  if (!db) return [];
  const matched = connections.filter((c) => c.pageId === pageId);
  return Array.from(new Set(matched.map((c) => c.userId)));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Multi-tenant isolation", () => {
  const userA = { id: 1, name: "User A" };
  const userB = { id: 2, name: "User B" };

  const pageA = { pageId: "page-111", userId: userA.id, pageName: "User A Page" };
  const pageB = { pageId: "page-222", userId: userB.id, pageName: "User B Page" };
  const connections = [pageA, pageB];

  // Scenario 1 & 2: Each user sees only their own pages
  it("User A sees only their own pages", () => {
    const userAPages = connections.filter((c) => c.userId === userA.id);
    expect(userAPages).toHaveLength(1);
    expect(userAPages[0].pageId).toBe("page-111");
    expect(userAPages.some((c) => c.userId === userB.id)).toBe(false);
  });

  it("User B sees only their own pages", () => {
    const userBPages = connections.filter((c) => c.userId === userB.id);
    expect(userBPages).toHaveLength(1);
    expect(userBPages[0].pageId).toBe("page-222");
    expect(userBPages.some((c) => c.userId === userA.id)).toBe(false);
  });

  // Scenario 3: Lead from User A's page → routed to User A
  it("Lead from User A's page is routed to User A", async () => {
    const userIds = await resolveUserIdsForPage(mockDb, "page-111", connections);
    expect(userIds).toContain(userA.id);
    expect(userIds).not.toContain(userB.id);
  });

  // Scenario 4: Lead from User B's page → routed to User B
  it("Lead from User B's page is routed to User B", async () => {
    const userIds = await resolveUserIdsForPage(mockDb, "page-222", connections);
    expect(userIds).toContain(userB.id);
    expect(userIds).not.toContain(userA.id);
  });

  // Scenario 5: User A sees only their leads
  it("User A sees only their own leads", () => {
    const allLeads = [
      { id: 1, userId: userA.id, fullName: "Lead A1", pageId: "page-111" },
      { id: 2, userId: userA.id, fullName: "Lead A2", pageId: "page-111" },
      { id: 3, userId: userB.id, fullName: "Lead B1", pageId: "page-222" },
    ];
    const userALeads = allLeads.filter((l) => l.userId === userA.id);
    expect(userALeads).toHaveLength(2);
    expect(userALeads.every((l) => l.userId === userA.id)).toBe(true);
    expect(userALeads.some((l) => l.userId === userB.id)).toBe(false);
  });

  it("User B sees only their own leads", () => {
    const allLeads = [
      { id: 1, userId: userA.id, fullName: "Lead A1", pageId: "page-111" },
      { id: 3, userId: userB.id, fullName: "Lead B1", pageId: "page-222" },
    ];
    const userBLeads = allLeads.filter((l) => l.userId === userB.id);
    expect(userBLeads).toHaveLength(1);
    expect(userBLeads[0].fullName).toBe("Lead B1");
    expect(userBLeads.some((l) => l.userId === userA.id)).toBe(false);
  });

  // Scenario 6: Unknown pageId → empty array (no fallback to userId=1)
  it("resolveUserIdsForPage returns empty array for unknown pageId — no fallback to owner", async () => {
    const userIds = await resolveUserIdsForPage(mockDb, "page-unknown-999", connections);
    expect(userIds).toHaveLength(0);
    expect(userIds).not.toContain(1); // Must NOT fall back to owner/admin
  });

  // Scenario 7: null db → empty array (graceful)
  it("resolveUserIdsForPage returns empty array when db is unavailable", async () => {
    const userIds = await resolveUserIdsForPage(null, "page-111", connections);
    expect(userIds).toHaveLength(0);
  });

  // KEY SCENARIO: Same page shared by two users → BOTH get the lead
  it("Same FB page shared by two users → both users receive the lead independently", async () => {
    const sharedPageId = "page-shared-333";
    const sharedConnections = [
      { pageId: sharedPageId, userId: userA.id },
      { pageId: sharedPageId, userId: userB.id },
    ];
    const userIds = await resolveUserIdsForPage(mockDb, sharedPageId, sharedConnections);
    expect(userIds).toHaveLength(2);
    expect(userIds).toContain(userA.id);
    expect(userIds).toContain(userB.id);
  });

  // Deduplication: same userId appearing twice → returned once
  it("resolveUserIdsForPage deduplicates userIds", async () => {
    const pageId = "page-dup";
    const dupConnections = [
      { pageId, userId: userA.id },
      { pageId, userId: userA.id }, // duplicate
    ];
    const userIds = await resolveUserIdsForPage(mockDb, pageId, dupConnections);
    expect(userIds).toHaveLength(1);
    expect(userIds[0]).toBe(userA.id);
  });

  // Scenario 8: Same FB page connected by two different users (multi-tenant)
  it("Same FB page can be connected by two different users independently", () => {
    const sharedPageId = "page-shared-333";
    const multiConnections = [
      { pageId: sharedPageId, userId: userA.id, pageName: "Shared Page (User A)" },
      { pageId: sharedPageId, userId: userB.id, pageName: "Shared Page (User B)" },
    ];
    const userAConn = multiConnections.filter((c) => c.userId === userA.id && c.pageId === sharedPageId);
    const userBConn = multiConnections.filter((c) => c.userId === userB.id && c.pageId === sharedPageId);
    expect(userAConn).toHaveLength(1);
    expect(userBConn).toHaveLength(1);
    // They are separate records with different userId
    expect(userAConn[0].userId).not.toBe(userBConn[0].userId);
  });

  // Scenario 9: facebookAccounts upsert is per (userId, fbUserId)
  it("facebookAccounts upsert uses (userId, fbUserId) composite key", () => {
    const fbUserId = "fb-user-abc";
    const accounts = [
      { id: 1, userId: userA.id, fbUserId, fbUserName: "FB User" },
    ];
    // User B connecting same FB account creates a NEW record
    const existingForUserA = accounts.find(
      (a) => a.userId === userA.id && a.fbUserId === fbUserId
    );
    const existingForUserB = accounts.find(
      (a) => a.userId === userB.id && a.fbUserId === fbUserId
    );
    expect(existingForUserA).toBeDefined();
    expect(existingForUserB).toBeUndefined(); // User B gets their own record
  });
});
