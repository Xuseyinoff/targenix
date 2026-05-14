/**
 * AppManifestMapper — Make.com / Zapier-level per-destination field mapping
 * grid for Step 2 of IntegrationWizardV2.
 *
 * Driven entirely by the AppManifestService returned by resolveDestManifest
 * (a DB template or a server manifest). Three pieces live here:
 *
 *   • FieldMappingRow      — one unified row in the mapping grid. The row
 *                            shape is constant; the widget switches on
 *                            field.mode (auto / static / secret).
 *   • AppManifestMapper    — the grid itself + the read-only "Connection
 *                            config" box for the legacy path.
 *   • FieldMappingsEditor  — the dynamic row-per-field editor used for
 *                            bare "custom" webhook destinations.
 *
 * Extracted from IntegrationWizardV2.tsx.
 */

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CheckCircle2, ChevronRight, Lock, Plus, X } from "lucide-react";
import {
  GroupedFieldPicker,
  type GroupedFieldPickerGroup,
} from "@/components/common/GroupedFieldPicker";
import {
  FB_METADATA_FIELDS,
  FB_METADATA_LABELS,
  type AppManifestLeadField,
  type AppManifestService,
  type FieldMapping,
} from "@/pages/lead-routing/shared";
import type { DestinationEntry } from "@/pages/lead-routing/wizardTypes";
import { LoadingBar, EmptyHint } from "./wizardPrimitives";

// ─── FieldMappingRow — one unified row in the Make.com-style mapping grid ─────
//
// The row shape stays constant across all three modes so the grid reads as a
// vertical table: LABEL → WIDGET. The widget is what switches:
//   • auto   → <Select> of FB form fields + metadata (with an inline
//              "Empty — pick a form field" warning when no match is set yet)
//   • static → <Input> with the admin default as placeholder + a small muted
//              helper line that surfaces the default when the user clears it
//   • secret → a read-only chip with the masked credential + a Lock icon so
//              users instantly recognise it's coming from the connection
//              they configured at destination creation time.

interface FieldMappingRowProps {
  field: AppManifestLeadField;
  leadValue: string;
  staticValue: string;
  formFields: Array<{ key: string; label?: string | null }>;
  onUpdateLeadField: (formFieldKey: string) => void;
  onUpdateStaticValue: (value: string) => void;
}

function FieldMappingRow({
  field,
  leadValue,
  staticValue,
  formFields,
  onUpdateLeadField,
  onUpdateStaticValue,
}: FieldMappingRowProps) {
  const containerCls = cn(
    "grid grid-cols-[120px_12px_1fr] items-center gap-2 rounded-lg border px-3 py-2",
    field.required
      ? "border-primary/25 bg-primary/4"
      : "border-border bg-background",
  );

  const labelCell = (
    <div className="text-xs font-medium leading-tight">
      {field.label}
      {field.required && <span className="text-destructive ml-0.5">*</span>}
    </div>
  );

  const arrow = (
    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
  );

  if (field.mode === "secret") {
    return (
      <div
        className={cn(
          containerCls,
          "border-border bg-muted/20", // secrets never look "required empty"
        )}
      >
        {labelCell}
        {arrow}
        <div
          className="flex items-center gap-2 rounded-md border border-dashed bg-background px-2.5 py-1.5 text-xs"
          title="This value comes from the connection you configured on the destination."
        >
          <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="font-mono text-muted-foreground truncate">
            {field.secretLabel ?? "••••"}
          </span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
            From connection
          </span>
        </div>
      </div>
    );
  }

  if (field.mode === "static") {
    const showDefaultHint =
      !staticValue && !!field.staticDefault;
    return (
      <div className={containerCls}>
        {labelCell}
        {arrow}
        <div className="space-y-0.5">
          <Input
            className="h-8 text-xs"
            placeholder={field.staticDefault || `Enter ${field.label.toLowerCase()}…`}
            value={staticValue}
            onChange={(e) => onUpdateStaticValue(e.target.value)}
          />
          {showDefaultHint && (
            <div className="text-[10px] text-muted-foreground/80 pl-0.5">
              Default:{" "}
              <span className="font-mono text-muted-foreground">
                {field.staticDefault}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // mode === "auto" — Make.com-style grouped, searchable, collapsible picker.
  // Groups are built from the two FB sources (form questions + lead metadata)
  // and handed to the shared GroupedFieldPicker. Empty-state is handled by
  // the picker itself via the `emptyMessage` prop when no options exist.
  const sourceGroups: GroupedFieldPickerGroup[] =
    formFields.length === 0
      ? []
      : [
          {
            id: "form-fields",
            label: "Form fields",
            defaultExpanded: true,
            options: formFields.map((f) => ({
              key: f.key,
              label: f.label || f.key,
            })),
          },
          {
            id: "fb-metadata",
            label: "FB metadata",
            defaultExpanded: true,
            options: FB_METADATA_FIELDS.map((m) => ({
              key: m.key,
              label: FB_METADATA_LABELS[m.key] ?? m.key,
            })),
          },
        ];

  return (
    <div className={containerCls}>
      {labelCell}
      {arrow}
      <GroupedFieldPicker
        groups={sourceGroups}
        value={leadValue || null}
        onChange={onUpdateLeadField}
        placeholder="Pick FB form field…"
        emptyMessage="Pick a form in Step 1 to see fields."
      />
    </div>
  );
}

export interface AppManifestMapperProps {
  manifest: AppManifestService;
  destEntry: DestinationEntry;
  formFields: Array<{ key: string; label?: string | null }>;
  loadingFields: boolean;
  connectionConfig: Record<string, string>;
  onUpdateLeadField: (key: string, formField: string) => void;
  onUpdateStaticValue: (key: string, value: string) => void;
  onUpdateCustomMapping: (index: number, p: Partial<FieldMapping>) => void;
  onAddCustomFormRow: () => void;
  onAddCustomStaticRow: () => void;
  onRemoveCustomMapping: (index: number) => void;
}

/**
 * Make.com / Zapier-style field mapping grid.
 *
 * The heart of this component is the `manifest.leadFields.map(...)` loop: it
 * renders ONE row per destination key, picking the widget based on `lf.mode`:
 *   • mode="auto"   → Select of Facebook form fields + metadata (FROM_LEAD)
 *   • mode="static" → Text input with admin default placeholder (user-editable)
 *   • mode="secret" → Read-only chip sourced from the saved connection
 *
 * For legacy destinations whose manifest only carries auto fields the grid
 * looks identical to the pre-dynamic-mapping version, so this is a no-op for
 * Telegram / Sheets / UZ-CPA-fallback admin templates.
 */
export function AppManifestMapper({
  manifest,
  destEntry,
  formFields,
  loadingFields,
  connectionConfig,
  onUpdateLeadField,
  onUpdateStaticValue,
  onUpdateCustomMapping,
  onAddCustomFormRow,
  onAddCustomStaticRow,
  onRemoveCustomMapping,
}: AppManifestMapperProps) {
  // Admin-managed templates (sotuvchi, 100k, …) also have templateType="custom"
  // in the DB for legacy compat — but they carry leadFields from the template.
  // Use leadFields.length as the true signal, not manifest.id.
  const isCustom = manifest.leadFields.length === 0;
  const hasConnection = Object.keys(connectionConfig).length > 0;
  // Hide the legacy "Connection config" box whenever secret rows already
  // surface the same information inline — prevents duplicate UI for new
  // admin templates that expose userVisibleFields.
  const hasInlineSecretRow = manifest.leadFields.some((lf) => lf.mode === "secret");
  // Auto rows can't be filled until the trigger form fields arrive. We still
  // render them (with disabled Select) but flag the situation with a banner so
  // static / secret rows stay accessible without hiding the whole grid.
  const hasAutoRow = manifest.leadFields.some((lf) => lf.mode === "auto");
  const needsFormFields = hasAutoRow && formFields.length === 0 && !loadingFields;

  return (
    <div className="border-t mt-5 pt-5 space-y-5">
      {/* ── Unified per-destination field mapping grid ── */}
      {!isCustom && manifest.leadFields.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Field mapping
            <span className="ml-1.5 normal-case font-normal">
              ({manifest.label})
            </span>
          </div>

          {loadingFields ? (
            <LoadingBar />
          ) : (
            <>
              {needsFormFields && (
                <EmptyHint message="Pick a form in Step 1 to fill the highlighted fields." />
              )}
              <div className="space-y-2">
                {manifest.leadFields.map((lf) => (
                  <FieldMappingRow
                    key={lf.key}
                    field={lf}
                    leadValue={destEntry.leadFields[lf.key] ?? ""}
                    staticValue={destEntry.staticValues[lf.key] ?? ""}
                    formFields={formFields}
                    onUpdateLeadField={(v) => onUpdateLeadField(lf.key, v)}
                    onUpdateStaticValue={(v) => onUpdateStaticValue(lf.key, v)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Custom (dynamic) type uses full FieldMappingsEditor ── */}
      {isCustom && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Field mapping
            <span className="ml-1.5 normal-case font-normal">(Custom Webhook)</span>
          </div>
          {loadingFields ? (
            <LoadingBar />
          ) : (
            <FieldMappingsEditor
              formFields={formFields}
              mappings={destEntry.customMappings}
              onUpdate={onUpdateCustomMapping}
              onRemove={onRemoveCustomMapping}
              onAddFormRow={onAddCustomFormRow}
              onAddStaticRow={onAddCustomStaticRow}
            />
          )}
        </div>
      )}

      {/* ── Connection config (read-only, legacy path only) ──
           Hidden when secret rows are already inline in the mapping grid so
           there's only one place to look for the api_key / bot_token badge. */}
      {hasConnection && !hasInlineSecretRow && (
        <div className="space-y-2 rounded-xl border bg-muted/30 px-3 py-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
            <span className="text-xs font-semibold">
              Connection
              <span className="ml-1 font-normal text-muted-foreground">
                ({destEntry.name})
              </span>
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {Object.entries(connectionConfig).map(([k, v]) => (
              <div key={k} className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground font-mono">{k}:</span>
                <span
                  className={cn(
                    "font-mono",
                    v.startsWith("•") ? "text-muted-foreground" : "font-medium",
                  )}
                >
                  {v}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FieldMappingsEditor ───────────────────────────────────────────────────────
// Make.com-style row-per-field mapper.  Every row:
//   [FB form field ▼  OR  static value input]  →  [destination key]  [×]
// Rows whose `to` is "name" or "phone" are highlighted as required.

interface FieldMappingsEditorProps {
  formFields: Array<{ key: string; label?: string | null }>;
  mappings: FieldMapping[];
  onUpdate: (index: number, patch: Partial<FieldMapping>) => void;
  onRemove: (index: number) => void;
  onAddFormRow: () => void;
  onAddStaticRow: () => void;
}

function FieldMappingsEditor({
  formFields,
  mappings,
  onUpdate,
  onRemove,
  onAddFormRow,
  onAddStaticRow,
}: FieldMappingsEditorProps) {
  return (
    <div className="space-y-1.5">
      {/* Column headers */}
      <div className="grid grid-cols-[1fr_12px_120px_28px] items-center gap-2 px-1 pb-0.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Facebook form field / static value
        </div>
        <div />
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Destination key
        </div>
        <div />
      </div>

      {/* Rows */}
      {mappings.map((m, i) => {
        const isRequired = m.to === "name" || m.to === "phone";
        return (
          <div
            key={i}
            className={cn(
              "grid grid-cols-[1fr_12px_120px_28px] items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors",
              isRequired
                ? "border-primary/25 bg-primary/4"
                : "border-border bg-background hover:bg-muted/20",
            )}
          >
            {/* Source: form field dropdown OR static value input */}
            {m.from !== null ? (
              <GroupedFieldPicker
                groups={[
                  {
                    id: "form-fields",
                    label: "Form fields",
                    defaultExpanded: true,
                    options: formFields.map((f) => ({
                      key: f.key,
                      label: f.label || f.key,
                    })),
                  },
                  {
                    id: "fb-metadata",
                    label: "FB metadata",
                    defaultExpanded: true,
                    options: FB_METADATA_FIELDS.map((mf) => ({
                      key: mf.key,
                      label: FB_METADATA_LABELS[mf.key] ?? mf.key,
                    })),
                  },
                ]}
                value={m.from || null}
                onChange={(v) => onUpdate(i, { from: v })}
                placeholder="Pick form field…"
                className="border-0 shadow-none bg-transparent px-1"
              />
            ) : (
              <Input
                className="h-8 text-xs border-0 shadow-none bg-transparent px-1 focus-visible:ring-0"
                placeholder="Static value…"
                value={m.staticValue ?? ""}
                onChange={(e) => onUpdate(i, { staticValue: e.target.value })}
              />
            )}

            {/* Arrow */}
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />

            {/* Destination key */}
            <Input
              className={cn(
                "h-8 text-xs font-mono border-0 shadow-none bg-transparent px-1 focus-visible:ring-0",
                isRequired && "font-semibold text-primary",
              )}
              placeholder="dest_key"
              value={m.to}
              onChange={(e) => onUpdate(i, { to: e.target.value })}
            />

            {/* Remove */}
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-destructive transition-colors"
              aria-label="Remove row"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}

      {/* Add row actions */}
      <div className="flex items-center gap-1.5 pt-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
          onClick={onAddFormRow}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add form field
        </Button>
        <span className="text-muted-foreground/40 text-xs">·</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-muted-foreground hover:text-foreground"
          onClick={onAddStaticRow}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Static value
        </Button>
      </div>
    </div>
  );
}
