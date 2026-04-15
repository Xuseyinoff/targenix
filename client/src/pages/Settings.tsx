import { useState } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Loader2, Mail, Send, Trash2, User } from "lucide-react";
import { useT } from "@/hooks/useT";

export default function Settings() {
  const [, setLocation] = useLocation();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const t = useT();

  const deleteAccountMutation = trpc.auth.deleteAccount.useMutation({
    onSuccess: () => {
      toast.success(t("settings.accountDeleted"));
      window.location.href = "/";
    },
    onError: (err) => toast.error(err.message),
  });

  // The confirmation word stays in English ("DELETE") for safety — it's a destructive action
  const CONFIRM_WORD = "DELETE";

  return (
    <DashboardLayout>
      <div className="p-6 max-w-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("settings.subtitle")}
          </p>
        </div>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("settings.integrations")}</CardTitle>
            <CardDescription>{t("settings.integrationsDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <User className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t("settings.profile")}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {t("settings.profileDesc")}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLocation("/settings/profile")}
                className="shrink-0"
              >
                {t("common.open")}
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-lg bg-[#229ED9]/10 flex items-center justify-center shrink-0">
                  <Send className="h-5 w-5 text-[#229ED9]" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t("settings.telegram")}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {t("settings.telegramDesc")}
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => setLocation("/settings/telegram")} className="shrink-0">
                {t("common.open")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-destructive/10 flex items-center justify-center">
                <Trash2 className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <CardTitle className="text-base text-destructive">{t("settings.dangerZone")}</CardTitle>
                <CardDescription>
                  {t("settings.dangerZoneDesc")}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              {t("settings.deleteWarning")}{" "}
              <strong>{t("settings.deleteWarningBold")}</strong>
            </p>
            <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
              <Trash2 className="h-4 w-4 mr-2" />
              {t("settings.deleteMyAccount")}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Dialog open={showDeleteDialog} onOpenChange={(v) => { setShowDeleteDialog(v); setDeleteConfirm(""); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-destructive">{t("settings.deleteAccount")}</DialogTitle>
            <DialogDescription>
              {t("settings.deleteAccountDesc")}{" "}
              <strong>{CONFIRM_WORD}</strong>{" "}
              {t("settings.deleteAccountDescEnd")}
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder={t("settings.deleteTypePlaceholder")}
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            autoComplete="off"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDeleteDialog(false); setDeleteConfirm(""); }}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={deleteConfirm !== CONFIRM_WORD || deleteAccountMutation.isPending}
              onClick={() => deleteAccountMutation.mutate()}
            >
              {deleteAccountMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("settings.deletePermanently")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
