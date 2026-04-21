/**
 * Unit tests for the env-driven feature-flag helper (Commit 5a).
 *
 * We swap process.env around each test and bust the module cache so parsing
 * is exercised from scratch every time.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetFeatureFlagsCache,
  describeMultiDestinationFlag,
  isMultiDestinationsEnabled,
} from "./featureFlags";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.MULTI_DEST_ALL;
  delete process.env.MULTI_DEST_USER_IDS;
  __resetFeatureFlagsCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  __resetFeatureFlagsCache();
});

describe("isMultiDestinationsEnabled", () => {
  it("returns false when no env vars are set", () => {
    expect(isMultiDestinationsEnabled(1)).toBe(false);
    expect(isMultiDestinationsEnabled(99)).toBe(false);
  });

  it("returns true for any valid user id when MULTI_DEST_ALL is truthy", () => {
    for (const truthy of ["1", "true", "True", "YES", "on"]) {
      process.env.MULTI_DEST_ALL = truthy;
      __resetFeatureFlagsCache();
      expect(isMultiDestinationsEnabled(42)).toBe(true);
    }
  });

  it("treats non-truthy MULTI_DEST_ALL values as off", () => {
    for (const falsy of ["0", "false", "no", "", "  "]) {
      process.env.MULTI_DEST_ALL = falsy;
      __resetFeatureFlagsCache();
      expect(isMultiDestinationsEnabled(42)).toBe(false);
    }
  });

  it("only enables user ids listed in MULTI_DEST_USER_IDS", () => {
    process.env.MULTI_DEST_USER_IDS = "1, 2 ,  42";
    __resetFeatureFlagsCache();
    expect(isMultiDestinationsEnabled(1)).toBe(true);
    expect(isMultiDestinationsEnabled(2)).toBe(true);
    expect(isMultiDestinationsEnabled(42)).toBe(true);
    expect(isMultiDestinationsEnabled(3)).toBe(false);
    expect(isMultiDestinationsEnabled(100)).toBe(false);
  });

  it("returns false for null / undefined / non-positive / NaN user ids", () => {
    process.env.MULTI_DEST_ALL = "true";
    __resetFeatureFlagsCache();
    expect(isMultiDestinationsEnabled(null)).toBe(false);
    expect(isMultiDestinationsEnabled(undefined)).toBe(false);
    expect(isMultiDestinationsEnabled(0)).toBe(false);
    expect(isMultiDestinationsEnabled(-1)).toBe(false);
    expect(isMultiDestinationsEnabled(Number.NaN)).toBe(false);
  });

  it("silently ignores malformed entries (doesn't crash the process)", () => {
    process.env.MULTI_DEST_USER_IDS = "abc,,1.5,2,xyz,42";
    __resetFeatureFlagsCache();
    expect(isMultiDestinationsEnabled(2)).toBe(true);
    expect(isMultiDestinationsEnabled(42)).toBe(true);
    expect(isMultiDestinationsEnabled(1)).toBe(false);
  });

  it("MULTI_DEST_ALL beats the per-user allowlist", () => {
    process.env.MULTI_DEST_USER_IDS = "1";
    process.env.MULTI_DEST_ALL = "true";
    __resetFeatureFlagsCache();
    expect(isMultiDestinationsEnabled(2)).toBe(true);
  });
});

describe("describeMultiDestinationFlag", () => {
  it("reports parsed env state", () => {
    process.env.MULTI_DEST_USER_IDS = "5, 1, 3";
    process.env.MULTI_DEST_ALL = "false";
    __resetFeatureFlagsCache();
    expect(describeMultiDestinationFlag()).toEqual({
      globalOn: false,
      allowedUserIds: [1, 3, 5],
    });
  });
});
