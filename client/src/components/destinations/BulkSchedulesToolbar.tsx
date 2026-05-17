/**
 * BulkSchedulesToolbar — fleet-wide schedule controls (Yuboraman parity,
 * PR 4/4 Phase C). Sits above the destinations table on Destinations.tsx.
 *
 * Buttons:
 *   1. Pause All — opens a dialog with 3 hour pickers; on Save calls
 *                  destinationSchedules.pauseAll for every destination
 *                  the caller owns.
 *   2. Start All — confirm dialog; on confirm calls startAll (clears
 *                  isPausedNow + immediately flushes pending leads —
 *                  Phase B wired this in destinationSchedulesRouter).
 *   3. Send All Pending — confirm; calls flushPendingAll.
 *   4. Reset Schedules — confirm; calls resetSchedules (deletes every
 *                  schedule row for the caller; pending leads flush as
 *                  a side effect of the reset, per Phase B).
 *
 * Confirms use native `window.confirm` to match the existing
 * `confirm(t("destinations.confirmDelete"))` pattern on this page —
 * no new ConfirmDialog component is needed.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Pause, Play, RotateCcw, Send } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useT } from "@/hooks/useT";
import { toast } from "sonner";

const NOT_SET = "__not_set__";

function fromSelectValue(value: string): number | null {
  if (value === NOT_SET) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function BulkSchedulesToolbar() {
  const t = useT();
  const utils = trpc.useUtils();
  const [pauseAllOpen, setPauseAllOpen] = useState(false);
  // pauseAll requires pauseHour (non-null per the server zod); default 22:00.
  const [pauseHour, setPauseHour] = useState<string>("22");
  const [startHour, setStartHour] = useState<string>("8");
  const [sendHour, setSendHour] = useState<string>("9");

  function invalidateAll() {
    void utils.destinationSchedules.listForUser.invalidate();
    void utils.destinationSchedules.listPendingCountsForUser.invalidate();
  }

  const pauseAllMutation = trpc.destinationSchedules.pauseAll.useMutation({
    onSuccess: (res) => {
      invalidateAll();
      toast.success(t("destinations.bulk.toastPaused", { count: res.affected }));
      setPauseAllOpen(false);
    },
  });
  const startAllMutation = trpc.destinationSchedules.startAll.useMutation({
    onSuccess: (res) => {
      invalidateAll();
      toast.success(
        t("destinations.bulk.toastResumed", {
          count: res.destinationsResumed,
          flushed: res.flushed?.succeeded ?? 0,
        }),
      );
    },
  });
  const flushAllMutation = trpc.destinationSchedules.flushPendingAll.useMutation({
    onSuccess: (res) => {
      invalidateAll();
      toast.success(t("destinations.bulk.toastFlushed", { queued: res.queued }));
    },
  });
  const resetMutation = trpc.destinationSchedules.resetSchedules.useMutation({
    onSuccess: (res) => {
      invalidateAll();
      toast.success(
        t("destinations.bulk.toastReset", { count: res.destinationsCleared }),
      );
    },
  });

  const anyPending =
    pauseAllMutation.isPending ||
    startAllMutation.isPending ||
    flushAllMutation.isPending ||
    resetMutation.isPending;

  function handleStartAll() {
    if (confirm(t("destinations.bulk.confirmStartAll"))) startAllMutation.mutate();
  }
  function handleFlushAll() {
    if (confirm(t("destinations.bulk.confirmFlushAll"))) flushAllMutation.mutate();
  }
  function handleReset() {
    if (confirm(t("destinations.bulk.confirmReset"))) resetMutation.mutate();
  }
  function handlePauseAllSave() {
    const pauseH = fromSelectValue(pauseHour);
    // Server's pauseAll zod requires pauseHour to be a number 0-23 (NOT null).
    // Defend at the UI layer too so the toast is friendly instead of a
    // tRPC validation error.
    if (pauseH == null) {
      toast.error(t("destinations.schedule.pauseTime"));
      return;
    }
    pauseAllMutation.mutate({
      pauseHour: pauseH,
      startHour: fromSelectValue(startHour),
      sendHour: fromSelectValue(sendHour),
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={() => setPauseAllOpen(true)}
          disabled={anyPending}
        >
          <Pause className="w-4 h-4" />
          <span className="ml-1.5">{t("destinations.bulk.pauseAll")}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={handleStartAll}
          disabled={anyPending}
        >
          {startAllMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Play className="w-4 h-4" />
          )}
          <span className="ml-1.5">{t("destinations.bulk.startAll")}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          onClick={handleFlushAll}
          disabled={anyPending}
        >
          {flushAllMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
          <span className="ml-1.5">{t("destinations.bulk.sendAllPending")}</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 text-muted-foreground"
          onClick={handleReset}
          disabled={anyPending}
        >
          {resetMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RotateCcw className="w-4 h-4" />
          )}
          <span className="ml-1.5">{t("destinations.bulk.resetSchedules")}</span>
        </Button>
      </div>

      <Dialog open={pauseAllOpen} onOpenChange={setPauseAllOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("destinations.bulk.pauseAllDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("destinations.bulk.pauseAllDialogDesc")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <ToolbarHourPicker
              label={t("destinations.schedule.pauseTime")}
              help={t("destinations.schedule.pauseTimeHelp")}
              value={pauseHour}
              onValueChange={setPauseHour}
              notSetLabel={t("destinations.schedule.notSet")}
              allowNotSet={false}
            />
            <ToolbarHourPicker
              label={t("destinations.schedule.startTime")}
              help={t("destinations.schedule.startTimeHelp")}
              value={startHour}
              onValueChange={setStartHour}
              notSetLabel={t("destinations.schedule.notSet")}
              allowNotSet
            />
            <ToolbarHourPicker
              label={t("destinations.schedule.sendTime")}
              help={t("destinations.schedule.sendTimeHelp")}
              value={sendHour}
              onValueChange={setSendHour}
              notSetLabel={t("destinations.schedule.notSet")}
              allowNotSet
            />
          </div>

          <DialogFooter className="gap-2 sm:justify-end mt-2">
            <Button
              variant="outline"
              onClick={() => setPauseAllOpen(false)}
              disabled={pauseAllMutation.isPending}
            >
              {t("destinations.schedule.cancel")}
            </Button>
            <Button
              onClick={handlePauseAllSave}
              disabled={pauseAllMutation.isPending}
            >
              {pauseAllMutation.isPending && (
                <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
              )}
              {t("destinations.bulk.pauseAll")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ToolbarHourPickerProps {
  label: string;
  help: string;
  value: string;
  onValueChange: (v: string) => void;
  notSetLabel: string;
  allowNotSet: boolean;
}

function ToolbarHourPicker({
  label,
  help,
  value,
  onValueChange,
  notSetLabel,
  allowNotSet,
}: ToolbarHourPickerProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="h-10">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allowNotSet && <SelectItem value={NOT_SET}>{notSetLabel}</SelectItem>}
          {Array.from({ length: 24 }, (_, i) => (
            <SelectItem key={i} value={String(i)}>
              {formatHour(i)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{help}</p>
    </div>
  );
}

