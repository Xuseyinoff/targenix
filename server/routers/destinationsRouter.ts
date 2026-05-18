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
import { destinations, destinationTemplates, users, integrations, orders, connections } from "../../drizzle/schema";
import { eq, desc, and, sql, gte, lt } from "drizzle-orm";
import { getDashboardDayUtcBounds } from "../lib/dashboardTimezone";
import { encrypt, decrypt } from "../encryption";
import {
  sendAffiliateOrderByTemplate,
  sendLeadViaTemplate,
  buildBody,
  buildCustomBody as _buildCustomBody,
  extractCustomVariableNames,
} from "../services/affiliateService";

import { assertSafeOutboundUrl } from "../lib/urlSafety";
import { loadConnectionForDelivery } from "../integrations/dispatch";
import {
  fetchDestinationTemplatesWithOverlayByIds,
  findAppActionIdForTemplate,
  getEndpointUrlByTemplateAppKey,
  listActiveDestinationTemplatesForPicker,
  loadDynamicExecutionTemplate,
  preferAppActionEndpointUrl,
} from "../integrations/dynamicTemplateSource";
import type { Connection } from "../../drizzle/schema";
import { checkUserRateLimit } from "../lib/userRateLimit";
import { insertApiKeyConnection } from "../services/connectionService";

async function validateTargetUrl(url: string): Promise<void> {
  await assertSafeOutboundUrl(url);
}

// ─── Dispatch-type resolution (templateType → appKey transition) ─────────────
// Phase 1 of templateType removal: the create/update API now accepts BOTH a
// legacy `templateType` discriminator AND a modern `appKey`. Internally we
// always work with one resolved dispatch type. Once Phase 2 ships and every
// client sends `appKey` only, the `templateType` input field is removed.

type DispatchType =
  | "sotuvchi"
  | "100k"
  | "custom"
  | "telegram"
  | "google-sheets"
  | "http-api-key"
  | "http-request";

/** appKeys that funnel through the http-api-key create branch (HTTP_API_KEY +
 *  OAuth2 CRM manifests — both share the same create surface). The retired
 *  webhook-json / crm-generic keys are intentionally absent: every legacy
 *  destination using them was either zero in prod (audit) or has been
 *  migrated to `http-request` via tooling/migrate-to-http-request.mjs. */
const HTTP_API_KEY_DISPATCH_APP_KEYS: ReadonlySet<string> = new Set([
  "eskiz-sms", "playmobile-sms", "openai",
  "bitrix24", "amocrm",
  "hubspot", "kommo", "pipedrive",
]);

const DIRECT_DISPATCH_KEYS: ReadonlySet<DispatchType> = new Set<DispatchType>([
  "sotuvchi", "100k", "custom", "telegram", "google-sheets",
]);

function resolveDispatchType(input: { appKey?: string }): DispatchType {
  const k = input.appKey?.trim();
  if (k) {
    if (DIRECT_DISPATCH_KEYS.has(k as DispatchType)) return k as DispatchType;
    if (HTTP_API_KEY_DISPATCH_APP_KEYS.has(k)) return "http-api-key";
    if (k === "http-request") return "http-request";
  }
  throw new Error("`appKey` is required to create a destination");
}

/** Update variant — if no `appKey` is provided in the input, preserve the
 *  current dispatch type from the existing destination row's appKey. */
function resolveDispatchTypeForUpdate(
  input: { appKey?: string },
  site: { appKey: string },
): DispatchType {
  const k = input.appKey?.trim();
  if (k) {
    if (DIRECT_DISPATCH_KEYS.has(k as DispatchType)) return k as DispatchType;
    if (HTTP_API_KEY_DISPATCH_APP_KEYS.has(k)) return "http-api-key";
    if (k === "http-request") return "http-request";
  }
  // Map site.appKey back to dispatch type — http-api-key apps map to "http-api-key"
  // dispatch; direct types map to themselves.
  const sk = site.appKey;
  if (DIRECT_DISPATCH_KEYS.has(sk as DispatchType)) return sk as DispatchType;
  if (HTTP_API_KEY_DISPATCH_APP_KEYS.has(sk)) return "http-api-key";
  if (sk === "http-request") return "http-request";
  return "custom";
}

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

/** Allowed values for `destinations.list` → `category` (matches `destination_templates.category`). */
const DESTINATION_LIST_CATEGORIES = ["messaging", "data", "webhooks", "affiliate", "crm"] as const;
type DestinationListCategory = (typeof DESTINATION_LIST_CATEGORIES)[number];

function isDestinationListCategory(v: unknown): v is DestinationListCategory {
  return typeof v === "string" && (DESTINATION_LIST_CATEGORIES as readonly string[]).includes(v);
}

/** When `templateId` is null — derive from `appKey`. Unknown keys → affiliate. */
function categoryFromAppKey(appKey: string): DestinationListCategory {
  switch (appKey) {
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
 * 2) Else derive from `appKey` (telegram → messaging, custom → webhooks, etc.).
 */
function resolveListDestinationCategory(
  templateId: number | null | undefined,
  dbCategory: string | null | undefined,
  appKey: string,
): DestinationListCategory {
  if (templateId != null && isDestinationListCategory(dbCategory)) {
    return dbCategory;
  }
  return categoryFromAppKey(appKey);
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

export const destinationsRouter = router({
  /** List all destinations for the authenticated user (secrets masked). */
  list: protectedProcedure
    .input(
      z
        .object({
          /**
           * Destinations Cleanup Sprint, PR 2/4. Default false — the destination
           * picker (and the Connections page surface) must NOT show rows that
           * are private to another integration. PR 1's edit-destination dialog
           * (which fetches a specific row by id to pre-fill the form) sets this
           * to true so it can prefill a row regardless of privacy state.
           */
          includePrivate: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
    const db = await getDb();
    if (!db) return [];
    const includePrivate = input?.includePrivate ?? false;
    const rows = await db
      .select()
      .from(destinations)
      .where(
        and(
          eq(destinations.userId, ctx.user.id),
          includePrivate ? undefined : sql`${destinations.parentIntegrationId} IS NULL`,
        ),
      )
      .orderBy(desc(destinations.createdAt));

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
      const tplById = await fetchDestinationTemplatesWithOverlayByIds(db, templateIds);
      for (const id of templateIds) {
        const t = tplById.get(id);
        if (!t) continue;
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
        r.appKey,
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
        /** `appKey` is the destination type discriminator. Required. */
        appKey: z.string().min(1).max(64),
        /** For http-api-key apps — all form field values (except connectionId) */
        templateConfig: z.record(z.string(), z.any()).optional(),
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
        /**
         * Destinations Cleanup Sprint, PR 2/4. When set, marks this destination
         * as private to that integration: it won't appear in the destination
         * picker for OTHER integrations, won't show on the Connections page,
         * and will be hard-deleted alongside the parent integration (PR 3).
         * Validated to belong to this user before insert. Omit (or null) for
         * the historical shared semantics.
         */
        parentIntegrationId: z.number().int().positive().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Abuse guard: a real user setting up destinations creates a handful
      // per session — 30/min is generous headroom while still blocking a
      // script that would otherwise insert thousands of rows.
      checkUserRateLimit(ctx.user.id, "destinationCreate", {
        max: 30,
        windowMs: 60_000,
        message: "Too many destinations created. Max 30 per minute.",
      });

      const db = await getDb();
      if (!db) throw new Error("DB not available");

      // Phase 1 — derive dispatch type from EITHER templateType (legacy) or
      // appKey (modern). Throws if neither is provided.
      const dispatchType = resolveDispatchType(input);

      // Destinations Cleanup Sprint, PR 2/4 — ownership-check the parent
      // integration before storing the reference. The picker won't surface
      // foreign integrations to the user, so a mismatch here means someone
      // is hand-crafting a request — reject rather than silently ignoring.
      let validatedParentIntegrationId: number | null = null;
      if (input.parentIntegrationId != null) {
        const [parentOk] = await db
          .select({ id: integrations.id })
          .from(integrations)
          .where(
            and(
              eq(integrations.id, input.parentIntegrationId),
              eq(integrations.userId, ctx.user.id),
            ),
          )
          .limit(1);
        if (!parentOk) throw new Error("Parent integration not found");
        validatedParentIntegrationId = parentOk.id;
      }

      // Defence-in-depth SSRF check on the http-request URL at create time.
      // The httpRequestAdapter re-runs this at dispatch, but failing here
      // gives the user a friendly error in the wizard instead of a silent
      // saved-but-broken destination they only discover when leads fail.
      if (dispatchType === "http-request") {
        const url = (input.templateConfig?.url ?? "") as string;
        if (typeof url === "string" && url.trim()) {
          await assertSafeOutboundUrl(url.trim());
        }
      }

      // Single source of truth for the parent-integration write — spread
      // into every dispatch-type's insert below so a "shared" destination
      // (no parent) just omits the column, defaulting it to NULL.
      const parentSpread =
        validatedParentIntegrationId != null
          ? { parentIntegrationId: validatedParentIntegrationId }
          : {};

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
            oauthTokenId: connections.oauthTokenId,
          })
          .from(connections)
          .where(eq(connections.id, input.connectionId))
          .limit(1);
        if (!cx || cx.userId !== ctx.user.id) {
          throw new Error("Connection not found");
        }
        if (dispatchType === "google-sheets" && cx.type !== "google_sheets") {
          throw new Error("Selected connection is not a Google Sheets connection");
        }
        if (dispatchType === "telegram" && cx.type !== "telegram_bot") {
          throw new Error("Selected connection is not a Telegram bot connection");
        }
        validatedConnectionId = cx.id;

        // For google-sheets, derive `googleAccountId` in templateConfig from
        // `oauth_tokens.id` (stored in connections.oauthTokenId) when the form
        // did not send it explicitly.
        if (
          dispatchType === "google-sheets" &&
          !input.googleAccountId &&
          cx.oauthTokenId
        ) {
          input = { ...input, googleAccountId: cx.oauthTokenId };
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
      if (dispatchType === "telegram") {
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
        const [inserted] = await db.insert(destinations).values({
          userId: ctx.user.id,
          name: input.name,
          url: null,
          appKey: "telegram",
          templateConfig: config,
          color: "#0088cc",
          isActive: true,
          ...(validatedConnectionId ? { connectionId: validatedConnectionId } : {}),
          ...parentSpread,
        });
        const id = (inserted as unknown as { insertId?: number })?.insertId;
        return { success: true, id, name: input.name, appKey: "telegram" as const };
      }

      // Google Sheets — append row per lead (no HTTP affiliate URL)
      if (dispatchType === "google-sheets") {
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
        const [inserted] = await db.insert(destinations).values({
          userId: ctx.user.id,
          name: input.name,
          url: null,
          appKey: "google-sheets",
          templateConfig: config,
          color: "#0F9D58",
          isActive: true,
          ...(autoChatId ? { telegramChatId: autoChatId } : {}),
          ...(validatedConnectionId ? { connectionId: validatedConnectionId } : {}),
          ...parentSpread,
        });
        const id = (inserted as unknown as { insertId?: number })?.insertId;
        return { success: true, id, name: input.name, appKey: "google-sheets" as const };
      }

      // HTTP API-key apps (Eskiz SMS, PlayMobile, Bitrix24, Webhook, etc.)
      // The manifest executionEndpoint provides the URL at delivery time —
      // we only need to store appKey + templateConfig + connectionId.
      if (dispatchType === "http-api-key") {
        if (!input.appKey?.trim()) throw new Error("appKey is required for app destinations");
        const [inserted] = await db.insert(destinations).values({
          userId:         ctx.user.id,
          name:           input.name,
          url:            null,
          appKey:         input.appKey.trim(),
          templateConfig: input.templateConfig ?? {},
          isActive:       true,
          ...(validatedConnectionId ? { connectionId: validatedConnectionId } : {}),
          ...parentSpread,
        });
        const id = (inserted as unknown as { insertId?: number })?.insertId;
        return { success: true, id, name: input.name, appKey: input.appKey.trim() };
      }

      // Universal HTTP Request — auth lives inline inside templateConfig
      // (no connection row), so storage matches the http-api-key branch but
      // without the `connectionId` reference. The delivery path picks up
      // `httpRequestAdapter` via resolveAdapterKey when `appKey === "http-request"`.
      if (dispatchType === "http-request") {
        const [inserted] = await db.insert(destinations).values({
          userId:         ctx.user.id,
          name:           input.name,
          url:            null,
          appKey:         "http-request",
          templateConfig: input.templateConfig ?? {},
          isActive:       true,
          ...parentSpread,
        });
        const id = (inserted as unknown as { insertId?: number })?.insertId;
        return { success: true, id, name: input.name, appKey: "http-request" };
      }

      // Build URL — resolve from destination_templates by appKey for known affiliate types
      let url = "";
      if (dispatchType === "sotuvchi" || dispatchType === "100k") {
        const ep = await getEndpointUrlByTemplateAppKey(db, dispatchType);
        if (!ep) throw new Error(`Destination template not found for type: ${dispatchType}`);
        url = ep;
      } else {
        url = input.url ?? "";
      }

      // For custom templates the user provides the URL — validate it before storing
      if (dispatchType === "custom" && url) {
        await validateTargetUrl(url);
      }

      // Build templateConfig
      const config: Record<string, unknown> = {};
      if (input.apiKey) {
        config.apiKeyEncrypted = encrypt(input.apiKey);
      }
      if (dispatchType === "custom") {
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

      const [inserted] = await db.insert(destinations).values({
        userId: ctx.user.id,
        name: input.name,
        url,
        appKey: dispatchType,
        templateConfig: config,
        ...(autoChatId ? { telegramChatId: autoChatId } : {}),
        isActive: true,
        ...parentSpread,
      });
      const id = (inserted as unknown as { insertId?: number })?.insertId;
      return {
        success: true,
        id,
        name: input.name,
        appKey: dispatchType,
      };
    }),

  /** Update a target website. Only owner can update. */
  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).optional(),
        appKey: z.string().min(1).max(64).optional(),
        templateConfig: z.record(z.string(), z.any()).optional(),
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
      // Updates are more frequent than creates (rename, toggle, re-map) —
      // 60/min is comfortable for legitimate editing yet still bounded.
      checkUserRateLimit(ctx.user.id, "destinationUpdate", {
        max: 60,
        windowMs: 60_000,
        message: "Too many destination updates. Max 60 per minute.",
      });

      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [site] = await db
        .select()
        .from(destinations)
        .where(and(eq(destinations.id, input.id), eq(destinations.userId, ctx.user.id)))
        .limit(1);
      if (!site) throw new Error("Website not found");

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) updates.name = input.name;
      if (input.isActive !== undefined) updates.isActive = input.isActive;

      // Phase 1 — derive effective dispatch type for downstream branching.
      // Equals input dispatch type if one was provided (templateType OR appKey),
      // else preserves the existing site.appKey.
      const effectiveDispatchType = resolveDispatchTypeForUpdate(input, site);
      const dispatchTypeChanged = effectiveDispatchType !== site.appKey;

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
            oauthTokenId: connections.oauthTokenId,
          })
          .from(connections)
          .where(eq(connections.id, input.connectionId))
          .limit(1);
        if (!cx || cx.userId !== ctx.user.id) {
          throw new Error("Connection not found");
        }
        if (effectiveDispatchType === "google-sheets" && cx.type !== "google_sheets") {
          throw new Error("Selected connection is not a Google Sheets connection");
        }
        if (effectiveDispatchType === "telegram" && cx.type !== "telegram_bot") {
          throw new Error("Selected connection is not a Telegram bot connection");
        }
        updates.connectionId = cx.id;

        if (
          effectiveDispatchType === "google-sheets" &&
          input.googleAccountId === undefined &&
          cx.oauthTokenId
        ) {
          input = { ...input, googleAccountId: cx.oauthTokenId };
        }
      }

      // Rebuild config if any config fields changed
      const hasConfigChange = input.apiKey !== undefined || dispatchTypeChanged ||
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

        if (effectiveDispatchType === "telegram") {
          if (input.botToken?.trim()) newConfig.botTokenEncrypted = encrypt(input.botToken);
          if (input.chatId !== undefined) newConfig.chatId = input.chatId.trim();
          if (input.messageTemplate !== undefined) newConfig.messageTemplate = input.messageTemplate;
        } else if (effectiveDispatchType === "google-sheets") {
          if (input.googleAccountId !== undefined) newConfig.googleAccountId = input.googleAccountId;
          if (input.spreadsheetId !== undefined) newConfig.spreadsheetId = input.spreadsheetId.trim();
          if (input.sheetName !== undefined) newConfig.sheetName = input.sheetName.trim();
          if (input.sheetHeaders !== undefined) newConfig.sheetHeaders = input.sheetHeaders;
          if (input.mapping !== undefined) newConfig.mapping = input.mapping;
        } else {
          if (input.apiKey) {
            newConfig.apiKeyEncrypted = encrypt(input.apiKey);
          }
          if (effectiveDispatchType === "custom") {
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

        if (dispatchTypeChanged) {
          updates.appKey = effectiveDispatchType;
          if (effectiveDispatchType === "sotuvchi" || effectiveDispatchType === "100k") {
            const ep = await getEndpointUrlByTemplateAppKey(db, effectiveDispatchType);
            if (!ep) throw new Error(`Destination template not found for type: ${effectiveDispatchType}`);
            updates.url = ep;
          } else if (effectiveDispatchType === "telegram") { /* no url needed */ }
          else if (effectiveDispatchType === "google-sheets") {
            updates.url = null;
          }
          else if (input.url) {
            await validateTargetUrl(input.url);
            updates.url = input.url;
          }
        } else if (input.url) {
          if (site.appKey === "custom") await validateTargetUrl(input.url);
          updates.url = input.url;
        }
      }

      await db.update(destinations).set(updates).where(and(eq(destinations.id, input.id), eq(destinations.userId, ctx.user.id)));
      return { success: true };
    }),

  /**
   * Destinations Cleanup Sprint, PR 2/4 — late-binding for the
   * private-destination flow.
   *
   * The wizard creates the destination BEFORE the integration row exists
   * (so the user can configure the HTTP webhook inline at action-step time).
   * Once the user clicks Publish and the integration is saved, the client
   * calls this proc to set parentIntegrationId. From that point the
   * destination is filtered out of every other integration's picker and
   * cascade-deleted with its parent (PR 3).
   *
   * Refuses to:
   *  - re-parent a destination that is ALREADY private (avoids cross-
   *    integration capture; UI shouldn't surface this case anyway)
   *  - link to a foreign integration (ownership check + parent-tenant
   *    check)
   *
   * Returns the new parentIntegrationId on success so the client can
   * confirm rather than guess.
   */
  attachToIntegration: protectedProcedure
    .input(
      z.object({
        destinationId: z.number().int().positive(),
        integrationId: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [dest] = await db
        .select({
          id: destinations.id,
          parentIntegrationId: destinations.parentIntegrationId,
        })
        .from(destinations)
        .where(and(eq(destinations.id, input.destinationId), eq(destinations.userId, ctx.user.id)))
        .limit(1);
      if (!dest) throw new Error("Destination not found");
      if (dest.parentIntegrationId != null && dest.parentIntegrationId !== input.integrationId) {
        throw new Error("Destination already private to a different integration");
      }

      const [parent] = await db
        .select({ id: integrations.id })
        .from(integrations)
        .where(and(eq(integrations.id, input.integrationId), eq(integrations.userId, ctx.user.id)))
        .limit(1);
      if (!parent) throw new Error("Integration not found");

      await db
        .update(destinations)
        .set({ parentIntegrationId: input.integrationId })
        .where(and(eq(destinations.id, input.destinationId), eq(destinations.userId, ctx.user.id)));
      return { success: true, parentIntegrationId: input.integrationId };
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
        .from(destinations)
        .where(and(eq(destinations.id, input.id), eq(destinations.userId, ctx.user.id)))
        .limit(1);
      if (!site || site.appKey !== "custom") return [];
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
        .from(destinations)
        .where(and(eq(destinations.id, input.id), eq(destinations.userId, ctx.user.id)))
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

        // NOTE: We used to always write the updated encrypted secrets back into
        // destinations.templateConfig as well as the linked connection (two DB writes).
        //
        // For zero-downtime + backward compatibility, we now prefer a single
        // source of truth when a connection is linked: the connection row.
        //
        // We only write templateConfig.secrets when there is NO linked connection
        // to sync to (legacy/template-only destinations).
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

          // Double-write fix:
          // - If this Save only changed secrets, we already persisted them into
          //   the linked connection. Avoid a second write to destinations.
          // - If the Save also changed name/isActive, we still need that write.
          const nonSecretUpdates: Record<string, unknown> = {};
          if (input.name !== undefined) nonSecretUpdates.name = input.name;
          if (input.isActive !== undefined) nonSecretUpdates.isActive = input.isActive;

          const hasNonSecretUpdates = Object.keys(nonSecretUpdates).length > 0;
          if (hasNonSecretUpdates) {
            await tx
              .update(destinations)
              .set(nonSecretUpdates)
              .where(
                and(eq(destinations.id, input.id), eq(destinations.userId, ctx.user.id)),
              );
          }
        });
      } else {
        // Legacy path: no linked connection, so we store secrets in templateConfig.
        await db
          .update(destinations)
          .set(updates)
          .where(and(eq(destinations.id, input.id), eq(destinations.userId, ctx.user.id)));
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
    return listActiveDestinationTemplatesForPicker(db);
  }),

  /**
   * Create a destinations row from an EXISTING api_key connection —
   * Make.com/Zapier's "reuse an app I've already connected" shortcut used by
   * the wizard's Action picker.
   *
   * Why this is a dedicated mutation rather than a variant of
   * `createFromTemplate`:
   *   • The user never retypes the secret. We copy the already-encrypted
   *     secret bytes straight from `connections.credentialsJson.secretsEncrypted`
   *     into `destinations.templateConfig.secrets`, so the same ciphertext
   *     is addressable from the delivery path (`buildBody`) without any
   *     additional decrypt/re-encrypt round-trip.
   *   • We link `destinations.connectionId` so future phases can migrate
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
      // brand new destinations row every time, so users who wired the
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
          .select({ id: destinations.id, name: destinations.name })
          .from(destinations)
          .where(
            and(
              eq(destinations.userId, ctx.user.id),
              eq(destinations.connectionId, conn.id),
              eq(destinations.templateId, template.id),
              eq(destinations.isActive, true),
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
        .select({ name: destinations.name })
        .from(destinations)
        .where(eq(destinations.userId, ctx.user.id));
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
      // `destinations.templateConfig.secrets`. The linked
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

      const actionId =
        (await findAppActionIdForTemplate(db, template.id, template.appKey)) ?? null;
      const initialUrl = await preferAppActionEndpointUrl(db, template.endpointUrl, actionId);

      const [inserted] = await db.insert(destinations).values({
        userId: ctx.user.id,
        name: finalName,
        url: initialUrl,
        templateId: template.id,
        appKey: template.appKey ?? "unknown",
        actionId,
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

  // Destinations Cleanup Sprint, PR 4/4 — getSheetHeaders + testIntegration
  // were Destinations.tsx-only. Removed alongside the page; their server-
  // side helpers (loadDynamicExecutionTemplate, sendAffiliateOrderByTemplate,
  // sendLeadViaTemplate, _buildCustomBody, etc.) are still in use by the
  // dispatch / worker paths — left alone.

  // ── Destination performance analytics ────────────────────────────────────
  // Single aggregated query: destinations → integrations → orders (LEFT JOIN)
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
          destinationId: destinations.id,
          name:          destinations.name,
          appKey:        destinations.appKey,
          templateId:    destinations.templateId,
          color:         destinations.color,
          isActive:      destinations.isActive,
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
        .from(destinations)
        .leftJoin(
          integrations,
          and(eq(integrations.destinationId, destinations.id), eq(integrations.userId, userId)),
        )
        .leftJoin(
          orders,
          and(eq(orders.integrationId, integrations.id), eq(orders.userId, userId)),
        )
        .where(eq(destinations.userId, userId))
        .groupBy(destinations.id)
        .orderBy(desc(sql`COALESCE(SUM(CASE WHEN ${orders.createdAt} >= ${last30dStart} THEN 1 ELSE 0 END), 0)`));

      return rows.map((r) => {
        const total30d   = Number(r.last30dTotal);
        const success30d = Number(r.last30dSuccess);
        const type: "custom" | "template" =
          r.appKey === "custom" && !r.templateId ? "custom" : "template";
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
        .select({ id: destinations.id })
        .from(destinations)
        .where(and(eq(destinations.id, input.destinationId), eq(destinations.userId, userId)))
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
              eq(integrations.destinationId, input.destinationId),
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
            eq(integrations.destinationId, input.destinationId),
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
