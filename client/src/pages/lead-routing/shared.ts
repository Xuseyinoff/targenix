/**
 * Shared helpers for the Lead Routing integration wizard (IntegrationWizardV2)
 * and related server queries. Constants and pure helpers live here so mapping
 * semantics stay consistent with `integrations.create` / `update` payloads.
 *
 * Nothing here depends on React or the router; everything is plain data
 * and pure functions so unit-testable in isolation.
 */

// ─── Auto-match patterns ──────────────────────────────────────────────────────

/**
 * Ordered list of substrings that identify a full-name / name field coming
 * from a Facebook lead form. Matching is case-insensitive and substring —
 * the first field whose lowercase key contains one of these wins.
 * Covers English, Russian and Uzbek variants we see in the wild.
 */
export const NAME_PATTERNS = [
  "full_name",
  "fullname",
  "name",
  "first_name",
  "firstname",
  "имя",
  "фио",
  "ismi",
  "ism",
  "полное_имя",
  "полное имя",
] as const;

/**
 * Same idea as NAME_PATTERNS but for the phone number. Uzbek keys like
 * "raqam" / "telefon" matter here because many UZ advertisers localise
 * their form labels.
 */
export const PHONE_PATTERNS = [
  "phone",
  "phone_number",
  "phonenumber",
  "telefon",
  "телефон",
  "mobile",
  "номер_телефона",
  "номер телефона",
  "raqam",
] as const;

/** First form field whose lowercase key matches any pattern, or "" if none. */
export function autoMatchField(
  fields: ReadonlyArray<{ key: string }>,
  patterns: ReadonlyArray<string>,
): string {
  for (const f of fields) {
    const key = f.key.toLowerCase();
    if (patterns.some((p) => key.includes(p))) return f.key;
  }
  return "";
}

// ─── Facebook metadata fields (selectable as extra sources) ──────────────────

export const FB_METADATA_FIELDS = [
  { key: "lead_id", label: "Lead ID" },
  { key: "form_id", label: "Form ID" },
  { key: "ad_id", label: "Ad ID" },
  { key: "ad_name", label: "Ad Name" },
  { key: "adset_id", label: "Ad Set ID" },
  { key: "adset_name", label: "Ad Set Name" },
  { key: "campaign_id", label: "Campaign ID" },
  { key: "campaign_name", label: "Campaign Name" },
] as const;

export const FB_METADATA_LABELS: Record<string, string> = Object.fromEntries(
  FB_METADATA_FIELDS.map((f) => [f.key, f.label]),
);

// ─── FieldMapping — new universal mapping row (IntegrationWizardV2) ──────────

/**
 * One row in the "Map lead fields" section of the new wizard.
 *
 * • `from !== null`  → value comes from the FB form payload (field key)
 * • `from === null`  → value is a hard-coded static string (`staticValue`)
 * • `to`             → the key the value lands under in the destination payload
 *
 * Stored as `config.fieldMappings` on new integrations.  Legacy integrations
 * produced by the old routing wizard keep using `config.nameField` /
 * `config.phoneField` / `config.extraFields` — leadService supports both.
 */
export interface FieldMapping {
  from: string | null;
  to: string;
  staticValue?: string;
}

export function serializeFieldMappings(
  mappings: FieldMapping[],
): FieldMapping[] {
  return mappings
    .filter((m) => m.to.trim() !== "")
    .map((m) => ({
      from: m.from,
      to: m.to.trim(),
      ...(m.from === null ? { staticValue: m.staticValue ?? "" } : {}),
    }));
}

// ─── ExtraField draft type (UI-side representation) ───────────────────────────

export type ExtraFieldDraft = {
  /** Destination-side key the value ends up under in the config. */
  destKey: string;
  /** "form" = value comes from the lead payload; "static" = hardcoded. */
  sourceType: "form" | "static";
  sourceField?: string;
  staticValue?: string;
  /** True for manually typed source keys (not in form/metadata lists). */
  manualSource?: boolean;
};

export function createEmptyExtraField(): ExtraFieldDraft {
  return {
    destKey: "",
    sourceType: "form",
    sourceField: "",
    staticValue: "",
    manualSource: true,
  };
}

export function isKnownFormOrMetaFieldKey(
  key: string,
  formFields: ReadonlyArray<{ key: string }>,
): boolean {
  const k = key.trim();
  if (!k) return false;
  if (formFields.some((f) => f.key === k)) return true;
  return FB_METADATA_FIELDS.some((m) => m.key === k);
}

/**
 * Drops empty rows and shapes the persisted payload. `sourceField` is kept
 * only for form-sourced rows and `staticValue` only for static rows — so the
 * server never sees an ambiguous mixed row.
 */
export function serializeExtraFields(extraFields: ReadonlyArray<ExtraFieldDraft>) {
  return extraFields
    .filter((field) => field.destKey.trim())
    .map((field) => ({
      destKey: field.destKey.trim(),
      sourceField: field.sourceType === "form" ? field.sourceField : undefined,
      staticValue:
        field.sourceType === "static" ? field.staticValue?.trim() : undefined,
    }));
}

/** Inverse of serializeExtraFields, used when loading an existing integration. */
export function hydrateExtraFields(value: unknown): ExtraFieldDraft[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    return {
      destKey: typeof item.destKey === "string" ? item.destKey : "",
      sourceType: item.staticValue !== undefined ? "static" : "form",
      sourceField: typeof item.sourceField === "string" ? item.sourceField : "",
      staticValue: typeof item.staticValue === "string" ? item.staticValue : "",
    };
  });
}

// ─── App Manifest — JSON-driven service schema (Make.com/Zapier level) ────────

/**
 * A single row in the wizard's "Field mapping" grid for a destination.
 *
 * Historically every row was a FROM-lead mapping (pick an FB form field that
 * feeds the outbound key). With admin-managed destination templates that
 * declare `bodyFields` + `userVisibleFields` + `variableFields`, the same
 * grid now hosts three very different widgets:
 *
 *   • mode="auto"   → Select of Facebook form fields + metadata.
 *                     Pre-matched from `autoDetect` (name / phone).
 *   • mode="static" → Plain text input. User types the per-integration value
 *                     (e.g. offer_id, stream). `staticDefault` pre-fills from
 *                     the destination's templateConfig so the admin default
 *                     shows up until the user overrides it.
 *   • mode="secret" → Read-only chip sourced from the saved connection /
 *                     destination credentials. `secretLabel` holds the
 *                     masked preview (e.g. "••••cd21") so the user can
 *                     visually confirm which credential is being used.
 *
 * The legacy code path (server manifest apps like Telegram / Sheets, and
 * the UZ-CPA fallback for admin templates without `autoMappedFields`) stays
 * on `mode="auto"` so behaviour is unchanged.
 */
export interface AppManifestLeadField {
  key: string;       // outbound payload key: "name", "phone", "offer_id", …
  label: string;     // UI label shown to user: "Ism (to'liq)"
  required: boolean;
  mode: "auto" | "static" | "secret";
  /** mode="auto" only — which global pattern set feeds first-load matching. */
  autoDetect?: "name" | "phone";
  /** mode="static" only — placeholder shown in the input (admin default). */
  staticDefault?: string;
  /** mode="secret" only — short masked preview shown in the read-only chip. */
  secretLabel?: string;
}

/**
 * One service (destination template) known at build time.
 *
 * leadFields        — fields mapped FROM the FB form by the user.
 * connectionKeys    — keys inside destination.templateConfig that are shown
 *                     read-only in the wizard as the "connection config".
 *                     Secret keys (apiKeyMasked, botTokenMasked) are always
 *                     added automatically; only non-secret display keys go here.
 */
export interface AppManifestService {
  id: string;
  label: string;
  description: string;
  leadFields: AppManifestLeadField[];
  connectionKeys: string[];
}

/**
 * Static variable-field presets per legacy template type key; used by the
 * server's `targetWebsitesRouter.getVariableFields` query. Admin templates
 * supply richer metadata via `destination_templates` (see
 * `resolveDestManifest` in IntegrationWizardV2.tsx).
 */
export const TEMPLATE_VARIABLE_FIELDS: Record<
  string,
  ReadonlyArray<{ key: string; label: string; placeholder: string; required: boolean }>
> = {
  sotuvchi: [
    { key: "offer_id", label: "Offer ID", placeholder: "e.g. 123", required: true },
    { key: "stream", label: "Stream", placeholder: "e.g. main", required: true },
  ],
  "100k": [
    { key: "stream_id", label: "Stream ID", placeholder: "e.g. 456", required: true },
  ],
  custom: [],
};
