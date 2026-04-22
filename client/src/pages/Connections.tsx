import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Link } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { DisconnectFacebookAccountDialog } from "@/components/DisconnectFacebookAccountDialog";
import { AppPickerModal } from "@/components/connections/AppPickerModal";
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
  User,
  ChevronDown,
  Plus,
  ShieldCheck,
  MoreHorizontal,
  MoreVertical,
  Fingerprint,
  LifeBuoy,
  Unlink,
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
        "gap-2 rounded-xl bg-[#1877F2] font-medium text-white shadow-sm transition-all hover:bg-[#166fe5] hover:shadow-md active:scale-[0.99]",
        "md:w-auto w-full min-h-11"
      )}
    >
      {connecting ? <Loader2 className="h-4 w-4 animate-spin shrink-0" /> : <Plus className="h-4 w-4 shrink-0" />}
      {connecting ? t("connections.connecting") : t("connections.connectFacebook")}
    </Button>
  );

  return (
    <DashboardLayout>
      <Sheet open={howOpen} onOpenChange={setHowOpen}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={cn(
            "rounded-t-2xl sm:rounded-none border-border/80",
            isMobile && "max-h-[min(88vh,640px)]"
          )}
        >
          <SheetHeader className="text-left border-b border-border/60 pb-4">
            <SheetTitle className="flex items-center gap-2 text-lg">
              <Facebook className="h-5 w-5 text-[#1877F2]" />
              {t("connections.howTitle")}
            </SheetTitle>
            <SheetDescription className="text-left text-sm leading-relaxed">
              {t("connections.howSubtitle")}
            </SheetDescription>
          </SheetHeader>
          <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
            <li className="flex gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>{t("connections.howStep1")}</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>{t("connections.howStep2")}</span>
            </li>
            <li className="flex gap-3">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span>
                {t("connections.howStep3Prefix")}{" "}
                <Link href="/integrations" className="font-medium text-primary hover:underline">
                  {t("connections.howStep3Link")}
                </Link>{" "}
                {t("connections.howStep3Suffix")}
              </span>
            </li>
          </ul>
        </SheetContent>
      </Sheet>

      <div className="mx-auto max-w-3xl space-y-5 pb-28 md:space-y-6 md:pb-0 px-0 sm:px-0">
        {/* Header — mobile: compact title row + icon actions; desktop unchanged rhythm */}
        <header className="space-y-2.5 md:space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-start justify-between gap-2 md:block">
                <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">{t("connections.title")}</h1>
                <div className="flex shrink-0 items-center gap-1.5 md:hidden">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-xl border-border/60 bg-background shadow-sm"
                    onClick={() => refetch()}
                    disabled={isLoading}
                    aria-label="Refresh connections"
                  >
                    <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-10 w-10 rounded-xl border-border/60 bg-background shadow-sm"
                    onClick={() => setHowOpen(true)}
                    aria-label="How it works"
                  >
                    <LifeBuoy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="text-xs leading-snug text-muted-foreground md:text-sm md:leading-relaxed md:max-w-md">
                {t("connections.subtitlePrefix")}{" "}
                <Link href="/integrations" className="text-primary font-medium hover:underline">
                  {t("connections.subtitleLink")}
                </Link>
                {t("connections.subtitleSuffix")}
              </p>
            </div>
            <div className="hidden shrink-0 flex-col gap-2 sm:flex-row md:flex">
              <Button
                variant="outline"
                size="default"
                className="rounded-xl min-h-10 border-border/80"
                onClick={() => refetch()}
                disabled={isLoading}
              >
                <RefreshCw className={cn("h-4 w-4 sm:mr-2", isLoading && "animate-spin")} />
                <span className="hidden sm:inline">{t("connections.refresh")}</span>
              </Button>
              {fbConnectButton}
            </div>
          </div>

          {/* Mobile: one tappable row → opens same “How it works” sheet (saves vertical space) */}
          <button
            type="button"
            onClick={() => setHowOpen(true)}
            className="flex w-full items-center gap-2.5 rounded-xl border border-border/60 bg-muted/15 px-3 py-2.5 text-left transition-colors active:bg-muted/30 md:hidden"
          >
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600" />
            <span className="text-[11px] leading-snug text-muted-foreground">
              <span className="font-medium text-foreground/90">{t("connections.oauthBadgeTitle")}</span> —{" "}
              {t("connections.oauthBadgeBody")} <span className="text-primary">{t("connections.learnMore")}</span>
            </span>
          </button>

          <div className="hidden flex-wrap items-center gap-2 md:flex">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
              <span>{t("connections.oauthBadgeTitle")} — {t("connections.oauthBadgeBody")}</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 rounded-full text-xs text-muted-foreground"
              onClick={() => setHowOpen(true)}
            >
              <LifeBuoy className="h-3.5 w-3.5" />
              {t("connections.howTitle")}
            </Button>
          </div>
        </header>

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

        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">{t("connections.yourAccounts")}</h2>
          {!isLoading && accountsWithPages.length > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {accountsWithPages.length} account{accountsWithPages.length !== 1 ? "s" : ""} · {totalPages} page
              {totalPages !== 1 ? "s" : ""}
            </span>
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
                  className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="flex items-stretch">
                    <CollapsibleTrigger asChild>
                      <button
                        type="button"
                        className="flex min-h-[4.25rem] flex-1 min-w-0 items-center gap-3 p-4 pr-2 text-left transition-colors hover:bg-muted/30 active:bg-muted/40"
                      >
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#1877F2]/10 ring-1 ring-[#1877F2]/15">
                          <User className="h-5 w-5 text-[#1877F2]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold text-foreground">{account.fbUserName}</div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {account.pages.length} page{account.pages.length !== 1 ? "s" : ""}
                            {activePages < account.pages.length ? (
                              <> · {activePages} active</>
                            ) : (
                              <> · all active</>
                            )}
                            <span className="mx-1.5 text-border">·</span>
                            <span className="tabular-nums">
                              Updated {formatShortDate(account.connectedAt ?? account.createdAt)}
                            </span>
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5 pl-1">
                          {tokenExpired ? (
                            <Badge
                              variant="outline"
                              className="border-red-200 bg-red-50 text-red-700 text-[10px] uppercase tracking-wide"
                            >
                              Token expired
                            </Badge>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="border-emerald-200/60 bg-emerald-50 text-emerald-800 text-[10px] font-medium uppercase tracking-wide dark:bg-emerald-950/40 dark:text-emerald-300"
                            >
                              Token OK
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
                    <div className="border-t border-border/60 bg-muted/5 px-2 pb-2 pt-1 sm:px-3">
                      {account.pages.length === 0 ? (
                        <p className="py-8 text-center text-sm text-muted-foreground">{t("connections.noPagesForAccount")}</p>
                      ) : (
                        <ul className="space-y-2 py-2">
                          {account.pages.map((page) => (
                            <li
                              key={page.id}
                              className="flex flex-col gap-3 rounded-xl border border-transparent bg-background/80 p-3 shadow-sm transition-all hover:border-border/80 hover:shadow-sm sm:flex-row sm:items-center sm:gap-4"
                            >
                              <div className="min-w-0 flex-1 space-y-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium text-foreground leading-snug">{page.pageName}</span>
                                  {page.subscriptionStatus === "failed" && (
                                    <Badge
                                      variant="outline"
                                      className="border-amber-300 bg-amber-50 text-amber-800 text-[10px] uppercase dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
                                      title={page.subscriptionError ?? t("connections.subscriptionFailed")}
                                    >
                                      {t("connections.webhookIssue")}
                                    </Badge>
                                  )}
                                  {page.isActive ? (
                                    <Badge className="border-0 bg-emerald-100 text-emerald-800 hover:bg-emerald-100 text-[10px] uppercase tracking-wide dark:bg-emerald-950/50 dark:text-emerald-300">
                                      {t("connections.active")}
                                    </Badge>
                                  ) : (
                                    <Badge variant="secondary" className="text-[10px] uppercase tracking-wide text-muted-foreground">
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
                                        className="ml-2 inline text-primary underline-offset-2 hover:underline"
                                      >
                                        {t("connections.pageId")}
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs font-mono text-xs">{page.pageId}</TooltipContent>
                                  </Tooltip>
                                </div>
                              </div>

                              <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-3 sm:border-t-0 sm:pt-0">
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
                          ))}
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
        <div className="flex items-center justify-between gap-3 pt-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("connections.deliverySectionLabel")}
          </span>
          <Button
            type="button"
            size="sm"
            className="h-9 shrink-0 gap-1.5 rounded-lg"
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
        <ConnectionsList />

        <AppPickerModal open={pickerOpen} onOpenChange={setPickerOpen} />

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
