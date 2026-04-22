/**
 * appIcons — small shim that turns manifest icon names / categories into
 * lucide-react components and Tailwind color classes.
 *
 * Manifests currently declare a free-form `icon` string (e.g. "Send",
 * "Table2"). We map the strings we recognise to lucide icons and fall back
 * to a generic Globe — this keeps the visual language consistent in the new
 * wizard without bloating the manifest contract.
 */

import {
  Archive,
  FileJson,
  Globe,
  Send,
  Table2,
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
};

export function resolveAppIcon(name: string | null | undefined): LucideIcon {
  if (!name) return Globe;
  return ICON_MAP[name] ?? Globe;
}

export function AppIcon({
  name,
  className,
}: {
  name: string | null | undefined;
  className?: string;
}) {
  const Component = resolveAppIcon(name);
  return <Component className={cn(className)} />;
}

/**
 * Soft coloured background for an app tile based on its manifest category.
 * Returns Tailwind classes compatible with both light and dark mode.
 */
export function appIconBgClass(category: string): string {
  switch (category) {
    case "messaging":
      return "bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400";
    case "spreadsheet":
      return "bg-green-50 text-green-600 dark:bg-green-950/40 dark:text-green-400";
    case "webhook":
      return "bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400";
    case "ecommerce":
      return "bg-orange-50 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400";
    case "affiliate":
      return "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400";
    default:
      return "bg-muted text-muted-foreground";
  }
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
