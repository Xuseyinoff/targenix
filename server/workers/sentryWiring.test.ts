/**
 * Source-level guard against regressing the worker-Sentry wiring.
 *
 * AUDIT_REPORT.md Section F.4 found that `server/workers/run.ts` historically
 * never called `initSentry()`, leaving every `captureCritical` /
 * `captureSecurityEvent` call inside `leadWorker.ts`, `appLogger.ts`, and
 * the 12 in-process schedulers as silent no-ops in production.
 *
 * These tests inspect the source of run.ts and globalErrorHandlers.ts to
 * assert the wiring is present. We don't boot a real Sentry client here —
 * `initSentry()`'s own no-op-when-DSN-missing behaviour is already verified
 * by its module-level early return; what we guard is the call site.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..");
const read = (rel: string): string =>
  readFileSync(join(repoRoot, rel), "utf8");

describe("worker — Sentry wiring", () => {
  const src = read("server/workers/run.ts");

  it("imports initSentry and flushSentry from monitoring/sentry", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\binitSentry\b[^}]*\bflushSentry\b[^}]*\}\s*from\s*["']\.\.\/monitoring\/sentry["']/,
    );
  });

  it("calls initSentry({ processTag: 'worker' }) inside boot() before the DB probe", () => {
    // Anchor to `async function boot()` because the health server
    // (defined earlier in the file) also awaits getDb() — without the
    // anchor, indexOf would find that first occurrence and mislead us.
    const bootStart = src.indexOf("async function boot()");
    expect(bootStart).toBeGreaterThan(-1);
    const bootBody = src.slice(bootStart);

    const initIdx = bootBody.search(
      /await\s+initSentry\(\s*\{\s*processTag:\s*["']worker["']\s*\}\s*\)/,
    );
    const dbIdx = bootBody.indexOf("await getDb()");
    expect(initIdx).toBeGreaterThan(-1);
    expect(dbIdx).toBeGreaterThan(-1);
    // Sentry must be live before the DB probe so a boot-time DB failure
    // still produces a Sentry event in production.
    expect(initIdx).toBeLessThan(dbIdx);
  });

  it("flushes Sentry in the shutdown handler before process.exit", () => {
    // The shutdown() helper handles SIGTERM/SIGINT; flushSentry must run
    // before exit so in-flight events aren't dropped on Railway deploys.
    const shutdownBlock = src.match(/async function shutdown[\s\S]*?process\.exit\(0\)/);
    expect(shutdownBlock).not.toBeNull();
    expect(shutdownBlock![0]).toMatch(/await\s+flushSentry\(\s*2000\s*\)/);
  });
});

describe("globalErrorHandlers — Sentry escalation", () => {
  const src = read("server/_core/globalErrorHandlers.ts");

  it("imports captureCritical and flushSentry", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bcaptureCritical\b[^}]*\bflushSentry\b[^}]*\}\s*from\s*["']\.\.\/monitoring\/sentry["']/,
    );
  });

  // Helper: extract the body of a single handler block from
  // `process.on("<event>", ...)` up to the next handler / EOF. Avoids the
  // nested-brace problem that defeats a naïve non-greedy `}\)` match.
  const handlerBody = (text: string, event: string): string => {
    const startMarker = `process.on("${event}"`;
    const start = text.indexOf(startMarker);
    if (start === -1) return "";
    const rest = text.slice(start + startMarker.length);
    // End at the next `process.on(` or the installer-closing log line.
    const nextOn = rest.indexOf("process.on(");
    const consoleEnd = rest.indexOf('console.log(`[${processName}]');
    const candidates = [nextOn, consoleEnd].filter((i) => i > -1);
    const end = candidates.length > 0 ? Math.min(...candidates) : rest.length;
    return rest.slice(0, end);
  };

  it("captures unhandledRejection to Sentry (process kept alive)", () => {
    const body = handlerBody(src, "unhandledRejection");
    expect(body).not.toBe("");
    expect(body).toMatch(/captureCritical\(/);
    // Policy: keep running on rejection — must NOT call process.exit here.
    expect(body).not.toMatch(/process\.exit/);
  });

  it("captures uncaughtException, flushes Sentry, then exits", () => {
    const body = handlerBody(src, "uncaughtException");
    expect(body).not.toBe("");
    expect(body).toMatch(/captureCritical\(/);
    expect(body).toMatch(/flushSentry\(\s*2000\s*\)/);
    expect(body).toMatch(/process\.exit\(1\)/);
  });
});

describe("monitoring/sentry — public surface", () => {
  const src = read("server/monitoring/sentry.ts");

  it("exports initSentry, flushSentry, captureCritical, captureSecurityEvent", () => {
    expect(src).toMatch(/export\s+async\s+function\s+initSentry\b/);
    expect(src).toMatch(/export\s+async\s+function\s+flushSentry\b/);
    expect(src).toMatch(/export\s+function\s+captureCritical\b/);
    expect(src).toMatch(/export\s+function\s+captureSecurityEvent\b/);
  });

  it("initSentry stamps a `process` tag after Sentry.init()", () => {
    expect(src).toMatch(/Sentry\.setTag\(\s*["']process["']\s*,\s*processTag\s*\)/);
  });

  it("flushSentry caps the wait via Sentry.close(timeoutMs)", () => {
    expect(src).toMatch(/_Sentry\.close\(\s*timeoutMs\s*\)/);
  });
});
