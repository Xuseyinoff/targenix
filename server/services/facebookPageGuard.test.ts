/**
 * facebookPageGuard — unit tests for the multi-tenant safety helpers.
 *
 * These tests stub the Drizzle `DbClient` shape so we never touch a real
 * database. The focus is on the boundary conditions that decide whether a
 * destructive `DELETE /{page-id}/subscribed_apps` call is safe to make.
 */
import { describe, expect, it, vi } from "vitest";
import {
  countOtherActiveTenantsOnPage,
  isPageSharedWithOtherTenants,
} from "./facebookPageGuard";
import type { DbClient } from "../db";

function makeDb(countResult: number) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ c: countResult }])),
      })),
    })),
  } as unknown as DbClient;
}

describe("facebookPageGuard.countOtherActiveTenantsOnPage", () => {
  it("returns 0 when no other tenant is active on the page", async () => {
    const db = makeDb(0);
    const n = await countOtherActiveTenantsOnPage(db, "page-1", 42);
    expect(n).toBe(0);
  });

  it("returns the number of other active tenants", async () => {
    const db = makeDb(2);
    const n = await countOtherActiveTenantsOnPage(db, "page-1", 42);
    expect(n).toBe(2);
  });

  it("coerces undefined DB responses to 0 safely", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([])),
        })),
      })),
    } as unknown as DbClient;
    const n = await countOtherActiveTenantsOnPage(db, "page-1", 42);
    expect(n).toBe(0);
  });
});

describe("facebookPageGuard.isPageSharedWithOtherTenants", () => {
  it("is false when count is 0", async () => {
    const db = makeDb(0);
    await expect(isPageSharedWithOtherTenants(db, "page-1", 1)).resolves.toBe(false);
  });

  it("is true when count is positive", async () => {
    const db = makeDb(3);
    await expect(isPageSharedWithOtherTenants(db, "page-1", 1)).resolves.toBe(true);
  });
});
