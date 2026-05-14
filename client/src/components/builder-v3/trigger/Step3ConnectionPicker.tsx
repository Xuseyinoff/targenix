/**
 * Step3ConnectionPicker — pick which Facebook account to read leads from.
 *
 * Backed by `trpc.facebookAccounts.list`. If the user has zero connected
 * accounts we show a one-line CTA pointing them at /connections to add
 * one — same pattern the V2 wizard uses.
 *
 * Phase 1 hard-couples this step to Facebook. Once we add Schedule/Webhook
 * trigger apps in Phase 2 this component will read `state.trigger.appKey`
 * and branch on which connection source to fetch from.
 */
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Loader2, Facebook as FacebookIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AppIcon,
  appBrandIconTileClass,
} from "@/components/destinations/appIcons";
import { findTriggerApp } from "@/components/builder-v3/catalog/triggerCatalog";
import type {
  BuilderV3Action,
  BuilderV3State,
} from "@/state/builderV3State";

export interface Step3ConnectionPickerProps {
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
}

export function Step3ConnectionPicker({
  state,
  dispatch,
}: Step3ConnectionPickerProps) {
  const [, setLocation] = useLocation();
  const app = findTriggerApp(state.trigger.appKey);

  const { data: accounts = [], isLoading } =
    trpc.facebookAccounts.list.useQuery(undefined, {
      staleTime: 30_000,
    });

  return (
    <div className="space-y-5">
      <header className="flex items-center gap-3">
        <span className={appBrandIconTileClass("h-10 w-10")}>
          <AppIcon name={app?.icon ?? null} className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-tight">
            Connect your Facebook account
          </h3>
          <p className="text-xs text-muted-foreground">
            Pick an existing account or add a new connection.
          </p>
        </div>
      </header>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…
        </div>
      ) : accounts.length === 0 ? (
        <EmptyState onAddNew={() => setLocation("/connections")} />
      ) : (
        <ul className="space-y-2">
          {accounts.map((acc) => {
            const selected = state.trigger.facebookAccountId === acc.id;
            return (
              <li key={acc.id}>
                <button
                  type="button"
                  onClick={() =>
                    dispatch({
                      type: "PATCH_TRIGGER",
                      patch: { facebookAccountId: acc.id },
                    })
                  }
                  className={cn(
                    "flex w-full items-center gap-3 rounded-md border bg-background px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-primary ring-2 ring-primary/20"
                      : "hover:bg-accent/40",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#1877F2]/10",
                    )}
                  >
                    <FacebookIcon className="h-4 w-4 text-[#1877F2]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {acc.fbUserName ?? "Facebook account"}
                    </span>
                    {acc.fbUserId && (
                      <span className="block truncate text-xs text-muted-foreground">
                        ID: {acc.fbUserId}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setLocation("/connections")}
        className="text-sm font-medium text-primary hover:underline"
      >
        + Add new Facebook connection
      </button>
    </div>
  );
}

function EmptyState({ onAddNew }: { onAddNew: () => void }) {
  return (
    <div className="rounded-md border border-dashed p-6 text-center">
      <p className="text-sm text-muted-foreground">
        No Facebook accounts connected yet.
      </p>
      <button
        type="button"
        onClick={onAddNew}
        className="mt-2 text-sm font-medium text-primary hover:underline"
      >
        Connect Facebook →
      </button>
    </div>
  );
}
