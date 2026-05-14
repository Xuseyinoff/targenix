import { useEffect, useMemo, useState } from "react";
import SettingsLayout from "@/components/SettingsLayout";
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
import { toast } from "sonner";
import { Loader2, Lock, Mail, Trash2, User } from "lucide-react";
import { useT } from "@/hooks/useT";

export default function SettingsProfile() {
  const t = useT();
  const utils = trpc.useUtils();
  const { data: me } = trpc.auth.me.useQuery();

  const isEmailAccount = useMemo(() => {
    return (me?.loginMethod ?? null) === "email";
  }, [me?.loginMethod]);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  useEffect(() => {
    setName(me?.name ?? "");
    setEmail(me?.email ?? "");
  }, [me?.name, me?.email]);

  const updateProfileMutation = trpc.auth.updateProfile.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      toast.success(t("profile.profileUpdated"));
    },
    onError: (e) => toast.error(e.message),
  });

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");

  const changePasswordMutation = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      toast.success(t("profile.passwordUpdated"));
    },
    onError: (e) => toast.error(e.message),
  });

  // ─── Danger zone (delete account) ─────────────────────────────────────────
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const deleteAccountMutation = trpc.auth.deleteAccount.useMutation({
    onSuccess: () => {
      toast.success(t("settings.accountDeleted"));
      window.location.href = "/";
    },
    onError: (err) => toast.error(err.message),
  });
  // The confirmation word stays in English ("DELETE") for safety — it's a
  // destructive action and must read identically in every locale.
  const CONFIRM_WORD = "DELETE";

  return (
    <SettingsLayout title={t("profile.title")} description={t("profile.subtitle")}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <User className="h-4 w-4" />
            {t("profile.name")}
          </CardTitle>
          <CardDescription>{t("profile.nameDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("profile.namePlaceholder")} />
          <div className="flex justify-end">
            <Button
              onClick={() => updateProfileMutation.mutate({ name })}
              disabled={updateProfileMutation.isPending || !name.trim()}
            >
              {updateProfileMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("profile.saveName")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4" />
            {t("profile.email")}
          </CardTitle>
          <CardDescription>{t("profile.emailDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("profile.emailPlaceholder")}
            disabled={!isEmailAccount}
          />
          {!isEmailAccount && (
            <p className="text-xs text-muted-foreground">
              {t("profile.socialLoginNote")}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={() => updateProfileMutation.mutate({ email })}
              disabled={updateProfileMutation.isPending || !isEmailAccount || !email.trim()}
            >
              {updateProfileMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("profile.saveEmail")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="h-4 w-4" />
            {t("profile.password")}
          </CardTitle>
          <CardDescription>{t("profile.passwordDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder={t("profile.currentPassword")}
            type="password"
            disabled={!isEmailAccount}
          />
          <Input
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t("profile.newPassword")}
            type="password"
            disabled={!isEmailAccount}
          />
          <Input
            value={confirmNewPassword}
            onChange={(e) => setConfirmNewPassword(e.target.value)}
            placeholder={t("profile.confirmPassword")}
            type="password"
            disabled={!isEmailAccount}
          />
          {!isEmailAccount && (
            <p className="text-xs text-muted-foreground">
              {t("profile.socialPasswordNote")}
            </p>
          )}
          <div className="flex justify-end">
            <Button
              onClick={() => {
                if (newPassword !== confirmNewPassword) {
                  toast.error(t("profile.passwordsNoMatch"));
                  return;
                }
                changePasswordMutation.mutate({ currentPassword, newPassword });
              }}
              disabled={
                changePasswordMutation.isPending ||
                !isEmailAccount ||
                !currentPassword ||
                newPassword.length < 8 ||
                newPassword !== confirmNewPassword
              }
            >
              {changePasswordMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("profile.updatePassword")}
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
              <CardDescription>{t("settings.dangerZoneDesc")}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            {t("settings.deleteWarning")} <strong>{t("settings.deleteWarningBold")}</strong>
          </p>
          <Button variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="h-4 w-4 mr-2" />
            {t("settings.deleteMyAccount")}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={showDeleteDialog} onOpenChange={(v) => { setShowDeleteDialog(v); setDeleteConfirm(""); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-destructive">{t("settings.deleteAccount")}</DialogTitle>
            <DialogDescription>
              {t("settings.deleteAccountDesc")} <strong>{CONFIRM_WORD}</strong>{" "}
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
    </SettingsLayout>
  );
}
