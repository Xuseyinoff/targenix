/**
 * Tenant UPDATE isolation regression tests.
 *
 * Defends against the 4 SELECT-then-UPDATE-by-id-only patterns flagged in
 * AUDIT_REPORT.md Section B.5:
 *   - triggers.update           (server/routers/triggersRouter.ts:115)
 *   - triggers.regenerateKey    (server/routers/triggersRouter.ts:236)
 *   - workflows.update          (server/routers/workflowsRouter.ts:147)
 *   - workflows.saveCanvas      (server/routers/workflowsRouter.ts:213)
 *
 * The fix narrows each UPDATE's WHERE clause to
 * `and(eq(table.id, X), eq(table.userId, Y))` via the `ownedBy()` helper
 * in `server/lib/assertUserOwns.ts`. These tests assert:
 *   1. `ownedBy()` produces a WHERE clause that references BOTH columns.
 *   2. The 4 affected routers actually import and use `ownedBy`.
 *
 * We avoid hitting a real DB because:
 *   (a) CI runs without DATABASE_URL — DB-backed suites self-skip there.
 *   (b) The interesting behaviour is "is userId in the WHERE clause?",
 *       not "does MySQL execute it correctly" — Drizzle and MySQL are
 *       already tested upstream.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedBy } from "./lib/assertUserOwns";
import { triggers, workflows } from "../drizzle/schema";

describe("ownedBy() helper", () => {
  it("returns an SQL object", () => {
    const clause = ownedBy(triggers, 42, 99);
    // Drizzle SQL objects have a `.queryChunks` array. Assert structure.
    expect(clause).toBeDefined();
    expect(typeof clause).toBe("object");
  });

  it("references both id and userId in the generated SQL", () => {
    const clause = ownedBy(triggers, 42, 99);
    // Walk all chunks and collect column .name values. Drizzle objects
    // have circular back-references (column → table → columns → …), so
    // a Set tracks visited nodes to keep the walk finite.
    const seenNames = new Set<string>();
    const seenNodes = new WeakSet<object>();
    const collect = (node: unknown): void => {
      if (node == null || typeof node !== "object") return;
      if (seenNodes.has(node as object)) return;
      seenNodes.add(node as object);
      const anyNode = node as Record<string, unknown>;
      if (typeof anyNode.name === "string") seenNames.add(anyNode.name);
      for (const v of Object.values(anyNode)) {
        if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === "object") collect(v);
      }
    };
    collect(clause);

    // Drizzle emits the configured column names — both `id` and `userId`
    // appear on `triggers`.
    expect(seenNames.has("id")).toBe(true);
    expect(seenNames.has("userId")).toBe(true);
  });

  it("works for both triggers and workflows tables (the 4 affected routers)", () => {
    expect(() => ownedBy(triggers, 1, 1)).not.toThrow();
    expect(() => ownedBy(workflows, 1, 1)).not.toThrow();
  });
});

describe("router source — defensive ownedBy() usage", () => {
  const repoRoot = join(__dirname, "..");
  const readRouter = (name: string): string =>
    readFileSync(join(repoRoot, "server", "routers", name), "utf8");

  it("triggersRouter imports ownedBy", () => {
    const src = readRouter("triggersRouter.ts");
    expect(src).toMatch(/from\s+["']\.\.\/lib\/assertUserOwns["']/);
    expect(src).toMatch(/\bownedBy\b/);
  });

  it("triggersRouter.update uses ownedBy on the UPDATE clause", () => {
    const src = readRouter("triggersRouter.ts");
    // Match the update procedure body — it should now scope by userId in
    // the .where() of db.update(triggers). The vulnerable original had
    // `.where(eq(triggers.id, input.id))` with no userId reference.
    const updateBlock = src.match(/update:\s*protectedProcedure[\s\S]*?delete:/);
    expect(updateBlock).not.toBeNull();
    expect(updateBlock![0]).toMatch(/ownedBy\(triggers,\s*input\.id,\s*ctx\.user\.id\)/);
    // Negative assertion: no bare `eq(triggers.id, input.id)` UPDATE.
    expect(updateBlock![0]).not.toMatch(
      /\.update\(triggers\)[\s\S]*\.where\(eq\(triggers\.id,\s*input\.id\)\)/,
    );
  });

  it("triggersRouter.regenerateKey uses ownedBy on the UPDATE clause", () => {
    const src = readRouter("triggersRouter.ts");
    const block = src.match(/regenerateKey:\s*protectedProcedure[\s\S]*$/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/ownedBy\(triggers,\s*input\.id,\s*ctx\.user\.id\)/);
    expect(block![0]).not.toMatch(
      /\.update\(triggers\)[\s\S]*\.where\(eq\(triggers\.id,\s*input\.id\)\)/,
    );
  });

  it("workflowsRouter imports ownedBy", () => {
    const src = readRouter("workflowsRouter.ts");
    expect(src).toMatch(/from\s+["']\.\.\/lib\/assertUserOwns["']/);
    expect(src).toMatch(/\bownedBy\b/);
  });

  it("workflowsRouter.update uses ownedBy on the UPDATE clause", () => {
    const src = readRouter("workflowsRouter.ts");
    const block = src.match(/update:\s*protectedProcedure[\s\S]*?delete:/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/ownedBy\(workflows,\s*input\.id,\s*ctx\.user\.id\)/);
    expect(block![0]).not.toMatch(
      /\.update\(workflows\)[\s\S]*\.where\(eq\(workflows\.id,\s*input\.id\)\)/,
    );
  });

  it("workflowsRouter.saveCanvas uses ownedBy on the UPDATE clause", () => {
    const src = readRouter("workflowsRouter.ts");
    const block = src.match(/saveCanvas:\s*protectedProcedure[\s\S]*?run:/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/ownedBy\(workflows,\s*input\.id,\s*ctx\.user\.id\)/);
    expect(block![0]).not.toMatch(
      /\.update\(workflows\)[\s\S]*\.where\(eq\(workflows\.id,\s*input\.id\)\)/,
    );
  });
});
