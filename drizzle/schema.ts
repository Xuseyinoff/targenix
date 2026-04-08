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

// ─── Target Websites ──────────────────────────────────────────────────────────
// A list of affiliate/CRM websites that leads are routed to.
//
// templateType: 'sotuvchi' | '100k' | 'albato' | 'custom'
// templateConfig: template-specific config JSON, e.g.:
//   sotuvchi: { apiKey, offerId, stream, regionId? }
//   100k:     { apiKey, streamId, regionId? }
//   albato:   { url, fieldMap, headers? }
//   custom:   { url, method, headers?, fieldMap?, successCondition? }
export const targetWebsites = mysqlTable("target_websites", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  /** Base URL of the target website's lead submission endpoint */
  url: text("url").notNull(),
  /** Optional static headers as JSON object */
  headers: json("headers"),
  /** Template type: sotuvchi | 100k | albato | custom */
  templateType: varchar("templateType", { length: 32 }).default("custom").notNull(),
  /** Template-specific config (api keys, field mappings, success conditions) */
  templateConfig: json("templateConfig"),
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
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  // Hot-path index: processLead queries WHERE userId=? AND isActive=1 AND pageId=? AND formId=?
  idxUserPageForm: index("idx_integrations_user_page_form").on(t.userId, t.isActive, t.pageId, t.formId),
  // FK-style index for JOIN with target_websites
  idxTargetWebsite: index("idx_integrations_target_website_id").on(t.targetWebsiteId),
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
  status: mysqlEnum("status", ["PENDING", "RECEIVED", "FAILED"]).default("PENDING").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // One lead record per (leadgenId, userId) pair — enables multi-tenant fan-out
  uqLeadgenUser: uniqueIndex("uq_leads_leadgen_user").on(t.leadgenId, t.userId),
  // Speeds up retryAllFailedLeads and WHERE userId=? AND status=? queries
  idxUserStatus: index("idx_leads_user_status").on(t.userId, t.status),
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
  retryCount: int("retryCount").default(0).notNull(),
  responseData: json("responseData"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // Speeds up: getOrdersByLead (WHERE leadId = ?) and processLead order lookup (WHERE leadId = ? AND integrationId = ?)
  idxLeadId: index("idx_orders_lead_id").on(t.leadId),
  // Speeds up: getOrderStats (WHERE userId = ?) and any filter by userId + status
  // e.g. SELECT COUNT(*) ... WHERE userId = ? (covers SUM(CASE WHEN status = ...) aggregations)
  idxUserStatus: index("idx_orders_user_status").on(t.userId, t.status),
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
  // Admin filter by logType
  idxLogType: index("idx_app_logs_log_type").on(t.logType),
  // Admin filter by eventType
  idxEventType: index("idx_app_logs_event_type").on(t.eventType),
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
