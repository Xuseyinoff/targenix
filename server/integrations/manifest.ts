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

// ─── ConfigField schema (Commit 1 of Phase 4) ──────────────────────────────────
// Declarative JSON-ish schema describing ONE input rendered by the dynamic form.
// These are plain data structures — no functions, no closures — so they can be
// serialised to the client, persisted, versioned, and round-tripped through any
// storage layer without evaluation concerns.
//
// At this commit these types are OPTIONAL metadata on each AppModule. Nothing
// at runtime consumes them yet (the dynamic form engine arrives in Commit 3).
// The only active code path is the registry validation pass, which warns about
// malformed schemas at boot but never throws — existing deliveries are
// unaffected.

export type ConfigFieldType =
  | "text"              // single-line string input
  | "password"          // single-line masked input (UI only — not encryption)
  | "textarea"          // multi-line string input
  | "number"            // numeric input
  | "boolean"           // toggle / checkbox
  | "select"            // dropdown with static options[]
  | "async-select"      // dropdown whose options come from optionsSource
  | "multi-select"      // multi-value dropdown with static options[]
  | "connection-picker" // picks a row from the connections table by type
  | "field-mapping"     // destination-field → lead-variable map
  | "code"              // JSON/raw editor (monospace)
  | "hidden"            // present in config but not rendered (defaults / legacy)
  // ── Make.com parity widgets ────────────────────────────────────────────────
  | "repeatable"        // array of sub-records (e.g. Headers as [{name, value}])
  | "group";            // visual grouping of related sub-fields, optional collapse

export interface ConfigFieldOption {
  value: string;
  label: string;
}

export interface ConfigFieldValidation {
  minLength?: number;
  maxLength?: number;
  /** JS regex source, NOT including delimiters. Applied via new RegExp(pattern). */
  pattern?: string;
  min?: number;
  max?: number;
}

/**
 * Conditional visibility rule. Field is shown only when the referenced field's
 * current value matches. Exactly one of equals / notEquals / in must be set.
 */
export interface ConfigFieldShowWhen {
  /** Key of another field in the same module. */
  field: string;
  equals?: unknown;
  notEquals?: unknown;
  in?: unknown[];
}

/**
 * Which Connections row type this picker filters on. Mirrors the
 * connections.type enum declared in drizzle/schema.ts.
 */
export type ConnectionPickerType = "google_sheets" | "telegram_bot" | "api_key";

export interface ConfigField {
  /** Stable key — persisted to integration config JSON. */
  key: string;
  type: ConfigFieldType;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  /** Initial value when the form is first opened. */
  defaultValue?: unknown;
  /** Static options for 'select' / 'multi-select'. */
  options?: ConfigFieldOption[];
  /**
   * For 'async-select' / 'field-mapping' — name of a loader declared in
   * AppManifest.dynamicOptionsLoaders. Validated at registry boot.
   */
  optionsSource?: string;
  /**
   * For 'field-mapping' — loader whose output lists the destination column
   * headers (e.g. Google Sheet column names).
   */
  headersSource?: string;
  /**
   * Keys of other fields in the same module that this field depends on.
   * The dynamic form re-runs the async loader whenever a dependency changes.
   */
  dependsOn?: string[];
  /** Conditional visibility — hide when the rule is not satisfied. */
  showWhen?: ConfigFieldShowWhen;
  /** Validation applied on the client and re-checked on the server. */
  validation?: ConfigFieldValidation;
  /**
   * For 'connection-picker' — which connection type to filter. Required when
   * type === 'connection-picker'.
   */
  connectionType?: ConnectionPickerType;
  /**
   * When true the UI should mask the value (password-style) and logs must
   * never print it. Useful for api keys inside 'text' fields.
   */
  sensitive?: boolean;

  /**
   * When true the dynamic form renders a real-time transform-engine preview
   * beneath this field (Make.com-style resolved-value pill). Only meaningful
   * for 'text' and 'textarea' field types that accept {{expression}} syntax.
   */
  showTransformPreview?: boolean;

  // ── Repeatable fields (type === "repeatable") ──────────────────────────────
  /**
   * Shape of ONE row inside a repeatable field. The dynamic form renders each
   * row as a compact inline mini-form over these sub-fields. Sub-fields MUST
   * NOT themselves be of type `repeatable` or `group` — nesting is flat on
   * purpose so the validator + serializer stay easy to reason about.
   *
   * Example (Headers as rows):
   *   { key: "headers", type: "repeatable",
   *     itemFields: [
   *       { key: "name",  type: "text", label: "Name",  required: true },
   *       { key: "value", type: "text", label: "Value", required: true },
   *     ] }
   */
  itemFields?: ConfigField[];
  /** Minimum number of rows (0 = completely empty is valid). Default 0. */
  minItems?: number;
  /** Maximum number of rows a user can add. Default: unbounded. */
  maxItems?: number;
  /** Label shown on the "+ Add" button. Default "Add row". */
  addButtonLabel?: string;

  // ── Grouped fields (type === "group") ──────────────────────────────────────
  /**
   * Child fields rendered under a shared header. Useful for grouping an
   * app's "Advanced settings" behind one collapsible toggle. Children live
   * in the SAME top-level `values` namespace — group is purely a visual
   * container, not a scope — so child.key stays globally unique within
   * the module. Nesting a group inside a group or a repeatable is not
   * supported (validator warns + ignores).
   */
  groupFields?: ConfigField[];
  /** Render a chevron toggle; group collapses when clicked. Default false. */
  collapsible?: boolean;
  /** When collapsible === true, start collapsed. Default false. */
  defaultCollapsed?: boolean;

  // ── Make.com-style Map toggle ──────────────────────────────────────────────
  /**
   * When true, the form engine renders a per-field "Map" toggle (Make.com /
   * Zapier style). Toggle ON → input becomes a trigger-variable picker
   * (e.g. pick `{{full_name}}`). Toggle OFF → standard static input.
   *
   * Activation requires the host page to also pass `availableVariables` into
   * DynamicForm — otherwise the toggle is hidden (architectural stub for
   * future inbound-webhook / runtime-mapping flows). No behaviour change for
   * existing apps that leave this unset.
   */
  mappable?: boolean;
}

export interface AppModule {
  /** Stable identifier referenced by scenarios/tRPC (e.g. "send_message"). */
  key: string;
  /** Human-readable name. */
  name: string;
  /** Currently only outbound delivery is modelled. Web-/reverse-hooks later. */
  kind: "action";
  /** Optional description shown in docs / tooltips. */
  description?: string;
  /**
   * Declarative list of inputs rendered by the dynamic form (Commit 3).
   * Optional for backwards-compat: modules without fields still work, they
   * simply cannot be rendered by the new form engine yet.
   */
  fields?: ConfigField[];
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
   * Placeholder in Phase 2 — superseded by AppModule.fields[] in Commit 1 of
   * Phase 4. Kept for backward-compat with any external tooling that might
   * reference it. New apps should declare fields[] on each module instead.
   *
   * @deprecated use AppModule.fields[] — will be removed after all built-in
   * apps migrate to the new schema.
   */
  configSchema?: unknown;
  /**
   * Maps each optionsSource / headersSource key used by this app's fields to
   * a backend loader identifier (e.g. "appsRouter.googleSheets.listSheetTabs").
   * Declared here — not on each field — because the same loader is often
   * reused across several fields, and because Commit 2 will wire a single
   * tRPC router that reads this map to dispatch loadOptions calls.
   *
   * Validated at registry boot: every optionsSource / headersSource referenced
   * by a field MUST exist as a key here, otherwise validateManifestFields()
   * reports a problem.
   */
  dynamicOptionsLoaders?: Record<string, string>;

  /** UI gating. Deprecated apps are still usable but should not be promoted. */
  availability: AppAvailability;

  /**
   * When true the app is hidden from end-user pickers (legacy/internal only).
   * listApps() defaults to { includeInternal: false }.
   */
  internal?: boolean;
}
