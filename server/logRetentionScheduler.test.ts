/**
 * logRetentionScheduler.test.ts
 *
 * Unit tests for log retention constants and scheduler lifecycle.
 * DB-dependent cleanup logic is covered by integration tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  RETENTION,
  startLogRetentionScheduler,
  stopLogRetentionScheduler,
} from "./services/logRetentionScheduler";

describe("logRetentionScheduler", () => {
  afterEach(() => {
    stopLogRetentionScheduler();
  });

  it("should export correct retention windows", () => {
    expect(RETENTION.USER_HOURS).toBe(48);
    expect(RETENTION.ADMIN_HOURS).toBe(720);
    expect(RETENTION.SYSTEM_ARCHIVE_DAYS).toBe(30);
    expect(RETENTION.SYSTEM_PURGE_DAYS).toBe(90);
  });

  it("should start without throwing", () => {
    expect(() => startLogRetentionScheduler()).not.toThrow();
  });

  it("should be idempotent — calling start twice does not throw", () => {
    startLogRetentionScheduler();
    expect(() => startLogRetentionScheduler()).not.toThrow();
  });

  it("should stop without throwing", () => {
    startLogRetentionScheduler();
    expect(() => stopLogRetentionScheduler()).not.toThrow();
  });

  it("should allow restart after stop", () => {
    startLogRetentionScheduler();
    stopLogRetentionScheduler();
    expect(() => startLogRetentionScheduler()).not.toThrow();
  });

  it("user retention window should be less than admin retention window", () => {
    expect(RETENTION.USER_HOURS).toBeLessThan(RETENTION.ADMIN_HOURS);
  });
});
