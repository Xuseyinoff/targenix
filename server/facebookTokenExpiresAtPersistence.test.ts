/**
 * Regression guard for the "Token expired badge stuck after Reconnect" bug
 * (incident 2026-05-18).
 *
 * Root cause: facebookOAuthCallback.ts and facebookAccountsRouter.ts wrote
 *   `tokenExpiresAt: expiresAt ?? undefined`
 * into Drizzle's .set() / .values(). When the Facebook /oauth/access_token
 * exchange returned an absent or zero `expires_in` (= "never expires" per
 * FB's contract — see facebookGraphService.ts:146 and schema.ts:131 comment
 * "null = never expires (business token)"), the inner `if
 * (exchanged.expires_in)` guard skipped, leaving expiresAt at null. The
 * `?? undefined` fallback then told Drizzle to OMIT the column from the
 * UPDATE statement entirely — preserving a stale expired timestamp from
 * the previous connect, even though the access token itself had been
 * successfully refreshed. The UI badge therefore stayed pinned on "Token
 * expired" forever after reconnect, until manually unstuck.
 *
 * Fix: pass `expiresAt` directly (Date | null). null becomes SQL NULL on
 * INSERT and explicit SET tokenExpiresAt = NULL on UPDATE — matching the
 * schema's "null = never expires" semantics.
 *
 * Test approach: source-grep contract (same pattern as
 * tenantUpdateIsolation.test.ts / connectionsCascadeDelete.test.ts). The
 * write paths must never re-introduce the `?? undefined` fallback for
 * tokenExpiresAt.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const CALLBACK_SRC = readFileSync(
  join(repoRoot, "server", "routes", "facebookOAuthCallback.ts"),
  "utf8",
);
const ROUTER_SRC = readFileSync(
  join(repoRoot, "server", "routers", "facebookAccountsRouter.ts"),
  "utf8",
);

describe("facebook tokenExpiresAt persistence — never `?? undefined`", () => {
  it("facebookOAuthCallback.ts has zero `tokenExpiresAt: expiresAt ?? undefined` sites", () => {
    // The `?? undefined` fallback is the exact pattern that suppresses the
    // UPDATE column write. Any future reintroduction is a regression.
    expect(CALLBACK_SRC).not.toMatch(/tokenExpiresAt:\s*expiresAt\s*\?\?\s*undefined/);
    expect(CALLBACK_SRC).not.toMatch(/tokenExpiresAt:\s*[a-zA-Z_]+\s*\?\?\s*undefined/);
  });

  it("facebookAccountsRouter.ts has zero `tokenExpiresAt: expiresAt ?? undefined` sites", () => {
    expect(ROUTER_SRC).not.toMatch(/tokenExpiresAt:\s*expiresAt\s*\?\?\s*undefined/);
    expect(ROUTER_SRC).not.toMatch(/tokenExpiresAt:\s*[a-zA-Z_]+\s*\?\?\s*undefined/);
  });

  it("every facebookOAuthCallback.ts tokenExpiresAt assignment passes `expiresAt` directly (Date | null)", () => {
    // There are 2 write sites: the UPDATE branch (Step 4 upsert) and the
    // INSERT branch. Both must use the bare `expiresAt` form so that null
    // semantically maps to "never expires" per schema.ts:131.
    const sites = CALLBACK_SRC.match(/tokenExpiresAt:\s*[^,\n]+/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      // Must NOT contain a fallback to undefined.
      expect(site).not.toMatch(/\?\?\s*undefined/);
      // Accepted shapes — bare `expiresAt`, with optional `?? null` fallback.
      const acceptable =
        /tokenExpiresAt:\s*expiresAt\s*[,)}]/.test(site) ||
        /tokenExpiresAt:\s*expiresAt\s*\?\?\s*null/.test(site) ||
        /tokenExpiresAt:\s*expiresAt\s*$/.test(site);
      expect(acceptable, `unexpected tokenExpiresAt shape: "${site}"`).toBe(true);
    }
  });

  it("every facebookAccountsRouter.ts tokenExpiresAt assignment passes `expiresAt` directly", () => {
    // The router has 4 write sites across two procedures (initial connect
    // INSERT/UPDATE + the secondary refresh path INSERT/UPDATE). Same
    // contract — null must propagate to the DB, not be swallowed.
    const sites = ROUTER_SRC.match(/tokenExpiresAt:\s*[^,\n]+/g) ?? [];
    // Note: the router also has SELECT projections that mention
    // `tokenExpiresAt: facebookAccounts.tokenExpiresAt` (drizzle column
    // reference); filter those out before counting write sites.
    const writeSites = sites.filter((s) => !/facebookAccounts\.tokenExpiresAt/.test(s));
    expect(writeSites.length).toBeGreaterThanOrEqual(4);
    for (const site of writeSites) {
      expect(site).not.toMatch(/\?\?\s*undefined/);
      // Accepted shapes:
      //   `tokenExpiresAt: expiresAt,`        (multi-line .set / .values)
      //   `tokenExpiresAt: expiresAt })`      (single-line inline .set)
      //   `tokenExpiresAt: expiresAt ?? null` (explicit null fallback)
      const acceptable =
        /tokenExpiresAt:\s*expiresAt\s*[,)}]/.test(site) ||
        /tokenExpiresAt:\s*expiresAt\s*\?\?\s*null/.test(site) ||
        /tokenExpiresAt:\s*expiresAt\s*$/.test(site);
      expect(acceptable, `unexpected tokenExpiresAt shape: "${site}"`).toBe(true);
    }
  });

  it("LongLivedTokenResult.expires_in is documented as `absent for never-expiring tokens`", () => {
    // Sanity-check the assumption that drove the fix: the FB Graph service
    // explicitly contracts that `expires_in` may be missing, and when it
    // is, the schema column comment says NULL means "never expires". If
    // either contract changes, this test breaks loudly and forces a
    // re-think before any silent regression.
    const graphSrc = readFileSync(
      join(repoRoot, "server", "services", "facebookGraphService.ts"),
      "utf8",
    );
    expect(graphSrc).toMatch(/expires_in\?:\s*number/);
    expect(graphSrc).toMatch(/absent for never-expiring tokens/);

    const schemaSrc = readFileSync(
      join(repoRoot, "drizzle", "schema.ts"),
      "utf8",
    );
    expect(schemaSrc).toMatch(/null = never expires/);
  });
});
