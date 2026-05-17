/**
 * SSRF guard regression tests.
 *
 * Covers:
 *   (1) `lib/urlSafety.assertSafeOutboundUrl` rejects the patterns that
 *       inline guards historically missed — DNS rebinding via decimal/hex
 *       IPs, IPv6 loopback, link-local, and non-HTTPS schemes.
 *   (2) Source-level guards confirming the 3 outbound paths flagged in
 *       AUDIT_REPORT.md Section D.6 route through the canonical helper:
 *         - affiliateService.ts  (template.endpointUrl)
 *         - workflowExecutor.ts  (workflow http_request step URL)
 *         - httpRequestAdapter.ts (destination http-request adapter URL)
 *   (3) appLogger.redactSecrets() never leaks values under secret-shaped
 *       keys, regardless of nesting / arrays / cycles.
 *
 * We avoid hitting the network — tests only use IP literals (which
 * short-circuit before DNS lookup) and `localhost` (which is rejected
 * by hostname check before DNS).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeOutboundUrl } from "../lib/urlSafety";
import { redactSecrets } from "./appLogger";

const repoRoot = join(__dirname, "..", "..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

describe("urlSafety.assertSafeOutboundUrl — rejection cases", () => {
  // Each rejects synchronously (before DNS) — safe in any environment.
  it.each([
    ["http://example.com/x", "must use HTTPS"],
    ["ftp://example.com/x", "must use HTTPS"],
    ["gopher://example.com/x", "must use HTTPS"],
    ["file:///etc/passwd", "must use HTTPS"],
    ["https://localhost/x", "must not target localhost"],
    ["https://localhost.localdomain/", "must not target localhost"],
    ["https://[::1]/x", "IPv6 bracket"],
    // Numeric IP forms — Node's WHATWG URL parser normalises these to
    // 127.0.0.1 before urlSafety sees the hostname, so the private-IP
    // branch catches them rather than the explicit numeric-form regex.
    // Either way the URL is rejected, which is what matters.
    ["https://2130706433/", "internal or private"], // 127.0.0.1 in decimal
    ["https://0x7f000001/", "internal or private"], // 127.0.0.1 in hex
    ["https://017700000001/", "internal or private"], // 127.0.0.1 in octal
    ["https://127.0.0.1/x", "internal or private"],
    ["https://10.0.0.1/x", "internal or private"],
    ["https://172.16.0.1/x", "internal or private"],
    ["https://192.168.1.1/x", "internal or private"],
    ["https://169.254.169.254/latest/meta-data/", "internal or private"], // AWS metadata
    ["https://0.0.0.0/x", "internal or private"],
    ["not a url", "Invalid URL"],
  ])("rejects %s", async (url, expectedMessage) => {
    await expect(assertSafeOutboundUrl(url)).rejects.toThrow(expectedMessage);
  });
});

describe("urlSafety.assertSafeOutboundUrl — accepts safe public IPv4", () => {
  // Direct public IP — short-circuits before DNS (line 81-85 of urlSafety.ts).
  // Avoids hostname-DNS lookups that could be flaky in CI.
  it("accepts a public IPv4 address over HTTPS", async () => {
    await expect(assertSafeOutboundUrl("https://1.1.1.1/")).resolves.toBeUndefined();
    await expect(assertSafeOutboundUrl("https://8.8.8.8/")).resolves.toBeUndefined();
  });
});

describe("source — outbound paths route through assertSafeOutboundUrl", () => {
  it("affiliateService.ts: sendLeadViaAffiliate guards URL before axios", () => {
    const src = read("server/services/affiliateService.ts");
    expect(src).toMatch(/from\s+["']\.\.\/lib\/urlSafety["']/);
    // At least two outbound calls in this file (legacy + dynamic-template).
    // Each must be preceded by an assertSafeOutboundUrl in the same function.
    const callCount = (src.match(/await\s+assertSafeOutboundUrl\(/g) ?? []).length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("workflowExecutor.ts: http_request step uses canonical guard (not inline regex)", () => {
    const src = read("server/services/workflowExecutor.ts");
    expect(src).toMatch(/from\s+["']\.\.\/lib\/urlSafety["']/);
    expect(src).toMatch(/await\s+assertSafeOutboundUrl\(url\)/);
    // The deleted local guard MUST be gone — its presence would mean the
    // refactor regressed.
    expect(src).not.toMatch(/\bisSafeUrl\b/);
    expect(src).not.toMatch(/\bBLOCKED_HOSTS\b/);
  });

  it("httpRequestAdapter.ts: routes finalUrl through assertSafeOutboundUrl", () => {
    const src = read("server/integrations/adapters/httpRequestAdapter.ts");
    expect(src).toMatch(/from\s+["']\.\.\/\.\.\/lib\/urlSafety["']/);
    expect(src).toMatch(/await\s+assertSafeOutboundUrl\(finalUrl\)/);
  });
});

describe("appLogger.redactSecrets — defense in depth", () => {
  it("returns primitives unchanged", () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
  });

  it("redacts secret-shaped keys at any nesting depth", () => {
    const input = {
      userId: 42,
      password: "p@ss",
      currentPassword: "p@ss",
      apiKey: "sk-abc",
      api_key: "sk-abc",
      accessToken: "tok",
      access_token: "tok",
      refreshToken: "rt",
      authorization: "Bearer x",
      cookie: "session=abc",
      bearer: "x",
      clientSecret: "cs",
      client_secret: "cs",
      nested: {
        userId: 99,
        secret: "deep",
        ok: "fine",
      },
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.userId).toBe(42);
    expect(out.password).toBe("[REDACTED]");
    expect(out.currentPassword).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.accessToken).toBe("[REDACTED]");
    expect(out.access_token).toBe("[REDACTED]");
    expect(out.refreshToken).toBe("[REDACTED]");
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.cookie).toBe("[REDACTED]");
    expect(out.bearer).toBe("[REDACTED]");
    expect(out.clientSecret).toBe("[REDACTED]");
    expect(out.client_secret).toBe("[REDACTED]");
    const nested = out.nested as Record<string, unknown>;
    expect(nested.userId).toBe(99);
    expect(nested.secret).toBe("[REDACTED]");
    expect(nested.ok).toBe("fine");
  });

  it("redacts even when the value is an object (does NOT walk into a secret-keyed branch)", () => {
    const input = { secrets: { aws: "akia...", gcp: "..." } };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.secrets).toBe("[REDACTED]");
  });

  it("preserves arrays and redacts inside them", () => {
    const input = {
      headers: [
        { name: "X-Trace", value: "abc" },
        { name: "Authorization", value: "Bearer xyz" },
      ],
    };
    const out = redactSecrets(input) as { headers: Array<Record<string, unknown>> };
    expect(out.headers).toHaveLength(2);
    expect(out.headers[0].name).toBe("X-Trace");
    expect(out.headers[0].value).toBe("abc");
    expect(out.headers[1].name).toBe("Authorization");
    expect(out.headers[1].value).toBe("Bearer xyz");
    // NOTE: redaction is by KEY name, not value content — the
    // `Authorization` header above lives under `value`, which isn't a
    // secret-shaped key, so the value passes through. This matches the
    // documented policy: callers MUST put credentials under secret-named
    // keys (e.g. `{ authorization: "Bearer ..." }`) to get redaction.
  });

  it("handles cycles without infinite recursion", () => {
    const a: Record<string, unknown> = { name: "loop" };
    a.self = a;
    const out = redactSecrets(a) as Record<string, unknown>;
    expect(out.name).toBe("loop");
    expect(out.self).toBe("[CIRCULAR]");
  });

  it("does NOT mutate the original input", () => {
    const original = { password: "p@ss", ok: "fine" };
    const snapshot = JSON.stringify(original);
    redactSecrets(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
