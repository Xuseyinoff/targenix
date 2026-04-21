/**
 * TelegramConnectDialog — reusable "Connect Telegram bot" modal.
 *
 * Shared between the `/connections` management page and inline surfaces like
 * the destination wizard's `ConnectionPicker`. Keeps the credential form and
 * server probe logic in one place so both entry points stay in sync.
 *
 * On successful creation it:
 *   1. Invalidates `connections.list` so the picker shows the new entry.
 *   2. Fires `onCreated(id, displayName)` so the caller can auto-select it.
 *   3. Closes the dialog and resets the form.
 */

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { useT } from "@/hooks/useT";
import { trpc } from "@/lib/trpc";

export interface TelegramConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fired after the server has validated + persisted the bot+chat pair.
   * Receives the new connection id so callers can auto-select it.
   */
  onCreated?: (connectionId: number, displayName: string) => void;
  /** Optional seed for the display name field (e.g. "My shop bot"). */
  defaultDisplayName?: string;
}

const INITIAL_FORM = {
  displayName: "",
  botToken: "",
  chatId: "",
};

export function TelegramConnectDialog({
  open,
  onOpenChange,
  onCreated,
  defaultDisplayName = "",
}: TelegramConnectDialogProps) {
  const t = useT();
  const utils = trpc.useUtils();
  const [form, setForm] = React.useState(() => ({
    ...INITIAL_FORM,
    displayName: defaultDisplayName,
  }));

  // Re-seed when the caller supplies a new default name (e.g. picker context).
  React.useEffect(() => {
    if (open) {
      setForm((prev) =>
        prev.displayName || !defaultDisplayName
          ? prev
          : { ...prev, displayName: defaultDisplayName },
      );
    } else {
      setForm({ ...INITIAL_FORM, displayName: defaultDisplayName });
    }
    // We only want to react to open/defaultDisplayName flipping, not form edits
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultDisplayName]);

  const createMutation = trpc.connections.createTelegramBot.useMutation({
    onSuccess: (res) => {
      toast.success(t("connections.telegram.connectSuccess"));
      void utils.connections.list.invalidate();
      const id = typeof res?.id === "number" ? res.id : null;
      const displayName = form.displayName.trim();
      if (id != null && onCreated) {
        onCreated(id, displayName);
      }
      onOpenChange(false);
      setForm({ ...INITIAL_FORM, displayName: defaultDisplayName });
    },
    onError: (err) => toast.error(err.message),
  });

  const canSubmit =
    !createMutation.isPending &&
    form.displayName.trim().length > 0 &&
    form.botToken.trim().length >= 10 &&
    form.chatId.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    createMutation.mutate({
      displayName: form.displayName.trim(),
      botToken: form.botToken.trim(),
      chatId: form.chatId.trim(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            {t("connections.telegram.cancel")}
          </Button>
          <Button
            type="button"
            className="rounded-xl bg-[#0088cc] text-white hover:bg-[#0077b3]"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {createMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {t("connections.telegram.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
