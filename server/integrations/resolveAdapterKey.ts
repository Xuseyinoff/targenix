/**
 * Picks a delivery `adapterKey` from integration type + `target_websites` row.
 *
 * Stage 2: when `appKey` is set (backfill 0049 / new creates), map by `appKey`
 * first. Otherwise preserve legacy `templateId` + `templateType` behaviour.
 *
 * Rollback: delete the `if (appKeyNorm)` block and restore the prior chain
 * (templateId first, then templateType).
 *
 * First-party `appKey` values (`telegram`, `google-sheets`, …) are also seeded
 * in `apps` / `app_actions` (see migration 0050) for DB catalogue; routing here
 * stays TS-defined for determinism. After migrations 0051/0052, `appKey` is NOT
 * NULL; `unknown` is a backfill sentinel treated like missing for routing.
 *
 * Logging: set `STAGE2_ADAPTER_LOG=1` only when debugging. Leave unset in
 * production to avoid per-delivery `console.log` volume. For resolved adapter
 * + appKey, see `STAGE2_APP_ROUTING_LOG=1` in `dispatchDelivery`.
 */
export function resolveAdapterKey(
  integrationType: string,
  tw?: {
    templateId?: number | null;
    templateType?: string | null;
    appKey?: string | null;
  } | null,
): string {
  if (integrationType === "AFFILIATE") return "affiliate";

  if (!tw) return "plain-url";

  const appKeyRaw = tw.appKey;
  const appKeyNorm =
    appKeyRaw != null && String(appKeyRaw).trim() !== "" ? String(appKeyRaw).trim() : null;
  // DB backfill sentinel (0051/0052): treat like missing appKey so templateType / templateId
  // still drive delivery — same dual-mode as pre–NOT NULL rows.
  const effectiveKey = appKeyNorm === "unknown" ? null : appKeyNorm;

  if (effectiveKey) {
    if (process.env.STAGE2_ADAPTER_LOG === "1" || process.env.STAGE2_ADAPTER_LOG === "true") {
      console.log({
        stage: "adapter_resolution",
        path: "NEW" as const,
        appKey: effectiveKey,
        templateType: tw.templateType,
        templateId: tw.templateId,
      });
    }
    if (effectiveKey === "telegram") return "telegram";
    if (effectiveKey === "google-sheets" || effectiveKey === "google_sheets") return "google-sheets";
    // Sentinel written by the NOT NULL backfill for destinations that had no templateType.
    if (effectiveKey === "plain-url") return "plain-url";
    // No templateId → appKey was copied from legacy templateType column during the NOT NULL
    // backfill (sotuvchi, 100k, albato, custom, …). Route to legacy-template so the
    // legacyTemplateAdapter continues to use tw.templateType for delivery, exactly as before.
    if (!tw.templateId) return "legacy-template";
    // Has both appKey and templateId → a proper DB-catalogue affiliate destination.
    return "dynamic-template";
  }

  if (process.env.STAGE2_ADAPTER_LOG === "1" || process.env.STAGE2_ADAPTER_LOG === "true") {
    console.log({
      stage: "adapter_resolution",
      path: "LEGACY" as const,
      appKey: tw.appKey ?? null,
      templateType: tw.templateType,
      templateId: tw.templateId,
    });
  }

  // telegram / google-sheets must be identified by templateType BEFORE
  // checking templateId — a destination can have both fields set (e.g. data
  // migration artefact) and templateId must NOT silently override intent.
  if (tw.templateType === "telegram") return "telegram";
  if (tw.templateType === "google-sheets") return "google-sheets";
  if (tw.templateId) return "dynamic-template";
  if (tw.templateType) return "legacy-template";
  return "plain-url";
}
