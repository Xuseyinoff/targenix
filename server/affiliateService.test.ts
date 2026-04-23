import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildVariableContext,
  injectVariables,
  resolveTemplateValue,
  extractVariableNames,
  extractCustomVariableNames,
  buildCustomBody,
  buildHeaders,
  BUILTIN_VARIABLES,
  SecretDecryptError,
  DeliveryBlockedError,
} from "./services/affiliateService";
import { encrypt } from "./encryption";

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

// ─── resolveTemplateValue (Stage D v2 Step 1) ──────────────────────────────
//
// Full coverage of the `{{SECRET:key}}` + `{{variable}}` resolver that is
// now used by `buildCustomBody` and `buildHeaders`. The tests below are
// the seven MANDATORY scenarios from the task brief:
//   1. Plain text — behaves exactly like before.
//   2. Variable only — still resolves via injectVariables.
//   3. SECRET only — decrypts from secrets map.
//   4. Mixed SECRET + variable — single-pass resolution.
//   5. Missing secret — empty string, no throw.
//   6. Headers.api_key SECRET — resolves through buildHeaders.
//   7. All three content types (json / form-urlencoded / multipart) —
//      legacy delivery path still works AND newly supports SECRET.
//
// `ENCRYPTION_KEY` is swapped around each block so `encrypt()` /
// `decrypt()` produce deterministic ciphertexts without depending on
// whatever key the surrounding dev environment happens to have set.

describe("resolveTemplateValue", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "stage-d-unit-test-key-do-not-use-in-prod";
  });
  afterAll(() => {
    if (originalKey !== undefined) process.env.ENCRYPTION_KEY = originalKey;
    else delete process.env.ENCRYPTION_KEY;
  });

  it("(1) passes plain text through unchanged (no SECRET, no variable)", () => {
    // Byte-for-byte identical to today: today this would go through
    // injectVariables, which also leaves plain text untouched.
    expect(resolveTemplateValue("ABC123", {}, {})).toBe("ABC123");
    expect(resolveTemplateValue("Bearer xyz", {}, undefined)).toBe("Bearer xyz");
  });

  it("(2) resolves {{variable}} exactly like injectVariables", () => {
    expect(resolveTemplateValue("{{name}}", { name: "Ali" })).toBe("Ali");
    expect(
      resolveTemplateValue("Hello {{name}}, phone {{phone}}", {
        name: "Ali",
        phone: "+998901234567",
      }),
    ).toBe("Hello Ali, phone +998901234567");
    expect(resolveTemplateValue("{{unknown}}", { name: "Ali" })).toBe("");
  });

  it("(3) resolves {{SECRET:key}} by decrypting from secrets map", () => {
    const ciphertext = encrypt("my-plain-api-key");
    expect(
      resolveTemplateValue("{{SECRET:api_key}}", {}, { api_key: ciphertext }),
    ).toBe("my-plain-api-key");
  });

  it("(3b) honours whitespace inside SECRET braces", () => {
    const ciphertext = encrypt("trimmed-value");
    expect(
      resolveTemplateValue("{{ SECRET:api_key }}", {}, { api_key: ciphertext }),
    ).toBe("trimmed-value");
  });

  it("(4) resolves a mixed string (SECRET + variable) in one pass", () => {
    const ciphertext = encrypt("secret-token-abc");
    expect(
      resolveTemplateValue(
        "Bearer {{SECRET:api_key}} for {{name}}",
        { name: "Ali" },
        { api_key: ciphertext },
      ),
    ).toBe("Bearer secret-token-abc for Ali");
  });

  it("(5a) returns empty string when the secret key is missing", () => {
    // Matches injectVariables' "unknown variable → empty" contract so
    // the partner endpoint receives the same empty value it would for a
    // bad {{variable}} — delivery is never blocked by a missing secret.
    expect(resolveTemplateValue("{{SECRET:unknown}}", {}, {})).toBe("");
  });

  it("(5b) returns empty string when secrets param is undefined", () => {
    expect(resolveTemplateValue("{{SECRET:api_key}}", {}, undefined)).toBe("");
  });

  // ─── Stage D v3 — HARD-failure semantics ─────────────────────────────
  // Decrypt-level failures USED to silently return empty string (Stage D
  // v2 Step 1 behaviour). That was the root cause of the aborted v1
  // migration — a production key mismatch silently sent empty api_keys
  // and logged leads as SENT while the partner rejected them.
  //
  // From Stage D v3 onwards the resolver throws `SecretDecryptError`
  // on any ACTUAL decrypt failure (ciphertext present but unreadable),
  // while a MISSING ciphertext still resolves to empty (soft-miss, kept
  // for configuration-oversight parity with `{{unknown_variable}}`).

  it("(5c) throws SecretDecryptError when ciphertext is malformed", () => {
    try {
      resolveTemplateValue("{{SECRET:api_key}}", {}, {
        api_key: "not-a-valid-ciphertext",
      });
      throw new Error("expected SecretDecryptError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretDecryptError);
      expect((err as SecretDecryptError).code).toBe("SECRET_DECRYPT_FAILED");
      expect((err as SecretDecryptError).key).toBe("api_key");
    }
  });

  it("(5d) throws SecretDecryptError on well-formatted but unreadable ciphertext", () => {
    // iv:payload shape parses but AES-CBC rejects the bytes — exactly
    // the shape that a production-key-vs-local-key mismatch produces.
    try {
      resolveTemplateValue("{{SECRET:api_key}}", {}, {
        api_key: "aabbccddeeff00112233445566778899:ff",
      });
      throw new Error("expected SecretDecryptError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretDecryptError);
      expect((err as SecretDecryptError).code).toBe("SECRET_DECRYPT_FAILED");
      expect((err as SecretDecryptError).key).toBe("api_key");
    }
  });

  it("(5e) throw carries the original decrypt error as `cause`", () => {
    // Surfacing the original error aids debugging without leaking
    // ciphertext into higher layers — the message stays generic.
    try {
      resolveTemplateValue("{{SECRET:api_key}}", {}, {
        api_key: "not-a-valid-ciphertext",
      });
      throw new Error("expected SecretDecryptError");
    } catch (err) {
      expect(err).toBeInstanceOf(SecretDecryptError);
      expect(
        (err as SecretDecryptError & { cause?: unknown }).cause,
      ).toBeInstanceOf(Error);
    }
  });

  it("preserves static injectVariables behaviour when no SECRET token present", () => {
    // This is the hot-path check — 100% of today's production configs
    // hit this branch, so any regression here would break delivery.
    const input = "Hello {{name}}, your phone is {{phone}}";
    const ctx = { name: "Ali", phone: "+998901234567" };
    expect(resolveTemplateValue(input, ctx, undefined)).toBe(
      injectVariables(input, ctx),
    );
    expect(resolveTemplateValue(input, ctx, {})).toBe(
      injectVariables(input, ctx),
    );
  });
});

// ─── buildCustomBody — SECRET resolution across content types ──────────────
describe("buildCustomBody — SECRET support", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "stage-d-unit-test-key-do-not-use-in-prod";
  });
  afterAll(() => {
    if (originalKey !== undefined) process.env.ENCRYPTION_KEY = originalKey;
    else delete process.env.ENCRYPTION_KEY;
  });

  const varCtx = buildVariableContext(sampleLead, { offer_id: "123" });

  it("(7a) resolves SECRET in form-urlencoded bodyFields", () => {
    const ciphertext = encrypt("plain-key-form");
    const cfg = {
      contentType: "form-urlencoded",
      bodyFields: [
        { key: "api_key", value: "{{SECRET:api_key}}" },
        { key: "name", value: "{{name}}" },
      ],
      secrets: { api_key: ciphertext },
    };
    const { body } = buildCustomBody(cfg, varCtx);
    const params = new URLSearchParams(body as string);
    expect(params.get("api_key")).toBe("plain-key-form");
    expect(params.get("name")).toBe("Ali Valiyev");
  });

  it("(7b) resolves SECRET in multipart bodyFields", () => {
    const ciphertext = encrypt("plain-key-multipart");
    const cfg = {
      contentType: "multipart",
      bodyFields: [
        { key: "api_key", value: "{{SECRET:api_key}}" },
        { key: "name", value: "{{name}}" },
      ],
      secrets: { api_key: ciphertext },
    };
    const { formData, contentTypeHeader } = buildCustomBody(cfg, varCtx);
    expect(contentTypeHeader).toBe("multipart/form-data");
    // form-data's internal buffer holds the resolved plaintext; we assert
    // via getBuffer() because the library does not expose fields() for
    // direct read.
    const bufStr = formData!.getBuffer().toString("utf8");
    expect(bufStr).toContain("plain-key-multipart");
    expect(bufStr).toContain("Ali Valiyev");
  });

  it("(7c) resolves SECRET in JSON bodyTemplate", () => {
    const ciphertext = encrypt("plain-key-json");
    const cfg = {
      contentType: "json",
      bodyTemplate: '{"api_key":"{{SECRET:api_key}}","name":"{{name}}"}',
      secrets: { api_key: ciphertext },
    };
    const { body, contentTypeHeader } = buildCustomBody(cfg, varCtx);
    expect(contentTypeHeader).toBe("application/json");
    expect(body).toEqual({ api_key: "plain-key-json", name: "Ali Valiyev" });
  });

  it("is a no-op for configs without any SECRET token (plain api_key preserved)", () => {
    // This is the exact shape production currently holds for the 5
    // legacy affiliate destinations — plain api_key string with no
    // `secrets` map. After Stage D v2 Step 1 the output MUST be
    // identical to before (the cfg still has `api_key` as plaintext
    // inside bodyFields, no encryption involved).
    const cfg = {
      contentType: "form-urlencoded",
      bodyFields: [
        { key: "api_key", value: "PLAIN_KEY_ABC" },
        { key: "name", value: "{{name}}" },
      ],
    };
    const { body } = buildCustomBody(cfg, varCtx);
    const params = new URLSearchParams(body as string);
    expect(params.get("api_key")).toBe("PLAIN_KEY_ABC");
    expect(params.get("name")).toBe("Ali Valiyev");
  });

  it("missing secrets map does not block delivery — empty string returned", () => {
    // Defensive: if a config references a SECRET but the secrets map was
    // not persisted (legacy/test/data-corruption), delivery must still
    // proceed with an empty string in that slot (partner responds).
    const cfg = {
      contentType: "form-urlencoded",
      bodyFields: [
        { key: "api_key", value: "{{SECRET:api_key}}" },
        { key: "name", value: "{{name}}" },
      ],
      // intentionally no `secrets` key
    };
    const { body } = buildCustomBody(cfg, varCtx);
    const params = new URLSearchParams(body as string);
    expect(params.get("api_key")).toBe("");
    expect(params.get("name")).toBe("Ali Valiyev");
  });

  // ─── Stage D v3 — DeliveryBlockedError on broken SECRET ───────────────
  // These exist expressly to prevent a repeat of the Stage D v1 failure:
  // encrypted bytes that the CURRENT runtime cannot decrypt (key drift)
  // MUST abort the outbound request — not send an empty api_key and log
  // the lead as SENT.

  const expectDeliveryBlocked = (fn: () => unknown, expectedKey: string) => {
    try {
      fn();
      throw new Error("expected DeliveryBlockedError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryBlockedError);
      expect((err as DeliveryBlockedError).code).toBe(
        "DELIVERY_BLOCKED_SECRET_ERROR",
      );
      expect((err as DeliveryBlockedError).key).toBe(expectedKey);
      expect((err as DeliveryBlockedError).adapterContext).toMatch(
        /^legacy-template\//,
      );
    }
  };

  it("(D3-body-form) broken SECRET in form-urlencoded throws DeliveryBlockedError", () => {
    const cfg = {
      contentType: "form-urlencoded",
      bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}" }],
      secrets: { api_key: "not-a-valid-ciphertext" },
    };
    expectDeliveryBlocked(() => buildCustomBody(cfg, varCtx), "api_key");
  });

  it("(D3-body-multipart) broken SECRET in multipart throws DeliveryBlockedError", () => {
    const cfg = {
      contentType: "multipart",
      bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}" }],
      secrets: { api_key: "aabbccddeeff00112233445566778899:ff" },
    };
    expectDeliveryBlocked(() => buildCustomBody(cfg, varCtx), "api_key");
  });

  it("(D3-body-json) broken SECRET in JSON bodyTemplate throws DeliveryBlockedError", () => {
    const cfg = {
      contentType: "json",
      bodyTemplate: '{"api_key":"{{SECRET:api_key}}"}',
      secrets: { api_key: "not-a-valid-ciphertext" },
    };
    expectDeliveryBlocked(() => buildCustomBody(cfg, varCtx), "api_key");
  });

  it("(D3-body-form) DeliveryBlockedError adapterContext identifies the failing stage", () => {
    const cfg = {
      contentType: "form-urlencoded",
      bodyFields: [{ key: "api_key", value: "{{SECRET:api_key}}" }],
      secrets: { api_key: "not-a-valid-ciphertext" },
    };
    try {
      buildCustomBody(cfg, varCtx);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryBlockedError);
      expect((err as DeliveryBlockedError).adapterContext).toBe(
        "legacy-template/body/form-urlencoded",
      );
    }
  });
});

// ─── buildHeaders — SECRET resolution ──────────────────────────────────────
describe("buildHeaders — SECRET support", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = "stage-d-unit-test-key-do-not-use-in-prod";
  });
  afterAll(() => {
    if (originalKey !== undefined) process.env.ENCRYPTION_KEY = originalKey;
    else delete process.env.ENCRYPTION_KEY;
  });

  const varCtx = buildVariableContext(sampleLead);

  it("(6) resolves {{SECRET:api_key}} in a header value", () => {
    const ciphertext = encrypt("plain-header-key");
    const cfg = {
      headers: {
        "X-Api-Key": "{{SECRET:api_key}}",
        Authorization: "Bearer {{SECRET:api_key}}",
      },
      secrets: { api_key: ciphertext },
    };
    const headers = buildHeaders(cfg, varCtx, "application/json");
    expect(headers["X-Api-Key"]).toBe("plain-header-key");
    expect(headers["Authorization"]).toBe("Bearer plain-header-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("leaves plain-text headers byte-for-byte identical (no-op path)", () => {
    const cfg = {
      headers: {
        "X-Api-Key": "PLAIN_STATIC_KEY",
        "X-Trace-Id": "{{lead_id}}",
      },
    };
    const headers = buildHeaders(cfg, varCtx, "application/json");
    expect(headers["X-Api-Key"]).toBe("PLAIN_STATIC_KEY");
    expect(headers["X-Trace-Id"]).toBe("lead_123");
  });

  it("honours user-provided Content-Type override", () => {
    const cfg = {
      headers: { "content-type": "application/xml" },
    };
    const headers = buildHeaders(cfg, varCtx, "application/json");
    expect(headers["content-type"]).toBe("application/xml");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  // ─── Stage D v3 — DeliveryBlockedError on broken SECRET in headers ────
  // An Authorization header with a decrypt-failing SECRET is the highest-
  // risk silent-fail scenario: a blank bearer token will draw a 401/403
  // from the partner but some adapters log it as SENT with error body.
  // We must abort before axios runs.

  it("(D3-headers) broken SECRET in Authorization throws DeliveryBlockedError", () => {
    const cfg = {
      headers: { Authorization: "Bearer {{SECRET:api_key}}" },
      secrets: { api_key: "not-a-valid-ciphertext" },
    };
    try {
      buildHeaders(cfg, varCtx, "application/json");
      throw new Error("expected DeliveryBlockedError");
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryBlockedError);
      expect((err as DeliveryBlockedError).code).toBe(
        "DELIVERY_BLOCKED_SECRET_ERROR",
      );
      expect((err as DeliveryBlockedError).key).toBe("api_key");
      expect((err as DeliveryBlockedError).adapterContext).toBe(
        "legacy-template/headers",
      );
    }
  });

  it("(D3-headers) multiple headers: any one broken SECRET blocks the whole request", () => {
    // Mixed: one valid SECRET and one broken SECRET. Delivery must not
    // partially proceed — the whole header build throws.
    const validCipher = encrypt("valid-key");
    const cfg = {
      headers: {
        "X-Api-Key": "{{SECRET:api_key}}",
        Authorization: "Bearer {{SECRET:auth_token}}",
      },
      secrets: {
        api_key: validCipher,
        auth_token: "aabbccddeeff00112233445566778899:ff",
      },
    };
    try {
      buildHeaders(cfg, varCtx, "application/json");
      throw new Error("expected DeliveryBlockedError");
    } catch (err) {
      expect(err).toBeInstanceOf(DeliveryBlockedError);
      expect((err as DeliveryBlockedError).key).toBe("auth_token");
    }
  });
});
