import DashboardLayout from "@/components/DashboardLayout";
import { DisconnectFacebookAccountDialog } from "@/components/DisconnectFacebookAccountDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { Facebook, Loader2, Trash2, User, AlertTriangle, RefreshCw } from "lucide-react";
import { useState, useCallback, useMemo } from "react";
import { toast } from "sonner";

// ─── Facebook JS SDK type declarations ────────────────────────────────────────
declare global {
  interface Window {
    FB: {
      login: (
        callback: (response: { authResponse?: { accessToken: string }; status: string }) => void,
        options: { scope: string; return_scopes?: boolean }
      ) => void;
      getLoginStatus: (callback: (response: { status: string }) => void) => void;
      logout: (callback: () => void) => void;
    };
    fbAsyncInit?: () => void;
  }
}

// Required Facebook permissions for lead ads
const FB_SCOPE =
  "pages_show_list,leads_retrieval,pages_read_engagement,pages_manage_ads,pages_manage_metadata";

export default function FacebookAccounts() {
  const utils = trpc.useUtils();
  const { data: accounts, isLoading } = trpc.facebookAccounts.list.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const [connecting, setConnecting] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const connectMutation = trpc.facebookAccounts.connect.useMutation({
    onSuccess: (data) => {
      toast.success(`Connected: ${data.fbUserName}`);
      utils.facebookAccounts.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
      setConnecting(false);
    },
  });

  const disconnectAccountName = useMemo(() => {
    if (deleteId == null || !accounts?.length) return "";
    return accounts.find((a) => a.id === deleteId)?.fbUserName ?? "";
  }, [deleteId, accounts]);

  // ── Facebook Login popup ───────────────────────────────────────────────────
  const handleFacebookLogin = useCallback(() => {
    if (!window.FB) {
      toast.error("Facebook SDK not loaded yet. Please wait a moment and try again.");
      return;
    }
    setConnecting(true);
    window.FB.login(
      (response) => {
        if (response.authResponse?.accessToken) {
          connectMutation.mutate(
            { accessToken: response.authResponse.accessToken },
            {
              onSettled: () => setConnecting(false),
            }
          );
        } else {
          // User cancelled or denied permissions
          setConnecting(false);
          if (response.status !== "unknown") {
            toast.error("Facebook login was cancelled or permissions were denied.");
          }
        }
      },
      { scope: FB_SCOPE, return_scopes: true }
    );
  }, [connectMutation]);

  // ── Re-connect (refresh token) for an existing account ────────────────────
  const handleReconnect = useCallback(() => {
    if (!window.FB) {
      toast.error("Facebook SDK not loaded yet. Please wait a moment and try again.");
      return;
    }
    setConnecting(true);
    // Force a fresh login to get a new token
    window.FB.logout(() => {
      window.FB.login(
        (response) => {
          if (response.authResponse?.accessToken) {
            connectMutation.mutate(
              { accessToken: response.authResponse.accessToken },
              {
                onSettled: () => setConnecting(false),
              }
            );
          } else {
            setConnecting(false);
            toast.error("Facebook login was cancelled.");
          }
        },
        { scope: FB_SCOPE, return_scopes: true }
      );
    });
  }, [connectMutation]);

  const isExpired = (expiresAt: Date | null) => {
    if (!expiresAt) return false;
    return new Date(expiresAt) < new Date();
  };

  const expiresLabel = (expiresAt: Date | null) => {
    if (!expiresAt) return "Never expires";
    const d = new Date(expiresAt);
    if (d < new Date()) return "Expired";
    const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
    if (days <= 7) return `Expires in ${days}d (renew soon)`;
    return `Expires in ${days}d`;
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Facebook Accounts</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Connect your Facebook accounts to access pages and lead forms
            </p>
          </div>
          <Button
            onClick={handleFacebookLogin}
            disabled={connecting}
            className="bg-[#1877F2] hover:bg-[#166FE5] text-white"
          >
            {connecting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Facebook className="h-4 w-4 mr-2" />
            )}
            {connecting ? "Connecting…" : "Connect with Facebook"}
          </Button>
        </div>

        {/* Permissions info */}
        <Card className="border-blue-200 bg-blue-50 dark:bg-blue-950/20 dark:border-blue-800">
          <CardContent className="pt-4 pb-4">
            <div className="flex gap-3">
              <Facebook className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
              <div className="text-sm text-blue-800 dark:text-blue-300 space-y-1">
                <p className="font-medium">What happens when you click "Connect with Facebook"</p>
                <p className="text-blue-700 dark:text-blue-400">
                  A Facebook login popup will open. After you log in and approve the requested
                  permissions, the short-lived token is automatically exchanged for a long-lived
                  token (valid ~60 days) and stored encrypted. The following permissions are
                  requested:
                </p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {FB_SCOPE.split(",").map((p) => (
                    <code
                      key={p}
                      className="bg-blue-100 dark:bg-blue-900 px-1.5 py-0.5 rounded text-xs"
                    >
                      {p}
                    </code>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Accounts list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !accounts?.length ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Facebook className="h-10 w-10 text-muted-foreground/40 mb-3" />
              <p className="text-muted-foreground font-medium">No accounts connected</p>
              <p className="text-sm text-muted-foreground/70 mt-1">
                Connect a Facebook account to start creating lead routing integrations
              </p>
              <Button
                className="mt-4 bg-[#1877F2] hover:bg-[#166FE5] text-white"
                onClick={handleFacebookLogin}
                disabled={connecting}
              >
                {connecting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Facebook className="h-4 w-4 mr-2" />
                )}
                Connect with Facebook
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {accounts.map((acct) => {
              const expired = isExpired(acct.tokenExpiresAt);
              const expiresIn = acct.tokenExpiresAt
                ? Math.ceil((new Date(acct.tokenExpiresAt).getTime() - Date.now()) / 86400000)
                : null;
              const expiringSoon = expiresIn !== null && expiresIn <= 7 && expiresIn > 0;

              return (
                <Card
                  key={acct.id}
                  className={
                    expired
                      ? "border-destructive/50"
                      : expiringSoon
                      ? "border-yellow-400/60"
                      : ""
                  }
                >
                  <CardContent className="flex items-center gap-4 py-4">
                    <div className="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center shrink-0">
                      <User className="h-5 w-5 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium truncate">{acct.fbUserName}</p>
                        {expired ? (
                          <Badge variant="destructive" className="text-xs">
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            Expired
                          </Badge>
                        ) : expiringSoon ? (
                          <Badge
                            variant="outline"
                            className="text-xs border-yellow-400 text-yellow-600 dark:text-yellow-400"
                          >
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            Expiring soon
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-xs">
                            Active
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        FB User ID:{" "}
                        <code className="bg-muted px-1 rounded">{acct.fbUserId}</code>
                        {" · "}
                        {expiresLabel(acct.tokenExpiresAt)}
                      </p>
                      <p className="text-xs text-muted-foreground/50 mt-0.5">
                        Connected {new Date(acct.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {(expired || expiringSoon) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleReconnect}
                          disabled={connecting}
                          className="text-xs"
                        >
                          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                          Reconnect
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setDeleteId(acct.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <DisconnectFacebookAccountDialog
        open={deleteId !== null}
        onOpenChange={(o) => !o && setDeleteId(null)}
        facebookAccountId={deleteId}
        accountName={disconnectAccountName}
      />
    </DashboardLayout>
  );
}
