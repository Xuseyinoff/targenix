/**
 * Shared helpers for Lead-Routing wizards.
 *
 * Both the legacy `LeadRoutingWizard` (stepped) and the new Make.com-style
 * `IntegrationWizardV2` (stacked cards) persist the SAME integration config
 * shape — so their field-mapping logic must behave identically. Pulling the
 * constants and pure helpers into this module guarantees they can never
 * drift and keeps either wizard free to iterate on UX without touching
 * serialisation semantics.
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

// ─── Template variable-field definitions (known destination templates) ───────

/**
 * Destination templates known at build time. When a user picks a template
 * with required variables (e.g. "sotuvchi" → offer_id + stream), the wizard
 * renders those inputs. "custom" is handled separately via an API that
 * extracts variables from the template body.
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
