/**
 * AdminTemplates — Admin page for managing destination templates.
 *
 * Admins define affiliate endpoint templates here.
 * Users pick these templates when creating destinations — no code change needed for new affiliates.
 *
 * Route: /admin/destination-templates
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Pencil,
  Globe,
  Loader2,
  Lock,
  X,
  Info,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface BodyField {
  key: string;
  value: string;
  isSecret: boolean;
}

interface AutoMappedField {
  key: string;
  label: string;
}

type TemplateCategory = "messaging" | "data" | "webhooks" | "affiliate" | "crm";

interface TemplateForm {
  name: string;
  description: string;
  color: string;
  category: TemplateCategory;
  /**
   * Connection app key. Links the template to an entry in
   * `connection_app_specs` so every {{SECRET:key}} token can be
   * validated against that spec's declared sensitive fields. Required
   * on the server — the form enforces selection before save.
   */
  appKey: string;
  endpointUrl: string;
  method: "POST" | "GET";
  contentType: string;
  bodyFields: BodyField[];
  /** Used only when contentType is application/json — raw JSON template with {{variables}} */
  jsonBodyTemplate: string;
  userVisibleFields: string[];
  variableFields: string[];
  autoMappedFields: AutoMappedField[];
  isActive: boolean;
}

/**
 * Category catalog shown in the admin form + list badges. The labels are
 * short and user-facing; `hint` is rendered under the <select> to help admins
 * pick the right bucket. Keep in sync with TEMPLATE_CATEGORIES on the server
 * and the `category` mysqlEnum in drizzle/schema.ts.
 */
const CATEGORIES: Array<{ value: TemplateCategory; label: string; hint: string }> = [
  { value: "affiliate", label: "Affiliate",  hint: "Uzbekistan CPA / offer networks (Sotuvchi, 100k, Inbaza…)" },
  { value: "messaging", label: "Messaging",  hint: "Chat / notification endpoints (custom Telegram bots, Discord…)" },
  { value: "data",      label: "Data",       hint: "Spreadsheets, data warehouses, analytics sinks" },
  { value: "webhooks",  label: "Webhooks",   hint: "Generic HTTP endpoints that do not fit any other bucket" },
  { value: "crm",       label: "CRM",        hint: "CRM / sales pipelines (amoCRM, Bitrix24, Pipedrive…)" },
];

/** Pick badge styling by category so the list reads at a glance. */
function categoryBadgeClass(c: TemplateCategory): string {
  switch (c) {
    case "affiliate": return "bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20";
    case "messaging": return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20";
    case "data":      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
    case "webhooks":  return "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20";
    case "crm":       return "bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20";
  }
}

function categoryLabel(c: TemplateCategory): string {
  return CATEGORIES.find((x) => x.value === c)?.label ?? c;
}

const JSON_TEMPLATE_KEY = "__json_template__";

const PRESET_COLORS = [
  "#3B82F6", "#10B981", "#8B5CF6", "#F59E0B",
  "#EF4444", "#06B6D4", "#84CC16", "#EC4899",
];

const CONTENT_TYPES = [
  "application/x-www-form-urlencoded",
  "application/json",
  "multipart/form-data",
];

const BUILTIN_VAR_HINTS = [
  "{{name}}", "{{phone}}", "{{email}}", "{{lead_id}}", "{{page_id}}", "{{form_id}}",
];

const DEFAULT_JSON_TEMPLATE = `{
  "name": "{{name}}",
  "phone": "{{phone}}",
  "api_key": "{{SECRET:api_key}}"
}`;

function defaultForm(): TemplateForm {
  return {
    name: "",
    description: "",
    color: "#3B82F6",
    category: "affiliate",
    appKey: "",
    endpointUrl: "",
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    bodyFields: [
      { key: "api_key", value: "{{SECRET:api_key}}", isSecret: true },
      { key: "phone", value: "{{phone}}", isSecret: false },
      { key: "name", value: "{{name}}", isSecret: false },
    ],
    jsonBodyTemplate: DEFAULT_JSON_TEMPLATE,
    userVisibleFields: ["api_key"],
    variableFields: [],
    autoMappedFields: [
      { key: "name", label: "Full Name" },
      { key: "phone", label: "Phone" },
    ],
    isActive: true,
  };
}

/** True when contentType is JSON mode */
function isJsonMode(ct: string) {
  return ct.toLowerCase().includes("json");
}

/** Convert bodyFields ↔ jsonBodyTemplate when switching modes */
function getEffectiveBodyFields(form: TemplateForm): BodyField[] {
  if (isJsonMode(form.contentType)) {
    return [{ key: JSON_TEMPLATE_KEY, value: form.jsonBodyTemplate, isSecret: false }];
  }
  return form.bodyFields;
}

// ─── Tag input component ───────────────────────────────────────────────────────

function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");

  function addTag() {
    const v = draft.trim();
    if (!v || values.includes(v)) { setDraft(""); return; }
    onChange([...values, v]);
    setDraft("");
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1.5 min-h-[36px] rounded-md border bg-background px-2 py-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-xs font-mono">
            {v}
            <button onClick={() => onChange(values.filter(x => x !== v))} className="text-muted-foreground hover:text-foreground">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[80px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder={values.length === 0 ? placeholder : "+ add"}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); } }}
          onBlur={addTag}
        />
      </div>
    </div>
  );
}

// ─── Auto-mapped field row ─────────────────────────────────────────────────────

function AutoMappedRow({
  field,
  onChange,
  onRemove,
}: {
  field: AutoMappedField;
  onChange: (f: AutoMappedField) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        className="w-32 font-mono text-xs h-8"
        placeholder="key"
        value={field.key}
        onChange={e => onChange({ ...field, key: e.target.value })}
      />
      <span className="text-muted-foreground text-xs">←</span>
      <Input
        className="flex-1 text-xs h-8"
        placeholder="label (e.g. Full Name)"
        value={field.label}
        onChange={e => onChange({ ...field, label: e.target.value })}
      />
      <button onClick={onRemove} className="text-muted-foreground hover:text-destructive">
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── Body field row ────────────────────────────────────────────────────────────

function BodyFieldRow({
  field,
  onChange,
  onRemove,
}: {
  field: BodyField;
  onChange: (f: BodyField) => void;
  onRemove: () => void;
}) {
  function toggleSecret() {
    const isSecret = !field.isSecret;
    const value = isSecret
      ? `{{SECRET:${field.key || "key"}}}`
      : field.value.startsWith("{{SECRET:") ? "" : field.value;
    onChange({ ...field, isSecret, value });
  }

  function handleKeyChange(newKey: string) {
    const value = field.isSecret ? `{{SECRET:${newKey}}}` : field.value;
    onChange({ ...field, key: newKey, value });
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        className="w-32 font-mono text-xs h-8"
        placeholder="field_key"
        value={field.key}
        onChange={e => handleKeyChange(e.target.value)}
      />
      <span className="text-muted-foreground text-xs shrink-0">→</span>
      <Input
        className="flex-1 font-mono text-xs h-8"
        placeholder="{{variable}} or static value"
        value={field.value}
        disabled={field.isSecret}
        onChange={e => onChange({ ...field, value: e.target.value })}
      />
      <button
        onClick={toggleSecret}
        title={field.isSecret ? "Secret (click to unset)" : "Mark as secret"}
        className={`shrink-0 rounded p-1 transition-colors ${field.isSecret ? "text-amber-500 bg-amber-500/10" : "text-muted-foreground hover:text-amber-500"}`}
      >
        <Lock className="w-3.5 h-3.5" />
      </button>
      <button onClick={onRemove} className="text-muted-foreground hover:text-destructive shrink-0">
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminTemplates() {
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<TemplateForm>(defaultForm());

  const utils = trpc.useUtils();
  const { data: templates = [], isLoading } = trpc.adminTemplates.list.useQuery();
  const { data: appKeyOptions = [] } = trpc.adminTemplates.listAppKeys.useQuery();

  const createMutation = trpc.adminTemplates.create.useMutation({
    onSuccess: () => { utils.adminTemplates.list.invalidate(); setOpen(false); toast.success("Template created"); },
    onError: e => toast.error(e.message),
  });

  const updateMutation = trpc.adminTemplates.update.useMutation({
    onSuccess: () => { utils.adminTemplates.list.invalidate(); setOpen(false); toast.success("Template updated"); },
    onError: e => toast.error(e.message),
  });

  const deleteMutation = trpc.adminTemplates.delete.useMutation({
    onSuccess: () => { utils.adminTemplates.list.invalidate(); toast.success("Template deleted"); },
    onError: e => toast.error(e.message),
  });

  const toggleMutation = trpc.adminTemplates.update.useMutation({
    onSuccess: () => utils.adminTemplates.list.invalidate(),
    onError: e => toast.error(e.message),
  });

  function openNew() {
    setEditId(null);
    setForm(defaultForm());
    setOpen(true);
  }

  function openEdit(t: typeof templates[0]) {
    setEditId(t.id);
    const ct = t.contentType ?? "application/x-www-form-urlencoded";
    const rawFields = (t.bodyFields as BodyField[]) ?? [];
    // Restore JSON template text if this was saved in JSON mode
    const jsonEntry = rawFields.find(f => f.key === JSON_TEMPLATE_KEY);
    setForm({
      name: t.name,
      description: t.description ?? "",
      color: t.color,
      category: ((t as { category?: TemplateCategory }).category ?? "affiliate") as TemplateCategory,
      appKey: ((t as { appKey?: string | null }).appKey ?? "") as string,
      endpointUrl: t.endpointUrl,
      method: (t.method ?? "POST") as "POST" | "GET",
      contentType: ct,
      bodyFields: jsonEntry ? [] : rawFields,
      jsonBodyTemplate: jsonEntry ? jsonEntry.value : DEFAULT_JSON_TEMPLATE,
      userVisibleFields: (t.userVisibleFields as string[]) ?? [],
      variableFields: (t.variableFields as string[]) ?? [],
      autoMappedFields: (t.autoMappedFields as AutoMappedField[]) ?? [],
      isActive: t.isActive,
    });
    setOpen(true);
  }

  function setField<K extends keyof TemplateForm>(k: K, v: TemplateForm[K]) {
    setForm(f => ({ ...f, [k]: v }));
  }

  function updateBodyField(i: number, patch: BodyField) {
    const next = [...form.bodyFields];
    next[i] = patch;
    // Sync userVisibleFields: secret fields → always in userVisibleFields
    const secrets = next.filter(f => f.isSecret).map(f => f.key);
    setForm(f => ({ ...f, bodyFields: next, userVisibleFields: secrets }));
  }

  function removeBodyField(i: number) {
    const next = form.bodyFields.filter((_, idx) => idx !== i);
    const secrets = next.filter(f => f.isSecret).map(f => f.key);
    setForm(f => ({ ...f, bodyFields: next, userVisibleFields: secrets }));
  }

  function addBodyField() {
    setForm(f => ({ ...f, bodyFields: [...f.bodyFields, { key: "", value: "", isSecret: false }] }));
  }

  function updateAutoMapped(i: number, patch: AutoMappedField) {
    const next = [...form.autoMappedFields];
    next[i] = patch;
    setField("autoMappedFields", next);
  }

  function removeAutoMapped(i: number) {
    setField("autoMappedFields", form.autoMappedFields.filter((_, idx) => idx !== i));
  }

  function handleSave() {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (!form.appKey.trim()) { toast.error("App is required — pick which connection spec this template uses"); return; }
    if (!form.endpointUrl.trim()) { toast.error("Endpoint URL is required"); return; }
    const effectiveFields = getEffectiveBodyFields(form);
    if (isJsonMode(form.contentType)) {
      if (!form.jsonBodyTemplate.trim()) { toast.error("JSON body template is required"); return; }
    } else {
      if (form.bodyFields.length === 0) { toast.error("At least one body field is required"); return; }
    }

    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      color: form.color,
      category: form.category,
      appKey: form.appKey,
      endpointUrl: form.endpointUrl.trim(),
      method: form.method,
      contentType: form.contentType,
      bodyFields: isJsonMode(form.contentType)
        ? effectiveFields
        : form.bodyFields.filter(f => f.key.trim()),
      userVisibleFields: form.userVisibleFields,
      variableFields: form.variableFields,
      autoMappedFields: form.autoMappedFields.filter(f => f.key.trim() && f.label.trim()),
      isActive: form.isActive,
    };

    if (editId !== null) {
      updateMutation.mutate({ id: editId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto space-y-6 p-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Destination Templates</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              Manage affiliate endpoint templates. Users pick these when creating destinations.
            </p>
          </div>
          <Button onClick={openNew}>
            <Plus className="w-4 h-4 mr-2" />
            New Template
          </Button>
        </div>

        {/* Template list */}
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-8 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading templates...
          </div>
        ) : templates.length === 0 ? (
          <div className="text-center py-16 border rounded-lg">
            <Globe className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No templates yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {templates.map(t => {
              const bodyFields = (t.bodyFields as BodyField[]) ?? [];
              const secrets = bodyFields.filter(f => f.isSecret).length;
              const varFields = (t.variableFields as string[]) ?? [];
              const category = ((t as { category?: TemplateCategory }).category ?? "affiliate") as TemplateCategory;
              return (
                <div key={t.id} className="flex items-center gap-4 border rounded-lg p-4 bg-card hover:bg-accent/5 transition-colors">
                  {/* Color bar */}
                  <div className="w-1 self-stretch rounded-full shrink-0" style={{ backgroundColor: t.color }} />
                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{t.name}</span>
                      <Badge variant="outline" className={`text-xs ${categoryBadgeClass(category)}`}>
                        {categoryLabel(category)}
                      </Badge>
                      {!t.isActive && <Badge variant="outline" className="text-xs">Inactive</Badge>}
                    </div>
                    {t.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{t.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1 font-mono truncate">{t.endpointUrl}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {bodyFields.length} fields
                      {secrets > 0 && ` · ${secrets} secret`}
                      {varFields.length > 0 && ` · ${varFields.length} variable`}
                    </p>
                  </div>
                  {/* Toggle */}
                  <Switch
                    checked={t.isActive}
                    onCheckedChange={v => toggleMutation.mutate({ id: t.id, isActive: v })}
                  />
                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(t)}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        if (confirm(`Delete template "${t.name}"?`)) {
                          deleteMutation.mutate({ id: t.id });
                        }
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create / Edit modal */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editId !== null ? "Edit Template" : "New Destination Template"}</DialogTitle>
            <DialogDescription>
              Define how leads are sent to this affiliate endpoint.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Basic info */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Name *</Label>
                <Input placeholder="e.g. Sotuvchi.com" value={form.name} onChange={e => setField("name", e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Description</Label>
                <Input placeholder="Short description" value={form.description} onChange={e => setField("description", e.target.value)} />
              </div>
            </div>

            {/* Color + Category */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Color</Label>
                <div className="flex gap-2 flex-wrap">
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setField("color", c)}
                      className={`w-7 h-7 rounded-full border-2 transition-all ${form.color === c ? "border-foreground scale-110" : "border-transparent"}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input
                    type="color"
                    value={form.color}
                    onChange={e => setField("color", e.target.value)}
                    className="w-7 h-7 rounded-full border cursor-pointer bg-transparent"
                    title="Custom color"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Category</Label>
                <select
                  className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  value={form.category}
                  onChange={e => setField("category", e.target.value as TemplateCategory)}
                >
                  {CATEGORIES.map(c => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {CATEGORIES.find(c => c.value === form.category)?.hint}
                </p>
              </div>
            </div>

            {/* App — connection spec the template requires */}
            <div className="space-y-1.5">
              <Label>
                App <span className="text-destructive">*</span>
              </Label>
              <select
                className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                value={form.appKey}
                onChange={e => setField("appKey", e.target.value)}
              >
                <option value="">— pick an app —</option>
                {appKeyOptions.map(o => (
                  <option key={o.appKey} value={o.appKey}>
                    {o.appKey}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Every <code className="bg-muted px-1 rounded">{"{{SECRET:key}}"}</code> token is validated against this
                app&apos;s declared credential fields.
              </p>
            </div>

            {/* Endpoint */}
            <div className="space-y-1.5">
              <Label>Endpoint URL *</Label>
              <Input
                placeholder="https://api.example.com/leads"
                value={form.endpointUrl}
                onChange={e => setField("endpointUrl", e.target.value)}
              />
            </div>

            {/* Method + Content-Type */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Method</Label>
                <select
                  className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  value={form.method}
                  onChange={e => setField("method", e.target.value as "POST" | "GET")}
                >
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Content Type</Label>
                <select
                  className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                  value={form.contentType}
                  onChange={e => setField("contentType", e.target.value)}
                >
                  {CONTENT_TYPES.map(ct => (
                    <option key={ct} value={ct}>{ct}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Body fields */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{isJsonMode(form.contentType) ? "JSON Body Template" : "Body Fields"}</Label>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Info className="w-3 h-3" />
                  Built-ins: {BUILTIN_VAR_HINTS.join(", ")}
                </div>
              </div>

              {isJsonMode(form.contentType) ? (
                /* JSON mode — textarea template */
                <div className="space-y-1">
                  <textarea
                    className="w-full font-mono text-xs min-h-[140px] resize-y rounded-md border border-input bg-background px-3 py-2 focus:outline-none focus:ring-1 focus:ring-ring"
                    placeholder={DEFAULT_JSON_TEMPLATE}
                    value={form.jsonBodyTemplate}
                    onChange={e => setField("jsonBodyTemplate", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Use <code className="bg-muted px-1 rounded">{"{{variable}}"}</code> for lead data,{" "}
                    <code className="bg-muted px-1 rounded">{"{{SECRET:key}}"}</code> for encrypted secrets.
                    Must be valid JSON.
                  </p>
                </div>
              ) : (
                /* Form-urlencoded / multipart mode — key-value rows */
                <>
                  <div className="space-y-2">
                    {form.bodyFields.map((field, i) => (
                      <BodyFieldRow
                        key={i}
                        field={field}
                        onChange={patch => updateBodyField(i, patch)}
                        onRemove={() => removeBodyField(i)}
                      />
                    ))}
                  </div>
                  <Button variant="outline" size="sm" onClick={addBodyField} className="mt-1 h-7 text-xs">
                    <Plus className="w-3 h-3 mr-1" />
                    Add Field
                  </Button>
                  {form.bodyFields.some(f => f.isSecret) && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1 mt-1">
                      <Lock className="w-3 h-3" />
                      Secret fields ({form.userVisibleFields.join(", ")}) will be shown to users at destination creation.
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Variable fields */}
            <TagInput
              label="Variable Fields (per routing rule)"
              values={form.variableFields}
              onChange={v => setField("variableFields", v)}
              placeholder="offer_id, stream..."
            />
            <p className="text-xs text-muted-foreground -mt-3">
              Users fill these per routing rule in Lead Routing Step 5.
            </p>

            {/* Auto-mapped fields */}
            <div className="space-y-2">
              <Label>Auto-mapped Fields (from lead data)</Label>
              <p className="text-xs text-muted-foreground -mt-1">
                The wizard will ask the user to map a Facebook form field into each of these keys.
                Keys named <code className="bg-muted px-1 rounded">name</code> / <code className="bg-muted px-1 rounded">phone</code>
                {" "}(or containing those words, e.g. <code className="bg-muted px-1 rounded">customer_phone</code>) are auto-detected from the lead.
              </p>
              <div className="space-y-2">
                {form.autoMappedFields.map((f, i) => (
                  <AutoMappedRow
                    key={i}
                    field={f}
                    onChange={patch => updateAutoMapped(i, patch)}
                    onRemove={() => removeAutoMapped(i)}
                  />
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setField("autoMappedFields", [...form.autoMappedFields, { key: "", label: "" }])}
                className="h-7 text-xs"
              >
                <Plus className="w-3 h-3 mr-1" />
                Add
              </Button>
            </div>

            {/* Active toggle */}
            <div className="flex items-center gap-3">
              <Switch checked={form.isActive} onCheckedChange={v => setField("isActive", v)} />
              <Label>Active (visible to users)</Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {editId !== null ? "Save Changes" : "Create Template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
