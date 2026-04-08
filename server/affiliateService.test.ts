import { describe, it, expect } from "vitest";
import {
  buildVariableContext,
  injectVariables,
  extractVariableNames,
  extractCustomVariableNames,
  buildCustomBody,
  BUILTIN_VARIABLES,
} from "./services/affiliateService";

const sampleLead = {
  leadgenId: "lead_123",
  fullName: "Ali Valiyev",
  phone: "+998901234567",
  email: "ali@example.com",
  pageId: "page_456",
  formId: "form_789",
};

// ─── buildVariableContext ────────────────────────────────────────────────────
describe("buildVariableContext", () => {
  it("maps built-in lead fields to variable names", () => {
    const ctx = buildVariableContext(sampleLead);
    expect(ctx.name).toBe("Ali Valiyev");
    expect(ctx.phone).toBe("+998901234567");
    expect(ctx.email).toBe("ali@example.com");
    expect(ctx.lead_id).toBe("lead_123");
    expect(ctx.page_id).toBe("page_456");
    expect(ctx.form_id).toBe("form_789");
  });

  it("merges extra variables, overriding built-ins if needed", () => {
    const ctx = buildVariableContext(sampleLead, { offer_id: "999", stream: "main" });
    expect(ctx.offer_id).toBe("999");
    expect(ctx.stream).toBe("main");
    expect(ctx.name).toBe("Ali Valiyev");
  });

  it("handles null fullName and phone gracefully", () => {
    const ctx = buildVariableContext({ ...sampleLead, fullName: null, phone: null });
    expect(ctx.name).toBe("");
    expect(ctx.phone).toBe("");
  });
});

// ─── injectVariables ─────────────────────────────────────────────────────────
describe("injectVariables", () => {
  it("replaces {{variable}} placeholders with values", () => {
    const result = injectVariables("Hello {{name}}, your phone is {{phone}}", {
      name: "Ali",
      phone: "+998901234567",
    });
    expect(result).toBe("Hello Ali, your phone is +998901234567");
  });

  it("replaces unknown variables with empty string", () => {
    const result = injectVariables("{{unknown_var}}", { name: "Ali" });
    expect(result).toBe("");
  });

  it("handles multiple occurrences of the same variable", () => {
    const result = injectVariables("{{name}} - {{name}}", { name: "Ali" });
    expect(result).toBe("Ali - Ali");
  });

  it("handles template with no variables unchanged", () => {
    const result = injectVariables("plain text", { name: "Ali" });
    expect(result).toBe("plain text");
  });

  it("handles whitespace inside variable braces", () => {
    const result = injectVariables("{{ name }}", { name: "Ali" });
    expect(result).toBe("Ali");
  });
});

// ─── extractVariableNames ────────────────────────────────────────────────────
describe("extractVariableNames", () => {
  it("extracts all variable names from a template string", () => {
    const names = extractVariableNames('{"name":"{{name}}","phone":"{{phone}}","offer":"{{offer_id}}"}');
    expect(names).toContain("name");
    expect(names).toContain("phone");
    expect(names).toContain("offer_id");
    expect(names).toHaveLength(3);
  });

  it("returns unique names (no duplicates)", () => {
    const names = extractVariableNames("{{name}} {{name}} {{phone}}");
    expect(names).toHaveLength(2);
  });

  it("returns empty array for template with no variables", () => {
    expect(extractVariableNames("no variables here")).toHaveLength(0);
  });
});

// ─── extractCustomVariableNames ──────────────────────────────────────────────
describe("extractCustomVariableNames", () => {
  it("filters out built-in variables", () => {
    const names = extractCustomVariableNames('{{name}} {{phone}} {{offer_id}} {{stream}}');
    expect(names).not.toContain("name");
    expect(names).not.toContain("phone");
    expect(names).toContain("offer_id");
    expect(names).toContain("stream");
  });

  it("returns empty array when only built-ins present", () => {
    const names = extractCustomVariableNames("{{name}} {{phone}} {{email}} {{lead_id}}");
    expect(names).toHaveLength(0);
  });

  it("BUILTIN_VARIABLES set contains all expected keys", () => {
    expect(BUILTIN_VARIABLES.has("name")).toBe(true);
    expect(BUILTIN_VARIABLES.has("phone")).toBe(true);
    expect(BUILTIN_VARIABLES.has("email")).toBe(true);
    expect(BUILTIN_VARIABLES.has("lead_id")).toBe(true);
    expect(BUILTIN_VARIABLES.has("page_id")).toBe(true);
    expect(BUILTIN_VARIABLES.has("form_id")).toBe(true);
  });
});

// ─── buildCustomBody ─────────────────────────────────────────────────────────
describe("buildCustomBody", () => {
  const varCtx = buildVariableContext(sampleLead, { offer_id: "123", stream: "main" });

  describe("contentType: json", () => {
    it("parses bodyTemplate and injects variables", () => {
      const cfg = {
        contentType: "json",
        bodyTemplate: '{"name":"{{name}}","phone":"{{phone}}","offer_id":"{{offer_id}}"}',
      };
      const { body, contentTypeHeader } = buildCustomBody(cfg, varCtx);
      expect(contentTypeHeader).toBe("application/json");
      expect(body).toEqual({ name: "Ali Valiyev", phone: "+998901234567", offer_id: "123" });
    });

    it("falls back to fieldMap when no bodyTemplate", () => {
      const cfg = {
        contentType: "json",
        fieldMap: { full_name: "name", tel: "phone" },
      };
      const { body, contentTypeHeader } = buildCustomBody(cfg, varCtx);
      expect(contentTypeHeader).toBe("application/json");
      expect((body as Record<string, string>).full_name).toBe("Ali Valiyev");
      expect((body as Record<string, string>).tel).toBe("+998901234567");
    });

    it("falls back to default built-in fields when no bodyTemplate or fieldMap", () => {
      const cfg = { contentType: "json" };
      const { body } = buildCustomBody(cfg, varCtx);
      expect((body as Record<string, string>).name).toBe("Ali Valiyev");
      expect((body as Record<string, string>).phone).toBe("+998901234567");
    });
  });

  describe("contentType: form-urlencoded", () => {
    it("builds URL-encoded body from bodyFields with variable injection", () => {
      const cfg = {
        contentType: "form-urlencoded",
        bodyFields: [
          { key: "name", value: "{{name}}" },
          { key: "phone", value: "{{phone}}" },
          { key: "offer_id", value: "{{offer_id}}" },
        ],
      };
      const { body, contentTypeHeader } = buildCustomBody(cfg, varCtx);
      expect(contentTypeHeader).toBe("application/x-www-form-urlencoded");
      expect(typeof body).toBe("string");
      const params = new URLSearchParams(body as string);
      expect(params.get("name")).toBe("Ali Valiyev");
      expect(params.get("phone")).toBe("+998901234567");
      expect(params.get("offer_id")).toBe("123");
    });

    it("skips fields with empty key", () => {
      const cfg = {
        contentType: "form-urlencoded",
        bodyFields: [
          { key: "", value: "{{name}}" },
          { key: "phone", value: "{{phone}}" },
        ],
      };
      const { body } = buildCustomBody(cfg, varCtx);
      const params = new URLSearchParams(body as string);
      expect(params.get("phone")).toBe("+998901234567");
      expect(params.get("")).toBeNull();
    });
  });

  describe("contentType: form (legacy alias)", () => {
    it("treats 'form' as 'form-urlencoded'", () => {
      const cfg = {
        contentType: "form",
        bodyFields: [{ key: "name", value: "{{name}}" }],
      };
      const { contentTypeHeader } = buildCustomBody(cfg, varCtx);
      expect(contentTypeHeader).toBe("application/x-www-form-urlencoded");
    });
  });

  describe("contentType: multipart", () => {
    it("returns FormData with injected fields", () => {
      const cfg = {
        contentType: "multipart",
        bodyFields: [
          { key: "name", value: "{{name}}" },
          { key: "phone", value: "{{phone}}" },
        ],
      };
      const { body, contentTypeHeader, formData } = buildCustomBody(cfg, varCtx);
      expect(contentTypeHeader).toBe("multipart/form-data");
      expect(body).toBeNull();
      expect(formData).toBeDefined();
    });
  });

  describe("JSON template with invalid JSON after injection", () => {
    it("returns injected string as-is when JSON.parse fails", () => {
      const cfg = {
        contentType: "json",
        bodyTemplate: "not valid json {{name}}",
      };
      const { body, contentTypeHeader } = buildCustomBody(cfg, varCtx);
      expect(contentTypeHeader).toBe("application/json");
      expect(typeof body).toBe("string");
      expect(body as string).toContain("Ali Valiyev");
    });
  });
});
