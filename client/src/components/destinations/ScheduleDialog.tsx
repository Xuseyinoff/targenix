/**
 * ScheduleDialog — per-destination daily pause / start / send-queued
 * schedule editor (Yuboraman parity, PR 4/4 Phase C).
 *
 * Three hour pickers (0-23 plus "Not set"), a read-only timezone field
 * (per-destination tz picker is queued for a follow-up), and a status row
 * surfacing queued-lead count when the destination has any. The data lives
 * in `destination_schedules` via the destinationSchedules.* tRPC procs.
 *
 * Save semantics: empty (NULL) for any hour means "no transition" — the
 * scheduler treats NULL pauseHour as "never auto-pause," NULL startHour
 * as "never auto-start," NULL sendHour as "leads wait indefinitely until
 * the 24h TTL force-sends them." All three can be NULL — the row still
 * exists so manual pauseAll/startAll continue to apply.
 */

import { useEffect, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Loader2, Send, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useT } from "@/hooks/useT";
import { toast } from "sonner";

interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destinationId: number;
  destinationName: string;
}

/** Sentinel for the Select since Radix can't bind to a literal null. */
const NOT_SET = "__not_set__";

function toSelectValue(hour: number | null | undefined): string {
  return hour == null ? NOT_SET : String(hour);
}

function fromSelectValue(value: string): number | null {
  if (value === NOT_SET) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function ScheduleDialog({
  open,
  onOpenChange,
  destinationId,
  destinationName,
}: ScheduleDialogProps) {
  const t = useT();
  const utils = trpc.useUtils();

  const { data: schedule, isLoading } = trpc.destinationSchedules.getSchedule.useQuery(
    { destinationId },
    { enabled: open },
  );
  const { data: pendingCounts } = trpc.destinationSchedules.listPendingCountsForUser.useQuery(
    undefined,
    { enabled: open },
  );

  // Local form state — initialised from the loaded schedule, then mutated
  // freely until Save. Reset whenever the dialog opens with a different
  // destination or the underlying schedule changes.
  const [pauseHour, setPauseHour] = useState<string>(NOT_SET);
  const [startHour, setStartHour] = useState<string>(NOT_SET);
  const [sendHour, setSendHour] = useState<string>(NOT_SET);

  useEffect(() => {
    if (!open) return;
    setPauseHour(toSelectValue(schedule?.pauseHour));
    setStartHour(toSelectValue(schedule?.startHour));
    setSendHour(toSelectValue(schedule?.sendHour));
  }, [open, schedule]);

  const pendingForThis =
    pendingCounts?.find((p) => p.destinationId === destinationId)?.count ?? 0;

  function invalidate() {
    void utils.destinationSchedules.getSchedule.invalidate({ destinationId });
    void utils.destinationSchedules.listForUser.invalidate();
    void utils.destinationSchedules.listPendingCountsForUser.invalidate();
  }

  const setMutation = trpc.destinationSchedules.setSchedule.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t("destinations.schedule.saved"));
      onOpenChange(false);
    },
  });
  const clearMutation = trpc.destinationSchedules.clearSchedule.useMutation({
    onSuccess: (res) => {
      invalidate();
      const flushed = res?.flushed?.succeeded ?? 0;
      toast.success(
        flushed > 0
          ? `${t("destinations.schedule.cleared")} · ${t(
              "destinations.schedule.flushed",
              { count: flushed },
            )}`
          : t("destinations.schedule.cleared"),
      );
      onOpenChange(false);
    },
  });

  // "Send now" path — reuses the per-destination clear+flush mutation
  // pattern: clearing the schedule already triggers an immediate flush
  // (Phase B wired this in destinationSchedulesRouter.clearSchedule).
  // For "flush without removing the schedule" we'd need a dedicated
  // procedure; that's queued for a follow-up — the global Send All
  // Pending button on the page toolbar covers the user need today.

  function handleSave() {
    setMutation.mutate({
      destinationId,
      pauseHour: fromSelectValue(pauseHour),
      startHour: fromSelectValue(startHour),
      sendHour: fromSelectValue(sendHour),
    });
  }

  function handleClear() {
    clearMutation.mutate({ destinationId });
  }

  const isSaving = setMutation.isPending;
  const isClearing = clearMutation.isPending;
  const hasExistingSchedule = !!schedule;

  // sendHour from the form (not the saved schedule) — drives the
  // "leads queued — will be sent at HH:00" message; if the user is
  // mid-edit and just picked a new sendHour, the message should reflect
  // their intent rather than the stale persisted value.
  const effectiveSendHour = fromSelectValue(sendHour);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("destinations.schedule.dialogTitle", { name: destinationName })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("destinations.schedule.tooltip")}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Pending leads banner */}
            {pendingForThis > 0 && (
              <div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
                <div className="flex items-center gap-2">
                  <Send className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {effectiveSendHour != null
                      ? t("destinations.schedule.queuedLeads", {
                          count: pendingForThis,
                          hour: String(effectiveSendHour).padStart(2, "0"),
                        })
                      : t("destinations.schedule.queuedLeadsNoSend", {
                          count: pendingForThis,
                        })}
                  </span>
                </div>
              </div>
            )}

            <HourPicker
              label={t("destinations.schedule.pauseTime")}
              help={t("destinations.schedule.pauseTimeHelp")}
              value={pauseHour}
              onValueChange={setPauseHour}
              notSetLabel={t("destinations.schedule.notSet")}
            />
            <HourPicker
              label={t("destinations.schedule.startTime")}
              help={t("destinations.schedule.startTimeHelp")}
              value={startHour}
              onValueChange={setStartHour}
              notSetLabel={t("destinations.schedule.notSet")}
            />
            <HourPicker
              label={t("destinations.schedule.sendTime")}
              help={t("destinations.schedule.sendTimeHelp")}
              value={sendHour}
              onValueChange={setSendHour}
              notSetLabel={t("destinations.schedule.notSet")}
            />

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                {t("destinations.schedule.timezone")}
              </Label>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="font-mono text-xs">
                  {schedule?.timezone ?? "Asia/Tashkent"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {t("destinations.schedule.timezoneHelpComingSoon")}
                </span>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="flex sm:justify-between gap-2 mt-2">
          <div>
            {hasExistingSchedule && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={handleClear}
                disabled={isSaving || isClearing}
              >
                {isClearing ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                ) : (
                  <Trash2 className="w-4 h-4 mr-1.5" />
                )}
                {t("destinations.schedule.clear")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving || isClearing}
            >
              {t("destinations.schedule.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={isSaving || isClearing || isLoading}>
              {isSaving && <Loader2 className="w-4 h-4 animate-spin mr-1.5" />}
              {t("destinations.schedule.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface HourPickerProps {
  label: string;
  help: string;
  value: string;
  onValueChange: (v: string) => void;
  notSetLabel: string;
}

function HourPicker({ label, help, value, onValueChange, notSetLabel }: HourPickerProps) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="h-10">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NOT_SET}>{notSetLabel}</SelectItem>
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
