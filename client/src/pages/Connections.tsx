import { useState, useEffect, useCallback } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Facebook,
  Loader2,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  User,
  Calendar,
  ChevronDown,
  ChevronRight,
  Plus,
} from "lucide-react";

const FB_APP_ID = import.meta.env.VITE_FACEBOOK_APP_ID as string;
const FB_PERMISSIONS =
  "pages_show_list,pages_read_engagement,pages_manage_metadata,leads_retrieval";

export default function Connections() {
  const [fbSdkReady, setFbSdkReady] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectResult, setConnectResult] = useState<{
    fbUserName: string;
    connectedAt?: Date;
    warnings?: string[];
    pages: Array<{ pageId: string; pageName: string; subscribed: boolean; isNew?: boolean; error?: string }>;
  } | null>(null);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set());

  const utils = trpc.useUtils();

  // ── Load FB SDK ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (window.FB) {
      setFbSdkReady(true);
      return;
    }
    window.fbAsyncInit = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.FB as any).init({
        appId: FB_APP_ID,
        cookie: true,
        xfbml: false,
        version: "v21.0",
      });
      setFbSdkReady(true);
    };
    if (!document.getElementById("facebook-jssdk")) {
      const script = document.createElement("script");
      script.id = "facebook-jssdk";
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true;
      script.defer = true;
      document.body.appendChild(script);
    }
  }, []);

  // ── Queries ────────────────────────────────────────────────────────────────
  const {
    data: accountsWithPages = [],
    isLoading,
    refetch,
  } = trpc.facebookAccounts.getAccountsWithPages.useQuery(undefined, {
    refetchInterval: 10000,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
  const connectMutation = trpc.facebookAccounts.connectAndSubscribeAll.useMutation({
    onSuccess: (data) => {
      setConnectResult({
        fbUserName: data.fbUserName,
        connectedAt: data.connectedAt,
        warnings: data.warnings,
        pages: data.pages,
      });
      utils.facebookAccounts.getAccountsWithPages.invalidate();
      utils.facebookAccounts.listConnectedPages.invalidate();
      const subscribed = data.pages.filter((p) => p.subscribed).length;
      const newPages = data.pages.filter((p) => p.isNew).length;
      toast.success(
        `Connected as ${data.fbUserName} — ${subscribed}/${data.pages.length} pages subscribed${newPages > 0 ? `, ${newPages} new` : ""}.`
      );
    },
    onError: (err) => {
      toast.error(err.message);
    },
    onSettled: () => setConnecting(false),
  });

  const toggleMutation = trpc.facebookAccounts.togglePageActive.useMutation({
    onSuccess: () => {
      utils.facebookAccounts.getAccountsWithPages.invalidate();
      utils.facebookAccounts.listConnectedPages.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const deleteMutation = trpc.facebookAccounts.deletePageConnection.useMutation({
    onSuccess: () => {
      toast.success("Connection deleted successfully.");
      utils.facebookAccounts.getAccountsWithPages.invalidate();
      utils.facebookAccounts.listConnectedPages.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleConnectFacebook = useCallback(() => {
    if (!fbSdkReady || !window.FB) {
      toast.error("Facebook SDK not ready. Please wait a moment and try again.");
      return;
    }
    setConnecting(true);
    setConnectResult(null);

    const doLogin = () => {
      window.FB!.login(
        (response) => {
          if (response.authResponse?.accessToken) {
            connectMutation.mutate({ accessToken: response.authResponse.accessToken });
          } else {
            setConnecting(false);
            toast.error("Facebook login was cancelled or permissions were denied.");
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { scope: FB_PERMISSIONS, auth_type: "rerequest", return_scopes: true } as any
      );
    };

    window.FB!.getLoginStatus((statusResponse) => {
      if (statusResponse.status === "connected") {
        window.FB!.logout(() => doLogin());
      } else {
        doLogin();
      }
    });
  }, [fbSdkReady, connectMutation]);

  function toggleAccount(accountId: number) {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  }

  const totalPages = accountsWithPages.reduce((sum, a) => sum + a.pages.length, 0);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* ── Header ── */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Connect your Facebook account to automatically subscribe all your pages to receive
              lead ads.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isLoading}
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button
              onClick={handleConnectFacebook}
              disabled={connecting || !fbSdkReady}
              className="bg-[#1877F2] hover:bg-[#166fe5] text-white gap-2"
            >
              {connecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {connecting ? "Connecting..." : "Connect Facebook Account"}
            </Button>
          </div>
        </div>

        {/* ── Connection result banner ── */}
        {connectResult && (
          <div className="rounded-xl border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-800 p-4">
            <div className="flex items-center gap-2 font-medium text-sm mb-1">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Connected as {connectResult.fbUserName}
            </div>
            <p className="text-sm text-muted-foreground">
              {connectResult.pages.filter((p) => p.subscribed).length} of{" "}
              {connectResult.pages.length} pages subscribed to receive leads.
            </p>
            {connectResult.pages.some((p) => !p.subscribed) && (
              <div className="mt-2 space-y-1">
                {connectResult.pages
                  .filter((p) => !p.subscribed)
                  .map((p) => (
                    <div
                      key={p.pageId}
                      className="flex items-center gap-2 text-sm text-yellow-700 dark:text-yellow-400"
                    >
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        {p.pageName}: {p.error}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        {/* ── Section heading ── */}
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Connected Facebook Accounts</h2>
          <Badge variant="secondary" className="text-xs">
            {accountsWithPages.length}
          </Badge>
          {totalPages > 0 && (
            <span className="text-xs text-muted-foreground">
              · {totalPages} page{totalPages !== 1 ? "s" : ""} total
            </span>
          )}
        </div>

        {/* ── Account cards ── */}
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div key={i} className="h-20 rounded-xl border bg-card animate-pulse" />
            ))}
          </div>
        ) : accountsWithPages.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-card p-10 text-center">
            <Facebook className="h-10 w-10 mx-auto mb-3 text-[#1877F2] opacity-60" />
            <p className="font-medium mb-1">No Facebook accounts connected</p>
            <p className="text-sm text-muted-foreground mb-4">
              Connect your Facebook account to start receiving leads from your pages.
            </p>
            <Button
              onClick={handleConnectFacebook}
              disabled={connecting || !fbSdkReady}
              size="sm"
              className="bg-[#1877F2] hover:bg-[#166fe5] text-white gap-2"
            >
              <Plus className="h-4 w-4" />
              Connect Facebook Account
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {accountsWithPages.map((account) => {
              const isExpanded = expandedAccounts.has(account.id);
              const activePages = account.pages.filter((p) => p.isActive).length;

              return (
                <div
                  key={account.id}
                  className="rounded-xl border bg-card overflow-hidden"
                >
                  {/* ── Account header (clickable) ── */}
                  <button
                    className="w-full flex items-center gap-4 p-4 hover:bg-muted/40 transition-colors text-left"
                    onClick={() => toggleAccount(account.id)}
                  >
                    {/* Avatar */}
                    <div className="h-10 w-10 rounded-full bg-[#1877F2]/10 flex items-center justify-center shrink-0">
                      <User className="h-5 w-5 text-[#1877F2]" />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{account.fbUserName}</span>
                        <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground">
                          {account.fbUserId}
                        </code>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
                        <span>
                          {account.pages.length} page{account.pages.length !== 1 ? "s" : ""}{" "}
                          connected
                          {activePages < account.pages.length && (
                            <span className="ml-1 text-amber-500">({activePages} active)</span>
                          )}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          Token updated:{" "}
                          {new Date(account.connectedAt ?? account.createdAt).toLocaleString("en-US", {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        {account.tokenExpiresAt ? (
                          new Date(account.tokenExpiresAt) < new Date() ? (
                            <span className="flex items-center gap-1 text-red-500">
                              <AlertTriangle className="h-3 w-3" />
                              Token expired
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-green-600">
                              <CheckCircle2 className="h-3 w-3" />
                              Long-Lived ✅
                            </span>
                          )
                        ) : (
                          <span className="flex items-center gap-1 text-green-600">
                            <CheckCircle2 className="h-3 w-3" />
                            Long-Lived ✅
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Chevron */}
                    <div className="shrink-0 text-muted-foreground">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </div>
                  </button>

                  {/* ── Pages list (expanded) ── */}
                  {isExpanded && (
                    <div className="border-t">
                      {account.pages.length === 0 ? (
                        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                          No pages found for this account.
                        </div>
                      ) : (
                        <div className="divide-y">
                          {account.pages.map((page) => (
                            <div
                              key={page.id}
                              className="flex items-center gap-3 px-4 py-3 hover:bg-muted/20 transition-colors"
                            >
                              {/* Indent arrow */}
                              <span className="text-muted-foreground text-xs shrink-0 pl-2">
                                →
                              </span>

                              {/* Page name + ID */}
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-sm font-medium truncate">
                                    {page.pageName}
                                  </span>
                                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground shrink-0">
                                    {page.pageId}
                                  </code>
                                </div>
                                <span className="text-xs text-muted-foreground">
                                  Connected{" "}
                                  {new Date(page.createdAt).toLocaleDateString("en-US", {
                                    year: "numeric",
                                    month: "short",
                                    day: "numeric",
                                  })}
                                </span>
                              </div>

                              {/* Status badge */}
                              <div className="shrink-0 flex items-center gap-1.5">
                                {page.subscriptionStatus === "failed" && (
                                  <Badge
                                    variant="outline"
                                    className="text-amber-600 border-amber-300 dark:border-amber-700 text-xs"
                                    title={page.subscriptionError ?? "Subscription failed"}
                                  >
                                    <AlertTriangle className="h-3 w-3 mr-1" />
                                    Sub. Failed
                                  </Badge>
                                )}
                                {page.isActive ? (
                                  <Badge
                                    variant="default"
                                    className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 text-xs"
                                  >
                                    <CheckCircle2 className="h-3 w-3 mr-1" />
                                    Active
                                  </Badge>
                                ) : (
                                  <Badge
                                    variant="secondary"
                                    className="text-muted-foreground text-xs"
                                  >
                                    <XCircle className="h-3 w-3 mr-1" />
                                    Inactive
                                  </Badge>
                                )}
                              </div>

                              {/* Toggle + Delete */}
                              <div className="flex items-center gap-3 shrink-0">
                                <Switch
                                  checked={page.isActive}
                                  onCheckedChange={(checked) =>
                                    toggleMutation.mutate({
                                      connectionId: page.id,
                                      isActive: checked,
                                    })
                                  }
                                  disabled={toggleMutation.isPending}
                                />
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Remove page connection?</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        This will remove <strong>{page.pageName}</strong> from
                                        Targenix.uz. Leads from this page will no longer be
                                        processed. This action cannot be undone.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                                      <AlertDialogAction
                                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                        onClick={() =>
                                          deleteMutation.mutate({ connectionId: page.id })
                                        }
                                      >
                                        Remove
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── How it works ── */}
        <div className="rounded-xl border border-dashed p-4">
          <div className="flex gap-3 text-sm text-muted-foreground">
            <Facebook className="h-4 w-4 shrink-0 mt-0.5 text-[#1877F2]" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">How it works</p>
              <p>
                When you click "Connect Facebook Account", a Facebook login popup opens. After you
                grant permissions, Targenix.uz automatically fetches all pages you manage and
                subscribes each one to receive lead ads via webhook. You can then go to{" "}
                <strong>Integrations</strong> to create routing rules for any connected page.
              </p>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
