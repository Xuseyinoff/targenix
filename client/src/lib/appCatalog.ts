/**
 * appCatalog — single source of truth for the app/destination picker UX.
 *
 * Originally each picker (/connections, /integrations wizard) shipped its own
 * copy of the category sidebar, brand tints, descriptions, popular ribbon and
 * auth badge rules. That caused drift the moment we touched one — Zapier-style
 * SaaS solves this with one shared catalog module that every picker consumes.
 *
 * This module owns:
 *   • UiCategory taxonomy + category normalisers (manifest / template → UI)
 *   • Sidebar definition (label / icon / pastel tint / sort order)
 *   • Brand tints for manifest apps that don't carry their own colour
 *   • Per-app 1-line descriptions (Tier 1.A — under the app name)
 *   • Popular ribbon membership (Tier 1.C — handpicked top 5)
 *   • Auth badge rules (Tier 1.B — OAuth / API Key / Bot Token / Webhook)
 *   • Short text helpers (truncation etc.)
 *
 * It contains zero React state and zero data fetching — the picker components
 * stay in charge of trpc queries and click handlers.
 */

import type { ComponentType, SVGProps } from "react";
import {
  Database,
  Home as HomeIcon,
  LayoutGrid,
  MessageSquare,
  Plus,
  Target,
  Webhook,
} from "lucide-react";

// ─── Category taxonomy ───────────────────────────────────────────────────────

export type UiCategory = "affiliate" | "messaging" | "data" | "webhooks" | "crm";

/** Sidebar id space — adds "home"/"apps" aliases that mean "no filter" and
 *  "custom" for the template-only filter (admin-managed affiliates). */
export type SidebarId = "home" | "apps" | UiCategory | "custom";

export interface SidebarItem {
  id: SidebarId;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Pastel tint for the category's icon tile — gives each row its own vibe. */
  iconBg: string;
  iconColor: string;
}

export const SIDEBAR: readonly SidebarItem[] = [
  { id: "home",      label: "Home",      icon: HomeIcon,      iconBg: "bg-slate-100 dark:bg-slate-800/40",    iconColor: "text-slate-700 dark:text-slate-300" },
  { id: "apps",      label: "Apps",      icon: LayoutGrid,    iconBg: "bg-indigo-100 dark:bg-indigo-950/40",  iconColor: "text-indigo-600 dark:text-indigo-400" },
  { id: "messaging", label: "Messaging", icon: MessageSquare, iconBg: "bg-sky-100 dark:bg-sky-950/40",        iconColor: "text-sky-600 dark:text-sky-400" },
  { id: "data",      label: "Data",      icon: Database,      iconBg: "bg-orange-100 dark:bg-orange-950/40",  iconColor: "text-orange-600 dark:text-orange-400" },
  { id: "webhooks",  label: "Webhooks",  icon: Webhook,       iconBg: "bg-violet-100 dark:bg-violet-950/40",  iconColor: "text-violet-600 dark:text-violet-400" },
  { id: "affiliate", label: "Affiliate", icon: Target,        iconBg: "bg-emerald-100 dark:bg-emerald-950/40", iconColor: "text-emerald-600 dark:text-emerald-400" },
  { id: "custom",    label: "Custom",    icon: Plus,          iconBg: "bg-rose-100 dark:bg-rose-950/40",      iconColor: "text-rose-600 dark:text-rose-400" },
] as const;

// ─── Category normalisers ────────────────────────────────────────────────────
// Server-side categories don't always line up with the picker's UI buckets —
// these normalise them. Keep them in sync with the AppCategory union on the
// server / destination_templates enum.

export function normalizeManifestCategory(raw: string | null | undefined): UiCategory {
  switch (raw) {
    case "messaging":   return "messaging";
    case "spreadsheet": return "data";
    case "webhook":     return "webhooks";
    case "ecommerce":   return "affiliate";
    case "affiliate":   return "affiliate";
    case "crm":         return "crm";
    default:            return "webhooks";
  }
}

export function normalizeTemplateCategory(raw: string | null | undefined): UiCategory {
  switch (raw) {
    case "messaging": return "messaging";
    case "data":      return "data";
    case "webhooks":  return "webhooks";
    case "affiliate": return "affiliate";
    case "crm":       return "crm";
    default:          return "affiliate";
  }
}

// ─── Brand tints ─────────────────────────────────────────────────────────────
// Manifest apps don't carry a brand colour — admin templates already do. We
// blend the two so every row has a recognisable accent.

export const BRAND_COLOR: Record<string, string> = {
  "telegram":      "#229ED9",
  "google-sheets": "#0F9D58",
  "plain-url":     "#6B7280",
  "http-webhook":  "#6B7280",
};

// ─── 1-line descriptions (Tier 1.A) ──────────────────────────────────────────
// Hand-curated for accuracy. Lookup is case-insensitive (we lowercase before
// reading). Add new apps here when they land; the category fallback keeps the
// picker honest until then.

export const APP_DESCRIPTIONS: Record<string, string> = {
  // Manifest apps
  "telegram":          "Telegram bot lead delivery",
  "google-sheets":     "Append leads to a spreadsheet",
  "http-webhook":      "POST/GET any URL with variables",
  "plain-url":         "POST/GET any URL with variables",
  // CPA / affiliate networks (admin templates)
  "100k.uz":           "Push leads to 100k.uz CPA",
  "100k":              "Push leads to 100k.uz CPA",
  "alijahon.uz":       "Push leads to Alijahon.uz",
  "alijahon":          "Push leads to Alijahon.uz",
  "sotuvchi.com":      "Push leads to Sotuvchi.com",
  "sotuvchi":          "Push leads to Sotuvchi.com",
  "inbaza.uz":         "Push leads to Inbaza.uz",
  "inbaza":            "Push leads to Inbaza.uz",
  "mycpa":             "Push leads to MyCPA network",
  // CRMs (templates or future manifests)
  "amocrm":            "Push leads to AmoCRM / Kommo",
  "kommo":             "Push leads to Kommo (AmoCRM)",
  "kommo-oauth":       "Push leads to Kommo via OAuth",
  "bitrix24":          "Push leads to Bitrix24 CRM",
  "hubspot":           "Push leads to HubSpot CRM",
  "pipedrive":         "Push leads to Pipedrive CRM",
  "custom-crm":        "Custom CRM via HTTP",
  // Messaging / SMS / AI
  "eskiz":             "Send SMS via Eskiz",
  "eskiz-sms":         "Send SMS via Eskiz",
  "openai":            "AI lead enrichment",
};

export const CATEGORY_FALLBACK_DESC: Record<UiCategory, string> = {
  affiliate: "Affiliate CPA · API key",
  messaging: "Messaging delivery",
  data:      "Data export",
  webhooks:  "Custom HTTP webhook",
  crm:       "CRM integration",
};

/**
 * Resolve a description for a picker row. Tries the explicit per-key entry
 * first, then falls back to a category-shaped tagline so new templates the
 * admin adds tomorrow still get something readable.
 */
export function descriptionFor(
  key: string | null | undefined,
  category: UiCategory,
): string {
  const k = (key ?? "").toLowerCase().trim();
  return APP_DESCRIPTIONS[k] ?? CATEGORY_FALLBACK_DESC[category];
}

// ─── Popular ribbon (Tier 1.C) ───────────────────────────────────────────────
// Handpicked top 5. Resist the urge to grow this past 5 — the ribbon is meant
// to highlight, not to recommend everything.

export const POPULAR_KEYS: ReadonlySet<string> = new Set([
  "telegram",
  "google-sheets",
  "100k.uz",
  "alijahon.uz",
  "sotuvchi.com",
]);

export function isPopular(key: string | null | undefined): boolean {
  const k = (key ?? "").toLowerCase().trim();
  return POPULAR_KEYS.has(k);
}

// ─── Auth badge (Tier 1.B) ───────────────────────────────────────────────────

export interface AuthBadge {
  label: string;
  /** Tailwind utility classes — bg + text + border, light + dark variants. */
  className: string;
}

export type AuthBadgeInput = {
  /** Manifest connectionType (oauth2, oauth2_google, telegram_bot, ...). */
  connectionType?: string | null;
  /** DB auth type (oauth2 / api_key / bearer / none). */
  authType?: string | null;
  /** "manifest" rows might have neither; admin templates always need API key. */
  source: "manifest" | "template";
};

/**
 * Map an app's auth metadata to a colour-coded pill. The label matches Zapier
 * vocabulary so users instantly know how much setup is involved before they
 * click.
 */
export function authBadgeFor(input: AuthBadgeInput): AuthBadge {
  const ct = (input.connectionType ?? "").toLowerCase();
  const at = (input.authType ?? "").toLowerCase();
  if (ct === "telegram_bot") {
    return {
      label: "Bot Token",
      className:
        "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-400 dark:border-violet-900/40",
    };
  }
  if (ct.startsWith("oauth2") || at === "oauth2") {
    return {
      label: "OAuth",
      className:
        "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-400 dark:border-sky-900/40",
    };
  }
  if (at === "bearer") {
    return {
      label: "Bearer",
      className:
        "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900/40",
    };
  }
  if (input.source === "template" || at === "api_key") {
    return {
      label: "API Key",
      className:
        "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-900/40",
    };
  }
  // http-webhook & misc
  return {
    label: "Webhook",
    className:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-900/40",
  };
}

// ─── Misc helpers ────────────────────────────────────────────────────────────

/** Truncate a manifest's description so it doesn't blow out a 2-col card row. */
export function shortDescription(raw: string | null | undefined, max = 38): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
