/**
 * formatLeadErrorMessage — golden-output tests for the three approved Uzbek
 * Telegram templates (Phase 1 design doc). The exact wording is intentional;
 * if a copy change is requested the test should fail and be updated by hand.
 */

import { describe, it, expect } from "vitest";

import { formatLeadErrorMessage } from "./telegramFormatter";

const BASE = {
  leadId: 5001,
  pageName: "Test Sahifa",
  formName: "Sotuv formasi",
  leadgenId: "lead-abc-123",
  errorType: "auth",
  dataError: "Error validating access token: Session has expired.",
  attempts: 1,
  maxAttempts: 3,
  now: new Date("2026-05-19T14:35:00.000Z"),
  baseUrl: "https://targenix.uz",
};

describe("formatLeadErrorMessage — auth", () => {
  it("includes the token-expired headline", () => {
    const out = formatLeadErrorMessage("auth", BASE);
    expect(out).toContain("Lead qabul qilinmadi");
    expect(out).toContain("Facebook token muddati o'tgan");
  });

  it("includes page and form names (HTML-escaped)", () => {
    const out = formatLeadErrorMessage("auth", { ...BASE, pageName: "A & B", formName: "F < 1" });
    expect(out).toContain("A &amp; B");
    expect(out).toContain("F &lt; 1");
  });

  it("includes a Connections deep link to the base URL", () => {
    const out = formatLeadErrorMessage("auth", BASE);
    expect(out).toContain('href="https://targenix.uz/connections"');
  });

  it("does NOT include the raw FB error in auth template (the message is generic)", () => {
    // The auth template intentionally avoids quoting the raw FB error because
    // it's almost always "Error validating access token" (low signal). The
    // template prompts the user to reconnect.
    const out = formatLeadErrorMessage("auth", BASE);
    expect(out).not.toContain("Session has expired");
  });
});

describe("formatLeadErrorMessage — validation", () => {
  it("includes the misconfiguration headline", () => {
    const out = formatLeadErrorMessage("validation", BASE);
    expect(out).toContain("sozlash xatosi");
  });

  it("quotes the raw Facebook error verbatim (Phase 1 Q5 decision)", () => {
    const out = formatLeadErrorMessage("validation", {
      ...BASE,
      dataError: "Some of the aliases you requested do not exist",
    });
    expect(out).toContain("Some of the aliases you requested do not exist");
  });

  it("escapes HTML in the raw error", () => {
    const out = formatLeadErrorMessage("validation", {
      ...BASE,
      dataError: "<script>alert(1)</script>",
    });
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>alert(1)</script>");
  });

  it("links to /integrations (the user fix is in integration config)", () => {
    const out = formatLeadErrorMessage("validation", BASE);
    expect(out).toContain('href="https://targenix.uz/integrations"');
  });
});

describe("formatLeadErrorMessage — final-exhaustion", () => {
  it("includes the max-attempts headline", () => {
    const out = formatLeadErrorMessage("final-exhaustion", {
      ...BASE,
      attempts: 3,
      maxAttempts: 3,
    });
    expect(out).toContain("bir necha urinishdan keyin ham");
  });

  it("shows the attempts ratio", () => {
    const out = formatLeadErrorMessage("final-exhaustion", {
      ...BASE,
      attempts: 3,
      maxAttempts: 3,
    });
    expect(out).toContain("3/3");
  });

  it("includes a direct deep link to the failed lead's detail page", () => {
    const out = formatLeadErrorMessage("final-exhaustion", {
      ...BASE,
      attempts: 3,
      maxAttempts: 3,
    });
    expect(out).toContain('href="https://targenix.uz/leads/5001"');
  });

  it("includes the classifier errorType so the user knows the bucket", () => {
    const out = formatLeadErrorMessage("final-exhaustion", {
      ...BASE,
      errorType: "network",
      attempts: 3,
      maxAttempts: 3,
    });
    expect(out).toContain("network");
  });

  it("uses fallback 'noma\\'lum' when leadgenId is empty", () => {
    const out = formatLeadErrorMessage("final-exhaustion", {
      ...BASE,
      leadgenId: null,
      attempts: 3,
      maxAttempts: 3,
    });
    expect(out).toContain("noma");
  });
});

describe("formatLeadErrorMessage — base URL resolution", () => {
  it("strips a trailing slash from the override base URL", () => {
    const out = formatLeadErrorMessage("auth", { ...BASE, baseUrl: "https://example.com/" });
    expect(out).toContain('href="https://example.com/connections"');
    expect(out).not.toContain("//connections");
  });
});
