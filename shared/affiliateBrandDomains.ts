/**
 * Affiliate catalogue branding — maps secure DB `appKey` values to a **public**
 * website domain. The API (`/api/brand-icons-by-key`) proxies raster favicons
 * (Clearbit → Google s2 → DuckDuckGo) when no bundled asset exists.
 *
 * **Bundled icons:** `client/public/affiliates/{appKey}.png` — served as `/affiliates/…`.
 * These PNGs are pulled from each brand’s live favicon (Google `s2/favicons`, domain from
 * `AFFILIATE_BRAND_DOMAIN_BY_APP_KEY`) so picks stay crisp and work without extra latency.
 *
 * **Adding an affiliate**
 * 1. Add `{ appKey: "brand.tld" }` to `AFFILIATE_BRAND_DOMAIN_BY_APP_KEY`.
 * 2. Add `{ appKey: "/affiliates/appKey.png" }` to `BUNDLED_AFFILIATE_ICON_PNG` and place the file
 *    under `client/public/affiliates/` (download favicon or official logo you’re licensed to use).
 * 3. If no PNG yet, `iconUrlForTemplateAppKey` falls back to `/api/brand-icons-by-key/:appKey`.
 */

export const AFFILIATE_BRAND_DOMAIN_BY_APP_KEY: Readonly<Record<string, string>> = {
  alijahon: "alijahon.uz",
  "100k": "100k.uz",
  inbaza: "inbaza.uz",
  sotuvchi: "sotuvchi.com",
  /** Templates labelled “MyCPA” in admin often use appKey `mgoods`. */
  mgoods: "mgoods.uz",
  // ── CPA-style affiliates created via the admin one-shot path. The slug
  // matches the `.uz` brand domain — `xana-uz` → `xana.uz`, etc. Adding a
  // brand here lets `apps.iconUrl=/api/brand-icons-by-key/<appKey>` resolve
  // through the in-memory LRU + 7-day cache (Bosqich 4) without an admin
  // upload step.
  "alibabashop-uz": "alibabashop.uz",
  "alitrend-uz": "alitrend.uz",
  "arenashop-uz": "arenashop.uz",
  "dovcham-uz": "dovcham.uz",
  "fayzlibazar-uz": "fayzlibazar.uz",
  "ishonchli-uz": "ishonchli.uz",
  "jin-uz": "jin.uz",
  "karvo-uz": "karvo.uz",
  "lidershop-uz": "lidershop.uz",
  "mandarinshop-uz": "mandarinshop.uz",
  "olchamarket-uz": "olchamarket.uz",
  "shoxmarket-uz": "shoxmarket.uz",
  "tezbro-uz": "tezbro.uz",
  "troia-uz": "troia.uz",
  "uzmakon-uz": "uzmakon.uz",
  "uztez-uz": "uztez.uz",
  "xana-uz": "xana.uz",
};

/** Same keys as above — committed raster assets (see module doc). */
export const BUNDLED_AFFILIATE_ICON_PNG: Readonly<Record<string, string>> = {
  alijahon: "/affiliates/alijahon.png",
  "100k": "/affiliates/100k.png",
  inbaza: "/affiliates/inbaza.png",
  sotuvchi: "/affiliates/sotuvchi.png",
  mgoods: "/affiliates/mgoods.png",
};

export function resolveAffiliateBrandDomain(appKey: string | null | undefined): string | null {
  if (appKey == null || typeof appKey !== "string") return null;
  const k = appKey.trim().toLowerCase();
  if (!k) return null;
  return AFFILIATE_BRAND_DOMAIN_BY_APP_KEY[k] ?? null;
}

/**
 * Same-origin URL for `<img>`.
 *
 * Resolution order (modernized — Bosqich 1):
 *   1. `dbIconUrl` — the value joined from `apps.iconUrl` on the wire. Admin
 *      controls this without a client rebuild.
 *   2. Hardcoded `BUNDLED_AFFILIATE_ICON_PNG` map — legacy fallback for the
 *      five originally bundled affiliates. Will be removed once every row
 *      has its DB iconUrl populated.
 *   3. `/api/brand-icons-by-key/:appKey` — server-side favicon proxy
 *      (Clearbit → Google s2 → DuckDuckGo). Only used when the appKey is
 *      whitelisted in `AFFILIATE_BRAND_DOMAIN_BY_APP_KEY`.
 *   4. `null` — caller picks a fallback (lucide Globe by convention).
 */
export function iconUrlForTemplateAppKey(
  appKey: string | null | undefined,
  dbIconUrl?: string | null,
): string | null {
  if (dbIconUrl && dbIconUrl.trim() !== "") return dbIconUrl;
  if (appKey == null || typeof appKey !== "string") return null;
  const k = appKey.trim().toLowerCase();
  if (!k) return null;
  const bundled = BUNDLED_AFFILIATE_ICON_PNG[k];
  if (bundled) return bundled;
  if (resolveAffiliateBrandDomain(k) == null) return null;
  return `/api/brand-icons-by-key/${encodeURIComponent(k)}`;
}
