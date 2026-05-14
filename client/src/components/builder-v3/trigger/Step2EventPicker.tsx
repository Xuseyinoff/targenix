/**
 * Step2EventPicker — second step. Shows the selected app's icon + name
 * in a header card and an inline dropdown for picking which event of
 * that app fires the automation.
 *
 * For Phase 1 the only event is Facebook's "Lead Ads (webhook)". The
 * dropdown still expands so the layout matches Albato exactly and the
 * "webhook" badge is visible.
 */
import {
  AppIcon,
  appBrandIconTileClass,
} from "@/components/destinations/appIcons";
import { EventDropdown } from "@/components/builder-v3/shared/EventDropdown";
import { findTriggerApp } from "@/components/builder-v3/catalog/triggerCatalog";
import type {
  BuilderV3Action,
  BuilderV3State,
} from "@/state/builderV3State";

export interface Step2EventPickerProps {
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
}

export function Step2EventPicker({
  state,
  dispatch,
}: Step2EventPickerProps) {
  const app = findTriggerApp(state.trigger.appKey);
  if (!app) {
    // Shouldn't be reachable — Step 1 enforces an app pick before we land
    // here — but render a tolerant empty state instead of crashing.
    return <p className="text-sm text-muted-foreground">Pick an app first.</p>;
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <span className={appBrandIconTileClass("h-10 w-10")}>
          <AppIcon name={app.icon} className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-tight">{app.name}</h3>
          <p className="text-xs text-muted-foreground">
            A trigger is an event that starts your automation.
          </p>
        </div>
      </header>

      <div className="space-y-2">
        <label className="block text-sm font-medium">
          Choose an event to trigger your automation
        </label>
        <EventDropdown
          events={app.events}
          value={state.trigger.eventId}
          onChange={(eventId) =>
            dispatch({ type: "PATCH_TRIGGER", patch: { eventId } })
          }
          placeholder="Select an event"
        />
        <p className="text-xs text-muted-foreground">
          This event will trigger data transfer (for example, when a new lead comes in).
        </p>
      </div>
    </div>
  );
}
