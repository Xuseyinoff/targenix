import type { Express, Request, Response } from "express";
import * as icons from "simple-icons";
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

async function proxyClearbit(domain: string, res: Response): Promise<void> {
  const url = `https://logo.clearbit.com/${domain}`;
  const r = await fetch(url, {
    // Clearbit may vary by UA; provide a common browser UA.
    headers: { "User-Agent": "Mozilla/5.0 targenix.uz server" },
  });
  if (!r.ok) {
    res.status(404).send("Not found");
    return;
  }
  const ct = r.headers.get("content-type") ?? "image/png";
  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader("Content-Type", ct);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.status(200).send(buf);
}

/**
 * GET /api/brand-icons/:slug.svg
 * Serves an SVG logo from the `simple-icons` npm package from our own domain
 * so clients don't depend on external CDNs (and avoid hotlink/CSP issues).
 *
 * Optional: ?color=fff (defaults to white)
 */
export function registerBrandIconRoutes(app: Express): void {
  app.get("/api/brand-icons/:slug.svg", async (req: Request, res: Response) => {
    const slug = String(req.params.slug ?? "").trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      res.status(400).send("Invalid slug");
      return;
    }

    const clearbit = CLEARBIT_BY_SLUG[slug];
    if (clearbit) {
      await proxyClearbit(clearbit, res);
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

