/**
 * IntegrationBuilderV3 — Albato-style step-by-step builder for creating
 * a LEAD_ROUTING integration.
 *
 * Mounted at /integrations/builder-v3 as an opt-in alternative to
 * /integrations/new-v2 (the existing Make.com-style stacked-card wizard).
 *
 * Layout mirrors Albato's automation builder at
 *   https://albato.com/app/bundle/edit/<id>
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ ← Automation #N ✎          [Group: Without a group ▼]          │
 *   │   ID: 722330/N                                                  │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │ Builder  History  Analytics       Canvas ⚪ [📋][⇄ Test][▶ Start]│
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │              [Trigger card] → [Action card]                     │
 *   │       (React Flow canvas with zoom + minimap controls)           │
 *   └─────────────────────────────────────────────────────────────────┘
 */
import { useReducer, useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { TriggerSetupModal } from "@/components/builder-v3/trigger/TriggerSetupModal";
import { ActionSetupModal } from "@/components/builder-v3/action/ActionSetupModal";
import { BuilderCanvas } from "@/components/builder-v3/BuilderCanvas";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
import {
  builderV3Reducer,
  INITIAL_STATE,
} from "@/state/builderV3State";
import { findTriggerApp, findTriggerEvent } from "@/components/builder-v3/catalog/triggerCatalog";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  Pencil,
  ChevronDown,
  Copy,
  ArrowLeftRight,
  Play,
} from "lucide-react";
import { useLocation } from "wouter";

export default function IntegrationBuilderV3() {
  const t = useT();
  const [, setLocation] = useLocation();
  const [state, dispatch] = useReducer(builderV3Reducer, INITIAL_STATE);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);

  // ── Derived: trigger summary ───────────────────────────────────────────────
  const app = findTriggerApp(state.trigger.appKey);
  const event = findTriggerEvent(state.trigger.appKey, state.trigger.eventId);
  const triggerConfigured =
    state.trigger.appKey !== null &&
    state.trigger.eventId !== null &&
    state.trigger.facebookAccountId !== null &&
    !!state.trigger.pageId;

  // ── Derived: trigger connection name (FB account) ──────────────────────────
  const { data: fbAccounts = [] } = trpc.facebookAccounts.list.useQuery(
    undefined,
    { staleTime: 30_000, enabled: triggerConfigured },
  );
  const fbAcc = fbAccounts.find(
    (a) => a.id === state.trigger.facebookAccountId,
  );
  const connectionLabel = fbAcc?.fbUserName ?? "Connection";

  // ── Derived: action summary ────────────────────────────────────────────────
  const actionAppQuery = trpc.apps.get.useQuery(
    state.action.appKey ? { key: state.action.appKey } : (undefined as never),
    {
      enabled: !!state.action.appKey,
      staleTime: 5 * 60 * 1000,
    },
  );
  const actionApp = actionAppQuery.data;
  const actionConfigured =
    state.action.appKey !== null && state.action.moduleKey !== null;
  const actionModule = actionApp?.modules?.find(
    (m) => m.key === state.action.moduleKey,
  );

  // ── Modal openers ──────────────────────────────────────────────────────────
  const openTrigger = () => {
    dispatch({
      type: "JUMP_TO",
      step: triggerConfigured ? "trigger-timing" : "trigger-app",
    });
    setTriggerOpen(true);
  };
  const openAction = () => {
    dispatch({
      type: "JUMP_TO",
      step: actionConfigured ? "action-params" : "action-app",
    });
    setActionOpen(true);
  };

  const canStart = triggerConfigured && actionConfigured;

  return (
    <DashboardLayout>
      <div className="flex h-[calc(100vh-4rem)] flex-col bg-muted/20">
        {/* ─── Header row 1: back, title, ID, group ─────────────────────── */}
        <div className="flex items-start justify-between border-b bg-background px-5 py-3 shrink-0">
          <div className="flex items-start gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setLocation("/integrations")}
              className="mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <h1 className="truncate text-lg font-semibold">
                  Automation #new
                </h1>
                <button
                  type="button"
                  className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                  aria-label="Edit name"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="truncate text-xs text-muted-foreground">
                Draft — not yet saved
              </p>
            </div>
          </div>

          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm",
              "text-muted-foreground hover:bg-accent transition-colors",
            )}
          >
            Group: Without a group
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* ─── Header row 2: Builder/History/Analytics + Canvas/Test/Start ── */}
        <div className="flex items-center justify-between border-b bg-background px-5 py-2 shrink-0">
          <nav className="flex items-center gap-1">
            {[
              { label: "Builder", active: true },
              { label: "History", active: false },
              { label: "Analytics", active: false },
            ].map((tab) => (
              <button
                key={tab.label}
                type="button"
                className={cn(
                  "relative rounded-md px-3 py-1.5 text-sm transition-colors",
                  tab.active
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
                {tab.active && (
                  <span className="absolute left-3 right-3 -bottom-2 h-0.5 rounded-full bg-primary" />
                )}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Canvas
              <span className="relative inline-flex h-5 w-9 items-center rounded-full bg-primary">
                <span className="absolute right-0.5 h-4 w-4 rounded-full bg-white shadow" />
              </span>
            </label>
            <button
              type="button"
              className="rounded-md border bg-background p-1.5 text-muted-foreground hover:bg-accent transition-colors"
              aria-label="Duplicate"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <Button variant="outline" size="sm" disabled={!canStart}>
              <ArrowLeftRight className="h-3.5 w-3.5" />
              Test
            </Button>
            <Button size="sm" disabled={!canStart}>
              <Play className="h-3.5 w-3.5" />
              Start
            </Button>
          </div>
        </div>

        {/* ─── Canvas ───────────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0">
          <BuilderCanvas
            trigger={{
              configured: triggerConfigured,
              appName: app?.name ?? "",
              eventLabel: event?.label ?? "",
              connectionLabel,
              detail: [state.trigger.pageName, state.trigger.formName]
                .filter(Boolean)
                .join(" · "),
              iconUrl: app?.icon ?? null,
            }}
            action={{
              configured: actionConfigured,
              appName: actionApp?.name ?? "",
              moduleName: actionModule?.name ?? "",
              detail: "",
              iconUrl: actionApp?.icon ?? null,
            }}
            onOpenTrigger={openTrigger}
            onOpenAction={openAction}
          />
        </div>
      </div>

      <TriggerSetupModal
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        state={state}
        dispatch={dispatch}
        onTriggerComplete={() => {
          // Phase 1.2: log + close. The real save mutation lands in 1.3.
          console.log("[builder-v3] trigger draft", state.trigger);
          setTriggerOpen(false);
        }}
      />

      <ActionSetupModal
        open={actionOpen}
        onOpenChange={setActionOpen}
        state={state}
        dispatch={dispatch}
        onActionComplete={() => {
          // Phase 1.2.5: log + close. The real save mutation lands in 1.3.
          console.log("[builder-v3] action draft", state.action);
          setActionOpen(false);
        }}
      />
    </DashboardLayout>
  );
}
