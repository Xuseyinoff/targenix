/**
 * IntegrationWizardV2 — destination category metadata.
 *
 * Extracted from IntegrationWizardV2.tsx. Maps the five destination
 * categories to their display label, icon, and Tailwind colour classes.
 * Used by the wizard's step-2 circle icon and the DestinationEditor chips.
 */

import { FileText, Globe, MessageSquare, Webhook } from "lucide-react";

export type DestinationCategory = "messaging" | "data" | "webhooks" | "affiliate" | "crm";

export const CATEGORY_META: Record<
  DestinationCategory,
  { label: string; icon: typeof MessageSquare; colorClass: string }
> = {
  messaging: {
    label: "Messaging",
    icon: MessageSquare,
    colorClass: "text-sky-600 bg-sky-50 dark:bg-sky-950/40 dark:text-sky-400",
  },
  data: {
    label: "Spreadsheets & Data",
    icon: FileText,
    colorClass: "text-green-600 bg-green-50 dark:bg-green-950/40 dark:text-green-400",
  },
  webhooks: {
    label: "Custom Webhooks",
    icon: Webhook,
    colorClass: "text-violet-600 bg-violet-50 dark:bg-violet-950/40 dark:text-violet-400",
  },
  affiliate: {
    label: "Affiliate / CRM",
    icon: Globe,
    colorClass: "text-orange-600 bg-orange-50 dark:bg-orange-950/40 dark:text-orange-400",
  },
  crm: {
    label: "CRM",
    icon: Globe,
    colorClass: "text-indigo-600 bg-indigo-50 dark:bg-indigo-950/40 dark:text-indigo-400",
  },
};

export function iconForCategory(category: string) {
  const meta = CATEGORY_META[category as DestinationCategory];
  return meta?.icon ?? Globe;
}
