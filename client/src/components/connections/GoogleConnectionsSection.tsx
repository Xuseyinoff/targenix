/**
 * GoogleConnectionsSection — card list of saved Google connections.
 *
 * Used inside /connections page below the Facebook section. Each row shows:
 *   • profile picture / fallback icon
 *   • email + optional display name
 *   • status badge (Active / Expired)
 *   • "used by N destinations" footer link
 *   • rename / disconnect actions in a dropdown
 *
 * The "Connect" button opens the existing Google OAuth popup used by the
 * Google Sheets destination form; on success it refetches the connections
 * list so the new row appears inline.
 */

import * as React from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Unlink,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { useGoogleOAuthPopup } from "@/hooks/useGoogleOAuthPopup";

// Google-branded circle to match Facebook's blue bubble in the section above.
const GOOGLE_COLOR = "#0F9D58";

export function GoogleConnectionsSection() {
  const t = useT();
  const utils = trpc.useUtils();

  const {
    data: connections = [],
    isLoading,
    refetch,
  } = trpc.connections.list.useQuery({ type: "google_sheets" });

  const [renameTarget, setRenameTarget] = React.useState<
    | { id: number; currentName: string }
    | null
  >(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [disconnectTarget, setDisconnectTarget] = React.useState<
    { id: number; name: string; usageCount: number } | null
  >(null);

  const renameMutation = trpc.connections.rename.useMutation({
    onSuccess: () => {
      toast.success(t("connections.google.renameSuccess"));
      utils.connections.list.invalidate();
      setRenameTarget(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const disconnectMutation = trpc.connections.disconnect.useMutation({
    onSuccess: (res) => {
      toast.success(
        t("connections.google.disconnectSuccess", { count: res.clearedDestinations }),
      );
      utils.connections.list.invalidate();
      utils.targetWebsites.list.invalidate();
      setDisconnectTarget(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const { start: startOAuth, isConnecting } = useGoogleOAuthPopup({
    onConnected: (_accountId, email) => {
      toast.success(
        email
          ? t("connections.google.connectedWithEmail", { email })
          : t("connections.google.connected"),
      );
      void refetch();
    },
    onError: (message) => {
      toast.error(message || t("connections.google.connectFailed"));
    },
  });

  const connectButton = (
    <Button
      type="button"
      onClick={() => void startOAuth()}
      disabled={isConnecting}
      className={cn(
        "gap-2 rounded-xl font-medium text-white shadow-sm transition-all hover:shadow-md active:scale-[0.99] min-h-10",
        "bg-[#0F9D58] hover:bg-[#0b8849]",
      )}
    >
      {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
      {isConnecting
        ? t("connections.google.connecting")
        : t("connections.google.connect")}
    </Button>
  );

  return (
    <section className="space-y-3 md:space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground md:text-lg">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#0F9D58]/10 ring-1 ring-[#0F9D58]/15">
              <GoogleIcon />
            </span>
            {t("connections.google.title")}
          </h2>
          <p className="mt-1 text-xs leading-snug text-muted-foreground md:text-sm">
            {t("connections.google.subtitle")}
          </p>
        </div>
        <div className="shrink-0">{connectButton}</div>
      </header>

      {isLoading ? (
        <div className="rounded-2xl border border-border/60 bg-card p-6 animate-pulse">
          <div className="h-10 w-40 rounded-md bg-muted" />
        </div>
      ) : connections.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-muted/10 px-6 py-10 text-center">
          <div
            className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl"
            style={{ backgroundColor: `${GOOGLE_COLOR}1a` }}
          >
            <GoogleIcon large />
          </div>
          <p className="text-sm font-medium text-foreground">
            {t("connections.google.emptyTitle")}
          </p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {t("connections.google.emptyBody")}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {connections.map((c) => {
            const email = c.google?.email ?? c.displayName;
            const expired = c.google?.expired ?? c.status !== "active";
            return (
              <li
                key={c.id}
                className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-3 shadow-sm transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:gap-4 sm:p-4"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {c.google?.picture ? (
                    <img
                      src={c.google.picture}
                      alt={email}
                      className="h-10 w-10 shrink-0 rounded-full object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0F9D58]/10 ring-1 ring-[#0F9D58]/15">
                      <GoogleIcon />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="truncate font-medium text-foreground">
                        {c.displayName}
                      </span>
                      {expired ? (
                        <Badge
                          variant="outline"
                          className="border-red-200 bg-red-50 text-red-700 text-[10px] uppercase"
                        >
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          {t("connections.google.expired")}
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="border-emerald-200/60 bg-emerald-50 text-emerald-800 text-[10px] font-medium uppercase tracking-wide dark:bg-emerald-950/40 dark:text-emerald-300"
                        >
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          {t("connections.google.active")}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      {c.google?.email && (
                        <span className="truncate">{c.google.email}</span>
                      )}
                      {c.usageCount > 0 && (
                        <>
                          <span className="text-border">·</span>
                          <span className="inline-flex items-center gap-1 text-[11px]">
                            <Users className="h-3 w-3" />
                            {t("connections.google.usedBy", { count: c.usageCount })}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 shrink-0 border-t border-border/50 pt-3 sm:border-t-0 sm:pt-0">
                  {c.usageCount > 0 && (
                    <Button asChild type="button" variant="ghost" size="sm" className="h-9 text-xs">
                      <Link href="/destinations">{t("connections.google.viewDestinations")}</Link>
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-10 w-10 rounded-xl border-border/80"
                        aria-label={t("connections.google.actions")}
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48 rounded-xl">
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onClick={() => {
                          setRenameTarget({ id: c.id, currentName: c.displayName });
                          setRenameValue(c.displayName);
                        }}
                      >
                        <Pencil className="mr-2 h-4 w-4" />
                        {t("connections.google.rename")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive focus:text-destructive"
                        onClick={() =>
                          setDisconnectTarget({
                            id: c.id,
                            name: c.displayName,
                            usageCount: c.usageCount,
                          })
                        }
                      >
                        <Unlink className="mr-2 h-4 w-4" />
                        {t("connections.google.disconnect")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
      >
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("connections.google.renameTitle")}</DialogTitle>
            <DialogDescription>
              {t("connections.google.renameBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-connection">{t("connections.google.renameLabel")}</Label>
            <Input
              id="rename-connection"
              value={renameValue}
              maxLength={255}
              onChange={(e) => setRenameValue(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={() => setRenameTarget(null)}
            >
              {t("connections.google.cancel")}
            </Button>
            <Button
              type="button"
              className="rounded-xl"
              disabled={renameMutation.isPending || !renameValue.trim()}
              onClick={() => {
                if (!renameTarget) return;
                renameMutation.mutate({
                  id: renameTarget.id,
                  displayName: renameValue.trim(),
                });
              }}
            >
              {renameMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t("connections.google.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => !open && setDisconnectTarget(null)}
      >
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("connections.google.disconnectTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {disconnectTarget?.usageCount
                ? t("connections.google.disconnectBodyInUse", {
                    count: disconnectTarget.usageCount,
                    name: disconnectTarget.name,
                  })
                : t("connections.google.disconnectBody", {
                    name: disconnectTarget?.name ?? "",
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel className="rounded-xl">
              {t("connections.google.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                if (!disconnectTarget) return;
                disconnectMutation.mutate({ id: disconnectTarget.id });
              }}
            >
              {disconnectMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t("connections.google.disconnectConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// Inline Google "G" SVG so we don't pull a whole icon dependency.
function GoogleIcon({ large }: { large?: boolean } = {}) {
  const size = large ? 24 : 16;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.7 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.5 16 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.7 6.1 29.6 4 24 4 16.2 4 9.5 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.5 0 10.5-2.1 14.3-5.5l-6.6-5.4C29.5 34.7 26.9 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.5 39.7 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4 5.8l6.6 5.4C41.6 36.1 44 30.5 44 24c0-1.2-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}
