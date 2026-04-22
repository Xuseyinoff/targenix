/**
 * ConnectionsList — unified /connections table (Phase 2C, Day 2).
 *
 * Replaces the old bespoke Google + Telegram connection cards with a single
 * rows-driven list that shows every saved credential the user owns:
 * Google Sheets OAuth, Telegram bots, and admin-template API keys.
 *
 * Design goals that dictated the shape of this file:
 *   • One table row per connection, type-agnostic. A user with 50 affiliate
 *     API keys and 2 Google accounts should see one scrollable list, not
 *     three bespoke cards.
 *   • Per-row actions (rename, delete) inline via a dropdown. Destructive
 *     actions surface the "used by N integrations" hint so the user knows
 *     what breaks before they confirm.
 *   • Schema-driven: adding a new connection type later (oauth2_slack,
 *     basic_auth, …) only requires teaching `visualFor()` how to map the
 *     type to an icon + metadata. The rest of the table is type-agnostic.
 *   • No destructive fallthrough on delete — we call `connections.disconnect`
 *     which already nulls out targetWebsites.connectionId so delivery adapters
 *     keep reading legacy templateConfig secrets.
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
  Send,
  Table2,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Link as LinkIcon,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";

// ─── Types ───────────────────────────────────────────────────────────────────

type ConnectionRow =
  inferRouterOutputs<AppRouter>["connections"]["list"][number];

type TypeVisuals = {
  icon: LucideIcon;
  color: string;
  /** Short label shown in the type badge — always stable, never localised */
  typeLabel: string;
  /** One-line secondary detail under the name (email, chatId, etc.). */
  detail: string;
};

function visualFor(row: ConnectionRow): TypeVisuals {
  if (row.type === "google_sheets") {
    return {
      icon: Table2,
      color: "#0F9D58",
      typeLabel: "Google Sheets",
      detail: row.google?.email ?? "—",
    };
  }
  if (row.type === "telegram_bot") {
    return {
      icon: Send,
      color: "#229ED9",
      typeLabel: "Telegram",
      detail: row.telegram?.chatId
        ? `chat id ${row.telegram.chatId}`
        : "No chat id",
    };
  }
  // api_key — the only remaining type in the discriminated union.
  const keys = row.apiKey?.secretKeys ?? [];
  return {
    icon: KeyRound,
    color: row.apiKey?.templateColor ?? "#6366F1",
    typeLabel: row.apiKey?.templateName ?? "API key",
    detail:
      keys.length === 0
        ? "No secrets stored"
        : keys.length === 1
          ? `${keys[0]} encrypted`
          : `${keys.length} secrets encrypted`,
  };
}

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ConnectionsList() {
  const utils = trpc.useUtils();
  const { data: rows = [], isLoading } = trpc.connections.list.useQuery();

  const [renameTarget, setRenameTarget] = useState<ConnectionRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConnectionRow | null>(null);

  const sortedRows = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [rows],
  );

  const deleteMutation = trpc.connections.disconnect.useMutation({
    onSuccess: (res) => {
      toast.success(
        res.clearedDestinations > 0
          ? `Connection removed · ${res.clearedDestinations} destination(s) now point to the fallback`
          : "Connection removed",
      );
      utils.connections.list.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3 shadow-sm animate-pulse"
          >
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
        <p className="text-sm font-medium text-foreground">
          No delivery connections yet
        </p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Press{" "}
          <span className="font-medium text-foreground">+ Add connection</span>{" "}
          above to link Google Sheets, Telegram, or an affiliate API key. Once
          saved they become reusable across every integration.
        </p>
      </div>
    );
  }

  return (
    <>
      <ul className="space-y-2">
        {sortedRows.map((row) => (
          <ConnectionRowView
            key={row.id}
            row={row}
            onRename={() => setRenameTarget(row)}
            onDelete={() => setDeleteTarget(row)}
          />
        ))}
      </ul>

      <RenameConnectionDialog
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
      >
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">
                {deleteTarget?.displayName}
              </span>{" "}
              will be deleted. Credentials are erased and cannot be recovered.
              {deleteTarget && deleteTarget.usageCount > 0 && (
                <span className="mt-2 block rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  Used by {deleteTarget.usageCount} destination
                  {deleteTarget.usageCount === 1 ? "" : "s"} — they'll fall
                  back to their legacy inline credentials (if any) and may
                  stop delivering until reconnected.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() =>
                deleteTarget &&
                deleteMutation.mutate({ id: deleteTarget.id })
              }
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Removing…
                </>
              ) : (
                "Remove"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function ConnectionRowView({
  row,
  onRename,
  onDelete,
}: {
  row: ConnectionRow;
  onRename: () => void;
  onDelete: () => void;
}) {
  const v = visualFor(row);
  const Icon = v.icon;
  const statusBad = row.status !== "active" || row.google?.expired;

  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border/60 bg-card p-3 shadow-sm transition-colors",
        "hover:border-border hover:bg-muted/10",
      )}
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: `${v.color}1A`, color: v.color }}
      >
        <Icon className="h-4 w-4" strokeWidth={2.2} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">
            {row.displayName}
          </span>
          <Badge
            variant="outline"
            className="h-5 shrink-0 rounded-full border-border/70 bg-muted/30 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            {v.typeLabel}
          </Badge>
          {statusBad && (
            <Badge
              variant="outline"
              className="h-5 shrink-0 rounded-full border-amber-500/40 bg-amber-500/10 px-2 text-[10px] font-medium uppercase tracking-wider text-amber-600"
            >
              {row.google?.expired ? "Expired" : row.status}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {v.detail}
          <span className="mx-1.5 text-border">·</span>
          Added {formatDate(row.createdAt)}
          {row.usageCount > 0 && (
            <>
              <span className="mx-1.5 text-border">·</span>
              <span className="text-emerald-600 dark:text-emerald-400">
                Used by {row.usageCount}
              </span>
            </>
          )}
        </p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-lg"
            aria-label="Connection actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44 rounded-xl">
          <DropdownMenuItem onClick={onRename} className="cursor-pointer">
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onDelete}
            className="cursor-pointer text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

// ─── Rename dialog ───────────────────────────────────────────────────────────

function RenameConnectionDialog({
  target,
  onClose,
}: {
  target: ConnectionRow | null;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [value, setValue] = useState("");

  // Sync the input with whichever row is currently being edited; resets when
  // the dialog opens for a different connection.
  useMemo(() => {
    if (target) setValue(target.displayName);
  }, [target]);

  const mutation = trpc.connections.rename.useMutation({
    onSuccess: () => {
      toast.success("Connection renamed");
      utils.connections.list.invalidate();
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!target) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === target.displayName) {
      onClose();
      return;
    }
    mutation.mutate({ id: target.id, displayName: trimmed });
  };

  return (
    <Dialog open={target !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Rename connection</DialogTitle>
            <DialogDescription>
              Just a label — credentials and linked destinations are
              untouched.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-1.5">
            <Label htmlFor="rename-conn" className="text-xs">
              Connection name
            </Label>
            <Input
              id="rename-conn"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-10"
            />
          </div>

          <DialogFooter className="mt-5 gap-2 sm:gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!value.trim() || mutation.isPending}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
