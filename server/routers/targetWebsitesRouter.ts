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
import { targetWebsites, destinationTemplates, users, integrations, orders, connections } from "../../drizzle/schema";
import { eq, desc, and, sql, gte, lt, inArray } from "drizzle-orm";
import { getDashboardDayUtcBounds } from "../lib/dashboardTimezone";
import { encrypt, decrypt } from "../encryption";
import {
  sendAffiliateOrderByTemplate,
  sendLeadViaTemplate,
  buildBody,
  buildVariableContext,
  buildCustomBody as _buildCustomBody,
  injectVariables,
  extractCustomVariableNames,
  type TemplateType,
  type TemplateConfig,
} from "../services/affiliateService";

import { assertSafeOutboundUrl } from "../lib/urlSafety";
import { loadConnectionForDelivery } from "../integrations/dispatch";
import type { Connection } from "../../drizzle/schema";
import { checkUserRateLimit } from "../lib/userRateLimit";
import { sendTelegramRawMessage } from "../services/telegramService";
import {
  appendLeadToGoogleSheet,
  buildGoogleSheetsAppendRow,
  getGoogleSheetHeaders,
} from "../services/googleSheetsService";
import { insertApiKeyConnection } from "../services/connectionService";

async function validateTargetUrl(url: string): Promise<void> {
  await assertSafeOutboundUrl(url);
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

/** Mask secrets in templateConfig before sending to client */
function maskConfig(config: unknown): unknown {
  if (!config || typeof config !== "object") return config;
  const c = { ...(config as Record<string, unknown>) };
  // Legacy: sotuvchi/100k apiKeyEncrypted
  if (c.apiKeyEncrypted) {
    delete c.apiKeyEncrypted;
    c.apiKeyMasked = "••••••••";
  }
  // Telegram: botTokenEncrypted
  if (c.botTokenEncrypted) {
    delete c.botTokenEncrypted;
    c.botTokenMasked = "••••••••";
  }
  // Dynamic template: secrets map — mask all values
  if (c.secrets && typeof c.secrets === "object") {
    const masked: Record<string, string> = {};
    for (const key of Object.keys(c.secrets as Record<string, unknown>)) {
      masked[key] = "••••••••";
    }
    c.secrets = masked;
  }

  // Custom templates: user can put secret-like values directly into bodyFields / headers.
  // Mask common secret-bearing keys to prevent leaking credentials to the frontend.
  const isSecretKey = (k: string): boolean => {
    const kk = k.toLowerCase();
    return (
      kk.includes("api_key") ||
      kk.includes("apikey") ||
      kk.includes("authorization") ||
      kk.includes("secret") ||
      kk.includes("token") ||
      kk.includes("password")
    );
  };

  if (Array.isArray(c.bodyFields)) {
    const maskedBodyFields = (c.bodyFields as Array<Record<string, unknown>>).map((f) => {
      const key = String(f.key ?? "");
      const value = f.value;
      const keyLooksSecret = isSecretKey(key);
      const valueIsString = typeof value === "string";
      const isTemplateVar = valueIsString ? (value as string).includes("{{") : false;
      return {
        ...f,
        value:
          keyLooksSecret && valueIsString && !isTemplateVar ? "••••••••" : value,
      };
    });
    c.bodyFields = maskedBodyFields;
  }

  if (c.headers && typeof c.headers === "object") {
    const headers = { ...(c.headers as Record<string, unknown>) };
    for (const [hk, hv] of Object.entries(headers)) {
      if (!isSecretKey(hk)) continue;
      if (typeof hv === "string" && !hv.includes("{{")) {
        headers[hk] = "••••••••";
      }
    }
    c.headers = headers;
  }

  return c;
}

/** Allowed values for `targetWebsites.list` → `category` (matches `destination_templates.category`). */
const DESTINATION_LIST_CATEGORIES = ["messaging", "data", "webhooks", "affiliate", "crm"] as const;
type DestinationListCategory = (typeof DESTINATION_LIST_CATEGORIES)[number];

function isDestinationListCategory(v: unknown): v is DestinationListCategory {
  return typeof v === "string" && (DESTINATION_LIST_CATEGORIES as readonly string[]).includes(v);
}

/** When `templateId` is null — derive from legacy `templateType`. Unknown types → affiliate. */
function categoryFromTemplateType(templateType: string): DestinationListCategory {
  switch (templateType) {
    case "telegram":
      return "messaging";
    case "custom":
      return "webhooks";
    case "sotuvchi":
    case "100k":
      return "affiliate";
    case "google-sheets":
      return "data";
    default:
      return "affiliate";
  }
}

/**
 * UI category for a destination row. Does not affect delivery.
 * 1) If `templateId` is set and the template row has a valid `category` → use it.
 * 2) Else derive from `templateType` (telegram → messaging, custom → webhooks, etc.).
 */
function resolveListDestinationCategory(
  templateId: number | null | undefined,
  dbCategory: string | null | undefined,
  templateType: string,
): DestinationListCategory {
  if (templateId != null && isDestinationListCategory(dbCategory)) {
    return dbCategory;
  }
  return categoryFromTemplateType(templateType);
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
  /** List all target websites for the authenticated user (secrets masked). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select()
      .from(targetWebsites)
      .where(eq(targetWebsites.userId, ctx.user.id))
      .orderBy(desc(targetWebsites.createdAt));

    // Enrich with template metadata for dynamic-template destinations.
    const templateIds = Array.from(
      new Set(
        rows
          .map((r) => r.templateId)
          .filter((id): id is number => id !== null && id !== undefined),
      ),
    );

    /** Full template metadata keyed by id (only for templateIds present in this user's rows). */
    interface TplMeta {
      name: string;
      category: string;
      /** Fields auto-filled from lead — [{key, label}] — drives wizard FROM_LEAD mapping. */
      autoMappedFields: Array<{ key: string; label: string }>;
      /** Keys user fills per routing rule (e.g. ["offer_id","stream"]) — shown read-only in wizard. */
      variableFields: string[];
      /** Keys user fills once at destination creation (e.g. ["api_key"]) */
      userVisibleFields: string[];
    }
    const tplMetaById = new Map<number, TplMeta>();
    if (templateIds.length > 0) {
      const tplRows = await db
        .select({
          id: destinationTemplates.id,
          name: destinationTemplates.name,
          category: destinationTemplates.category,
          autoMappedFields: destinationTemplates.autoMappedFields,
          variableFields: destinationTemplates.variableFields,
          userVisibleFields: destinationTemplates.userVisibleFields,
        })
        .from(destinationTemplates)
        .where(inArray(destinationTemplates.id, templateIds));
      for (const t of tplRows) {
        tplMetaById.set(t.id, {
          name: t.name,
          category: t.category,
          autoMappedFields: (t.autoMappedFields as Array<{ key: string; label: string }>) ?? [],
          variableFields: (t.variableFields as string[]) ?? [],
          userVisibleFields: (t.userVisibleFields as string[]) ?? [],
        });
      }
    }

    return rows.map((r) => {
      const tplMeta = r.templateId != null ? tplMetaById.get(r.templateId) : undefined;
      const category = resolveListDestinationCategory(
        r.templateId,
        tplMeta?.category,
        r.templateType,
      );
      return {
        ...r,
        templateConfig: maskConfig(r.templateConfig),
        templateName: tplMeta?.name ?? null,
        category,
        /**
         * FROM_LEAD fields defined by the admin template.
         * Client wizard uses these to build the "Field mapping" section.
         * Empty for legacy non-template destinations → UI falls back to the
         * default name+phone schema via
         * `resolveDestManifest` (client/src/pages/IntegrationWizardV2.tsx).
         */
        autoMappedFields: tplMeta?.autoMappedFields ?? [],
        /** Keys shown read-only in the wizard "Connection config" section. */
        variableFields: tplMeta?.variableFields ?? [],
        userVisibleFields: tplMeta?.userVisibleFields ?? [],
      };
    });
  }),

  /** Create a new target website. apiKey / botToken is encrypted before saving. */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        templateType: z.enum(["sotuvchi", "100k", "custom", "telegram", "google-sheets"]),
        /** Plain-text apiKey — only for sotuvchi / 100k */
        apiKey: z.string().optional(),
        /** Google Sheets destination */
        googleAccountId: z.number().int().positive().optional(),
        spreadsheetId: z.string().optional(),
        sheetName: z.string().optional(),
        /** Google Sheets row 1 labels + column → lead field */
        sheetHeaders: z.array(z.string()).optional(),
        mapping: z.record(z.string(), z.string()).optional(),
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
        /** Telegram destination fields */
        botToken: z.string().optional(),
        chatId: z.string().optional(),
        messageTemplate: z.string().optional(),
        /** Phase 3 — link to unified connections table (optional, additive). */
        connectionId: z.number().int().positive().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [me] = await db
        .select({
          mode: users.telegramDestinationDeliveryMode,
          defaultChatId: users.telegramDestinationDefaultChatId,
        })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      const autoChatId =
        me?.mode === "ALL" && me.defaultChatId ? String(me.defaultChatId) : null;

      // Phase 3 — validate ownership of a passed-in connectionId. We do it
      // once, up-front, so downstream branches can safely forward the id.
      // If the connection belongs to another user or is of the wrong type
      // we reject the whole create call rather than silently dropping the
      // reference (would produce a destination without working credentials).
      let validatedConnectionId: number | null = null;
      if (input.connectionId) {
        const [cx] = await db
          .select({
            id: connections.id,
            userId: connections.userId,
            type: connections.type,
            googleAccountId: connections.googleAccountId,
          })
          .from(connections)
          .where(eq(connections.id, input.connectionId))
          .limit(1);
        if (!cx || cx.userId !== ctx.user.id) {
          throw new Error("Connection not found");
        }
        if (input.templateType === "google-sheets" && cx.type !== "google_sheets") {
          throw new Error("Selected connection is not a Google Sheets connection");
        }
        if (input.templateType === "telegram" && cx.type !== "telegram_bot") {
          throw new Error("Selected connection is not a Telegram bot connection");
        }
        validatedConnectionId = cx.id;

        // For google-sheets, derive googleAccountId from the connection when
        // the form did not send it explicitly — keeps templateConfig coherent
        // as a fallback for the hybrid adapter resolution.
        if (
          input.templateType === "google-sheets" &&
          !input.googleAccountId &&
          cx.googleAccountId
        ) {
          input = { ...input, googleAccountId: cx.googleAccountId };
        }
      }

      // Telegram destination — no URL needed.
      //
      // Two credential paths:
      //   A) connectionId provided → botToken + chatId are resolved from the
      //      connection at delivery time (telegramAdapter.tryResolveFromConnection).
      //      The templateConfig only needs an optional messageTemplate + an
      //      optional chatId override. This is the Make.com-style path used by
      //      the v2 wizard's inline destination creation.
      //   B) no connectionId → the caller must supply botToken + chatId
      //      inline; we encrypt the token and persist it in templateConfig.
      //      This is the legacy path used by the old destination form.
      if (input.templateType === "telegram") {
        const defaultTemplate =
          "📋 Yangi lead\n\n👤 Ism: {{full_name}}\n📞 Telefon: {{phone_number}}\n📧 Email: {{email}}";
        const config: Record<string, unknown> = {};
        if (validatedConnectionId) {
          if (input.chatId?.trim()) config.chatId = input.chatId.trim();
          config.messageTemplate = input.messageTemplate?.trim() || defaultTemplate;
        } else {
          if (!input.botToken?.trim()) throw new Error("Bot Token is required");
          if (!input.chatId?.trim()) throw new Error("Chat ID is required");
          config.botTokenEncrypted = encrypt(input.botToken);
          config.chatId = input.chatId.trim();
          config.messageTemplate = input.messageTemplate?.trim() || defaultTemplate;
        }
        const inserted = await db.insert(targetWebsites).values({
          userId: ctx.user.id,
          name: input.name,
          url: null,
          templateType: "telegram",
          templateConfig: config,
          color: "#0088cc",
          isActive: true,
          ...(validatedConnectionId ? { connectionId: validatedConnectionId } : {}),
        });
        const id = (inserted as unknown as { insertId?: number })?.insertId;
        return { success: true, id, name: input.name, templateType: "telegram" as const };
      }

      // Google Sheets — append row per lead (no HTTP affiliate URL)
      if (input.templateType === "google-sheets") {
        if (!input.googleAccountId) throw new Error("Google account is required");
        if (!input.spreadsheetId?.trim()) throw new Error("Spreadsheet ID is required");
        if (!input.sheetName?.trim()) throw new Error("Sheet name is required");
        const config: Record<string, unknown> = {
          googleAccountId: input.googleAccountId,
          spreadsheetId: input.spreadsheetId.trim(),
          sheetName: input.sheetName.trim(),
        };
        config.sheetHeaders = input.sheetHeaders ?? [];
        config.mapping = input.mapping ?? {};
        const inserted = await db.insert(targetWebsites).values({
          userId: ctx.user.id,
          name: input.name,
          url: null,
          templateType: "google-sheets",
          templateConfig: config,
          color: "#0F9D58",
          isActive: true,
          ...(autoChatId ? { telegramChatId: autoChatId } : {}),
          ...(validatedConnectionId ? { connectionId: validatedConnectionId } : {}),
        });
        const id = (inserted as unknown as { insertId?: number })?.insertId;
        return { success: true, id, name: input.name, templateType: "google-sheets" as const };
      }

      // Build URL (pre-filled for known templates)
      let url = "";
      if (input.templateType === "sotuvchi") url = "https://sotuvchi.com/api/v2/order";
      else if (input.templateType === "100k") url = "https://api.100k.uz/api/shop/v1/orders/target";
      else url = input.url ?? "";

      // For custom templates the user provides the URL — validate it before storing
      if (input.templateType === "custom" && url) {
        await validateTargetUrl(url);
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

      const inserted = await db.insert(targetWebsites).values({
        userId: ctx.user.id,
        name: input.name,
        url,
        templateType: input.templateType,
        templateConfig: config,
        ...(autoChatId ? { telegramChatId: autoChatId } : {}),
        isActive: true,
      });
      const id = (inserted as unknown as { insertId?: number })?.insertId;
      return {
        success: true,
        id,
        name: input.name,
        templateType: input.templateType,
      };
    }),

  /** Update a target website. Only owner can update. */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        templateType: z.enum(["sotuvchi", "100k", "custom", "telegram", "google-sheets"]).optional(),
        apiKey: z.string().optional(),
        googleAccountId: z.number().int().positive().optional(),
        spreadsheetId: z.string().optional(),
        sheetName: z.string().optional(),
        sheetHeaders: z.array(z.string()).optional(),
        mapping: z.record(z.string(), z.string()).optional(),
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
        /** Telegram destination fields */
        botToken: z.string().optional(),
        chatId: z.string().optional(),
        messageTemplate: z.string().optional(),
        /** Phase 3 — link/unlink unified connections row. `null` clears. */
        connectionId: z.number().int().positive().nullable().optional(),
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

      // Phase 3 — validate and apply connectionId swaps.
      // `null` explicitly clears the link. Any other value must resolve to
      // a connection owned by this user and compatible with the template.
      if (input.connectionId === null) {
        updates.connectionId = null;
      } else if (input.connectionId !== undefined) {
        const [cx] = await db
          .select({
            id: connections.id,
            userId: connections.userId,
            type: connections.type,
            googleAccountId: connections.googleAccountId,
          })
          .from(connections)
          .where(eq(connections.id, input.connectionId))
          .limit(1);
        if (!cx || cx.userId !== ctx.user.id) {
          throw new Error("Connection not found");
        }
        const effectiveType = input.templateType ?? site.templateType;
        if (effectiveType === "google-sheets" && cx.type !== "google_sheets") {
          throw new Error("Selected connection is not a Google Sheets connection");
        }
        if (effectiveType === "telegram" && cx.type !== "telegram_bot") {
          throw new Error("Selected connection is not a Telegram bot connection");
        }
        updates.connectionId = cx.id;

        if (
          effectiveType === "google-sheets" &&
          input.googleAccountId === undefined &&
          cx.googleAccountId
        ) {
          input = { ...input, googleAccountId: cx.googleAccountId };
        }
      }

      // Rebuild config if any config fields changed
      const hasConfigChange = input.apiKey !== undefined || input.templateType !== undefined ||
        input.url !== undefined || input.method !== undefined || input.headers !== undefined ||
        input.fieldMap !== undefined || input.successCondition !== undefined ||
        input.contentType !== undefined || input.variableFields !== undefined ||
        input.bodyTemplate !== undefined || input.bodyFields !== undefined ||
        input.jsonField !== undefined || input.jsonValue !== undefined ||
        input.botToken !== undefined || input.chatId !== undefined || input.messageTemplate !== undefined ||
        input.googleAccountId !== undefined || input.spreadsheetId !== undefined || input.sheetName !== undefined ||
        input.sheetHeaders !== undefined || input.mapping !== undefined;

      if (hasConfigChange) {
        const existingConfig = (site.templateConfig as Record<string, unknown>) ?? {};
        const newConfig = { ...existingConfig };

        const templateType = input.templateType ?? site.templateType;

        if (templateType === "telegram") {
          if (input.botToken?.trim()) newConfig.botTokenEncrypted = encrypt(input.botToken);
          if (input.chatId !== undefined) newConfig.chatId = input.chatId.trim();
          if (input.messageTemplate !== undefined) newConfig.messageTemplate = input.messageTemplate;
        } else if (templateType === "google-sheets") {
          if (input.googleAccountId !== undefined) newConfig.googleAccountId = input.googleAccountId;
          if (input.spreadsheetId !== undefined) newConfig.spreadsheetId = input.spreadsheetId.trim();
          if (input.sheetName !== undefined) newConfig.sheetName = input.sheetName.trim();
          if (input.sheetHeaders !== undefined) newConfig.sheetHeaders = input.sheetHeaders;
          if (input.mapping !== undefined) newConfig.mapping = input.mapping;
        } else {
          if (input.apiKey) {
            newConfig.apiKeyEncrypted = encrypt(input.apiKey);
          }
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
        }
        updates.templateConfig = newConfig;

        if (input.templateType) {
          updates.templateType = input.templateType;
          if (input.templateType === "sotuvchi") updates.url = "https://sotuvchi.com/api/v2/order";
          else if (input.templateType === "100k") updates.url = "https://api.100k.uz/api/shop/v1/orders/target";
          else if (input.templateType === "telegram") { /* no url needed */ }
          else if (input.templateType === "google-sheets") {
            updates.url = null;
          }
          else if (input.url) {
            await validateTargetUrl(input.url);
            updates.url = input.url;
          }
        } else if (input.url) {
          const effectiveType = site.templateType;
          if (effectiveType === "custom") await validateTargetUrl(input.url);
          updates.url = input.url;
        }
      }

      await db.update(targetWebsites).set(updates).where(and(eq(targetWebsites.id, input.id), eq(targetWebsites.userId, ctx.user.id)));
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
   * Used by the lead-routing wizard (IntegrationWizardV2) for custom destinations.
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
   * Update a dynamic (template-based) destination.
   * Only allows changing name and secret fields.
   * Never overwrites bodyFields, variableFields, endpointUrl, or template structure.
   */
  updateFromTemplate: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        /** New secret values keyed by field key. Empty string = keep existing. */
        secrets: z.record(z.string(), z.string()).optional(),
        isActive: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      // Multi-tenant: verify ownership
      const [site] = await db
        .select()
        .from(targetWebsites)
        .where(and(eq(targetWebsites.id, input.id), eq(targetWebsites.userId, ctx.user.id)))
        .limit(1);
      if (!site) throw new Error("Website not found");
      if (!site.templateId) throw new Error("Not a template-based destination");

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.isActive !== undefined) updates.isActive = input.isActive;

      /** Keys the user submitted with a non-empty plaintext → new ciphertext (same bytes for tw + connection). */
      let encryptedPatch: Record<string, string> | null = null;

      // Re-encrypt only the secrets that were actually changed (non-empty)
      if (input.secrets && Object.keys(input.secrets).length > 0) {
        const existingConfig = (site.templateConfig ?? {}) as Record<string, unknown>;
        const existingSecrets = (existingConfig.secrets ?? {}) as Record<string, string>;
        const updatedSecrets = { ...existingSecrets };
        encryptedPatch = {};

        for (const [key, value] of Object.entries(input.secrets)) {
          if (value.trim()) {
            const enc = encrypt(value);
            updatedSecrets[key] = enc;
            encryptedPatch[key] = enc;
          }
          // Empty string → keep existing encrypted value (user left field blank = no change)
        }

        updates.templateConfig = { ...existingConfig, secrets: updatedSecrets };
      }

      const hasSecretWrites =
        encryptedPatch != null && Object.keys(encryptedPatch).length > 0;
      const shouldSyncConnection =
        hasSecretWrites &&
        site.connectionId != null &&
        typeof site.connectionId === "number";

      if (shouldSyncConnection) {
        await db.transaction(async (tx) => {
          const [conn] = await tx
            .select()
            .from(connections)
            .where(
              and(
                eq(connections.id, site.connectionId!),
                eq(connections.userId, ctx.user.id),
              ),
            )
            .limit(1);

          if (!conn) {
            throw new Error("Linked connection not found or access denied");
          }

          if (conn.type === "api_key") {
            const creds = (conn.credentialsJson ?? {}) as Record<string, unknown>;
            const prevEnc =
              (creds.secretsEncrypted as Record<string, string> | undefined) ?? {};
            const nextEnc = { ...prevEnc, ...encryptedPatch! };
            await tx
              .update(connections)
              .set({
                credentialsJson: {
                  ...creds,
                  secretsEncrypted: nextEnc,
                },
                updatedAt: new Date(),
              })
              .where(eq(connections.id, conn.id));
          }

          await tx
            .update(targetWebsites)
            .set(updates)
            .where(
              and(eq(targetWebsites.id, input.id), eq(targetWebsites.userId, ctx.user.id)),
            );
        });
      } else {
        await db
          .update(targetWebsites)
          .set(updates)
          .where(and(eq(targetWebsites.id, input.id), eq(targetWebsites.userId, ctx.user.id)));
      }

      return { success: true };
    }),

  /**
   * Return all active admin-managed destination templates.
   * Used by TargetWebsites page to show a template picker to the user.
   */
  getTemplates: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(destinationTemplates)
      .where(eq(destinationTemplates.isActive, true))
      .orderBy(destinationTemplates.name);
  }),

  /**
   * Create a destination from an admin-managed template.
   * Encrypts all secret fields (those whose bodyFields value starts with {{SECRET:...}}).
   */
  createFromTemplate: protectedProcedure
    .input(
      z.object({
        templateId: z.number(),
        name: z.string().min(1),
        /** User-filled secret values keyed by field key (e.g. { api_key: "xxx" }) */
        secrets: z.record(z.string(), z.string()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [me] = await db
        .select({
          mode: users.telegramDestinationDeliveryMode,
          defaultChatId: users.telegramDestinationDefaultChatId,
        })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      const autoChatId =
        me?.mode === "ALL" && me.defaultChatId ? String(me.defaultChatId) : null;

      const [template] = await db
        .select()
        .from(destinationTemplates)
        .where(and(eq(destinationTemplates.id, input.templateId), eq(destinationTemplates.isActive, true)))
        .limit(1);
      if (!template) throw new Error("Template not found");

      // Encrypt each secret field provided by the user
      const encryptedSecrets: Record<string, string> = {};
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value.trim()) {
          encryptedSecrets[key] = encrypt(value);
        }
      }

      // Create a connection row so secrets live only in `connections` (same
      // contract as `createFromConnection`). Runtime delivery resolves secrets
      // via `resolveSecretsForDelivery` → active connection wins; legacy rows
      // without a link still carry `templateConfig.secrets` — never stripped here.
      const connectionId = await insertApiKeyConnection(db, {
        userId: ctx.user.id,
        templateId: template.id,
        displayName: input.name,
        secretsEncrypted: encryptedSecrets,
      });

      await db.insert(targetWebsites).values({
        userId: ctx.user.id,
        name: input.name,
        url: template.endpointUrl,
        templateType: "custom",   // backwards-compat fallback
        templateId: template.id,
        color: template.color,
        connectionId,
        templateConfig: {
          variables: {},
        },
        ...(autoChatId ? { telegramChatId: autoChatId } : {}),
        isActive: true,
      });
      return { success: true };
    }),

  /**
   * Create a target_websites row from an EXISTING api_key connection —
   * Make.com/Zapier's "reuse an app I've already connected" shortcut used by
   * the wizard's Action picker.
   *
   * Why this is a dedicated mutation rather than a variant of
   * `createFromTemplate`:
   *   • The user never retypes the secret. We copy the already-encrypted
   *     secret bytes straight from `connections.credentialsJson.secretsEncrypted`
   *     into `targetWebsites.templateConfig.secrets`, so the same ciphertext
   *     is addressable from the delivery path (`buildBody`) without any
   *     additional decrypt/re-encrypt round-trip.
   *   • We link `targetWebsites.connectionId` so future phases can migrate
   *     delivery to read secrets straight off the connection row (Phase 4).
   *   • The destination name defaults to the template name with a
   *     " (n)" suffix if one already exists — matches the wizard's "Sotuvchi.com (1)"
   *     UX the user approved.
   */
  createFromConnection: protectedProcedure
    .input(
      z.object({
        connectionId: z.number().int().positive(),
        /** Optional override; generated from template name otherwise. */
        name: z.string().trim().min(1).max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [conn] = await db
        .select({
          id: connections.id,
          userId: connections.userId,
          type: connections.type,
          displayName: connections.displayName,
          credentialsJson: connections.credentialsJson,
        })
        .from(connections)
        .where(eq(connections.id, input.connectionId))
        .limit(1);

      if (!conn || conn.userId !== ctx.user.id) {
        throw new Error("Connection not found");
      }
      if (conn.type !== "api_key") {
        throw new Error(
          `createFromConnection only supports api_key connections (got ${conn.type})`,
        );
      }

      const creds = (conn.credentialsJson ?? {}) as {
        templateId?: number;
        secretsEncrypted?: Record<string, string>;
      };
      const templateId = creds.templateId;
      if (typeof templateId !== "number") {
        throw new Error("Connection has no associated template");
      }
      const secretsEncrypted = creds.secretsEncrypted ?? {};

      const [template] = await db
        .select()
        .from(destinationTemplates)
        .where(
          and(
            eq(destinationTemplates.id, templateId),
            eq(destinationTemplates.isActive, true),
          ),
        )
        .limit(1);
      if (!template) throw new Error("Template not found or inactive");

      // ── Dedupe guard ────────────────────────────────────────────────────
      //
      // A connection is a REUSABLE credential bundle ("my 100k.uz api key")
      // — the whole point of having it is that the user should not need a
      // separate destination row per integration. Before this guard landed,
      // the wizard's "Use my 100k.uz connection" one-click button created a
      // brand new target_websites row every time, so users who wired the
      // same affiliate into three integrations ended up with "100k.uz (1)",
      // "100k.uz (2)", "100k.uz (3)" cluttering the destination list.
      //
      // The product-intent contract is 1 connection × 1 template = 1
      // destination. If that pair already has an active row, return it
      // instead of creating another. Users who genuinely want a second
      // destination with the same credential can still build one by
      // passing an explicit `name` — in that case we fall through to
      // create a fresh row (keeps power-user path open without UX
      // regression for the common case).
      if (!input.name) {
        const [reusable] = await db
          .select({ id: targetWebsites.id, name: targetWebsites.name })
          .from(targetWebsites)
          .where(
            and(
              eq(targetWebsites.userId, ctx.user.id),
              eq(targetWebsites.connectionId, conn.id),
              eq(targetWebsites.templateId, template.id),
              eq(targetWebsites.isActive, true),
            ),
          )
          .limit(1);
        if (reusable) {
          return {
            id: reusable.id,
            name: reusable.name,
            templateId: template.id,
          };
        }
      }

      // Auto-name with a " (n)" suffix if the user already has destinations
      // sharing this template name — keeps the picker self-contained while
      // avoiding duplicates that would confuse the "pick from existing" list.
      const baseName = input.name?.trim() || template.name;
      const existing = await db
        .select({ name: targetWebsites.name })
        .from(targetWebsites)
        .where(eq(targetWebsites.userId, ctx.user.id));
      let finalName = baseName;
      if (!input.name) {
        const used = new Set(existing.map((e) => e.name));
        let n = 1;
        while (used.has(finalName)) {
          finalName = `${baseName} (${n})`;
          n += 1;
        }
      }

      const [me] = await db
        .select({
          mode: users.telegramDestinationDeliveryMode,
          defaultChatId: users.telegramDestinationDefaultChatId,
        })
        .from(users)
        .where(eq(users.id, ctx.user.id))
        .limit(1);
      const autoChatId =
        me?.mode === "ALL" && me.defaultChatId ? String(me.defaultChatId) : null;

      // Stage 3 Phase 2 — STOP COPYING SECRETS into
      // `target_websites.templateConfig.secrets`. The linked
      // `connectionId` below is the single source of truth from now on;
      // `resolveSecretsForDelivery` at runtime reads
      // `connections.credentialsJson.secretsEncrypted` on every
      // delivery, so credential rotation on the connection propagates
      // instantly to every destination that references it (no more
      // stale copies to chase).
      //
      // What about old destinations? They still have
      // `templateConfig.secrets` populated from their original create
      // — untouched by this change. `resolveSecretsForDelivery` falls
      // back to that map whenever no active connection is linked, so
      // legacy rows keep delivering while Phase 3 migration links
      // connections to them. Nothing gets deleted on this path.
      //
      // Explicitly referenced to keep the typed field wired for lint;
      // silenced because the intentional omission is the whole point
      // of Phase 2.
      void secretsEncrypted;
      const [inserted] = await db.insert(targetWebsites).values({
        userId: ctx.user.id,
        name: finalName,
        url: template.endpointUrl,
        templateType: "custom",
        templateId: template.id,
        color: template.color,
        templateConfig: {
          // Intentionally no `secrets`: see Stage 3 Phase 2 note above.
          variables: {},
        },
        connectionId: conn.id,
        ...(autoChatId ? { telegramChatId: autoChatId } : {}),
        isActive: true,
      });
      const id = (inserted as unknown as { insertId?: number })?.insertId;
      if (!id) throw new Error("Failed to create destination");
      return { id, name: finalName, templateId: template.id };
    }),

  /**
   * Load row 1 of a Google Sheet tab as header labels (for column mapping UI).
   */
  getSheetHeaders: protectedProcedure
    .input(
      z.object({
        googleAccountId: z.number().int().positive(),
        spreadsheetId: z.string().min(1),
        sheetName: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      checkUserRateLimit(ctx.user.id, "getSheetHeaders", {
        max: 20,
        windowMs: 60_000,
        message: "Too many sheet header requests. Max 20 per minute.",
      });
      return getGoogleSheetHeaders({
        userId: ctx.user.id,
        googleAccountId: input.googleAccountId,
        spreadsheetId: input.spreadsheetId,
        sheetName: input.sheetName,
      });
    }),

  /**
   * Test an integration by sending a sample lead and returning the full request/response.
   *
   * For dynamic (admin-managed) templates:
   *   - Builds body ONLY from template.bodyFields
   *   - Decrypts secrets from templateConfig.secrets
   *   - Falls back to "test_[key]" for missing variable fields
   *
   * For legacy custom templates:
   *   - Uses existing sendAffiliateOrderByTemplate logic
   */
  testIntegration: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        /** Optional variable overrides for the test (e.g. offer_id, stream) */
        variableOverrides: z.record(z.string(), z.string()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      checkUserRateLimit(ctx.user.id, "testIntegration", { max: 5, windowMs: 60_000, message: "Too many test requests. Max 5 per minute." });
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [site] = await db
        .select()
        .from(targetWebsites)
        .where(and(eq(targetWebsites.id, input.id), eq(targetWebsites.userId, ctx.user.id)))
        .limit(1);
      if (!site) throw new Error("Website not found");

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

      // ── Dynamic admin-managed template ────────────────────────────────────────
      if (site.templateId) {
        const [dynTpl] = await db
          .select()
          .from(destinationTemplates)
          .where(eq(destinationTemplates.id, site.templateId))
          .limit(1);
        if (!dynTpl) throw new Error("Destination template not found");

        const varFields = (dynTpl.variableFields as string[]) ?? [];
        const existingVariables = ((site.templateConfig as Record<string, unknown>)?.variables as Record<string, string>) ?? {};
        const varOverridesWithFallback: Record<string, string> = {};
        for (const key of varFields) {
          varOverridesWithFallback[key] = varOverrides[key] ?? existingVariables[key] ?? `test_${key}`;
        }

        let testConnection: Connection | null = null;
        if (site.connectionId != null) {
          testConnection = await loadConnectionForDelivery(
            db,
            site.connectionId,
            ctx.user.id,
          );
        }

        const result = await sendLeadViaTemplate(
          dynTpl,
          site.templateConfig,
          sampleLead,
          varOverridesWithFallback,
          testConnection,
          ctx.user.id,
        );
        const durationMs = Date.now() - t0;

        // Build preview using the same body builder and mask any secret fields.
        const previewFields = buildBody(dynTpl, site, sampleLead, varOverridesWithFallback);
        for (const field of (dynTpl.bodyFields as Array<{ key: string; value: string; isSecret: boolean }>) ?? []) {
          if (field.value.startsWith("{{SECRET:") && field.value.endsWith("}}")) {
            previewFields[field.key] = "••••••••";
          }
        }

        const normalizedCt = dynTpl.contentType.toLowerCase();
        let previewBody: unknown = previewFields;
        if (normalizedCt.includes("form-urlencoded") || normalizedCt.includes("urlencoded")) {
          const p = new URLSearchParams();
          for (const [k, v] of Object.entries(previewFields)) p.append(k, v);
          previewBody = p.toString();
        }

        return {
          success: result.success,
          responseData: result.responseData,
          error: result.error,
          durationMs,
          requestPreview: {
            url: dynTpl.endpointUrl,
            method: dynTpl.method ?? "POST",
            headers: { "Content-Type": dynTpl.contentType },
            body: previewBody,
          },
        };
      }

      // ── Telegram destination test ─────────────────────────────────────────────
      if (site.templateType === "telegram") {
        const cfg = (site.templateConfig ?? {}) as { botTokenEncrypted?: string; chatId?: string; messageTemplate?: string };
        if (!cfg.botTokenEncrypted || !cfg.chatId) {
          return { success: false, responseData: null, error: "Telegram config incomplete (missing botToken or chatId)", durationMs: Date.now() - t0, requestPreview: null };
        }
        const token = decrypt(cfg.botTokenEncrypted);
        const testText = `[TEST] Yangi lead\n\nIsm: Test User\nTelefon: +998901234567\nEmail: test@example.com`;
        const result = await sendTelegramRawMessage(token, cfg.chatId, testText);
        return { success: result.success, responseData: null, error: result.error, durationMs: Date.now() - t0, requestPreview: null };
      }

      // ── Google Sheets ──────────────────────────────────────────────────────────
      if (site.templateType === "google-sheets") {
        const cfg = (site.templateConfig ?? {}) as Record<string, unknown>;
        const gidRaw = cfg.googleAccountId;
        const googleAccountId =
          typeof gidRaw === "number" && Number.isFinite(gidRaw)
            ? gidRaw
            : typeof gidRaw === "string"
              ? parseInt(String(gidRaw).trim(), 10)
              : NaN;
        const spreadsheetId = typeof cfg.spreadsheetId === "string" ? cfg.spreadsheetId.trim() : "";
        const sheetName = typeof cfg.sheetName === "string" ? cfg.sheetName.trim() : "";
        if (!Number.isFinite(googleAccountId) || googleAccountId < 1 || !spreadsheetId || !sheetName) {
          return {
            success: false,
            responseData: null,
            error: "Google Sheets config incomplete (googleAccountId, spreadsheetId, or sheetName)",
            durationMs: Date.now() - t0,
            requestPreview: {
              url: `POST spreadsheets/${spreadsheetId || "?"}/values/...:append`,
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: { values: [["Test User", "+998901234567", "test@example.com", new Date().toISOString()]] },
            },
          };
        }
        const ts = new Date().toISOString();
        const sheetHeaders = Array.isArray(cfg.sheetHeaders) ? (cfg.sheetHeaders as string[]) : null;
        const mapping =
          cfg.mapping && typeof cfg.mapping === "object" && !Array.isArray(cfg.mapping)
            ? (cfg.mapping as Record<string, string>)
            : null;
        const rowValues = buildGoogleSheetsAppendRow({
          sheetHeaders,
          mapping,
          leadPayload: { ...sampleLead, extraFields: {} },
          createdAtIso: ts,
        });
        const result = await appendLeadToGoogleSheet({
          userId: ctx.user.id,
          googleAccountId,
          spreadsheetId,
          sheetName,
          values: rowValues,
        });
        const durationMs = Date.now() - t0;
        return {
          success: result.success,
          responseData: result.responseData,
          error: result.error,
          durationMs,
          requestPreview: {
            url: `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/...:append`,
            method: "POST",
            headers: { Authorization: "Bearer ••••", "Content-Type": "application/json" },
            body: { values: [rowValues] },
          },
        };
      }

      // ── Legacy custom template ─────────────────────────────────────────────────
      let legacyConnection: Connection | null = null;
      if (site.connectionId != null) {
        legacyConnection = await loadConnectionForDelivery(
          db,
          site.connectionId,
          ctx.user.id,
        );
      }
      const result = await sendAffiliateOrderByTemplate(
        site.templateType as TemplateType,
        site.templateConfig as TemplateConfig,
        sampleLead,
        varOverrides,
        site.url ?? "",
        legacyConnection,
        ctx.user.id,
      );
      const durationMs = Date.now() - t0;

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

  // ── Destination performance analytics ────────────────────────────────────
  // Single aggregated query: targetWebsites → integrations → orders (LEFT JOIN)
  // Returns today / last_7d / last_30d counts per destination, all users' destinations.
  getDestinationStats: protectedProcedure
    .query(async ({ ctx }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return [];

      const todayBounds = getDashboardDayUtcBounds();
      const last7dStart  = new Date(todayBounds.start.getTime() - 6  * 24 * 60 * 60 * 1000);
      const last30dStart = new Date(todayBounds.start.getTime() - 29 * 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          destinationId: targetWebsites.id,
          name:          targetWebsites.name,
          templateType:  targetWebsites.templateType,
          templateId:    targetWebsites.templateId,
          color:         targetWebsites.color,
          isActive:      targetWebsites.isActive,
          // today
          todayTotal:   sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${todayBounds.start} AND ${orders.createdAt} < ${todayBounds.end} THEN 1 ELSE 0 END), 0)`,
          todaySuccess: sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${todayBounds.start} AND ${orders.createdAt} < ${todayBounds.end} AND ${orders.status} = 'SENT' THEN 1 ELSE 0 END), 0)`,
          todayFailed:  sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${todayBounds.start} AND ${orders.createdAt} < ${todayBounds.end} AND ${orders.status} = 'FAILED' THEN 1 ELSE 0 END), 0)`,
          // last_7d
          last7dTotal:   sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${last7dStart} THEN 1 ELSE 0 END), 0)`,
          last7dSuccess: sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${last7dStart} AND ${orders.status} = 'SENT' THEN 1 ELSE 0 END), 0)`,
          last7dFailed:  sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${last7dStart} AND ${orders.status} = 'FAILED' THEN 1 ELSE 0 END), 0)`,
          // last_30d
          last30dTotal:   sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${last30dStart} THEN 1 ELSE 0 END), 0)`,
          last30dSuccess: sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${last30dStart} AND ${orders.status} = 'SENT' THEN 1 ELSE 0 END), 0)`,
          last30dFailed:  sql<number>`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${last30dStart} AND ${orders.status} = 'FAILED' THEN 1 ELSE 0 END), 0)`,
        })
        .from(targetWebsites)
        .leftJoin(
          integrations,
          and(eq(integrations.targetWebsiteId, targetWebsites.id), eq(integrations.userId, userId)),
        )
        .leftJoin(
          orders,
          and(eq(orders.integrationId, integrations.id), eq(orders.userId, userId)),
        )
        .where(eq(targetWebsites.userId, userId))
        .groupBy(targetWebsites.id)
        .orderBy(desc(sql`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${last30dStart} THEN 1 ELSE 0 END), 0)`));

      return rows.map((r) => {
        const total30d   = Number(r.last30dTotal);
        const success30d = Number(r.last30dSuccess);
        const type: "custom" | "template" =
          r.templateType === "custom" && !r.templateId ? "custom" : "template";
        return {
          destinationId: r.destinationId,
          name:          r.name,
          type,
          color:         r.color,
          isActive:      r.isActive,
          today:   { total: Number(r.todayTotal),   success: Number(r.todaySuccess),   failed: Number(r.todayFailed)   },
          last7d:  { total: Number(r.last7dTotal),  success: Number(r.last7dSuccess),  failed: Number(r.last7dFailed)  },
          last30d: { total: total30d,                success: success30d,               failed: Number(r.last30dFailed) },
          successRate: total30d > 0 ? Math.round((success30d / total30d) * 100) : null,
        };
      });
    }),

  // ── Per-destination time series (drill-down chart) ────────────────────────
  getDestinationTimeSeries: protectedProcedure
    .input(z.object({
      destinationId: z.number().int().positive(),
      range: z.enum(["today", "last_7d", "last_30d"]).default("last_7d"),
    }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return { points: [] };

      // Ownership check
      const [dest] = await db
        .select({ id: targetWebsites.id })
        .from(targetWebsites)
        .where(and(eq(targetWebsites.id, input.destinationId), eq(targetWebsites.userId, userId)))
        .limit(1);
      if (!dest) return { points: [] };

      const todayBounds = getDashboardDayUtcBounds();

      if (input.range === "today") {
        const rows = await db
          .select({
            hour:   sql<number>`HOUR(CONVERT_TZ(${orders.createdAt}, '+00:00', '+05:00'))`,
            total:  sql<number>`COUNT(*)`,
            sent:   sql<number>`SUM(CASE WHEN ${orders.status} = 'SENT'   THEN 1 ELSE 0 END)`,
            failed: sql<number>`SUM(CASE WHEN ${orders.status} = 'FAILED' THEN 1 ELSE 0 END)`,
          })
          .from(orders)
          .innerJoin(
            integrations,
            and(
              eq(orders.integrationId, integrations.id),
              eq(integrations.userId, userId),
              eq(integrations.targetWebsiteId, input.destinationId),
            ),
          )
          .where(and(
            eq(orders.userId, userId),
            gte(orders.createdAt, todayBounds.start),
            lt(orders.createdAt, todayBounds.end),
          ))
          .groupBy(sql`HOUR(CONVERT_TZ(${orders.createdAt}, '+00:00', '+05:00'))`)
          .orderBy(sql`HOUR(CONVERT_TZ(${orders.createdAt}, '+00:00', '+05:00'))`);

        const byHour = new Map(rows.map((r) => [Number(r.hour), r]));
        return {
          points: Array.from({ length: 24 }, (_, h) => ({
            label:  `${String(h).padStart(2, "0")}:00`,
            total:  Number(byHour.get(h)?.total  ?? 0),
            sent:   Number(byHour.get(h)?.sent   ?? 0),
            failed: Number(byHour.get(h)?.failed ?? 0),
          })),
        };
      }

      const days      = input.range === "last_7d" ? 7 : 30;
      const startDate = new Date(todayBounds.start.getTime() - (days - 1) * 24 * 60 * 60 * 1000);

      const rows = await db
        .select({
          day:    sql<string>`DATE(CONVERT_TZ(${orders.createdAt}, '+00:00', '+05:00'))`,
          total:  sql<number>`COUNT(*)`,
          sent:   sql<number>`SUM(CASE WHEN ${orders.status} = 'SENT'   THEN 1 ELSE 0 END)`,
          failed: sql<number>`SUM(CASE WHEN ${orders.status} = 'FAILED' THEN 1 ELSE 0 END)`,
        })
        .from(orders)
        .innerJoin(
          integrations,
          and(
            eq(orders.integrationId, integrations.id),
            eq(integrations.userId, userId),
            eq(integrations.targetWebsiteId, input.destinationId),
          ),
        )
        .where(and(eq(orders.userId, userId), gte(orders.createdAt, startDate)))
        .groupBy(sql`DATE(CONVERT_TZ(${orders.createdAt}, '+00:00', '+05:00'))`)
        .orderBy(sql`DATE(CONVERT_TZ(${orders.createdAt}, '+00:00', '+05:00'))`);

      const byDay = new Map(rows.map((r) => [r.day, r]));
      return {
        points: Array.from({ length: days }, (_, i) => {
          const tashkentD = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000);
          const dayStr    = tashkentD.toISOString().slice(0, 10);
          return {
            label:  dayStr.slice(5),
            total:  Number(byDay.get(dayStr)?.total  ?? 0),
            sent:   Number(byDay.get(dayStr)?.sent   ?? 0),
            failed: Number(byDay.get(dayStr)?.failed ?? 0),
          };
        }),
      };
    }),
});
