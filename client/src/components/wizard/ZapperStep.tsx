/**
 * ZapperStep — the Zapier/Make-style stacked-card step chrome used by
 * IntegrationWizardV2.
 *
 * Renders the left-rail circle + vertical connector, the clickable step
 * header (collapses to a summary pill when done), and the content card.
 * Purely presentational — all state (isActive / isOpen / isDone / isLocked)
 * is controlled by the parent wizard.
 *
 * Extracted from IntegrationWizardV2.tsx.
 */

import { cn } from "@/lib/utils";
import { CheckCircle2 } from "lucide-react";

export interface ZapperStepProps {
  /** Icon shown in the circle (step 1 = Facebook, step 2 = app icon or Zap). */
  icon: React.ComponentType<{ className?: string }>;
  /** Tailwind bg+text classes for the icon badge when not done. */
  iconColor: string;
  /** Small ALL-CAPS label above the app name: "TRIGGER" or "ACTION". */
  label: string;
  /** Prominent app name: "Facebook Lead Ads", "Telegram", etc. */
  appName: string;
  /** Step is visually highlighted (primary border on circle). */
  isActive: boolean;
  /** Step is fully filled — circle becomes solid primary, shows checkmark. */
  isDone: boolean;
  /** Step is not yet reachable — content is hidden and circle is dimmed. */
  isLocked?: boolean;
  /** Whether to render the content card (controlled by parent). */
  isOpen: boolean;
  /** Whether to draw the vertical connector below this step. */
  isLast?: boolean;
  /** One-line summary shown when isDone && !isOpen. */
  summary?: string;
  /** Clicking the header when isDone triggers this to re-open the step. */
  onHeaderClick?: () => void;
  children?: React.ReactNode;
}

export function ZapperStep({
  icon: Icon,
  iconColor,
  label,
  appName,
  isActive,
  isDone,
  isLocked,
  isOpen,
  isLast,
  summary,
  onHeaderClick,
  children,
}: ZapperStepProps) {
  return (
    <div className="flex gap-4">
      {/* ── Left rail: circle + connector line ── */}
      <div className="flex flex-col items-center shrink-0 w-11">
        <button
          type="button"
          disabled={isLocked}
          onClick={onHeaderClick}
          className={cn(
            "relative z-10 flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-all duration-200",
            isDone
              ? "bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-sm ring-4 ring-background"
              : isActive
                ? "bg-emerald-100 ring-4 ring-emerald-50 dark:bg-emerald-950/40 dark:ring-emerald-950/20"
                : isLocked
                  ? "bg-slate-100 dark:bg-muted ring-2 ring-background"
                  : "bg-white border-2 border-slate-200 dark:bg-card dark:border-border hover:border-emerald-300 ring-2 ring-background",
          )}
          aria-label={`Go to ${label}`}
        >
          {isDone && !isOpen ? (
            <CheckCircle2 className="h-5 w-5 text-white" strokeWidth={2.5} />
          ) : (
            <Icon
              className={cn(
                "h-4 w-4 transition-colors",
                isDone
                  ? "text-white"
                  : isLocked
                    ? "text-muted-foreground/30"
                    : isActive
                      ? "text-emerald-600 dark:text-emerald-400"
                      : iconColor,
              )}
            />
          )}
        </button>
        {/* Vertical connector — emerald gradient when above is done */}
        {!isLast && (
          <div
            className={cn(
              "w-0.5 flex-1 mt-1.5 rounded-full",
              isDone
                ? "bg-gradient-to-b from-emerald-300 via-emerald-200 to-emerald-100 dark:from-emerald-700 dark:via-emerald-800 dark:to-emerald-900/40"
                : "bg-slate-200 dark:bg-border",
            )}
            style={{ minHeight: "40px" }}
          />
        )}
      </div>

      {/* ── Right content ── */}
      <div className={cn("flex-1 pb-6", isLast && "pb-2")}>
        {/* Step header (clickable when done) */}
        <div className="flex items-start justify-between min-h-[44px] mb-3">
          <button
            type="button"
            disabled={isLocked || isOpen}
            onClick={onHeaderClick}
            className={cn(
              "text-left flex-1 min-w-0",
              !isLocked && !isOpen && "hover:opacity-80 transition-opacity",
            )}
          >
            <div
              className={cn(
                "text-[10px] uppercase tracking-widest font-bold leading-none mb-1.5",
                isLocked
                  ? "text-muted-foreground/40"
                  : isActive || isDone
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-muted-foreground",
              )}
            >
              {label}
            </div>
            <div
              className={cn(
                "text-base font-bold tracking-tight leading-tight truncate",
                isLocked && "text-muted-foreground/40",
              )}
            >
              {appName}
            </div>
          </button>
          {isDone && !isOpen && (
            <button
              type="button"
              onClick={onHeaderClick}
              className="ml-3 text-xs font-semibold text-primary hover:underline shrink-0 mt-1"
            >
              Edit
            </button>
          )}
        </div>

        {/* Done summary pill (when collapsed) */}
        {isDone && !isOpen && summary && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/40 px-3 py-1 text-xs text-emerald-700 dark:text-emerald-400 font-semibold mb-2">
            <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
            {summary}
          </div>
        )}

        {/* Content card (when open) — Wapi rounded-2xl + slate border */}
        {isOpen && !isLocked && (
          <div className="rounded-2xl border border-slate-200/70 dark:border-border bg-white dark:bg-card p-5">
            {children}
          </div>
        )}

        {/* Locked placeholder */}
        {isLocked && (
          <div className="rounded-2xl border border-dashed border-slate-200 dark:border-border bg-slate-50/40 dark:bg-muted/10 px-4 py-3 text-xs text-muted-foreground/60">
            Complete the trigger step first.
          </div>
        )}
      </div>
    </div>
  );
}
