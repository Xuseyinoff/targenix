import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  ArrowLeft, RotateCcw, Loader2, CheckCircle2, XCircle, Clock,
  Globe, Send, Variable, GitBranch, Zap, Copy, ChevronDown, ChevronRight,
  AlertTriangle, Timer, Hash,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Status meta ──────────────────────────────────────────────────────────────

const STATUS_META = {
  running:   { label: "Ishlayapti", cls: "bg-blue-100 text-blue-700",      icon: Loader2 },
  success:   { label: "Muvaffaqiyatli", cls: "bg-emerald-100 text-emerald-700", icon: CheckCircle2 },
  failed:    { label: "Xato",      cls: "bg-red-100 text-red-700",          icon: XCircle },
  cancelled: { label: "Bekor",     cls: "bg-slate-100 text-slate-600",      icon: XCircle },
  skipped:   { label: "O'tkazildi", cls: "bg-slate-100 text-slate-500",     icon: ChevronRight },
} as const;

const STEP_ICONS: Record<string, React.ElementType> = {
  http_request: Globe,
  telegram:     Send,
  set_variable: Variable,
  condition:    GitBranch,
};

// ─── JSON viewer ──────────────────────────────────────────────────────────────

function JsonNode({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null || value === undefined)
    return <span className="text-slate-400">{value === null ? "null" : "undefined"}</span>;
  if (typeof value === "boolean")
    return <span className="text-violet-500">{String(value)}</span>;
  if (typeof value === "number")
    return <span className="text-amber-600">{value}</span>;
  if (typeof value === "string") {
    const truncated = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    return <span className="text-emerald-600 break-all">"{truncated}"</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-slate-400">[]</span>;
    return (
      <span>
        <button
          onClick={() => setOpen(o => !o)}
          className="text-slate-500 hover:text-foreground font-mono text-xs underline-offset-2 hover:underline"
        >
          {open ? "[" : `[… ${value.length} item${value.length > 1 ? "s" : ""}]`}
        </button>
        {open && (
          <>
            {value.map((item, i) => (
              <div key={i} style={{ paddingLeft: 16 }}>
                <JsonNode value={item} depth={depth + 1} />
                {i < value.length - 1 && <span className="text-slate-400">,</span>}
              </div>
            ))}
            <span className="text-slate-400">]</span>
          </>
        )}
      </span>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-slate-400">{"{}"}</span>;
    return (
      <span>
        <button
          onClick={() => setOpen(o => !o)}
          className="text-slate-500 hover:text-foreground font-mono text-xs underline-offset-2 hover:underline"
        >
          {open ? "{" : `{… ${entries.length} key${entries.length > 1 ? "s" : ""}}`}
        </button>
        {open && (
          <>
            {entries.map(([k, v], i) => (
              <div key={k} style={{ paddingLeft: 16 }}>
                <span className="text-blue-500">"{k}"</span>
                <span className="text-slate-400">: </span>
                <JsonNode value={v} depth={depth + 1} />
                {i < entries.length - 1 && <span className="text-slate-400">,</span>}
              </div>
            ))}
            <span className="text-slate-400">{"}"}</span>
          </>
        )}
      </span>
    );
  }
  return <span className="text-slate-600">{String(value)}</span>;
}

function JsonViewer({ data, label }: { data: unknown; label: string }) {
  function copy() {
    try {
      void navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      toast.success("Copied!");
    } catch {
      /* ignore */
    }
  }
  return (
    <div className="rounded-lg border bg-muted/20 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/30">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
        <button onClick={copy} className="text-muted-foreground hover:text-foreground transition-colors">
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="px-3 py-2.5 font-mono text-xs leading-relaxed overflow-x-auto">
        {data == null
          ? <span className="text-slate-400 italic">— bo'sh —</span>
          : <JsonNode value={data} depth={0} />
        }
      </div>
    </div>
  );
}

// ─── Duration bar ─────────────────────────────────────────────────────────────

function DurationBar({ ms, maxMs, status }: { ms: number | null; maxMs: number; status: string }) {
  const pct = ms != null && maxMs > 0 ? Math.max(2, (ms / maxMs) * 100) : 0;
  const barCls = status === "success" ? "bg-emerald-400"
    : status === "failed" ? "bg-red-400"
    : status === "skipped" ? "bg-slate-200"
    : "bg-blue-400";
  return (
    <div className="flex items-center gap-2 mt-1.5">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", barCls)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground w-14 text-right shrink-0">
        {ms != null ? `${ms}ms` : "—"}
      </span>
    </div>
  );
}

// ─── Step card ────────────────────────────────────────────────────────────────

type StepExec = {
  id: number;
  position: number;
  status: string;
  inputJson: unknown;
  outputJson: unknown;
  error: string | null;
  durationMs: number | null;
  executedAt: Date;
  stepName: string | null;
  stepType: string | null;
};

function StepCard({
  step, maxMs, selected, onClick,
}: {
  step: StepExec;
  maxMs: number;
  selected: boolean;
  onClick: () => void;
}) {
  const meta = STATUS_META[step.status as keyof typeof STATUS_META] ?? STATUS_META.skipped;
  const StepIcon = STEP_ICONS[step.stepType ?? ""] ?? Zap;
  const StatusIcon = meta.icon;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left px-4 py-3 border-b transition-colors",
        selected ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/30",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-7 w-7 rounded-lg bg-muted shrink-0">
          <StepIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium truncate">
              {step.stepName ?? `Step ${step.position + 1}`}
            </span>
            <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0", meta.cls)}>
              {meta.label}
            </span>
          </div>
          {step.stepType && (
            <p className="text-[10px] text-muted-foreground mt-0.5 capitalize">
              {step.stepType.replace(/_/g, " ")}
            </p>
          )}
          <DurationBar ms={step.durationMs} maxMs={maxMs} status={step.status} />
        </div>
        <div className="shrink-0">
          {selected
            ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>
      {step.error && (
        <div className="mt-2 flex items-start gap-1.5 bg-red-50 rounded px-2 py-1.5">
          <AlertTriangle className="h-3 w-3 text-red-500 shrink-0 mt-0.5" />
          <p className="text-[10px] text-red-600 line-clamp-2">{step.error}</p>
        </div>
      )}
    </button>
  );
}

// ─── Step detail panel ────────────────────────────────────────────────────────

function StepDetailPanel({ step, onClose }: { step: StepExec; onClose: () => void }) {
  const meta = STATUS_META[step.status as keyof typeof STATUS_META] ?? STATUS_META.skipped;
  return (
    <div className="w-80 shrink-0 border-l bg-background flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/20 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold truncate">{step.stepName ?? `Step ${step.position + 1}`}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", meta.cls)}>
              {meta.label}
            </span>
            {step.durationMs != null && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                <Timer className="h-3 w-3" />{step.durationMs}ms
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          {new Date(step.executedAt).toLocaleString("uz-UZ")}
        </div>
        {step.error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-[10px] font-semibold text-red-600 uppercase tracking-wide mb-1">Xato</p>
            <p className="text-xs text-red-700 break-words">{step.error}</p>
          </div>
        )}
        <JsonViewer data={step.inputJson} label="Input (Kiruvchi)" />
        <JsonViewer data={step.outputJson} label="Output (Chiquvchi)" />
      </div>
    </div>
  );
}

// ─── Summary panel ────────────────────────────────────────────────────────────

function SummaryPanel({
  exec,
  workflowName,
  onReplay,
  replaying,
}: {
  exec: {
    id: number;
    workflowId: number;
    status: string;
    triggerData: unknown;
    startedAt: Date;
    completedAt: Date | null;
    error: string | null;
  };
  workflowName: string;
  onReplay: () => void;
  replaying: boolean;
}) {
  const meta = STATUS_META[exec.status as keyof typeof STATUS_META] ?? STATUS_META.skipped;
  const StatusIcon = meta.icon;
  const totalMs = exec.completedAt
    ? new Date(exec.completedAt).getTime() - new Date(exec.startedAt).getTime()
    : null;

  return (
    <div className="w-64 shrink-0 border-r bg-background flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/20">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Execution</p>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="space-y-2">
          <div className={cn("flex items-center gap-2 rounded-lg px-3 py-2", meta.cls)}>
            <StatusIcon className="h-4 w-4 shrink-0" />
            <span className="text-sm font-semibold">{meta.label}</span>
          </div>

          <div className="space-y-1.5 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Hash className="h-3 w-3" />
              <span>ID: #{exec.id}</span>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Clock className="h-3 w-3 shrink-0" />
              <span>{new Date(exec.startedAt).toLocaleString("uz-UZ")}</span>
            </div>
            {totalMs != null && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Timer className="h-3 w-3" />
                <span>Jami: {totalMs}ms</span>
              </div>
            )}
          </div>
        </div>

        {exec.error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-[10px] font-semibold text-red-600 uppercase tracking-wide mb-1">Workflow xatosi</p>
            <p className="text-xs text-red-700 break-words">{exec.error}</p>
          </div>
        )}

        <Button
          size="sm"
          variant="outline"
          className="w-full gap-2"
          disabled={replaying}
          onClick={onReplay}
        >
          {replaying
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RotateCcw className="h-3.5 w-3.5" />}
          Qayta ishga tushurish
        </Button>

        <div className="border-t pt-3">
          <JsonViewer data={exec.triggerData} label="Trigger Data" />
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ExecutionDebugger() {
  const params = useParams<{ wfId: string; execId: string }>();
  const [, setLocation] = useLocation();
  const wfId = Number(params.wfId);
  const execId = Number(params.execId);

  const [selectedStep, setSelectedStep] = useState<number | null>(null);

  const { data: execDetail, isLoading } = trpc.workflows.executionDetail.useQuery(
    { executionId: execId },
    { enabled: !!execId },
  );
  const { data: workflow } = trpc.workflows.get.useQuery(
    { id: wfId },
    { enabled: !!wfId },
  );

  const replay = trpc.workflows.replayExecution.useMutation({
    onSuccess: (result) => {
      toast.success("Qayta ishga tushdi");
      setLocation(`/workflows/${wfId}/executions/${result.executionId}`);
    },
    onError: e => toast.error(e.message),
  });

  if (!execId || isNaN(execId)) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Noto'g'ri execution ID</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!execDetail) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Execution topilmadi</p>
      </div>
    );
  }

  const steps = execDetail.steps as StepExec[];
  const maxMs = Math.max(1, ...steps.map(s => s.durationMs ?? 0));
  const selectedStepData = selectedStep != null ? steps.find(s => s.id === selectedStep) ?? null : null;
  const execMeta = STATUS_META[execDetail.status as keyof typeof STATUS_META] ?? STATUS_META.skipped;

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Top bar */}
      <div className="h-14 border-b flex items-center gap-3 px-4 shrink-0 bg-background/95 backdrop-blur z-50">
        <Button
          variant="ghost" size="sm"
          className="h-8 gap-1.5 text-muted-foreground"
          onClick={() => setLocation(`/workflows`)}
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="text-xs">Workflows</span>
        </Button>
        <div className="h-4 w-px bg-border" />
        <span className="text-sm font-medium truncate max-w-[200px]">
          {workflow?.name ?? "Workflow"}
        </span>
        <span className="text-muted-foreground/50">/</span>
        <span className="text-xs text-muted-foreground">Execution #{execId}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", execMeta.cls)}>
          {execMeta.label}
        </span>
        <div className="flex-1" />
        <Button
          variant="outline" size="sm"
          className="h-8 gap-1.5"
          disabled={replay.isPending}
          onClick={() => replay.mutate({ executionId: execId })}
        >
          {replay.isPending
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RotateCcw className="h-3.5 w-3.5" />}
          <span className="text-xs">Replay</span>
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Summary panel */}
        <SummaryPanel
          exec={execDetail as Parameters<typeof SummaryPanel>[0]["exec"]}
          workflowName={workflow?.name ?? ""}
          onReplay={() => replay.mutate({ executionId: execId })}
          replaying={replay.isPending}
        />

        {/* Steps list */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b bg-muted/10 flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              Steplar ({steps.length})
            </p>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              {Object.entries(
                steps.reduce<Record<string, number>>((acc, s) => {
                  acc[s.status] = (acc[s.status] ?? 0) + 1;
                  return acc;
                }, {})
              ).map(([st, cnt]) => {
                const m = STATUS_META[st as keyof typeof STATUS_META];
                return m ? (
                  <span key={st} className={cn("rounded-full px-1.5 py-0.5 font-medium", m.cls)}>
                    {cnt} {m.label}
                  </span>
                ) : null;
              })}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto divide-y-0">
            {steps.length === 0 ? (
              <p className="text-center py-12 text-sm text-muted-foreground">Step yo'q</p>
            ) : (
              steps.map(step => (
                <StepCard
                  key={step.id}
                  step={step}
                  maxMs={maxMs}
                  selected={selectedStep === step.id}
                  onClick={() => setSelectedStep(prev => prev === step.id ? null : step.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Step detail panel */}
        {selectedStepData && (
          <StepDetailPanel
            step={selectedStepData}
            onClose={() => setSelectedStep(null)}
          />
        )}
      </div>
    </div>
  );
}
