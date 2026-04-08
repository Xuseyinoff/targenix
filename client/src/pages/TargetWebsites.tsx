/**
 * TargetWebsites — manage affiliate site configurations.
 *
 * Each Target Website is a reusable config: set up once, used in many Lead Routings.
 * Template types: sotuvchi | 100k | custom
 *
 * Custom template: universal POST API builder with:
 *  - Content-Type: JSON / form-urlencoded / multipart
 *  - Body builder: JSON editor (with {{variable}} support) or key-value pairs
 *  - Headers: dynamic key-value with {{variable}} support
 *  - Success condition: HTTP 2xx / JSON field check
 *  - Test button: sends sample lead, shows request + response
 */

import { useState, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Globe,
  ChevronRight,
  ArrowLeft,
  Loader2,
  Eye,
  EyeOff,
  Info,
  Pencil,
  CheckCircle2,
  FlaskConical,
  ChevronDown,
  ChevronUp,
  Copy,
} from "lucide-react";

// ─── Template definitions (client-side display only) ─────────────────────────
type TemplateType = "sotuvchi" | "100k" | "custom";
type ContentType = "json" | "form-urlencoded" | "multipart";

interface TemplateInfo {
  id: TemplateType;
  label: string;
  description: string;
  color: string;
  endpoint?: string;
  infoText: string;
  savedFields: Array<{ key: string; label: string; placeholder: string; secret?: boolean }>;
  variableFields: Array<{ key: string; label: string; placeholder: string }>;
  autoMapped: Record<string, string>;
}

const TEMPLATES: TemplateInfo[] = [
  {
    id: "sotuvchi",
    label: "sotuvchi.com",
    description: "O'zbekistondagi yetakchi affiliate platforma",
    color: "bg-blue-500",
    endpoint: "https://sotuvchi.com/api/v2/order",
    infoText: "Leads will be sent as: name, phone, api_key, offer_id, stream",
    savedFields: [
      { key: "apiKey", label: "API Key", placeholder: "Your sotuvchi.com API key", secret: true },
    ],
    variableFields: [
      { key: "offer_id", label: "Offer ID", placeholder: "e.g. 123" },
      { key: "stream", label: "Stream", placeholder: "e.g. main" },
    ],
    autoMapped: { name: "Full Name", phone: "Phone" },
  },
  {
    id: "100k",
    label: "100k.uz",
    description: "100k.uz affiliate tizimi",
    color: "bg-green-500",
    endpoint: "https://api.100k.uz/api/shop/v1/orders/target",
    infoText: "Leads will be sent as: client_full_name, customer_phone, api_key, stream_id",
    savedFields: [
      { key: "apiKey", label: "API Key", placeholder: "Your 100k.uz API key", secret: true },
    ],
    variableFields: [
      { key: "stream_id", label: "Stream ID", placeholder: "e.g. 456" },
    ],
    autoMapped: {
      client_full_name: "Full Name",
      customer_phone: "Phone",
      facebook_lead_id: "Lead ID",
      facebook_form_id: "Form ID",
    },
  },
  {
    id: "custom",
    label: "Custom",
    description: "Istalgan sayt uchun universal POST API builder",
    color: "bg-purple-500",
    infoText: "Configure endpoint URL, content type, body template, headers, and success condition",
    savedFields: [],
    variableFields: [],
    autoMapped: {},
  },
];

// ─── Built-in variables reference ────────────────────────────────────────────
const BUILTIN_VARS = [
  { key: "{{name}}", desc: "Full name" },
  { key: "{{phone}}", desc: "Phone number" },
  { key: "{{email}}", desc: "Email address" },
  { key: "{{lead_id}}", desc: "Facebook lead ID" },
  { key: "{{page_id}}", desc: "Facebook page ID" },
  { key: "{{form_id}}", desc: "Facebook form ID" },
];

const DEFAULT_JSON_TEMPLATE = `{
  "name": "{{name}}",
  "phone": "{{phone}}",
  "email": "{{email}}",
  "offer_id": "{{offer_id}}",
  "stream": "{{stream}}"
}`;

// ─── Form state ──────────────────────────────────────────────────────────────
type FormMode = "select-template" | "configure";

interface BodyField { key: string; value: string }
interface HeaderField { key: string; value: string }

interface FormState {
  name: string;
  templateType: TemplateType;
  fields: Record<string, string>;
  showSecret: Record<string, boolean>;
  // Custom only
  url: string;
  method: "POST";
  contentType: ContentType;
  bodyTemplate: string;
  bodyFields: BodyField[];
  customHeaders: HeaderField[];
  successCondition: "http_2xx" | "json_field";
  jsonField: string;
  jsonValue: string;
  /** User-defined variable names that will be prompted in Step 5 (custom template only) */
  customVariableFields: string[];
}

const defaultForm = (): FormState => ({
  name: "",
  templateType: "sotuvchi",
  fields: {},
  showSecret: {},
  url: "",
  method: "POST",
  contentType: "json",
  bodyTemplate: DEFAULT_JSON_TEMPLATE,
  bodyFields: [
    { key: "name", value: "{{name}}" },
    { key: "phone", value: "{{phone}}" },
  ],
  customHeaders: [],
  successCondition: "http_2xx",
  jsonField: "status",
  jsonValue: "ok",
  customVariableFields: [],
});

// ─── Badge helpers ────────────────────────────────────────────────────────────
function templateBadgeVariant(type: string | null): "default" | "secondary" | "outline" {
  if (type === "sotuvchi") return "default";
  if (type === "100k") return "secondary";
  return "outline";
}

function templateLabel(type: string | null): string {
  return TEMPLATES.find((t) => t.id === type)?.label ?? "Custom";
}

function templateColor(type: string | null): string {
  return TEMPLATES.find((t) => t.id === type)?.color ?? "bg-purple-500";
}

// ─── Test Result Panel ────────────────────────────────────────────────────────
interface TestResult {
  success: boolean;
  durationMs: number;
  requestPreview: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  } | null;
  responseData: unknown;
  error?: string;
}

function TestResultPanel({ result, onClose }: { result: TestResult; onClose: () => void }) {
  const [showReq, setShowReq] = useState(true);
  const [showRes, setShowRes] = useState(true);

  function copyJson(val: unknown) {
    navigator.clipboard.writeText(JSON.stringify(val, null, 2));
    toast.success("Copied to clipboard");
  }

  return (
    <div className="mt-4 rounded-lg border bg-muted/30 overflow-hidden">
      {/* Status bar */}
      <div className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium ${result.success ? "bg-green-500/10 text-green-700 dark:text-green-400" : "bg-red-500/10 text-red-700 dark:text-red-400"}`}>
        <span className={`w-2 h-2 rounded-full ${result.success ? "bg-green-500" : "bg-red-500"}`} />
        {result.success ? "✓ Test passed" : "✗ Test failed"}
        <span className="ml-auto text-xs opacity-70">{result.durationMs}ms</span>
        <button onClick={onClose} className="ml-2 text-muted-foreground hover:text-foreground text-xs">✕</button>
      </div>

      {/* Request preview */}
      {result.requestPreview && (
        <div className="border-t">
          <button
            className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/50 transition-colors"
            onClick={() => setShowReq((v) => !v)}
          >
            <span>REQUEST SENT</span>
            {showReq ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {showReq && (
            <div className="px-4 pb-3 space-y-2">
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="outline" className="font-mono">{result.requestPreview.method}</Badge>
                <code className="text-xs text-muted-foreground truncate">{result.requestPreview.url}</code>
              </div>
              {Object.keys(result.requestPreview.headers).length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Headers:</p>
                  <div className="bg-background rounded border p-2 text-xs font-mono space-y-0.5">
                    {Object.entries(result.requestPreview.headers).map(([k, v]) => (
                      <div key={k}><span className="text-blue-500">{k}</span>: {v}</div>
                    ))}
                  </div>
                </div>
              )}
              {result.requestPreview.body !== null && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-xs text-muted-foreground">Body:</p>
                    <button onClick={() => copyJson(result.requestPreview!.body)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                      <Copy className="w-3 h-3" /> Copy
                    </button>
                  </div>
                  <pre className="bg-background rounded border p-2 text-xs font-mono overflow-auto max-h-32 whitespace-pre-wrap">
                    {JSON.stringify(result.requestPreview.body, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Response */}
      <div className="border-t">
        <button
          className="w-full flex items-center justify-between px-4 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/50 transition-colors"
          onClick={() => setShowRes((v) => !v)}
        >
          <span>RESPONSE</span>
          {showRes ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {showRes && (
          <div className="px-4 pb-3">
            {result.error ? (
              <p className="text-xs text-red-500 font-mono">{result.error}</p>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs text-muted-foreground">Raw response:</p>
                  <button onClick={() => copyJson(result.responseData)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <Copy className="w-3 h-3" /> Copy
                  </button>
                </div>
                <pre className="bg-background rounded border p-2 text-xs font-mono overflow-auto max-h-40 whitespace-pre-wrap">
                  {typeof result.responseData === "string"
                    ? result.responseData
                    : JSON.stringify(result.responseData, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function TargetWebsites() {
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [mode, setMode] = useState<FormMode>("select-template");
  const [form, setForm] = useState<FormState>(defaultForm());
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [showVarRef, setShowVarRef] = useState(false);

  const utils = trpc.useUtils();
  const { data: sites = [], isLoading } = trpc.targetWebsites.list.useQuery();

  const createMutation = trpc.targetWebsites.create.useMutation({
    onSuccess: () => {
      utils.targetWebsites.list.invalidate();
      setOpen(false);
      toast.success("Target website saved");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.targetWebsites.update.useMutation({
    onSuccess: () => {
      utils.targetWebsites.list.invalidate();
      setOpen(false);
      toast.success("Updated");
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.targetWebsites.delete.useMutation({
    onSuccess: () => {
      utils.targetWebsites.list.invalidate();
      toast.success("Deleted");
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleMutation = trpc.targetWebsites.update.useMutation({
    onSuccess: () => utils.targetWebsites.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const testMutation = trpc.targetWebsites.testIntegration.useMutation({
    onSuccess: (data) => {
      setTestResult(data as TestResult);
    },
    onError: (e) => toast.error(`Test failed: ${e.message}`),
  });

  const selectedTemplate = TEMPLATES.find((t) => t.id === form.templateType)!;
  const isCustom = form.templateType === "custom";

  function openAdd() {
    setEditId(null);
    setForm(defaultForm());
    setMode("select-template");
    setTestResult(null);
    setOpen(true);
  }

  function openEdit(site: (typeof sites)[0]) {
    setEditId(site.id);
    const tpl = TEMPLATES.find((t) => t.id === site.templateType) ?? TEMPLATES[2];
    const config = (site.templateConfig ?? {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};

    // Restore bodyFields from config
    const bodyFields: BodyField[] = Array.isArray(config.bodyFields)
      ? (config.bodyFields as BodyField[])
      : [{ key: "name", value: "{{name}}" }, { key: "phone", value: "{{phone}}" }];

    setForm({
      ...defaultForm(),
      name: site.name,
      templateType: tpl.id,
      fields,
      url: (config.url as string) ?? site.url ?? "",
      method: "POST",
      contentType: (config.contentType as ContentType) ?? "json",
      bodyTemplate: (config.bodyTemplate as string) ?? DEFAULT_JSON_TEMPLATE,
      bodyFields,
      customHeaders: config.headers
        ? Object.entries(config.headers as Record<string, string>).map(([k, v]) => ({ key: k, value: v }))
        : [],
      successCondition: (config.successCondition as "http_2xx" | "json_field") ?? "http_2xx",
      jsonField: (config.jsonField as string) ?? "status",
      jsonValue: (config.jsonValue as string) ?? "ok",
      customVariableFields: Array.isArray(config.variableFields)
        ? (config.variableFields as string[])
        : [],
    });
    setMode("configure");
    setTestResult(null);
    setOpen(true);
  }

  function setField(key: string, value: string) {
    setForm((f) => ({ ...f, fields: { ...f.fields, [key]: value } }));
  }

  function toggleShowSecret(key: string) {
    setForm((f) => ({ ...f, showSecret: { ...f.showSecret, [key]: !f.showSecret[key] } }));
  }

  function handleTemplateSelect(id: TemplateType) {
    setForm((f) => ({ ...f, templateType: id, fields: {}, showSecret: {} }));
    setMode("configure");
  }

  function handleSubmit() {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (isCustom && !form.url.trim()) { toast.error("Endpoint URL is required"); return; }

    // Validate apiKey for non-custom templates (required on create, optional on edit)
    if (!isCustom) {
      for (const sf of selectedTemplate.savedFields) {
        if (sf.key === "apiKey" && editId) continue;
        if (!form.fields[sf.key]?.trim()) {
          toast.error(`"${sf.label}" is required`);
          return;
        }
      }
    }

    // Validate JSON template if contentType = json
    if (isCustom && form.contentType === "json" && form.bodyTemplate.trim()) {
      try { JSON.parse(form.bodyTemplate); } catch {
        toast.error("Body template is not valid JSON. Check for syntax errors.");
        return;
      }
    }

    const headersObj = Object.fromEntries(
      form.customHeaders.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value])
    );

    const payload: Parameters<typeof createMutation.mutate>[0] = {
      name: form.name,
      templateType: form.templateType,
      ...(form.fields.apiKey ? { apiKey: form.fields.apiKey } : {}),
      ...(isCustom ? {
        url: form.url,
        method: "POST",
        contentType: form.contentType === "form-urlencoded" ? "form-urlencoded" : form.contentType,
        headers: headersObj,
        bodyTemplate: form.contentType === "json" ? form.bodyTemplate : undefined,
        bodyFields: form.contentType !== "json" ? form.bodyFields.filter((f) => f.key.trim()) : undefined,
        successCondition: form.successCondition,
        jsonField: form.successCondition === "json_field" ? form.jsonField : undefined,
        jsonValue: form.successCondition === "json_field" ? form.jsonValue : undefined,
        variableFields: form.customVariableFields.filter((v) => v.trim()),
      } : {}),
    };

    if (editId) {
      updateMutation.mutate({ id: editId, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  function handleTest() {
    if (!editId) {
      toast.info("Save the website first, then test it");
      return;
    }
    setTestResult(null);
    testMutation.mutate({ id: editId });
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isTesting = testMutation.isPending;

  return (
    <DashboardLayout>
      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">Destinations</h1>
            <p className="text-muted-foreground text-xs mt-0.5 hidden sm:block">
              Reusable affiliate site configurations — set up once, use in many Lead Routings
            </p>
          </div>
          <Button size="sm" className="h-8 px-2 shrink-0" onClick={openAdd}>
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline ml-1.5">Add Website</span>
          </Button>
        </div>

        {/* List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : sites.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
              <Globe className="w-10 h-10 text-muted-foreground/40" />
              <p className="text-muted-foreground text-sm">No target websites yet</p>
              <Button variant="outline" size="sm" onClick={openAdd}>
                <Plus className="w-4 h-4 mr-2" />
                Add your first website
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {sites.map((site) => {
              const config = (site.templateConfig ?? {}) as Record<string, unknown>;
              const tpl = TEMPLATES.find((t) => t.id === site.templateType);
              return (
                <Card key={site.id} className="hover:shadow-sm transition-shadow">
                  <CardContent className="p-3 flex items-center gap-3">
                    <div className="w-1.5 h-10 rounded-full shrink-0" style={{ backgroundColor: site.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="font-semibold text-sm">{site.name}</span>
                        <Badge variant={templateBadgeVariant(site.templateType)} className="text-xs shrink-0">
                          {templateLabel(site.templateType)}
                        </Badge>
                        {!site.isActive && <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">Inactive</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {site.url || (config.url as string) || tpl?.endpoint || "—"}
                      </p>
                      {Boolean(config.apiKeyMasked) && (
                        <p className="text-xs text-muted-foreground mt-0.5">API Key: ••••••••</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Switch
                        checked={site.isActive}
                        onCheckedChange={(checked) =>
                          toggleMutation.mutate({ id: site.id, isActive: checked })
                        }
                      />
                      <Button variant="ghost" size="icon" onClick={() => openEdit(site)}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          if (confirm("Delete this website?")) deleteMutation.mutate({ id: site.id });
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {mode === "select-template"
                ? "Choose Template"
                : editId
                ? `Edit: ${form.name || "Website"}`
                : `New ${selectedTemplate?.label ?? "Website"}`}
            </DialogTitle>
            <DialogDescription>
              {mode === "select-template"
                ? "Select a template to get started"
                : editId
                ? "Update your target website configuration"
                : "Configure a new target website for lead routing"}
            </DialogDescription>
          </DialogHeader>

          {/* Step 1: Template selector */}
          {mode === "select-template" && (
            <div className="grid gap-3 py-2">
              {TEMPLATES.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => handleTemplateSelect(tpl.id)}
                  className="flex items-center gap-4 p-4 rounded-lg border hover:border-primary hover:bg-muted/30 transition-all text-left group"
                >
                  <div className={`w-3 h-10 rounded-full shrink-0 ${tpl.color}`} />
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm">{tpl.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{tpl.description}</div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </button>
              ))}
            </div>
          )}

          {/* Step 2: Configure */}
          {mode === "configure" && (
            <div className="space-y-5 py-2">
              {/* Back button */}
              {!editId && (
                <button
                  onClick={() => setMode("select-template")}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to templates
                </button>
              )}

              {/* Template badge */}
              <div className="flex items-center gap-2">
                <div className={`w-2 h-6 rounded-full ${selectedTemplate.color}`} />
                <span className="font-medium text-sm">{selectedTemplate.label}</span>
                {selectedTemplate.endpoint && (
                  <span className="text-xs text-muted-foreground truncate">{selectedTemplate.endpoint}</span>
                )}
              </div>

              {/* Name */}
              <div className="space-y-1.5">
                <Label>Name <span className="text-destructive">*</span></Label>
                <Input
                  placeholder={`e.g. ${selectedTemplate.label} — My Campaign`}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>

              {/* Non-custom: saved fields (apiKey) */}
              {!isCustom && selectedTemplate.savedFields.map((sf) => (
                <div key={sf.key} className="space-y-1.5">
                  <Label>
                    {sf.label}
                    {sf.key !== "apiKey" || !editId ? (
                      <span className="text-destructive"> *</span>
                    ) : (
                      <span className="text-muted-foreground text-xs ml-1">(leave blank to keep existing)</span>
                    )}
                  </Label>
                  <div className="relative">
                    <Input
                      placeholder={editId && sf.secret ? "••••••••  (unchanged)" : sf.placeholder}
                      value={form.fields[sf.key] ?? ""}
                      onChange={(e) => setField(sf.key, e.target.value)}
                      type={sf.secret && !form.showSecret[sf.key] ? "password" : "text"}
                      className={sf.secret ? "pr-10" : ""}
                    />
                    {sf.secret && (
                      <button
                        type="button"
                        onClick={() => toggleShowSecret(sf.key)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {form.showSecret[sf.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {/* Non-custom: auto-mapped info */}
              {!isCustom && Object.keys(selectedTemplate.autoMapped).length > 0 && (
                <div className="rounded-lg bg-muted/40 border p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3" /> Auto-mapped fields
                  </p>
                  {Object.entries(selectedTemplate.autoMapped).map(([k, v]) => (
                    <p key={k} className="text-xs text-muted-foreground">
                      <code className="bg-background px-1 rounded">{k}</code> ← {v}
                    </p>
                  ))}
                </div>
              )}

              {/* ── CUSTOM TEMPLATE FIELDS ── */}
              {isCustom && (
                <>
                  {/* Endpoint URL */}
                  <div className="space-y-1.5">
                    <Label>Endpoint URL <span className="text-destructive">*</span></Label>
                    <Input
                      placeholder="https://your-crm.com/api/leads"
                      value={form.url}
                      onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                    />
                  </div>

                  {/* Method + Content Type */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Method</Label>
                      <div className="h-9 flex items-center px-3 rounded-md border bg-muted/30 text-sm text-muted-foreground">
                        POST
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Content Type</Label>
                      <select
                        className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                        value={form.contentType}
                        onChange={(e) => setForm((f) => ({ ...f, contentType: e.target.value as ContentType }))}
                      >
                        <option value="json">application/json</option>
                        <option value="form-urlencoded">application/x-www-form-urlencoded</option>
                        <option value="multipart">multipart/form-data</option>
                      </select>
                    </div>
                  </div>

                  {/* Variable reference */}
                  <div className="rounded-lg border bg-muted/20">
                    <button
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowVarRef((v) => !v)}
                    >
                      <span className="flex items-center gap-1.5">
                        <Info className="w-3 h-3" />
                        Available variables (click to expand)
                      </span>
                      {showVarRef ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                    {showVarRef && (
                      <div className="px-3 pb-3 grid grid-cols-2 gap-1.5">
                        {BUILTIN_VARS.map((v) => (
                          <div key={v.key} className="flex items-center gap-2">
                            <code
                              className="text-xs bg-background border rounded px-1.5 py-0.5 cursor-pointer hover:bg-primary/10 transition-colors"
                              onClick={() => {
                                navigator.clipboard.writeText(v.key);
                                toast.success(`Copied ${v.key}`);
                              }}
                            >
                              {v.key}
                            </code>
                            <span className="text-xs text-muted-foreground">{v.desc}</span>
                          </div>
                        ))}
                        <div className="col-span-2 mt-1 text-xs text-muted-foreground">
                          Custom: <code className="bg-background border rounded px-1 py-0.5">{"{{offer_id}}"}</code>{" "}
                          <code className="bg-background border rounded px-1 py-0.5">{"{{stream}}"}</code>{" "}
                          <code className="bg-background border rounded px-1 py-0.5">{"{{any_field}}"}</code>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Body builder */}
                  <div className="space-y-2">
                    <Label>
                      {form.contentType === "json" ? "Body Template (JSON)" : "Body Fields"}
                    </Label>

                    {form.contentType === "json" ? (
                      <div className="space-y-1">
                        <Textarea
                          className="font-mono text-xs min-h-[140px] resize-y"
                          placeholder={DEFAULT_JSON_TEMPLATE}
                          value={form.bodyTemplate}
                          onChange={(e) => setForm((f) => ({ ...f, bodyTemplate: e.target.value }))}
                        />
                        <p className="text-xs text-muted-foreground">
                          Use <code className="bg-muted px-1 rounded">{"{{variable}}"}</code> for dynamic values. Must be valid JSON.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {form.bodyFields.map((bf, i) => (
                          <div key={i} className="flex gap-2 items-center">
                            <Input
                              placeholder="Key (e.g. name)"
                              value={bf.key}
                              className="font-mono text-xs"
                              onChange={(e) => {
                                const fs = [...form.bodyFields];
                                fs[i] = { ...fs[i], key: e.target.value };
                                setForm((f) => ({ ...f, bodyFields: fs }));
                              }}
                            />
                            <span className="text-muted-foreground text-sm shrink-0">→</span>
                            <Input
                              placeholder="Value (e.g. {{name}})"
                              value={bf.value}
                              className="font-mono text-xs"
                              onChange={(e) => {
                                const fs = [...form.bodyFields];
                                fs[i] = { ...fs[i], value: e.target.value };
                                setForm((f) => ({ ...f, bodyFields: fs }));
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="shrink-0"
                              onClick={() =>
                                setForm((f) => ({ ...f, bodyFields: f.bodyFields.filter((_, j) => j !== i) }))
                              }
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setForm((f) => ({ ...f, bodyFields: [...f.bodyFields, { key: "", value: "" }] }))
                          }
                        >
                          <Plus className="w-3 h-3 mr-1" /> Add Field
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Headers */}
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Headers <span className="text-xs font-normal">(optional, supports variables)</span></Label>
                    {form.customHeaders.map((h, i) => (
                      <div key={i} className="flex gap-2">
                        <Input
                          placeholder="Header name (e.g. Authorization)"
                          value={h.key}
                          className="text-xs"
                          onChange={(e) => {
                            const hs = [...form.customHeaders];
                            hs[i] = { ...hs[i], key: e.target.value };
                            setForm((f) => ({ ...f, customHeaders: hs }));
                          }}
                        />
                        <Input
                          placeholder="Value (e.g. Bearer {{api_key}})"
                          value={h.value}
                          className="text-xs font-mono"
                          onChange={(e) => {
                            const hs = [...form.customHeaders];
                            hs[i] = { ...hs[i], value: e.target.value };
                            setForm((f) => ({ ...f, customHeaders: hs }));
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          onClick={() =>
                            setForm((f) => ({ ...f, customHeaders: f.customHeaders.filter((_, j) => j !== i) }))
                          }
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setForm((f) => ({ ...f, customHeaders: [...f.customHeaders, { key: "", value: "" }] }))
                      }
                    >
                      <Plus className="w-3 h-3 mr-1" /> Add Header
                    </Button>
                  </div>

                  {/* Variable Fields */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label>Variable Fields</Label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Names of fields the user fills in Step 5 when creating a routing rule (e.g. <code className="font-mono">stream</code>, <code className="font-mono">offer_id</code>)
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0 text-xs"
                        onClick={() => setForm((f) => ({ ...f, customVariableFields: [...f.customVariableFields, ""] }))}
                      >
                        + Add Field
                      </Button>
                    </div>
                    {form.customVariableFields.length === 0 && (
                      <p className="text-xs text-muted-foreground italic">
                        No variable fields defined. Add fields that should be filled per routing rule.
                      </p>
                    )}
                    {form.customVariableFields.map((vf, idx) => (
                      <div key={idx} className="flex gap-2 items-center">
                        <Input
                          placeholder={`e.g. stream, offer_id, campaign`}
                          value={vf}
                          className="text-xs font-mono"
                          onChange={(e) => {
                            const next = [...form.customVariableFields];
                            next[idx] = e.target.value;
                            setForm((f) => ({ ...f, customVariableFields: next }));
                          }}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="shrink-0 text-muted-foreground hover:text-destructive px-2"
                          onClick={() => {
                            const next = form.customVariableFields.filter((_, i) => i !== idx);
                            setForm((f) => ({ ...f, customVariableFields: next }));
                          }}
                        >
                          ✕
                        </Button>
                      </div>
                    ))}
                  </div>

                  {/* Success Condition */}
                  <div className="space-y-2">
                    <Label>Success Condition</Label>
                    <select
                      className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                      value={form.successCondition}
                      onChange={(e) => setForm((f) => ({ ...f, successCondition: e.target.value as "http_2xx" | "json_field" }))}
                    >
                      <option value="http_2xx">HTTP 2xx response (default)</option>
                      <option value="json_field">JSON field equals value</option>
                    </select>
                    {form.successCondition === "json_field" && (
                      <div className="flex gap-2 items-center">
                        <Input
                          placeholder="Field name (e.g. status)"
                          value={form.jsonField}
                          className="text-xs font-mono"
                          onChange={(e) => setForm((f) => ({ ...f, jsonField: e.target.value }))}
                        />
                        <span className="text-muted-foreground text-sm shrink-0">==</span>
                        <Input
                          placeholder="Expected value (e.g. ok)"
                          value={form.jsonValue}
                          className="text-xs font-mono"
                          onChange={(e) => setForm((f) => ({ ...f, jsonValue: e.target.value }))}
                        />
                      </div>
                    )}
                  </div>

                  {/* Test button + result */}
                  {editId && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleTest}
                          disabled={isTesting}
                          className="flex items-center gap-2"
                        >
                          {isTesting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <FlaskConical className="w-4 h-4" />
                          )}
                          {isTesting ? "Testing…" : "Test Integration"}
                        </Button>
                        <p className="text-xs text-muted-foreground">
                          Sends a sample lead to your endpoint
                        </p>
                      </div>
                      {testResult && (
                        <TestResultPanel result={testResult} onClose={() => setTestResult(null)} />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {mode === "configure" && (
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={isSaving}>
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {editId ? "Save Changes" : "Save Website"}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
