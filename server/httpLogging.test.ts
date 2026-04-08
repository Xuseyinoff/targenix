import { describe, expect, it } from "vitest";
import { summarizeRequestPayload } from "./_core/httpLogging";

describe("summarizeRequestPayload", () => {
  it("redacts object values and keeps only shape metadata", () => {
    const summary = summarizeRequestPayload({
      email: "user@example.com",
      password: "super-secret",
      token: "abc123",
    });

    expect(summary).toEqual({
      kind: "object",
      keyCount: 3,
      keys: ["email", "password", "token"],
      redacted: true,
    });
  });

  it("summarizes strings without leaking content", () => {
    const summary = summarizeRequestPayload("oauth-code-value");

    expect(summary).toEqual({
      kind: "string",
      length: "oauth-code-value".length,
      redacted: true,
    });
  });
});
