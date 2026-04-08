import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import { verifyWebhookSignature } from "./services/facebookService";

const APP_SECRET = "test-app-secret-for-unit-tests";

function makeSignature(body: Buffer, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return "sha256=" + hmac.digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("returns true for a valid signature", () => {
    const body = Buffer.from(JSON.stringify({ object: "page", entry: [] }));
    const sig = makeSignature(body, APP_SECRET);
    expect(verifyWebhookSignature(body, sig, APP_SECRET)).toBe(true);
  });

  it("returns false for a tampered body", () => {
    const body = Buffer.from(JSON.stringify({ object: "page", entry: [] }));
    const sig = makeSignature(body, APP_SECRET);
    const tamperedBody = Buffer.from(JSON.stringify({ object: "page", entry: [{ id: "evil" }] }));
    expect(verifyWebhookSignature(tamperedBody, sig, APP_SECRET)).toBe(false);
  });

  it("returns false when signature header is missing", () => {
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature(body, undefined, APP_SECRET)).toBe(false);
  });

  it("returns false for wrong secret", () => {
    const body = Buffer.from("{}");
    const sig = makeSignature(body, "wrong-secret");
    expect(verifyWebhookSignature(body, sig, APP_SECRET)).toBe(false);
  });

  it("returns false for malformed signature header", () => {
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature(body, "md5=abc123", APP_SECRET)).toBe(false);
  });
});
