import {
  boolean,
  date,
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
  /** Last time the password was changed. JWTs issued before this timestamp
   *  are rejected by verifySession() — closes the "stolen cookie still works
   *  after password reset" hole. NULL = never reset; no session invalidation. */
  passwordChangedAt: timestamp("passwordChangedAt"),
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
  /** Destinations delivery mapping mode: ALL (auto-map) or MANUAL (per-destination). */
  telegramDestinationDeliveryMode: mysqlEnum("telegramDestinationDeliveryMode", ["ALL", "MANUAL"])
    .default("MANUAL")
    .notNull(),
  /** Default DELIVERY chat id used when mode = ALL. */
  telegramDestinationDefaultChatId: varchar("telegramDestinationDefaultChatId", { length: 64 }),
  /** Reporting currency for the Insights dashboards (ISO-4217). UZS or USD
   *  today; v2 may add more. Rollup rows snapshot this value at write time so
   *  a user changing their base currency later does not retroactively
   *  re-interpret historical numbers. */
  baseCurrency: varchar("baseCurrency", { length: 8 }).default("USD").notNull(),
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
  /**
   * Targenix user this chat belongs to, resolved from the my_chat_member
   * `from` field (the Telegram user who added the bot) matched against
   * users.telegramUserId / users.telegramChatId. NULL = added by someone we
   * can't tie to an account — falls back to the manual "enter Chat ID" path.
   */
  claimedByUserId: int("claimedByUserId"),
  firstSeenAt: timestamp("firstSeenAt").defaultNow().notNull(),
  lastSeenAt: timestamp("lastSeenAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqChatId: uniqueIndex("uq_telegram_pending_chats_chat_id").on(t.chatId),
  idxLastSeen: index("idx_telegram_pending_chats_last_seen").on(t.lastSeenAt),
  idxClaimedBy: index("idx_telegram_pending_chats_claimed_by").on(t.claimedByUserId),
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
  // One page connection per (user, FB account, page) — a single Targenix user can
  // connect the same page via two different FB accounts (business manager + personal).
  // Same FB page can also still be connected by different Targenix users independently.
  // Matches prod migration 0035_fb_multi_account_per_page.sql.
  userAccountPageUnique: uniqueIndex("uq_fb_conn_user_account_page").on(
    t.userId,
    t.facebookAccountId,
    t.pageId,
  ),
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

// ─── Universal OAuth (migration 0055) ─────────────────────────────────────────
export const oauthStates = mysqlTable(
  "oauth_states",
  {
    id: int("id").autoincrement().primaryKey(),
    state: varchar("state", { length: 128 }).notNull(),
    userId: int("userId").notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    mode: varchar("mode", { length: 32 }).notNull(),
    appKey: varchar("appKey", { length: 64 }),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    uqState: uniqueIndex("uq_oauth_states_state").on(t.state),
    idxUser: index("idx_oauth_states_user").on(t.userId),
  }),
);

export const oauthTokens = mysqlTable(
  "oauth_tokens",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    appKey: varchar("appKey", { length: 64 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 255 }),
    picture: varchar("picture", { length: 512 }),
    accessToken: text("accessToken").notNull(),
    refreshToken: text("refreshToken"),
    expiryDate: timestamp("expiryDate"),
    scopes: text("scopes"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  (t) => ({
    uqUserAppEmail: uniqueIndex("uq_oauth_tokens_user_app_email").on(
      t.userId,
      t.appKey,
      t.email,
    ),
    idxUserApp: index("idx_oauth_tokens_user_app").on(t.userId, t.appKey),
  }),
);

export type OauthTokenRow = typeof oauthTokens.$inferSelect;
export type InsertOauthTokenRow = typeof oauthTokens.$inferInsert;

// ─── Apps (authoritative app catalogue — migration 0048) ─────────────────────
// Each row defines the shape of credentials an app requires: `authType` + `fields[]`.
// The legacy `connection_app_specs` table was dropped in migration 0054.
export const apps = mysqlTable("apps", {
  id: int("id").autoincrement().primaryKey(),
  appKey: varchar("appKey", { length: 64 }).notNull().unique(),
  displayName: varchar("displayName", { length: 128 }).notNull(),
  category: varchar("category", { length: 32 }).notNull(),
  authType: varchar("authType", { length: 32 }).notNull(),
  fields: json("fields").notNull(),
  oauthConfig: json("oauthConfig"),
  iconUrl: varchar("iconUrl", { length: 512 }),
  docsUrl: varchar("docsUrl", { length: 512 }),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type AppRow = typeof apps.$inferSelect;
export type InsertAppRow = typeof apps.$inferInsert;

// ─── App actions (Stage 1 mirror of destination_templates per app) ───────────
export const appActions = mysqlTable(
  "app_actions",
  {
    id: int("id").autoincrement().primaryKey(),
    appKey: varchar("appKey", { length: 64 }).notNull(),
    actionKey: varchar("actionKey", { length: 64 }).notNull().default("default"),
    name: varchar("name", { length: 255 }).notNull(),
    endpointUrl: varchar("endpointUrl", { length: 500 }).notNull(),
    method: varchar("method", { length: 10 }).default("POST").notNull(),
    contentType: varchar("contentType", { length: 100 }),
    bodyFields: json("bodyFields").notNull(),
    userFields: json("userFields").notNull(),
    variableFields: json("variableFields").notNull(),
    autoMappedFields: json("autoMappedFields").notNull(),
    /**
     * Make.com-style action schema (MVP).
     * Stored in DB so new actions can be added/edited without deploy.
     */
    schemaVersion: int("schemaVersion").default(1).notNull(),
    inputSchema: json("inputSchema"),
    outputSchema: json("outputSchema"),
    uiSchema: json("uiSchema"),
    isDefault: boolean("isDefault").default(true).notNull(),
    isActive: boolean("isActive").default(true).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => ({
    uniqAppAction: uniqueIndex("uniq_app_action").on(t.appKey, t.actionKey),
    idxAppKey: index("idx_app_actions_appKey").on(t.appKey),
  }),
);

export type AppActionRow = typeof appActions.$inferSelect;
export type InsertAppActionRow = typeof appActions.$inferInsert;

// ─── Destination Templates (Admin-managed) ─────────────────────────────────────
// Admin-defined affiliate endpoint templates.
// Users pick a template when creating a destination — no code changes needed for new affiliates.
//
// bodyFields: all fields sent to endpoint, e.g.:
//   [{ key: "api_key", value: "{{SECRET:api_key}}", isSecret: true }, ...]
// userVisibleFields: fields user fills once (e.g. ["api_key"])
// variableFields:    fields user fills per routing rule (e.g. ["offer_id", "stream"])
// autoMappedFields:  fields auto-filled from lead data (e.g. [{ key: "name", label: "Full Name" }])
//
// appKey links this template to a connection_app_specs row. Nullable until
// every legacy row is backfilled (migration 0046 does this for the 4 current
// rows). New rows MUST set appKey — enforced by adminTemplatesRouter.
export const destinationTemplates = mysqlTable("destination_templates", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: varchar("description", { length: 500 }),
  color: varchar("color", { length: 7 }).default("#3B82F6").notNull(),
  /** Product category for scalable Destinations UI; delivery unchanged. Default affiliate = legacy templates. */
  category: mysqlEnum("category", ["messaging", "data", "webhooks", "affiliate", "crm"])
    .default("affiliate")
    .notNull(),
  /** FK-in-spirit → connection_app_specs.appKey. See block comment above. */
  appKey: varchar("appKey", { length: 64 }),
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
}, (t) => ({
  idxAppKey: index("idx_destination_templates_appKey").on(t.appKey),
}));

export type DestinationTemplate = typeof destinationTemplates.$inferSelect;
export type InsertDestinationTemplate = typeof destinationTemplates.$inferInsert;

// ─── Connections (unified credential store) ──────────────────────────────────
// A per-user library of reusable connections (Google Sheets accounts, Telegram
// bots, future API keys). Replaces scattered credential storage inside
// destinations.templateConfig. Step 1 scaffold — additive only; delivery
// code still reads from templateConfig until adapters migrate to connectionId.
//
// Credentials storage by type:
//   google_sheets → oauthTokenId → oauth_tokens (universal OAuth); googleAccountId legacy
//   telegram_bot  → credentialsJson = { botTokenEncrypted, chatId }
//   api_key       → credentialsJson = { apiKeyEncrypted, ... }
export const connections = mysqlTable("connections", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** DB: VARCHAR(32) since migration 0053 — was ENUM; app still restricts to known types in routers. */
  type: varchar("type", { length: 32 }).notNull(),
  /**
   * FK-in-spirit → connection_app_specs.appKey. Identifies which app this
   * connection is for (e.g. 'sotuvchi', 'mgoods', 'telegram'). Nullable
   * for legacy rows; future writes set it, and `uniq_user_app_label`
   * prevents duplicate connection names within the same app for one user.
   */
  appKey: varchar("appKey", { length: 64 }),
  /** Human-readable label shown in the UI, e.g. "Google Sheets (user@gmail.com)" */
  displayName: varchar("displayName", { length: 255 }).notNull(),
  /** Lifecycle status; adapters treat non-'active' as "fall back to templateConfig". */
  status: mysqlEnum("status", ["active", "expired", "revoked", "error"]).default("active").notNull(),
  /** OAuth token row for google_sheets (migration 0055). */
  oauthTokenId: int("oauthTokenId"),
  /** Encrypted credentials for telegram_bot / api_key types. NULL for google_sheets. */
  credentialsJson: json("credentialsJson"),
  /** Last successful verification timestamp; used by health checks. */
  lastVerifiedAt: timestamp("lastVerifiedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  idxUserId: index("idx_connections_user_id").on(t.userId),
  idxUserType: index("idx_connections_user_type").on(t.userId, t.type),
  idxOauthToken: index("idx_connections_oauth_token_id").on(t.oauthTokenId),
  uniqUserAppLabel: uniqueIndex("uniq_user_app_label").on(
    t.userId, t.appKey, t.displayName,
  ),
  uniqUserOauthToken: uniqueIndex("uniq_connections_user_oauth_token").on(
    t.userId, t.oauthTokenId,
  ),
}));

export type Connection = typeof connections.$inferSelect;
export type InsertConnection = typeof connections.$inferInsert;

// ─── Connection Health Logs ───────────────────────────────────────────────────
// Audit trail for connection health checks. One row per check run (manual or
// scheduled). Powers the health history panel in the Connection Manager UI.
export const connectionHealthLogs = mysqlTable("connection_health_logs", {
  id:           int("id").autoincrement().primaryKey(),
  connectionId: int("connectionId").notNull(),
  userId:       int("userId").notNull(),
  /** 'ok' | 'error' | 'expired' — result of the health probe */
  checkStatus:  varchar("checkStatus", { length: 16 }).notNull(),
  latencyMs:    int("latencyMs"),
  /** Truncated error message (max 500 chars) */
  errorMessage: varchar("errorMessage", { length: 500 }),
  checkedAt:    timestamp("checkedAt").defaultNow().notNull(),
}, (t) => ({
  idxConnection: index("idx_chl_connection_id").on(t.connectionId),
  idxUserChecked: index("idx_chl_user_checked").on(t.userId, t.checkedAt),
}));

export type ConnectionHealthLog = typeof connectionHealthLogs.$inferSelect;

// ─── Connection Events ───────────────────────────────────────────────────────
// Immutable audit log for connection lifecycle events. Mirrors the
// `order_events` pattern: every state change (create, rename, disconnect,
// expire, error, revoke) appends one row. Powers the connection-history UI
// and supports security audits when a credential rotation needs forensic
// "who touched what, when" detail.
//
// Sprint 2 / Item 2.4.
export const connectionEvents = mysqlTable("connection_events", {
  id:            int("id").autoincrement().primaryKey(),
  /** Snapshot of the connection at event time — kept as int (not FK) so the
   *  row survives the parent connection being deleted (audit must outlive
   *  the entity it audits). */
  connectionId:  int("connectionId").notNull(),
  userId:        int("userId").notNull(),
  /** What happened. New values appended over time; consumers must tolerate
   *  unknown strings (forward compat with admin-introduced events). */
  eventType:     varchar("eventType", { length: 32 }).notNull(),
  /** Where the event originated:
   *    'user'         — explicit user action (rename, disconnect)
   *    'system'       — background process (expire, health probe)
   *    'oauth'        — refresh / callback flow
   *    'webhook'      — external trigger
   *    'admin'        — admin override / impersonation
   */
  source:        varchar("source", { length: 16 }).notNull(),
  /** Optional structured diff — e.g. `{ from: "old name", to: "new name" }`
   *  for renames, `{ reason: "invalid_grant" }` for refresh failures. */
  details:       json("details").$type<Record<string, unknown> | null>(),
  createdAt:     timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  /** Per-connection timeline — primary access pattern (UI history panel). */
  idxConnection: index("idx_connection_events_connection").on(t.connectionId, t.createdAt),
  /** Per-user feed — drives "recent activity" digests and the security
   *  dashboard ("show me all expiry events in the last 24h"). */
  idxUserCreated: index("idx_connection_events_user_created").on(t.userId, t.createdAt),
}));

export type ConnectionEvent = typeof connectionEvents.$inferSelect;
export type InsertConnectionEvent = typeof connectionEvents.$inferInsert;

// ─── Target Websites ──────────────────────────────────────────────────────────
// A list of affiliate/CRM websites that leads are routed to.
//
// templateType: 'sotuvchi' | '100k' | 'albato' | 'custom' | 'telegram' (legacy hardcoded)
// templateId:   FK to destinationTemplates (dynamic admin-managed templates)
// templateConfig: template-specific config JSON, e.g.:
//   legacy:  { apiKeyEncrypted, ... }
//   dynamic: { secrets: { api_key: "encrypted:..." }, variables: {} }
//   telegram: { botTokenEncrypted, chatId, messageTemplate }
// 2026-05-12: SQL table renamed to `destinations` via migration 0069.
// The legacy name `destinations` still resolves at the DB level via a
// backward-compat VIEW, so hand-written SQL outside Drizzle keeps working
// during the transition. The VIEW will be dropped in a follow-up migration
// once every caller has settled on the new name.
export const destinations = mysqlTable("destinations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  /** Base URL of the target website's lead submission endpoint. NULL for telegram destinations. */
  url: text("url"),
  /** Optional static headers as JSON object */
  headers: json("headers").$type<Record<string, string> | null>(),
  /** FK to destinationTemplates — set when created from admin-managed template */
  templateId: int("templateId"),
  /**
   * Denormalized from `destination_templates.appKey` when `templateId` is set
   * (Stage 2 migration 0049). Backfill 0051 + NOT NULL 0052; sentinel `unknown`
   * means "use legacy `templateType` / `templateId` for routing" (see
   * `resolveAdapterKey`).
   */
  appKey: varchar("appKey", { length: 64 }).notNull(),
  /**
   * FK-in-spirit → `app_actions.id` for the action row mirroring this template
   * (match via `app_actions.actionKey = CONCAT('t', destination_templates.id)`).
   * NULL when no template or no `app_actions` row.
   */
  actionId: int("actionId"),
  /** Template-specific config (api keys, field mappings, success conditions) */
  templateConfig: json("templateConfig"),
  /** Delivery chatId for Telegram lead notifications (delivery chat only) */
  telegramChatId: varchar("telegramChatId", { length: 64 }),
  isActive: boolean("isActive").default(true).notNull(),
  /** Hex color for visual distinction in UI (e.g., #3b82f6) */
  color: varchar("color", { length: 7 }).default("#6366f1").notNull(),
  /**
   * FK → connections.id (ON DELETE SET NULL at DB level, see migration 0043).
   * Nullable — adapters prefer the linked connection when set, otherwise fall
   * back to credentials embedded in templateConfig. This keeps legacy rows and
   * tests working without any data migration.
   */
  connectionId: int("connectionId"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Destination = typeof destinations.$inferSelect;
export type InsertDestination = typeof destinations.$inferInsert;

// ─── Integrations ─────────────────────────────────────────────────────────────
// LEAD_ROUTING: full pipeline — FB account → page → form → field map → target website
export const integrations = mysqlTable("integrations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  // DB enum still allows the historical "AFFILIATE" value for backward compat
  // — 0 production rows use it (audit 2026-05-12). The TS union is narrowed
  // here so new inserts/reads are type-checked against "LEAD_ROUTING" only.
  // If drizzle-kit ever proposes an ALTER … MODIFY COLUMN to drop the enum
  // value, discard it: the schema parity matters less than the risk of a
  // table-rewrite migration on a hot table.
  type: mysqlEnum("type", ["LEAD_ROUTING"]).notNull(),
  /**
   * JSON config shape:
   *   LEAD_ROUTING: {
   *     facebookAccountId: number,   // facebookAccounts.id
   *     // pageId, pageName, formId, formName → dedicated columns (migrated out of JSON)
   *     nameField: string,           // FB form field key for full name
   *     phoneField: string,          // FB form field key for phone
   *     destinationId: number,     // targetWebsites.id
   *     flow: string,
   *     offerId: string,
   *   }
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
   */
  pageId: varchar("pageId", { length: 128 }),
  formId: varchar("formId", { length: 128 }),
  pageName: varchar("pageName", { length: 255 }),
  formName: varchar("formName", { length: 255 }),
  /** Dedicated FK column to `destinations.id` (legacy config.destinationId
   *  remains as a JSON fallback for old rows — see extractDestinationIdFromConfig).
   *  Migration 0071 renamed this SQL column from `destinationId` to `destinationId`. */
  destinationId: int("destinationId"),
  /** Dedicated FK column extracted from config.facebookAccountId for efficient disconnect cleanup.
   *  Nullable — populated by backfill for existing rows; always set on new LEAD_ROUTING integrations. */
  facebookAccountId: int("facebookAccountId"),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /**
   * Soft-delete timestamp. NULL = live row; NOT NULL = deleted via UI.
   *
   * Hard delete was orphaning historical orders (verified 2026-05-15: 11,139
   * orphaned rows, ~3,711 in the May 1-15 window alone, invisible to CRM
   * queries that INNER JOIN integrations). Soft-delete keeps the row so
   * order JOINs continue to resolve; live-integration queries should
   * filter `deletedAt IS NULL`.
   */
  deletedAt: timestamp("deletedAt"),
}, (t) => ({
  // Hot-path index: processLead queries WHERE userId=? AND isActive=1 AND pageId=? AND formId=?
  idxUserPageForm: index("idx_integrations_user_page_form").on(t.userId, t.isActive, t.pageId, t.formId),
  // FK-style index for JOIN with destinations
  idxDestination: index("idx_integrations_destination_id").on(t.destinationId),
  // Index for disconnect cleanup: find all integrations tied to a given FB account
  idxFbAccount: index("idx_integrations_fb_account_id").on(t.facebookAccountId),
}));

export type Integration = typeof integrations.$inferSelect;
export type InsertIntegration = typeof integrations.$inferInsert;

// ─── Integration Destinations ─────────────────────────────────────────────────
// Fan-out join between ONE integration and N destinations (migration 0044).
//
// This is the Make.com-style multi-destination scaffold. Until Commit 5 wires
// the feature-flagged dual-read, the legacy `integrations.destinationId`
// column remains the dispatch source of truth. This table is kept in sync by
// dual-write in server/db.ts so both shapes stay correct during the rollout.
//
// Invariants:
//   - (integrationId, destinationId) is UNIQUE.
//   - Both FKs CASCADE: deleting an integration or a target website removes
//     the mapping automatically — no orphans, no dangling dispatch attempts.
//   - `position` drives fan-out order (all zero today; reorderable later).
//   - `enabled` lets a user pause ONE destination without deleting the row.
//   - `filterJson` is reserved for per-destination Make.com-style filters
//     (Phase 5+). NULL and unread at this commit.
// 2026-05-12: SQL table renamed to `integration_routes` via migration 0069.
// The legacy name `integration_routes` still resolves at the DB level
// via a backward-compat VIEW. The VIEW will be dropped in a follow-up
// migration once every caller has settled on the new name.
export const integrationRoutes = mysqlTable(
  "integration_routes",
  {
    id: int("id").autoincrement().primaryKey(),
    integrationId: int("integrationId").notNull(),
    destinationId: int("destinationId").notNull(),
    position: int("position").default(0).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    filterJson: json("filterJson"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().onUpdateNow(),
  },
  (t) => ({
    // Dispatch hot-path: resolve all enabled destinations for one integration,
    // ordered. Index covers the full WHERE + ORDER BY clause.
    idxIntegration: index("idx_integration_routes_integration").on(
      t.integrationId,
      t.enabled,
      t.position,
    ),
    // Reverse lookup — "what integrations deliver to this destination?" —
    // used when cleaning up on destination delete.
    idxDestination: index("idx_integration_routes_destination").on(
      t.destinationId,
    ),
    // Hard guarantee against duplicate mappings in the UI or via a race.
    uniqIntegrationRoute: uniqueIndex("uniq_integration_route").on(
      t.integrationId,
      t.destinationId,
    ),
  }),
);

export type IntegrationRoute = typeof integrationRoutes.$inferSelect;
export type InsertIntegrationRoute = typeof integrationRoutes.$inferInsert;

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
  /**
   * Completed Graph-enrichment attempts. Per-minute retry scheduler stops
   * claiming the lead once `dataAttempts >= LEAD_MAX_GRAPH_ATTEMPTS`.
   * Mirrors `orders.attempts`.
   */
  dataAttempts: int("dataAttempts").default(0).notNull(),
  /**
   * When to retry the Graph fetch next. `null` = no retry scheduled (either
   * success, permanently failed via classifier, or attempts exhausted). The
   * scheduler claims rows by clearing this column inside the same locking
   * transaction so concurrent workers can't re-dispatch the same lead.
   */
  dataNextRetryAt: timestamp("dataNextRetryAt"),
  /**
   * Classified outcome of the last Graph failure. Drives the backoff ladder
   * and the giveup decision (see `leadEnrichmentRetryPolicy.ts`).
   *
   *   - `permanently_missing` — Graph code 100/33 ("Object does not exist").
   *     Lead got deleted on FB's side; no point retrying.
   *   - `auth`                — token invalid/expired (code 190 / 102).
   *   - `validation`          — request shape wrong (rare).
   *   - `rate_limit`          — code 4 / 17 / 80004 — honour Retry-After.
   *   - `network`             — timeout / 5xx / connection error.
   */
  dataErrorType: varchar("dataErrorType", { length: 32 }),

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
  extraFields: json("extraFields").$type<Record<string, string> | null>(),

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
  // Speeds up the per-minute Graph-retry scheduler scan: walks only ERROR
  // rows whose nextRetryAt is due and dataAttempts is under cap.
  idxDataRetryDue: index("idx_leads_data_retry_due").on(t.dataStatus, t.dataNextRetryAt, t.dataAttempts),
}));

export type Lead = typeof leads.$inferSelect;
export type InsertLead = typeof leads.$inferInsert;

// ─── Orders ───────────────────────────────────────────────────────────────────
export const orders = mysqlTable("orders", {
  id: int("id").autoincrement().primaryKey(),
  leadId: int("leadId").notNull(),
  userId: int("userId").notNull(),
  integrationId: int("integrationId").notNull(),
  /**
   * Which `integration_routes` row this order is delivering to.
   *
   * - `0` = legacy single-destination path: an order aggregates delivery
   *   for the whole integration (there is only one destination so there's
   *   nothing to disambiguate). All rows created before migration 0045
   *   take this value.
   * - `> 0` = per-destination fan-out path (Commit 6b onward, behind the
   *   `multi_destinations` feature flag). Each destination mapping gets
   *   its own order row so attempts / nextRetryAt / status are tracked
   *   independently — preventing double-delivery when one destination
   *   succeeds and another fails.
   *
   * Stored as a non-null INT with DEFAULT 0 so existing code paths that
   * omit the column on insert keep working without changes, and so the
   * composite unique key below has strict semantics (unlike NULL, which
   * MySQL treats as always-unique).
   */
  destinationId: int("destinationId").default(0).notNull(),
  status: mysqlEnum("status", ["PENDING", "SENT", "FAILED"]).default("PENDING").notNull(),
  /** Completed delivery attempts (each HTTP/send to integration). Max 3 then auto-retry stops. */
  attempts: int("attempts").default(0).notNull(),
  lastAttemptAt: timestamp("lastAttemptAt"),
  /** After a failed delivery, set to now+1h until attempts reach max; hourly job selects due rows */
  nextRetryAt: timestamp("nextRetryAt"),
  responseData: json("responseData"),
  /** Phase 10 observability — delivery error classification (network | validation | …). */
  errorType: varchar("errorType", { length: 32 }),
  /** Phase 10 observability — end-to-end delivery latency in milliseconds. */
  durationMs: int("durationMs"),
  /** Phase 10 observability — which adapter key handled this delivery (telegram, google-sheets, http-api-key, …). */
  adapterKey: varchar("adapterKey", { length: 64 }),
  /** CRM: latest status string fetched from the affiliate platform (new/accepted/delivered/...) */
  crmStatus: varchar("crmStatus", { length: 32 }),
  /** CRM: raw status string as returned by the platform before normalization (e.g. "client_returned", "trash") */
  crmRawStatus: varchar("crmRawStatus", { length: 64 }),
  /** CRM: when crmStatus was last refreshed from the platform */
  crmSyncedAt: timestamp("crmSyncedAt"),
  /** CRM: true once crmStatus reaches a terminal state — sync is skipped for these rows */
  isFinal: boolean("isFinal").default(false).notNull(),
  /** Insights: snapshot of the destination's offer_id at order creation time
   *  (read from destination.templateConfig). Denormalised so analytics never
   *  has to reach into JSON at query time. NULL on legacy rows / destinations
   *  with no offer variable. */
  offerId: varchar("offerId", { length: 64 }),
  /** Insights: offer display name captured from the CRM platform's
   *  /getOrders response (sotuvchi: `offer.name`). Denormalised so the
   *  Insights breakdown can render "Yurak ursa bas" instead of the raw
   *  numeric offer id. Captured at sync time — historical names stay even
   *  if sotuvchi later renames the offer. Phase 4 follow-up (migration 0090). */
  offerName: varchar("offerName", { length: 255 }),
  /** Insights: payout per delivered order, in the SMALLEST unit of the
   *  source platform's currency (sotuvchi today: integer UZS so'm, captured
   *  from the /getOrderDetails `order.pay_for` field). NULL when the CRM
   *  sync hasn't seen this order in delivered state yet. Revenue analytics
   *  use SUM(payoutAmount WHERE crmStatus='delivered' AND payoutCurrency
   *  matches the user's baseCurrency). */
  payoutAmount: int("payoutAmount"),
  /** ISO-4217 currency code of `payoutAmount`. 'UZS' for sotuvchi orders;
   *  set by the CRM sync adapter at the same time as payoutAmount. NULL
   *  when payoutAmount is NULL. Drives the cross-currency safety check in
   *  the rollup worker — revenue is only summed when this matches the
   *  user's baseCurrency (v1 has no FX conversion). */
  payoutCurrency: varchar("payoutCurrency", { length: 8 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // One order row per (lead, integration, destination). Legacy rows pin
  // destinationId=0 so the constraint still guarantees idempotency on the
  // single-destination path while leaving room for per-destination rows
  // when multi-destinations fan-out is enabled.
  uqLeadIntDest: uniqueIndex("uq_orders_lead_int_dest").on(
    t.leadId,
    t.integrationId,
    t.destinationId,
  ),
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
  // Reverse lookup: "which orders belong to this destination mapping?"
  // Used by per-destination retry scheduling (Commit 6b) and destination
  // deletion clean-up.
  idxDestination: index("idx_orders_destination").on(t.destinationId),
  // Covering index for the "has this lead been routed?" EXISTS subquery
  // that runs on every leads.list / leads.count / leads.stats call:
  //   EXISTS (SELECT 1 FROM orders WHERE leadId = ? AND userId = ? AND attempts > 0)
  // Column order: userId FIRST — MySQL drives the semi-join from the
  // orders side filtered on userId, so a leadId-first index gets ignored
  // by the optimizer. (userId, leadId, attempts) makes it a covering
  // "Using index" LooseScan: getLeadsCount 691ms → 372ms on local.
  idxLeadUserAttempts: index("idx_orders_lead_user_attempts").on(
    t.userId,
    t.leadId,
    t.attempts,
  ),
  /** Insights drill-down: per-offer time-series and "top offers" queries
   *  scan (userId, offerId, createdAt). Lets the rollup worker pull a
   *  single user's orders for one offer over the rebuild window cheaply. */
  idxUserOfferCreated: index("idx_orders_user_offer_created").on(
    t.userId,
    t.offerId,
    t.createdAt,
  ),
}));

export type Order = typeof orders.$inferSelect;
export type InsertOrder = typeof orders.$inferInsert;

// ─── Order CRM Status Events ──────────────────────────────────────────────────
// Immutable audit log: every CRM status change appends one row.
// Powers: status timeline, analytics (time-in-state, funnel), debugging.
export const orderEvents = mysqlTable("order_events", {
  id: int("id").autoincrement().primaryKey(),
  orderId: int("orderId").notNull(),
  userId: int("userId").notNull(),
  oldStatus: varchar("oldStatus", { length: 32 }),
  newStatus: varchar("newStatus", { length: 32 }).notNull(),
  source: varchar("source", { length: 32 }).default("sync").notNull(), // 'sync' | 'manual'
  changedAt: timestamp("changedAt").defaultNow().notNull(),
}, (t) => ({
  idxOrderId: index("idx_order_events_order_id").on(t.orderId),
  idxUserId:  index("idx_order_events_user_id").on(t.userId),
  idxChangedAt: index("idx_order_events_changed_at").on(t.changedAt),
}));

export type OrderEvent = typeof orderEvents.$inferSelect;

// ─── Webhook Events ───────────────────────────────────────────────────────────
export const webhookEvents = mysqlTable("webhook_events", {
  id: int("id").autoincrement().primaryKey(),
  eventType: varchar("eventType", { length: 64 }).notNull(),
  payload: json("payload").notNull(),
  /**
   * Facebook X-Hub-Signature-256 header. Used as the idempotency key for
   * webhook retries — Facebook signs each request uniquely (HMAC of body +
   * app secret), so any retry of the same payload carries the same value.
   * MySQL unique index permits multiple NULL rows, so unsigned events
   * (test payloads, legacy rows) still insert freely.
   */
  signature: varchar("signature", { length: 128 }),
  verified: boolean("verified").default(false).notNull(),
  processed: boolean("processed").default(false).notNull(),
  error: text("error"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  // Speeds up ORDER BY createdAt DESC LIMIT ? on Webhook Health page
  idxCreatedAt: index("idx_webhook_events_created_at").on(t.createdAt),
  /**
   * Idempotency guard — same Facebook retry hits ER_DUP_ENTRY and is
   * silently treated as already-acknowledged in the webhook handler.
   * NULL signatures still allowed (test events) — MySQL unique permits
   * multiple NULLs.
   */
  uniqSignature: uniqueIndex("uniq_webhook_events_signature").on(t.signature),
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
  meta: json("meta").$type<Record<string, unknown> | null>(),
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

// ─── Ad Accounts ──────────────────────────────────────────────────────────────
// Synced from Facebook Marketing API by background job (every 10 min).
// Frontend reads from this instead of calling Graph API directly — it's the
// system-of-record for the UI even though FB is the upstream truth.
export const adAccounts = mysqlTable("ad_accounts", {
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
  /** Business Manager ID this ad account belongs to. Pulled via Graph
   *  `?fields=business{id,name}`. NULL = no BM (personal ad account) OR
   *  not yet back-filled. Phase 1 Insights uses this for top-level
   *  grouping in the FB-attribution dropdown. */
  bmId: varchar("bmId", { length: 64 }),
  bmName: varchar("bmName", { length: 255 }),
  /** When this record was last synced from Facebook */
  lastSyncedAt: timestamp("lastSyncedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  uqUserAccount: uniqueIndex("uq_ad_accounts_user_account").on(t.userId, t.fbAdAccountId),
  idxFbAccount: index("idx_ad_accounts_fb_account").on(t.facebookAccountId),
  /** Insights drill-down: "all ad accounts under BM X". */
  idxBmId: index("idx_ad_accounts_bm_id").on(t.bmId),
}));

export type AdAccount = typeof adAccounts.$inferSelect;
export type InsertAdAccount = typeof adAccounts.$inferInsert;

// ─── Campaigns ────────────────────────────────────────────────────────────────
// Synced from Facebook Marketing API. One row per campaign per user.
export const campaigns = mysqlTable("campaigns", {
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
  uqUserCampaign: uniqueIndex("uq_campaigns_user_campaign").on(t.userId, t.fbCampaignId),
  idxUserAdAccount: index("idx_campaigns_user_ad_account").on(t.userId, t.fbAdAccountId),
}));

export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = typeof campaigns.$inferInsert;

// ─── Ad Sets ──────────────────────────────────────────────────────────────────
// Synced on-demand when user drills into a campaign.
export const adSets = mysqlTable("ad_sets", {
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
  uqUserAdSet: uniqueIndex("uq_ad_sets_user_adset").on(t.userId, t.fbAdSetId),
  idxUserCampaign: index("idx_ad_sets_user_campaign").on(t.userId, t.fbCampaignId),
}));

export type AdSet = typeof adSets.$inferSelect;
export type InsertAdSet = typeof adSets.$inferInsert;

// ─── Campaign Insights ────────────────────────────────────────────────────────
// Stores aggregated performance metrics per campaign per date preset.
// Sourced from a single campaign-level insights API call (not per-campaign).
// Key: (userId, fbCampaignId, datePreset) — refreshed every sync cycle.
export const campaignInsights = mysqlTable("campaign_insights", {
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
  uqKey: uniqueIndex("uq_campaign_insights_key").on(t.userId, t.fbCampaignId, t.datePreset),
  idxUserAdAccount: index("idx_campaign_insights_account").on(t.userId, t.fbAdAccountId),
}));

export type CampaignInsights = typeof campaignInsights.$inferSelect;
export type InsertCampaignInsights = typeof campaignInsights.$inferInsert;

// ─── CRM Connections ──────────────────────────────────────────────────────────
// Stores affiliate platform credentials for admin CRM status syncing.
// Separate from `connections` table — CRM-only, admin-managed.
export const crmConnections = mysqlTable("crm_connections", {
  id: int("id").autoincrement().primaryKey(),
  /** Admin user who added this account */
  userId: int("userId").notNull(),
  /** Affiliate platform */
  platform: mysqlEnum("platform", ["sotuvchi", "100k"]).notNull(),
  /** Human label shown in CRM UI */
  displayName: varchar("displayName", { length: 64 }).notNull(),
  /** Phone or email used to log in (stored for auto re-login on 401) */
  phone: varchar("phone", { length: 64 }).notNull(),
  /** AES-encrypted login password — needed for automatic token refresh */
  passwordEncrypted: text("passwordEncrypted").notNull(),
  /** AES-encrypted Bearer token for Platform API calls */
  bearerTokenEncrypted: text("bearerTokenEncrypted").notNull(),
  /** Numeric user ID returned by the platform after login */
  platformUserId: varchar("platformUserId", { length: 64 }).notNull(),
  /** active = token is valid; error = last login attempt failed */
  status: mysqlEnum("status", ["active", "error"]).default("active").notNull(),
  /** When we last successfully logged in / refreshed the token */
  lastLoginAt: timestamp("lastLoginAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  idxUserId: index("idx_crm_connections_user_id").on(t.userId),
  idxPlatform: index("idx_crm_connections_platform").on(t.platform),
}));

export type CrmConnection = typeof crmConnections.$inferSelect;
export type InsertCrmConnection = typeof crmConnections.$inferInsert;

// ─── Triggers ────────────────────────────────────────────────────────────────

export const triggers = mysqlTable("triggers", {
  id:          int("id").autoincrement().primaryKey(),
  userId:      int("userId").notNull(),
  name:        varchar("name", { length: 255 }).notNull(),
  type:        mysqlEnum("type", ["webhook", "schedule", "manual", "api"]).notNull(),
  /** Unique slug used in webhook URL: /api/trigger/wh/:webhookKey */
  webhookKey:  varchar("webhookKey", { length: 64 }).unique(),
  /** Type-specific config. Schedule: { cron: "0 * * * *" }. API: { secretHash: "..." } */
  config:      json("config"),
  isActive:    boolean("isActive").default(true).notNull(),
  lastFiredAt: timestamp("lastFiredAt"),
  createdAt:   timestamp("createdAt").defaultNow().notNull(),
  updatedAt:   timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  idxUserId:    index("idx_triggers_user_id").on(t.userId),
  idxWebhookKey: index("idx_triggers_webhook_key").on(t.webhookKey),
}));

export type Trigger       = typeof triggers.$inferSelect;
export type InsertTrigger = typeof triggers.$inferInsert;

// ─── Trigger Executions ───────────────────────────────────────────────────────

export const triggerExecutions = mysqlTable("trigger_executions", {
  id:          int("id").autoincrement().primaryKey(),
  triggerId:   int("triggerId").notNull(),
  userId:      int("userId").notNull(),
  status:      mysqlEnum("status", ["received", "success", "failed"]).default("received").notNull(),
  /** Raw incoming payload (webhook body, schedule tick metadata, etc.) */
  payload:     json("payload"),
  source:      varchar("source", { length: 64 }),
  executedAt:  timestamp("executedAt").defaultNow().notNull(),
  error:       text("error"),
}, (t) => ({
  idxTriggerId: index("idx_trigger_exec_trigger_id").on(t.triggerId),
  idxUserId:    index("idx_trigger_exec_user_id").on(t.userId),
  idxFiredAt:   index("idx_trigger_exec_fired_at").on(t.executedAt),
}));

export type TriggerExecution       = typeof triggerExecutions.$inferSelect;
export type InsertTriggerExecution = typeof triggerExecutions.$inferInsert;

// ─── Workflows ────────────────────────────────────────────────────────────────

export const workflows = mysqlTable("workflows", {
  id:          int().autoincrement().primaryKey(),
  userId:      int().notNull(),
  triggerId:   int(),           // optional FK → triggers.id
  name:        varchar("name",  { length: 255 }).notNull(),
  description: text("description"),
  isActive:       boolean("isActive").default(true).notNull(),
  /** When true, this workflow fires for every new lead this user receives. */
  triggerOnLead:  boolean("triggerOnLead").default(false).notNull(),
  canvasJson:     json("canvasJson"),  // React Flow nodes + edges
  createdAt:      timestamp("createdAt").defaultNow().notNull(),
  updatedAt:      timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  idxUserId:    index("idx_workflows_user_id").on(t.userId),
  idxTriggerId: index("idx_workflows_trigger_id").on(t.triggerId),
}));

export type Workflow       = typeof workflows.$inferSelect;
export type InsertWorkflow = typeof workflows.$inferInsert;

export const workflowSteps = mysqlTable("workflow_steps", {
  id:             int().autoincrement().primaryKey(),
  workflowId:     int().notNull(),
  position:       int().notNull().default(0),
  type:           varchar("type", { length: 64 }).notNull(), // http_request | telegram | set_variable | condition
  name:           varchar("name", { length: 255 }).notNull(),
  config:         json("config").notNull(),
  continueOnError: boolean("continueOnError").default(false).notNull(),
  createdAt:      timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  idxWorkflowId: index("idx_wf_steps_workflow_id").on(t.workflowId),
}));

export type WorkflowStep       = typeof workflowSteps.$inferSelect;
export type InsertWorkflowStep = typeof workflowSteps.$inferInsert;

export const workflowExecutions = mysqlTable("workflow_executions", {
  id:          int().autoincrement().primaryKey(),
  workflowId:  int().notNull(),
  userId:      int().notNull(),
  status:      mysqlEnum("status", ["running", "success", "failed", "cancelled"]).default("running").notNull(),
  triggerData: json("triggerData"),
  contextJson: json("contextJson"), // accumulated step outputs
  startedAt:   timestamp("startedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  error:       text("error"),
}, (t) => ({
  idxWorkflowId: index("idx_wf_exec_workflow_id").on(t.workflowId),
  idxUserId:     index("idx_wf_exec_user_id").on(t.userId),
  idxStatus:     index("idx_wf_exec_status").on(t.status),
}));

export type WorkflowExecution       = typeof workflowExecutions.$inferSelect;
export type InsertWorkflowExecution = typeof workflowExecutions.$inferInsert;

export const workflowStepExecutions = mysqlTable("workflow_step_executions", {
  id:          int().autoincrement().primaryKey(),
  executionId: int().notNull(),
  stepId:      int().notNull(),
  position:    int().notNull(),
  status:      mysqlEnum("status", ["running", "success", "failed", "skipped"]).default("running").notNull(),
  inputJson:   json("inputJson"),  // resolved config after template substitution
  outputJson:  json("outputJson"), // step result
  error:       text("error"),
  durationMs:  int("durationMs"),
  executedAt:  timestamp("executedAt").defaultNow().notNull(),
}, (t) => ({
  idxExecutionId: index("idx_wf_step_exec_exec_id").on(t.executionId),
  idxStepId:      index("idx_wf_step_exec_step_id").on(t.stepId),
}));

export type WorkflowStepExecution       = typeof workflowStepExecutions.$inferSelect;
export type InsertWorkflowStepExecution = typeof workflowStepExecutions.$inferInsert;

// ─── Circuit Breakers ────────────────────────────────────────────────────────
// Per-destination circuit breaker state. Keyed on (integrationId, destinationId)
// so multi-destination fan-out integrations can have independent breakers — one
// flaky destination does not block its siblings.
//
// State machine: CLOSED → OPEN (cooldown) → HALF_OPEN (limited probes) → CLOSED.
// `cooldownLevel` indexes into `CIRCUIT_POLICY[errorType].cooldownLadder` for
// exponential back-off after repeated re-opens.
//
// destinationId=0 means "whole integration" (legacy / non-fan-out orders).
// Phase 0 = shadow mode — written on every delivery outcome but not yet
// enforced in the scheduler claim.
export const circuitBreakers = mysqlTable("circuit_breakers", {
  id:             int("id").autoincrement().primaryKey(),
  integrationId:  int("integrationId").notNull(),
  /** 0 = whole integration (legacy / single-dest). >0 = specific integration_routes row. */
  destinationId:  int("destinationId").default(0).notNull(),
  /**
   * Cached `destinations.appKey` for this destination (set on first
   * recordOutcome). Lets `evaluateClaim` answer "is any sibling of this
   * destination's app currently OPEN?" without joining through
   * `integration_routes` and `destinations` on every claim.
   */
  appKey:         varchar("appKey", { length: 64 }),
  /** CLOSED | OPEN | HALF_OPEN */
  state:          mysqlEnum("state", ["CLOSED", "OPEN", "HALF_OPEN"]).default("CLOSED").notNull(),

  /** Tumbling-window counters. Reset whenever now - windowStartedAt > policy.windowMs. */
  windowStartedAt: timestamp("windowStartedAt"),
  windowFailures:  int("windowFailures").default(0).notNull(),
  windowSuccesses: int("windowSuccesses").default(0).notNull(),

  /** Streak counters for fast-trip on consecutive failures. */
  consecutiveFailures:  int("consecutiveFailures").default(0).notNull(),
  consecutiveSuccesses: int("consecutiveSuccesses").default(0).notNull(),

  /** OPEN-state bookkeeping. */
  openedAt:       timestamp("openedAt"),
  cooldownUntil:  timestamp("cooldownUntil"),
  /** Index into CIRCUIT_POLICY[errorType].cooldownLadder. Increments on re-open. */
  cooldownLevel:  int("cooldownLevel").default(0).notNull(),

  /** Diagnostics for the most recent trip. */
  lastErrorType:    varchar("lastErrorType", { length: 32 }),
  lastErrorMessage: varchar("lastErrorMessage", { length: 500 }),
  /** "consecutive" | "rate_limited" | "auth_persistent" | "manual" | … */
  lastTripReason:   varchar("lastTripReason", { length: 64 }),

  /** HALF_OPEN budget tracking. */
  halfOpenAttempts:  int("halfOpenAttempts").default(0).notNull(),
  halfOpenSuccesses: int("halfOpenSuccesses").default(0).notNull(),

  /** Admin override — 'OPEN' (force-pause) | 'CLOSED' (force-bypass) | null. */
  manualLock:        mysqlEnum("manualLock", ["OPEN", "CLOSED"]),
  manualLockSetBy:   varchar("manualLockSetBy", { length: 128 }),
  manualLockReason:  text("manualLockReason"),
  manualLockSetAt:   timestamp("manualLockSetAt"),

  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  /** One row per (integration, destination) — upsert target. */
  uqDest:    uniqueIndex("uq_circuit_breakers_dest").on(t.integrationId, t.destinationId),
  /** Scheduler claim JOIN — filter by state + cooldown expiry. */
  idxState:  index("idx_circuit_breakers_state").on(t.state, t.cooldownUntil),
  /** Per-app sibling lookup ("any 100k.uz destination currently OPEN?"). */
  idxAppKey: index("idx_circuit_breakers_appkey_state").on(t.appKey, t.state),
}));

export type CircuitBreaker       = typeof circuitBreakers.$inferSelect;
export type InsertCircuitBreaker = typeof circuitBreakers.$inferInsert;

// ─── Circuit Breaker Events (immutable audit log) ────────────────────────────
// Append-only history of every CB state transition + probe outcome. Powers
// the "why did this destination open 3h ago?" admin view and post-incident
// forensics. Survives parent row deletion (audit must outlive entity).
export const circuitBreakerEvents = mysqlTable("circuit_breaker_events", {
  id:             int("id").autoincrement().primaryKey(),
  integrationId:  int("integrationId").notNull(),
  destinationId:  int("destinationId").default(0).notNull(),
  /**
   * 'opened' | 'half_opened' | 'closed' | 'probe_sent' | 'probe_succeeded' |
   * 'probe_failed' | 'manual_open' | 'manual_close' | 'manual_reset' |
   * 'shadow_would_block' | 'shadow_would_allow'
   *
   * `shadow_*` events are Phase 0-only — emitted by the scheduler when CB
   * would have made a different decision than the legacy retry path.
   */
  eventType:      varchar("eventType", { length: 32 }).notNull(),
  fromState:      varchar("fromState", { length: 16 }),
  toState:        varchar("toState", { length: 16 }),
  /** Short human-readable cause: "5 consecutive network errors", "manual unblock by admin#3" */
  reason:         varchar("reason", { length: 256 }),
  errorType:      varchar("errorType", { length: 32 }),
  /** Free-form structured context (window counters, retry-after header, order id, etc.) */
  metadata:       json("metadata"),
  createdAt:      timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  /** Per-destination timeline — primary access pattern (admin history view). */
  idxDestTime:  index("idx_cb_events_dest_time").on(t.integrationId, t.destinationId, t.createdAt),
  /** Event-type filter for cross-destination ops queries ("all opens in last 24h"). */
  idxTypeTime:  index("idx_cb_events_type_time").on(t.eventType, t.createdAt),
}));

export type CircuitBreakerEvent       = typeof circuitBreakerEvents.$inferSelect;
export type InsertCircuitBreakerEvent = typeof circuitBreakerEvents.$inferInsert;

// ─── Admin audit log ──────────────────────────────────────────────────────────
//
// Roadmap #12. Captures every admin-protected tRPC mutation so we have a
// forensic "who touched what, when" record for the global tables admins can
// write to (apps, app_actions, destination_templates) and the privileged
// trigger endpoints (DLQ replay, retry-all, backfill).
//
// Source of truth is the tRPC audit middleware in server/_core/trpc.ts —
// any new admin procedure inherits auditing automatically the moment it
// is built on top of `adminProcedure` (and `templateEditorProcedure`,
// which has been wired in alongside).
//
// Retention: append-only. No TTL today; rotation can be added later when
// volume warrants it (admin actions are low-frequency by design).
export const adminAuditLogs = mysqlTable("admin_audit_log", {
  id:           int("id").autoincrement().primaryKey(),
  /** The acting admin (ctx.user.id at call time). Not an FK so the row
   *  survives if the user is ever deleted. */
  adminId:      int("adminId").notNull(),
  /** tRPC procedure path — e.g. "adminApps.create", "adminDlq.replayBatch". */
  path:         varchar("path", { length: 128 }).notNull(),
  /** "mutation" today; "query" reserved for future opt-in read auditing. */
  type:         varchar("type", { length: 16 }).notNull(),
  /** Sanitized input payload. Secrets are stripped and large blobs
   *  truncated by the audit middleware before insertion. NULL when the
   *  procedure takes no input. */
  input:        json("input").$type<Record<string, unknown> | null>(),
  /** "success" | "failure". */
  resultStatus: varchar("resultStatus", { length: 16 }).notNull(),
  /** TRPCError code on failure (e.g. "FORBIDDEN", "BAD_REQUEST"). NULL on success. */
  errorCode:    varchar("errorCode", { length: 64 }),
  /** First 500 chars of the error message on failure. NULL on success. */
  errorMessage: varchar("errorMessage", { length: 500 }),
  /** Server-side wall-clock duration of the procedure call, in milliseconds. */
  durationMs:   int("durationMs").notNull().default(0),
  /** Best-effort caller IP (from req.ip with Express's trust-proxy applied). */
  ipAddress:    varchar("ipAddress", { length: 64 }),
  /** Truncated User-Agent header — useful for distinguishing browser sessions
   *  from CLI tooling in forensic reviews. */
  userAgent:    varchar("userAgent", { length: 256 }),
  createdAt:    timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  /** Per-admin timeline — primary access pattern ("show me everything admin#3
   *  did last week"). */
  idxAdminCreated: index("idx_admin_audit_admin_created").on(t.adminId, t.createdAt),
  /** Per-procedure timeline — for "who touched destination_templates lately". */
  idxPathCreated:  index("idx_admin_audit_path_created").on(t.path, t.createdAt),
}));

export type AdminAuditLog       = typeof adminAuditLogs.$inferSelect;
export type InsertAdminAuditLog = typeof adminAuditLogs.$inferInsert;

// ─── Metric snapshots ─────────────────────────────────────────────────────────
//
// Roadmap #7 phase C. Periodic captures of the in-process counters
// (failed_orders, oauth_errors) and DB-side gauges (failed_orders_db,
// retry_queue_size). Before this table, counters reset on process restart
// and the only output was console.log under `METRICS_LOG=1` — no history,
// no graphs, no recovery after a deploy.
//
// `kind` distinguishes interpretation:
//   - "counter" — delta over the snapshot interval (counters are
//                 read-and-reset by the capture scheduler, so each row
//                 is the activity in [snapshotAt - interval, snapshotAt))
//   - "gauge"   — point-in-time reading at snapshotAt (no reset)
//
// Retention: append-only. Volume is modest (4 metrics × 12/hour × 24h ≈
// 1.2k rows/day, ~430k/year). A TTL prune can be added if needed.
export const metricSnapshots = mysqlTable("metric_snapshots", {
  id:         int("id").autoincrement().primaryKey(),
  /** When the snapshot was taken. Default lets the DB stamp the row. */
  snapshotAt: timestamp("snapshotAt").defaultNow().notNull(),
  /** Canonical metric name — keep it snake_case for grep-friendliness:
   *  "failed_orders", "oauth_errors", "retry_queue_size", "failed_orders_db". */
  metric:     varchar("metric", { length: 64 }).notNull(),
  /** "counter" (interval delta) or "gauge" (point-in-time). */
  kind:       varchar("kind", { length: 16 }).notNull(),
  /** The numeric reading. Counter values are always >= 0; gauges can be
   *  any non-negative integer in practice (queue sizes, row counts). */
  value:      int("value").notNull(),
  /** Optional context — e.g. process replica id, environment tag,
   *  diagnostic dimensions. Kept loose so new metrics don't need a
   *  schema change to add per-metric attributes. */
  meta:       json("meta").$type<Record<string, unknown> | null>(),
}, (t) => ({
  /** Primary access pattern: "graph metric X over time". */
  idxMetricTime: index("idx_metric_snapshots_metric_time").on(t.metric, t.snapshotAt),
  /** Cross-metric "what happened around 2:04am" forensic queries. */
  idxTime:       index("idx_metric_snapshots_time").on(t.snapshotAt),
}));

export type MetricSnapshot       = typeof metricSnapshots.$inferSelect;
export type InsertMetricSnapshot = typeof metricSnapshots.$inferInsert;

// ─── Insights — fact_attribution_daily ────────────────────────────────────────
//
// Phase 1 rollup table for the /insights surface. One row per
// (user, date, full FB attribution chain, offer). Refreshed every 15 min by
// insightsRollupScheduler with a 7-day rebuild window (covers sotuvchi's
// 3–5 day delivery lag). Reads are O(rows in date range) and join-free;
// writes are batched UPSERTs against the composite UNIQUE.
//
// All dimension columns are NOT NULL with an empty-string sentinel so the
// UNIQUE index treats "unknown" rows as mergeable (MySQL otherwise treats
// NULLs as distinct, which would defeat the UPSERT). The rollup writer
// must normalise NULL → '' before INSERT.
//
// Money columns are BIGINT in the SMALLEST unit of `currency` (UZS so'm /
// USD cents). Each row is self-consistent — no cross-row currency mixing.
// `currency` snapshots users.baseCurrency at write time so a later change
// to that setting does not retroactively reinterpret historical rows.
export const factAttributionDaily = mysqlTable("fact_attribution_daily", {
  id:           int("id").autoincrement().primaryKey(),
  userId:       int("userId").notNull(),
  /** YYYY-MM-DD. `mode: "string"` keeps the JS side string-typed — the
   *  rollup writer and read sites always compare/format strings, never
   *  Date objects, which avoids timezone surprises around midnight UTC. */
  date:         date("date", { mode: "string" }).notNull(),

  // Dimension columns — '' sentinel for "unknown / not applicable".
  bmId:         varchar("bmId",         { length: 64  }).default("").notNull(),
  adAccountId:  varchar("adAccountId",  { length: 64  }).default("").notNull(),
  campaignId:   varchar("campaignId",   { length: 100 }).default("").notNull(),
  adsetId:      varchar("adsetId",      { length: 100 }).default("").notNull(),
  adId:         varchar("adId",         { length: 100 }).default("").notNull(),
  pageId:       varchar("pageId",       { length: 128 }).default("").notNull(),
  formId:       varchar("formId",       { length: 128 }).default("").notNull(),
  offerId:      varchar("offerId",      { length: 64  }).default("").notNull(),

  // Lead-funnel counters (from leads table).
  leads:        int("leads").default(0).notNull(),
  enriched:     int("enriched").default(0).notNull(),
  enrichErrors: int("enrichErrors").default(0).notNull(),

  // Delivery-funnel counters (from orders table).
  sent:         int("sent").default(0).notNull(),
  failed:       int("failed").default(0).notNull(),

  // CRM-funnel counters (from orders.crmStatus).
  accepted:     int("accepted").default(0).notNull(),
  delivered:    int("delivered").default(0).notNull(),
  held:         int("held").default(0).notNull(),
  rejected:     int("rejected").default(0).notNull(),
  trash:        int("trash").default(0).notNull(),

  // Money — in the smallest unit of `currency` (UZS so'm / USD cents).
  // Drizzle's `int` maps to MySQL INT; we use it for the small counters above.
  // The two money columns are BIGINT in SQL; drizzle-orm has no first-class
  // bigint type for mysql-core today, so we expose them as `varchar` of
  // numeric strings to avoid JS-precision-loss surprises at the boundary.
  // (The SQL column itself is BIGINT — see migration 0085.) Read sites cast
  // to Number when the value is known small.
  spendAmount:   varchar("spendAmount",   { length: 32 }).default("0").notNull(),
  revenueAmount: varchar("revenueAmount", { length: 32 }).default("0").notNull(),
  /** "In-flight" money — orders with sotuvchi pay_for committed whose
   *  crmStatus is past `new` but not yet `delivered`. Surfaces in the
   *  Insights breakdown table as a Pipeline column so users see the
   *  amount expected to land on top of the realised Revenue. Does NOT
   *  feed Profit (we stay conservative on Profit = Revenue − Spend).
   *  Phase 4 addition (migration 0089). */
  pipelineAmount: varchar("pipelineAmount", { length: 32 }).default("0").notNull(),

  /** Snapshot of users.baseCurrency at the moment this row was written. */
  currency:     varchar("currency", { length: 8 }).default("USD").notNull(),

  updatedAt:    timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  /** UPSERT target — full grain. */
  uniqGrain: uniqueIndex("uniq_fact_attribution").on(
    t.userId, t.date,
    t.bmId, t.adAccountId,
    t.campaignId, t.adsetId, t.adId,
    t.pageId, t.formId, t.offerId,
  ),
  /** Primary access pattern — "everything for user X over date range". */
  idxUserDate:     index("idx_fact_attr_user_date").on(t.userId, t.date),
  /** Group-by-campaign drill-down. */
  idxUserCampaign: index("idx_fact_attr_user_campaign").on(t.userId, t.campaignId, t.date),
  /** Group-by-offer drill-down. */
  idxUserOffer:    index("idx_fact_attr_user_offer").on(t.userId, t.offerId, t.date),
  /** Group-by-BM drill-down. */
  idxUserBm:       index("idx_fact_attr_user_bm").on(t.userId, t.bmId, t.date),
}));

export type FactAttributionDaily       = typeof factAttributionDaily.$inferSelect;
export type InsertFactAttributionDaily = typeof factAttributionDaily.$inferInsert;

// ─── Insights — campaign_daily_insights (Phase 2 spend cache) ────────────────
//
// Per-day spend granularity from the FB Marketing API insights endpoint
// (called with `time_increment=1`). The rollup worker joins this table by
// (userId, fbCampaignId, date) to fill fact_attribution_daily.spendAmount
// — the existing `campaign_insights` table only stores preset-aggregated
// totals (today / yesterday / last_7d / last_30d), which the rollup's
// daily grain cannot use.
//
// `currency` is a snapshot of the source ad_account's currency. The
// rollup compares it to the user's baseCurrency and skips rows that
// don't match (v1: no FX conversion).
export const campaignDailyInsights = mysqlTable("campaign_daily_insights", {
  id:              int("id").autoincrement().primaryKey(),
  userId:          int("userId").notNull(),
  fbAdAccountId:   varchar("fbAdAccountId", { length: 64 }).notNull(),
  fbCampaignId:    varchar("fbCampaignId",  { length: 64 }).notNull(),
  /** YYYY-MM-DD; string mode for the same midnight-UTC reasons as
   *  fact_attribution_daily.date. */
  date:            date("date", { mode: "string" }).notNull(),
  /** Smallest-unit integer in `currency` (UZS so'm units / USD cents). */
  spend:           varchar("spend", { length: 32 }).default("0").notNull(),
  currency:        varchar("currency", { length: 8 }).default("USD").notNull(),
  impressions:     int("impressions").default(0).notNull(),
  clicks:          int("clicks").default(0).notNull(),
  /** Lead count as FB reports it (independent of our leads table). */
  leadsReported:   int("leadsReported").default(0).notNull(),
  syncedAt:        timestamp("syncedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  /** UPSERT target — one row per (user, campaign, day). */
  uniqCampaignDay: uniqueIndex("uniq_campaign_day").on(t.userId, t.fbCampaignId, t.date),
  /** Rollup join hot-path: WHERE userId=? AND date BETWEEN ? AND ?. */
  idxUserDate:     index("idx_user_date").on(t.userId, t.date),
  /** Per-campaign drill: WHERE userId=? AND fbCampaignId=? AND date IN (…). */
  idxUserCampaignDate: index("idx_user_campaign_date").on(t.userId, t.fbCampaignId, t.date),
  /** Per-ad-account ops queries (rare). */
  idxUserAdAccount: index("idx_user_ad_account").on(t.userId, t.fbAdAccountId),
}));

export type CampaignDailyInsights       = typeof campaignDailyInsights.$inferSelect;
export type InsertCampaignDailyInsights = typeof campaignDailyInsights.$inferInsert;

// ─── Insights — fx_rates (Phase 4: USD/UZS exchange rates) ───────────────────
//
// Daily snapshot of UZS-per-USD from the Central Bank of Uzbekistan (CBU)
// JSON API. The rollup worker joins this by `date` so it can express
// Revenue / Spend in the user's chosen baseCurrency even when the source
// transaction is in another currency.
//
// Storage choice: DECIMAL(10,4) keeps the rate precise without depending
// on JS float quirks. mysql2 returns DECIMAL as a string by default; the
// rollup SQL keeps math in MySQL via CAST so JS never sees the raw value.
//
// "Last-known-rate" fallback: the rollup picks the rate for the lead's
// date, or the most recent rate ≤ that date if the CBU sync hasn't run
// for that day yet. Audit-friendly: a 2026-05-15 lead always uses the
// 2026-05-15 rate (or the closest earlier day), never the rate at
// rollup-read time.
export const fxRates = mysqlTable("fx_rates", {
  id:           int("id").autoincrement().primaryKey(),
  date:         date("date", { mode: "string" }).notNull(),
  /** How many UZS so'm equal 1 USD on `date`. CBU publishes this daily;
   *  exposed as a numeric string at the drizzle boundary to avoid JS
   *  float precision surprises (matches the existing money-column
   *  convention used in fact_attribution_daily). */
  uzsPerUsd:    varchar("uzs_per_usd", { length: 16 }).notNull(),
  /** Where the rate came from. 'CBU' for the official Central Bank pull;
   *  'manual' if an admin overrode it. */
  source:       varchar("source", { length: 32 }).default("CBU").notNull(),
  fetchedAt:    timestamp("fetched_at").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  /** One rate per day — UPSERT target. */
  uniqDate: uniqueIndex("uniq_fx_date").on(t.date),
  /** Range lookups for rollup fallback. */
  idxDate:  index("idx_fx_date").on(t.date),
}));

export type FxRate       = typeof fxRates.$inferSelect;
export type InsertFxRate = typeof fxRates.$inferInsert;
