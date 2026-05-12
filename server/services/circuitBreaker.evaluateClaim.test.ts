/**
 * DB-backed integration tests for the circuit breaker DECISION surface
 * (`evaluateClaim` + `autoPromoteExpiredCooldowns`).
 *
 * Why a second test file: the existing circuitBreaker.test.ts covers the
 * WRITE side (recordOutcome state transitions). This file covers the READ
 * side — what callers see when they ask "should I dispatch?". Together
 * they pin every public API the retry scheduler depends on.
 *
 * Scenarios covered here:
 *   1. evaluateClaim — never-seen destination → allow
 *   2. evaluateClaim — CLOSED row → allow
 *   3. evaluateClaim — OPEN with future cooldown → block
 *   4. evaluateClaim — OPEN with expired cooldown → promote to HALF_OPEN + probe
 *   5. evaluateClaim — HALF_OPEN within probe budget → probe
 *   6. evaluateClaim — HALF_OPEN past probe budget → block
 *   7. evaluateClaim — manualLock=OPEN trumps everything
 *   8. evaluateClaim — manualLock=CLOSED trumps OPEN state
 *   9. Per-app sibling block — OPEN destination of app A blocks new destinations of app A
 *  10. autoPromoteExpiredCooldowns — bulk OPEN→HALF_OPEN by cooldown expiry
 *  11. autoPromoteExpiredCooldowns — skips manualLock=OPEN rows
 *
 * All scenarios use absurdly-large IDs (>= 999_100) to avoid colliding
 * with real prod rows on a shared dev DB; the beforeEach truncates rows
 * scoped to that ID range.
 */

import "dotenv/config";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

const HAS_DB = Boolean(
  process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL,
);

// Sentinel IDs reserved for this suite — keep above the existing
// circuitBreaker.test.ts range (999_001) so the two files can run in
// parallel without stepping on each other.
const TEST_INTEGRATION_ID = 999_100;
const TEST_DESTINATION_ID_A = 999_101;
const TEST_DESTINATION_ID_B = 999_102;
const TEST_APP_KEY = "test-sibling-app";

(HAS_DB ? describe : describe.skip)("circuitBreaker — evaluateClaim + autoPromoteExpiredCooldowns", () => {
  let db: import("../db").DbClient;
  let recordOutcome: typeof import("./circuitBreaker").recordOutcome;
  let evaluateClaim: typeof import("./circuitBreaker").evaluateClaim;
  let autoPromoteExpiredCooldowns: typeof import("./circuitBreaker").autoPromoteExpiredCooldowns;

  beforeAll(async () => {
    const dbMod = await import("../db");
    const got = await dbMod.getDb();
    if (!got) throw new Error("DB unavailable despite DATABASE_URL set");
    db = got;
    const cb = await import("./circuitBreaker");
    recordOutcome = cb.recordOutcome;
    evaluateClaim = cb.evaluateClaim;
    autoPromoteExpiredCooldowns = cb.autoPromoteExpiredCooldowns;
  });

  afterAll(async () => {
    const { closeDb } = await import("../db");
    await closeDb();
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM integration_health WHERE integrationId = ${TEST_INTEGRATION_ID}`);
    await db.execute(sql`DELETE FROM integration_health_events WHERE integrationId = ${TEST_INTEGRATION_ID}`);
  });

  // ─── 1. Never-seen destination → allow ───────────────────────────────────

  it("returns allow when no integration_health row exists for the destination", async () => {
    const r = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
    });
    expect(r.decision).toBe("allow");
    expect(r.state).toBe("CLOSED");
    expect(r.reason).toBe("no_health_row");
  });

  // ─── 2. CLOSED row → allow ───────────────────────────────────────────────

  it("returns allow when the row is CLOSED", async () => {
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: true,
    });
    const r = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
    });
    expect(r.decision).toBe("allow");
    expect(r.state).toBe("CLOSED");
  });

  // ─── 3. OPEN with future cooldown → block ────────────────────────────────

  it("returns block when the row is OPEN with cooldown in the future", async () => {
    // Trip via rate_limit (single failure → OPEN with cooldown ahead).
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
      errorMessage: "429",
    });
    const r = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
    });
    expect(r.decision).toBe("block");
    expect(r.state).toBe("OPEN");
    expect(r.cooldownUntil).toBeInstanceOf(Date);
    expect(r.cooldownUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  // ─── 4. OPEN with expired cooldown → promote + probe ─────────────────────

  it("auto-promotes OPEN → HALF_OPEN when cooldownUntil <= NOW() and returns probe", async () => {
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
      errorMessage: "429",
    });
    // Force the cooldown to be in the past so evaluateClaim treats it as expired.
    await db.execute(
      sql`UPDATE integration_health
            SET cooldownUntil = NOW() - INTERVAL 60 SECOND
          WHERE integrationId = ${TEST_INTEGRATION_ID}
            AND destinationId = ${TEST_DESTINATION_ID_A}`,
    );

    const r = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
    });
    expect(r.decision).toBe("probe");
    expect(r.state).toBe("HALF_OPEN");

    // Confirm the row was actually mutated, not just reported as HALF_OPEN.
    const after = (await db.execute(
      sql`SELECT state, halfOpenAttempts FROM integration_health
            WHERE integrationId = ${TEST_INTEGRATION_ID}
              AND destinationId = ${TEST_DESTINATION_ID_A}`,
    )) as unknown as [Array<{ state: string; halfOpenAttempts: number }>, unknown];
    expect(after[0][0]?.state).toBe("HALF_OPEN");
    expect(after[0][0]?.halfOpenAttempts).toBe(0);
  });

  // ─── 5. HALF_OPEN within probe budget → probe ────────────────────────────

  it("returns probe when the row is HALF_OPEN with budget remaining", async () => {
    // Trip, then manually flip to HALF_OPEN (simulates one probe already used).
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
    });
    await db.execute(
      sql`UPDATE integration_health
            SET state = 'HALF_OPEN', halfOpenAttempts = 0, halfOpenSuccesses = 0
          WHERE integrationId = ${TEST_INTEGRATION_ID}
            AND destinationId = ${TEST_DESTINATION_ID_A}`,
    );

    const r = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
    });
    expect(r.decision).toBe("probe");
    expect(r.state).toBe("HALF_OPEN");
    expect(r.reason).toMatch(/half_open_probe/);
  });

  // ─── 6. HALF_OPEN past probe budget → block ──────────────────────────────

  it("returns block when HALF_OPEN halfOpenAttempts has hit the probeBudget", async () => {
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
    });
    // Probe budget for rate_limit is small (typically 1); set attempts high.
    await db.execute(
      sql`UPDATE integration_health
            SET state = 'HALF_OPEN', halfOpenAttempts = 99, halfOpenSuccesses = 0
          WHERE integrationId = ${TEST_INTEGRATION_ID}
            AND destinationId = ${TEST_DESTINATION_ID_A}`,
    );

    const r = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
    });
    expect(r.decision).toBe("block");
    expect(r.state).toBe("HALF_OPEN");
    expect(r.reason).toMatch(/half_open_budget_exhausted/);
  });

  // ─── 7. manualLock=OPEN trumps everything ────────────────────────────────

  it("returns block with reason=manual_lock_open even when state is CLOSED", async () => {
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: true,
    });
    await db.execute(
      sql`UPDATE integration_health
            SET manualLock = 'OPEN'
          WHERE integrationId = ${TEST_INTEGRATION_ID}
            AND destinationId = ${TEST_DESTINATION_ID_A}`,
    );

    const r = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
    });
    expect(r.decision).toBe("block");
    expect(r.reason).toBe("manual_lock_open");
    expect(r.manualLock).toBe("OPEN");
  });

  // ─── 8. manualLock=CLOSED trumps OPEN state ──────────────────────────────

  it("returns allow with reason=manual_lock_closed even when state is OPEN", async () => {
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
    });
    await db.execute(
      sql`UPDATE integration_health
            SET manualLock = 'CLOSED'
          WHERE integrationId = ${TEST_INTEGRATION_ID}
            AND destinationId = ${TEST_DESTINATION_ID_A}`,
    );

    const r = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
    });
    expect(r.decision).toBe("allow");
    expect(r.reason).toBe("manual_lock_closed");
    expect(r.manualLock).toBe("CLOSED");
  });

  // ─── 9. Per-app sibling block ────────────────────────────────────────────

  it("blocks a new destination of an app whose sibling is currently OPEN", async () => {
    // Open destination A with appKey, then ask for destination B (never
    // seen) of the same app — should be blocked by sibling-check.
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
      appKey: TEST_APP_KEY,
    });

    const r = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_B,
      appKey: TEST_APP_KEY,
    });
    expect(r.decision).toBe("block");
    expect(r.reason).toMatch(/app_sibling_open/);
  });

  // ─── 10. autoPromoteExpiredCooldowns — bulk promotion ────────────────────

  it("auto-promotes OPEN rows with expired cooldown to HALF_OPEN in bulk", async () => {
    // Create two OPEN rows with expired cooldowns
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
    });
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_B,
      success: false,
      errorType: "rate_limit",
    });
    await db.execute(
      sql`UPDATE integration_health
            SET cooldownUntil = NOW() - INTERVAL 60 SECOND
          WHERE integrationId = ${TEST_INTEGRATION_ID}`,
    );

    const promoted = await autoPromoteExpiredCooldowns(db);
    expect(promoted).toBeGreaterThanOrEqual(2);

    const rows = (await db.execute(
      sql`SELECT destinationId, state FROM integration_health
            WHERE integrationId = ${TEST_INTEGRATION_ID}`,
    )) as unknown as [Array<{ destinationId: number; state: string }>, unknown];
    for (const row of rows[0]) {
      expect(row.state).toBe("HALF_OPEN");
    }
  });

  // ─── 11. autoPromoteExpiredCooldowns — skips manual_lock=OPEN ────────────

  it("does NOT auto-promote rows with manualLock=OPEN even if cooldown expired", async () => {
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
    });
    await db.execute(
      sql`UPDATE integration_health
            SET cooldownUntil = NOW() - INTERVAL 60 SECOND,
                manualLock = 'OPEN'
          WHERE integrationId = ${TEST_INTEGRATION_ID}
            AND destinationId = ${TEST_DESTINATION_ID_A}`,
    );

    await autoPromoteExpiredCooldowns(db);

    const after = (await db.execute(
      sql`SELECT state FROM integration_health
            WHERE integrationId = ${TEST_INTEGRATION_ID}
              AND destinationId = ${TEST_DESTINATION_ID_A}`,
    )) as unknown as [Array<{ state: string }>, unknown];
    expect(after[0][0]?.state).toBe("OPEN");
  });

  // ─── 12. HALF_OPEN probe success → CLOSED transition via recordOutcome ──

  it("HALF_OPEN probe success closes the breaker after probesToClose successes", async () => {
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
    });
    await db.execute(
      sql`UPDATE integration_health
            SET state = 'HALF_OPEN', halfOpenAttempts = 0, halfOpenSuccesses = 0
          WHERE integrationId = ${TEST_INTEGRATION_ID}
            AND destinationId = ${TEST_DESTINATION_ID_A}`,
    );

    const result = await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: true,
    });
    expect(result.fromState).toBe("HALF_OPEN");
    expect(result.toState).toBe("CLOSED");
    expect(result.transitioned).toBe(true);
  });

  // ─── 13. HALF_OPEN probe failure → OPEN with bumped cooldown level ──────

  it("HALF_OPEN probe failure reopens the breaker with a higher cooldown level", async () => {
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
    });
    await db.execute(
      sql`UPDATE integration_health
            SET state = 'HALF_OPEN', halfOpenAttempts = 0, halfOpenSuccesses = 0,
                cooldownLevel = 0
          WHERE integrationId = ${TEST_INTEGRATION_ID}
            AND destinationId = ${TEST_DESTINATION_ID_A}`,
    );

    const result = await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID_A,
      success: false,
      errorType: "rate_limit",
      errorMessage: "429 again",
    });
    expect(result.fromState).toBe("HALF_OPEN");
    expect(result.toState).toBe("OPEN");
    expect(result.transitioned).toBe(true);

    const after = (await db.execute(
      sql`SELECT cooldownLevel FROM integration_health
            WHERE integrationId = ${TEST_INTEGRATION_ID}
              AND destinationId = ${TEST_DESTINATION_ID_A}`,
    )) as unknown as [Array<{ cooldownLevel: number }>, unknown];
    expect(after[0][0]?.cooldownLevel).toBeGreaterThanOrEqual(1);
  });
});
