/**
 * BuilderShellModal — Albato-style modal chrome for the V3 trigger/action
 * setup wizard.
 *
 * Layout (matches https://albato.com app builder modals):
 *
 *   ┌───────────────────────────────────────┐
 *   │ Title                  [Help]  [X]    │  ← header (sticky)
 *   ├───────────────────────────────────────┤
 *   │  ← Back  (only when canGoBack)        │
 *   │                                       │
 *   │              body / step              │  ← scrollable
 *   │                                       │
 *   ├───────────────────────────────────────┤
 *   │ (custom footer slot — Continue, Save) │  ← sticky
 *   └───────────────────────────────────────┘
 *
 * Why not just use DialogHeader/DialogFooter from components/ui/dialog?
 *   - Our shadcn DialogContent applies `p-6 gap-4 grid` which fights the
 *     Albato three-band layout (header / scroll body / footer). We pass
 *     `className="p-0 gap-0"` and lay the bands out ourselves.
 *   - The default X button is absolutely-positioned at `top-4 right-4`;
 *     we want it on the same row as the Help pill, so we render our own
 *     and pass `showCloseButton={false}`.
 *
 * Modal sizing follows AppCatalogPicker's proven `h-[560px] max-h-[80vh]`
 * so behaviour on short viewports matches what users already expect.
 */
import * as React from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ChevronLeft, BookOpen, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BuilderShellModalProps {
  open: boolean;
  onOpenChange: (next: boolean) => void;

  /** Modal title shown top-left. */
  title: string;

  /** When provided, renders a "Help" pill linking to docs (opens new tab). */
  helpUrl?: string;
  helpLabel?: string;

  /** When true, shows a "Back" link above the body. */
  canGoBack?: boolean;
  onBack?: () => void;
  backLabel?: string;

  /** Body content (the active step). */
  children: React.ReactNode;

  /**
   * Footer slot — typically `<BuilderStepFooter primary={...} />`. Rendered
   * verbatim inside a sticky bottom band with a top border.
   */
  footer?: React.ReactNode;
}

export function BuilderShellModal({
  open,
  onOpenChange,
  title,
  helpUrl,
  helpLabel,
  canGoBack,
  onBack,
  backLabel,
  children,
  footer,
}: BuilderShellModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Override DialogContent's default `gap-4 p-6 sm:max-w-lg` so the
        // header / body / footer rows touch each other and the modal can
        // grow up to ~640px wide.
        className={cn(
          "p-0 gap-0 sm:max-w-[640px] w-[calc(100%-2rem)]",
          "flex flex-col overflow-hidden",
          "h-[560px] max-h-[80vh]",
        )}
      >
        {/* Header — sticky, gradient-free, with optional Help pill + X */}
        <div className="flex items-center justify-between border-b px-6 py-4 shrink-0">
          <h2 className="text-lg font-semibold leading-none">{title}</h2>
          <div className="flex items-center gap-2">
            {helpUrl && (
              <a
                href={helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border bg-accent/40 px-2.5 py-1.5",
                  "text-xs font-medium text-foreground hover:bg-accent transition-colors",
                )}
              >
                <BookOpen className="h-3.5 w-3.5" />
                {helpLabel ?? "Help"}
              </a>
            )}
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-md",
                "text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
              )}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body — scrollable, with optional Back link pinned to the top */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {canGoBack && (
            <div className="px-6 pt-4">
              <button
                type="button"
                onClick={onBack}
                className={cn(
                  "inline-flex items-center gap-0.5 text-sm text-muted-foreground",
                  "hover:text-foreground transition-colors",
                )}
              >
                <ChevronLeft className="h-4 w-4" />
                {backLabel ?? "Back"}
              </button>
            </div>
          )}
          <div className="px-6 py-5">{children}</div>
        </div>

        {/* Footer — sticky bottom band, only if provided */}
        {footer && (
          <div className="border-t px-6 py-4 shrink-0 flex justify-end">
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
