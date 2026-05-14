/**
 * NodeMenu — kebab (⋮) dropdown that appears on every canvas node.
 *
 * Mirrors the menu Albato shows when you click the three-dots icon on a
 * trigger or action card. Phase 1 wires Rename + Delete to real handlers;
 * Filter / Test / Error handler / Connection settings dispatch to optional
 * callbacks (parent can omit them and the row simply hides).
 *
 * Reused for both Trigger and Action nodes — keeps the menu styling /
 * shortcut order consistent across the canvas. Each row that's not wired
 * is omitted instead of being shown disabled, since "ghost rows" feel
 * broken.
 */
import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  MoreVertical,
  Filter,
  AlertTriangle,
  Pencil,
  PlayCircle,
  Settings2,
  Link2,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface NodeMenuProps {
  /** When provided, shows a "Rename" row that fires this on click. */
  onRename?: () => void;
  /** When provided, shows a "Filter" row that fires this on click. */
  onFilter?: () => void;
  /** When provided, shows an "Error handler" row that fires this on click. */
  onErrorHandler?: () => void;
  /** When provided, shows a "Test the step" row that fires this on click. */
  onTestStep?: () => void;
  /** When provided, shows "Additional connection settings" row. */
  onAdditionalConnectionSettings?: () => void;
  /** When provided, shows "Connection settings" row. */
  onConnectionSettings?: () => void;
  /** When provided, shows a Delete row with confirmation. */
  onDelete?: () => void;

  /** Aria label for the trigger button. */
  triggerLabel?: string;
}

export function NodeMenu({
  onRename,
  onFilter,
  onErrorHandler,
  onTestStep,
  onAdditionalConnectionSettings,
  onConnectionSettings,
  onDelete,
  triggerLabel = "More options",
}: NodeMenuProps) {
  // Each row's render is gated on its handler being provided. We collect
  // them as nodes so the separator logic stays declarative (separator
  // between "settings" rows and the destructive Delete row only).
  const settingsRows: React.ReactNode[] = [];
  if (onFilter) {
    settingsRows.push(
      <Row
        key="filter"
        icon={Filter}
        label="Filter"
        onSelect={onFilter}
      />,
    );
  }
  if (onErrorHandler) {
    settingsRows.push(
      <Row
        key="error"
        icon={AlertTriangle}
        label="Error handler"
        onSelect={onErrorHandler}
      />,
    );
  }
  if (onRename) {
    settingsRows.push(
      <Row
        key="rename"
        icon={Pencil}
        label="Rename"
        onSelect={onRename}
      />,
    );
  }
  if (onTestStep) {
    settingsRows.push(
      <Row
        key="test"
        icon={PlayCircle}
        label="Test the step"
        onSelect={onTestStep}
      />,
    );
  }
  if (onAdditionalConnectionSettings) {
    settingsRows.push(
      <Row
        key="addl-conn"
        icon={Settings2}
        label="Additional connection settings"
        onSelect={onAdditionalConnectionSettings}
      />,
    );
  }
  if (onConnectionSettings) {
    settingsRows.push(
      <Row
        key="conn"
        icon={Link2}
        label="Connection settings"
        onSelect={onConnectionSettings}
      />,
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          // Stop the click from bubbling up to the node's card-level click
          // handler (which opens the setup modal). The kebab should ONLY
          // open the menu — not re-open the trigger/action modal.
          onClick={(e) => e.stopPropagation()}
          aria-label={triggerLabel}
          className={cn(
            "shrink-0 rounded-md p-1 text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          )}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        // Stop selects from also triggering the card-level click.
        onClick={(e) => e.stopPropagation()}
      >
        {settingsRows}
        {onDelete && settingsRows.length > 0 && <DropdownMenuSeparator />}
        {onDelete && (
          <Row
            icon={Trash2}
            label="Delete"
            onSelect={onDelete}
            destructive
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Row helper ──────────────────────────────────────────────────────────────

interface RowProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

function Row({ icon: Icon, label, onSelect, destructive }: RowProps) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn(
        "gap-2 text-sm cursor-pointer",
        destructive && "text-destructive focus:text-destructive focus:bg-destructive/10",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </DropdownMenuItem>
  );
}
