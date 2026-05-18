/**
 * Tenant UPDATE isolation regression test for the `destinationsRouter`.
 *
 * Companion to `tenantUpdateIsolation.test.ts` (which covers
 * triggers / workflows). This file pins the same guarantee for
 * `destinations.update` and `destinations.updateFromTemplate` — both
 * exposed to the new inline editor on /integrations (Destinations Cleanup
 * Sprint, PR 1/4), so any future regression that drops the `userId` check
 * from their WHERE clauses must trip CI before reaching prod.
 *
 * Style note: the destinationsRouter does NOT use the `ownedBy()` helper —
 * it spells out `and(eq(destinations.id, X), eq(destinations.userId, Y))`
 * inline. The assertions below match that exact shape rather than reaching
 * for the helper.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const ROUTER_SRC = readFileSync(
  join(repoRoot, "server", "routers", "destinationsRouter.ts"),
  "utf8",
);

describe("destinationsRouter — tenant isolation on mutations", () => {
  it("`update` SELECT is scoped to (id AND userId)", () => {
    const block = ROUTER_SRC.match(/^\s*update:\s*protectedProcedure[\s\S]*?\n\s*\}\),\n/m);
    expect(block).not.toBeNull();
    // Ownership SELECT before the UPDATE — id + userId both pinned.
    expect(block![0]).toMatch(
      /\.from\(destinations\)[\s\S]*?\.where\(\s*and\(\s*eq\(destinations\.id,\s*input\.id\)\s*,\s*eq\(destinations\.userId,\s*ctx\.user\.id\)/,
    );
  });

  it("`update` UPDATE WHERE is scoped to (id AND userId), never id alone", () => {
    const block = ROUTER_SRC.match(/^\s*update:\s*protectedProcedure[\s\S]*?\n\s*\}\),\n/m);
    expect(block).not.toBeNull();
    // The UPDATE statement must include userId in its WHERE clause.
    expect(block![0]).toMatch(
      /\.update\(destinations\)[\s\S]*?\.where\(\s*and\(\s*eq\(destinations\.id,\s*input\.id\)\s*,\s*eq\(destinations\.userId,\s*ctx\.user\.id\)/,
    );
    // Negative: no bare-id UPDATE — would let any logged-in user touch
    // another tenant's destination row.
    expect(block![0]).not.toMatch(
      /\.update\(destinations\)[\s\S]*?\.where\(\s*eq\(destinations\.id,\s*input\.id\)\s*\)/,
    );
  });

  it("`updateFromTemplate` SELECT is scoped to (id AND userId)", () => {
    const block = ROUTER_SRC.match(
      /^\s*updateFromTemplate:\s*protectedProcedure[\s\S]*?\n\s*\}\),\n/m,
    );
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(
      /\.from\(destinations\)[\s\S]*?\.where\(\s*and\(\s*eq\(destinations\.id,\s*input\.id\)\s*,\s*eq\(destinations\.userId,\s*ctx\.user\.id\)/,
    );
  });

  it("`updateFromTemplate` UPDATE WHERE is scoped to (id AND userId)", () => {
    const block = ROUTER_SRC.match(
      /^\s*updateFromTemplate:\s*protectedProcedure[\s\S]*?\n\s*\}\),\n/m,
    );
    expect(block).not.toBeNull();
    // Two paths through this procedure — the simple branch (no connection
    // sync) and the transaction branch. Both must scope by userId. We
    // assert presence of at least one ownership-scoped UPDATE; the
    // negative below catches the "bare-id UPDATE" anti-pattern in either.
    expect(block![0]).toMatch(
      /\.update\(destinations\)[\s\S]*?\.where\(\s*and\(\s*eq\(destinations\.id,\s*input\.id\)\s*,\s*eq\(destinations\.userId,\s*ctx\.user\.id\)/,
    );
    expect(block![0]).not.toMatch(
      /\.update\(destinations\)[\s\S]*?\.where\(\s*eq\(destinations\.id,\s*input\.id\)\s*\)/,
    );
  });

  it("`updateFromTemplate` linked-connection branch verifies connection ownership too", () => {
    const block = ROUTER_SRC.match(
      /^\s*updateFromTemplate:\s*protectedProcedure[\s\S]*?\n\s*\}\),\n/m,
    );
    expect(block).not.toBeNull();
    // The secret-mirror path looks up the linked connection — that lookup
    // must also be tenant-scoped, otherwise a cross-tenant connectionId
    // smuggled onto a destination row would let a user write into another
    // tenant's connection secrets.
    expect(block![0]).toMatch(
      /from\(connections\)[\s\S]*?eq\(connections\.userId,\s*ctx\.user\.id\)/,
    );
  });
});
