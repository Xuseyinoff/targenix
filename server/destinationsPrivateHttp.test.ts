/**
 * Source-grep contract tests for the PR 2/4 private-HTTP wiring.
 *
 * The Destinations Cleanup Sprint, PR 2/4 introduced:
 *   1. `destinations.parentIntegrationId` column (migration 0094).
 *   2. `destinations.create` now accepts + persists the column, with an
 *      ownership check that the parent integration belongs to the caller.
 *   3. `destinations.list` defaults to filtering OUT rows whose
 *      `parentIntegrationId IS NOT NULL`, with `includePrivate=true` as
 *      the opt-in escape hatch (used by PR 1's edit-destination dialog).
 *   4. `destinations.attachToIntegration` — late-binding mutation that the
 *      wizard calls after `integrations.create` returns so the new
 *      destination can be flipped to private without a chicken-and-egg.
 *
 * Same pattern as `tenantUpdateIsolation.test.ts` /
 * `destinationsUpdateIsolation.test.ts`: assert by reading the router
 * source and matching the contract-shaping regexes. The DB-backed
 * behavioural tests run on Railway's prod-shaped integration runner; this
 * file is the in-repo guard that survives offline CI and won't quietly
 * regress if someone deletes the ownership check.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const ROUTER_SRC = readFileSync(
  join(repoRoot, "server", "routers", "destinationsRouter.ts"),
  "utf8",
);
const SCHEMA_SRC = readFileSync(
  join(repoRoot, "drizzle", "schema.ts"),
  "utf8",
);
const MIGRATION_SRC = readFileSync(
  join(
    repoRoot,
    "drizzle",
    "0094_destinations_parent_integration.sql",
  ),
  "utf8",
);

describe("destinations schema — parentIntegrationId column (PR 2/4)", () => {
  it("schema.ts declares destinations.parentIntegrationId as nullable INT", () => {
    // The column must be declared INSIDE the destinations table block —
    // schema-wide greps would false-positive on other tables that may
    // gain a similarly-named column later.
    const block = SCHEMA_SRC.match(
      /export const destinations = mysqlTable[\s\S]*?^\}\)\);/m,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/parentIntegrationId:\s*int\("parentIntegrationId"\)/);
    // Negative: must NOT be `.notNull()` — the whole privacy semantic
    // depends on NULL meaning "shared". A .notNull() addition would
    // break every existing shared row.
    expect(block![0]).not.toMatch(/parentIntegrationId:\s*int\([^)]+\)\.notNull/);
  });

  it("schema.ts declares idx_destinations_parent_integration on the column", () => {
    const block = SCHEMA_SRC.match(
      /export const destinations = mysqlTable[\s\S]*?^\}\)\);/m,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(
      /index\("idx_destinations_parent_integration"\)\.on\(t\.parentIntegrationId\)/,
    );
  });

  it("migration 0094 uses ALGORITHM=INPLACE,LOCK=NONE for the ADD COLUMN", () => {
    // Online-DDL guarantee — the destinations table is on the hot dispatch
    // path; a blocking ALTER would stall lead delivery for the duration of
    // the migration. Asserting the hint sticks around in source.
    expect(MIGRATION_SRC).toMatch(/ADD COLUMN\s+`parentIntegrationId`[\s\S]*ALGORITHM=INPLACE,\s*LOCK=NONE/);
  });
});

describe("destinations.create — parentIntegrationId persistence (PR 2/4)", () => {
  it("input schema accepts an optional parentIntegrationId", () => {
    const create = ROUTER_SRC.match(/^  create:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m);
    expect(create).not.toBeNull();
    expect(create![0]).toMatch(
      /parentIntegrationId:\s*z\.number\(\)\.int\(\)\.positive\(\)\.nullable\(\)\.optional\(\)/,
    );
  });

  it("ownership-checks the parent integration before insert", () => {
    const create = ROUTER_SRC.match(/^  create:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m);
    expect(create).not.toBeNull();
    // Must SELECT integrations WHERE id=parentIntegrationId AND userId=ctx.user.id.
    // The exact AND() shape is fixed so a regression that drops the
    // userId check will fail this test.
    expect(create![0]).toMatch(
      /\.from\(integrations\)[\s\S]*?\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(integrations\.id,\s*input\.parentIntegrationId\)\s*,\s*\n?\s*eq\(integrations\.userId,\s*ctx\.user\.id\)/,
    );
    // The "not found" message is the public-facing surface — pinning it
    // so a regression that throws raw zod errors doesn't slip through.
    expect(create![0]).toMatch(/throw new Error\("Parent integration not found"\)/);
  });

  it("forwards parentIntegrationId into every dispatch-type insert via the spread", () => {
    const create = ROUTER_SRC.match(/^  create:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m);
    expect(create).not.toBeNull();
    // The single spread variable used by all 5 insert branches.
    expect(create![0]).toMatch(/const parentSpread\s*=/);
    // Count spread sites — telegram, sheets, http-api-key, http-request,
    // legacy custom. All 5 must spread the parent so a private telegram
    // (rare but legitimate when wizard wants it) lands in the column too.
    const spreadCount = (create![0].match(/\.\.\.parentSpread/g) ?? []).length;
    expect(spreadCount).toBe(5);
  });

  it("runs assertSafeOutboundUrl on http-request URLs at create time", () => {
    // Defence-in-depth — the adapter re-runs this at dispatch, but failing
    // fast at create-time gives the user a friendly error in the wizard
    // instead of a silent saved-but-broken row.
    const create = ROUTER_SRC.match(/^  create:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m);
    expect(create).not.toBeNull();
    expect(create![0]).toMatch(/dispatchType === "http-request"[\s\S]*?assertSafeOutboundUrl/);
  });
});

describe("destinations.list — private filter (PR 2/4)", () => {
  it("accepts an optional { includePrivate: boolean } input", () => {
    const list = ROUTER_SRC.match(/^  list:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m);
    expect(list).not.toBeNull();
    expect(list![0]).toMatch(/includePrivate:\s*z\.boolean\(\)\.optional\(\)/);
  });

  it("defaults to excluding parentIntegrationId IS NOT NULL rows", () => {
    const list = ROUTER_SRC.match(/^  list:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m);
    expect(list).not.toBeNull();
    // Filter is gated on the includePrivate flag; assert both the
    // sentinel SQL string and the gate variable name appear together.
    expect(list![0]).toMatch(
      /includePrivate\s*\?\s*undefined\s*:\s*sql`\$\{destinations\.parentIntegrationId\} IS NULL`/,
    );
  });
});

describe("destinations.attachToIntegration — late-bind mutation (PR 2/4)", () => {
  it("is declared as a protectedProcedure mutation with destinationId + integrationId", () => {
    const block = ROUTER_SRC.match(
      /^  attachToIntegration:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/destinationId:\s*z\.number\(\)\.int\(\)\.positive\(\)/);
    expect(block![0]).toMatch(/integrationId:\s*z\.number\(\)\.int\(\)\.positive\(\)/);
  });

  it("ownership-scopes BOTH the destination lookup AND the parent lookup AND the UPDATE", () => {
    const block = ROUTER_SRC.match(
      /^  attachToIntegration:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    // Three queries fire, all three must scope by ctx.user.id —
    // otherwise a hand-crafted call could attach someone else's
    // destination to your integration (or yours to theirs).
    expect(block![0]).toMatch(
      /\.from\(destinations\)[\s\S]*?eq\(destinations\.id,\s*input\.destinationId\)[\s\S]*?eq\(destinations\.userId,\s*ctx\.user\.id\)/,
    );
    expect(block![0]).toMatch(
      /\.from\(integrations\)[\s\S]*?eq\(integrations\.id,\s*input\.integrationId\)[\s\S]*?eq\(integrations\.userId,\s*ctx\.user\.id\)/,
    );
    expect(block![0]).toMatch(
      /\.update\(destinations\)[\s\S]*?\.where\(\s*and\(\s*eq\(destinations\.id,\s*input\.destinationId\)\s*,\s*eq\(destinations\.userId,\s*ctx\.user\.id\)/,
    );
  });

  it("refuses to re-parent a destination that is already private elsewhere", () => {
    const block = ROUTER_SRC.match(
      /^  attachToIntegration:\s*protectedProcedure[\s\S]*?\n    \}\),\n/m,
    );
    expect(block).not.toBeNull();
    // Guard against cross-integration capture — once a destination is
    // private to integration A, it must NOT be silently re-pointed at
    // integration B.
    expect(block![0]).toMatch(/parentIntegrationId\s*!==\s*input\.integrationId/);
    expect(block![0]).toMatch(
      /throw new Error\("Destination already private to a different integration"\)/,
    );
  });
});
