import type { Express, Request, Response } from "express";
import * as icons from "simple-icons";
import { resolveAffiliateBrandDomain } from "@shared/affiliateBrandDomains";
import { log } from "../services/appLogger";

const CLEARBIT_BY_SLUG: Record<string, string> = {
  pipedrive: "pipedrive.com",
  kommo: "kommo.com",
  amocrm: "amocrm.com",
  bitrix24: "bitrix24.com",
  openai: "openai.com",
};

function exportNameForSlug(slug: string): string {
  // "google-sheets" -> "siGooglesheets"
  const base = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .split("-")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return `si${base}`;
}

const FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * In-memory cache for proxied brand logos (Bosqich 4 of the icon system
 * modernization). Without this, every page load that resolves an affiliate
 * without `apps.iconUrl` fires three external requests (Clearbit → Google
 * favicons → DuckDuckGo). The cache key is the resolved brand domain so
 * the same logo is reused across different appKeys that map to the same
 * domain. TTL is short enough that a brand redesign propagates within a
 * day, long enough to absorb the rendering bursts during admin sessions.
 *
 * Cap kept small — these are admin-facing dashboards, not a CDN; we'd
 * rather evict and re-fetch than balloon the process heap.
 */
type CachedLogo = { buf: Buffer; contentType: string; expiresAt: number };
const LOGO_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const LOGO_CACHE_MAX_ENTRIES = 128;
const logoCache = new Map<string, CachedLogo>();

function readCachedLogo(domain: string): CachedLogo | null {
  const hit = logoCache.get(domain);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    logoCache.delete(domain);
    return null;
  }
  // Refresh insertion order (LRU touch).
  logoCache.delete(domain);
  logoCache.set(domain, hit);
  return hit;
}

function writeCachedLogo(domain: string, buf: Buffer, contentType: string): void {
  if (logoCache.size >= LOGO_CACHE_MAX_ENTRIES) {
    const oldest = logoCache.keys().next().value;
    if (oldest) logoCache.delete(oldest);
  }
  logoCache.set(domain, { buf, contentType, expiresAt: Date.now() + LOGO_CACHE_TTL_MS });
}

async function fetchLogoBytes(
  domain: string,
): Promise<{ buf: Buffer; contentType: string } | null> {
  const cached = readCachedLogo(domain);
  if (cached) return { buf: cached.buf, contentType: cached.contentType };
  const tryFetch = async (url: string): Promise<{ buf: Buffer; contentType: string } | null> => {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": FETCH_UA },
        redirect: "follow",
      });
      if (!r.ok) return null;
      const rawCt = r.headers.get("content-type") ?? "";
      const ct = rawCt.split(";")[0].trim().toLowerCase();
      if (!ct.startsWith("image/")) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 32) return null;
      return { buf, contentType: ct };
    } catch {
      return null;
    }
  };

  // Clearbit often 404s / is deprecated for public use — don't stop there.
  let got = await tryFetch(`https://logo.clearbit.com/${domain}`);
  if (got) {
    writeCachedLogo(domain, got.buf, got.contentType);
    return got;
  }

  got = await tryFetch(
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`,
  );
  if (got) {
    writeCachedLogo(domain, got.buf, got.contentType);
    return got;
  }

  got = await tryFetch(`https://icons.duckduckgo.com/ip3/${domain}.ico`);
  if (got) writeCachedLogo(domain, got.buf, got.contentType);
  return got;
}

async function proxyRasterBrand(domain: string, res: Response): Promise<void> {
  const got = await fetchLogoBytes(domain);
  if (!got) {
    res.status(404).send("Not found");
    return;
  }
  res.setHeader("Content-Type", got.contentType);
  // 7 days browser/CDN cache. Brand redesigns are rare; admins can always
  // override with `apps.iconUrl` (Bosqich 2) when they need an immediate flip.
  res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
  res.status(200).send(got.buf);
}

/**
 * GET /api/brand-icons/:slug.svg
 * Serves an SVG logo from the `simple-icons` npm package from our own domain
 * so clients don't depend on external CDNs (and avoid hotlink/CSP issues).
 *
 * Optional: ?color=fff (defaults to white)
 */
export function registerBrandIconRoutes(app: Express): void {
  /**
   * Raster logo for DB `apps.appKey` / `destination_templates.appKey` affiliates
   * (Clearbit → Google favicon → DuckDuckGo). Extensionless URL avoids clashing
   * with `/api/brand-icons/:slug.svg` reserved slugs like `app`.
   */
  app.get("/api/brand-icons-by-key/:appKey", async (req: Request, res: Response) => {
    const raw = String(req.params.appKey ?? "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,64}$/.test(raw)) {
      res.status(400).send("Invalid app key");
      return;
    }
    const domain = resolveAffiliateBrandDomain(raw);
    if (!domain) {
      res.status(404).send("Not found");
      return;
    }
    await proxyRasterBrand(domain, res);
  });

  app.get("/api/brand-icons/:slug.svg", async (req: Request, res: Response) => {
    const slug = String(req.params.slug ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      res.status(400).send("Invalid slug");
      return;
    }

    const rasterDomain = CLEARBIT_BY_SLUG[slug];
    if (rasterDomain) {
      await proxyRasterBrand(rasterDomain, res);
      return;
    }

    const exp = exportNameForSlug(slug);
    const icon = (icons as Record<string, any>)[exp] as
      | { title: string; svg: string; hex?: string }
      | undefined;

    if (!icon?.svg) {
      res.status(404).send("Not found");
      return;
    }

    const svg = icon.svg;

    // cache hard: content addressed by versioned server deploy; safe to cache
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.status(200).send(svg);

    // best-effort debug trace
    if (process.env.BRAND_ICON_LOG === "1") {
      await log.info("SYSTEM", "brand_icon_served", { slug, exp });
    }
  });
}

