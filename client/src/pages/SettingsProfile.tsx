import { useEffect, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Loader2, Lock, Mail, User } from "lucide-react";
import { useLocation } from "wouter";

export default function SettingsProfile() {
  const utils = trpc.useUtils();
  const [, setLocation] = useLocation();
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
      toast.success("Profile updated.");
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
      toast.success("Password updated.");
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <DashboardLayout>
      <div className="p-6 max-w-2xl space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Update your personal account details.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setLocation("/settings")} className="shrink-0">
            Back
          </Button>
        </div>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4" />
              Name
            </CardTitle>
            <CardDescription>Your display name in the dashboard.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
            <div className="flex justify-end">
              <Button
                onClick={() => updateProfileMutation.mutate({ name })}
                disabled={updateProfileMutation.isPending || !name.trim()}
              >
                {updateProfileMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save name
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Email
            </CardTitle>
            <CardDescription>
              Change your login email. Only available for email/password accounts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              disabled={!isEmailAccount}
            />
            {!isEmailAccount && (
              <p className="text-xs text-muted-foreground">
                This account uses a social login method, so email can’t be changed here.
              </p>
            )}
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => updateProfileMutation.mutate({ email })}
                disabled={updateProfileMutation.isPending || !isEmailAccount || !email.trim()}
              >
                {updateProfileMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save email
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="h-4 w-4" />
              Password
            </CardTitle>
            <CardDescription>
              Update your password. Only available for email/password accounts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              type="password"
              disabled={!isEmailAccount}
            />
            <Input
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (min 8 chars)"
              type="password"
              disabled={!isEmailAccount}
            />
            <Input
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              placeholder="Confirm new password"
              type="password"
              disabled={!isEmailAccount}
            />
            {!isEmailAccount && (
              <p className="text-xs text-muted-foreground">
                This account uses a social login method, so password can’t be changed here.
              </p>
            )}
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  if (newPassword !== confirmNewPassword) {
                    toast.error("New passwords do not match.");
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
                Update password
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

