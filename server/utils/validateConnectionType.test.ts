import { afterEach, describe, expect, it, vi } from "vitest";
import { validateConnectionType } from "./validateConnectionType";

describe("validateConnectionType", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TYPE_VALIDATION_LOG;
  });

  it('accepts "api_key"', () => {
    expect(validateConnectionType("api_key")).toBe("api_key");
  });

  it('accepts "oauth2"', () => {
    expect(validateConnectionType("oauth2")).toBe("oauth2");
  });

  it('accepts "telegram_bot"', () => {
    expect(validateConnectionType("telegram_bot")).toBe("telegram_bot");
  });

  it('accepts "custom_service" with warn only', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(validateConnectionType("custom_service")).toBe("custom_service");
    expect(warn).toHaveBeenCalledWith("Unknown connection type (allowed):", "custom_service");
  });

  it('rejects "INVALID!!!"', () => {
    expect(() => validateConnectionType("INVALID!!!")).toThrow("Invalid connection type");
  });

  it('rejects empty string', () => {
    expect(() => validateConnectionType("")).toThrow("Invalid connection type");
  });

  it("logs when TYPE_VALIDATION_LOG=1", () => {
    process.env.TYPE_VALIDATION_LOG = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    validateConnectionType("api_key");
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "type_validation",
        input: "api_key",
        result: "api_key",
      }),
    );
  });
});
