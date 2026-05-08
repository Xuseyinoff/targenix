/**
 * ConnectionsList — Phase 8 upgrade: Connection Health + Manager UI.
 *
 * Adds to the existing unified credential table:
 *  • Health status dot (green/amber/red) per row
 *  • Inline "Verify" button — calls connections.verify, updates status live
 *  • Last verified time in row metadata
 *  • Connection detail sheet — health check history, usage list, re-verify
 */

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Send,
  Table2,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Link as LinkIcon,
  ShieldCheck,
  AlertTriangle,
  XCircle,
  Clock,
  Zap,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";

// ─── Types ───────────────────────────────────────────────────────────────────

type ConnectionRow = inferRouterOutputs<AppRouter>["connections"]["list"][number];
type HealthLog     = inferRouterOutputs<AppRouter>["connections"]["healthLogs"][number];

type TypeVisuals = {
  icon:      LucideIcon;
  color:     string;
  typeLabel: string;
  detail:    string;
};

function visualFor(row: ConnectionRow): TypeVisuals {
  if (row.type === "google_sheets") {
    return { icon: Table2,   color: "#0F9D58", typeLabel: "Google Sheets", detail: row.google?.email ?? "—" };
  }
  if (row.type === "telegram_bot") {
    return { icon: Send,     color: "#229ED9", typeLabel: "Telegram",      detail: row.telegram?.chatId ? `chat id ${row.telegram.chatId}` : "No chat id" };
  }
  const keys = row.apiKey?.secretKeys ?? [];
  return {
    icon:      KeyRound,
    color:     row.apiKey?.templateColor ?? "#6366F1",
    typeLabel: row.apiKey?.templateName ?? "API key",
    detail:    keys.length === 0 ? "No secrets stored" : keys.length === 1 ? `${keys[0]} encrypted` : `${keys.length} secrets encrypted`,
  };
}

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(d: Date | string): string {
  const date = new Date(d);
  const now   = Date.now();
  const diff  = now - date.getTime();
  if (diff < 60_000)   return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return formatDate(d);
}

// ─── Health dot ──────────────────────────────────────────────────────────────

function healthFor(row: ConnectionRow): { color: string; label: string; icon: LucideIcon } {
  const expired = row.google?.expired || row.status === "expired";
  if (expired)                     return { color: "text-amber-500", label: "Expired",  icon: AlertTriangle };
  if (row.status === "error")      return { color: "text-red-500",   label: "Error",    icon: XCircle };
  if (row.status === "revoked")    return { color: "text-red-500",   label: "Revoked",  icon: XCircle };
  if (!row.lastVerifiedAt)         return { color: "text-slate-400", label: "Not checked", icon: Clock };
  return { color: "text-emerald-500", label: "Active", icon: ShieldCheck };
}

function HealthDot({ row }: { row: ConnectionRow }) {
  const h = healthFor(row);
  const Icon = h.icon;
  return (
    <span title={h.label}>
      <Icon className={cn("h-3.5 w-3.5 shrink-0", h.color)} />
    </span>
  );
}

// ─── Main list ────────────────────────────────────────────────────────────────

export function ConnectionsList({ onReconnect }: { onReconnect?: () => void }) {
  const utils = trpc.useUtils();
  const { data: rows = [], isLoading } = trpc.connections.list.useQuery();

  const [renameTarget, setRenameTarget] = useState<ConnectionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionRow | null>(null);
  const [detailTarget, setDetailTarget] = useState<ConnectionRow | null>(null);

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [rows],
  );

  const deleteMutation = trpc.connections.disconnect.useMutation({
    onSuccess: (res) => {
      toast.success(res.clearedDestinations > 0
        ? `Connection removed · ${res.clearedDestinations} destination(s) now use fallback`
        : "Connection removed");
      utils.connections.list.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map(i => (
          <div key={i} className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3 shadow-sm animate-pulse">
            <div className="h-9 w-9 shrink-0 rounded-lg bg-muted" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3.5 w-36 rounded-md bg-muted" />
              <div className="h-3 w-48 rounded-md bg-muted/70" />
            </div>
            <div className="h-6 w-16 rounded-full bg-muted/60" />
          </div>
        ))}
      </div>
    );
  }

  if (sortedRows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-muted/10 px-6 py-12 text-center">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-muted/40">
          <LinkIcon className="h-5 w-5 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">No delivery connections yet</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Press{" "}
          <span className="font-medium text-foreground">+ Add connection</span>{" "}
          above to link Google Sheets, Telegram, or an affiliate API key. Once saved they become reusable across every integration.
        </p>
      </div>
    );
  }

  return (
    <>
      <ul className="space-y-2">
        {sortedRows.map(row => (
          <ConnectionRowView
            key={row.id}
            row={row}
            onRename={() => setRenameTarget(row)}
            onDelete={() => setDeleteTarget(row)}
            onDetail={() => setDetailTarget(row)}
            onVerifySuccess={() => utils.connections.list.invalidate()}
            onReconnect={onReconnect}
          />
        ))}
      </ul>

      <RenameConnectionDialog target={renameTarget} onClose={() => setRenameTarget(null)} />

      <ConnectionDetailSheet
        row={detailTarget}
        onClose={() => setDetailTarget(null)}
        onReconnect={onReconnect}
        onVerifySuccess={() => utils.connections.list.invalidate()}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={v => !v && setDeleteTarget(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">{deleteTarget?.displayName}</span>{" "}
              will be deleted. Credentials are erased and cannot be recovered.
              {deleteTarget && deleteTarget.usageCount > 0 && (
                <span className="mt-2 block rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  Used by {deleteTarget.usageCount} destination{deleteTarget.usageCount === 1 ? "" : "s"} — they'll fall back to legacy inline credentials (if any).
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate({ id: deleteTarget.id })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin" />Removing…</> : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function ConnectionRowView({
  row, onRename, onDelete, onDetail, onVerifySuccess, onReconnect,
}: {
  row:             ConnectionRow;
  onRename:        () => void;
  onDelete:        () => void;
  onDetail:        () => void;
  onVerifySuccess: () => void;
  onReconnect?:    () => void;
}) {
  const v = visualFor(row);
  const Icon = v.icon;
  const h = healthFor(row);
  const isExpiredOAuth = (row.google?.expired || row.status === "expired") && row.type === "google_sheets";

  const verifyMutation = trpc.connections.verify.useMutation({
    onSuccess: (res) => {
      if (res.tokenRefreshed) toast.success("Token refreshed — connection active");
      else if (res.ok)        toast.success("Connection verified ✓");
      else                    toast.error(`Check failed: ${res.error ?? res.newStatus}`);
      onVerifySuccess();
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <li className={cn(
      "flex items-center gap-3 rounded-xl border bg-card p-3 shadow-sm transition-colors",
      "hover:border-border hover:bg-muted/10",
      h.label === "Active" ? "border-border/60" : "border-amber-300/60 dark:border-amber-700/40",
    )}>
      {/* Icon */}
      <button
        type="button"
        onClick={onDetail}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-opacity hover:opacity-80"
        style={{ backgroundColor: `${v.color}1A`, color: v.color }}
        title="View details"
      >
        <Icon className="h-4 w-4" strokeWidth={2.2} />
      </button>

      {/* Name + meta */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={onDetail}
            className="truncate text-sm font-medium text-foreground hover:underline underline-offset-2"
          >
            {row.displayName}
          </button>
          <HealthDot row={row} />
          <Badge variant="outline" className="h-5 shrink-0 rounded-full border-border/70 bg-muted/30 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {v.typeLabel}
          </Badge>
          {h.label !== "Active" && (
            <Badge variant="outline" className={cn(
              "h-5 shrink-0 rounded-full px-2 text-[10px] font-medium uppercase tracking-wider",
              h.label === "Expired"  && "border-amber-500/40 bg-amber-500/10 text-amber-600",
              h.label === "Error"    && "border-red-500/40 bg-red-500/10 text-red-600",
              h.label === "Revoked"  && "border-red-500/40 bg-red-500/10 text-red-600",
              h.label === "Not checked" && "border-slate-400/40 bg-slate-100/50 text-slate-500",
            )}>
              {h.label}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {v.detail}
          <span className="mx-1.5 text-border">·</span>
          {row.lastVerifiedAt ? <>Verified {formatTime(row.lastVerifiedAt)}</> : <>Added {formatDate(row.createdAt)}</>}
          {row.usageCount > 0 && (
            <><span className="mx-1.5 text-border">·</span><span className="text-emerald-600 dark:text-emerald-400">Used by {row.usageCount}</span></>
          )}
        </p>
      </div>

      {/* Verify / Re-connect */}
      {isExpiredOAuth && onReconnect ? (
        <Button variant="outline" size="sm" className="h-7 shrink-0 gap-1.5 text-xs text-amber-600 border-amber-400/60 hover:bg-amber-50" onClick={onReconnect}>
          <RefreshCw className="h-3 w-3" />
          Re-connect
        </Button>
      ) : (
        <Button
          variant="ghost" size="icon"
          className="h-7 w-7 shrink-0 rounded-lg text-muted-foreground hover:text-primary"
          title="Verify connection"
          disabled={verifyMutation.isPending}
          onClick={() => verifyMutation.mutate({ id: row.id })}
        >
          {verifyMutation.isPending
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Zap className="h-3.5 w-3.5" />}
        </Button>
      )}

      {/* Actions dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-lg" aria-label="Connection actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48 rounded-xl">
          <DropdownMenuItem onClick={onDetail} className="cursor-pointer">
            <ShieldCheck className="mr-2 h-4 w-4" />
            Health details
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRename} className="cursor-pointer">
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onDelete} className="cursor-pointer text-destructive focus:text-destructive">
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

// ─── Connection detail sheet ─────────────────────────────────────────────────

function ConnectionDetailSheet({
  row, onClose, onReconnect, onVerifySuccess,
}: {
  row:             ConnectionRow | null;
  onClose:         () => void;
  onReconnect?:    () => void;
  onVerifySuccess: () => void;
}) {
  const { data: logs = [], isLoading: logsLoading, refetch: refetchLogs } = trpc.connections.healthLogs.useQuery(
    { id: row?.id ?? 0, limit: 15 },
    { enabled: !!row },
  );

  const verifyMutation = trpc.connections.verify.useMutation({
    onSuccess: (res) => {
      if (res.tokenRefreshed) toast.success("Token refreshed — connection active");
      else if (res.ok)        toast.success("Connection verified ✓");
      else                    toast.error(`Check failed: ${res.error ?? res.newStatus}`);
      onVerifySuccess();
      void refetchLogs();
    },
    onError: (err) => toast.error(err.message),
  });

  if (!row) return null;

  const v   = visualFor(row);
  const h   = healthFor(row);
  const Icon = v.icon;

  return (
    <Sheet open={!!row} onOpenChange={o => !o && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col gap-0 p-0">
        <SheetHeader className="px-5 py-4 border-b">
          <SheetTitle className="flex items-center gap-2.5 text-sm">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ backgroundColor: `${v.color}1A`, color: v.color }}>
              <Icon className="h-3.5 w-3.5" strokeWidth={2.2} />
            </span>
            {row.displayName}
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Status card */}
          <div className={cn(
            "flex items-start gap-3 rounded-xl border px-4 py-3",
            h.label === "Active"   && "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30",
            h.label === "Expired"  && "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30",
            h.label === "Error"    && "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30",
            h.label === "Revoked"  && "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30",
            h.label === "Not checked" && "border-border bg-muted/20",
          )}>
            <h.icon className={cn("h-4 w-4 mt-0.5 shrink-0", h.color)} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">{h.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {row.lastVerifiedAt
                  ? `Last verified ${formatTime(row.lastVerifiedAt)} · ${new Date(row.lastVerifiedAt).toLocaleString("uz-UZ")}`
                  : "Never verified — click Verify to run a health check"}
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm" variant="outline" className="h-8 gap-1.5 text-xs"
              disabled={verifyMutation.isPending}
              onClick={() => verifyMutation.mutate({ id: row.id })}
            >
              {verifyMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              {verifyMutation.isPending ? "Verifying…" : "Verify now"}
            </Button>
            {(h.label === "Expired" || h.label === "Error") && row.type === "google_sheets" && onReconnect && (
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs text-amber-600 border-amber-400/60" onClick={() => { onClose(); onReconnect(); }}>
                <RefreshCw className="h-3.5 w-3.5" />
                Re-connect Google
              </Button>
            )}
          </div>

          {/* Meta */}
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between"><span className="text-muted-foreground">Type</span><span className="font-medium">{v.typeLabel}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Created</span><span>{formatDate(row.createdAt)}</span></div>
            {row.usageCount > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Used by</span>
                <span className="text-emerald-600 dark:text-emerald-400 font-medium">{row.usageCount} destination{row.usageCount === 1 ? "" : "s"}</span>
              </div>
            )}
            {row.type === "google_sheets" && row.google && (
              <div className="flex justify-between"><span className="text-muted-foreground">Account</span><span className="truncate max-w-[180px]">{row.google.email}</span></div>
            )}
            {row.type === "telegram_bot" && row.telegram && (
              <div className="flex justify-between"><span className="text-muted-foreground">Chat ID</span><span className="font-mono">{row.telegram.chatId}</span></div>
            )}
          </div>

          {/* Health log */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Health history</p>
            {logsLoading ? (
              <div className="space-y-1.5">
                {[0,1,2].map(i => <div key={i} className="h-8 rounded-lg bg-muted animate-pulse" />)}
              </div>
            ) : logs.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">No health checks yet — press Verify above.</p>
            ) : (
              <ul className="space-y-1.5">
                {(logs as HealthLog[]).map(log => (
                  <HealthLogRow key={log.id} log={log} />
                ))}
              </ul>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function HealthLogRow({ log }: { log: HealthLog }) {
  const ok = log.checkStatus === "ok";
  return (
    <li className={cn(
      "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
      ok
        ? "border-emerald-200/60 bg-emerald-50/50 dark:border-emerald-800/40 dark:bg-emerald-950/20"
        : "border-red-200/60 bg-red-50/50 dark:border-red-800/40 dark:bg-red-950/20",
    )}>
      {ok
        ? <ShieldCheck className="h-3 w-3 text-emerald-600 shrink-0" />
        : <XCircle className="h-3 w-3 text-red-500 shrink-0" />}
      <span className={cn("font-medium capitalize shrink-0", ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
        {log.checkStatus}
      </span>
      {log.latencyMs != null && (
        <span className="text-muted-foreground shrink-0">{log.latencyMs}ms</span>
      )}
      {log.errorMessage && (
        <span className="text-muted-foreground truncate flex-1">{log.errorMessage}</span>
      )}
      <span className="ml-auto text-muted-foreground/70 shrink-0 tabular-nums">{formatTime(log.checkedAt)}</span>
    </li>
  );
}

// ─── Rename dialog ───────────────────────────────────────────────────────────

function RenameConnectionDialog({ target, onClose }: { target: ConnectionRow | null; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState("");
  useMemo(() => { if (target) setValue(target.displayName); }, [target]);

  const mutation = trpc.connections.rename.useMutation({
    onSuccess: () => { toast.success("Connection renamed"); utils.connections.list.invalidate(); onClose(); },
    onError: (err) => toast.error(err.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === target.displayName) { onClose(); return; }
    mutation.mutate({ id: target.id, displayName: trimmed });
  };

  return (
    <Dialog open={target !== null} onOpenChange={v => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Rename connection</DialogTitle>
            <DialogDescription>Just a label — credentials and linked destinations are untouched.</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-1.5">
            <Label htmlFor="rename-conn" className="text-xs">Connection name</Label>
            <Input id="rename-conn" autoFocus value={value} onChange={e => setValue(e.target.value)} className="h-10" />
          </div>
          <DialogFooter className="mt-5 gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!value.trim() || mutation.isPending}>
              {mutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
