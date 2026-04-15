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

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/useT";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DialogFooter } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  WebsiteFlowDialog,
  AddWebsiteSelectStep,
} from "@/components/AddWebsiteModal";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Globe,
  ArrowLeft,
  Loader2,
  MoreVertical,
  Eye,
  EyeOff,
  Info,
  Pencil,
  FlaskConical,
  ChevronDown,
  ChevronUp,
  Copy,
  X,
  Link2,
  Braces,
  Sparkles,
  Layers,
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

// ─── Dynamic template types ───────────────────────────────────────────────────
interface DynBodyField { key: string; value: string; isSecret: boolean }
interface DynAutoMapped { key: string; label: string }
interface DynTemplate {
  id: number;
  name: string;
  description?: string | null;
  color: string;
  endpointUrl: string;
  userVisibleFields: string[];
  variableFields: string[];
  autoMappedFields: DynAutoMapped[];
  bodyFields: DynBodyField[];
}

// ─── Form state ──────────────────────────────────────────────────────────────
// "edit-dynamic" = editing a template-based destination (name + secrets only)
type FormMode = "select-template" | "configure" | "configure-dynamic" | "edit-dynamic";

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
  const t = useT();

  function copyJson(val: unknown) {
    navigator.clipboard.writeText(JSON.stringify(val, null, 2));
    toast.success(t("destinations.toast.copied"));
  }

  return (
    <div className="mt-4 rounded-lg border bg-muted/30 overflow-hidden">
      {/* Status bar */}
      <div className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium ${result.success ? "bg-green-500/10 text-green-700 dark:text-green-400" : "bg-red-500/10 text-red-700 dark:text-red-400"}`}>
        <span className={`w-2 h-2 rounded-full ${result.success ? "bg-green-500" : "bg-red-500"}`} />
        {result.success ? t("destinations.testPanel.passed") : t("destinations.testPanel.failed")}
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
            <span>{t("destinations.testPanel.requestSent")}</span>
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
                  <p className="text-xs text-muted-foreground mb-1">{t("destinations.testPanel.headers")}</p>
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
                    <p className="text-xs text-muted-foreground">{t("destinations.testPanel.body")}</p>
                    <button onClick={() => copyJson(result.requestPreview!.body)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                      <Copy className="w-3 h-3" /> {t("destinations.testPanel.copy")}
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
          <span>{t("destinations.testPanel.response")}</span>
          {showRes ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        {showRes && (
          <div className="px-4 pb-3">
            {result.error ? (
              <p className="text-xs text-red-500 font-mono">{result.error}</p>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs text-muted-foreground">{t("destinations.testPanel.rawResponse")}</p>
                  <button onClick={() => copyJson(result.responseData)} className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <Copy className="w-3 h-3" /> {t("destinations.testPanel.copy")}
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

// ─── TagInput — chip-style tag field (Enter or comma to add) ─────────────────
function TagInput({
  label,
  hint,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const t = useT();
  function addTag() {
    const v = draft.trim();
    if (!v || values.includes(v)) { setDraft(""); return; }
    onChange([...values, v]);
    setDraft("");
  }
  return (
    <div className="space-y-1.5">
      <div>
        <Label>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <div className="flex flex-wrap gap-1.5 min-h-[36px] rounded-md border bg-background px-2 py-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-xs font-mono">
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="text-muted-foreground hover:text-foreground">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          className="flex-1 min-w-[80px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder={values.length === 0 ? placeholder : t("destinations.tagInput.add")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addTag(); } }}
          onBlur={addTag}
        />
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function TargetWebsites() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [mode, setMode] = useState<FormMode>("select-template");
  const [form, setForm] = useState<FormState>(defaultForm());
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "inactive" | "template" | "custom">("all");
  // Dynamic template state (create flow)
  const [selectedDynTemplate, setSelectedDynTemplate] = useState<DynTemplate | null>(null);
  const [dynName, setDynName] = useState("");
  const [dynSecrets, setDynSecrets] = useState<Record<string, string>>({});
  const [dynShowSecret, setDynShowSecret] = useState<Record<string, boolean>>({});
  // Edit-dynamic state (edit flow — simplified: name + secrets only)
  const [editDynSecretKeys, setEditDynSecretKeys] = useState<string[]>([]);
  const [editDynUrl, setEditDynUrl] = useState("");

  const utils = trpc.useUtils();
  const { data: sites = [], isLoading } = trpc.targetWebsites.list.useQuery();
  const { data: dynTemplates = [] } = trpc.targetWebsites.getTemplates.useQuery();

  const createMutation = trpc.targetWebsites.create.useMutation({
    onSuccess: () => {
      utils.targetWebsites.list.invalidate();
      setOpen(false);
      toast.success(t("destinations.toast.targetWebsiteSaved"));
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMutation = trpc.targetWebsites.update.useMutation({
    onSuccess: () => {
      utils.targetWebsites.list.invalidate();
      setOpen(false);
      toast.success(t("destinations.toast.updated"));
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.targetWebsites.delete.useMutation({
    onSuccess: () => {
      utils.targetWebsites.list.invalidate();
      toast.success(t("destinations.toast.deleted"));
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
    onError: (e) => toast.error(t("destinations.toast.testFailed", { message: e.message })),
  });

  const createFromTemplateMutation = trpc.targetWebsites.createFromTemplate.useMutation({
    onSuccess: () => {
      utils.targetWebsites.list.invalidate();
      setOpen(false);
      toast.success(t("destinations.toast.saved"));
    },
    onError: (e) => toast.error(e.message),
  });

  const updateFromTemplateMutation = trpc.targetWebsites.updateFromTemplate.useMutation({
    onSuccess: () => {
      utils.targetWebsites.list.invalidate();
      setOpen(false);
      toast.success(t("destinations.toast.updated"));
    },
    onError: (e) => toast.error(e.message),
  });

  const selectedTemplate = TEMPLATES.find((t) => t.id === form.templateType)!;
  const isCustom = form.templateType === "custom";

  const filteredSites = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sites
      .filter((site) => {
        const isTemplateBased = site.templateType !== "custom" || !!(site as { templateId?: number | null }).templateId;
        const isPureCustom = site.templateType === "custom" && !(site as { templateId?: number | null }).templateId;
        if (filter === "active") return !!site.isActive;
        if (filter === "inactive") return !site.isActive;
        if (filter === "template") return isTemplateBased;
        if (filter === "custom") return isPureCustom;
        return true;
      })
      .filter((site) => {
        if (!q) return true;
        const config = (site.templateConfig ?? {}) as Record<string, unknown>;
        const url = String(site.url || (config.url as string) || "");
        const type = String(site.templateType || "");
        return (
          site.name.toLowerCase().includes(q) ||
          url.toLowerCase().includes(q) ||
          type.toLowerCase().includes(q)
        );
      });
  }, [sites, query, filter]);

  function openAdd() {
    setEditId(null);
    setForm(defaultForm());
    setMode("select-template");
    setTestResult(null);
    setSelectedDynTemplate(null);
    setDynName("");
    setDynSecrets({});
    setDynShowSecret({});
    setOpen(true);
  }

  function selectDynTemplate(tpl: typeof dynTemplates[0]) {
    const bodyFields = (tpl.bodyFields as DynBodyField[]) ?? [];
    const userVisibleFields = (tpl.userVisibleFields as string[]) ?? [];
    const variableFields = (tpl.variableFields as string[]) ?? [];
    const autoMappedFields = (tpl.autoMappedFields as DynAutoMapped[]) ?? [];
    setSelectedDynTemplate({ ...tpl, bodyFields, userVisibleFields, variableFields, autoMappedFields });
    setDynName("");
    setDynSecrets({});
    setDynShowSecret({});
    setMode("configure-dynamic");
  }

  function handleDynSubmit() {
    if (!dynName.trim()) { toast.error(t("destinations.validation.nameRequired")); return; }
    if (!selectedDynTemplate) return;
    for (const key of selectedDynTemplate.userVisibleFields) {
      if (!dynSecrets[key]?.trim()) { toast.error(t("destinations.validation.fieldRequired", { field: key })); return; }
    }
    createFromTemplateMutation.mutate({
      templateId: selectedDynTemplate.id,
      name: dynName.trim(),
      secrets: dynSecrets,
    });
  }

  function openEdit(site: (typeof sites)[0]) {
    setEditId(site.id);
    setTestResult(null);

    // Dynamic template-based destination → simplified edit (name + secrets only)
    const siteTemplateId = (site as { templateId?: number | null }).templateId;
    if (siteTemplateId) {
      const config = (site.templateConfig ?? {}) as Record<string, unknown>;
      const secretKeys = Object.keys((config.secrets ?? {}) as Record<string, unknown>);
      setDynName(site.name);
      setDynSecrets({});
      setDynShowSecret({});
      setEditDynSecretKeys(secretKeys);
      setEditDynUrl(site.url ?? "");
      setMode("edit-dynamic");
      setOpen(true);
      return;
    }

    // Legacy template (sotuvchi / 100k / custom) → full form
    const tpl = TEMPLATES.find((t) => t.id === site.templateType) ?? TEMPLATES[2];
    const config = (site.templateConfig ?? {}) as Record<string, unknown>;

    const bodyFields: BodyField[] = Array.isArray(config.bodyFields)
      ? (config.bodyFields as BodyField[])
      : [{ key: "name", value: "{{name}}" }, { key: "phone", value: "{{phone}}" }];

    setForm({
      ...defaultForm(),
      name: site.name,
      templateType: tpl.id,
      fields: {},
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
    setOpen(true);
  }

  function handleEditDynSubmit() {
    if (!dynName.trim()) { toast.error(t("destinations.validation.nameRequired")); return; }
    if (!editId) return;
    updateFromTemplateMutation.mutate({
      id: editId,
      name: dynName.trim(),
      secrets: dynSecrets,
    });
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
    if (!form.name.trim()) { toast.error(t("destinations.validation.nameRequired")); return; }
    if (isCustom && !form.url.trim()) { toast.error(t("destinations.validation.endpointRequired")); return; }

    // Validate apiKey for non-custom templates (required on create, optional on edit)
    if (!isCustom) {
      for (const sf of selectedTemplate.savedFields) {
        if (sf.key === "apiKey" && editId) continue;
        if (!form.fields[sf.key]?.trim()) {
          toast.error(t("destinations.validation.fieldRequired", { field: sf.label }));
          return;
        }
      }
    }

    // Validate JSON template if contentType = json
    if (isCustom && form.contentType === "json" && form.bodyTemplate.trim()) {
      try { JSON.parse(form.bodyTemplate); } catch {
        toast.error(t("destinations.validation.invalidJson"));
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
      toast.info(t("destinations.validation.saveFirstThenTest"));
      return;
    }
    setTestResult(null);
    testMutation.mutate({ id: editId });
  }

  const isSaving = createMutation.isPending || updateMutation.isPending || createFromTemplateMutation.isPending || updateFromTemplateMutation.isPending;
  const isTesting = testMutation.isPending;

  return (
    <DashboardLayout>
      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">{t("destinations.title")}</h1>
            <p className="text-muted-foreground text-xs mt-0.5 hidden sm:block">
              {t("destinations.subtitle")}
            </p>
          </div>
          <Button size="sm" className="h-10 px-3 shrink-0" onClick={openAdd}>
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline ml-1.5">{t("destinations.addWebsite")}</span>
          </Button>
        </div>

        {/* Search + filters (mobile-first) */}
        {!isLoading && sites.length > 0 && (
          <div className="space-y-3">
            <div className="relative">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("destinations.searchPlaceholder")}
                className="h-10"
              />
            </div>
            <div className="flex items-center gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <Button
                type="button"
                variant={filter === "all" ? "secondary" : "outline"}
                size="sm"
                className="h-9 shrink-0"
                onClick={() => setFilter("all")}
              >
                {t("destinations.filterAll")}
              </Button>
              <Button
                type="button"
                variant={filter === "active" ? "secondary" : "outline"}
                size="sm"
                className="h-9 shrink-0"
                onClick={() => setFilter("active")}
              >
                {t("destinations.filterActive")}
              </Button>
              <Button
                type="button"
                variant={filter === "inactive" ? "secondary" : "outline"}
                size="sm"
                className="h-9 shrink-0"
                onClick={() => setFilter("inactive")}
              >
                {t("destinations.filterInactive")}
              </Button>
              <Button
                type="button"
                variant={filter === "template" ? "secondary" : "outline"}
                size="sm"
                className="h-9 shrink-0"
                onClick={() => setFilter("template")}
              >
                {t("destinations.filterTemplate")}
              </Button>
              <Button
                type="button"
                variant={filter === "custom" ? "secondary" : "outline"}
                size="sm"
                className="h-9 shrink-0"
                onClick={() => setFilter("custom")}
              >
                {t("destinations.filterCustom")}
              </Button>
            </div>
          </div>
        )}

        {/* List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : sites.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
              <Globe className="w-10 h-10 text-muted-foreground/40" />
              <p className="text-muted-foreground text-sm">{t("destinations.emptyTitle")}</p>
              <Button variant="outline" size="sm" onClick={openAdd}>
                <Plus className="w-4 h-4 mr-2" />
                {t("destinations.emptyCta")}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {filteredSites.map((site) => {
              const config = (site.templateConfig ?? {}) as Record<string, unknown>;
              const tpl = TEMPLATES.find((t) => t.id === site.templateType);
              const isDynamic = !!(site as { templateId?: number | null }).templateId;
              const dynName = (site as { templateName?: string | null }).templateName;
              return (
                <Card key={site.id} className="hover:shadow-sm transition-shadow">
                  <CardContent className="p-3 flex items-center gap-3">
                    <div className="w-1.5 h-10 rounded-full shrink-0" style={{ backgroundColor: site.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="font-semibold text-sm">{site.name}</span>
                        <Badge variant={isDynamic ? "secondary" : templateBadgeVariant(site.templateType)} className="text-xs shrink-0">
                          {isDynamic ? (dynName ?? t("destinations.filterTemplate")) : templateLabel(site.templateType)}
                        </Badge>
                        {!site.isActive && (
                          <Badge variant="outline" className="text-xs text-muted-foreground shrink-0">
                            {t("destinations.inactiveBadge")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {site.url || (config.url as string) || tpl?.endpoint || "—"}
                      </p>
                      {Boolean(config.apiKeyMasked) && (
                        <p className="text-xs text-muted-foreground mt-0.5">{t("destinations.labels.apiKeyConfigured")}</p>
                      )}
                      {isDynamic && typeof config.secrets === "object" && config.secrets !== null && Object.keys(config.secrets as Record<string, unknown>).length > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">{t("destinations.labels.secretsConfigured")}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="hidden sm:flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-12 text-right">
                          {site.isActive ? t("destinations.statusActive") : t("destinations.statusOff")}
                        </span>
                        <Switch
                          checked={site.isActive}
                          onCheckedChange={(checked) =>
                            toggleMutation.mutate({ id: site.id, isActive: checked })
                          }
                        />
                      </div>
                      <div className="sm:hidden flex flex-col items-end gap-1">
                        <span className="text-[11px] text-muted-foreground">
                          {site.isActive ? t("destinations.statusActive") : t("destinations.statusOff")}
                        </span>
                        <Switch
                          checked={site.isActive}
                          onCheckedChange={(checked) =>
                            toggleMutation.mutate({ id: site.id, isActive: checked })
                          }
                        />
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11"
                            aria-label={t("destinations.moreActions")}
                          >
                            <MoreVertical className="w-5 h-5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem onClick={() => openEdit(site)} className="cursor-pointer">
                            <Pencil className="mr-2 h-4 w-4" />
                            {t("destinations.edit")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => {
                              if (confirm(t("destinations.confirmDelete"))) deleteMutation.mutate({ id: site.id });
                            }}
                            className="cursor-pointer text-destructive focus:text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t("destinations.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <WebsiteFlowDialog
        open={open}
        onOpenChange={setOpen}
        mode={mode}
        wideDesktop={mode !== "select-template"}
        headerTitle={
          mode === "select-template"
            ? t("destinations.dialog.addTitle")
            : mode === "configure-dynamic"
              ? t("destinations.dialog.newTitle", { name: selectedDynTemplate?.name ?? "Website" })
              : mode === "edit-dynamic"
                ? t("destinations.dialog.editTitle", { name: dynName || "Website" })
                : editId
                  ? t("destinations.dialog.editTitle", { name: form.name || "Website" })
                  : t("destinations.dialog.newTitle", { name: selectedTemplate?.label ?? "Website" })
        }
        headerDescription={
          mode === "select-template"
            ? t("destinations.dialog.addSubtitle")
            : mode === "configure-dynamic"
              ? selectedDynTemplate?.endpointUrl ?? t("destinations.dialog.configureSubtitle")
              : mode === "edit-dynamic"
                ? editDynUrl || t("destinations.dialog.editDynamicSubtitle")
                : editId
                  ? t("destinations.dialog.editSubtitle")
                  : t("destinations.dialog.newSubtitle")
        }
        footer={
          mode === "configure-dynamic" ? (
            <DialogFooter className="gap-2 sm:justify-end">
              <Button variant="outline" onClick={() => setOpen(false)}>
                {t("destinations.dialog.cancel")}
              </Button>
              <Button onClick={handleDynSubmit} disabled={isSaving}>
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t("destinations.dialog.saveWebsite")}
              </Button>
            </DialogFooter>
          ) : mode === "edit-dynamic" ? (
            <DialogFooter className="gap-2 sm:justify-end">
              <Button variant="outline" onClick={() => setOpen(false)}>
                {t("destinations.dialog.cancel")}
              </Button>
              <Button onClick={handleEditDynSubmit} disabled={isSaving}>
                {isSaving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {t("destinations.dialog.saveChanges")}
              </Button>
            </DialogFooter>
          ) : mode === "configure" ? (
            <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" className="h-10 w-full sm:w-auto" onClick={() => setOpen(false)}>
                {t("destinations.dialog.cancel")}
              </Button>
              <Button className="h-10 w-full shadow-sm sm:w-auto sm:min-w-[9rem]" onClick={handleSubmit} disabled={isSaving}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editId ? t("destinations.dialog.saveChanges") : t("destinations.dialog.saveWebsite")}
              </Button>
            </DialogFooter>
          ) : undefined
        }
      >
        {mode === "select-template" && (
          <AddWebsiteSelectStep
            open={open}
            templates={dynTemplates}
            onSelectAffiliate={selectDynTemplate}
            onSelectCustom={() => handleTemplateSelect("custom")}
          />
        )}

          {/* Step 2a: Configure dynamic template */}
          {mode === "configure-dynamic" && selectedDynTemplate && (
            <div className="space-y-5 py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                onClick={() => setMode("select-template")}
              >
                <ArrowLeft className="h-4 w-4" />
                {t("destinations.dynamic.backToTemplates")}
              </Button>

              {/* Name */}
              <div className="space-y-1.5">
                <Label>
                  {t("destinations.form.nameLabel")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  placeholder={t("destinations.dynamic.nameExampleWithName", { name: selectedDynTemplate.name })}
                  value={dynName}
                  onChange={(e) => setDynName(e.target.value)}
                />
              </div>

              {/* Secret fields (user fills once) */}
              {selectedDynTemplate.userVisibleFields.map((key) => (
                <div key={key} className="space-y-1.5">
                  <Label>
                    {key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                    <span className="text-destructive"> *</span>
                  </Label>
                  <div className="relative">
                    <Input
                      placeholder={t("destinations.dynamic.secretPlaceholder", {
                        name: selectedDynTemplate.name,
                        key: key.replace(/_/g, " "),
                      })}
                      value={dynSecrets[key] ?? ""}
                      onChange={(e) => setDynSecrets(s => ({ ...s, [key]: e.target.value }))}
                      type={dynShowSecret[key] ? "text" : "password"}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setDynShowSecret(s => ({ ...s, [key]: !s[key] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {dynShowSecret[key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              ))}

              {/* Variable fields info */}
              {selectedDynTemplate.variableFields.length > 0 && (
                <div className="rounded-lg bg-muted/40 border p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3" /> Per-routing fields
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("destinations.dynamic.variableFieldsInfo", {
                      fields: selectedDynTemplate.variableFields.join(", "),
                    })}
                  </p>
                </div>
              )}

              {/* Auto-mapped info */}
              {selectedDynTemplate.autoMappedFields.length > 0 && (
                <div className="rounded-lg bg-muted/40 border p-3 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3" /> {t("destinations.dynamic.autoMappedFromLead")}
                  </p>
                  {selectedDynTemplate.autoMappedFields.map((f) => (
                    <p key={f.key} className="text-xs text-muted-foreground">
                      <code className="bg-background px-1 rounded">{f.key}</code> ← {f.label}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Edit: simplified form for template-based destination */}
          {mode === "edit-dynamic" && (
            <div className="space-y-5 py-2">
              {/* Name */}
              <div className="space-y-1.5">
                <Label>
                  {t("destinations.dynamic.affiliateName")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  placeholder={t("destinations.dynamic.nameExample")}
                  value={dynName}
                  onChange={(e) => setDynName(e.target.value)}
                />
              </div>

              {/* Secret fields — leave blank to keep existing */}
              {editDynSecretKeys.map((key) => (
                <div key={key} className="space-y-1.5">
                  <Label>
                    {key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                    <span className="text-muted-foreground text-xs ml-1">
                      {t("destinations.dynamic.leaveBlankKeep")}
                    </span>
                  </Label>
                  <div className="relative">
                    <Input
                      placeholder={t("destinations.dynamic.unchangedPlaceholder")}
                      value={dynSecrets[key] ?? ""}
                      onChange={(e) => setDynSecrets((s) => ({ ...s, [key]: e.target.value }))}
                      type={dynShowSecret[key] ? "text" : "password"}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setDynShowSecret((s) => ({ ...s, [key]: !s[key] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {dynShowSecret[key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              ))}

              {/* Endpoint info */}
              {editDynUrl && (
                <p className="text-xs text-muted-foreground truncate font-mono">{editDynUrl}</p>
              )}
            </div>
          )}

          {/* Step 2: Configure */}
          {mode === "configure" && (
            <div className="space-y-5 py-2">
              {!editId && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2 h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                  onClick={() => setMode("select-template")}
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t("destinations.dynamic.backToTemplates")}
                </Button>
              )}

              {isCustom ? (
                <div className="flex gap-3 rounded-2xl border border-violet-200/70 bg-gradient-to-br from-violet-500/[0.07] via-background to-fuchsia-500/[0.05] p-3.5 shadow-sm dark:border-violet-900/50 dark:from-violet-950/40 dark:to-background">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-md shadow-violet-500/20">
                    <Braces className="h-5 w-5" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold tracking-tight text-foreground">{t("destinations.custom.title")}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {t("destinations.custom.descPrefix")}{" "}
                      <code className="font-mono text-[11px]">application/x-www-form-urlencoded</code>{" "}
                      {t("destinations.custom.descMid")}{" "}
                      <code className="font-mono text-[11px]">multipart/form-data</code>.{" "}
                      {t("destinations.custom.descSuffix", { placeholder: "{{ }}" })}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2.5 rounded-xl border bg-muted/25 px-3 py-2">
                  <div className={`h-8 w-1 shrink-0 rounded-full ${selectedTemplate.color}`} />
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{selectedTemplate.label}</span>
                    {selectedTemplate.endpoint && (
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{selectedTemplate.endpoint}</p>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  {t("destinations.form.nameLabel")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  className="h-10 rounded-lg shadow-xs"
                  placeholder={t("destinations.form.namePlaceholder", { label: selectedTemplate.label })}
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
                      <span className="text-muted-foreground text-xs ml-1">{t("destinations.dynamic.leaveBlankKeep")}</span>
                    )}
                  </Label>
                  <div className="relative">
                    <Input
                      placeholder={
                        editId && sf.secret ? t("destinations.dynamic.unchangedPlaceholder") : sf.placeholder
                      }
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
                    <Info className="w-3 h-3" /> {t("destinations.legacy.autoMappedFields")}
                  </p>
                  {Object.entries(selectedTemplate.autoMapped).map(([k, v]) => (
                    <p key={k} className="text-xs text-muted-foreground">
                      <code className="bg-background px-1 rounded">{k}</code> ← {v}
                    </p>
                  ))}
                </div>
              )}

              {isCustom && (
                <div className="space-y-6 rounded-2xl border border-border/60 bg-card/40 p-4 shadow-sm ring-1 ring-black/[0.02] dark:bg-card/20 dark:ring-white/[0.04] sm:p-5">
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">
                      Endpoint URL <span className="text-destructive">*</span>
                    </Label>
                    <div className="relative">
                      <Link2
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden
                      />
                      <Input
                        className="h-10 rounded-lg pl-9 font-mono text-sm shadow-xs"
                        placeholder={t("destinations.form.urlPlaceholder")}
                        value={form.url}
                        onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                      />
                    </div>
                  </div>

                  <div className="grid gap-3 rounded-xl border border-border/80 bg-muted/15 p-3 sm:grid-cols-2 sm:gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t("destinations.form.method")}
                      </Label>
                      <div className="flex h-10 items-center rounded-lg border border-dashed border-muted-foreground/25 bg-background/80 px-3 font-mono text-xs font-semibold tracking-wide text-muted-foreground">
                        POST
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {t("destinations.form.contentType")}
                      </Label>
                      <Select
                        value={form.contentType}
                        onValueChange={(v) => setForm((f) => ({ ...f, contentType: v as ContentType }))}
                      >
                        <SelectTrigger className="h-10 w-full rounded-lg shadow-xs">
                          <SelectValue placeholder={t("destinations.form.formatPlaceholder")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="json">application/json</SelectItem>
                          <SelectItem value="form-urlencoded">application/x-www-form-urlencoded</SelectItem>
                          <SelectItem value="multipart">multipart/form-data</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="rounded-xl border border-primary/15 bg-gradient-to-b from-primary/[0.06] to-muted/15 p-4 dark:from-primary/10 dark:to-muted/10">
                    <div className="mb-3 flex gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background/90 shadow-sm ring-1 ring-border/60">
                        <Sparkles className="h-4 w-4 text-violet-600 dark:text-violet-400" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{t("destinations.form.templateVarsTitle")}</p>
                        <p className="text-xs leading-snug text-muted-foreground">
                          {t("destinations.form.templateVarsSubtitle")}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {BUILTIN_VARS.map((v) => (
                        <button
                          key={v.key}
                          type="button"
                          title={v.desc}
                          className="inline-flex items-center gap-1 rounded-full border border-border/90 bg-background px-3 py-1.5 font-mono text-[11px] font-medium shadow-sm transition hover:border-primary/35 hover:bg-primary/5 hover:shadow-md active:scale-[0.98]"
                          onClick={() => {
                            void navigator.clipboard.writeText(v.key);
                            toast.success(t("destinations.toast.copiedKey", { key: v.key }));
                          }}
                        >
                          {v.key}
                          <Copy className="h-3 w-3 opacity-50" aria-hidden />
                        </button>
                      ))}
                      <span className="inline-flex items-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                        {"{{any_field}}"}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Braces className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      <Label className="text-sm font-medium">
                        {form.contentType === "json"
                          ? t("destinations.form.bodyJson")
                          : t("destinations.form.bodyFields")}
                      </Label>
                    </div>

                    {form.contentType === "json" ? (
                      <div className="space-y-1.5">
                        <Textarea
                          className="min-h-[160px] resize-y rounded-lg border-border/80 font-mono text-xs leading-relaxed shadow-xs"
                          placeholder={DEFAULT_JSON_TEMPLATE}
                          value={form.bodyTemplate}
                          onChange={(e) => setForm((f) => ({ ...f, bodyTemplate: e.target.value }))}
                        />
                        <p className="text-xs text-muted-foreground">
                          {t("destinations.form.bodyHintPrefix")}{" "}
                          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{"{{variable}}"}</code>{" "}
                          {t("destinations.form.bodyHintSuffix")}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2 rounded-lg border border-border/60 bg-background/50 p-2">
                        {form.bodyFields.map((bf, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <Input
                              placeholder={t("destinations.form.keyPlaceholder")}
                              value={bf.key}
                              className="h-9 w-28 rounded-md font-mono text-xs sm:w-32"
                              onChange={(e) => {
                                const fs = [...form.bodyFields];
                                fs[i] = { ...fs[i], key: e.target.value };
                                setForm((f) => ({ ...f, bodyFields: fs }));
                              }}
                            />
                            <span className="shrink-0 text-xs text-muted-foreground">→</span>
                            <Input
                              placeholder={t("destinations.form.valuePlaceholder")}
                              value={bf.value}
                              className="h-9 min-w-0 flex-1 rounded-md font-mono text-xs"
                              onChange={(e) => {
                                const fs = [...form.bodyFields];
                                fs[i] = { ...fs[i], value: e.target.value };
                                setForm((f) => ({ ...f, bodyFields: fs }));
                              }}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() =>
                                setForm((f) => ({ ...f, bodyFields: f.bodyFields.filter((_, j) => j !== i) }))
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-1 h-8 text-xs"
                          onClick={() => setForm((f) => ({ ...f, bodyFields: [...f.bodyFields, { key: "", value: "" }] }))}
                        >
                          <Plus className="mr-1 h-3 w-3" /> {t("destinations.form.addField")}
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className="rounded-xl border border-border/70 bg-muted/10 p-3.5 shadow-xs">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Layers className="h-4 w-4 text-muted-foreground" aria-hidden />
                        <Label className="text-sm font-medium">
                          {t("destinations.form.headers")}{" "}
                          <span className="text-xs font-normal text-muted-foreground">
                            {t("destinations.form.optional")}
                          </span>
                        </Label>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-8 shrink-0 text-xs"
                        onClick={() => setForm((f) => ({ ...f, customHeaders: [...f.customHeaders, { key: "", value: "" }] }))}
                      >
                        <Plus className="mr-1 h-3 w-3" /> {t("destinations.form.headersAdd")}
                      </Button>
                    </div>
                    {form.customHeaders.length === 0 && (
                      <p className="text-xs italic text-muted-foreground">
                        {t("destinations.form.headersEmptyHint")}
                      </p>
                    )}
                    <div className="space-y-2 pt-1">
                      {form.customHeaders.map((h, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <Input
                            placeholder={t("destinations.form.headerNamePlaceholder")}
                            value={h.key}
                            className="h-9 w-36 rounded-md text-xs sm:w-44"
                            onChange={(e) => {
                              const hs = [...form.customHeaders];
                              hs[i] = { ...hs[i], key: e.target.value };
                              setForm((f) => ({ ...f, customHeaders: hs }));
                            }}
                          />
                          <span className="shrink-0 text-muted-foreground">:</span>
                          <Input
                            placeholder={t("destinations.form.headerValuePlaceholder")}
                            value={h.value}
                            className="h-9 min-w-0 flex-1 rounded-md font-mono text-xs"
                            onChange={(e) => {
                              const hs = [...form.customHeaders];
                              hs[i] = { ...hs[i], value: e.target.value };
                              setForm((f) => ({ ...f, customHeaders: hs }));
                            }}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                            onClick={() =>
                              setForm((f) => ({ ...f, customHeaders: f.customHeaders.filter((_, j) => j !== i) }))
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <TagInput
                    label={t("destinations.form.variableFieldsLabel")}
                    hint={t("destinations.form.variableFieldsHint")}
                    values={form.customVariableFields}
                    onChange={(vals) => setForm((f) => ({ ...f, customVariableFields: vals }))}
                    placeholder={t("destinations.form.variableFieldsPlaceholder")}
                  />

                  <div className="space-y-2 rounded-xl border border-border/70 bg-muted/10 p-3.5">
                    <Label className="text-sm font-medium">{t("destinations.form.successCondition")}</Label>
                    <Select
                      value={form.successCondition}
                      onValueChange={(v) =>
                        setForm((f) => ({ ...f, successCondition: v as "http_2xx" | "json_field" }))
                      }
                    >
                      <SelectTrigger className="h-10 w-full rounded-lg shadow-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="http_2xx">{t("destinations.form.successHttp2xx")}</SelectItem>
                        <SelectItem value="json_field">{t("destinations.form.successJsonField")}</SelectItem>
                      </SelectContent>
                    </Select>
                    {form.successCondition === "json_field" && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Input
                          placeholder={t("destinations.form.jsonFieldPlaceholder")}
                          value={form.jsonField}
                          className="h-9 min-w-[8rem] flex-1 rounded-md font-mono text-xs"
                          onChange={(e) => setForm((f) => ({ ...f, jsonField: e.target.value }))}
                        />
                        <span className="text-xs font-medium text-muted-foreground">=</span>
                        <Input
                          placeholder={t("destinations.form.jsonValuePlaceholder")}
                          value={form.jsonValue}
                          className="h-9 min-w-[8rem] flex-1 rounded-md font-mono text-xs"
                          onChange={(e) => setForm((f) => ({ ...f, jsonValue: e.target.value }))}
                        />
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 border-t border-border/50 pt-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        onClick={handleTest}
                        disabled={isTesting || !editId}
                        className="h-9 gap-2"
                        title={!editId ? t("destinations.form.testSaveFirstTitle") : undefined}
                      >
                        {isTesting ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <FlaskConical className="h-4 w-4" />
                        )}
                        {isTesting ? t("destinations.form.testing") : t("destinations.form.testIntegration")}
                      </Button>
                      <p className="text-xs text-muted-foreground sm:pl-1">
                        {editId
                          ? t("destinations.form.testDescReady")
                          : t("destinations.form.testDescLocked")}
                      </p>
                    </div>
                    {testResult && editId ? (
                      <TestResultPanel result={testResult} onClose={() => setTestResult(null)} />
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          )}
      </WebsiteFlowDialog>
    </DashboardLayout>
  );
}
