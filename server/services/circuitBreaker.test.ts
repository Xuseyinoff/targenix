/**
 * circuitBreaker.test.ts
 *
 * Two test suites:
 *   1. Pure-logic tests for circuitPolicy.ts — no DB needed, always run.
 *   2. State-machine integration tests against the local MySQL DB. Skipped
 *      when DATABASE_URL is missing so CI environments without a database
 *      still produce green builds.
 *
 * The state machine is tightly coupled to SQL semantics (UPSERT, UNIQUE key
 * races, NULL-vs-now comparisons). Mocking Drizzle's fluent chains end-to-end
 * is fragile and gives false confidence; running against a real DB and
 * truncating between cases is more honest.
 */

import "dotenv/config";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  CIRCUIT_POLICY,
  cooldownMsForLevel,
  getPolicy,
  isMaxLevel,
} from "../lib/circuitPolicy";

// ─── 1. Pure-logic tests (always run) ──────────────────────────────────────

describe("circuitPolicy", () => {
  it("getPolicy falls back to 'unknown' for null/undefined errorType", () => {
    expect(getPolicy(null)).toBe(CIRCUIT_POLICY.unknown);
    expect(getPolicy(undefined)).toBe(CIRCUIT_POLICY.unknown);
  });

  it("getPolicy returns the exact policy for each known errorType", () => {
    expect(getPolicy("network")).toBe(CIRCUIT_POLICY.network);
    expect(getPolicy("rate_limit")).toBe(CIRCUIT_POLICY.rate_limit);
    expect(getPolicy("auth")).toBe(CIRCUIT_POLICY.auth);
    expect(getPolicy("validation")).toBe(CIRCUIT_POLICY.validation);
  });

  it("validation policy never trips by design (consecutiveTrip is Infinity)", () => {
    expect(CIRCUIT_POLICY.validation.consecutiveTrip).toBe(Number.POSITIVE_INFINITY);
  });

  it("rate_limit is the only policy that trips on a single failure", () => {
    expect(CIRCUIT_POLICY.rate_limit.consecutiveTrip).toBe(1);
    expect(CIRCUIT_POLICY.network.consecutiveTrip).toBeGreaterThan(1);
    expect(CIRCUIT_POLICY.auth.consecutiveTrip).toBeGreaterThan(1);
  });

  it("cooldownLadder durations are strictly non-decreasing", () => {
    for (const klass of ["network", "rate_limit", "auth", "unknown"] as const) {
      const ladder = CIRCUIT_POLICY[klass].cooldownLadder;
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i]).toBeGreaterThanOrEqual(ladder[i - 1]!);
      }
    }
  });

  it("cooldownMsForLevel clamps to the final entry past the ladder length", () => {
    const p = CIRCUIT_POLICY.network;
    const last = p.cooldownLadder[p.cooldownLadder.length - 1]!;
    expect(cooldownMsForLevel(p, p.cooldownLadder.length + 5)).toBe(last);
    expect(cooldownMsForLevel(p, -1)).toBe(p.cooldownLadder[0]);
  });

  it("isMaxLevel is true once we reach the final ladder entry", () => {
    const p = CIRCUIT_POLICY.auth;
    expect(isMaxLevel(p, p.cooldownLadder.length - 1)).toBe(true);
    expect(isMaxLevel(p, p.cooldownLadder.length - 2)).toBe(false);
    expect(isMaxLevel(p, 999)).toBe(true);
  });

  it("auth at max level requires manual intervention", () => {
    expect(CIRCUIT_POLICY.auth.requireManualCloseAtMax).toBe(true);
    expect(CIRCUIT_POLICY.network.requireManualCloseAtMax).toBe(false);
    expect(CIRCUIT_POLICY.rate_limit.requireManualCloseAtMax).toBe(false);
  });
});

// ─── 2. State machine integration tests (require local DB) ─────────────────

const HAS_DB = Boolean(
  process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL,
);

(HAS_DB ? describe : describe.skip)("circuitBreaker — state machine (DB-backed)", () => {
  // Use absurdly large IDs so we cannot collide with real integration rows
  // even on a shared dev DB.
  const TEST_INTEGRATION_ID = 999_001;
  const TEST_DESTINATION_ID = 999_001;

  let db: import("../db").DbClient;
  let recordOutcome: typeof import("./circuitBreaker").recordOutcome;
  let evaluateClaim: typeof import("./circuitBreaker").evaluateClaim;

  beforeAll(async () => {
    const dbMod = await import("../db");
    const got = await dbMod.getDb();
    if (!got) throw new Error("DB unavailable despite DATABASE_URL set");
    db = got;
    const cb = await import("./circuitBreaker");
    recordOutcome = cb.recordOutcome;
    evaluateClaim = cb.evaluateClaim;
  });

  afterAll(async () => {
    const { closeDb } = await import("../db");
    await closeDb();
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM integration_health WHERE integrationId = ${TEST_INTEGRATION_ID}`);
    await db.execute(sql`DELETE FROM integration_health_events WHERE integrationId = ${TEST_INTEGRATION_ID}`);
  });

  it("first outcome on a never-seen destination creates a CLOSED row", async () => {
    const r = await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
      success: true,
    });
    expect(r.fromState).toBe("CLOSED");
    expect(r.toState).toBe("CLOSED");
    expect(r.transitioned).toBe(false);
  });

  it("5 consecutive network failures trip CLOSED → OPEN", async () => {
    let last;
    for (let i = 0; i < CIRCUIT_POLICY.network.consecutiveTrip; i++) {
      last = await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "network",
        errorMessage: "ETIMEDOUT",
      });
    }
    expect(last?.fromState).toBe("CLOSED");
    expect(last?.toState).toBe("OPEN");
    expect(last?.transitioned).toBe(true);
    expect(last?.reason).toMatch(/consecutive/);
  });

  it("a single rate_limit failure trips immediately (consecutiveTrip=1)", async () => {
    const r = await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
      success: false,
      errorType: "rate_limit",
      errorMessage: "429 Too Many Requests",
    });
    expect(r.toState).toBe("OPEN");
    expect(r.transitioned).toBe(true);
  });

  it("validation failures NEVER trip the breaker (by policy)", async () => {
    for (let i = 0; i < 50; i++) {
      const r = await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "validation",
        errorMessage: "missing required field",
      });
      expect(r.toState).toBe("CLOSED");
    }
  });

  it("a success between failures resets the consecutive streak", async () => {
    // 4 fails — one short of network trip threshold (5)
    for (let i = 0; i < 4; i++) {
      await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "network",
      });
    }
    // 1 success — should reset
    await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
      success: true,
    });
    // 4 more fails — should still not trip (streak was reset)
    let last;
    for (let i = 0; i < 4; i++) {
      last = await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "network",
      });
    }
    expect(last?.toState).toBe("CLOSED");
  });

  it("evaluateClaim returns 'block' while OPEN before cooldown expires", async () => {
    for (let i = 0; i < 5; i++) {
      await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "network",
      });
    }
    const ev = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
    });
    expect(ev.decision).toBe("block");
    expect(ev.state).toBe("OPEN");
  });

  it("evaluateClaim promotes OPEN → HALF_OPEN once cooldown expires (decision: probe)", async () => {
    for (let i = 0; i < 5; i++) {
      await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "network",
      });
    }
    // Fast-forward: manually expire the cooldown (set it well in the past to
    // dodge any DB-vs-JS clock skew at sub-second resolution).
    await db.execute(sql`
      UPDATE integration_health
      SET cooldownUntil = DATE_SUB(NOW(), INTERVAL 1 HOUR)
      WHERE integrationId = ${TEST_INTEGRATION_ID}
    `);
    const ev = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
    });
    expect(ev.decision).toBe("probe");
    expect(ev.state).toBe("HALF_OPEN");
  });

  it("HALF_OPEN → CLOSED after probesToClose successes; cooldownLevel resets", async () => {
    // Open the breaker
    for (let i = 0; i < 5; i++) {
      await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "network",
      });
    }
    // Expire cooldown + promote to HALF_OPEN
    await db.execute(sql`
      UPDATE integration_health
      SET cooldownUntil = DATE_SUB(NOW(), INTERVAL 1 SECOND)
      WHERE integrationId = ${TEST_INTEGRATION_ID}
    `);
    await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
    }); // triggers the promotion

    const r = await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
      success: true,
    });
    expect(r.fromState).toBe("HALF_OPEN");
    expect(r.toState).toBe("CLOSED");
    expect(r.transitioned).toBe(true);

    const [row] = (await db.execute(sql`
      SELECT cooldownLevel FROM integration_health WHERE integrationId = ${TEST_INTEGRATION_ID}
    `)) as any;
    expect(Number(row[0].cooldownLevel)).toBe(0);
  });

  it("HALF_OPEN probe failure re-opens with cooldownLevel + 1 (exponential)", async () => {
    // Open
    for (let i = 0; i < 5; i++) {
      await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "network",
      });
    }
    // Promote
    await db.execute(sql`
      UPDATE integration_health
      SET cooldownUntil = DATE_SUB(NOW(), INTERVAL 1 SECOND)
      WHERE integrationId = ${TEST_INTEGRATION_ID}
    `);
    await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
    });
    // Probe fails
    const r = await recordOutcome(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
      success: false,
      errorType: "network",
    });
    expect(r.fromState).toBe("HALF_OPEN");
    expect(r.toState).toBe("OPEN");

    const [row] = (await db.execute(sql`
      SELECT cooldownLevel FROM integration_health WHERE integrationId = ${TEST_INTEGRATION_ID}
    `)) as any;
    expect(Number(row[0].cooldownLevel)).toBe(1);
  });

  it("manualLock='OPEN' forces block regardless of state", async () => {
    await db.execute(sql`
      INSERT INTO integration_health (integrationId, destinationId, state, manualLock)
      VALUES (${TEST_INTEGRATION_ID}, ${TEST_DESTINATION_ID}, 'CLOSED', 'OPEN')
    `);
    const ev = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
    });
    expect(ev.decision).toBe("block");
    expect(ev.reason).toBe("manual_lock_open");
  });

  it("manualLock='CLOSED' forces allow even when state would be OPEN", async () => {
    for (let i = 0; i < 5; i++) {
      await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "network",
      });
    }
    await db.execute(sql`
      UPDATE integration_health SET manualLock='CLOSED'
      WHERE integrationId = ${TEST_INTEGRATION_ID}
    `);
    const ev = await evaluateClaim(db, {
      integrationId: TEST_INTEGRATION_ID,
      destinationId: TEST_DESTINATION_ID,
    });
    expect(ev.decision).toBe("allow");
    expect(ev.reason).toBe("manual_lock_closed");
  });

  it("appends an 'opened' event to integration_health_events on each trip", async () => {
    for (let i = 0; i < 5; i++) {
      await recordOutcome(db, {
        integrationId: TEST_INTEGRATION_ID,
        destinationId: TEST_DESTINATION_ID,
        success: false,
        errorType: "network",
      });
    }
    const [events] = (await db.execute(sql`
      SELECT eventType, fromState, toState
      FROM integration_health_events
      WHERE integrationId = ${TEST_INTEGRATION_ID}
      ORDER BY id DESC LIMIT 1
    `)) as any;
    expect(events[0].eventType).toBe("opened");
    expect(events[0].fromState).toBe("CLOSED");
    expect(events[0].toState).toBe("OPEN");
  });
});
