import { describe, it, expect, beforeEach } from "vitest";
import { loaderCache } from "./cache";
import type { LoadOptionsResult } from "./types";

const RESULT: LoadOptionsResult = { options: [{ value: "x", label: "X" }] };

function seed(userId: number, loaderKey: string, connectionId: number | null) {
  loaderCache.set(userId, loaderKey, connectionId, {}, undefined, undefined, 50, RESULT);
}

beforeEach(() => {
  loaderCache.__clear();
});

describe("loaderCache", () => {
  it("get returns a stored entry, miss returns null", () => {
    seed(1, "google_sheets", 100);
    expect(loaderCache.get(1, "google_sheets", 100, {}, undefined, undefined, 50)).toEqual(RESULT);
    expect(loaderCache.get(1, "google_sheets", 999, {}, undefined, undefined, 50)).toBeNull();
  });

  it("invalidate(userId, loaderKey) clears only that user+loader", () => {
    seed(1, "google_sheets", 100);
    seed(1, "telegram_chats", 200);
    seed(2, "google_sheets", 100);
    loaderCache.invalidate(1, "google_sheets");
    expect(loaderCache.get(1, "google_sheets", 100, {}, undefined, undefined, 50)).toBeNull();
    // Other loader for the same user survives.
    expect(loaderCache.get(1, "telegram_chats", 200, {}, undefined, undefined, 50)).toEqual(RESULT);
    // Other tenant survives.
    expect(loaderCache.get(2, "google_sheets", 100, {}, undefined, undefined, 50)).toEqual(RESULT);
  });

  describe("invalidateByConnection — disconnect credential-leak guard", () => {
    it("clears every cached result tied to the given connectionId", () => {
      // Same connection, two different loaders → both must be dropped.
      seed(1, "google_sheets", 57);
      seed(1, "google_sheets_tabs", 57);
      // Same user, different connection → must survive.
      seed(1, "google_sheets", 58);

      loaderCache.invalidateByConnection(1, 57);

      expect(loaderCache.get(1, "google_sheets", 57, {}, undefined, undefined, 50)).toBeNull();
      expect(loaderCache.get(1, "google_sheets_tabs", 57, {}, undefined, undefined, 50)).toBeNull();
      expect(loaderCache.get(1, "google_sheets", 58, {}, undefined, undefined, 50)).toEqual(RESULT);
    });

    it("never touches another tenant's cache (connectionId collision across users)", () => {
      // connectionId values are globally unique in prod, but the guard must
      // still be userId-scoped as defence in depth.
      seed(1, "google_sheets", 57);
      seed(2, "google_sheets", 57);

      loaderCache.invalidateByConnection(1, 57);

      expect(loaderCache.get(1, "google_sheets", 57, {}, undefined, undefined, 50)).toBeNull();
      expect(loaderCache.get(2, "google_sheets", 57, {}, undefined, undefined, 50)).toEqual(RESULT);
    });

    it("does not match a connectionId that is a prefix of another (c5 vs c57)", () => {
      seed(1, "google_sheets", 5);
      seed(1, "google_sheets", 57);

      loaderCache.invalidateByConnection(1, 5);

      expect(loaderCache.get(1, "google_sheets", 5, {}, undefined, undefined, 50)).toBeNull();
      // c57 must NOT be caught by a naive `c5` substring match.
      expect(loaderCache.get(1, "google_sheets", 57, {}, undefined, undefined, 50)).toEqual(RESULT);
    });

    it("is a no-op when nothing references the connection", () => {
      seed(1, "google_sheets", 100);
      loaderCache.invalidateByConnection(1, 999);
      expect(loaderCache.get(1, "google_sheets", 100, {}, undefined, undefined, 50)).toEqual(RESULT);
    });
  });
});
