/**
 * Step1AppPicker — first step of the trigger setup modal.
 *
 * Renders Albato's two-column "Apps + Tools" layout (Facebook in Apps,
 * Schedule/Webhook/RSS in Tools). On app pick → dispatches PATCH_TRIGGER
 * + GO_NEXT to "trigger-event". On tool pick → no-op for Phase 1 (tools
 * are disabled).
 */
import * as React from "react";
import {
  AppToolsPicker,
  type SidebarKey,
} from "@/components/builder-v3/shared/AppToolsPicker";
import {
  TRIGGER_APPS,
  TRIGGER_TOOLS,
} from "@/components/builder-v3/catalog/triggerCatalog";
import type {
  BuilderV3Action,
  BuilderV3State,
} from "@/state/builderV3State";

export interface Step1AppPickerProps {
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
}

const SIDEBAR = [
  { id: "all" as const, label: "All" },
  { id: "apps" as const, label: "Apps" },
  { id: "tools" as const, label: "Tools" },
];

export function Step1AppPicker({ dispatch }: Step1AppPickerProps) {
  const [activeNav, setActiveNav] = React.useState<SidebarKey>("all");

  return (
    <AppToolsPicker
      sidebar={SIDEBAR}
      activeSidebar={activeNav}
      onSidebarChange={setActiveNav}
      apps={TRIGGER_APPS.map((a) => ({
        id: a.appKey,
        name: a.name,
        icon: a.icon,
        available: a.available,
      }))}
      tools={TRIGGER_TOOLS.map((t) => ({
        id: t.id,
        name: t.name,
        icon: t.icon,
        description: t.description,
        available: t.available,
      }))}
      onPickApp={(item) => {
        dispatch({ type: "PATCH_TRIGGER", patch: { appKey: item.id } });
        dispatch({ type: "GO_NEXT", next: "trigger-event" });
      }}
      onPickTool={() => {
        // Phase 1: tools are disabled at the data level (item.available =
        // false), so AppToolsPicker won't actually fire this. Kept as a
        // safety net + a hook for the eventual tool-trigger flows.
      }}
      searchPlaceholder="Search..."
    />
  );
}
