import { useState } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Plus, Play, Trash2, History, ChevronRight, Loader2, CheckCircle2,
  XCircle, Clock, Globe, Send, Variable, GitBranch, Layers, Pencil,
  ArrowUp, ArrowDown, LayoutTemplate,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type StepType = "http_request" | "telegram" | "set_variable" | "condition";

const STEP_META: Record<StepType, { label: string; icon: React.ElementType; color: string; desc: string }> = {
  http_request: { label: "HTTP Request", icon: Globe,      color: "bg-blue-100 text-blue-700",    desc: "Tashqi API ga so'rov yuborish" },
  telegram:     { label: "Telegram",     icon: Send,       color: "bg-sky-100 text-sky-700",      desc: "Telegram xabari yuborish" },
  set_variable: { label: "O'zgaruvchi",  icon: Variable,   color: "bg-amber-100 text-amber-700",  desc: "Keyingi steplarda ishlatish uchun qiymat saqlash" },
  condition:    { label: "Shart (IF)",   icon: GitBranch,  color: "bg-violet-100 text-violet-700", desc: "Shart bajarilmasa to'xtatish" },
};

const EXEC_STATUS = {
  running: { label: "Ishlayapti", cls: "bg-blue-100 text-blue-700" },
  success: { label: "Muvaffaqiyatli", cls: "bg-emerald-100 text-emerald-700" },
  failed:  { label: "Xato",      cls: "bg-red-100 text-red-700" },
  cancelled: { label: "Bekor",   cls: "bg-slate-100 text-slate-600" },
  skipped:   { label: "O'tkazildi", cls: "bg-slate-100 text-slate-500" },
};

const TEMPLATE_HINTS = [
  "{{trigger.phone}}", "{{trigger.email}}", "{{trigger.fullName}}",
  "{{steps.0.output.body.id}}", "{{steps.0.output.status}}", "{{vars.myVar}}",
];

// ─── Step config forms ────────────────────────────────────────────────────────

function HttpRequestForm({ config, onChange }: { config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">URL <span className="text-muted-foreground">({"{{template}}"} ishlaydi)</span></Label>
        <Input className="text-xs font-mono" placeholder="https://api.example.com/leads" value={String(config.url ?? "")} onChange={e => onChange({ ...config, url: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Method</Label>
          <Select value={String(config.method ?? "POST")} onValueChange={v => onChange({ ...config, method: v })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {["GET","POST","PUT","PATCH","DELETE"].map(m => <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Timeout (ms)</Label>
          <Input type="number" className="text-xs h-8" placeholder="10000" value={String(config.timeout ?? 10000)} onChange={e => onChange({ ...config, timeout: Number(e.target.value) })} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Body (JSON yoki {"{{template}}"})</Label>
        <Textarea className="text-xs font-mono resize-none" rows={4} placeholder={'{"phone": "{{trigger.phone}}", "name": "{{trigger.fullName}}"}'} value={String(config.body ?? "")} onChange={e => onChange({ ...config, body: e.target.value })} />
      </div>
    </div>
  );
}

function TelegramForm({ config, onChange }: { config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Chat ID</Label>
        <Input className="text-xs" placeholder="-1001234567890 yoki @channel" value={String(config.chatId ?? "")} onChange={e => onChange({ ...config, chatId: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Xabar <span className="text-muted-foreground">({"{{template}}"} ishlaydi)</span></Label>
        <Textarea className="text-xs resize-none" rows={4} placeholder={"Yangi lid: {{trigger.fullName}}\nTelefon: {{trigger.phone}}\nCRM ID: {{steps.0.output.body.id}}"} value={String(config.message ?? "")} onChange={e => onChange({ ...config, message: e.target.value })} />
      </div>
    </div>
  );
}

function SetVariableForm({ config, onChange }: { config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">O'zgaruvchi nomi</Label>
        <Input className="text-xs font-mono" placeholder="crmId" value={String(config.key ?? "")} onChange={e => onChange({ ...config, key: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Qiymat <span className="text-muted-foreground">({"{{template}}"} ishlaydi)</span></Label>
        <Input className="text-xs font-mono" placeholder="{{steps.0.output.body.id}}" value={String(config.value ?? "")} onChange={e => onChange({ ...config, value: e.target.value })} />
        <p className="text-[10px] text-muted-foreground">Keyingi steplarda: <code className="bg-muted px-1 rounded">{"{{vars.crmId}}"}</code></p>
      </div>
    </div>
  );
}

function ConditionForm({ config, onChange }: { config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void }) {
  const operators = ["eq","neq","contains","starts_with","ends_with","exists","not_exists","gt","gte","lt","lte"];
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Maydon ({"{{template}}"} yoki qiymat)</Label>
        <Input className="text-xs font-mono" placeholder="{{steps.0.output.status}}" value={String(config.field ?? "")} onChange={e => onChange({ ...config, field: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Operator</Label>
          <Select value={String(config.operator ?? "eq")} onValueChange={v => onChange({ ...config, operator: v })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>{operators.map(o => <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Qiymat</Label>
          <Input className="text-xs" placeholder="200" value={String(config.value ?? "")} onChange={e => onChange({ ...config, value: e.target.value })} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Shart bajarilmasa</Label>
        <Select value={String(config.onFail ?? "stop")} onValueChange={v => onChange({ ...config, onFail: v })}>
          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="stop" className="text-xs">Workflowni to'xtatish</SelectItem>
            <SelectItem value="continue" className="text-xs">Davom etish</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function StepConfigForm({ type, config, onChange }: { type: StepType; config: Record<string, unknown>; onChange: (c: Record<string, unknown>) => void }) {
  switch (type) {
    case "http_request":  return <HttpRequestForm config={config} onChange={onChange} />;
    case "telegram":      return <TelegramForm config={config} onChange={onChange} />;
    case "set_variable":  return <SetVariableForm config={config} onChange={onChange} />;
    case "condition":     return <ConditionForm config={config} onChange={onChange} />;
  }
}

// ─── Step editor dialog ───────────────────────────────────────────────────────

interface StepDraft {
  id?: number;
  type: StepType;
  name: string;
  config: Record<string, unknown>;
  continueOnError: boolean;
  position: number;
}

function StepEditorDialog({
  open,
  initial,
  onSave,
  onClose,
}: {
  open: boolean;
  initial?: StepDraft;
  onSave: (s: StepDraft) => void;
  onClose: () => void;
}) {
  const [type, setType]   = useState<StepType>(initial?.type ?? "http_request");
  const [name, setName]   = useState(initial?.name ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(initial?.config ?? {});
  const [coe, setCoe]     = useState(initial?.continueOnError ?? false);

  function handleSave() {
    if (!name.trim()) { toast.error("Nom kiriting"); return; }
    onSave({ ...initial, type, name: name.trim(), config, continueOnError: coe, position: initial?.position ?? 0 });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial?.id ? "Stepni tahrirlash" : "Yangi step"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          {/* Type selector */}
          {!initial?.id && (
            <div className="space-y-1.5">
              <Label className="text-xs">Step turi</Label>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(STEP_META) as StepType[]).map(t => {
                  const m = STEP_META[t];
                  return (
                    <button key={t} type="button" onClick={() => { setType(t); setConfig({}); }}
                      className={cn("flex items-start gap-2 rounded-lg border p-2.5 text-left text-xs transition-colors",
                        type === t ? "border-primary bg-primary/5" : "hover:bg-muted/40")}>
                      <m.icon className={cn("h-4 w-4 shrink-0 mt-0.5", m.color.split(" ").find(c => c.startsWith("text-")))} />
                      <div><p className="font-medium">{m.label}</p><p className="text-muted-foreground text-[10px] mt-0.5">{m.desc}</p></div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="step-name" className="text-xs">Step nomi</Label>
            <Input id="step-name" className="text-xs" placeholder="CRM ga yozish" value={name} onChange={e => setName(e.target.value)} autoFocus={!!initial?.id} />
          </div>

          <StepConfigForm type={type} config={config} onChange={setConfig} />

          {/* Template hints */}
          <div className="space-y-1.5">
            <p className="text-[10px] text-muted-foreground font-medium">Mavjud o'zgaruvchilar:</p>
            <div className="flex flex-wrap gap-1">
              {TEMPLATE_HINTS.map(h => (
                <button key={h} type="button" onClick={() => navigator.clipboard.writeText(h)}
                  className="font-mono text-[10px] bg-muted/60 hover:bg-muted px-1.5 py-0.5 rounded border transition-colors">
                  {h}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Switch id="coe" checked={coe} onCheckedChange={setCoe} />
            <Label htmlFor="coe" className="text-xs text-muted-foreground cursor-pointer">Xato bo'lsa ham davom etish</Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Bekor</Button>
          <Button onClick={handleSave}>Saqlash</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Execution detail sheet ───────────────────────────────────────────────────

function ExecutionDetailSheet({ executionId, onClose }: { executionId: number; onClose: () => void }) {
  const { data, isLoading } = trpc.workflows.executionDetail.useQuery({ executionId }, { enabled: true });

  return (
    <Sheet open onOpenChange={v => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-muted-foreground" />
            Execution #{executionId}
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {isLoading ? <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          : !data ? <p className="text-sm text-muted-foreground text-center py-8">Topilmadi</p>
          : (
            <>
              <div className="flex items-center gap-2">
                <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", EXEC_STATUS[data.status as keyof typeof EXEC_STATUS]?.cls)}>
                  {EXEC_STATUS[data.status as keyof typeof EXEC_STATUS]?.label ?? data.status}
                </span>
                <span className="text-xs text-muted-foreground">{new Date(data.startedAt).toLocaleString("uz-UZ")}</span>
                {data.completedAt && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    {Math.round((new Date(data.completedAt).getTime() - new Date(data.startedAt).getTime()) / 1000)}s
                  </span>
                )}
              </div>
              {data.error && <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{data.error}</div>}

              <div className="space-y-2">
                {data.steps.map((s, i) => {
                  const st = EXEC_STATUS[s.status as keyof typeof EXEC_STATUS];
                  return (
                    <div key={s.id} className="rounded-lg border bg-muted/10 p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground w-5">{i + 1}</span>
                        <span className="text-sm font-medium flex-1">{(s as unknown as Record<string, unknown>).name as string ?? `Step ${i+1}`}</span>
                        <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", st?.cls)}>{st?.label ?? s.status}</span>
                        {s.durationMs != null && <span className="text-[10px] text-muted-foreground">{s.durationMs}ms</span>}
                      </div>
                      {s.error && <p className="text-xs text-red-500 ml-5">{s.error}</p>}
                      {s.outputJson != null && (
                        <pre className="text-[10px] font-mono bg-muted/40 rounded p-2 overflow-x-auto max-h-32 ml-5">
                          {JSON.stringify(s.outputJson, null, 2)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Workflow card ────────────────────────────────────────────────────────────

function WorkflowCard({
  wf,
  onRun,
  onEdit,
  onDelete,
  onHistory,
  onCanvas,
}: {
  wf: { id: number; name: string; isActive: boolean; stepCount: number; lastRunAt: Date | null; lastStatus: string | null };
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onHistory: () => void;
  onCanvas: () => void;
}) {
  const lastSt = wf.lastStatus as keyof typeof EXEC_STATUS | null;
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3 rounded-lg border bg-card hover:bg-muted/20 transition-colors", !wf.isActive && "opacity-60")}>
      <div className="h-9 w-9 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center shrink-0">
        <Layers className="h-4 w-4 text-violet-600 dark:text-violet-400" />
      </div>

      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{wf.name}</span>
          {!wf.isActive && <Badge variant="outline" className="text-[10px] px-1.5 py-0">Nofaol</Badge>}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{wf.stepCount} step</span>
          {wf.lastRunAt && (
            <>
              <span>·</span>
              <Clock className="h-3 w-3" />
              <span>{new Date(wf.lastRunAt).toLocaleDateString("uz-UZ")}</span>
            </>
          )}
          {lastSt && EXEC_STATUS[lastSt] && (
            <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", EXEC_STATUS[lastSt].cls)}>
              {EXEC_STATUS[lastSt].label}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="outline" className="h-8 px-2.5 text-xs" onClick={onHistory} title="Tarix">
          <History className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="outline" className="h-8 px-2.5 text-xs" onClick={onEdit} title="Tahrirlash">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="outline" className="h-8 px-2.5 text-xs text-violet-600 border-violet-200 hover:bg-violet-50" onClick={onCanvas} title="Canvas Editor">
          <LayoutTemplate className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" className="h-8 px-2.5 text-xs bg-violet-600 hover:bg-violet-700" onClick={onRun} title="Ishlatish">
          <Play className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ─── Workflow builder sheet ───────────────────────────────────────────────────

type WfFormMode = "create" | "edit";

function WorkflowBuilderSheet({
  open, onClose, editId,
}: { open: boolean; onClose: () => void; editId?: number }) {
  const utils = trpc.useUtils();
  const mode: WfFormMode = editId ? "edit" : "create";

  const { data: existing } = trpc.workflows.get.useQuery({ id: editId! }, { enabled: !!editId });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [triggerId, setTriggerId] = useState<string>("none");
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [stepEditorOpen, setStepEditorOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<StepDraft | undefined>();

  const { data: triggers } = trpc.triggers.list.useQuery();

  // Load existing data into form
  const [loaded, setLoaded] = useState(false);
  if (existing && !loaded) {
    setName(existing.name);
    setDescription(existing.description ?? "");
    setIsActive(existing.isActive);
    setTriggerId(existing.triggerId ? String(existing.triggerId) : "none");
    setSteps(existing.steps.map(s => ({
      id: s.id, type: s.type as StepType, name: s.name,
      config: s.config as Record<string, unknown>,
      continueOnError: s.continueOnError,
      position: s.position,
    })));
    setLoaded(true);
  }

  const create = trpc.workflows.create.useMutation({
    onSuccess: () => { toast.success("Workflow yaratildi"); void utils.workflows.list.invalidate(); onClose(); },
    onError: e => toast.error(e.message),
  });
  const update = trpc.workflows.update.useMutation({
    onSuccess: () => { toast.success("Saqlandi"); void utils.workflows.list.invalidate(); onClose(); },
    onError: e => toast.error(e.message),
  });

  const isPending = create.isPending || update.isPending;

  function addStep(s: StepDraft) {
    setSteps(prev => [...prev, { ...s, position: prev.length }]);
  }

  function updateStep(idx: number, s: StepDraft) {
    setSteps(prev => prev.map((old, i) => i === idx ? { ...s, position: idx } : old));
  }

  function removeStep(idx: number) {
    setSteps(prev => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, position: i })));
  }

  function moveStep(idx: number, dir: -1 | 1) {
    setSteps(prev => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next.map((s, i) => ({ ...s, position: i }));
    });
  }

  function handleSubmit() {
    if (!name.trim()) { toast.error("Nom kiriting"); return; }
    const payload = {
      name: name.trim(),
      description: description.trim() || undefined,
      isActive,
      triggerId: triggerId && triggerId !== "none" ? Number(triggerId) : undefined,
      steps: steps.map(s => ({
        type: s.type, name: s.name, config: s.config,
        continueOnError: s.continueOnError, position: s.position,
      })),
    };
    if (mode === "edit" && editId) {
      update.mutate({ id: editId, ...payload });
    } else {
      create.mutate(payload);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={v => !v && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col gap-0 p-0">
          <SheetHeader className="px-6 py-4 border-b">
            <SheetTitle className="text-base">{mode === "edit" ? "Workflowni tahrirlash" : "Yangi Workflow"}</SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
            {/* Basic info */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Nomi</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Lead → CRM → Telegram" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Tavsif (ixtiyoriy)</Label>
                <Textarea className="resize-none text-xs" rows={2} value={description} onChange={e => setDescription(e.target.value)} placeholder="Bu workflow nima qiladi..." />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Trigger (ixtiyoriy)</Label>
                  <Select value={triggerId} onValueChange={setTriggerId}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Tanlash..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none" className="text-xs">— Trigger yo'q —</SelectItem>
                      {triggers?.map(t => (
                        <SelectItem key={t.id} value={String(t.id)} className="text-xs">{t.name} ({t.type})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 pt-5">
                  <Switch checked={isActive} onCheckedChange={setIsActive} />
                  <Label className="text-xs">Faol</Label>
                </div>
              </div>
            </div>

            {/* Steps */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Steplar</Label>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setEditingStep(undefined); setStepEditorOpen(true); }}>
                  <Plus className="h-3.5 w-3.5 mr-1" />Step qo'shish
                </Button>
              </div>

              {steps.length === 0 ? (
                <div className="rounded-lg border border-dashed bg-muted/10 py-8 text-center space-y-2">
                  <Layers className="h-8 w-8 text-muted-foreground/30 mx-auto" />
                  <p className="text-xs text-muted-foreground">Hali step yo'q — yuqoridagi tugmani bosing</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {steps.map((s, i) => {
                    const m = STEP_META[s.type];
                    return (
                      <div key={i} className="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
                        <span className="text-xs font-mono text-muted-foreground w-4 text-center">{i + 1}</span>
                        <div className={cn("h-6 w-6 rounded flex items-center justify-center shrink-0", m.color)}>
                          <m.icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{s.name}</p>
                          <p className="text-[10px] text-muted-foreground">{m.label}</p>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0} className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted disabled:opacity-30">
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button type="button" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted disabled:opacity-30">
                            <ArrowDown className="h-3 w-3" />
                          </button>
                          <button type="button" onClick={() => { setEditingStep({ ...s, id: undefined }); setStepEditorOpen(true); }} className="h-6 w-6 flex items-center justify-center rounded hover:bg-muted text-muted-foreground">
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button type="button" onClick={() => removeStep(i)} className="h-6 w-6 flex items-center justify-center rounded hover:bg-red-50 text-muted-foreground hover:text-red-500">
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="px-6 py-4 border-t flex gap-2">
            <Button variant="outline" onClick={onClose} className="flex-1">Bekor</Button>
            <Button className="flex-1" onClick={handleSubmit} disabled={isPending}>
              {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === "edit" ? "Saqlash" : "Yaratish"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <StepEditorDialog
        open={stepEditorOpen}
        initial={editingStep}
        onSave={(s) => {
          const existIdx = editingStep ? steps.findIndex(st => st.name === editingStep.name && st.position === editingStep.position) : -1;
          if (existIdx >= 0) updateStep(existIdx, s);
          else addStep(s);
        }}
        onClose={() => setStepEditorOpen(false)}
      />
    </>
  );
}

// ─── History sheet ────────────────────────────────────────────────────────────

function HistorySheet({ workflowId, onClose }: { workflowId: number; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const [, setLocation] = useLocation();
  const { data } = trpc.workflows.executions.useQuery({ workflowId, limit: 20, offset: page * 20 });

  return (
    <Sheet open onOpenChange={v => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="flex items-center gap-2 text-sm">
            <History className="h-4 w-4 text-muted-foreground" /> Execution tarixi
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto divide-y">
          {!data || data.items.length === 0 ? (
            <p className="text-center py-10 text-sm text-muted-foreground">Hali ishlatilmagan</p>
          ) : data.items.map(e => {
            const st = EXEC_STATUS[e.status as keyof typeof EXEC_STATUS];
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  onClose();
                  setLocation(`/workflows/${workflowId}/executions/${e.id}`);
                }}
                className="w-full flex items-center gap-3 px-6 py-3 hover:bg-muted/30 transition-colors text-left"
              >
                <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0", st?.cls)}>
                  {st?.label ?? e.status}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">{new Date(e.startedAt).toLocaleString("uz-UZ")}</p>
                  {e.error && <p className="text-xs text-red-500 truncate">{e.error}</p>}
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </button>
            );
          })}
        </div>
        {data && data.total > 20 && (
          <div className="px-6 py-3 border-t flex items-center justify-between">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Oldingi</Button>
            <span className="text-xs text-muted-foreground">{page + 1}/{Math.ceil(data.total / 20)}</span>
            <Button size="sm" variant="outline" disabled={(page + 1) * 20 >= data.total} onClick={() => setPage(p => p + 1)}>Keyingi</Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Run result dialog ────────────────────────────────────────────────────────

function RunResultDialog({ result, onClose }: {
  result: { executionId: number; status: string; stepResults: Array<{ stepId: number; name: string; status: string; durationMs: number | null; error?: string }>; error?: string };
  onClose: () => void;
}) {
  const ok = result.status === "success";
  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {ok ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <XCircle className="h-5 w-5 text-red-500" />}
            {ok ? "Workflow muvaffaqiyatli" : "Workflow xato bilan tugadi"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2 py-1">
          {result.stepResults.map((s, i) => {
            const st = EXEC_STATUS[s.status as keyof typeof EXEC_STATUS];
            return (
              <div key={s.stepId} className="flex items-center gap-2 text-sm">
                <span className="text-xs font-mono text-muted-foreground w-4">{i + 1}</span>
                <span className="flex-1 truncate">{s.name}</span>
                <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", st?.cls)}>{st?.label ?? s.status}</span>
                {s.durationMs != null && <span className="text-[10px] text-muted-foreground">{s.durationMs}ms</span>}
              </div>
            );
          })}
          {result.error && <p className="text-xs text-red-500 mt-2">{result.error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Yopish</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Workflows() {
  const utils = trpc.useUtils();
  const [, setLocation] = useLocation();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editId, setEditId] = useState<number | undefined>();
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [runResult, setRunResult] = useState<Parameters<typeof RunResultDialog>[0]["result"] | null>(null);
  const [runningId, setRunningId] = useState<number | null>(null);

  const { data: list, isLoading } = trpc.workflows.list.useQuery();

  const deleteMutation = trpc.workflows.delete.useMutation({
    onSuccess: () => { toast.success("O'chirildi"); void utils.workflows.list.invalidate(); },
    onError: e => toast.error(e.message),
  });

  const runMutation = trpc.workflows.run.useMutation({
    onSuccess: (data, vars) => {
      setRunningId(null);
      setRunResult(data);
      void utils.workflows.list.invalidate();
    },
    onError: (e) => { setRunningId(null); toast.error(e.message); },
  });

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Workflowlar</h1>
            <p className="text-sm text-muted-foreground mt-0.5">Ketma-ket step-by-step avtomatlashtirish</p>
          </div>
          <Button onClick={() => { setEditId(undefined); setBuilderOpen(true); }}>
            <Plus className="mr-2 h-4 w-4" />Yangi workflow
          </Button>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Barcha workflowlar ({list?.length ?? 0})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {isLoading ? (
              <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : !list || list.length === 0 ? (
              <div className="text-center py-12 space-y-3">
                <Layers className="h-10 w-10 text-muted-foreground/30 mx-auto" />
                <p className="text-sm text-muted-foreground">Hali workflow yo'q</p>
                <Button variant="outline" size="sm" onClick={() => setBuilderOpen(true)}>
                  <Plus className="mr-2 h-3.5 w-3.5" />Birinchi workflowni yarating
                </Button>
              </div>
            ) : (
              list.map(wf => (
                <WorkflowCard
                  key={wf.id}
                  wf={wf as Parameters<typeof WorkflowCard>[0]["wf"]}
                  onRun={() => {
                    setRunningId(wf.id);
                    runMutation.mutate({ id: wf.id, triggerData: {} });
                  }}
                  onEdit={() => { setEditId(wf.id); setBuilderOpen(true); }}
                  onDelete={() => setDeleteId(wf.id)}
                  onHistory={() => setHistoryId(wf.id)}
                  onCanvas={() => setLocation(`/workflows/${wf.id}/canvas`)}
                />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {builderOpen && (
        <WorkflowBuilderSheet
          open={builderOpen}
          onClose={() => { setBuilderOpen(false); setEditId(undefined); }}
          editId={editId}
        />
      )}

      {historyId !== null && <HistorySheet workflowId={historyId} onClose={() => setHistoryId(null)} />}

      {runResult && <RunResultDialog result={runResult} onClose={() => setRunResult(null)} />}

      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Workflow o'chirilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>Barcha execution tarixi ham o'chadi.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteId && deleteMutation.mutate({ id: deleteId })}>
              O'chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardLayout>
  );
}
