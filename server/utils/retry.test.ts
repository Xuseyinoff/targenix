import { describe, it, expect, vi } from "vitest";
import { withRetry } from "./retry";

describe("withRetry", () => {
  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withRetry(fn, 2)).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail1"))
      .mockResolvedValueOnce(7);
    await expect(withRetry(fn, 2)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
