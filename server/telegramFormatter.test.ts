import { describe, it, expect } from "vitest";
import { formatLeadMessage, parseApiResponse } from "./services/telegramFormatter";

// ─── parseApiResponse ─────────────────────────────────────────────────────────

describe("parseApiResponse", () => {
  it("detects success from status='success'", () => {
    const r = parseApiResponse("CRM", { status: "success", order_id: "ORD-123" }, true);
    expect(r.statusEmoji).toBe("🟢");
    expect(r.statusLabel).toBe("Success");
    expect(r.fields.find((f) => f.label === "ID")?.value).toBe("ORD-123");
  });

  it("detects success from ok=true", () => {
    const r = parseApiResponse("API", { ok: true, id: "REQ-99" }, true);
    expect(r.statusEmoji).toBe("🟢");
  });

  it("detects error from status='error'", () => {
    const r = parseApiResponse("API", { status: "error", message: "Invalid token" }, false);
    expect(r.statusEmoji).toBe("🔴");
    expect(r.statusLabel).toBe("Error");
    expect(r.fields.find((f) => f.label === "Message")?.value).toBe("Invalid token");
  });

  it("detects error from success=false", () => {
    const r = parseApiResponse("API", { success: false, reason: "Quota exceeded" }, false);
    expect(r.statusEmoji).toBe("🔴");
  });

  it("extracts order_id field", () => {
    const r = parseApiResponse("Shop", { order_id: "12345", status: "ok" }, true);
    expect(r.fields.find((f) => f.label === "ID")?.value).toBe("12345");
  });

  it("extracts price/amount field", () => {
    const r = parseApiResponse("CPA", { status: "ok", payout: "5000" }, true);
    expect(r.fields.find((f) => f.label === "Amount")?.value).toBe("5000");
  });

  it("truncates long message values", () => {
    const longMsg = "x".repeat(200);
    const r = parseApiResponse("API", { message: longMsg }, true);
    const msg = r.fields.find((f) => f.label === "Message");
    expect(msg?.value.length).toBeLessThanOrEqual(121); // 120 + ellipsis
    expect(msg?.value.endsWith("…")).toBe(true);
  });

  it("returns unknown for null responseData with no error", () => {
    const r = parseApiResponse("API", null, true);
    expect(r.statusEmoji).toBe("⚪");
    expect(r.statusLabel).toBe("Unknown response format");
  });

  it("returns error message when responseData is null and error provided", () => {
    const r = parseApiResponse("API", null, false, "Connection refused");
    expect(r.statusEmoji).toBe("🔴");
    expect(r.fields[0].value).toBe("Connection refused");
  });

  it("handles non-object responseData (string)", () => {
    const r = parseApiResponse("API", "OK", true);
    expect(r.statusEmoji).toBe("🟢");
  });

  it("caps fields at 5 extras", () => {
    const r = parseApiResponse(
      "API",
      {
        status: "ok",
        message: "done",
        order_id: "1",
        payout: "100",
        status_text: "accepted",
        comment: "fast",
        response_code: "200",
      },
      true
    );
    expect(r.fields.length).toBeLessThanOrEqual(6);
  });

  it("skips empty string fields", () => {
    const r = parseApiResponse("API", { status: "ok", message: "" }, true);
    expect(r.fields.find((f) => f.label === "Message")).toBeUndefined();
  });
});

// ─── formatLeadMessage (minimal delivery template) ───────────────────────────

describe("formatLeadMessage", () => {
  const baseOpts = {
    lead: {
      fullName: "Ali Valiyev",
      phone: "+998901234567",
      accountName: "Xusenova Sitoramo",
      pageName: "Go'zallik Mo'jizasi",
      formName: "Tibbiyot Form - 7",
    },
    routing: {
      integrationName: "Sotuvchi.com",
      success: true,
      responseData: { status: "success", order_id: "ORD-999" },
      durationMs: 320,
    },
  };

  it("shows minimal NEW LEAD header", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).toContain("🚀");
    expect(html).toContain("<b>NEW LEAD</b>");
    expect(html).not.toContain("TARGENIX");
  });

  it("shows lead name and phone", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).toContain("Ali Valiyev");
    expect(html).toContain("+998901234567");
  });

  it("shows compact source lines (Account, Sahifa, Forma)", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).toContain("📌 Account:");
    expect(html).toContain("Xusenova Sitoramo");
    expect(html).toContain("📍 Sahifa:");
    expect(html).toContain("Go'zallik Mo'jizasi");
    expect(html).toContain("📝 Forma:");
    expect(html).toContain("Tibbiyot Form - 7");
    expect(html).not.toContain("SOURCE");
  });

  it("shows routing line to destination", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).toContain("🔀 Yo'naltirildi");
    expect(html).toContain("Sotuvchi.com");
    expect(html).not.toContain("ROUTING");
  });

  it("shows Yuborildi for success with duration", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).toContain("✅ Yuborildi");
    expect(html).toContain("0.32s");
    expect(html).not.toContain("Yuborilmadi");
  });

  it("shows Yuborilmadi for failure", () => {
    const html = formatLeadMessage({
      ...baseOpts,
      routing: { ...baseOpts.routing, success: false, error: "Timeout" },
    });
    expect(html).toContain("❌ Yuborilmadi");
    expect(html).not.toContain("✅ Yuborildi");
  });

  it("omits duration suffix when durationMs is undefined", () => {
    const html = formatLeadMessage({
      ...baseOpts,
      routing: { ...baseOpts.routing, durationMs: undefined },
    });
    expect(html).toContain("✅ Yuborildi");
    expect(html).not.toContain("0.32s");
    expect(html).not.toMatch(/Yuborildi • \d/);
  });

  it("wraps response in blockquote", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).toContain("<blockquote>");
    expect(html).toContain("</blockquote>");
  });

  it("shows SUCCESS and order id inside response block", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).toContain("SUCCESS");
    expect(html).toContain("ID:");
    expect(html).toContain("ORD-999");
    expect(html).not.toContain("→ RESPONSE");
  });

  it("prefers targetWebsiteName in routing line when provided", () => {
    const html = formatLeadMessage({
      ...baseOpts,
      routing: { ...baseOpts.routing, targetWebsiteName: "My Dest" },
    });
    expect(html).toContain("🔀 Yo'naltirildi → My Dest");
  });

  it("shows [TEST] badge in header when isTest=true", () => {
    const html = formatLeadMessage({ ...baseOpts, isTest: true });
    expect(html).toContain("[TEST]");
    expect(html).toContain("NEW LEAD");
  });

  it("shows [ADMIN] badge when isAdmin=true", () => {
    const html = formatLeadMessage({ ...baseOpts, isAdmin: true });
    expect(html).toContain("[ADMIN]");
  });

  it("shows [RETRY] badge and Urinish line when isAutoRetry with deliveryAttempt", () => {
    const html = formatLeadMessage({
      ...baseOpts,
      isAutoRetry: true,
      deliveryAttempt: { current: 2, max: 3 },
    });
    expect(html).toContain("[RETRY]");
    expect(html).toContain("NEW LEAD");
    expect(html).toContain("🔁 Urinish: 2/3");
    expect(html).not.toContain("avtomatik qayta yuborish");
  });

  it("shows [TEST] and [RETRY] together when both flags set", () => {
    const html = formatLeadMessage({
      ...baseOpts,
      isTest: true,
      isAutoRetry: true,
      deliveryAttempt: { current: 3, max: 3 },
    });
    expect(html).toContain("[TEST]");
    expect(html).toContain("[RETRY]");
  });

  it("does not show [TEST] badge when isTest=false (default)", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).not.toContain("[TEST]");
  });

  it("does not show [RETRY] when isAutoRetry is false (default)", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).not.toContain("[RETRY]");
  });

  it("escapes HTML special characters in name", () => {
    const html = formatLeadMessage({
      ...baseOpts,
      lead: { ...baseOpts.lead, fullName: "<script>alert(1)</script>" },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows dash for null name", () => {
    const html = formatLeadMessage({
      ...baseOpts,
      lead: { ...baseOpts.lead, fullName: null },
    });
    expect(html).toContain("👤 —");
  });

  it("omits source lines when no account/page/form", () => {
    const html = formatLeadMessage({
      lead: { fullName: "Test", phone: "123" },
      routing: { integrationName: "API", success: true },
    });
    expect(html).not.toContain("📌 Account:");
    expect(html).not.toContain("📍 Sahifa:");
  });

  it("produces valid HTML (balanced blockquotes)", () => {
    const html = formatLeadMessage(baseOpts);
    const opens = (html.match(/<blockquote>/g) || []).length;
    const closes = (html.match(/<\/blockquote>/g) || []).length;
    expect(opens).toBe(closes);
  });

  it("handles unknown API response gracefully", () => {
    const html = formatLeadMessage({
      ...baseOpts,
      routing: { ...baseOpts.routing, responseData: null },
    });
    expect(html).toContain("Unknown response format");
  });

  it("does not include footer clock line", () => {
    const html = formatLeadMessage(baseOpts);
    expect(html).not.toContain("🕒");
  });
});
