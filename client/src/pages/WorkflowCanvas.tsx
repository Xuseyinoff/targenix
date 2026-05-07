import { useCallback, useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import {
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useEdgesState,
  addEdge,
  Controls,
  MiniMap,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  useReactFlow,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  ArrowLeft, Play, Save, Globe, Send, Variable, GitBranch,
  Zap, Clock, Trash2, Check, AlertCircle, Loader2, Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type StepType = "trigger" | "http_request" | "telegram" | "set_variable" | "condition";

type NodeData = Record<string, unknown> & {
  stepType: StepType;
  name: string;
  config: Record<string, unknown>;
  continueOnError: boolean;
  triggerId?: number | null;
};

type WFNode = Node<NodeData>;

type CanvasJson = {
  nodes: WFNode[];
  edges: Edge[];
};

// ─── Step meta ────────────────────────────────────────────────────────────────

const STEP_META: Record<StepType, {
  label: string;
  icon: React.ElementType;
  headerCls: string;
  borderCls: string;
  ringCls: string;
  miniColor: string;
}> = {
  trigger:      { label: "Trigger",      icon: Zap,       headerCls: "bg-emerald-500", borderCls: "border-emerald-200", ringCls: "ring-emerald-400", miniColor: "#10b981" },
  http_request: { label: "HTTP Request", icon: Globe,     headerCls: "bg-blue-500",    borderCls: "border-blue-200",    ringCls: "ring-blue-400",    miniColor: "#3b82f6" },
  telegram:     { label: "Telegram",     icon: Send,      headerCls: "bg-sky-500",     borderCls: "border-sky-200",     ringCls: "ring-sky-400",     miniColor: "#0ea5e9" },
  set_variable: { label: "Set Variable", icon: Variable,  headerCls: "bg-amber-500",   borderCls: "border-amber-200",   ringCls: "ring-amber-400",   miniColor: "#f59e0b" },
  condition:    { label: "Shart (IF)",   icon: GitBranch, headerCls: "bg-violet-500",  borderCls: "border-violet-200",  ringCls: "ring-violet-400",  miniColor: "#8b5cf6" },
};

// ─── Validation ───────────────────────────────────────────────────────────────

function isNodeValid(d: NodeData): boolean {
  const c = d.config;
  switch (d.stepType) {
    case "trigger":      return true;
    case "http_request": return !!c.url;
    case "telegram":     return !!(c.chatId && c.message);
    case "set_variable": return !!c.key;
    case "condition":    return !!(c.field && c.operator);
    default:             return true;
  }
}

// ─── Custom node components ───────────────────────────────────────────────────

function TriggerNode({ data, selected }: NodeProps) {
  const d = data as NodeData;
  const m = STEP_META.trigger;
  return (
    <div className={cn(
      "rounded-xl border-2 bg-white shadow-sm w-[200px] overflow-hidden transition-all",
      selected ? `ring-2 ${m.ringCls} shadow-md` : m.borderCls,
    )}>
      <div className={cn("px-3 py-2 flex items-center gap-2 text-white text-xs font-semibold", m.headerCls)}>
        <m.icon className="h-3.5 w-3.5" />
        <span className="uppercase tracking-wide">Trigger</span>
      </div>
      <div className="px-3 py-2.5">
        <p className="text-xs font-medium truncate">{String(d.name)}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {d.triggerId ? `Trigger #${d.triggerId}` : "Trigger tanlanmagan"}
        </p>
      </div>
      <Handle type="source" position={Position.Bottom}
        className="!bg-emerald-500 !w-3 !h-3 !border-2 !border-white !rounded-full" />
    </div>
  );
}

function StepNode({ data, selected }: NodeProps) {
  const d = data as NodeData;
  const m = STEP_META[d.stepType] ?? STEP_META.http_request;
  const valid = isNodeValid(d);
  return (
    <div className={cn(
      "rounded-xl border-2 bg-white shadow-sm w-[200px] overflow-hidden transition-all",
      selected ? `ring-2 ${m.ringCls} shadow-md` : m.borderCls,
    )}>
      <Handle type="target" position={Position.Top}
        className="!bg-slate-300 !w-3 !h-3 !border-2 !border-white !rounded-full" />
      <div className={cn("px-3 py-2 flex items-center gap-2 text-white text-xs font-semibold", m.headerCls)}>
        <m.icon className="h-3.5 w-3.5" />
        <span className="uppercase tracking-wide flex-1 truncate">{m.label}</span>
        {valid
          ? <Check className="h-3 w-3 opacity-90 shrink-0" />
          : <AlertCircle className="h-3 w-3 opacity-90 shrink-0" />}
      </div>
      <div className="px-3 py-2.5">
        <p className="text-xs font-medium truncate">{String(d.name)}</p>
        {!valid && <p className="text-[10px] text-destructive mt-0.5">Sozlama to'liq emas</p>}
      </div>
      <Handle type="source" position={Position.Bottom}
        className="!bg-slate-300 !w-3 !h-3 !border-2 !border-white !rounded-full" />
    </div>
  );
}

function ConditionNode({ data, selected }: NodeProps) {
  const d = data as NodeData;
  const m = STEP_META.condition;
  const valid = isNodeValid(d);
  return (
    <div className={cn(
      "rounded-xl border-2 bg-white shadow-sm w-[200px] overflow-hidden transition-all",
      selected ? `ring-2 ${m.ringCls} shadow-md` : m.borderCls,
    )}>
      <Handle type="target" position={Position.Top}
        className="!bg-slate-300 !w-3 !h-3 !border-2 !border-white !rounded-full" />
      <div className={cn("px-3 py-2 flex items-center gap-2 text-white text-xs font-semibold", m.headerCls)}>
        <m.icon className="h-3.5 w-3.5" />
        <span className="uppercase tracking-wide flex-1">Shart (IF)</span>
        {valid
          ? <Check className="h-3 w-3 opacity-90 shrink-0" />
          : <AlertCircle className="h-3 w-3 opacity-90 shrink-0" />}
      </div>
      <div className="px-3 py-2.5">
        <p className="text-xs font-medium truncate">{String(d.name)}</p>
        <div className="flex gap-2 mt-1.5">
          <span className="text-[10px] bg-emerald-50 text-emerald-600 border border-emerald-200 px-1.5 py-0.5 rounded">True →</span>
          <span className="text-[10px] bg-red-50 text-red-500 border border-red-200 px-1.5 py-0.5 rounded">False →</span>
        </div>
      </div>
      <Handle type="source" id="true"  position={Position.Bottom} style={{ left: "28%" }}
        className="!bg-emerald-400 !w-3 !h-3 !border-2 !border-white !rounded-full" />
      <Handle type="source" id="false" position={Position.Bottom} style={{ left: "72%" }}
        className="!bg-red-400 !w-3 !h-3 !border-2 !border-white !rounded-full" />
    </div>
  );
}

const NODE_TYPES = { trigger: TriggerNode, step: StepNode, condition: ConditionNode } as const;

// ─── Node palette ─────────────────────────────────────────────────────────────

const PALETTE = [
  { stepType: "trigger"      as StepType, nodeType: "trigger",   label: "Trigger",       icon: Zap,       accentCls: "border-l-emerald-400" },
  { stepType: "http_request" as StepType, nodeType: "step",      label: "HTTP Request",  icon: Globe,     accentCls: "border-l-blue-400" },
  { stepType: "telegram"     as StepType, nodeType: "step",      label: "Telegram",      icon: Send,      accentCls: "border-l-sky-400" },
  { stepType: "set_variable" as StepType, nodeType: "step",      label: "Set Variable",  icon: Variable,  accentCls: "border-l-amber-400" },
  { stepType: "condition"    as StepType, nodeType: "condition", label: "Shart (IF)",    icon: GitBranch, accentCls: "border-l-violet-400" },
] as const;

function NodePalette() {
  function onDragStart(e: React.DragEvent, item: typeof PALETTE[number]) {
    e.dataTransfer.setData("rf/steptype", item.stepType);
    e.dataTransfer.setData("rf/nodetype", item.nodeType);
    e.dataTransfer.effectAllowed = "move";
  }
  return (
    <div className="w-52 shrink-0 border-r bg-background flex flex-col">
      <div className="px-4 py-3 border-b bg-muted/20">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Node turlari</p>
        <p className="text-[10px] text-muted-foreground/60 mt-0.5">Canvasga sudrang</p>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {PALETTE.map(item => (
          <div
            key={item.stepType}
            draggable
            onDragStart={e => onDragStart(e, item)}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2.5 rounded-lg border bg-background border-l-4",
              "hover:bg-accent/50 cursor-grab active:cursor-grabbing select-none transition-colors",
              item.accentCls,
            )}
          >
            <item.icon className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-xs font-medium">{item.label}</span>
          </div>
        ))}
        <div className="pt-2 border-t">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40 px-1 mb-1.5">Tez kunda</p>
          {(["Delay", "Loop"] as const).map(label => (
            <div key={label} className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-dashed text-muted-foreground/40 mb-1.5 select-none">
              <Clock className="h-4 w-4 shrink-0" />
              <span className="text-xs">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Node settings panel ──────────────────────────────────────────────────────

type TriggerItem = { id: number; name: string; type: string };

function SettingsPanel({
  node, triggers, onChange, onDelete,
}: {
  node: WFNode;
  triggers: TriggerItem[];
  onChange: (patch: Partial<NodeData>) => void;
  onDelete: () => void;
}) {
  const d = node.data;
  const c = d.config;
  const sc = (patch: Record<string, unknown>) => onChange({ config: { ...c, ...patch } });

  return (
    <div className="w-72 shrink-0 border-l bg-background flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/20 flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <p className="text-xs font-semibold flex-1 truncate">{STEP_META[d.stepType]?.label ?? d.stepType}</p>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">

        {/* Name */}
        <div className="space-y-1.5">
          <Label className="text-xs">Nomi</Label>
          <Input className="text-xs h-8" value={String(d.name)}
            onChange={e => onChange({ name: e.target.value })} placeholder="Step nomi..." />
        </div>

        {/* Trigger: select trigger */}
        {d.stepType === "trigger" && (
          <div className="space-y-1.5">
            <Label className="text-xs">Trigger</Label>
            <Select
              value={d.triggerId ? String(d.triggerId) : "none"}
              onValueChange={v => onChange({ triggerId: v === "none" ? null : Number(v) })}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Tanlang..." /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs">— Trigger yo'q —</SelectItem>
                {triggers.map(t => (
                  <SelectItem key={t.id} value={String(t.id)} className="text-xs">{t.name} ({t.type})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* HTTP Request */}
        {d.stepType === "http_request" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">URL</Label>
              <Input className="text-xs h-8 font-mono" placeholder="https://api.example.com/leads"
                value={String(c.url ?? "")} onChange={e => sc({ url: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Method</Label>
                <Select value={String(c.method ?? "POST")} onValueChange={v => sc({ method: v })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["GET","POST","PUT","PATCH","DELETE"].map(m =>
                      <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Timeout (ms)</Label>
                <Input type="number" className="text-xs h-8" placeholder="10000"
                  value={String(c.timeout ?? 10000)} onChange={e => sc({ timeout: Number(e.target.value) })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Body (JSON)</Label>
              <Textarea className="text-xs font-mono resize-none" rows={4}
                placeholder={'{"phone": "{{trigger.phone}}"}'}
                value={String(c.body ?? "")} onChange={e => sc({ body: e.target.value })} />
            </div>
          </>
        )}

        {/* Telegram */}
        {d.stepType === "telegram" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Chat ID</Label>
              <Input className="text-xs h-8" placeholder="-1001234567890"
                value={String(c.chatId ?? "")} onChange={e => sc({ chatId: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Xabar</Label>
              <Textarea className="text-xs resize-none" rows={4}
                placeholder={"Yangi lid: {{trigger.fullName}}\nTelefon: {{trigger.phone}}"}
                value={String(c.message ?? "")} onChange={e => sc({ message: e.target.value })} />
            </div>
          </>
        )}

        {/* Set Variable */}
        {d.stepType === "set_variable" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">O'zgaruvchi nomi</Label>
              <Input className="text-xs h-8 font-mono" placeholder="crmId"
                value={String(c.key ?? "")} onChange={e => sc({ key: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Qiymat</Label>
              <Input className="text-xs h-8 font-mono" placeholder="{{steps.0.output.body.id}}"
                value={String(c.value ?? "")} onChange={e => sc({ value: e.target.value })} />
            </div>
          </>
        )}

        {/* Condition */}
        {d.stepType === "condition" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Maydon</Label>
              <Input className="text-xs h-8 font-mono" placeholder="{{steps.0.output.status}}"
                value={String(c.field ?? "")} onChange={e => sc({ field: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Operator</Label>
              <Select value={String(c.operator ?? "eq")} onValueChange={v => sc({ operator: v })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["eq","neq","contains","starts_with","ends_with","exists","not_exists","gt","gte","lt","lte"].map(o =>
                    <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Qiymat</Label>
              <Input className="text-xs h-8 font-mono" placeholder="200"
                value={String(c.value ?? "")} onChange={e => sc({ value: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Shart bajarilmasa</Label>
              <Select value={String(c.onFail ?? "stop")} onValueChange={v => sc({ onFail: v })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="stop" className="text-xs">Workflowni to'xtatish</SelectItem>
                  <SelectItem value="continue" className="text-xs">Davom etish</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}

        {/* continueOnError */}
        {d.stepType !== "trigger" && (
          <div className="flex items-center gap-2 pt-1 border-t">
            <Switch id={`coe-${node.id}`} checked={!!d.continueOnError}
              onCheckedChange={v => onChange({ continueOnError: v })} />
            <Label htmlFor={`coe-${node.id}`} className="text-xs cursor-pointer">Xatoda davom etish</Label>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Topological sort (Kahn's BFS) ────────────────────────────────────────────

function topoSort(nodes: WFNode[], edges: Edge[]): WFNode[] {
  const adj = new Map<string, string[]>();
  const inDeg = new Map<string, number>();
  for (const n of nodes) { adj.set(n.id, []); inDeg.set(n.id, 0); }
  for (const e of edges) {
    adj.get(e.source)?.push(e.target);
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1);
  }
  const queue = Array.from(inDeg.entries()).filter(([, d]) => d === 0).map(([id]) => id);
  const sorted: WFNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    const n = nodes.find(x => x.id === id);
    if (n) sorted.push(n);
    for (const nbr of adj.get(id) ?? []) {
      const nd = (inDeg.get(nbr) ?? 1) - 1;
      inDeg.set(nbr, nd);
      if (nd === 0) queue.push(nbr);
    }
  }
  return sorted;
}

// ─── Default layout from existing steps ──────────────────────────────────────

function generateDefaultLayout(workflow: {
  triggerId?: number | null;
  steps: { id?: number; position: number; type: string; name: string; config: unknown; continueOnError: boolean }[];
}): { nodes: WFNode[]; edges: Edge[] } {
  const nodes: WFNode[] = [];
  const edges: Edge[] = [];
  const CX = 100;
  let y = 0;

  nodes.push({
    id: "trigger-node",
    type: "trigger",
    position: { x: CX, y },
    data: { stepType: "trigger", name: "Trigger", config: {}, continueOnError: false, triggerId: workflow.triggerId ?? null },
  });
  y += 160;

  let prevId = "trigger-node";
  for (const step of workflow.steps) {
    const nodeId = `step-${step.id ?? step.position}`;
    const isCondition = step.type === "condition";
    nodes.push({
      id: nodeId,
      type: isCondition ? "condition" : "step",
      position: { x: CX, y },
      data: {
        stepType: step.type as StepType,
        name: step.name,
        config: (step.config ?? {}) as Record<string, unknown>,
        continueOnError: step.continueOnError,
      },
    });
    edges.push({
      id: `e-${prevId}-${nodeId}`,
      source: prevId,
      target: nodeId,
      markerEnd: { type: MarkerType.ArrowClosed },
    });
    prevId = nodeId;
    y += 160;
  }

  return { nodes, edges };
}

// ─── Canvas inner (must be inside ReactFlowProvider) ─────────────────────────

function CanvasInner({ workflowId }: { workflowId: number }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const rf = useReactFlow();

  const { data: workflow, isLoading } = trpc.workflows.get.useQuery({ id: workflowId });
  const { data: triggersList } = trpc.triggers.list.useQuery();

  const [nodes, setNodes, onNodesChange] = useNodesState<WFNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wfName, setWfName] = useState("");
  const [wfActive, setWfActive] = useState(true);
  const [initialized, setInitialized] = useState(false);

  const saveCanvas = trpc.workflows.saveCanvas.useMutation({
    onSuccess: () => {
      toast.success("Canvas saqlandi");
      void utils.workflows.list.invalidate();
      void utils.workflows.get.invalidate({ id: workflowId });
    },
    onError: e => toast.error(e.message),
  });

  const runWf = trpc.workflows.run.useMutation({
    onSuccess: r => toast.success(`Ishga tushdi — ${r.status}`),
    onError: e => toast.error(e.message),
  });

  useEffect(() => {
    if (!workflow || initialized) return;
    setWfName(workflow.name);
    setWfActive(workflow.isActive);

    const saved = workflow.canvasJson as CanvasJson | null;
    if (saved?.nodes?.length) {
      setNodes(saved.nodes);
      setEdges(saved.edges ?? []);
    } else {
      const { nodes: dn, edges: de } = generateDefaultLayout(workflow);
      setNodes(dn);
      setEdges(de);
    }
    setInitialized(true);
    setTimeout(() => rf.fitView({ padding: 0.25 }), 80);
  }, [workflow, initialized, rf, setNodes, setEdges]);

  const selectedNode = nodes.find(n => n.id === selectedId) ?? null;

  const onConnect = useCallback((conn: Connection) => {
    setEdges(eds => addEdge({
      ...conn,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 2 },
    }, eds));
  }, [setEdges]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedId(node.id);
  }, []);

  const onPaneClick = useCallback(() => setSelectedId(null), []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const stepType = e.dataTransfer.getData("rf/steptype") as StepType;
    const nodeType = e.dataTransfer.getData("rf/nodetype");
    if (!stepType || !nodeType) return;

    const position = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const id = `${nodeType}-${Date.now()}`;
    const defaultConfig: Record<string, unknown> =
      stepType === "http_request" ? { method: "POST", timeout: 10000 }
      : stepType === "condition" ? { operator: "eq", onFail: "stop" }
      : {};

    setNodes(nds => [...nds, {
      id,
      type: nodeType,
      position,
      data: {
        stepType,
        name: STEP_META[stepType]?.label ?? stepType,
        config: defaultConfig,
        continueOnError: false,
      },
    }]);
    setSelectedId(id);
  }, [rf, setNodes]);

  function updateNodeData(patch: Partial<NodeData>) {
    if (!selectedId) return;
    setNodes(nds => nds.map(n =>
      n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n
    ));
  }

  function deleteSelectedNode() {
    if (!selectedId) return;
    setNodes(nds => nds.filter(n => n.id !== selectedId));
    setEdges(eds => eds.filter(e => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  }

  function handleSave() {
    const nonTrigger = nodes.filter(n => n.data.stepType !== "trigger");
    const sorted = topoSort(nonTrigger, edges);
    const seen = new Set(sorted.map(n => n.id));
    for (const n of nonTrigger) if (!seen.has(n.id)) sorted.push(n);

    const VALID_STEP_TYPES = ["http_request", "telegram", "set_variable", "condition"] as const;
    type ValidStepType = typeof VALID_STEP_TYPES[number];
    function isValidStepType(t: string): t is ValidStepType {
      return (VALID_STEP_TYPES as readonly string[]).includes(t);
    }
    const steps = sorted
      .filter(n => isValidStepType(String(n.data.stepType)))
      .map((n, i) => ({
        type:            String(n.data.stepType) as ValidStepType,
        name:            String(n.data.name),
        config:          n.data.config,
        continueOnError: !!n.data.continueOnError,
        position:        i,
      }));

    const triggerNode = nodes.find(n => n.data.stepType === "trigger");
    const triggerId = (triggerNode?.data.triggerId as number | null | undefined) ?? undefined;

    saveCanvas.mutate({
      id:         workflowId,
      name:       wfName.trim() || "Workflow",
      isActive:   wfActive,
      triggerId:  triggerId ?? null,
      canvasJson: {
        nodes: nodes as unknown as Record<string, unknown>[],
        edges: edges as unknown as Record<string, unknown>[],
      },
      steps,
    });
  }

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Top bar */}
      <div className="h-14 border-b flex items-center gap-3 px-4 shrink-0 bg-background/95 backdrop-blur z-50">
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground"
          onClick={() => setLocation("/workflows")}>
          <ArrowLeft className="h-4 w-4" />
          <span className="text-xs">Workflows</span>
        </Button>
        <div className="h-4 w-px bg-border" />
        <Input
          value={wfName}
          onChange={e => setWfName(e.target.value)}
          className="h-8 border-none shadow-none text-sm font-medium focus-visible:ring-0 w-64 px-1"
          placeholder="Workflow nomi..."
        />
        <div className="flex items-center gap-1.5 ml-1">
          <Switch checked={wfActive} onCheckedChange={setWfActive} className="scale-90" />
          <span className="text-xs text-muted-foreground">{wfActive ? "Faol" : "Nofaol"}</span>
        </div>
        <div className="flex-1" />
        <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={runWf.isPending}
          onClick={() => runWf.mutate({ id: workflowId, triggerData: {} })}>
          {runWf.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          <span className="text-xs">Test Run</span>
        </Button>
        <Button size="sm" className="h-8 gap-1.5" disabled={saveCanvas.isPending} onClick={handleSave}>
          {saveCanvas.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          <span className="text-xs">Saqlash</span>
        </Button>
      </div>

      {/* Main area */}
      <div className="flex-1 flex overflow-hidden">
        <NodePalette />

        <div className="flex-1 relative" onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            defaultEdgeOptions={{
              markerEnd: { type: MarkerType.ArrowClosed },
              style: { strokeWidth: 2, stroke: "#94a3b8" },
            }}
            deleteKeyCode="Delete"
          >
            <Controls className="!border !rounded-lg !shadow-sm" />
            <MiniMap
              className="!border !rounded-lg !shadow-sm"
              maskColor="rgba(0,0,0,0.04)"
              nodeColor={n => {
                const st = (n.data as NodeData).stepType;
                return STEP_META[st]?.miniColor ?? "#94a3b8";
              }}
            />
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#e2e8f0" />
          </ReactFlow>
        </div>

        {selectedNode && (
          <SettingsPanel
            node={selectedNode}
            triggers={(triggersList ?? []) as TriggerItem[]}
            onChange={updateNodeData}
            onDelete={deleteSelectedNode}
          />
        )}
      </div>
    </div>
  );
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default function WorkflowCanvas() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);

  if (!id || isNaN(id)) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Noto'g'ri workflow ID</p>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <CanvasInner workflowId={id} />
    </ReactFlowProvider>
  );
}
