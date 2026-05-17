/**
 * Duplicate-prevention contract tests.
 *
 * What's covered here:
 *   - DuplicateIntegrationError class shape (code, fields, message)
 *   - integrationsRouter.create translates DuplicateIntegrationError →
 *     TRPCError CONFLICT with a friendly, name-referencing message
 *   - integrationsRouter.create lets other errors propagate unchanged
 *
 * What's covered elsewhere:
 *   - The SQL functional UNIQUE index actually rejects races at the DB layer
 *     → tooling/verify-0092-functional-index.mjs (run against prod; rolls
 *     back via a transaction so no data is left behind)
 *   - The pre-check SELECT short-circuits before INSERT
 *     → exercised by the same verify script (no insert call to mock)
 *
 * Why not pure unit-test the createIntegration pre-check itself: vi.mock of
 * "../db" can replace the EXPORTED `getDb` for callers, but it can't
 * intercept the same-module reference inside `createIntegration` (which
 * resolves `getDb` against the module-internal binding, not the mock). We
 * could refactor createIntegration to accept a DbClient parameter, but
 * that's out of scope for PR 1/4 (would touch every caller). The prod
 * verify-script gives stronger end-to-end coverage than a brittle mock.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return {
    ...actual,
    getDb: vi.fn(),
    createIntegration: vi.fn(),
  };
});

import { createIntegration, DuplicateIntegrationError } from "../db";
import { integrationsRouter } from "./integrationsRouter";
import type { TrpcContext } from "../_core/context";

function userCaller(userId = 100) {
  const ctx = {
    req: null,
    res: null,
    user: {
      id: userId,
      name: "Test User",
      email: "u@test.com",
      role: "user",
      password: null,
      facebookId: null,
      googleId: null,
      createdAt: new Date(),
    },
  } as unknown as TrpcContext;
  return integrationsRouter.createCaller(ctx);
}

// ─── DuplicateIntegrationError shape ─────────────────────────────────────────

describe("DuplicateIntegrationError", () => {
  it("1. carries the discriminating code 'DUPLICATE_INTEGRATION'", () => {
    const err = new DuplicateIntegrationError({
      userId: 1,
      formId: "f",
      destinationId: 2,
      existingId: 3,
      existingName: "n",
    });
    expect(err.code).toBe("DUPLICATE_INTEGRATION");
  });

  it("2. exposes user/form/destination/existing context for router translation", () => {
    const err = new DuplicateIntegrationError({
      userId: 100,
      formId: "form-abc",
      destinationId: 50,
      existingId: 999,
      existingName: "existing-integration",
    });
    expect(err.userId).toBe(100);
    expect(err.formId).toBe("form-abc");
    expect(err.destinationId).toBe(50);
    expect(err.existingId).toBe(999);
    expect(err.existingName).toBe("existing-integration");
  });

  it("3. message includes the existing id (useful in logs)", () => {
    const err = new DuplicateIntegrationError({
      userId: 1,
      formId: "f",
      destinationId: 2,
      existingId: 7777,
      existingName: "n",
    });
    expect(err.message).toContain("7777");
  });

  it("4. is an Error subclass (instanceof checks work)", () => {
    const err = new DuplicateIntegrationError({
      userId: 1,
      formId: "f",
      destinationId: 2,
      existingId: 3,
      existingName: "n",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DuplicateIntegrationError);
  });
});

// ─── integrationsRouter.create — DuplicateIntegrationError → CONFLICT ───────

describe("integrationsRouter.create — error translation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("5. DuplicateIntegrationError → TRPCError CONFLICT with friendly message", async () => {
    vi.mocked(createIntegration).mockRejectedValueOnce(
      new DuplicateIntegrationError({
        userId: 100,
        formId: "form-1",
        destinationId: 50,
        existingId: 600174,
        existingName: "shlang 64k/30k",
      }),
    );

    await expect(
      userCaller().create({
        type: "LEAD_ROUTING",
        name: "another-shlang",
        config: { ad: "x" },
        pageId: "page-1",
        formId: "form-1",
        destinationId: 50,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("shlang 64k/30k"),
    });
  });

  it("6. CONFLICT message references the existing integration id", async () => {
    vi.mocked(createIntegration).mockRejectedValueOnce(
      new DuplicateIntegrationError({
        userId: 100,
        formId: "form-1",
        destinationId: 50,
        existingId: 600174,
        existingName: "shlang 64k/30k",
      }),
    );

    await expect(
      userCaller().create({
        type: "LEAD_ROUTING",
        name: "dupe-attempt",
        config: {},
        pageId: "page-1",
        formId: "form-1",
        destinationId: 50,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("600174"),
    });
  });

  it("7. happy path: when createIntegration resolves, returns { success: true }", async () => {
    vi.mocked(createIntegration).mockResolvedValueOnce(undefined);

    const result = await userCaller().create({
      type: "LEAD_ROUTING",
      name: "first-integration",
      config: {},
      pageId: "page-1",
      formId: "form-1",
      destinationId: 50,
    });
    expect(result).toEqual({ success: true });
  });

  it("8. non-DuplicateIntegrationError errors propagate (NOT translated to CONFLICT)", async () => {
    // tRPC wraps unknown throws as INTERNAL_SERVER_ERROR with the original
    // attached as `.cause`. The router must NOT downgrade these to CONFLICT.
    vi.mocked(createIntegration).mockRejectedValueOnce(new Error("DB on fire"));

    await expect(
      userCaller().create({
        type: "LEAD_ROUTING",
        name: "x",
        config: {},
        pageId: "page-1",
        formId: "form-1",
        destinationId: 50,
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB on fire",
    });
  });
});
