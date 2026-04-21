/**
 * Make.com-style app manifest.
 *
 * Phase 2 — introduces a declarative metadata layer on top of the delivery
 * adapter registry. Each AppManifest describes ONE destination type (Telegram,
 * Google Sheets, custom HTTP webhook, …) and points at the adapter key that
 * actually performs the delivery.
 *
 * Phase 2 does NOT change runtime dispatch — adapters are still resolved via
 * resolveAdapterKey()/getAdapter(). Manifests are pure metadata used by:
 *   - future UI (Phase 4: dynamic forms from configSchema)
 *   - tRPC apps.list endpoint (this phase)
 *   - admin tooling / docs
 *
 * Adding a new integration in Phase 4+ becomes a matter of shipping:
 *   1. an adapter (server/integrations/adapters/<key>.ts)
 *   2. a manifest (server/integrations/apps/<key>.ts)
 * …with no changes to dispatch logic or DB schema.
 */

export type AppCategory =
  | "messaging"
  | "spreadsheet"
  | "webhook"
  | "ecommerce"
  | "affiliate"
  | "other";

export type AppAvailability = "stable" | "beta" | "deprecated";

/**
 * How this app acquires credentials.
 *   "none"          — inline credentials stored per-destination in
 *                     target_websites.templateConfig (legacy path).
 *   "oauth2_google" — resolves googleAccountId via the unified connections
 *                     table (Phase 3) or templateConfig fallback.
 *   "telegram_bot"  — resolves bot token + chatId via connections table or
 *                     templateConfig fallback.
 *   "custom_http"   — reserved for future API-key / header auth stored in
 *                     the connections table.
 */
export type ConnectionType =
  | "none"
  | "oauth2_google"
  | "telegram_bot"
  | "custom_http";

export interface AppModule {
  /** Stable identifier referenced by scenarios/tRPC (e.g. "send_message"). */
  key: string;
  /** Human-readable name. */
  name: string;
  /** Currently only outbound delivery is modelled. Web-/reverse-hooks later. */
  kind: "action";
  /** Optional description shown in docs / tooltips. */
  description?: string;
}

export interface AppManifest {
  /**
   * Unique app key. In Phase 2 this matches the adapter registry key 1:1 —
   * the indirection exists so Phase 4+ can decouple them (e.g. one adapter
   * shared across multiple apps, or one app routing to multiple adapters).
   */
  key: string;
  /** Display name. */
  name: string;
  /** Semver — bump when manifest shape or configSchema changes. */
  version: string;
  /** Lucide icon name (preferred) or absolute URL to an SVG/PNG. */
  icon?: string;
  category: AppCategory;
  /** Short user-facing description for listings. */
  description?: string;

  /**
   * Registry key fed into getAdapter(). Must point at a registered adapter.
   * Validated at boot time inside registerApp().
   */
  adapterKey: string;

  /** How credentials are provisioned — drives the Connection Picker UI later. */
  connectionType: ConnectionType;

  /**
   * Available modules. For now every app exposes a single "send lead" action;
   * triggers and multi-action apps belong to later phases.
   */
  modules: AppModule[];

  /**
   * JSON schema describing destination config (spreadsheetId, chatId, …).
   * Placeholder in Phase 2 — wired into a <SchemaForm> runtime in Phase 4.
   */
  configSchema?: unknown;

  /** UI gating. Deprecated apps are still usable but should not be promoted. */
  availability: AppAvailability;

  /**
   * When true the app is hidden from end-user pickers (legacy/internal only).
   * listApps() defaults to { includeInternal: false }.
   */
  internal?: boolean;
}
