/**
 * Source-level regression tests for scheduler overlap protection.
 *
 * AUDIT_REPORT.md Section D.4 originally claimed 7 schedulers lacked
 * overlap guards. Re-verification (Fix 4/5) found 5 of those use the
 * setTimeout self-reschedule pattern, which is INHERENTLY overlap-safe
 * — the next tick is scheduled only AFTER the current one resolves.
 * Only the 2 schedulers that use raw setInterval (`retryScheduler`,
 * `triggerScheduler`) needed an explicit `inFlight` guard.
 *
 * These tests assert the shape of each file's overlap protection
 * (or document the self-reschedule pattern when guard is unnecessary)
 * so a future refactor that switches setTimeout → setInterval doesn't
 * silently regress.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("setInterval schedulers — explicit inFlight guard required", () => {
  it("retryScheduler.ts guards the per-minute order tick with inFlight", () => {
    const src = read("server/services/retryScheduler.ts");
    // Imports the Sentry helper for the catch escalation path.
    expect(src).toMatch(/from\s+["']\.\.\/monitoring\/sentry["']/);
    expect(src).toMatch(/\bcaptureCritical\b/);
    // Module-level overlap flag exists.
    expect(src).toMatch(/let\s+orderTickInFlight\s*=\s*false/);
    // The setInterval callback short-circuits when the prior tick is
    // still running, logs a warning, and never throws.
    expect(src).toMatch(/setInterval\([\s\S]*?if\s*\(orderTickInFlight\)/);
    expect(src).toMatch(/skipping order tick/i);
    // Reset must happen in a finally so an exception inside the tick
    // can never wedge the scheduler.
    expect(src).toMatch(/finally\s*\{[\s\S]*?orderTickInFlight\s*=\s*false/);
    // Sentry escalation paths exist for each inner stage so a thrown
    // tick error reaches telemetry, not just the AdminLogs page.
    expect(src).toMatch(/captureCritical\([^)]+scheduler:\s*["']retry["']/);
  });

  it("triggerScheduler.ts guards runScheduledTriggers with runInFlight", () => {
    const src = read("server/services/triggerScheduler.ts");
    expect(src).toMatch(/from\s+["']\.\.\/monitoring\/sentry["']/);
    expect(src).toMatch(/let\s+runInFlight\s*=\s*false/);
    // Entry-point check + log + early return.
    expect(src).toMatch(/if\s*\(runInFlight\)/);
    expect(src).toMatch(/skipping tick/i);
    // Reset in finally + Sentry escalation in catch.
    expect(src).toMatch(/finally\s*\{[\s\S]*?runInFlight\s*=\s*false/);
    expect(src).toMatch(/captureCritical\([^)]+scheduler:\s*["']trigger["']/);
  });
});

describe("setTimeout self-reschedule schedulers — overlap-safe by design", () => {
  // For each, assert the next tick is scheduled INSIDE the current
  // run's resolution path (so it cannot start until the prior finishes).
  // The signal is `setTimeout(... , INTERVAL)` appearing inside a
  // `.finally(`, the `run` async body, or a `scheduleNext()` helper
  // chained off the current tick. We also assert these files do NOT
  // use `setInterval` for their primary loop — a regression to
  // setInterval would silently reintroduce overlap risk.
  it.each([
    [
      "server/services/leadPollingService.ts",
      /\.finally\(\(\)\s*=>\s*\{[\s\S]*?setTimeout\(tickAndReschedule/,
    ],
    [
      "server/services/logRetentionScheduler.ts",
      /retentionTimer\s*=\s*setTimeout\([\s\S]*?scheduleNext\(\)/,
    ],
    [
      "server/services/formsRefreshScheduler.ts",
      /_timer\s*=\s*setTimeout\(run/,
    ],
    [
      "server/services/adsSyncScheduler.ts",
      /\.finally\(\(\)\s*=>\s*\{[\s\S]*?scheduleNext\(\)/,
    ],
    [
      "server/services/oauthStateCleanupScheduler.ts",
      /cleanupTimer\s*=\s*setTimeout\([\s\S]*?scheduleNext\(\)/,
    ],
  ])("%s uses self-reschedule (no setInterval for primary loop)", (path, pattern) => {
    const src = read(path);
    expect(src).toMatch(pattern);
    // Negative: must NOT use setInterval for the main loop. (refillTimer
    // / unref'd ticker helpers inside other utilities don't appear in
    // these files.)
    expect(src).not.toMatch(/setInterval\(/);
  });
});

describe("graceful shutdown — oauthStateCleanupScheduler.stop is wired", () => {
  it("oauthStateCleanupScheduler exports stopOAuthStateCleanupScheduler", () => {
    const src = read("server/services/oauthStateCleanupScheduler.ts");
    expect(src).toMatch(/export\s+function\s+stopOAuthStateCleanupScheduler\b/);
    expect(src).toMatch(/clearTimeout\(cleanupTimer\)/);
  });

  it("workers/run.ts shutdown() calls stopOAuthStateCleanupScheduler before flushSentry", () => {
    const src = read("server/workers/run.ts");
    // Import is present.
    expect(src).toMatch(/stopOAuthStateCleanupScheduler/);
    // Shutdown order: stop scheduler -> worker.close -> flushSentry -> exit.
    const shutdownBlock = src.match(
      /async function shutdown[\s\S]*?process\.exit\(0\)/,
    );
    expect(shutdownBlock).not.toBeNull();
    const stopIdx = shutdownBlock![0].indexOf("stopOAuthStateCleanupScheduler()");
    const flushIdx = shutdownBlock![0].indexOf("flushSentry(");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(flushIdx);
  });
});

describe("already-guarded schedulers — positive control", () => {
  // Assert the 4 schedulers the audit listed as already safe still are.
  // A regression here means the audit's "OK" entries lost their guard.
  it.each([
    "server/services/connectionHealthScheduler.ts",
    "server/services/crmSyncScheduler.ts",
    "server/services/fxRateScheduler.ts",
    "server/services/insightsRollupScheduler.ts",
    "server/services/metricSnapshotScheduler.ts",
  ])("%s either uses self-reschedule or has an inFlight-style guard", (path) => {
    const src = read(path);
    const hasSelfReschedule =
      /setTimeout\([\s\S]*?(scheduleNext|reschedule|run\b)/i.test(src) &&
      !/setInterval\(/.test(src);
    const hasGuard = /\b(inFlight|isRunning|running|locked|busy)\b/.test(src);
    expect(hasSelfReschedule || hasGuard).toBe(true);
  });
});
