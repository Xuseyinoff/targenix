/**
 * IntegrationWizardV2 — small shared UI primitives.
 *
 * Extracted from IntegrationWizardV2.tsx. These two helpers are used by
 * several wizard sub-components (TriggerEditor, DestinationEditor,
 * AppManifestMapper) so they live in their own module.
 */

import { Button } from "@/components/ui/button";
import { Loader2, Pencil } from "lucide-react";

/** Inline "Loading…" bar shown while a wizard query is in flight. */
export function LoadingBar() {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Loading…
    </div>
  );
}

/**
 * Dashed-border hint shown when a wizard step has nothing to pick yet.
 * Optionally renders a CTA button that opens `href` in a new tab.
 */
export function EmptyHint({
  message,
  ctaLabel,
  href,
}: {
  message: string;
  ctaLabel?: string;
  href?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed bg-muted/10 p-3 text-xs">
      <div className="flex-1 text-muted-foreground">{message}</div>
      {ctaLabel && href && (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs shrink-0"
          onClick={() => window.open(href, "_blank")}
        >
          <Pencil className="h-3 w-3 mr-1" /> {ctaLabel}
        </Button>
      )}
    </div>
  );
}
