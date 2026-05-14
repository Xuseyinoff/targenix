/**
 * BuilderCanvas — Albato-style React Flow surface for the V3 builder.
 *
 * Layout (vertical, single column, matches https://albato.com/app/bundle):
 *
 *   ┌────────────────────────────────┐
 *   │ [Hint]              Real time ⚙│  ← hover-only badges above card
 *   │ ┌──────────────────────────┐   │
 *   │ │ ICON  1. App: event   ⋮ │   │  ← step header
 *   │ │       Full title here    │   │
 *   │ │  ┌────────────────────┐  │   │
 *   │ │  │ Connection      ▼ │  │   │  ← connection picker (in-card)
 *   │ │  └────────────────────┘  │   │
 *   │ └──────────────────────────┘   │
 *   │           [⊕ filter]            │  ← optional bottom badge
 *   └────────────────────────────────┘
 *                  │
 *                  ⊕
 *                  │
 *   ┌────────────────────────────────┐
 *   │ ┌──────────────────────────┐   │
 *   │ │  [+]  Add action          │   │
 *   │ │       2. Do this …        │   │
 *   │ └──────────────────────────┘   │
 *   └────────────────────────────────┘
 */
import * as React from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  type EdgeProps,
  BaseEdge,
  getStraightPath,
  EdgeLabelRenderer,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { cn } from "@/lib/utils";
import {
  Plus,
  ChevronDown,
  Filter,
  Lightbulb,
  Zap,
} from "lucide-react";
import { AppIcon, appBrandIconTileClass } from "@/components/destinations/appIcons";
import { NodeMenu } from "./NodeMenu";

// ─── Data shapes ─────────────────────────────────────────────────────────────

type NodeMenuCallbacks = {
  onRename?: () => void;
  onFilter?: () => void;
  onTestStep?: () => void;
  onErrorHandler?: () => void;
  onDelete?: () => void;
};

type TriggerNodeData = {
  configured: boolean;
  appName: string;
  eventLabel: string;
  /** Connection account name (e.g. "Sitoramo xusenova"). */
  connectionLabel: string;
  /** Free-line detail under header (page · form). */
  detail: string;
  onClick: () => void;
  iconUrl: string | null;
} & NodeMenuCallbacks;

type ActionNodeData = {
  configured: boolean;
  appName: string;
  moduleName: string;
  detail: string;
  onClick: () => void;
  iconUrl: string | null;
} & NodeMenuCallbacks;

// ─── Add-between edge: a small ⊕ in the middle of the line ────────────────────

type AddBetweenEdgeData = { onAdd: () => void };

function AddBetweenEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY } = props;
  const data = props.data as AddBetweenEdgeData | undefined;
  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  return (
    <>
      <BaseEdge
        path={edgePath}
        style={{ stroke: "var(--border)", strokeWidth: 1.5, strokeDasharray: "0" }}
      />
      <EdgeLabelRenderer>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            data?.onAdd();
          }}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          className={cn(
            "absolute z-10 flex h-6 w-6 items-center justify-center rounded-full",
            "border bg-card text-muted-foreground shadow-sm",
            "hover:border-primary hover:text-primary hover:scale-110 transition-all",
            "pointer-events-auto",
          )}
          title="Add step"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

// ─── Trigger node ────────────────────────────────────────────────────────────
//
// Important: the outer card uses a <div role="button"> (NOT a real <button>)
// because the kebab + connection picker + filter icon each render their own
// <button>. Nesting buttons is invalid HTML and Chrome silently drops the
// inner click handlers — which is why "trigger ustiga bossam hech narsa
// bo'lmayapti" symptoms appeared. The div+role+keyDown gives us the same
// accessibility surface without the nesting trap.

function TriggerCanvasNode({ data }: NodeProps) {
  const d = data as TriggerNodeData;

  const onCardClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    // Bail if the click started inside an interactive child (kebab,
    // connection picker, filter badge). Those children call
    // stopPropagation themselves, so this is a defence-in-depth — without
    // it a click on the kebab icon's bounding-box edge could still hit
    // the card.
    if ((e.target as HTMLElement).closest("[data-no-card-click]")) return;
    d.onClick();
  };

  return (
    <div className="relative">
      {/* Hover badges above the card */}
      <div className="absolute -top-6 left-0 right-0 flex items-center justify-between text-[10px] pointer-events-none">
        <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-1.5 py-0.5 font-semibold uppercase tracking-wider text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
          <Lightbulb className="h-2.5 w-2.5" />
          Hint
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          Real time
          <Zap className="h-2.5 w-2.5" />
        </span>
      </div>

      {/* Card — div+role acting as a button (see note above on nesting) */}
      <div
        role="button"
        tabIndex={0}
        onClick={onCardClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCardClick(e);
          }
        }}
        className={cn(
          "w-[280px] rounded-xl border bg-card shadow-sm overflow-hidden cursor-pointer",
          "ring-1 ring-transparent hover:ring-emerald-200 dark:hover:ring-emerald-900 transition-all",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        )}
      >
        <div className="flex items-start gap-3 px-3 py-3">
          {d.configured ? (
            <span className={appBrandIconTileClass("h-9 w-9")}>
              <AppIcon name={d.iconUrl} className="h-5 w-5" />
            </span>
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 bg-muted/40">
              <Plus className="h-4 w-4 text-muted-foreground" />
            </span>
          )}

          <div className="min-w-0 flex-1">
            {d.configured ? (
              <>
                <p className="text-[11px] text-muted-foreground truncate">
                  1. {d.appName}: {d.eventLabel}
                </p>
                <p className="text-sm font-semibold text-foreground truncate mt-0.5">
                  {d.appName}: {d.eventLabel}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-foreground">
                  Add trigger
                </p>
                <p className="text-[11px] text-muted-foreground">
                  1. When this happens in the selected app
                </p>
              </>
            )}
          </div>

          <span data-no-card-click>
            <NodeMenu
              onRename={d.onRename}
              onFilter={d.onFilter}
              onTestStep={d.onTestStep}
              onErrorHandler={d.onErrorHandler}
              onDelete={d.onDelete}
            />
          </span>
        </div>

        {/* Connection picker display (in-card). data-no-card-click on the
            wrapper so clicks on the dropdown don't bubble back to the card
            click handler — for now the dropdown still re-opens the setup
            modal, which is fine because the wrapper guards against a
            double-fire. */}
        {d.configured && d.connectionLabel && (
          <div className="border-t bg-muted/30 px-3 py-2" data-no-card-click>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                d.onClick();
              }}
              className={cn(
                "flex w-full items-center justify-between rounded-md border bg-card px-2.5 py-1.5",
                "text-left text-xs hover:bg-accent/40 transition-colors cursor-pointer",
              )}
            >
              <span className="truncate text-foreground">
                {d.connectionLabel}
              </span>
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
            {d.detail && (
              <p className="mt-1.5 text-[10px] text-muted-foreground truncate">
                {d.detail}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Filter badge below card */}
      {d.configured && (
        <div
          className="absolute -bottom-3 left-1/2 -translate-x-1/2 z-10"
          data-no-card-click
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              d.onFilter?.();
            }}
            className="flex h-6 w-6 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-sm hover:text-primary hover:border-primary transition-all cursor-pointer"
            title="Add filter"
          >
            <Filter className="h-3 w-3" />
          </button>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-emerald-500 !w-2.5 !h-2.5 !border-2 !border-white dark:!border-card !-bottom-1"
      />
    </div>
  );
}

// ─── Action node ─────────────────────────────────────────────────────────────
//
// Same div+role trick as TriggerCanvasNode — see the note above. The
// NodeMenu must NOT live inside a real <button> ancestor.

function ActionCanvasNode({ data }: NodeProps) {
  const d = data as ActionNodeData;

  const onCardClick = (e: React.MouseEvent | React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("[data-no-card-click]")) return;
    d.onClick();
  };

  return (
    <div className="relative">
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-emerald-500 !w-2.5 !h-2.5 !border-2 !border-white dark:!border-card !-top-1"
      />

      <div
        role="button"
        tabIndex={0}
        onClick={onCardClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCardClick(e);
          }
        }}
        className={cn(
          "w-[280px] rounded-xl border bg-card shadow-sm overflow-hidden cursor-pointer",
          "ring-1 ring-transparent hover:ring-emerald-200 dark:hover:ring-emerald-900 transition-all",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
        )}
      >
        <div className="flex items-start gap-3 px-3 py-3">
          {d.configured ? (
            <span className={appBrandIconTileClass("h-9 w-9")}>
              <AppIcon name={d.iconUrl} className="h-5 w-5" />
            </span>
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-emerald-100 dark:bg-emerald-950/40">
              <Plus className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
            </span>
          )}

          <div className="min-w-0 flex-1">
            {d.configured ? (
              <>
                <p className="text-[11px] text-muted-foreground truncate">
                  2. {d.appName}: {d.moduleName}
                </p>
                <p className="text-sm font-semibold text-foreground truncate mt-0.5">
                  {d.appName}: {d.moduleName}
                </p>
                {d.detail && (
                  <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                    {d.detail}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-foreground">
                  Add action
                </p>
                <p className="text-[11px] text-muted-foreground">
                  2. Do this in the selected app
                </p>
              </>
            )}
          </div>

          <span data-no-card-click>
            <NodeMenu
              onRename={d.onRename}
              onFilter={d.onFilter}
              onTestStep={d.onTestStep}
              onErrorHandler={d.onErrorHandler}
              onDelete={d.onDelete}
            />
          </span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-emerald-500 !w-2.5 !h-2.5 !border-2 !border-white dark:!border-card !-bottom-1"
      />
    </div>
  );
}

// ─── Sink edge: drag handle for "next action" hint ───────────────────────────
// xyflow needs at least one target for every source; we render a tiny invisible
// node below the action so the bottom-handle has somewhere to point. This also
// gives us a clean spot to render the bottom ⊕ button.

function SinkNode({ data }: NodeProps) {
  const d = data as { onAdd: () => void };
  return (
    <div>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <button
        type="button"
        onClick={d.onAdd}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-full",
          "border bg-card text-muted-foreground shadow-sm",
          "hover:border-primary hover:text-primary hover:scale-110 transition-all",
        )}
        title="Add next step"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const nodeTypes = {
  triggerCanvas: TriggerCanvasNode,
  actionCanvas: ActionCanvasNode,
  sinkNode: SinkNode,
};
const edgeTypes = {
  addBetween: AddBetweenEdge,
};

// ─── Public component ────────────────────────────────────────────────────────

export interface BuilderCanvasProps {
  trigger: {
    configured: boolean;
    appName: string;
    eventLabel: string;
    connectionLabel: string;
    detail: string;
    iconUrl: string | null;
  };
  action: {
    configured: boolean;
    appName: string;
    moduleName: string;
    detail: string;
    iconUrl: string | null;
  };
  onOpenTrigger: () => void;
  onOpenAction: () => void;

  /** Optional kebab-menu handlers. When omitted, that row is hidden. */
  triggerMenu?: NodeMenuCallbacks;
  actionMenu?: NodeMenuCallbacks;
}

export function BuilderCanvas(props: BuilderCanvasProps) {
  const nodes: Node[] = React.useMemo(
    () => [
      {
        id: "trigger",
        type: "triggerCanvas",
        position: { x: 0, y: 0 },
        data: {
          ...props.trigger,
          ...(props.triggerMenu ?? {}),
          onClick: props.onOpenTrigger,
        },
        draggable: false,
        selectable: false,
      },
      {
        id: "action",
        type: "actionCanvas",
        position: { x: 0, y: 220 },
        data: {
          ...props.action,
          ...(props.actionMenu ?? {}),
          onClick: props.onOpenAction,
        },
        draggable: false,
        selectable: false,
      },
      {
        id: "sink",
        type: "sinkNode",
        position: { x: 137, y: 380 },
        data: { onAdd: props.onOpenAction },
        draggable: false,
        selectable: false,
      },
    ],
    [props],
  );

  const edges: Edge[] = React.useMemo(
    () => [
      {
        id: "trigger-action",
        source: "trigger",
        target: "action",
        type: "addBetween",
        data: { onAdd: props.onOpenAction },
      },
      {
        id: "action-sink",
        source: "action",
        target: "sink",
        type: "addBetween",
        data: { onAdd: props.onOpenAction },
      },
    ],
    [props.onOpenAction],
  );

  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
        panOnDrag
        zoomOnScroll
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d4d4d8" />
        {/* Albato parity: both zoom controls AND minimap sit in the bottom-
            left corner, side-by-side. xyflow's MiniMap defaults to right-
            aligned even when position=bottom-left — we override with an
            inline left/right pair so it pins next to Controls. */}
        <Controls
          position="bottom-left"
          showInteractive={false}
          className="!shadow-sm !bg-card !rounded-lg !border !overflow-hidden"
        />
        <MiniMap
          position="bottom-left"
          pannable
          zoomable
          nodeColor={(node) =>
            node.type === "triggerCanvas" ? "#10b981" : "#a3a3a3"
          }
          maskColor="rgba(0,0,0,0.04)"
          // Push the minimap right of the controls strip. Controls' default
          // width is ~28px + 12px left offset; 52px keeps a clean ~12px gap.
          style={{ left: 52, right: "auto" }}
          className="!shadow-sm !bg-card !rounded-lg !border"
        />
      </ReactFlow>
    </ReactFlowProvider>
  );
}
