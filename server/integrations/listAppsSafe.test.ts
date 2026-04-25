import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSpecSafe } from "./listAppsSafe";
import type { AppRow } from "../../drizzle/schema";
import type { DbClient } from "../db";

function makeDbForResolveSpec(
  limitResult: unknown[] | Promise<unknown[]> | (() => Promise<unknown[]>),
): DbClient {
  const limitFn =
    typeof limitResult === "function"
      ? vi.fn(limitResult as () => Promise<unknown[]>)
      : vi.fn(() => Promise.resolve(limitResult));

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: limitFn,
        })),
      })),
    })),
  };
  return db as unknown as DbClient;
}

function appRow(partial: Partial<AppRow> & Pick<AppRow, "appKey" | "displayName">): AppRow {
  return {
    id: partial.id ?? 1,
    appKey: partial.appKey,
    displayName: partial.displayName,
    category: partial.category ?? "affiliate",
    authType: partial.authType ?? "api_key",
    fields: partial.fields ?? [
      { key: "api_key", label: "API Key", required: true, sensitive: true },
    ],
    oauthConfig: partial.oauthConfig ?? null,
    iconUrl: partial.iconUrl ?? null,
    docsUrl: partial.docsUrl ?? null,
    isActive: partial.isActive ?? true,
    createdAt: partial.createdAt ?? new Date("2025-01-01"),
  };
}

describe("resolveSpecSafe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.STAGE2_SPEC_LOG;
  });

  it("uses DB when an active apps row exists", async () => {
    const row = appRow({
      appKey: "__db_only_resolve_spec__",
      displayName: "Resolved From DB",
      fields: [{ key: "token", label: "Token", required: true, sensitive: true }],
    });
    const db = makeDbForResolveSpec([row]);

    const spec = await resolveSpecSafe(db, "__db_only_resolve_spec__");

    expect(spec).not.toBeNull();
    expect(spec?.displayName).toBe("Resolved From DB");
    expect(spec?.fields[0]?.key).toBe("token");
    expect(db.select).toHaveBeenCalled();
  });

  it("returns null when DB has no row for the appKey", async () => {
    const db = makeDbForResolveSpec([]);

    const spec = await resolveSpecSafe(db, "sotuvchi");

    expect(spec).toBeNull();
  });

  it("returns null when key is missing in DB and TS", async () => {
    const db = makeDbForResolveSpec([]);

    const spec = await resolveSpecSafe(db, "__no_such_app_key__");

    expect(spec).toBeNull();
  });

  it("returns null when DB query throws", async () => {
    const db = makeDbForResolveSpec(() => Promise.reject(new Error("connection reset")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const spec = await resolveSpecSafe(db, "sotuvchi");

    expect(spec).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("returns null when db is null", async () => {
    const spec = await resolveSpecSafe(null, "mgoods");

    expect(spec).toBeNull();
  });

  it("logs spec source when STAGE2_SPEC_LOG=1", async () => {
    process.env.STAGE2_SPEC_LOG = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const db = makeDbForResolveSpec([
      appRow({ appKey: "100k", displayName: "100k from DB marker" }),
    ]);

    await resolveSpecSafe(db, "100k");

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "spec_resolution",
        source: "DB",
        appKey: "100k",
      }),
    );
  });
});
