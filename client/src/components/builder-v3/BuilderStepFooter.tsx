/**
 * BuilderStepFooter — primary CTA row for each Builder V3 step.
 *
 * Currently a thin wrapper around <Button> with a fixed right-alignment.
 * The wrapper exists so that future steps can append secondary actions
 * (e.g. "Save & start", "Test event") without touching every step
 * component, and so the visual rhythm stays identical across steps.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export interface BuilderStepFooterProps {
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryType?: "button" | "submit";
}

export function BuilderStepFooter({
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryLoading,
  primaryType = "button",
}: BuilderStepFooterProps) {
  return (
    <Button
      type={primaryType}
      onClick={onPrimary}
      disabled={primaryDisabled || primaryLoading}
    >
      {primaryLoading && <Loader2 className="h-4 w-4 animate-spin" />}
      {primaryLabel}
    </Button>
  );
}
