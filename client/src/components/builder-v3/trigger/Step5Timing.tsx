/**
 * Step5Timing — when should data start flowing?
 *
 * Albato exposes two options: "Real time" (default) and "Data migration"
 * (bulk historical backfill). targenix only supports real-time today, so
 * the Bulk option is rendered disabled with a small "Coming soon" hint.
 * Keeping it visible matches Albato's layout 1:1 and prepares the UI for
 * the day we add a backfill worker.
 */
import { cn } from "@/lib/utils";
import { Clock, History } from "lucide-react";
import type {
  BuilderV3Action,
  BuilderV3State,
} from "@/state/builderV3State";

export interface Step5TimingProps {
  state: BuilderV3State;
  dispatch: React.Dispatch<BuilderV3Action>;
}

export function Step5Timing({ state, dispatch }: Step5TimingProps) {
  return (
    <div className="space-y-5">
      <header>
        <h3 className="text-base font-semibold leading-tight">
          Automation timing
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose when to send data.
        </p>
      </header>

      <div className="space-y-3">
        <RadioRow
          icon={<Clock className="h-4 w-4" />}
          label="Real time"
          hint="Forward each lead as soon as Facebook delivers the webhook."
          checked={state.trigger.timing === "realtime"}
          onPick={() =>
            dispatch({ type: "PATCH_TRIGGER", patch: { timing: "realtime" } })
          }
        />
        <RadioRow
          icon={<History className="h-4 w-4" />}
          label="Data migration (bulk historical)"
          hint="Backfill existing leads before going live."
          checked={state.trigger.timing === "bulk"}
          onPick={() =>
            dispatch({ type: "PATCH_TRIGGER", patch: { timing: "bulk" } })
          }
          disabled
        />
      </div>
    </div>
  );
}

function RadioRow({
  icon,
  label,
  hint,
  checked,
  onPick,
  disabled,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  onPick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onPick()}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border bg-background px-3 py-3 text-left transition-colors",
        checked
          ? "border-primary ring-2 ring-primary/20"
          : "hover:bg-accent/40",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      {/* Custom radio dot — we control colour without bringing in a third-
          party form library just for this. */}
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary" : "border-muted-foreground/40",
        )}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          {icon}
          {label}
          {disabled && (
            <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Soon
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}
