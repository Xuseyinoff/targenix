import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetLoadersForTests,
  getLoader,
  listLoaderKeys,
  registerLoader,
} from "./registry";
import type { LoadOptionsContext, LoadOptionsResult } from "./types";

const stub = async (_ctx: LoadOptionsContext): Promise<LoadOptionsResult> => ({
  options: [],
});

beforeEach(() => {
  __resetLoadersForTests();
});

describe("loader registry", () => {
  it("registerLoader + getLoader round-trip a single loader", () => {
    registerLoader("x.one", stub);
    expect(getLoader("x.one")).toBe(stub);
  });

  it("getLoader returns null for unknown keys", () => {
    expect(getLoader("missing")).toBeNull();
  });

  it("listLoaderKeys returns every registered key, sorted", () => {
    registerLoader("b", stub);
    registerLoader("a", stub);
    registerLoader("c", stub);
    expect(listLoaderKeys()).toEqual(["a", "b", "c"]);
  });

  it("last-write-wins on duplicate registration", () => {
    const first = async () => ({ options: [{ value: "1", label: "1" }] });
    const second = async () => ({ options: [{ value: "2", label: "2" }] });
    registerLoader("dup", first);
    registerLoader("dup", second);
    expect(getLoader("dup")).toBe(second);
  });

  it("built-in Google Sheets loaders register when the barrel is imported", async () => {
    __resetLoadersForTests();
    await import("./register");
    const keys = listLoaderKeys();
    expect(keys).toContain("google-sheets.listSpreadsheets");
    expect(keys).toContain("google-sheets.listSheetTabs");
    expect(keys).toContain("google-sheets.getSheetHeaders");
  });
});
