/**
 * SaaS-style pipeline badges: strong lead row (routing / data) + softer integration row.
 * Mobile-first, touch-friendly min heights.
 */
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getLeadPipelineBadgeConfig,
  getOrderBadgeConfig,
  type LeadPipelineFields,
  type LeadBadgeKey,
} from "@/lib/leadPipelineBadgeModel";

const LEAD_TONE: Record<
  "success" | "warning" | "danger" | "info" | "neutral",
  string
> = {
  success:
    "bg-emerald-500/15 text-emerald-900 border-emerald-500/40 shadow-sm shadow-emerald-500/10 dark:bg-emerald-950/60 dark:text-emerald-100 dark:border-emerald-600/50",
  warning:
    "bg-orange-500/12 text-orange-950 border-orange-500/35 shadow-sm shadow-orange-500/10 dark:bg-orange-950/45 dark:text-orange-100 dark:border-orange-600/45",
  danger:
    "bg-red-500/14 text-red-950 border-red-500/40 shadow-sm shadow-red-500/10 dark:bg-red-950/55 dark:text-red-50 dark:border-red-600/50",
  info: "bg-sky-500/12 text-sky-950 border-sky-500/35 dark:bg-sky-950/45 dark:text-sky-50 dark:border-sky-600/45",
  neutral:
    "bg-muted/80 text-foreground/90 border-border/80 dark:bg-muted/50 dark:text-foreground dark:border-border",
};

/** Order row: avoid emerald (same as lead “Delivered”) — sky = “dispatched to integration”. */
const ORDER_TONE: Record<"success" | "danger" | "warning" | "neutral", string> = {
  success:
    "bg-sky-500/[0.14] text-sky-950 border-sky-500/35 shadow-sm shadow-sky-500/5 dark:bg-sky-950/40 dark:text-sky-100 dark:border-sky-600/45",
  danger:
    "bg-red-500/[0.07] text-red-900/85 border-red-300/40 dark:bg-red-950/25 dark:text-red-300/90 dark:border-red-900/35",
  warning:
    "bg-amber-500/[0.08] text-amber-900/85 border-amber-300/40 dark:bg-amber-950/25 dark:text-amber-200/85 dark:border-amber-800/35",
  neutral: "bg-muted/50 text-muted-foreground border-border/60 dark:bg-muted/30",
};

function leadIcon(key: LeadBadgeKey) {
  switch (key) {
    case "DATA_ERROR":
      return Database;
    case "DELIVERED":
      return CheckCircle2;
    case "PARTIALLY_DELIVERED":
      return AlertTriangle;
    case "DELIVERY_FAILED":
      return AlertCircle;
    case "PROCESSING":
      return Loader2;
    case "FETCHING_DATA":
      return Clock;
    default:
      return Clock;
  }
}

type LeadPipelineBadgeProps = {
  lead: LeadPipelineFields;
  /** Slightly smaller on dense tables */
  size?: "default" | "compact";
  className?: string;
};

export function LeadPipelineBadge({ lead, size = "default", className }: LeadPipelineBadgeProps) {
  const cfg = getLeadPipelineBadgeConfig(lead);
  const Icon = leadIcon(cfg.key);
  const isSpin = cfg.key === "PROCESSING";

  return (
    <span
      title={cfg.description}
      className={cn(
        "inline-flex max-w-full items-center rounded-full border font-semibold tracking-tight",
        size === "compact"
          ? "min-h-5 gap-0.5 px-1.5 py-px text-[10px] sm:text-[11px] leading-none"
          : "min-h-7 gap-1.5 px-2.5 py-1 text-xs sm:text-sm",
        LEAD_TONE[cfg.tone],
        className
      )}
    >
      <Icon
        className={cn(
          "shrink-0 opacity-95",
          size === "compact" ? "h-2.5 w-2.5" : "h-3.5 w-3.5",
          isSpin && "animate-spin",
        )}
        aria-hidden
      />
      <span className="truncate">{cfg.label}</span>
    </span>
  );
}

type OrderIntegrationBadgeProps = {
  status: string;
  size?: "default" | "compact";
  className?: string;
};

/** Lighter visual weight than {@link LeadPipelineBadge} — per-integration outcome. */
export function OrderIntegrationBadge({ status, size = "default", className }: OrderIntegrationBadgeProps) {
  const cfg = getOrderBadgeConfig(status);
  const Icon = cfg.key === "sent" ? Send : cfg.key === "failed" ? AlertCircle : Clock;

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-md border font-medium tracking-tight opacity-95",
        size === "compact"
          ? "min-h-5 gap-0.5 px-1.5 py-px text-[10px] sm:text-[11px] leading-none"
          : "min-h-6 gap-1 px-2 py-0.5 text-[11px] sm:text-xs",
        ORDER_TONE[cfg.tone],
        className
      )}
    >
      <Icon className={cn("shrink-0 opacity-80", size === "compact" ? "h-2.5 w-2.5" : "h-3 w-3")} aria-hidden />
      <span className="truncate">{cfg.label}</span>
    </span>
  );
}
