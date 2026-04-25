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
  /** Destinations delivery mapping mode: ALL (auto-map) or MANUAL (per-destination). */
  telegramDestinationDeliveryMode: mysqlEnum("telegramDestinationDeliveryMode", ["ALL", "MANUAL"])
    .default("MANUAL")
    .notNull(),
  /** Default DELIVERY chat id used when mode = ALL. */
  telegramDestinationDefaultChatId: varchar("telegramDestinationDefaultChatId", { length: 64 }),
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

// ─── Google Accounts ──────────────────────────────────────────────────────────
// One row per connected Google account per platform user.
// One user can connect multiple Google accounts (multiple Google emails).
export const googleAccounts = mysqlTable("google_accounts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  /** Google account email address */
  email: varchar("email", { length: 320 }).notNull(),
  /** Display name from Google profile */
  name: varchar("name", { length: 255 }),
  /** Google profile picture URL */
  picture: varchar("picture", { length: 512 }),
  /** OAuth access token — stored AES-256-CBC encrypted */
  accessToken: text("accessToken").notNull(),
  /** OAuth refresh token — stored AES-256-CBC encrypted. Null if not returned (already connected). */
  refreshToken: text("refreshToken"),
  /** Absolute timestamp when the access token expires */
  expiryDate: timestamp("expiryDate"),
  /**
   * "login"       — created during Google Login / Register (openid, email, profile scopes only).
   *                 NEVER used for API access (Sheets, Drive, etc.).
   * "integration" — created when user connects Google for API access (full scopes).
   *                 Used exclusively for Sheets/Drive/etc. calls.
   */
  type: mysqlEnum("type", ["login", "integration"]).default("login").notNull(),
  /** Space-separated list of OAuth scopes that were granted for this token. */
  scopes: text("scopes"),
  connectedAt: timestamp("connectedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, (t) => ({
  // One row per (user, email, type) — same Google email can appear as both login + integration
  uqUserEmailType: uniqueIndex("uq_google_accounts_user_email_type").on(t.userId, t.email, t.type),
  idxUserId: index("idx_google_accounts_user_id").on(t.userId),
  idxType: index("idx_google_accounts_type").on(t.userId, t.type),
}));

export type GoogleAccount = typeof googleAccounts.$inferSelect;
export type InsertGoogleAccount = typeof googleAccounts.$inferInsert;

// ─── Google OAuth States (CSRF protection) ────────────────────────────────────
// Short-lived tokens stored during the OAuth authorization_code flow.
// Verified on callback to prevent CSRF attacks; deleted immediately after use.
export const googleOauthStates = mysqlTable("google_oauth_states", {
  id: int("id").autoincrement().primaryKey(),
  /** Cryptographically random 64-hex-char state token */
  state: varchar("state", { length: 128 }).notNull(),
  /** Platform user who initiated the flow. 0 = login flow (user not yet authenticated). */
  userId: int("userId").notNull(),
  /**
   * "login"       — flow started from Login / Register page (no session required).
   * "integration" — flow started from Connections page (session required, userId > 0).
   */
  type: mysqlEnum("type", ["login", "integration"]).default("login").notNull(),
  /** 10-minute TTL */
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (t) => ({
  uqState: uniqueIndex("uq_google_oauth_states_state").on(t.state),
  idxUserId: index("idx_google_oauth_states_user_id").on(t.userId),
}));

export type GoogleOauthState = typeof googleOauthStates.$inferSelect;
export type InsertGoogleOauthState = typeof googleOauthStates.$inferInsert;

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
// target_websites.templateConfig. Step 1 scaffold — additive only; delivery
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
  /** @deprecated use oauthTokenId — legacy google_accounts.id (integration). */
  googleAccountId: int("googleAccountId"),
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
}));

export type Connection = typeof connections.$inferSelect;
export type InsertConnection = typeof connections.$inferInsert;

// ─── Target Websites ──────────────────────────────────────────────────────────
// A list of affiliate/CRM websites that leads are routed to.
//
// templateType: 'sotuvchi' | '100k' | 'albato' | 'custom' | 'telegram' (legacy hardcoded)
// templateId:   FK to destinationTemplates (dynamic admin-managed templates)
// templateConfig: template-specific config JSON, e.g.:
//   legacy:  { apiKeyEncrypted, ... }
//   dynamic: { secrets: { api_key: "encrypted:..." }, variables: {} }
//   telegram: { botTokenEncrypted, chatId, messageTemplate }
export const targetWebsites = mysqlTable("target_websites", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  /** Base URL of the target website's lead submission endpoint. NULL for telegram destinations. */
  url: text("url"),
  /** Optional static headers as JSON object */
  headers: json("headers"),
  /** Template type: sotuvchi | 100k | albato | custom (legacy; null when using templateId) */
  templateType: varchar("templateType", { length: 32 }).default("custom").notNull(),
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

export type TargetWebsite = typeof targetWebsites.$inferSelect;
export type InsertTargetWebsite = typeof targetWebsites.$inferInsert;

// ─── Integrations ─────────────────────────────────────────────────────────────
// LEAD_ROUTING: full pipeline — FB account → page → form → field map → target website
// AFFILIATE: POST lead to an external HTTP endpoint
export const integrations = mysqlTable("integrations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  type: mysqlEnum("type", ["AFFILIATE", "LEAD_ROUTING"]).notNull(),
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

// ─── Integration Destinations ─────────────────────────────────────────────────
// Fan-out join between ONE integration and N target_websites (migration 0044).
//
// This is the Make.com-style multi-destination scaffold. Until Commit 5 wires
// the feature-flagged dual-read, the legacy `integrations.targetWebsiteId`
// column remains the dispatch source of truth. This table is kept in sync by
// dual-write in server/db.ts so both shapes stay correct during the rollout.
//
// Invariants:
//   - (integrationId, targetWebsiteId) is UNIQUE.
//   - Both FKs CASCADE: deleting an integration or a target website removes
//     the mapping automatically — no orphans, no dangling dispatch attempts.
//   - `position` drives fan-out order (all zero today; reorderable later).
//   - `enabled` lets a user pause ONE destination without deleting the row.
//   - `filterJson` is reserved for per-destination Make.com-style filters
//     (Phase 5+). NULL and unread at this commit.
export const integrationDestinations = mysqlTable(
  "integration_destinations",
  {
    id: int("id").autoincrement().primaryKey(),
    integrationId: int("integrationId").notNull(),
    targetWebsiteId: int("targetWebsiteId").notNull(),
    position: int("position").default(0).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    filterJson: json("filterJson"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull().onUpdateNow(),
  },
  (t) => ({
    // Dispatch hot-path: resolve all enabled destinations for one integration,
    // ordered. Index covers the full WHERE + ORDER BY clause.
    idxIntegration: index("idx_integration_destinations_integration").on(
      t.integrationId,
      t.enabled,
      t.position,
    ),
    // Reverse lookup — "what integrations deliver to this destination?" —
    // used when cleaning up on target_website delete.
    idxTargetWebsite: index("idx_integration_destinations_target_website").on(
      t.targetWebsiteId,
    ),
    // Hard guarantee against duplicate mappings in the UI or via a race.
    uniqIntegrationDestination: uniqueIndex("uniq_integration_destination").on(
      t.integrationId,
      t.targetWebsiteId,
    ),
  }),
);

export type IntegrationDestination = typeof integrationDestinations.$inferSelect;
export type InsertIntegrationDestination = typeof integrationDestinations.$inferInsert;

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
  /**
   * Which `integration_destinations` row this order is delivering to.
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
