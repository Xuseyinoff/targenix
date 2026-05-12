/**
 * FilterBuilder — Visual per-destination filter editor.
 *
 * Opened from the Integrations page. Loads existing filterJson for each
 * destination of an integration, lets the user build AND/OR condition groups,
 * and saves back via integrations.setDestinationFilter.
 */

import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, Trash2, Loader2, Filter, Info } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types (mirror server/services/filterEngine.ts) ──────────────────────────

type FilterOperator =
  | "eq" | "neq"
  | "contains" | "not_contains"
  | "starts_with" | "ends_with"
  | "gt" | "gte" | "lt" | "lte"
  | "exists" | "not_exists"
  | "in" | "not_in";

interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value: string;
}

interface FilterRule {
  enabled: boolean;
  logic: "AND" | "OR";
  conditions: FilterCondition[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STANDARD_FIELDS = [
  { value: "phone",    label: "Telefon" },
  { value: "email",    label: "Email" },
  { value: "fullName", label: "Ism" },
];

const OPERATORS: { value: FilterOperator; label: string; noValue?: boolean }[] = [
  { value: "eq",           label: "=" },
  { value: "neq",          label: "≠" },
  { value: "contains",     label: "o'z ichiga oladi" },
  { value: "not_contains", label: "o'z ichiga olmaydi" },
  { value: "starts_with",  label: "boshlanadi" },
  { value: "ends_with",    label: "tugaydi" },
  { value: "gt",           label: ">" },
  { value: "gte",          label: "≥" },
  { value: "lt",           label: "<" },
  { value: "lte",          label: "≤" },
  { value: "exists",       label: "mavjud", noValue: true },
  { value: "not_exists",   label: "mavjud emas", noValue: true },
  { value: "in",           label: "ro'yxatda (a,b,c)" },
  { value: "not_in",       label: "ro'yxatda emas" },
];

function makeEmpty(): FilterRule {
  return { enabled: true, logic: "AND", conditions: [] };
}

function makeCondition(): FilterCondition {
  return { field: "phone", operator: "eq", value: "" };
}

// ─── ConditionRow ─────────────────────────────────────────────────────────────

function ConditionRow({
  condition,
  index,
  extraFields,
  onChange,
  onRemove,
}: {
  condition: FilterCondition;
  index: number;
  extraFields: string[];
  onChange: (c: FilterCondition) => void;
  onRemove: () => void;
}) {
  const allFields = [
    ...STANDARD_FIELDS,
    ...extraFields
      .filter((f) => !STANDARD_FIELDS.some((s) => s.value === f))
      .map((f) => ({ value: f, label: f })),
  ];

  const opMeta = OPERATORS.find((o) => o.value === condition.operator);
  const noValue = opMeta?.noValue ?? false;

  return (
    <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
      <Select
        value={condition.field}
        onValueChange={(v) => onChange({ ...condition, field: v })}
      >
        <SelectTrigger className="h-8 text-xs w-[120px] shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allFields.map((f) => (
            <SelectItem key={f.value} value={f.value} className="text-xs">
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={condition.operator}
        onValueChange={(v) => onChange({ ...condition, operator: v as FilterOperator, value: "" })}
      >
        <SelectTrigger className="h-8 text-xs w-[160px] shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OPERATORS.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {noValue ? (
        <div className="flex-1 h-8 bg-muted/40 rounded-md border border-dashed flex items-center px-3">
          <span className="text-xs text-muted-foreground italic">qiymat shart emas</span>
        </div>
      ) : (
        <Input
          className="h-8 text-xs flex-1 min-w-[100px]"
          placeholder={condition.operator === "in" || condition.operator === "not_in" ? "+998,+7,+44" : "qiymat"}
          value={condition.value}
          onChange={(e) => onChange({ ...condition, value: e.target.value })}
        />
      )}

      <button
        type="button"
        onClick={onRemove}
        className="h-8 w-8 shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
        aria-label={`Remove condition ${index + 1}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ─── SingleDestinationEditor ──────────────────────────────────────────────────

function SingleDestinationEditor({
  integrationId,
  destinationId,
  destName,
  integrationConfig,
  initialFilter,
  onSaved,
}: {
  integrationId: number;
  destinationId: number;
  destName: string;
  integrationConfig: Record<string, unknown>;
  initialFilter: FilterRule | null;
  onSaved: () => void;
}) {
  const [rule, setRule] = useState<FilterRule>(() => initialFilter ?? makeEmpty());

  useEffect(() => {
    setRule(initialFilter ?? makeEmpty());
  }, [initialFilter]);

  const save = trpc.integrations.setDestinationFilter.useMutation({
    onSuccess: () => {
      toast.success("Filter saqlandi");
      onSaved();
    },
    onError: (e) => toast.error(e.message),
  });

  // Extract custom field names from fieldMappings
  const extraFields: string[] = (() => {
    const mappings = (integrationConfig.fieldMappings as Array<{ to?: string }> | undefined) ?? [];
    const custom = mappings
      .map((m) => m.to ?? "")
      .filter((t) => t && !["phone", "email", "fullName"].includes(t));
    return Array.from(new Set(custom));
  })();

  function addCondition() {
    setRule((r) => ({ ...r, conditions: [...r.conditions, makeCondition()] }));
  }

  function updateCondition(i: number, c: FilterCondition) {
    setRule((r) => ({
      ...r,
      conditions: r.conditions.map((old, idx) => (idx === i ? c : old)),
    }));
  }

  function removeCondition(i: number) {
    setRule((r) => ({ ...r, conditions: r.conditions.filter((_, idx) => idx !== i) }));
  }

  function handleSave() {
    save.mutate({ integrationId, destinationId, filter: rule.conditions.length === 0 ? null : rule });
  }

  function handleClear() {
    setRule(makeEmpty());
    save.mutate({ integrationId, destinationId, filter: null });
  }

  const activeCount = rule.enabled && rule.conditions.length > 0 ? rule.conditions.length : 0;

  return (
    <div className="space-y-4">
      {/* Destination label */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate max-w-[200px]">{destName}</span>
          {activeCount > 0 && (
            <Badge variant="outline" className="text-[10px] text-violet-600 border-violet-300 bg-violet-50 dark:bg-violet-950/30">
              {activeCount} shart
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`enabled-${destinationId}`} className="text-xs text-muted-foreground">
            Faol
          </Label>
          <Switch
            id={`enabled-${destinationId}`}
            checked={rule.enabled}
            onCheckedChange={(v) => setRule((r) => ({ ...r, enabled: v }))}
          />
        </div>
      </div>

      {/* AND / OR toggle */}
      {rule.conditions.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Mantiq:</span>
          <div className="flex rounded-lg border overflow-hidden">
            {(["AND", "OR"] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setRule((r) => ({ ...r, logic: l }))}
                className={cn(
                  "px-3 py-1 text-xs font-medium transition-colors",
                  rule.logic === l
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                )}
              >
                {l}
              </button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">
            {rule.logic === "AND" ? "— barchasi to'g'ri bo'lishi kerak" : "— kamida biri to'g'ri bo'lsa yetarli"}
          </span>
        </div>
      )}

      {/* Conditions */}
      {rule.conditions.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center space-y-2">
          <Filter className="h-8 w-8 text-muted-foreground/30 mx-auto" />
          <p className="text-sm text-muted-foreground">Hali shart yo'q</p>
          <p className="text-xs text-muted-foreground/70">
            Shart yo'q = barcha lidlar yuboriladi
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rule.conditions.map((cond, i) => (
            <div key={i} className="flex items-center gap-2">
              {rule.conditions.length > 1 && (
                <span className="text-[10px] font-mono text-muted-foreground w-6 text-center shrink-0">
                  {i === 0 ? "IF" : rule.logic}
                </span>
              )}
              {rule.conditions.length === 1 && (
                <span className="text-[10px] font-mono text-muted-foreground w-6 text-center shrink-0">IF</span>
              )}
              <div className="flex-1">
                <ConditionRow
                  condition={cond}
                  index={i}
                  extraFields={extraFields}
                  onChange={(c) => updateCondition(i, c)}
                  onRemove={() => removeCondition(i)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add condition */}
      {rule.conditions.length < 10 && (
        <button
          type="button"
          onClick={addCondition}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Shart qo'shish
        </button>
      )}

      {/* Info */}
      {rule.conditions.length > 0 && (
        <div className="flex items-start gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 px-3 py-2">
          <Info className="h-3.5 w-3.5 text-blue-500 mt-0.5 shrink-0" />
          <p className="text-[11px] text-blue-700 dark:text-blue-300">
            {rule.logic === "AND"
              ? "Lid faqat barcha shartlar bajarilganda ushbu yo'nalishga yuboriladi."
              : "Lid kamida bitta shart bajarilganda ushbu yo'nalishga yuboriladi."}
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-2 border-t">
        {rule.conditions.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground text-xs"
            onClick={handleClear}
            disabled={save.isPending}
          >
            Tozalash
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={handleSave}
          disabled={save.isPending}
        >
          {save.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          Saqlash
        </Button>
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function FilterBuilderSheet({
  open,
  onClose,
  integrationId,
  integrationName,
  integrationConfig,
  destinationNames,
}: {
  open: boolean;
  onClose: () => void;
  integrationId: number;
  integrationName: string;
  integrationConfig: Record<string, unknown>;
  /** Map of destinationId → display name */
  destinationNames: Record<number, string>;
}) {
  const utils = trpc.useUtils();
  const [activeDestIdx, setActiveDestIdx] = useState(0);

  const { data: destFilters, isLoading } = trpc.integrations.getDestinationFilters.useQuery(
    { integrationId },
    { enabled: open }
  );

  // Reset tab when destinations change
  useEffect(() => { setActiveDestIdx(0); }, [integrationId]);

  const dests = destFilters ?? [];
  const activeDest = dests[activeDestIdx];

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Filter className="h-4 w-4 text-violet-500" />
            Filtr — {integrationName}
          </SheetTitle>
          <SheetDescription className="text-xs">
            Qaysi lidlar ushbu integratsiya orqali yuborilishini boshqaring
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : dests.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              Yo'nalish topilmadi
            </div>
          ) : (
            <div className="space-y-5">
              {/* Destination tabs (if more than 1) */}
              {dests.length > 1 && (
                <div className="flex gap-1 bg-muted/40 p-1 rounded-lg">
                  {dests.map((d, i) => (
                    <button
                      key={d.destinationId}
                      type="button"
                      onClick={() => setActiveDestIdx(i)}
                      className={cn(
                        "flex-1 rounded-md px-2 py-1.5 text-xs font-medium truncate transition-colors",
                        activeDestIdx === i
                          ? "bg-background shadow-sm text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {destinationNames[d.destinationId] ?? `#${d.destinationId}`}
                    </button>
                  ))}
                </div>
              )}

              {activeDest && (
                <SingleDestinationEditor
                  key={`${activeDest.destinationId}-${activeDestIdx}`}
                  integrationId={integrationId}
                  destinationId={activeDest.destinationId}
                  destName={destinationNames[activeDest.destinationId] ?? `Yo'nalish #${activeDest.destinationId}`}
                  integrationConfig={integrationConfig}
                  initialFilter={(activeDest.filterJson as FilterRule | null) ?? null}
                  onSaved={() => void utils.integrations.getDestinationFilters.invalidate({ integrationId })}
                />
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
