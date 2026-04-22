/**
 * GroupField — visual container for a set of related sub-fields, optionally
 * collapsible behind a chevron toggle (Make.com / Zapier "Advanced settings"
 * pattern).
 *
 * A group does NOT own its own value. Its children live in the SAME top-level
 * `values` namespace of the surrounding form — the group is purely layout.
 * That means:
 *   • seedInitialValues / validateFields / collectDependentKeys flatten it
 *     away and work on the children as if they were siblings.
 *   • A child's `showWhen` can reference any sibling OR any field outside
 *     the group without special wiring.
 *
 * Limitations (enforced by convention, not the type system):
 *   • Groups may not nest inside groups or repeatables. The manifest
 *     validator in ../registry.ts warns + skips offending nodes at boot.
 *
 * Rendering delegates each child back to `renderChild` — a callback supplied
 * by the top-level DynamicForm. This keeps the group renderer agnostic to
 * which field types exist today; adding a new ConfigFieldType never requires
 * editing this file.
 */

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConfigField } from "../types";

export interface GroupFieldProps {
  field: ConfigField;
  renderChild: (child: ConfigField) => React.ReactNode;
  /**
   * Disable the whole group — forwarded to the shell; the caller is still
   * responsible for threading `disabled` down through `renderChild`.
   */
  disabled?: boolean;
  className?: string;
}

export function GroupField({
  field,
  renderChild,
  disabled,
  className,
}: GroupFieldProps) {
  const children = field.groupFields ?? [];
  const collapsible = field.collapsible === true;

  // When not collapsible, start always-open; when collapsible, honour
  // defaultCollapsed. Controlled locally because collapsed state is purely
  // presentational and should not be persisted in form values.
  const [open, setOpen] = React.useState<boolean>(() =>
    collapsible ? !(field.defaultCollapsed === true) : true,
  );

  if (children.length === 0) return null;

  return (
    <section
      className={cn(
        "rounded-xl border border-border/70 bg-muted/20 px-4 py-3",
        disabled && "opacity-70",
        className,
      )}
      data-field-key={field.key}
      data-group-open={open}
    >
      {/* Header row — label + optional chevron */}
      <header
        className={cn(
          "flex items-center justify-between",
          collapsible && "cursor-pointer select-none",
          open && "mb-3",
        )}
        onClick={collapsible ? () => setOpen((v) => !v) : undefined}
        role={collapsible ? "button" : undefined}
        aria-expanded={collapsible ? open : undefined}
        tabIndex={collapsible ? 0 : undefined}
        onKeyDown={
          collapsible
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((v) => !v);
                }
              }
            : undefined
        }
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">
            {field.label}
          </div>
          {field.description && (
            <p className="text-xs text-muted-foreground leading-snug">
              {field.description}
            </p>
          )}
        </div>
        {collapsible && (
          <span className="ml-3 shrink-0 text-muted-foreground">
            {open ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </span>
        )}
      </header>

      {open && (
        <div className="flex flex-col gap-4">
          {children.map((child) => (
            <React.Fragment key={child.key}>{renderChild(child)}</React.Fragment>
          ))}
        </div>
      )}
    </section>
  );
}
