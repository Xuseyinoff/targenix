/**
 * action/Step1AppPicker — App picker for the action setup modal.
 *
 * Same two-column layout as the trigger picker but with the **richer
 * sidebar** Albato shows on the action side:
 *   All / Apps / AI / Logic / Formatting / Rows (arrays) / Advanced
 *
 * Apps come from `trpc.apps.list` filtered to destinations we support
 * via `isSupportedAppKey`. Tools come from the local `actionToolsCatalog`
 * — all disabled in Phase 1, but visible so the UI looks complete.
 *
 * Picking an app dispatches PATCH_ACTION + GO_NEXT to "action-action"
 * (Step 2 = action/module picker). Picking a tool is a no-op for now;
 * the tool items render disabled at the data layer so the click never
 * fires anyway.
 */
import * as React from "react";
import { trpc } from "@/lib/trpc";
import {
  AppToolsPicker,
  type AppToolsItem,
  type SidebarKey,
} from "@/components/builder-v3/shared/AppToolsPicker";
import {
  ACTION_TOOLS,
  toolsByCategory,
  type ToolCategory,
} from "@/components/builder-v3/catalog/actionToolsCatalog";
import { isSupportedAppKey } from "@/components/destinations/createPayload";
import { Home, LayoutGrid, Sparkles, Workflow, Wand2, Rows3, MoreHorizontal } from "lucide-react";
import type {
  BuilderV3Action,
  BuilderV3State,
} from "@/state/builderV3State";

export interface ActionStep1AppPickerProps {
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
}

// Sidebar entries — match Albato's action picker exactly.
const SIDEBAR = [
  { id: "all" as SidebarKey, label: "All", icon: Home },
  { id: "apps" as SidebarKey, label: "Apps", icon: LayoutGrid },
  { id: "ai" as SidebarKey, label: "AI", icon: Sparkles },
  { id: "logic" as SidebarKey, label: "Logic", icon: Workflow },
  { id: "formatting" as SidebarKey, label: "Formatting", icon: Wand2 },
  { id: "rows" as SidebarKey, label: "Rows (arrays)", icon: Rows3 },
  { id: "advanced" as SidebarKey, label: "Advanced", icon: MoreHorizontal },
];

// Map sidebar id → tool category. "all"/"apps" mean "no filter" / "no tools".
function toolsForSidebar(active: SidebarKey): AppToolsItem[] {
  if (active === "all") return ACTION_TOOLS;
  if (active === "apps") return [];
  return toolsByCategory(active as ToolCategory);
}

function appsForSidebar(active: SidebarKey, apps: AppToolsItem[]): AppToolsItem[] {
  // Show Apps column in "All" and "Apps" tabs only — every other tab is a
  // pure tool category.
  if (active === "all" || active === "apps") return apps;
  return [];
}

export function Step1AppPicker({ dispatch }: ActionStep1AppPickerProps) {
  const [activeNav, setActiveNav] = React.useState<SidebarKey>("all");

  const { data: rawApps = [], isLoading } = trpc.apps.list.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });

  // Filter to destinations targenix supports + that have configurable fields.
  // Sort alphabetically to match Albato's list ordering.
  const supportedApps = React.useMemo<AppToolsItem[]>(
    () =>
      rawApps
        .filter((a) => a.availability !== "deprecated")
        .filter((a) => isSupportedAppKey(a.key))
        .filter((a) => {
          const fields = a.modules[0]?.fields;
          return Array.isArray(fields) && fields.length > 0;
        })
        .map((a) => ({
          id: a.key,
          name: a.name,
          icon: a.icon ?? null,
          description: a.description ?? undefined,
          available: true,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rawApps],
  );

  const apps = appsForSidebar(activeNav, supportedApps);
  const tools = toolsForSidebar(activeNav);

  if (isLoading) {
    return (
      <div className="-mx-6 -my-5 flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading apps…</p>
      </div>
    );
  }

  return (
    <AppToolsPicker
      sidebar={SIDEBAR}
      activeSidebar={activeNav}
      onSidebarChange={setActiveNav}
      apps={apps}
      tools={tools}
      onPickApp={(item) => {
        dispatch({ type: "PATCH_ACTION", patch: { appKey: item.id } });
        dispatch({ type: "GO_NEXT", next: "action-action" });
      }}
      onPickTool={() => {
        // All tools are disabled in Phase 1 — AppToolsPicker prevents this
        // from firing — but keep the prop wired for future flows.
      }}
      searchPlaceholder="Search apps and tools..."
    />
  );
}
