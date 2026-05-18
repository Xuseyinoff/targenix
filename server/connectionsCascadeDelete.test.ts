/**
 * Source-grep contract tests for the PR 3/4 cascade-delete wiring.
 *
 * The Destinations Cleanup Sprint, PR 3/4 added two surfaces on
 * connectionsRouter:
 *   1. `previewDelete` — read-only forecast the dialog calls before the
 *      user confirms.
 *   2. `disconnect` — now reassigns dependent destinations to a sibling
 *      connection when one exists, otherwise soft-deletes them
 *      (isActive=false). Both paths still scrub credential-shaped keys
 *      from templateConfig (preserved from the pre-PR-3 behaviour).
 *
 * Both surfaces share the `buildDisconnectPlan` helper so the dialog and
 * the mutation can never disagree about what's about to happen. These
 * tests pin the contract by reading the router source — same pattern as
 * `tenantUpdateIsolation.test.ts`, `destinationsUpdateIsolation.test.ts`,
 * and `destinationsPrivateHttp.test.ts`. The DB-backed behavioural tests
 * run end-to-end on the dev tRPC API (browser verification step).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const ROUTER_SRC = readFileSync(
  join(repoRoot, "server", "routers", "connectionsRouter.ts"),
  "utf8",
);

describe("buildDisconnectPlan — cascade planner (PR 3/4)", () => {
  it("is declared once at module scope (single source of truth)", () => {
    const matches = ROUTER_SRC.match(/^async function buildDisconnectPlan\b/gm) ?? [];
    expect(matches.length).toBe(1);
  });

  it("tenant-scopes the connection lookup", () => {
    const block = ROUTER_SRC.match(
      /^async function buildDisconnectPlan[\s\S]*?^\}\n/m,
    );
    expect(block).not.toBeNull();
    // The first SELECT (connection identity) MUST be scoped by userId or
    // a user could probe other tenants' connection appKeys/displayNames.
    expect(block![0]).toMatch(
      /\.from\(connections\)[\s\S]*?\.where\(\s*and\(\s*eq\(connections\.id,\s*connectionId\)\s*,\s*eq\(connections\.userId,\s*userId\)/,
    );
  });

  it("only surfaces ACTIVE dependent destinations", () => {
    const block = ROUTER_SRC.match(
      /^async function buildDisconnectPlan[\s\S]*?^\}\n/m,
    );
    expect(block).not.toBeNull();
    // The dependents query must AND on isActive=true. Already-deactivated
    // rows would clutter the dialog and confuse the action counts.
    expect(block![0]).toMatch(
      /\.from\(destinations\)[\s\S]*?eq\(destinations\.connectionId,\s*connectionId\)[\s\S]*?eq\(destinations\.isActive,\s*true\)/,
    );
  });

  it("only attempts fallback lookup when the deleting connection has appKey", () => {
    const block = ROUTER_SRC.match(
      /^async function buildDisconnectPlan[\s\S]*?^\}\n/m,
    );
    expect(block).not.toBeNull();
    // The null-appKey policy was decided with the user up-front: 70% of
    // prod connections pre-date the appKey column and always soft-delete.
    // The fallback lookup must be guarded by an explicit null check.
    expect(block![0]).toMatch(/if \(conn\.appKey != null\)/);
  });

  it("fallback lookup is tenant-scoped AND excludes the deleting row AND requires status=active", () => {
    const block = ROUTER_SRC.match(
      /^async function buildDisconnectPlan[\s\S]*?^\}\n/m,
    );
    expect(block).not.toBeNull();
    // Sibling-lookup contract:
    //   - userId scope (don't smuggle another tenant's key)
    //   - appKey match (the grouping key)
    //   - id != connectionId (don't reassign to the row we're deleting)
    //   - status = "active" (don't promote a revoked/error key)
    expect(block![0]).toMatch(
      /eq\(connections\.userId,\s*userId\)[\s\S]*?eq\(connections\.appKey,\s*conn\.appKey\)[\s\S]*?ne\(connections\.id,\s*connectionId\)[\s\S]*?eq\(connections\.status,\s*"active"\)/,
    );
  });

  it("returns the four critical counters (totalDestinations, totalIntegrations, hasFallback, fallbackConnectionId)", () => {
    const block = ROUTER_SRC.match(
      /^async function buildDisconnectPlan[\s\S]*?^\}\n/m,
    );
    expect(block).not.toBeNull();
    // The dialog branches on hasFallback; the toast uses the counters.
    // If any goes missing the UI quietly degrades.
    expect(block![0]).toMatch(/totalDestinations:/);
    expect(block![0]).toMatch(/totalIntegrations:/);
    expect(block![0]).toMatch(/hasFallback:/);
    expect(block![0]).toMatch(/fallbackConnectionId:/);
  });
});

describe("connections.previewDelete — read-only forecast (PR 3/4)", () => {
  it("is declared as a query (NOT a mutation) so the dialog can poll safely", () => {
    const block = ROUTER_SRC.match(
      /^  previewDelete:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/\.query\(/);
    expect(block![0]).not.toMatch(/\.mutation\(/);
  });

  it("delegates to buildDisconnectPlan (no duplicate logic)", () => {
    const block = ROUTER_SRC.match(
      /^  previewDelete:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(
      /return buildDisconnectPlan\(db,\s*ctx\.user\.id,\s*input\.id\)/,
    );
  });
});

describe("connections.disconnect — cascade behaviour (PR 3/4)", () => {
  it("calls buildDisconnectPlan once and uses its fallbackConnectionId", () => {
    const block = ROUTER_SRC.match(
      /^  disconnect:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(
      /const plan = await buildDisconnectPlan\(db,\s*userId,\s*input\.id\)/,
    );
    expect(block![0]).toMatch(/const fallbackId = plan\.fallbackConnectionId/);
  });

  it("scrubs templateConfig on BOTH the reassign AND deactivate paths", () => {
    const block = ROUTER_SRC.match(
      /^  disconnect:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    // Per the user's PR-3 decision: scrub on both paths. The inline
    // secrets belonged to the OLD connection; the new connection has
    // its own. Match the literal scrub call BEFORE both UPDATE branches.
    const scrubCount = (block![0].match(/scrubSecretsFromTemplateConfig\(/g) ?? []).length;
    expect(scrubCount).toBeGreaterThanOrEqual(1);
    // The branching update must appear in both branches.
    expect(block![0]).toMatch(/connectionId:\s*fallbackId,\s*templateConfig:\s*scrubbed/);
    expect(block![0]).toMatch(
      /connectionId:\s*null,\s*templateConfig:\s*scrubbed,\s*isActive:\s*false/,
    );
  });

  it("clears stale connectionId on already-inactive dependents (no status flip)", () => {
    const block = ROUTER_SRC.match(
      /^  disconnect:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    // Already-inactive rows were excluded from the planner's count, but
    // we still scrub their connectionId pointer so a future "reactivate"
    // flow can't pick up the dangling reference. No isActive change.
    expect(block![0]).toMatch(
      /\.set\(\{\s*connectionId:\s*null\s*\}\)[\s\S]{0,300}eq\(destinations\.isActive,\s*false\)/,
    );
  });

  it("deletes the connection row inside the transaction with tenant scope", () => {
    const block = ROUTER_SRC.match(
      /^  disconnect:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(
      /tx[\s\S]{0,80}\.delete\(connections\)[\s\S]*?eq\(connections\.id,\s*input\.id\)[\s\S]*?eq\(connections\.userId,\s*userId\)/,
    );
  });

  it("preserves the orphan oauth_token cleanup hook (regression guard)", () => {
    const block = ROUTER_SRC.match(
      /^  disconnect:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    // Pre-PR-3 behaviour: when the deleted connection was the last
    // reference to its oauth_token, that token is also deleted. The
    // cascade refactor MUST keep this — otherwise rolling out PR 3
    // would silently leak shared OAuth tokens in the DB.
    expect(block![0]).toMatch(/stillReferenced[\s\S]*?\.delete\(oauthTokens\)/);
    expect(block![0]).toMatch(/deletedOrphanToken\s*=\s*true/);
  });

  it("returns the new cascade counters (reassignedDestinations + deactivatedDestinations)", () => {
    const block = ROUTER_SRC.match(
      /^  disconnect:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/reassignedDestinations,/);
    expect(block![0]).toMatch(/deactivatedDestinations,/);
    expect(block![0]).toMatch(/fallbackConnectionId:\s*plan\.fallbackConnectionId/);
  });

  it("logs the cascade outcome into connection_events for audit", () => {
    const block = ROUTER_SRC.match(
      /^  disconnect:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    // The connection_events row is the only forensic trail after the
    // connection row itself is gone — must carry the new counters.
    expect(block![0]).toMatch(
      /appendConnectionEvent\(db,\s*\{[\s\S]*?reassignedDestinations[\s\S]*?deactivatedDestinations[\s\S]*?fallbackConnectionId/,
    );
  });
});
