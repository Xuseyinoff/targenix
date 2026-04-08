import { useState, useEffect, useCallback, useRef } from "react";
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
  ShieldCheck,
} from "lucide-react";

/**
 * Connections page — uses Authorization Code Flow (server-side) for security.
 *
 * Flow:
 *  1. Click "Connect Facebook Account"
 *  2. Frontend calls /api/auth/facebook/initiate → server generates CSRF state, returns OAuth URL
 *  3. Frontend opens OAuth URL in a popup window
 *  4. Facebook redirects to /api/auth/facebook/callback with code+state
 *  5. Server verifies CSRF state, exchanges code for token, saves pages
 *  6. Callback page sends postMessage to opener with result
 *  7. Frontend receives message, shows success/error, refreshes data
 */
export default function Connections() {
  const [connecting, setConnecting] = useState(false);
  const [connectResult, setConnectResult] = useState<{
    fbUserName: string;
    warnings?: string[];
    pages: Array<{ pageId: string; pageName: string; subscribed: boolean; isNew?: boolean; error?: string }>;
  } | null>(null);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set());
  const popupRef = useRef<Window | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const utils = trpc.useUtils();

  // ── Queries ────────────────────────────────────────────────────────────────
  const {
    data: accountsWithPages = [],
    isLoading,
    refetch,
  } = trpc.facebookAccounts.getAccountsWithPages.useQuery(undefined, {
    refetchInterval: 10000,
  });

  // ── Mutations ──────────────────────────────────────────────────────────────
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

  // ── Listen for postMessage from OAuth popup ────────────────────────────────
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      // Only handle messages from our own origin
      if (event.origin !== window.location.origin) return;

      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "fb_oauth_success") {
        setConnecting(false);
        setConnectResult({
          fbUserName: data.fbUserName,
          warnings: data.warnings ?? [],
          pages: data.pages ?? [],
        });
        utils.facebookAccounts.getAccountsWithPages.invalidate();
        utils.facebookAccounts.listConnectedPages.invalidate();

        const subscribed = (data.pages ?? []).filter((p: { subscribed: boolean }) => p.subscribed).length;
        const newPages = (data.pages ?? []).filter((p: { isNew: boolean }) => p.isNew).length;
        toast.success(
          `Connected as ${data.fbUserName} — ${subscribed}/${(data.pages ?? []).length} pages subscribed${newPages > 0 ? `, ${newPages} new` : ""}.`
        );

        // Clean up popup polling
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      } else if (data.type === "fb_oauth_error") {
        setConnecting(false);
        toast.error(data.error ?? "Facebook connection failed.");

        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [utils]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    };
  }, []);

  // ── Connect Facebook Account (Authorization Code Flow) ─────────────────────
  const handleConnectFacebook = useCallback(async () => {
    if (connecting) return;
    setConnecting(true);
    setConnectResult(null);

    try {
      // Step 1: Get OAuth URL from server (server generates CSRF state)
      const response = await fetch("/api/auth/facebook/initiate", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: "Failed to initiate OAuth" }));
        throw new Error(errorData.error ?? "Failed to initiate OAuth");
      }

      const { oauthUrl } = await response.json();

      // Step 2: Open OAuth URL in popup
      const popupWidth = 600;
      const popupHeight = 700;
      const left = Math.round(window.screenX + (window.outerWidth - popupWidth) / 2);
      const top = Math.round(window.screenY + (window.outerHeight - popupHeight) / 2);

      const popup = window.open(
        oauthUrl,
        "facebook_oauth",
        `width=${popupWidth},height=${popupHeight},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`
      );

      if (!popup) {
        throw new Error("Popup was blocked. Please allow popups for this site and try again.");
      }

      popupRef.current = popup;

      // Step 3: Poll for popup closure (detect user cancellation)
      pollIntervalRef.current = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollIntervalRef.current!);
          pollIntervalRef.current = null;
          // If still connecting after popup closed, user cancelled
          setConnecting((prev) => {
            if (prev) {
              toast.error("Facebook connection cancelled.");
            }
            return false;
          });
        }
      }, 500);
    } catch (error) {
      setConnecting(false);
      toast.error(error instanceof Error ? error.message : "Failed to connect Facebook account.");
    }
  }, [connecting]);

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
              disabled={connecting}
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

        {/* ── Security badge ── */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
          <span>Secured with Authorization Code Flow — your token never touches the browser</span>
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
              disabled={connecting}
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
                When you click "Connect Facebook Account", a secure Facebook login popup opens using
                Authorization Code Flow. After you grant permissions, Targenix.uz automatically
                fetches all pages you manage (including Business Manager pages) and subscribes each
                one to receive lead ads via webhook. You can then go to{" "}
                <strong>Integrations</strong> to create routing rules for any connected page.
              </p>
            </div>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
