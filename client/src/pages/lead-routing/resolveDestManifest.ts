/**
 * resolveDestManifest — the single "spine" that merges the two
 * service-definition worlds into one AppManifestService:
 *   • admin-managed `destination_templates` (DB rows, infinite scale)
 *   • code-registered server manifests (Telegram, Sheets, HTTP Webhook, …)
 *
 * Extracted from IntegrationWizardV2.tsx — pure logic, no React.
 *
 * Priority (first match wins):
 *   ⓪. destType === "custom"    → CUSTOM_MANIFEST (row-builder UI)
 *   ①. DB autoMappedFields set   → fully dynamic manifest from DB
 *   ②. templateId set, AMF empty → UZ-CPA convention (name+phone FROM_LEAD)
 *   ③. Server manifest app.key   → default name+phone leadFields
 *
 * The client-side APP_MANIFEST registry (hardcoded sotuvchi/100k/telegram
 * entries) was retired in favour of the two sources above.
 */

import type { AppManifestLeadField, AppManifestService } from "./shared";

export type DestRecordLike = {
  templateId?: number | null;
  templateName?: string | null;
  autoMappedFields?: unknown;
  /** List of keys admin declared as per-integration variables (offer_id, stream, …). */
  variableFields?: unknown;
  /** List of keys backed by saved credentials (api_key, bot_token, …). */
  userVisibleFields?: unknown;
  /** Already-masked view from destinations.list — holds admin defaults + masked secrets. */
  templateConfig?: unknown;
};

export type ServerAppStub = { key: string; name: string; description: string | null };

// Turn a machine key into something humans tolerate reading: "offer_id" → "Offer id".
// We keep it minimal (Title Case on the first word, spaces instead of
// underscores) so translated labels from admin-managed templates win whenever
// they're provided.
export function humanizeKey(key: string): string {
  if (!key) return "";
  const spaced = key.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const DEFAULT_LEAD_FIELDS: AppManifestLeadField[] = [
  { key: "name",  label: "Ism (to'liq)",   required: true, mode: "auto", autoDetect: "name"  },
  { key: "phone", label: "Telefon raqami",  required: true, mode: "auto", autoDetect: "phone" },
];

// Custom Webhook is the only "app" that genuinely has no lead schema — the
// user builds the mapping row-by-row via FieldMappingsEditor. Kept here
// (rather than in shared.ts) because it is rendering glue, not a service def.
export const CUSTOM_MANIFEST: AppManifestService = {
  id: "custom",
  label: "Custom Webhook",
  description: "POST to any URL",
  leadFields: [],
  connectionKeys: [],
};

/**
 * Resolve the secret preview shown in mode="secret" chips.
 *
 * Admin-managed templates currently stash masked previews inside
 * `templateConfig.apiKeyMasked` / `templateConfig.botTokenMasked` (via
 * maskConfig on the server). Other secret keys fall back to a generic
 * "••••" indicator so the user still sees that a credential is on file.
 */
function previewForSecretKey(
  key: string,
  templateConfig: Record<string, unknown>,
): string {
  if (key.includes("api_key") || key === "apiKey") {
    const masked = templateConfig.apiKeyMasked;
    if (typeof masked === "string" && masked) return masked;
  }
  if (key.includes("bot_token") || key === "botToken") {
    const masked = templateConfig.botTokenMasked;
    if (typeof masked === "string" && masked) return masked;
  }
  const direct = templateConfig[`${key}Masked`];
  if (typeof direct === "string" && direct) return direct;
  return "••••";
}

export function resolveDestManifest(
  destRecord: DestRecordLike | null | undefined,
  destType: string,
  destName: string,
  serverApps: ServerAppStub[] = [],
): AppManifestService | null {
  if (!destType) return null;

  // ⓪ Real (bare) custom webhook — no schema, wizard uses FieldMappingsEditor.
  //
  // Caveat: admin-managed template destinations (sotuvchi, 100k, inbaza, …)
  // are ALSO persisted with `templateType: "custom"` for backwards-compat
  // with the original UZ-CPA schema; what distinguishes them is a
  // non-null `templateId` pointing at the destination_templates row.
  // Skipping path ⓪ in that case lets path ① build the dynamic
  // auto/static/secret mapping grid instead of short-circuiting to the
  // generic custom-webhook row builder.
  const hasTemplate = (destRecord?.templateId ?? null) !== null;
  if (destType === "custom" && !hasTemplate) return CUSTOM_MANIFEST;

  const dbAutoFields = (
    Array.isArray(destRecord?.autoMappedFields) ? destRecord!.autoMappedFields : []
  ) as Array<{ key: string; label: string }>;

  // ① DB has explicit autoMappedFields — fully dynamic manifest.
  // Covers admin destination_templates (sotuvchi, 100k, inbaza, mycpa, …).
  //
  // We walk THREE ordered sources to build the Make.com-style mapping grid:
  //   A) autoMappedFields  → mode="auto"   (name, phone — FB form dropdown)
  //   B) variableFields    → mode="static" (offer_id, stream — per-integration text)
  //   C) userVisibleFields → mode="secret" (api_key — from the saved connection)
  //
  // A key appearing in more than one list wins in this order (auto > static >
  // secret) so admins can't accidentally make a FROM_LEAD field also a secret.
  if (dbAutoFields.length > 0) {
    const variableKeys = (
      Array.isArray(destRecord?.variableFields) ? destRecord!.variableFields : []
    ) as string[];
    const secretKeys = (
      Array.isArray(destRecord?.userVisibleFields) ? destRecord!.userVisibleFields : []
    ) as string[];
    const tplCfg = (destRecord?.templateConfig ?? {}) as Record<string, unknown>;

    const leadFields: AppManifestLeadField[] = [];
    const seen = new Set<string>();

    for (const f of dbAutoFields) {
      if (!f.key || seen.has(f.key)) continue;
      seen.add(f.key);
      leadFields.push({
        key: f.key,
        label: f.label || humanizeKey(f.key),
        required: true,
        mode: "auto",
        autoDetect:
          f.key === "name" || /name/i.test(f.key)
            ? "name"
            : f.key === "phone" || /phone/i.test(f.key)
              ? "phone"
              : undefined,
      });
    }

    for (const key of variableKeys) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const preset = tplCfg[key];
      leadFields.push({
        key,
        label: humanizeKey(key),
        required: true,
        mode: "static",
        staticDefault: typeof preset === "string" ? preset : "",
      });
    }

    for (const key of secretKeys) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      leadFields.push({
        key,
        label: humanizeKey(key),
        required: false, // already captured at destination creation; UI is read-only
        mode: "secret",
        secretLabel: previewForSecretKey(key, tplCfg),
      });
    }

    return {
      id: destType,
      label: destRecord?.templateName ?? destName,
      description: "",
      leadFields,
      // connectionKeys is now redundant for this path: secret + variable keys
      // are inline rows in leadFields. Left empty so the "Connection config"
      // block in AppManifestMapper hides itself.
      connectionKeys: [],
    };
  }

  // ② Admin-created template (templateId set) but autoMappedFields empty —
  // fall back to the universal UZ-CPA convention (name + phone FROM_LEAD).
  // Still expose variableFields as legacy connection keys for the read-only
  // Connection box so existing destinations keep rendering identically until
  // their admin adds autoMappedFields.
  const isAdminTemplate = (destRecord?.templateId ?? null) !== null;
  if (isAdminTemplate) {
    return {
      id: destType,
      label: destRecord?.templateName ?? destName,
      description: "",
      leadFields: DEFAULT_LEAD_FIELDS,
      connectionKeys: (
        Array.isArray(destRecord?.variableFields) ? destRecord!.variableFields : []
      ) as string[],
    };
  }

  // ③ Server manifest fallback — telegram, google-sheets, http-webhook,
  // and every future code-defined app. Default lead schema (name + phone)
  // because the FROM_LEAD stage is universal for inbound lead triggers.
  const serverApp = serverApps.find((a) => a.key === destType);
  if (serverApp) {
    return {
      id: serverApp.key,
      label: serverApp.name,
      description: serverApp.description ?? "",
      leadFields: DEFAULT_LEAD_FIELDS,
      connectionKeys: [],
    };
  }

  return null;
}
