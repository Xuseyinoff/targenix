import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Link } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { DisconnectFacebookAccountDialog } from "@/components/DisconnectFacebookAccountDialog";
import { AppCatalogPicker } from "@/components/appCatalog/AppCatalogPicker";
import { ConnectionsList } from "@/components/connections/ConnectionsList";
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
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { useIsMobile } from "@/hooks/useMobile";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
import {
  Facebook,
  Loader2,
  Trash2,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  Plus,
  ShieldCheck,
  MoreHorizontal,
  MoreVertical,
  Fingerprint,
  LifeBuoy,
  Unlink,
  Webhook,
} from "lucide-react";

function formatShortDate(d: string | Date) {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function ConnectionsSkeleton() {
  return (
    <div className="space-y-4">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm space-y-4 animate-pulse"
        >
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-40 max-w-[55%] rounded-md bg-muted" />
              <div className="h-3 w-28 rounded-md bg-muted/80" />
            </div>
            <div className="h-8 w-8 rounded-md bg-muted" />
          </div>
          <div className="h-16 rounded-xl bg-muted/50" />
          <div className="h-16 rounded-xl bg-muted/40" />
        </div>
      ))}
    </div>
  );
}

/**
 * Facebook Connections — OAuth + grouped pages (premium SaaS layout, mobile-first).
 */
export default function Connections() {
  const isMobile = useIsMobile();
  const t = useT();
  const [connecting, setConnecting] = useState(false);
  const [connectResult, setConnectResult] = useState<{
    fbUserName: string;
    warnings?: string[];
    pages: Array<{ pageId: string; pageName: string; subscribed: boolean; isNew?: boolean; error?: string }>;
  } | null>(null);
  const [openAccounts, setOpenAccounts] = useState<Record<number, boolean>>({});
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [disconnectAccountTarget, setDisconnectAccountTarget] = useState<{
    id: number;
    name: string;
    pageCount: number;
  } | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const popupRef = useRef<Window | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oauthCompletedRef = useRef(false);

  const utils = trpc.useUtils();

  const {
    data: accountsWithPages = [],
    isLoading,
    isError,
    error: queryError,
    refetch,
  } = trpc.facebookAccounts.getAccountsWithPages.useQuery(undefined, {
    refetchInterval: 10000,
  });

  const toggleMutation = trpc.facebookAccounts.togglePageActive.useMutation({
    onSuccess: () => {
      utils.facebookAccounts.getAccountsWithPages.invalidate();
      utils.facebookAccounts.listConnectedPages.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.facebookAccounts.deletePageConnection.useMutation({
    onSuccess: () => {
      toast.success(t("connections.pageRemoved"));
      utils.facebookAccounts.getAccountsWithPages.invalidate();
      utils.facebookAccounts.listConnectedPages.invalidate();
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const utilsRef = useRef(utils);
  useEffect(() => {
    utilsRef.current = utils;
  }, [utils]);

  const processOAuthResultRef = useRef<((data: unknown) => void) | null>(null);
  processOAuthResultRef.current = (data: unknown) => {
    if (!data || typeof data !== "object") return;
    const msg = data as Record<string, unknown>;
    if (msg.type !== "fb_oauth_success" && msg.type !== "fb_oauth_error") return;

    if (oauthCompletedRef.current) return;
    oauthCompletedRef.current = true;

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (bcRef.current) {
      bcRef.current.close();
      bcRef.current = null;
    }

    if (msg.type === "fb_oauth_success") {
      setConnecting(false);
      setConnectResult({
        fbUserName: msg.fbUserName as string,
        warnings: (msg.warnings ?? []) as string[],
        pages: (msg.pages ?? []) as Array<{
          pageId: string;
          pageName: string;
          subscribed: boolean;
          isNew?: boolean;
          error?: string;
        }>,
      });
      utilsRef.current.facebookAccounts.getAccountsWithPages.invalidate();
      utilsRef.current.facebookAccounts.listConnectedPages.invalidate();

      const pages = (msg.pages ?? []) as Array<{ subscribed: boolean; isNew?: boolean }>;
      const subscribed = pages.filter((p) => p.subscribed).length;
      const newPages = pages.filter((p) => p.isNew).length;
      toast.success(
        `${t("connections.connectedAs", { name: String(msg.fbUserName ?? "") })} — ${t("connections.pagesSubscribed", { subscribed, total: pages.length })}${newPages > 0 ? `, ${newPages} new` : ""}.`
      );
    } else {
      setConnecting(false);
      toast.error((msg.error as string) ?? t("connections.facebookConnectFailed"));
    }
  };

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      processOAuthResultRef.current?.(event.data);
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (bcRef.current) {
        bcRef.current.close();
        bcRef.current = null;
      }
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    };
  }, []);

  const handleConnectFacebook = useCallback(async () => {
    if (connecting) return;
    setConnecting(true);
    setConnectResult(null);

    try {
      const response = await fetch("/api/auth/facebook/initiate", {
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: t("connections.oauthInitiateFailed") }));
        throw new Error(errorData.error ?? t("connections.oauthInitiateFailed"));
      }

      const { oauthUrl } = await response.json();

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
        throw new Error(t("connections.popupBlocked"));
      }

      popupRef.current = popup;
      oauthCompletedRef.current = false;

      try {
        const bc = new BroadcastChannel("targenix_fb_oauth");
        bcRef.current = bc;
        bc.onmessage = (event) => processOAuthResultRef.current?.(event.data);
      } catch {
        /* fallback: window.message */
      }

      timeoutRef.current = setTimeout(() => {
        if (bcRef.current) {
          bcRef.current.close();
          bcRef.current = null;
        }
        setConnecting((prev) => {
          if (prev) toast.error(t("connections.oauthTimedOut"));
          return false;
        });
      }, 30_000);
    } catch (err) {
      setConnecting(false);
      toast.error(err instanceof Error ? err.message : t("connections.connectAccountFailed"));
    }
  }, [connecting]);

  const totalPages = useMemo(
    () => accountsWithPages.reduce((sum, a) => sum + a.pages.length, 0),
    [accountsWithPages]
  );

  const setAccountOpen = (id: number, open: boolean) => {
    setOpenAccounts((m) => ({ ...m, [id]: open }));
  };

  const fbConnectButton = (
    <Button
      onClick={handleConnectFacebook}
      disabled={connecting}
      className={cn(
        "wapi-button-hover gap-2 rounded-full bg-[#1877F2] font-medium text-white shadow-sm hover:bg-[#166fe5]",
        "md:w-auto w-full h-10 md:h-10 min-h-10 px-4"
      )}
    >
      {connecting ? <Loader2 className="h-4 w-4 animate-spin shrink-0" /> : <Facebook className="h-4 w-4 shrink-0" />}
      {connecting ? t("connections.connecting") : t("connections.connectFacebook")}
    </Button>
  );

  return (
    <DashboardLayout>
      <Sheet open={howOpen} onOpenChange={setHowOpen}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={cn(
            "rounded-t-2xl sm:rounded-none border-slate-200/70 dark:border-border p-0 gap-0 sm:max-w-md",
            isMobile && "max-h-[min(92vh,720px)]"
          )}
        >
          {/* Header — emerald gradient with FB icon */}
          <SheetHeader className="text-left p-6 pb-5 bg-gradient-to-br from-emerald-50/70 to-white dark:from-emerald-950/20 dark:to-transparent border-b border-slate-200/70 dark:border-border">
            <div className="flex items-center gap-3 mb-1">
              <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-[#1877F2] to-[#0c5dc8] flex items-center justify-center shadow-sm ring-2 ring-[#1877F2]/10">
                <Facebook className="h-5 w-5 text-white" strokeWidth={2.2} />
              </div>
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-lg font-bold tracking-tight">
                  {t("connections.howTitle")}
                </SheetTitle>
                <SheetDescription className="text-left text-xs leading-snug mt-0.5">
                  {t("connections.howSubtitle")}
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          {/* Wapi-style numbered stepper */}
          <div className="flex-1 overflow-y-auto p-6">
            <ol className="relative space-y-5">
              {/* Vertical connecting line (behind the numbers) */}
              <div className="absolute left-[14px] top-7 bottom-7 w-0.5 bg-gradient-to-b from-emerald-200 via-emerald-100 to-transparent dark:from-emerald-900/40 dark:via-emerald-950/30 dark:to-transparent" aria-hidden />

              <li className="relative flex gap-4">
                <div className="relative z-10 h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white text-xs font-bold flex items-center justify-center shadow-sm ring-4 ring-background">
                  1
                </div>
                <div className="flex-1 pt-0.5">
                  <p className="text-sm font-semibold leading-snug">Connect Facebook</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {t("connections.howStep1")}
                  </p>
                </div>
              </li>

              <li className="relative flex gap-4">
                <div className="relative z-10 h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white text-xs font-bold flex items-center justify-center shadow-sm ring-4 ring-background">
                  2
                </div>
                <div className="flex-1 pt-0.5">
                  <p className="text-sm font-semibold leading-snug">We sync your pages</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {t("connections.howStep2")}
                  </p>
                </div>
              </li>

              <li className="relative flex gap-4">
                <div className="relative z-10 h-7 w-7 shrink-0 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 text-white text-xs font-bold flex items-center justify-center shadow-sm ring-4 ring-background">
                  3
                </div>
                <div className="flex-1 pt-0.5">
                  <p className="text-sm font-semibold leading-snug">Route in Integrations</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {t("connections.howStep3Prefix")}{" "}
                    <Link href="/integrations" className="font-semibold text-primary hover:underline">
                      {t("connections.howStep3Link")}
                    </Link>{" "}
                    {t("connections.howStep3Suffix")}
                  </p>
                </div>
              </li>
            </ol>

            {/* Security footer info */}
            <div className="mt-7 rounded-2xl border border-emerald-100 dark:border-emerald-900/40 bg-emerald-50/60 dark:bg-emerald-950/15 p-4">
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
                  <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
                    Tokens never touch your browser
                  </p>
                  <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80 mt-1 leading-relaxed">
                    OAuth happens entirely on the server. Access tokens are AES-256 encrypted and never exposed to client code.
                  </p>
                </div>
              </div>
            </div>

            {/* CTA */}
            <Button
              onClick={() => setHowOpen(false)}
              className="wapi-button-hover mt-5 w-full h-10 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
            >
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
              Got it
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Sticky page header (Wapi pattern) ── */}
      <div className="sticky top-16 z-30 -mx-6 -mt-6 mb-6 bg-background/85 backdrop-blur-md border-b border-slate-200/70 dark:border-border">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-end justify-between flex-wrap gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight text-primary">{t("connections.title")}</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              {t("connections.subtitlePrefix")}{" "}
              <Link href="/integrations" className="text-primary font-semibold hover:underline">
                {t("connections.subtitleLink")}
              </Link>
              {t("connections.subtitleSuffix")}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="icon"
              className="wapi-button-hover rounded-full h-10 w-10 md:hidden"
              onClick={() => setHowOpen(true)}
              aria-label="How it works"
            >
              <LifeBuoy className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              className="wapi-button-hover rounded-full h-10 px-4 font-medium"
              onClick={() => refetch()}
              disabled={isLoading}
              title={t("connections.refresh")}
            >
              <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
              <span className="hidden sm:inline ml-1.5">{t("connections.refresh")}</span>
            </Button>
            {fbConnectButton}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-4xl space-y-5 pb-28 md:space-y-6 md:pb-0 px-0 sm:px-0">
        {/* ── OAuth security info bar (Wapi info card) ── */}
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-emerald-100 dark:border-emerald-900/40 bg-emerald-50/60 dark:bg-emerald-950/15 px-4 py-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center shrink-0">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100">
                {t("connections.oauthBadgeTitle")}
              </p>
              <p className="text-xs text-emerald-700/80 dark:text-emerald-300/80 mt-0.5 line-clamp-2">
                {t("connections.oauthBadgeBody")}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 rounded-full text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 shrink-0 hidden sm:flex"
            onClick={() => setHowOpen(true)}
          >
            <LifeBuoy className="h-3.5 w-3.5 mr-1.5" />
            {t("connections.howTitle")}
          </Button>
        </div>

        {isError && (
          <Alert variant="destructive" className="rounded-2xl">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>{t("connections.loadErrorTitle")}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>{queryError?.message ?? t("connections.tryAgain")}</span>
              <Button variant="outline" size="sm" className="shrink-0 border-destructive/40" onClick={() => refetch()}>
                {t("connections.retry")}
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {connectResult && (
          <div className="rounded-2xl border border-emerald-200/80 bg-emerald-50/80 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/25">
            <div className="flex items-center gap-2 font-medium text-sm text-emerald-900 dark:text-emerald-100">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {t("connections.connectedAs", { name: connectResult.fbUserName })}
            </div>
            <p className="mt-1 text-sm text-emerald-800/90 dark:text-emerald-200/90">
              {t("connections.pagesSubscribed", {
                subscribed: connectResult.pages.filter((p) => p.subscribed).length,
                total: connectResult.pages.length,
              })}
            </p>
            {connectResult.pages.some((p) => !p.subscribed) && (
              <ul className="mt-2 space-y-1 text-xs text-amber-800 dark:text-amber-200/90">
                {connectResult.pages
                  .filter((p) => !p.subscribed)
                  .map((p) => (
                    <li key={p.pageId} className="flex gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>
                        {p.pageName}: {p.error}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-[#1877F2]/10 dark:bg-[#1877F2]/15 flex items-center justify-center">
              <Facebook className="h-4 w-4 text-[#1877F2]" />
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-tight">{t("connections.yourAccounts")}</h3>
              <p className="text-xs text-muted-foreground">Facebook accounts &amp; subscribed pages</p>
            </div>
          </div>
          {!isLoading && accountsWithPages.length > 0 && (
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-muted text-xs">
              <span className="font-bold tabular-nums">{accountsWithPages.length}</span>
              <span className="text-muted-foreground">account{accountsWithPages.length !== 1 ? "s" : ""}</span>
              <span className="text-border">·</span>
              <span className="font-bold tabular-nums">{totalPages}</span>
              <span className="text-muted-foreground">page{totalPages !== 1 ? "s" : ""}</span>
            </div>
          )}
        </div>

        {isLoading ? (
          <ConnectionsSkeleton />
        ) : accountsWithPages.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 bg-muted/10 px-6 py-14 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#1877F2]/10">
              <Facebook className="h-7 w-7 text-[#1877F2]" />
            </div>
            <p className="text-base font-medium text-foreground">{t("connections.noAccountsTitle")}</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {t("connections.noAccountsBody")}
            </p>
            <div className="mt-6 w-full max-w-xs md:hidden">{fbConnectButton}</div>
            <div className="mt-6 hidden md:block">{fbConnectButton}</div>
          </div>
        ) : (
          <div className="space-y-4">
            {accountsWithPages.map((account) => {
              const activePages = account.pages.filter((p) => p.isActive).length;
              const tokenExpired = account.tokenExpiresAt ? new Date(account.tokenExpiresAt) < new Date() : false;
              const isOpen = openAccounts[account.id] ?? false;

              return (
                <Collapsible
                  key={account.id}
                  open={isOpen}
                  onOpenChange={(open) => setAccountOpen(account.id, open)}
                  className="wapi-card-hover overflow-hidden rounded-2xl border border-slate-200/70 dark:border-border bg-white dark:bg-card"
                >
                  <div className="flex items-stretch">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex min-h-[4.5rem] flex-1 min-w-0 items-center gap-3 p-4 pr-2 text-left transition-colors hover:bg-slate-50/60 dark:hover:bg-muted/30 active:bg-muted/40 group"
                      >
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#1877F2] to-[#0c5dc8] shadow-sm ring-2 ring-[#1877F2]/10">
                          <Facebook className="h-6 w-6 text-white" strokeWidth={2.2} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-foreground text-base transition-colors group-hover:text-primary">{account.fbUserName}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1 font-medium tabular-nums">
                              <Facebook className="h-3 w-3" />
                              {account.pages.length} page{account.pages.length !== 1 ? "s" : ""}
                            </span>
                            <span className="text-border">·</span>
                            <span className={cn(
                              "inline-flex items-center gap-1 font-medium",
                              activePages === account.pages.length ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
                            )}>
                              <span className={cn(
                                "h-1.5 w-1.5 rounded-full",
                                activePages === account.pages.length ? "bg-emerald-500" : "bg-amber-500"
                              )} />
                              {activePages < account.pages.length ? `${activePages} active` : "all active"}
                            </span>
                            <span className="text-border">·</span>
                            <span className="tabular-nums">
                              Updated {formatShortDate(account.connectedAt ?? account.createdAt)}
                            </span>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2 pl-1">
                          {tokenExpired ? (
                            <Badge
                              variant="outline"
                              className="border-rose-200 bg-rose-50 text-rose-700 text-[10px] uppercase tracking-widest font-bold dark:bg-rose-950/30 dark:border-rose-900/40 dark:text-rose-400"
                            >
                              Token expired
                            </Badge>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="border-emerald-200/60 bg-emerald-50 text-emerald-700 text-[10px] font-bold uppercase tracking-widest dark:bg-emerald-950/40 dark:text-emerald-300"
                            >
                              ● Token OK
                            </Badge>
                          )}
                          <ChevronDown
                            className={cn(
                              "h-4 w-4 text-muted-foreground transition-transform duration-200",
                              isOpen && "rotate-180"
                            )}
                          />
                        </div>
                      </button>
                    </CollapsibleTrigger>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-auto min-h-[4.25rem] w-11 shrink-0 rounded-none border-l border-border/50 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                          aria-label="Account options"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52 rounded-xl">
                        <DropdownMenuItem
                          className="cursor-pointer md:hidden"
                          onClick={() => {
                            void navigator.clipboard.writeText(account.fbUserId);
                            toast.success(t("connections.userIdCopied"));
                          }}
                        >
                          <Fingerprint className="mr-2 h-4 w-4" />
                          {t("connections.copyUserId")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="cursor-pointer text-destructive focus:text-destructive"
                          onClick={() =>
                            setDisconnectAccountTarget({
                              id: account.id,
                              name: account.fbUserName,
                              pageCount: account.pages.length,
                            })
                          }
                        >
                          <Unlink className="mr-2 h-4 w-4" />
                          {t("connections.disconnectAccount")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <div className="hidden md:flex">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="flex w-11 shrink-0 items-center justify-center border-l border-border/50 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                            aria-label="Facebook user ID"
                          >
                            <Fingerprint className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-xs font-mono text-xs">
                          User ID: {account.fbUserId}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>

                  <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
                    <div className="border-t border-slate-200/70 dark:border-border bg-slate-50/30 dark:bg-muted/10 px-3 pb-3 pt-2">
                      {account.pages.length === 0 ? (
                        <p className="py-8 text-center text-sm text-muted-foreground">{t("connections.noPagesForAccount")}</p>
                      ) : (
                        <ul className="space-y-2 py-2">
                          {account.pages.map((page) => {
                            const initial = page.pageName.trim().charAt(0).toUpperCase() || "?";
                            return (
                              <li
                                key={page.id}
                                className="flex flex-col gap-3 rounded-xl border border-slate-200/60 dark:border-border bg-white dark:bg-card p-3 transition-all hover:border-emerald-200 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/15 group sm:flex-row sm:items-center sm:gap-4"
                              >
                                <div className="flex items-center gap-3 min-w-0 flex-1">
                                  <div
                                    className={cn(
                                      "h-9 w-9 shrink-0 rounded-full flex items-center justify-center text-sm font-bold text-white transition-all",
                                      page.isActive
                                        ? "bg-gradient-to-br from-emerald-400 to-emerald-600"
                                        : "bg-gradient-to-br from-slate-300 to-slate-400"
                                    )}
                                  >
                                    {initial}
                                  </div>
                                  <div className="min-w-0 flex-1 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-semibold text-sm text-foreground leading-snug transition-colors group-hover:text-emerald-700 dark:group-hover:text-emerald-400">{page.pageName}</span>
                                      {page.subscriptionStatus === "failed" && (
                                        <Badge
                                          variant="outline"
                                          className="border-amber-300 bg-amber-50 text-amber-800 text-[10px] uppercase tracking-wider font-bold dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                                          title={page.subscriptionError ?? t("connections.subscriptionFailed")}
                                        >
                                          <AlertTriangle className="h-2.5 w-2.5 mr-1" />
                                          {t("connections.webhookIssue")}
                                        </Badge>
                                      )}
                                      {page.isActive ? (
                                        <Badge className="border-0 bg-emerald-100 text-emerald-700 hover:bg-emerald-100 text-[10px] uppercase tracking-widest font-bold dark:bg-emerald-950/50 dark:text-emerald-300">
                                          ● {t("connections.active")}
                                        </Badge>
                                      ) : (
                                        <Badge variant="secondary" className="text-[10px] uppercase tracking-widest font-bold text-muted-foreground">
                                          {t("connections.inactive")}
                                        </Badge>
                                      )}
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      <span>{t("connections.added", { date: formatShortDate(page.createdAt) })}</span>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <button
                                            type="button"
                                            className="ml-2 inline text-primary underline-offset-2 hover:underline font-medium"
                                          >
                                            {t("connections.pageId")}
                                          </button>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-xs font-mono text-xs">{page.pageId}</TooltipContent>
                                      </Tooltip>
                                    </div>
                                  </div>
                                </div>

                              <div className="flex items-center justify-between gap-3 border-t border-slate-200/70 dark:border-border pt-3 sm:border-t-0 sm:pt-0">
                                <div className="flex items-center gap-2 sm:flex-col sm:items-end">
                                  <span className="text-xs text-muted-foreground sm:hidden">{t("connections.receiveLeads")}</span>
                                  <Switch
                                    checked={page.isActive}
                                    onCheckedChange={(checked) =>
                                      toggleMutation.mutate({
                                        connectionId: page.id,
                                        isActive: checked,
                                      })
                                    }
                                    disabled={toggleMutation.isPending}
                                    className="data-[state=checked]:bg-emerald-600 scale-110 sm:scale-100"
                                  />
                                </div>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant="outline"
                                      size="icon"
                                      className="h-11 w-11 shrink-0 rounded-xl border-border/80"
                                      aria-label="Page actions"
                                    >
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-48 rounded-xl">
                                    <DropdownMenuItem
                                      className="cursor-pointer"
                                      onClick={() => {
                                        void navigator.clipboard.writeText(page.pageId);
                                        toast.success(t("connections.pageIdCopied"));
                                      }}
                                    >
                                      <Fingerprint className="mr-2 h-4 w-4" />
                                      {t("connections.copyPageId")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      className="cursor-pointer text-destructive focus:text-destructive"
                                      onClick={() => setDeleteTarget({ id: page.id, name: page.pageName })}
                                    >
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      {t("connections.removePage")}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        )}

        {/* Phase 2C — delivery-side connections. Facebook logic above is
            untouched; the "+ Add connection" button opens a Zapier-style
            picker modal (AppPickerModal). Clicking an app inside the modal
            drives the right credential flow inline:
              - Google Sheets → the existing Google OAuth popup
              - Telegram      → TelegramConnectDialog (bot token + chat id)
              - Admin tpl     → /destinations?template=<id>
            No bespoke Google / Telegram sections live on this page anymore;
            their saved rows surface through the unified list (coming next). */}
        <div className="flex items-center justify-between gap-3 pt-4">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-violet-100 dark:bg-violet-950/40 flex items-center justify-center">
              <Webhook className="h-4 w-4 text-violet-600 dark:text-violet-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-tight">
                {t("connections.deliverySectionLabel")}
              </h3>
              <p className="text-xs text-muted-foreground">Where your leads get sent</p>
            </div>
          </div>
          <Button
            type="button"
            className="wapi-button-hover h-10 shrink-0 gap-1.5 rounded-full px-4 bg-primary hover:bg-primary/90 text-primary-foreground font-medium"
            onClick={() => setPickerOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Add connection
          </Button>
        </div>

        {/* Unified rows for every saved delivery credential (Sheets / Telegram
            / admin-template API keys). Facebook accounts stay in the
            Collapsible cards above because their page-level management
            doesn't fit a flat row. */}
        <ConnectionsList onReconnect={() => setPickerOpen(true)} />

        <AppCatalogPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          mode="connection"
        />

        {/* Sticky primary CTA — mobile (hidden when empty to avoid duplicate with empty state) */}
        {!isLoading && accountsWithPages.length > 0 && (
          <div className="md:hidden pointer-events-none fixed inset-x-0 bottom-0 z-30 border-t border-border/40 bg-gradient-to-t from-background via-background/95 to-transparent p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-8 shadow-[0_-12px_40px_-16px_rgba(0,0,0,0.08)] dark:shadow-[0_-12px_40px_-16px_rgba(0,0,0,0.35)]">
            <div className="pointer-events-auto mx-auto max-w-3xl">{fbConnectButton}</div>
          </div>
        )}

        <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
          <AlertDialogContent className="rounded-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>{t("connections.removePageTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                <strong className="text-foreground">{deleteTarget?.name}</strong>{" "}
                {t("connections.removePageBodyPrefix", { name: deleteTarget?.name ?? "" })}{" "}
                {t("connections.removePageBodySuffix")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="gap-2 sm:gap-0">
              <AlertDialogCancel className="rounded-xl">{t("connections.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => deleteTarget && deleteMutation.mutate({ connectionId: deleteTarget.id })}
              >
                {t("connections.remove")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <DisconnectFacebookAccountDialog
          open={!!disconnectAccountTarget}
          onOpenChange={(o) => !o && setDisconnectAccountTarget(null)}
          facebookAccountId={disconnectAccountTarget?.id ?? null}
          accountName={disconnectAccountTarget?.name ?? ""}
          pageCount={disconnectAccountTarget?.pageCount}
        />
      </div>
    </DashboardLayout>
  );
}
