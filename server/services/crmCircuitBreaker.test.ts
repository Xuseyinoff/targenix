import { beforeEach, describe, expect, it } from "vitest";
import {
  shouldSkipCrmAccount,
  recordCrmFailure,
  recordCrmSuccess,
  _getCrmCircuitBreakerState,
  _resetCrmCircuitBreaker,
} from "./crmCircuitBreaker";

describe("crmCircuitBreaker", () => {
  beforeEach(() => {
    _resetCrmCircuitBreaker();
  });

  it("fresh account is never skipped", () => {
    expect(shouldSkipCrmAccount(1).skip).toBe(false);
  });

  it("1-2 failures stay below threshold — no cooldown", () => {
    recordCrmFailure(1);
    recordCrmFailure(1);
    expect(shouldSkipCrmAccount(1).skip).toBe(false);
  });

  it("3rd consecutive failure opens cooldown (5 min ladder rung)", () => {
    const t0 = 1_000_000_000_000;
    recordCrmFailure(1, t0);
    recordCrmFailure(1, t0);
    recordCrmFailure(1, t0);
    const d = shouldSkipCrmAccount(1, t0);
    expect(d.skip).toBe(true);
    expect(d.cooldownUntilMs).toBe(t0 + 5 * 60 * 1000);
    expect(d.reason).toMatch(/3 consecutive failures/);
  });

  it("cooldown expires naturally — account becomes usable again", () => {
    const t0 = 1_000_000_000_000;
    recordCrmFailure(1, t0);
    recordCrmFailure(1, t0);
    recordCrmFailure(1, t0);
    // Just past 5-min cooldown:
    const tAfter = t0 + 5 * 60 * 1000 + 1;
    expect(shouldSkipCrmAccount(1, tAfter).skip).toBe(false);
  });

  it("cooldown ladder escalates: 5 min → 15 min → 1 hour", () => {
    const t0 = 1_000_000_000_000;
    // 3 failures → 5 min rung
    recordCrmFailure(1, t0);
    recordCrmFailure(1, t0);
    recordCrmFailure(1, t0);
    expect(shouldSkipCrmAccount(1, t0).cooldownUntilMs).toBe(t0 + 5 * 60 * 1000);
    // 4th → 15 min rung
    recordCrmFailure(1, t0);
    expect(shouldSkipCrmAccount(1, t0).cooldownUntilMs).toBe(t0 + 15 * 60 * 1000);
    // 5th → 1 hr rung
    recordCrmFailure(1, t0);
    expect(shouldSkipCrmAccount(1, t0).cooldownUntilMs).toBe(t0 + 60 * 60 * 1000);
    // 6th → still 1 hr (top of ladder)
    recordCrmFailure(1, t0);
    expect(shouldSkipCrmAccount(1, t0).cooldownUntilMs).toBe(t0 + 60 * 60 * 1000);
  });

  it("one success wipes the entire failure streak", () => {
    recordCrmFailure(1);
    recordCrmFailure(1);
    recordCrmFailure(1);
    expect(shouldSkipCrmAccount(1).skip).toBe(true);
    recordCrmSuccess(1);
    expect(shouldSkipCrmAccount(1).skip).toBe(false);
    // State entry is dropped entirely so the Map stays bounded.
    expect(_getCrmCircuitBreakerState().has(1)).toBe(false);
  });

  it("accounts are isolated — one tripping doesn't affect another", () => {
    recordCrmFailure(1);
    recordCrmFailure(1);
    recordCrmFailure(1);
    expect(shouldSkipCrmAccount(1).skip).toBe(true);
    expect(shouldSkipCrmAccount(2).skip).toBe(false);
  });
});
