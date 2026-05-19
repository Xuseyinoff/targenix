/**
 * Source-grep contract tests for the appKey-on-insert fix.
 *
 * Pins the two insert functions and their callers so a future refactor
 * cannot silently re-introduce the original bug (where 42 of 59 prod
 * connections ended up with appKey=NULL because nothing wrote the column
 * on the insert path).
 *
 * CRLF-tolerant: every read strips "\r" before regex tests so the suite
 * passes on Windows checkouts where core.autocrlf=true flips line endings
 * (per saved memory rule [[feedback-crlf-on-windows]]).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSource(relPath: string): string {
  const abs = resolve(__dirname, "..", "..", relPath);
  return readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
}

describe("connectionService — input interfaces declare appKey", () => {
  const src = readSource("server/services/connectionService.ts");

  it("InsertApiKeyConnectionInput has appKey: string | null", () => {
    const block = src.match(/interface InsertApiKeyConnectionInput\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    // Match the actual declaration anywhere inside the interface body.
    expect(block![0]).toMatch(/appKey:\s*string\s*\|\s*null/);
  });

  it("UpsertTelegramConnectionInput has appKey: string | null", () => {
    const block = src.match(/interface UpsertTelegramConnectionInput\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/appKey:\s*string\s*\|\s*null/);
  });
});

describe("connectionService — insert function bodies write appKey", () => {
  const src = readSource("server/services/connectionService.ts");

  it("insertApiKeyConnection's .values() reads input.appKey", () => {
    // Anchor on the function body opener `): Promise<number> {` so the
    // regex doesn't stop at the parameter type's `}`. The body must
    // contain `appKey: input.appKey` in the .values() literal.
    const body = src.match(
      /export async function insertApiKeyConnection[\s\S]*?\): Promise<number> \{[\s\S]*?\n\}/,
    );
    expect(body).not.toBeNull();
    expect(body![0]).toMatch(/appKey:\s*input\.appKey/);
  });

  it("insertTelegramConnection's .values() reads input.appKey", () => {
    const body = src.match(
      /export async function insertTelegramConnection[\s\S]*?\): Promise<number> \{[\s\S]*?\n\}/,
    );
    expect(body).not.toBeNull();
    expect(body![0]).toMatch(/appKey:\s*input\.appKey/);
  });
});

describe("connectionsRouter — callers propagate appKey", () => {
  const src = readSource("server/routers/connectionsRouter.ts");

  it("insertApiKeyConnection caller passes appKey: tpl.appKey (the canonical source)", () => {
    // The caller has `tpl` (a destinationTemplates row) in scope from the
    // template fetch a few lines up. The pre-fix bug was that this caller
    // didn't propagate the value at all.
    expect(src).toMatch(
      /insertApiKeyConnection\(db,\s*\{[\s\S]*?appKey:\s*tpl\.appKey[\s\S]*?\}\)/,
    );
  });

  it("insertTelegramConnection caller passes appKey: 'telegram' (constant for the bot path)", () => {
    expect(src).toMatch(
      /insertTelegramConnection\(db,\s*\{[\s\S]*?appKey:\s*["']telegram["'][\s\S]*?\}\)/,
    );
  });
});

describe("destinationsRouter — stale import removed", () => {
  const src = readSource("server/routers/destinationsRouter.ts");

  it("does NOT import insertApiKeyConnection (zero call sites in this file)", () => {
    // Phase 1 grep confirmed zero usages. The import was dead weight.
    // If a future PR re-introduces it without a real call, this test
    // catches the regression.
    expect(src).not.toMatch(/import\s*\{[^}]*insertApiKeyConnection[^}]*\}\s*from\s*"\.\.\/services\/connectionService"/);
  });
});
