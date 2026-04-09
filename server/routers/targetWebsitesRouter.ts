/**
 * targetWebsitesRouter — CRUD for target websites.
 *
 * Security:
 *  - All procedures are protected (require auth).
 *  - apiKey is encrypted with AES-256-CBC before saving to DB.
 *  - On list/get, apiKey is masked as "••••••••" so it never leaks to the client.
 *  - The raw decrypted apiKey is only used server-side in affiliateService.
 *
 * Template config shape stored in templateConfig JSON:
 *  sotuvchi:  { apiKeyEncrypted: string }
 *  100k:      { apiKeyEncrypted: string }
 *  custom:    { url: string, method?: string, headers?: object, fieldMap?: object,
 *               successCondition?: string, contentType?: string, variableFields?: string[] }
 */

import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { targetWebsites } from "../../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";
import { encrypt, decrypt } from "../encryption";
import {
  sendAffiliateOrderByTemplate,
  buildVariableContext,
  buildCustomBody as _buildCustomBody,
  injectVariables,
  extractCustomVariableNames,
  type TemplateType,
  type TemplateConfig,
} from "../services/affiliateService";

/**
 * Validate a custom target website URL before storing it.
 * Must be HTTPS and must not target private/internal addresses (SSRF prevention).
 */
function validateTargetUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Target website URL must use HTTPS");
  }
  const host = parsed.hostname.toLowerCase();
  const blocked = [
    "localhost", "127.0.0.1", "0.0.0.0", "::1",
    "169.254.",
    "10.", "192.168.",
    ...Array.from({ length: 16 }, (_, i) => `172.${16 + i}.`),
  ];
  if (blocked.some((b) => host === b.replace(/\.$/, "") || host.startsWith(b))) {
    throw new Error("Target website URL must not point to internal or private addresses");
  }
}

// ─── Variable field definitions per template ──────────────────────────────────
export const TEMPLATE_VARIABLE_FIELDS: Record<string, Array<{ key: string; label: string; placeholder: string; required: boolean }>> = {
  sotuvchi: [
    { key: "offer_id", label: "Offer ID", placeholder: "e.g. 123", required: true },
    { key: "stream", label: "Stream", placeholder: "e.g. main", required: true },
  ],
  "100k": [
    { key: "stream_id", label: "Stream ID", placeholder: "e.g. 456", required: true },
  ],
  custom: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Mask apiKey in templateConfig before sending to client */
function maskConfig(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;
  const c = { ...(config as Record<string, unknown>) };
  if (c.apiKeyEncrypted) {
    delete c.apiKeyEncrypted;
    c.apiKeyMasked = "••••••••";
  }
  return c;
}

/** Decrypt apiKey from templateConfig for server-side use */
export function decryptApiKey(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const c = config as Record<string, unknown>;
  if (typeof c.apiKeyEncrypted === "string") {
    try { return decrypt(c.apiKeyEncrypted); } catch { return null; }
  }
  return null;
}

// ─── Router ───────────────────────────────────────────────────────────────────

const templateConfigSchema = z.record(z.string(), z.any());

export const targetWebsitesRouter = router({
  /** List all target websites for the authenticated user (apiKey masked). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select()
      .from(targetWebsites)
      .where(eq(targetWebsites.userId, ctx.user.id))
      .orderBy(desc(targetWebsites.createdAt));
    return rows.map((r) => ({ ...r, templateConfig: maskConfig(r.templateConfig) }));
  }),

  /** Create a new target website. apiKey is encrypted before saving. */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        templateType: z.enum(["sotuvchi", "100k", "custom"]),
        /** Plain-text apiKey — only for sotuvchi / 100k */
        apiKey: z.string().optional(),
        /** For custom template */
        url: z.string().optional(),
        method: z.enum(["POST", "GET"]).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        fieldMap: z.record(z.string(), z.string()).optional(),
        successCondition: z.string().optional(),
        contentType: z.enum(["json", "form", "form-urlencoded", "multipart"]).optional(),
        bodyTemplate: z.string().optional(),
        bodyFields: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
        jsonField: z.string().optional(),
        jsonValue: z.string().optional(),
        variableFields: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      // Build URL (pre-filled for known templates)
      let url = "";
      if (input.templateType === "sotuvchi") url = "https://sotuvchi.com/api/v2/order";
      else if (input.templateType === "100k") url = "https://api.100k.uz/api/shop/v1/orders/target";
      else url = input.url ?? "";

      // For custom templates the user provides the URL — validate it before storing
      if (input.templateType === "custom" && url) {
        validateTargetUrl(url);
      }

      // Build templateConfig
      const config: Record<string, unknown> = {};
      if (input.apiKey) {
        config.apiKeyEncrypted = encrypt(input.apiKey);
      }
      if (input.templateType === "custom") {
        if (input.method) config.method = input.method;
        if (input.headers) config.headers = input.headers;
        if (input.fieldMap) config.fieldMap = input.fieldMap;
        if (input.successCondition) config.successCondition = input.successCondition;
        if (input.contentType) config.contentType = input.contentType;
        if (input.bodyTemplate !== undefined) config.bodyTemplate = input.bodyTemplate;
        if (input.bodyFields !== undefined) config.bodyFields = input.bodyFields;
        if (input.jsonField !== undefined) config.jsonField = input.jsonField;
        if (input.jsonValue !== undefined) config.jsonValue = input.jsonValue;
        if (input.variableFields) config.variableFields = input.variableFields;
      }

      await db.insert(targetWebsites).values({
        userId: ctx.user.id,
        name: input.name,
        url,
        templateType: input.templateType,
        templateConfig: config,
        isActive: true,
      });
      return { success: true };
    }),

  /** Update a target website. Only owner can update. */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        templateType: z.enum(["sotuvchi", "100k", "custom"]).optional(),
        apiKey: z.string().optional(),
        url: z.string().optional(),
        method: z.enum(["POST", "GET"]).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        fieldMap: z.record(z.string(), z.string()).optional(),
        successCondition: z.string().optional(),
        contentType: z.enum(["json", "form", "form-urlencoded", "multipart"]).optional(),
        bodyTemplate: z.string().optional(),
        bodyFields: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
        jsonField: z.string().optional(),
        jsonValue: z.string().optional(),
        variableFields: z.array(z.string()).optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [site] = await db
        .select()
        .from(targetWebsites)
        .where(and(eq(targetWebsites.id, input.id), eq(targetWebsites.userId, ctx.user.id)))
        .limit(1);
      if (!site) throw new Error("Website not found");

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.isActive !== undefined) updates.isActive = input.isActive;

      // Rebuild config if any config fields changed
      const hasConfigChange = input.apiKey !== undefined || input.templateType !== undefined ||
        input.url !== undefined || input.method !== undefined || input.headers !== undefined ||
        input.fieldMap !== undefined || input.successCondition !== undefined ||
        input.contentType !== undefined || input.variableFields !== undefined ||
        input.bodyTemplate !== undefined || input.bodyFields !== undefined ||
        input.jsonField !== undefined || input.jsonValue !== undefined;

      if (hasConfigChange) {
        const existingConfig = (site.templateConfig as Record<string, unknown>) ?? {};
        const newConfig = { ...existingConfig };

        if (input.apiKey) {
          newConfig.apiKeyEncrypted = encrypt(input.apiKey);
        }
        const templateType = input.templateType ?? site.templateType;
        if (templateType === "custom") {
          if (input.method !== undefined) newConfig.method = input.method;
          if (input.headers !== undefined) newConfig.headers = input.headers;
          if (input.fieldMap !== undefined) newConfig.fieldMap = input.fieldMap;
          if (input.successCondition !== undefined) newConfig.successCondition = input.successCondition;
          if (input.contentType !== undefined) newConfig.contentType = input.contentType;
          if (input.bodyTemplate !== undefined) newConfig.bodyTemplate = input.bodyTemplate;
          if (input.bodyFields !== undefined) newConfig.bodyFields = input.bodyFields;
          if (input.jsonField !== undefined) newConfig.jsonField = input.jsonField;
          if (input.jsonValue !== undefined) newConfig.jsonValue = input.jsonValue;
          if (input.variableFields !== undefined) newConfig.variableFields = input.variableFields;
        }
        updates.templateConfig = newConfig;

        if (input.templateType) {
          updates.templateType = input.templateType;
          // Update URL for known templates
          if (input.templateType === "sotuvchi") updates.url = "https://sotuvchi.com/api/v2/order";
          else if (input.templateType === "100k") updates.url = "https://api.100k.uz/api/shop/v1/orders/target";
          else if (input.url) {
            validateTargetUrl(input.url);
            updates.url = input.url;
          }
        } else if (input.url) {
          const effectiveType = site.templateType;
          if (effectiveType === "custom") validateTargetUrl(input.url);
          updates.url = input.url;
        }
      }

      await db.update(targetWebsites).set(updates).where(eq(targetWebsites.id, input.id));
      return { success: true };
    }),

  /** Delete a target website. Only owner can delete. */
  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      await db
        .delete(targetWebsites)
        .where(and(eq(targetWebsites.id, input.id), eq(targetWebsites.userId, ctx.user.id)));
      return { success: true };
    }),

  /** Get variable field definitions for a template type. */
  getVariableFields: protectedProcedure
    .input(z.object({ templateType: z.enum(["sotuvchi", "100k", "custom"]) }))
    .query(({ input }) => {
      return TEMPLATE_VARIABLE_FIELDS[input.templateType] ?? [];
    }),

  /**
   * Return all variable field names for a custom template.
   * Priority order:
   *  1. Explicit variableFields list saved by the user in the template config
   *  2. Auto-detected {{var}} placeholders in bodyTemplate / bodyFields / headers
   *     (filtered to exclude built-in variables like name, phone, email, etc.)
   * Used by LeadRoutingWizard Step 5 to show which fields the user must fill per routing.
   */
  getCustomVariables: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const [site] = await db
        .select()
        .from(targetWebsites)
        .where(and(eq(targetWebsites.id, input.id), eq(targetWebsites.userId, ctx.user.id)))
        .limit(1);
      if (!site || site.templateType !== "custom") return [];
      const cfg = (site.templateConfig ?? {}) as Record<string, unknown>;

      // 1. Explicit variableFields list (highest priority — user defined these explicitly)
      if (Array.isArray(cfg.variableFields) && (cfg.variableFields as string[]).length > 0) {
        return (cfg.variableFields as string[]).filter((v) => typeof v === "string" && v.trim());
      }

      // 2. Auto-detect from body template / body fields / headers
      const detected = new Set<string>();

      // 2a. bodyFields with empty value → treat the key itself as a variable name the user must fill
      if (Array.isArray(cfg.bodyFields)) {
        for (const f of cfg.bodyFields as Array<{ key: string; value: string }>) {
          if (f.key && (!f.value || f.value.trim() === "")) {
            detected.add(f.key);
          }
        }
      }

      // 2b. {{placeholder}} variables in bodyTemplate / bodyFields values / headers
      const parts: string[] = [];
      if (cfg.bodyTemplate) parts.push(cfg.bodyTemplate as string);
      if (Array.isArray(cfg.bodyFields)) {
        for (const f of cfg.bodyFields as Array<{ key: string; value: string }>) {
          parts.push(f.key);
          parts.push(f.value);
        }
      }
      if (cfg.headers) {
        for (const v of Object.values(cfg.headers as Record<string, string>)) {
          parts.push(v);
        }
      }
      const combined = parts.join(" ");
      for (const name of extractCustomVariableNames(combined)) {
        detected.add(name);
      }

      return Array.from(detected);
    }),

  /**
   * Test a custom integration by sending a sample lead and returning the full request/response.
   * Returns: requestPreview (headers + body), rawResponse, parsedResponse, success, durationMs.
   */
  testIntegration: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        /** Optional custom variable overrides for the test (e.g. offer_id, stream) */
        variableOverrides: z.record(z.string(), z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [site] = await db
        .select()
        .from(targetWebsites)
        .where(and(eq(targetWebsites.id, input.id), eq(targetWebsites.userId, ctx.user.id)))
        .limit(1);
      if (!site) throw new Error("Website not found");

      // Sample lead for testing
      const sampleLead = {
        leadgenId: "test_lead_12345",
        fullName: "Test User",
        phone: "+998901234567",
        email: "test@example.com",
        pageId: "test_page_id",
        formId: "test_form_id",
      };

      const varOverrides = input.variableOverrides ?? {};
      const t0 = Date.now();

      const result = await sendAffiliateOrderByTemplate(
        site.templateType as TemplateType,
        site.templateConfig as TemplateConfig,
        sampleLead,
        varOverrides,
        site.url  // pass site.url for custom templates
      );

      const durationMs = Date.now() - t0;

      // Build request preview (what was sent)
      const cfg = (site.templateConfig ?? {}) as Record<string, unknown>;
      let requestPreview: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body: unknown;
      } | null = null;

      if (site.templateType === "custom") {
        const varCtx = buildVariableContext(sampleLead, varOverrides);
        const { body, contentTypeHeader } = _buildCustomBody(cfg, varCtx);
        const rawHeaders = (cfg.headers as Record<string, string> | undefined) ?? {};
        const injectedHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawHeaders)) {
          injectedHeaders[k] = injectVariables(v, varCtx);
        }
        if (!injectedHeaders["Content-Type"] && !injectedHeaders["content-type"]) {
          injectedHeaders["Content-Type"] = contentTypeHeader;
        }
        requestPreview = {
          url: (cfg.url as string) || site.url || "",
          method: (cfg.method as string) ?? "POST",
          headers: injectedHeaders,
          body,
        };
      }

      return {
        success: result.success,
        responseData: result.responseData,
        error: result.error,
        durationMs,
        requestPreview,
      };
    }),
});
