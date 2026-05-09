/**
 * appIcons — small shim that turns manifest icon names / categories into
 * lucide-react components and Tailwind color classes.
 *
 * Manifests currently declare a free-form `icon` string (e.g. "Send",
 * "Table2"). We map the strings we recognise to lucide icons and fall back
 * to a generic Globe — this keeps the visual language consistent in the new
 * wizard without bloating the manifest contract.
 */

import * as React from "react";
import {
  Archive,
  Briefcase,
  Database,
  FileJson,
  Globe,
  MessageSquare,
  Send,
  Smartphone,
  Sparkles,
  Table2,
  Users,
  Webhook,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const ICON_MAP: Record<string, LucideIcon> = {
  Send,
  Table2,
  Globe,
  Webhook,
  FileJson,
  Archive,
  Zap,
  Users,
  Briefcase,
  Database,
  Sparkles,
  Smartphone,
  MessageSquare,
};

/** True when `name` should be rendered as an `<img>` (URL path or absolute URL). */
export function isIconUrl(name: string | null | undefined): name is string {
  if (!name) return false;
  return /^https?:\/\//i.test(name) || name.startsWith("/");
}

/**
 * Neutral “app store” tile behind logos — white-ish on light UI, deep surface on dark,
 * so full-colour PNG/SVG and monochrome favicons stay legible in both themes.
 */
export function appBrandIconTileClass(className?: string): string {
  return cn(
    "flex shrink-0 items-center justify-center overflow-hidden rounded-md p-0.5",
    "bg-white shadow-sm ring-1 ring-zinc-200/90",
    "dark:bg-zinc-800 dark:ring-zinc-600/90 dark:shadow-black/30",
    className,
  );
}

export function resolveAppIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Globe;
  // If an app uses a brand logo URL, UI should render <img>.
  // Keep resolveAppIcon returning a component for legacy call sites.
  if (isIconUrl(name)) return Globe;
  return ICON_MAP[name] ?? Globe;
}

export function AppIcon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);

  if (isIconUrl(name)) {
    // Raster (Clearbit PNG) and SVG both need real pixels — CSS masks break PNGs
    // and force single-color silhouettes, which hides full-color logos on light UI.
    if (failed) {
      const Fallback = Globe;
      return <Fallback className={cn(className)} />;
    }
    return (
      <img
        src={name}
        alt=""
        className={cn("block max-h-full max-w-full object-contain", className)}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  const Component = resolveAppIcon(name);
  return <Component className={cn(className)} />;
}

/** Hover border colour for an app shortcut card, matched to its category. */
export function appIconRingClass(category: string): string {
  switch (category) {
    case "messaging":
      return "hover:border-sky-300 dark:hover:border-sky-600";
    case "spreadsheet":
      return "hover:border-emerald-300 dark:hover:border-emerald-600";
    case "webhook":
      return "hover:border-violet-300 dark:hover:border-violet-600";
    case "ecommerce":
    case "affiliate":
      return "hover:border-amber-300 dark:hover:border-amber-600";
    default:
      return "hover:border-primary/30";
  }
}
