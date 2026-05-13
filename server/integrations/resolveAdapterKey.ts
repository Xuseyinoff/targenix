/**
 * Picks a delivery `adapterKey` from integration type + `destinations` row.
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
/**
 * Phase 9 — app keys whose delivery is handled by the generic httpApiKeyAdapter.
 * Add a new entry here whenever a new http-api-key app manifest is registered.
 * Keys must match the `key` field in the app manifest exactly.
 */
const HTTP_API_KEY_APP_KEYS = new Set([
  "eskiz-sms",
  "playmobile-sms",
  "openai",
  "crm-generic",
  // Phase 11
  "webhook-json",
  "bitrix24",
  "amocrm",
]);

// Phase 12 — OAuth2 CRM apps (token from oauth_tokens via getValidAccessToken)
const HTTP_OAUTH2_APP_KEYS = new Set([
  "hubspot",
  "kommo",
  "pipedrive",
]);

export function resolveAdapterKey(
  integrationType: "LEAD_ROUTING",
  tw?: {
    templateId?: number | null;
    appKey?: string | null;
  } | null,
): string {
  // `integrationType` is kept in the signature for call-site parity; the
  // standalone AFFILIATE integration type was retired (see audit
  // 2026-05-12: 0 production rows). Only LEAD_ROUTING reaches this fn now.
  void integrationType;

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
        templateId: tw.templateId,
      });
    }
    if (effectiveKey === "telegram") return "telegram";
    if (effectiveKey === "google-sheets" || effectiveKey === "google_sheets") return "google-sheets";
    // Sentinel written by the NOT NULL backfill for destinations that had no templateType.
    if (effectiveKey === "plain-url") return "plain-url";
    // Universal HTTP — consolidates webhook-json / plain-url / crm-generic
    // behind one manifest + adapter (httpRequestAdapter). Phase 1 of the
    // http-refactor; see MIGRATION_PLAN_http_refactor.md.
    if (effectiveKey === "http-request") return "http-request";
    // Phase 9 — manifest-driven HTTP api_key apps (no destination_templates row needed).
    if (HTTP_API_KEY_APP_KEYS.has(effectiveKey)) return "http-api-key";
    // Phase 12 — OAuth2 CRM apps (token fetched via getValidAccessToken).
    if (HTTP_OAUTH2_APP_KEYS.has(effectiveKey)) return "http-oauth2";
    // Any other appKey → dynamic-template. The legacy-template fallback
    // (templateId IS NULL + non-first-party appKey) was removed after
    // confirming 0 production rows match (audit 2026-05-12); migrations
    // 0051/0052 + the destination_templates catalogue make every
    // affiliate destination a proper templateId-backed row.
    return "dynamic-template";
  }

  // Sprint 4 / Item 4.3 — templateType-first legacy fallback removed.
  //
  // Pre-condition verified before sunset: 0 destinations rows had
  // appKey IS NULL or 'unknown' on either local or Railway production
  // (audit-appkey-coverage.ts, 2026-05-11). The NOT NULL backfill in
  // migrations 0051/0052 already eliminated the case this block was
  // covering; keeping it perpetuated dual-mode routing complexity that
  // wasn't load-bearing.
  //
  // If a future code path inserts a row without an appKey (it
  // shouldn't — every destination creator path computes one), the
  // delivery falls into the safest default: plain-url with the
  // integration's config-supplied URL. No silent misroute, no
  // credential leak.
  if (process.env.STAGE2_ADAPTER_LOG === "1" || process.env.STAGE2_ADAPTER_LOG === "true") {
    console.log({
      stage: "adapter_resolution",
      path: "LEGACY_DEFAULT" as const,
      appKey: tw.appKey ?? null,
      templateId: tw.templateId,
      note: "appKey missing — falling through to plain-url default",
    });
  }
  return "plain-url";
}
