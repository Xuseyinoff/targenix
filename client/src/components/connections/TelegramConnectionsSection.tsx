/**
 * TelegramConnectionsSection — card list of saved Telegram bot connections.
 *
 * Unlike Google (OAuth popup), Telegram connections are created by the user
 * pasting a BotFather token + a chat id. Before storage the server validates
 * the pairing by sending a test message via `sendTelegramRawMessage`. This
 * matches the existing Telegram destination form but the credentials are now
 * saved as a reusable library entry instead of being buried inside every
 * destination's templateConfig.
 */

import * as React from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import {
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Send,
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
import { trpc } from "@/lib/trpc";

export function TelegramConnectionsSection() {
  const t = useT();
  const utils = trpc.useUtils();

  const { data: connections = [], isLoading } = trpc.connections.list.useQuery({
    type: "telegram_bot",
  });

  const [connectOpen, setConnectOpen] = React.useState(false);
  const [form, setForm] = React.useState({ displayName: "", botToken: "", chatId: "" });

  const [renameTarget, setRenameTarget] = React.useState<
    { id: number; currentName: string } | null
  >(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [disconnectTarget, setDisconnectTarget] = React.useState<
    { id: number; name: string; usageCount: number } | null
  >(null);

  const createMutation = trpc.connections.createTelegramBot.useMutation({
    onSuccess: () => {
      toast.success(t("connections.telegram.connectSuccess"));
      utils.connections.list.invalidate();
      setConnectOpen(false);
      setForm({ displayName: "", botToken: "", chatId: "" });
    },
    onError: (err) => toast.error(err.message),
  });

  const renameMutation = trpc.connections.rename.useMutation({
    onSuccess: () => {
      toast.success(t("connections.telegram.renameSuccess"));
      utils.connections.list.invalidate();
      setRenameTarget(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const disconnectMutation = trpc.connections.disconnect.useMutation({
    onSuccess: (res) => {
      toast.success(
        t("connections.telegram.disconnectSuccess", { count: res.clearedDestinations }),
      );
      utils.connections.list.invalidate();
      utils.targetWebsites.list.invalidate();
      setDisconnectTarget(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const connectButton = (
    <Button
      type="button"
      onClick={() => setConnectOpen(true)}
      className="gap-2 rounded-xl bg-[#0088cc] font-medium text-white shadow-sm transition-all hover:bg-[#0077b3] hover:shadow-md active:scale-[0.99] min-h-10"
    >
      <Plus className="h-4 w-4" />
      {t("connections.telegram.connect")}
    </Button>
  );

  return (
    <section className="space-y-3 md:space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight text-foreground md:text-lg">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#0088cc]/10 ring-1 ring-[#0088cc]/15">
              <Send className="h-3.5 w-3.5 text-[#0088cc]" />
            </span>
            {t("connections.telegram.title")}
          </h2>
          <p className="mt-1 text-xs leading-snug text-muted-foreground md:text-sm">
            {t("connections.telegram.subtitle")}
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
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#0088cc]/10">
            <Send className="h-5 w-5 text-[#0088cc]" />
          </div>
          <p className="text-sm font-medium text-foreground">
            {t("connections.telegram.emptyTitle")}
          </p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {t("connections.telegram.emptyBody")}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {connections.map((c) => (
            <li
              key={c.id}
              className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-3 shadow-sm transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:gap-4 sm:p-4"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#0088cc]/10 ring-1 ring-[#0088cc]/15">
                  <Send className="h-4 w-4 text-[#0088cc]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="truncate font-medium text-foreground">
                      {c.displayName}
                    </span>
                    <Badge
                      variant="secondary"
                      className="border-emerald-200/60 bg-emerald-50 text-emerald-800 text-[10px] font-medium uppercase tracking-wide dark:bg-emerald-950/40 dark:text-emerald-300"
                    >
                      {t("connections.telegram.active")}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    {c.telegram?.chatId && (
                      <span className="truncate font-mono">
                        chat: {c.telegram.chatId}
                      </span>
                    )}
                    {c.usageCount > 0 && (
                      <>
                        <span className="text-border">·</span>
                        <span className="inline-flex items-center gap-1 text-[11px]">
                          <Users className="h-3 w-3" />
                          {t("connections.telegram.usedBy", { count: c.usageCount })}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 shrink-0 border-t border-border/50 pt-3 sm:border-t-0 sm:pt-0">
                {c.usageCount > 0 && (
                  <Button asChild type="button" variant="ghost" size="sm" className="h-9 text-xs">
                    <Link href="/destinations">
                      {t("connections.telegram.viewDestinations")}
                    </Link>
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-10 w-10 rounded-xl border-border/80"
                      aria-label={t("connections.telegram.actions")}
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
                      {t("connections.telegram.rename")}
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
                      {t("connections.telegram.disconnect")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("connections.telegram.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("connections.telegram.dialogBody")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="tg-name">{t("connections.telegram.nameLabel")}</Label>
              <Input
                id="tg-name"
                placeholder={t("connections.telegram.namePlaceholder")}
                value={form.displayName}
                maxLength={255}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tg-token">{t("connections.telegram.tokenLabel")}</Label>
              <Input
                id="tg-token"
                placeholder="123456:AAH..."
                value={form.botToken}
                maxLength={255}
                onChange={(e) => setForm({ ...form, botToken: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {t("connections.telegram.tokenHelp")}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tg-chat">{t("connections.telegram.chatLabel")}</Label>
              <Input
                id="tg-chat"
                placeholder="-100..."
                value={form.chatId}
                maxLength={255}
                onChange={(e) => setForm({ ...form, chatId: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                {t("connections.telegram.chatHelp")}
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={() => setConnectOpen(false)}
              disabled={createMutation.isPending}
            >
              {t("connections.telegram.cancel")}
            </Button>
            <Button
              type="button"
              className="rounded-xl bg-[#0088cc] text-white hover:bg-[#0077b3]"
              disabled={
                createMutation.isPending ||
                !form.displayName.trim() ||
                !form.botToken.trim() ||
                !form.chatId.trim()
              }
              onClick={() =>
                createMutation.mutate({
                  displayName: form.displayName.trim(),
                  botToken: form.botToken.trim(),
                  chatId: form.chatId.trim(),
                })
              }
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t("connections.telegram.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!renameTarget}
        onOpenChange={(open) => !open && setRenameTarget(null)}
      >
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("connections.telegram.renameTitle")}</DialogTitle>
            <DialogDescription>
              {t("connections.telegram.renameBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-telegram">{t("connections.telegram.renameLabel")}</Label>
            <Input
              id="rename-telegram"
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
              {t("connections.telegram.cancel")}
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
              {t("connections.telegram.save")}
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
              {t("connections.telegram.disconnectTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {disconnectTarget?.usageCount
                ? t("connections.telegram.disconnectBodyInUse", {
                    count: disconnectTarget.usageCount,
                    name: disconnectTarget.name,
                  })
                : t("connections.telegram.disconnectBody", {
                    name: disconnectTarget?.name ?? "",
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel className="rounded-xl">
              {t("connections.telegram.cancel")}
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
              {t("connections.telegram.disconnectConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
