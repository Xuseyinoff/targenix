import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ─── Users ───────────────────────────────────────────────────────────────────
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  /** bcrypt hash — only set for email/password accounts */
  passwordHash: varchar("passwordHash", { length: 255 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  /** Telegram integration fields */
  /** Telegram user ID (from message.from.id) for the system chat link */
  telegramUserId: varchar("telegramUserId", { length: 32 }),
  telegramChatId: varchar("telegramChatId", { length: 64 }),
  telegramUsername: varchar("telegramUsername", { length: 128 }),
  telegramConnectedAt: timestamp("telegramConnectedAt"),
  /** One-time token used to link a Telegram chat to this user account */
  telegramConnectToken: varchar("telegramConnectToken", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Telegram Chats (Delivery / System) ───────────────────────────────────────
export const telegramChats = mysqlTable("telegram_chats", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** Telegram chat id (group/channel/user). Unique globally to prevent cross-user linking. */
  chatId: varchar("chatId", { length: 64 }).notNull(),
  /** SYSTEM = user private chat; DELIVERY = group/channel used for lead delivery */
  type: mysqlEnum("type", ["SYSTEM", "DELIVERY"]).notNull(),
  /** Telegram chat title for groups/channels (best-effort) */
  title: varchar("title", { length: 255 }),
  /** Telegram username for channels (best-effort) */
  username: varchar("username", { length: 128 }),
  connectedAt: timestamp("connectedAt").defaultNow().notNull(),
  disconnectedAt: timestamp("disconnectedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  uqChatId: uniqueIndex("uq_telegram_chats_chat_id").on(t.chatId),
  idxUserType: index("idx_telegram_chats_user_type").on(t.userId, t.type),
}));

export type TelegramChat = typeof telegramChats.$inferSelect;
export type InsertTelegramChat = typeof telegramChats.$inferInsert;

// ─── Telegram Pending Chats (Bot-added but not yet linked) ────────────────────
export const telegramPendingChats = mysqlTable("telegram_pending_chats", {
  id: int("id").autoincrement().primaryKey(),
  /** Telegram chat id (group/channel). Unique globally. */
  chatId: varchar("chatId", { length: 64 }).notNull(),
  /** Raw Telegram chat.type: group | supergroup | channel */
  chatType: varchar("chatType", { length: 32 }).notNull(),
  title: varchar("title", { length: 255 }),
  username: varchar("username", { length: 128 }),
  /** Bot's current status per my_chat_member: member | administrator | left | kicked | ... */
  botStatus: varchar("botStatus", { length: 32 }),
  firstSeenAt: timestamp("firstSeenAt").defaultNow().notNull(),
  lastSeenAt: timestamp("lastSeenAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqChatId: uniqueIndex("uq_telegram_pending_chats_chat_id").on(t.chatId),
  idxLastSeen: index("idx_telegram_pending_chats_last_seen").on(t.lastSeenAt),
}));

export type TelegramPendingChat = typeof telegramPendingChats.$inferSelect;
export type InsertTelegramPendingChat = typeof telegramPendingChats.$inferInsert;

// ─── Password Reset Tokens ────────────────────────────────────────────────────
export const passwordResetTokens = mysqlTable("password_reset_tokens", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  token: varchar("token", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// ─── Facebook Accounts ────────────────────────────────────────────────────────
// Stores a connected Facebook User Account (obtained via User Access Token).
// One platform user can connect multiple Facebook accounts.
export const facebookAccounts = mysqlTable("facebook_accounts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** Facebook user ID (numeric string) */
  fbUserId: varchar("fbUserId", { length: 64 }).notNull(),
  /** Display name from Facebook profile */
  fbUserName: varchar("fbUserName", { length: 255 }).notNull(),
  /** Long-Lived User Access Token — stored AES-256-CBC encrypted */
  accessToken: text("accessToken").notNull(),
  /** Token expiry as Unix timestamp ms; null = never expires (business token) */
  tokenExpiresAt: timestamp("tokenExpiresAt"),
  /** Last time this account's token was successfully refreshed/reconnected */
  connectedAt: timestamp("connectedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // One FB user account per platform user (same FB account can be linked by different users)
  userFbUserUnique: uniqueIndex("uq_facebook_accounts_user_fbuser").on(t.userId, t.fbUserId),
}));

export type FacebookAccount = typeof facebookAccounts.$inferSelect;
export type InsertFacebookAccount = typeof facebookAccounts.$inferInsert;

// ─── Facebook Connections (Page-level tokens, kept for backward compat) ───────
export const facebookConnections = mysqlTable("facebook_connections", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** FK to facebookAccounts.id — which FB account this page belongs to */
  facebookAccountId: int("facebookAccountId"),
  pageId: varchar("pageId", { length: 128 }).notNull(),
  pageName: varchar("pageName", { length: 255 }).notNull(),
  /** Long-Lived Page Access Token — stored encrypted */
  accessToken: text("accessToken").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  /** Subscription status: active = subscribed OK, failed = subscribePageToApp failed, inactive = manually deactivated */
  subscriptionStatus: mysqlEnum("subscriptionStatus", ["active", "failed", "inactive"]).default("active").notNull(),
  /** Error message if subscriptionStatus = failed */
  subscriptionError: text("subscriptionError"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  // One page connection per platform user (same FB page can be connected by different users)
  userPageUnique: uniqueIndex("uq_facebook_connections_user_page").on(t.userId, t.pageId),
  // Non-unique index on pageId — speeds up webhook fan-out query: WHERE pageId = ?
  idxPageId: index("idx_facebook_connections_page_id").on(t.pageId),
}));

export type FacebookConnection = typeof facebookConnections.$inferSelect;
export type InsertFacebookConnection = typeof facebookConnections.$inferInsert;

// ─── Facebook Forms ─────────────────────────────────────────────────────────
// Stores all lead forms fetched from Facebook/Instagram pages.
// Used to enrich leads with pageName + formName without storing duplicates.
export const facebookForms = mysqlTable("facebook_forms", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  pageId: varchar("pageId", { length: 128 }).notNull(),
  pageName: varchar("pageName", { length: 255 }).notNull(),
  formId: varchar("formId", { length: 128 }).notNull(),
  formName: varchar("formName", { length: 255 }).notNull(),
  /** 'fb' = Facebook, 'ig' = Instagram */
  platform: mysqlEnum("platform", ["fb", "ig"]).default("fb").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // Unique: one form entry per user+page+form combination
  userPageFormUnique: uniqueIndex("uq_facebook_forms_user_page_form").on(t.userId, t.pageId, t.formId),
  // Speeds up: lookup by pageId+formId for lead enrichment
  idxUserPageForm: index("idx_facebook_forms_user_page_form").on(t.userId, t.pageId, t.formId),
}));

export type FacebookForm = typeof facebookForms.$inferSelect;
export type InsertFacebookForm = typeof facebookForms.$inferInsert;

// ─── Destination Templates (Admin-managed) ─────────────────────────────────────
// Admin-defined affiliate endpoint templates.
// Users pick a template when creating a destination — no code changes needed for new affiliates.
//
// bodyFields: all fields sent to endpoint, e.g.:
//   [{ key: "api_key", value: "{{SECRET:api_key}}", isSecret: true }, ...]
// userVisibleFields: fields user fills once (e.g. ["api_key"])
// variableFields:    fields user fills per routing rule (e.g. ["offer_id", "stream"])
// autoMappedFields:  fields auto-filled from lead data (e.g. [{ key: "name", label: "Full Name" }])
export const destinationTemplates = mysqlTable("destination_templates", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: varchar("description", { length: 500 }),
  color: varchar("color", { length: 7 }).default("#3B82F6").notNull(),
  endpointUrl: varchar("endpointUrl", { length: 500 }).notNull(),
  method: varchar("method", { length: 10 }).default("POST").notNull(),
  contentType: varchar("contentType", { length: 100 }).default("application/x-www-form-urlencoded").notNull(),
  /** All fields sent to endpoint. Format: [{ key, value, isSecret }] */
  bodyFields: json("bodyFields").notNull(),
  /** Keys of fields user fills once at destination creation (e.g. ["api_key"]) */
  userVisibleFields: json("userVisibleFields").notNull(),
  /** Keys of fields user fills per routing rule (e.g. ["offer_id", "stream"]) */
  variableFields: json("variableFields").notNull(),
  /** Fields auto-filled from lead (shown as info). Format: [{ key, label }] */
  autoMappedFields: json("autoMappedFields").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type DestinationTemplate = typeof destinationTemplates.$inferSelect;
export type InsertDestinationTemplate = typeof destinationTemplates.$inferInsert;

// ─── Target Websites ──────────────────────────────────────────────────────────
// A list of affiliate/CRM websites that leads are routed to.
//
// templateType: 'sotuvchi' | '100k' | 'albato' | 'custom' (legacy hardcoded)
// templateId:   FK to destinationTemplates (dynamic admin-managed templates)
// templateConfig: template-specific config JSON, e.g.:
//   legacy:  { apiKeyEncrypted, ... }
//   dynamic: { secrets: { api_key: "encrypted:..." }, variables: {} }
export const targetWebsites = mysqlTable("target_websites", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  /** Base URL of the target website's lead submission endpoint */
  url: text("url").notNull(),
  /** Optional static headers as JSON object */
  headers: json("headers"),
  /** Template type: sotuvchi | 100k | albato | custom (legacy; null when using templateId) */
  templateType: varchar("templateType", { length: 32 }).default("custom").notNull(),
  /** FK to destinationTemplates — set when created from admin-managed template */
  templateId: int("templateId"),
  /** Template-specific config (api keys, field mappings, success conditions) */
  templateConfig: json("templateConfig"),
  /** Delivery chatId for Telegram lead notifications (delivery chat only) */
  telegramChatId: varchar("telegramChatId", { length: 64 }),
  isActive: boolean("isActive").default(true).notNull(),
  /** Hex color for visual distinction in UI (e.g., #3b82f6) */
  color: varchar("color", { length: 7 }).default("#6366f1").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type TargetWebsite = typeof targetWebsites.$inferSelect;
export type InsertTargetWebsite = typeof targetWebsites.$inferInsert;

// ─── Integrations ─────────────────────────────────────────────────────────────
// LEAD_ROUTING: full pipeline — FB account → page → form → field map → target website
// TELEGRAM: notify a Telegram chat on each new lead
// AFFILIATE: POST lead to an external HTTP endpoint
export const integrations = mysqlTable("integrations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", ["TELEGRAM", "AFFILIATE", "LEAD_ROUTING"]).notNull(),
  /**
   * JSON config shape by type:
   *   LEAD_ROUTING: {
   *     facebookAccountId: number,   // facebookAccounts.id
   *     // pageId, pageName, formId, formName → dedicated columns (migrated out of JSON)
   *     nameField: string,           // FB form field key for full name
   *     phoneField: string,          // FB form field key for phone
   *     targetWebsiteId: number,     // targetWebsites.id
   *     flow: string,
   *     offerId: string,
   *   }
   *   TELEGRAM: { token: string, chatId: string }
   *   AFFILIATE: { url: string, headers: Record<string,string> }
   */
  config: json("config").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  /** Optional Telegram channel/group chat ID for lead notifications on this integration.
   *  If set, leads routed through this integration are sent to this chat.
   *  If null, notifications fall back to the user's personal Telegram (users.telegramChatId). */
  telegramChatId: varchar("telegramChatId", { length: 64 }),
  /**
   * Dedicated columns extracted from config JSON for efficient indexing.
   * Nullable during migration — backfilled by migrate-integrations-pageform.mjs.
   * For LEAD_ROUTING integrations only; NULL for TELEGRAM / AFFILIATE.
   */
  pageId: varchar("pageId", { length: 128 }),
  formId: varchar("formId", { length: 128 }),
  pageName: varchar("pageName", { length: 255 }),
  formName: varchar("formName", { length: 255 }),
  /** Dedicated FK column extracted from config.targetWebsiteId for efficient JOIN and index. */
  targetWebsiteId: int("targetWebsiteId"),
  /** Dedicated FK column extracted from config.facebookAccountId for efficient disconnect cleanup.
   *  Nullable — populated by backfill for existing rows; always set on new LEAD_ROUTING integrations.
   *  NULL for TELEGRAM / AFFILIATE types. */
  facebookAccountId: int("facebookAccountId"),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  // Hot-path index: processLead queries WHERE userId=? AND isActive=1 AND pageId=? AND formId=?
  idxUserPageForm: index("idx_integrations_user_page_form").on(t.userId, t.isActive, t.pageId, t.formId),
  // FK-style index for JOIN with target_websites
  idxTargetWebsite: index("idx_integrations_target_website_id").on(t.targetWebsiteId),
  // Index for disconnect cleanup: find all integrations tied to a given FB account
  idxFbAccount: index("idx_integrations_fb_account_id").on(t.facebookAccountId),
}));

export type Integration = typeof integrations.$inferSelect;
export type InsertIntegration = typeof integrations.$inferInsert;

// ─── Leads ────────────────────────────────────────────────────────────────────
export const leads = mysqlTable("leads", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  pageId: varchar("pageId", { length: 128 }).notNull(),
  formId: varchar("formId", { length: 128 }).notNull(),
  // Composite unique: same FB lead can be received by multiple Targenix users independently
  leadgenId: varchar("leadgenId", { length: 128 }).notNull(),
  fullName: varchar("fullName", { length: 512 }),
  phone: varchar("phone", { length: 64 }),
  email: varchar("email", { length: 320 }),
  rawData: json("rawData"),
  /** 'fb' = Facebook, 'ig' = Instagram — extracted from Graph API platform field */
  platform: mysqlEnum("platform", ["fb", "ig"]).default("fb").notNull(),
  /** Facebook Graph enrichment stage */
  dataStatus: mysqlEnum("dataStatus", ["PENDING", "ENRICHED", "ERROR"]).default("PENDING").notNull(),
  /** Integration routing aggregate outcome (independent of dataStatus) */
  deliveryStatus: mysqlEnum("deliveryStatus", ["PENDING", "PROCESSING", "SUCCESS", "FAILED", "PARTIAL"]).default("PENDING").notNull(),
  /** Set when dataStatus = ERROR (Graph/token failure) */
  dataError: text("dataError"),

  // ── Denormalized source info (copied from facebook_forms on write) ─────────
  // Eliminates N+1 queries on leads list — no JOIN needed at read time.
  pageName:  varchar("pageName",  { length: 255 }),
  formName:  varchar("formName",  { length: 255 }),

  // ── Ad attribution (from Graph API lead data) ──────────────────────────────
  // Enables campaign/ad analytics without parsing rawData JSON at query time.
  campaignId:   varchar("campaignId",   { length: 100 }),
  campaignName: varchar("campaignName", { length: 255 }),
  adsetId:      varchar("adsetId",      { length: 100 }),
  adsetName:    varchar("adsetName",    { length: 255 }),
  adId:         varchar("adId",         { length: 100 }),
  adName:       varchar("adName",       { length: 255 }),

  // ── Extra field_data values (email, city, custom fields) ──────────────────
  // Stores remaining field_data keys after name+phone extraction.
  // Keeps schema clean while preserving all form answers.
  extraFields: json("extraFields"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // One lead record per (leadgenId, userId) pair — enables multi-tenant fan-out
  uqLeadgenUser: uniqueIndex("uq_leads_leadgen_user").on(t.leadgenId, t.userId),
  // Speeds up retry scheduler and WHERE userId=? AND deliveryStatus=? queries
  idxUserDeliveryStatus: index("idx_leads_user_delivery_status").on(t.userId, t.deliveryStatus),
  idxUserDataStatus: index("idx_leads_user_data_status").on(t.userId, t.dataStatus),
  // Speeds up paginated leads dashboard (WHERE userId=? ORDER BY createdAt DESC)
  idxUserCreatedAt: index("idx_leads_user_created_at").on(t.userId, t.createdAt),
  // Speeds up per-page analytics (WHERE userId=? AND pageId=? AND deliveryStatus=?)
  idxUserPageDelivery: index("idx_leads_user_page_delivery").on(t.userId, t.pageId, t.deliveryStatus),
  // Speeds up platform filter (WHERE userId=? AND platform=? ORDER BY createdAt DESC)
  idxUserPlatformCreatedAt: index("idx_leads_user_platform_created_at").on(t.userId, t.platform, t.createdAt),
  // Speeds up formId filter (WHERE userId=? AND formId=?)
  idxUserFormId: index("idx_leads_user_form_id").on(t.userId, t.formId),
  // Speeds up campaign analytics (WHERE userId=? AND campaignId=?)
  idxUserCampaignId: index("idx_leads_user_campaign_id").on(t.userId, t.campaignId),
  // Speeds up global time-series queries (admin analytics, archival)
  idxCreatedAt: index("idx_leads_created_at").on(t.createdAt),
}));

export type Lead = typeof leads.$inferSelect;
export type InsertLead = typeof leads.$inferInsert;

// ─── Orders ───────────────────────────────────────────────────────────────────
export const orders = mysqlTable("orders", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  userId: int("userId").notNull(),
  integrationId: int("integrationId").notNull(),
  status: mysqlEnum("status", ["PENDING", "SENT", "FAILED"]).default("PENDING").notNull(),
  /** Completed delivery attempts (each HTTP/send to integration). Max 3 then auto-retry stops. */
  attempts: int("attempts").default(0).notNull(),
  lastAttemptAt: timestamp("lastAttemptAt"),
  /** After a failed delivery, set to now+1h until attempts reach max; hourly job selects due rows */
  nextRetryAt: timestamp("nextRetryAt"),
  responseData: json("responseData"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // One order row per lead per integration — idempotent retries without duplicate rows
  uqLeadIntegration: uniqueIndex("uq_orders_lead_integration").on(t.leadId, t.integrationId),
  // Speeds up: getOrdersByLead (WHERE leadId = ?) and processLead order lookup (WHERE leadId = ? AND integrationId = ?)
  idxLeadId: index("idx_orders_lead_id").on(t.leadId),
  // Speeds up: getOrderStats (WHERE userId = ?) and any filter by userId + status
  // e.g. SELECT COUNT(*) ... WHERE userId = ? (covers SUM(CASE WHEN status = ...) aggregations)
  idxUserStatus: index("idx_orders_user_status").on(t.userId, t.status),
  // Speeds up: per-integration analytics (WHERE integrationId = ? AND status = ?)
  idxIntegrationStatus: index("idx_orders_integration_status").on(t.integrationId, t.status),
  // Speeds up: time-series order analytics and archival
  idxCreatedAt: index("idx_orders_created_at").on(t.createdAt),
  // Hourly job: FAILED + due nextRetryAt
  idxRetryDue: index("idx_orders_retry_due").on(t.status, t.nextRetryAt),
}));

export type Order = typeof orders.$inferSelect;
export type InsertOrder = typeof orders.$inferInsert;

// ─── Webhook Events ───────────────────────────────────────────────────────────
export const webhookEvents = mysqlTable("webhook_events", {
  id: int("id").autoincrement().primaryKey(),
  eventType: varchar("eventType", { length: 64 }).notNull(),
  payload: json("payload").notNull(),
  signature: varchar("signature", { length: 128 }),
  verified: boolean("verified").default(false).notNull(),
  processed: boolean("processed").default(false).notNull(),
  error: text("error"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  // Speeds up ORDER BY createdAt DESC LIMIT ? on Webhook Health page
  idxCreatedAt: index("idx_webhook_events_created_at").on(t.createdAt),
}));

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type InsertWebhookEvent = typeof webhookEvents.$inferInsert;

// ─── Application Logs ───────────────────────────────────────────────────────────────────────────────
// Structured log entries for all important system events.
export const appLogs = mysqlTable("app_logs", {
  id: int("id").autoincrement().primaryKey(),
  /** Owner of this log entry — used for per-user retention policy (48h for users, 30d for admins) */
  userId: int("userId"),
  /** USER = attributed to a specific user; SYSTEM = infrastructure/HTTP/background logs */
  logType: mysqlEnum("logType", ["USER", "SYSTEM"]).default("SYSTEM").notNull(),
  /** Log level */
  level: mysqlEnum("level", ["INFO", "WARN", "ERROR", "DEBUG"]).default("INFO").notNull(),
  /** Category for filtering: WEBHOOK, LEAD, ORDER, SYSTEM, HTTP, FACEBOOK */
  category: varchar("category", { length: 64 }).notNull(),
  /** Structured event type for observability: lead_received, sent_to_telegram, error, etc. */
  eventType: varchar("eventType", { length: 64 }),
  /** Source of the event: facebook, retry, manual, system */
  source: varchar("source", { length: 64 }),
  /** Duration in milliseconds for timed operations */
  duration: int("duration"),
  /** Human-readable message */
  message: text("message").notNull(),
  /** Optional structured metadata (request body, response, error details, stack traces, etc.) */
  meta: json("meta"),
  /** Optional reference to a lead ID */
  leadId: int("leadId"),
  /** Optional reference to a page ID */
  pageId: varchar("pageId", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  // Retention cleanup + Logs page pagination filtered by user
  idxUserCreatedAt: index("idx_app_logs_user_created_at").on(t.userId, t.createdAt),
  // Admin filter by logType + time (covers ORDER BY createdAt on filtered results)
  idxLogTypeCreatedAt: index("idx_app_logs_log_type_created_at").on(t.logType, t.createdAt),
  // Admin filter by eventType + time
  idxEventTypeCreatedAt: index("idx_app_logs_event_type_created_at").on(t.eventType, t.createdAt),
  // Admin filter by level + time (ERROR/WARN dashboards)
  idxLevelCreatedAt: index("idx_app_logs_level_created_at").on(t.level, t.createdAt),
  // Global time-based queries (admin dashboard, archival cron)
  idxCreatedAt: index("idx_app_logs_created_at").on(t.createdAt),
}));

export type AppLog = typeof appLogs.$inferSelect;
export type InsertAppLog = typeof appLogs.$inferInsert;

// ─── Facebook OAuth States ───────────────────────────────────────────────────
// Stores CSRF state tokens for Facebook Authorization Code Flow.
// Each state is tied to a userId and expires after 10 minutes.
export const facebookOauthStates = mysqlTable("facebook_oauth_states", {
  id: int("id").autoincrement().primaryKey(),
  /** The random CSRF state token sent to Facebook */
  state: varchar("state", { length: 128 }).notNull().unique(),
  /** The user who initiated the OAuth flow */
  userId: int("userId").notNull(),
  /** When this state expires (10 minutes from creation) */
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  idxState: uniqueIndex("uq_facebook_oauth_states_state").on(t.state),
  idxUserId: index("idx_facebook_oauth_states_user_id").on(t.userId),
}));

export type FacebookOauthState = typeof facebookOauthStates.$inferSelect;
export type InsertFacebookOauthState = typeof facebookOauthStates.$inferInsert;

// ─── Ad Accounts Cache ────────────────────────────────────────────────────────
// Synced from Facebook Marketing API by background job (every 10 min).
// Frontend reads from this instead of calling Graph API directly.
export const adAccountsCache = mysqlTable("ad_accounts_cache", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** FK to facebookAccounts.id — which connected FB user owns this ad account */
  facebookAccountId: int("facebookAccountId").notNull(),
  /** Facebook ad account ID (act_XXXXXXXXX format) */
  fbAdAccountId: varchar("fbAdAccountId", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  /** ACTIVE | DISABLED | UNSETTLED | PENDING_RISK_REVIEW | ... */
  status: varchar("status", { length: 32 }).notNull().default("UNKNOWN"),
  statusCode: int("statusCode").notNull().default(0),
  currency: varchar("currency", { length: 8 }).notNull().default("USD"),
  timezone: varchar("timezone", { length: 64 }),
  /** Account balance in cents as string (from Facebook API) */
  balance: varchar("balance", { length: 32 }).notNull().default("0"),
  /** Total lifetime spend in cents as string */
  amountSpent: varchar("amountSpent", { length: 32 }).notNull().default("0"),
  minDailyBudget: varchar("minDailyBudget", { length: 32 }).notNull().default("0"),
  /** When this record was last synced from Facebook */
  lastSyncedAt: timestamp("lastSyncedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqUserAccount: uniqueIndex("uq_ad_accounts_cache_user_account").on(t.userId, t.fbAdAccountId),
  idxFbAccount: index("idx_ad_accounts_cache_fb_account").on(t.facebookAccountId),
}));

export type AdAccountCache = typeof adAccountsCache.$inferSelect;
export type InsertAdAccountCache = typeof adAccountsCache.$inferInsert;

// ─── Campaigns Cache ──────────────────────────────────────────────────────────
// Synced from Facebook Marketing API. One row per campaign per user.
export const campaignsCache = mysqlTable("campaigns_cache", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  facebookAccountId: int("facebookAccountId").notNull(),
  fbAdAccountId: varchar("fbAdAccountId", { length: 64 }).notNull(),
  /** Facebook campaign ID (numeric string) */
  fbCampaignId: varchar("fbCampaignId", { length: 64 }).notNull(),
  name: varchar("name", { length: 512 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("ACTIVE"),
  objective: varchar("objective", { length: 64 }).notNull().default(""),
  dailyBudget: varchar("dailyBudget", { length: 32 }).notNull().default("0"),
  lifetimeBudget: varchar("lifetimeBudget", { length: 32 }).notNull().default("0"),
  lastSyncedAt: timestamp("lastSyncedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqUserCampaign: uniqueIndex("uq_campaigns_cache_user_campaign").on(t.userId, t.fbCampaignId),
  idxUserAdAccount: index("idx_campaigns_cache_user_ad_account").on(t.userId, t.fbAdAccountId),
}));

export type CampaignCache = typeof campaignsCache.$inferSelect;
export type InsertCampaignCache = typeof campaignsCache.$inferInsert;

// ─── Ad Sets Cache ─────────────────────────────────────────────────────────────
// Synced on-demand when user drills into a campaign.
export const adSetsCache = mysqlTable("ad_sets_cache", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  facebookAccountId: int("facebookAccountId").notNull(),
  fbAdAccountId: varchar("fbAdAccountId", { length: 64 }).notNull(),
  fbCampaignId: varchar("fbCampaignId", { length: 64 }).notNull(),
  /** Facebook ad set ID (numeric string) */
  fbAdSetId: varchar("fbAdSetId", { length: 64 }).notNull(),
  name: varchar("name", { length: 512 }).notNull(),
  status: varchar("status", { length: 32 }).notNull().default("ACTIVE"),
  dailyBudget: varchar("dailyBudget", { length: 32 }).notNull().default("0"),
  lifetimeBudget: varchar("lifetimeBudget", { length: 32 }).notNull().default("0"),
  optimizationGoal: varchar("optimizationGoal", { length: 64 }),
  billingEvent: varchar("billingEvent", { length: 64 }),
  lastSyncedAt: timestamp("lastSyncedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqUserAdSet: uniqueIndex("uq_ad_sets_cache_user_adset").on(t.userId, t.fbAdSetId),
  idxUserCampaign: index("idx_ad_sets_cache_user_campaign").on(t.userId, t.fbCampaignId),
}));

export type AdSetCache = typeof adSetsCache.$inferSelect;
export type InsertAdSetCache = typeof adSetsCache.$inferInsert;

// ─── Campaign Insights Cache ──────────────────────────────────────────────────
// Stores aggregated performance metrics per campaign per date preset.
// Sourced from a single campaign-level insights API call (not per-campaign).
// Key: (userId, fbCampaignId, datePreset) — refreshed every sync cycle.
export const campaignInsightsCache = mysqlTable("campaign_insights_cache", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  facebookAccountId: int("facebookAccountId").notNull(),
  fbAdAccountId: varchar("fbAdAccountId", { length: 64 }).notNull(),
  fbCampaignId: varchar("fbCampaignId", { length: 64 }).notNull(),
  /** Frontend date preset: today | yesterday | last_7d | last_30d */
  datePreset: varchar("datePreset", { length: 32 }).notNull(),
  spend: varchar("spend", { length: 32 }).notNull().default("0"),
  impressions: int("impressions").notNull().default(0),
  clicks: int("clicks").notNull().default(0),
  leads: int("leads").notNull().default(0),
  ctr: varchar("ctr", { length: 16 }).notNull().default("0"),
  cpl: varchar("cpl", { length: 16 }).notNull().default("0"),
  conversionRate: varchar("conversionRate", { length: 16 }).notNull().default("0"),
  /** When this row was last synced from Facebook */
  syncedAt: timestamp("syncedAt").defaultNow().notNull(),
}, (t) => ({
  uqKey: uniqueIndex("uq_campaign_insights_cache_key").on(t.userId, t.fbCampaignId, t.datePreset),
  idxUserAdAccount: index("idx_campaign_insights_cache_account").on(t.userId, t.fbAdAccountId),
}));

export type CampaignInsightsCacheRow = typeof campaignInsightsCache.$inferSelect;
export type InsertCampaignInsightsCache = typeof campaignInsightsCache.$inferInsert;
