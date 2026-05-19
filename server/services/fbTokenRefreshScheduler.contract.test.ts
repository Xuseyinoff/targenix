/**
 * Source-grep contract tests for the FB token-refresh scheduler wiring.
 *
 * Guards against silent regressions where someone removes a key import
 * or changes the classifier call shape. These are coarse — exact phrasing
 * may change, but the shape must survive.
 *
 * CRLF-tolerant: every source read strips "\r" before regex tests so the
 * suite passes on Windows checkouts where core.autocrlf=true flips line
 * endings (per saved memory rule [[feedback-crlf-on-windows]]).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSource(relPath: string): string {
  const abs = resolve(__dirname, "..", "..", relPath);
  return readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
}

describe("fbTokenRefreshScheduler — public surface", () => {
  const src = readSource("server/services/fbTokenRefreshScheduler.ts");

  it("exports the start/stop/tick triplet that worker wiring expects", () => {
    expect(src).toMatch(/export function startFbTokenRefreshScheduler\(/);
    expect(src).toMatch(/export function stopFbTokenRefreshScheduler\(/);
    expect(src).toMatch(/export async function runFbTokenRefreshTick\(/);
  });

  it("returns a counter shape with the five buckets the design doc specifies", () => {
    // The shape — scanned / refreshed / failed / skipped / dead — is part
    // of the public contract: ops will grep Railway logs for these names.
    expect(src).toMatch(/export interface FbTokenRefreshResult\s*\{/);
    expect(src).toMatch(/scanned:\s*number/);
    expect(src).toMatch(/refreshed:\s*number/);
    expect(src).toMatch(/failed:\s*number/);
    expect(src).toMatch(/skipped:\s*number/);
    expect(src).toMatch(/dead:\s*number/);
  });
});

describe("fbTokenRefreshScheduler — correctness anchors", () => {
  const src = readSource("server/services/fbTokenRefreshScheduler.ts");

  it("queries facebook_accounts.tokenExpiresAt with the required NOT NULL + window filter", () => {
    // Without the isNotNull guard the scheduler would try to refresh
    // never-expiring business tokens. Without the upper-bound, it would
    // refresh every account on every tick.
    expect(src).toMatch(/isNotNull\(facebookAccounts\.tokenExpiresAt\)/);
    expect(src).toMatch(/lt\(facebookAccounts\.tokenExpiresAt,\s*horizon\)/);
    expect(src).toMatch(/gte\(facebookAccounts\.tokenExpiresAt,\s*now\)/);
  });

  it("processes due rows oldest-expiry-first (asc orderBy)", () => {
    // If a tick is killed midway, the highest-risk accounts must already
    // have been attempted.
    expect(src).toMatch(/orderBy\(asc\(facebookAccounts\.tokenExpiresAt\)\)/);
  });

  it("uses classifyGraphError on the caught FB error (same classifier as processLead)", () => {
    expect(src).toMatch(/import\s*\{[\s\S]*?classifyGraphError[\s\S]*?\}\s*from\s*"\.\.\/lib\/leadEnrichmentRetryPolicy"/);
    expect(src).toMatch(/classifyGraphError\(fb\)/);
  });

  it("treats expires_in falsy/zero as never-expires (tokenExpiresAt=null) per bfeaf23 fix", () => {
    // The new-expiry computation must guard against expires_in=0 OR
    // missing — both indicate a business token. Park-at-now-plus-zero
    // would put the row in the danger zone immediately.
    expect(src).toMatch(/exchanged\.expires_in\s*&&\s*exchanged\.expires_in\s*>\s*0/);
    expect(src).toMatch(/newExpiresAt[\s\S]*?:\s*null/);
  });

  it("respects FB_TOKEN_REFRESH_ENABLED feature flag at start time", () => {
    expect(src).toMatch(/envBool\("FB_TOKEN_REFRESH_ENABLED"/);
  });

  it("uses an _running overlap guard before tick execution", () => {
    expect(src).toMatch(/if\s*\(_running\)/);
    expect(src).toMatch(/_running\s*=\s*true/);
    expect(src).toMatch(/_running\s*=\s*false/);
  });

  it("Phase 2A explicitly defers Telegram — the file references the followup, not the call", () => {
    // Belt-and-braces: the scheduler must NOT import the Telegram surface
    // in Phase 2A. The marker comment also helps Phase 2B grep for the
    // dead-token branch later.
    expect(src).not.toMatch(/from\s*"\.\.\/webhooks\/telegramWebhook"/);
    expect(src).not.toMatch(/sendLeadErrorTelegramNotification/);
    expect(src).toMatch(/Phase 2B/);
  });
});

describe("worker / single-service wiring", () => {
  const workerSrc = readSource("server/workers/run.ts");
  const coreSrc = readSource("server/_core/index.ts");

  it("worker imports and starts the scheduler", () => {
    expect(workerSrc).toMatch(
      /import\s*\{[\s\S]*?startFbTokenRefreshScheduler[\s\S]*?\}\s*from\s*"\.\.\/services\/fbTokenRefreshScheduler"/,
    );
    expect(workerSrc).toMatch(/startFbTokenRefreshScheduler\(\)/);
  });

  it("worker cancels the scheduler timer in the shutdown handler", () => {
    // Without an explicit stop, the boot/tick timer keeps the worker
    // alive past worker.close() during a Railway redeploy.
    expect(workerSrc).toMatch(/stopFbTokenRefreshScheduler\(\)/);
  });

  it("single-service web mode (START_WORKER=true) also starts the scheduler", () => {
    // Per [[project-web-worker-split]] the START_WORKER path needs the
    // same schedulers as the standalone worker. Drift between the two
    // is a recurring bug source.
    expect(coreSrc).toMatch(
      /await import\("\.\.\/services\/fbTokenRefreshScheduler"\)/,
    );
    expect(coreSrc).toMatch(/startFbTokenRefreshScheduler\(\)/);
  });
});
