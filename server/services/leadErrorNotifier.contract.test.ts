/**
 * Source-grep contract tests for the failed-leads sprint wiring.
 *
 * These tests guard against silent regressions where someone removes a key
 * line and the runtime behaviour quietly drifts. They are intentionally
 * coarse — exact phrasing changes are fine, but the SHAPE of the code must
 * survive.
 *
 * CRLF-tolerant: tests read source files and strip "\r" before regex tests
 * so they pass on Windows checkouts where `core.autocrlf=true` flips line
 * endings (see saved memory rule [[feedback-crlf-on-windows]]).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSource(relPath: string): string {
  const abs = resolve(__dirname, "..", "..", relPath);
  return readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
}

describe("processLead — integration-presence check is hoisted", () => {
  const src = readSource("server/services/leadService.ts");

  it("imports the notifier helpers", () => {
    expect(src).toMatch(/import\s+\{[^}]*sendLeadErrorTelegramNotification[^}]*\}\s+from\s+"\.\/leadErrorNotifier"/);
    expect(src).toMatch(/import\s+\{[^}]*clearLeadErrorNotifyCooldown[^}]*\}\s+from\s+"\.\/leadErrorNotifier"/);
  });

  it("computes hasIntegration BEFORE calling resolvePageAccessToken", () => {
    // Locate the two anchors and require hasIntegration to appear first.
    const hasIntegrationIdx = src.indexOf("const hasIntegration");
    const resolveTokenIdx = src.indexOf("resolvePageAccessToken(params.pageId");
    expect(hasIntegrationIdx).toBeGreaterThan(0);
    expect(resolveTokenIdx).toBeGreaterThan(0);
    expect(hasIntegrationIdx).toBeLessThan(resolveTokenIdx);
  });

  it("integration check is scoped to active LEAD_ROUTING for (userId, pageId, formId)", () => {
    // The active-integration query must filter on all four — anything looser
    // would notify the wrong user or for the wrong form.
    const match = src.match(/const hasIntegrationRows[\s\S]*?\.limit\(1\);/);
    expect(match).not.toBeNull();
    const block = match![0];
    expect(block).toMatch(/integrations\.userId,\s*params\.userId/);
    expect(block).toMatch(/integrations\.isActive,\s*true/);
    expect(block).toMatch(/integrations\.type,\s*"LEAD_ROUTING"/);
    expect(block).toMatch(/integrations\.pageId,\s*params\.pageId/);
    expect(block).toMatch(/integrations\.formId,\s*params\.formId/);
  });
});

describe("persistGraphFailure — notifier wiring", () => {
  const src = readSource("server/services/leadService.ts");

  it("calls sendLeadErrorTelegramNotification only when hasIntegration is true", () => {
    // Find the persistGraphFailure function body and assert the gating shape.
    // Anchor on the body opener `): Promise<void> {` so we don't stop at the
    // parameter type's `}`. Close on `\n  }\n` — a 2-space-indented brace
    // followed by a newline (the function body's outer closing brace).
    const match = src.match(/async function persistGraphFailure[\s\S]*?\): Promise<void> \{[\s\S]*?\n  \}\n/);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toMatch(/if\s*\(hasIntegration\)\s*\{/);
    expect(body).toMatch(/sendLeadErrorTelegramNotification\(/);
  });

  it("treats the notifier as fire-and-forget (void + .catch)", () => {
    // Anchor on the body opener `): Promise<void> {` so we don't stop at the
    // parameter type's `}`. Close on `\n  }\n` — a 2-space-indented brace
    // followed by a newline (the function body's outer closing brace).
    const match = src.match(/async function persistGraphFailure[\s\S]*?\): Promise<void> \{[\s\S]*?\n  \}\n/);
    expect(match).not.toBeNull();
    const body = match![0];
    // A Telegram outage must not block lead persistence — the call must be
    // unawaited and the rejection must be caught.
    expect(body).toMatch(/void sendLeadErrorTelegramNotification\(/);
    expect(body).toMatch(/\.catch\(\(err\)/);
  });

  it("passes isFinalExhaustion computed from LEAD_MAX_GRAPH_ATTEMPTS", () => {
    // Anchor on the body opener `): Promise<void> {` so we don't stop at the
    // parameter type's `}`. Close on `\n  }\n` — a 2-space-indented brace
    // followed by a newline (the function body's outer closing brace).
    const match = src.match(/async function persistGraphFailure[\s\S]*?\): Promise<void> \{[\s\S]*?\n  \}\n/);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toMatch(/isFinalExhaustion\s*=\s*newAttempts\s*>=\s*LEAD_MAX_GRAPH_ATTEMPTS/);
    expect(body).toMatch(/isFinalExhaustion[\s,]/);
  });
});

describe("processLead — Redis cooldown cleared on success", () => {
  const src = readSource("server/services/leadService.ts");

  it("calls clearLeadErrorNotifyCooldown on the success branch", () => {
    expect(src).toMatch(/void clearLeadErrorNotifyCooldown\(params\.userId\)/);
  });

  it("cleanup runs after fetchLeadData succeeds, before the lead UPDATE", () => {
    const clearIdx = src.indexOf("clearLeadErrorNotifyCooldown(params.userId)");
    const fetchOkIdx = src.indexOf("if (!fetchResult.ok)");
    expect(clearIdx).toBeGreaterThan(0);
    expect(fetchOkIdx).toBeGreaterThan(0);
    // Cleanup happens AFTER the !ok early-return branch.
    expect(clearIdx).toBeGreaterThan(fetchOkIdx);
  });
});

describe("visibility filter — getLeads / getLeadsCount / getLeadStats", () => {
  const src = readSource("server/db.ts");

  it("all 5 EXISTS(orders) clauses are wrapped in an OR with the Graph-error branch", () => {
    // Count occurrences of the orders EXISTS clause and the matching
    // integrations EXISTS clause. They must be 1:1 — every visibility check
    // must surface failed leads on configured forms.
    const ordersCount = (src.match(/EXISTS \(SELECT 1 FROM \$\{orders\}/g) ?? []).length;
    const integrationsCount = (src.match(/EXISTS \(SELECT 1 FROM \$\{integrations\}/g) ?? []).length;
    expect(ordersCount).toBe(5);
    expect(integrationsCount).toBe(5);
  });

  it("each OR branch checks integrations.isActive AND type='LEAD_ROUTING' AND matching pageId+formId", () => {
    // The new visibility clause must be exactly scoped — otherwise a user
    // would see error rows for forms they never wired up.
    const matches = src.match(
      /EXISTS \(SELECT 1 FROM \$\{integrations\}[\s\S]*?\$\{integrations\.formId\}\s*=\s*\$\{leads\.formId\}\)/g,
    );
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(5);
    for (const m of matches!) {
      expect(m).toContain("isActive");
      expect(m).toContain("LEAD_ROUTING");
      expect(m).toContain("${integrations.pageId} = ${leads.pageId}");
    }
  });
});

describe("notifier targets the system chat, not a destination's delivery chat", () => {
  const src = readSource("server/services/leadErrorNotifier.ts");

  it("queries users.telegramChatId", () => {
    expect(src).toMatch(/telegramChatId:\s*users\.telegramChatId/);
  });

  it("does NOT reference destination / integration telegramChatId", () => {
    // Delivery chats are for successful handoff messages; error alerts go
    // to the user's personal system chat only.
    expect(src).not.toMatch(/destinations?\.telegramChatId/);
    expect(src).not.toMatch(/integration\.telegramChatId/);
  });
});
