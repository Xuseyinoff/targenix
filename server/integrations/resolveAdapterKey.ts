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
 * stays TS-defined for determinism.
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

  if (appKeyNorm) {
    if (process.env.STAGE2_ADAPTER_LOG === "1" || process.env.STAGE2_ADAPTER_LOG === "true") {
      console.log({
        stage: "adapter_resolution",
        path: "NEW" as const,
        appKey: appKeyNorm,
        templateType: tw.templateType,
        templateId: tw.templateId,
      });
    }
    if (appKeyNorm === "telegram") return "telegram";
    if (appKeyNorm === "google-sheets" || appKeyNorm === "google_sheets") return "google-sheets";
    // Affiliate / admin app keys (sotuvchi, 100k, inbaza, mgoods, …) → same adapter as `dynamic-template` rows
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

  if (tw.templateId) return "dynamic-template";
  if (tw.templateType === "telegram") return "telegram";
  if (tw.templateType === "google-sheets") return "google-sheets";
  if (tw.templateType) return "legacy-template";
  return "plain-url";
}
