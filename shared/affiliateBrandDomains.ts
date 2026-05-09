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

/** Same-origin URL for `<img>`; returns null when the key is not whitelisted. */
export function iconUrlForTemplateAppKey(appKey: string | null | undefined): string | null {
  if (appKey == null || typeof appKey !== "string") return null;
  const k = appKey.trim().toLowerCase();
  if (!k || resolveAffiliateBrandDomain(k) == null) return null;
  const bundled = BUNDLED_AFFILIATE_ICON_PNG[k];
  if (bundled) return bundled;
  return `/api/brand-icons-by-key/${encodeURIComponent(k)}`;
}
