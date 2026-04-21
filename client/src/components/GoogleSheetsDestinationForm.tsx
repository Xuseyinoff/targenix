/**
 * Google Sheets destination fields — used inside Destinations modal (configure step).
 * Spreadsheet: pick from Drive, search, or manual ID (legacy). Tabs load from Sheets API.
 */

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, FlaskConical, Table2, RefreshCw } from "lucide-react";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { GOOGLE_SHEETS_MAPPABLE_FIELDS } from "@shared/googleSheets";
import { trpc } from "@/lib/trpc";

/**
 * Channel + message types sent by GET /api/auth/google/callback (integration flow).
 * See server/routes/googleOAuth.ts → popupHtml().
 */
const GOOGLE_OAUTH_CHANNEL = "targenix_google_oauth";
type GoogleOAuthMessage =
  | {
      type: "google_oauth_success";
      accountId: number;
      email?: string;
      name?: string;
      picture?: string;
      scopes?: string;
    }
  | { type: "google_oauth_error"; error?: string };

const NONE_VALUE = "__none__";
const SHEET_MANUAL_VALUE = "__manual_sheet__";
/** Placeholder row when multiple tabs exist but none chosen yet. */
const SHEET_TAB_PICK_VALUE = "__pick_sheet_tab__";

export type GoogleSheetsFieldErrors = Partial<
  Record<"googleAccountId" | "spreadsheetId" | "sheetName" | "mapping", string>
>;

export type SpreadsheetPickerMode = "select" | "search" | "manual";

export interface GoogleIntegrationAccount {
  id: number;
  email: string;
}

export interface GoogleSheetsDestinationFormProps {
  accounts: GoogleIntegrationAccount[];
  googleAccountId: number | null;
  spreadsheetId: string;
  sheetName: string;
  /** Row 1 labels from Google (after Load columns). */
  sheetHeaders: string[];
  /** Header cell text → mappable field key (or __none__). */
  columnMapping: Record<string, string>;
  fieldErrors: GoogleSheetsFieldErrors;
  onGoogleAccountIdChange: (id: number | null) => void;
  onSpreadsheetIdChange: (v: string) => void;
  onSheetNameChange: (v: string) => void;
  onSheetHeadersLoaded: (headers: string[]) => void;
  onColumnMappingChange: (header: string, fieldKey: string) => void;
  onAccountsRefresh: () => void;
  /** Fetch row 1 via tRPC */
  onLoadColumns: () => Promise<{ success: boolean; headers?: string[]; error?: string }>;
  loadColumnsPending?: boolean;
  loadColumnsError?: string | null;
  onLoadColumnsError: (msg: string | null) => void;
  /** Test connection — parent wires testIntegration mutation */
  onTestConnection: () => void;
  isTesting: boolean;
  canTest: boolean;
  accountsLoading?: boolean;
}

export function GoogleSheetsDestinationForm({
  accounts,
  googleAccountId,
  spreadsheetId,
  sheetName,
  sheetHeaders,
  columnMapping,
  fieldErrors,
  onGoogleAccountIdChange,
  onSpreadsheetIdChange,
  onSheetNameChange,
  onSheetHeadersLoaded,
  onColumnMappingChange,
  onAccountsRefresh,
  onLoadColumns,
  loadColumnsPending,
  loadColumnsError,
  onLoadColumnsError,
  onTestConnection,
  isTesting,
  canTest,
  accountsLoading,
}: GoogleSheetsDestinationFormProps) {
  const t = useT();
  const [connectBusy, setConnectBusy] = React.useState(false);
  const [pickerMode, setPickerMode] = React.useState<SpreadsheetPickerMode>("select");
  const [searchDraft, setSearchDraft] = React.useState("");
  const [spreadsheetList, setSpreadsheetList] = React.useState<{ id: string; name: string }[]>([]);
  const [spreadsheetsListError, setSpreadsheetsListError] = React.useState<string | null>(null);
  const [sheetTitles, setSheetTitles] = React.useState<string[]>([]);
  const [sheetTabsError, setSheetTabsError] = React.useState<string | null>(null);
  const [sheetTabsLoading, setSheetTabsLoading] = React.useState(false);
  const [useManualSheetName, setUseManualSheetName] = React.useState(false);

  const listSpreadsheetsMutation = trpc.google.listSpreadsheets.useMutation();
  const listSheetsMutation = trpc.google.listSheets.useMutation();

  const hasAccounts = accounts.length > 0;
  const idLooksValid = spreadsheetId.trim().length >= 10;

  React.useEffect(() => {
    setSpreadsheetList([]);
    setSpreadsheetsListError(null);
    setSheetTitles([]);
    setSheetTabsError(null);
    setUseManualSheetName(false);
    setSearchDraft("");
  }, [googleAccountId]);

  /** Select from list: load when account or select mode is active. */
  React.useEffect(() => {
    if (pickerMode !== "select" || googleAccountId == null || !hasAccounts) return;
    let cancelled = false;
    setSpreadsheetsListError(null);
    void listSpreadsheetsMutation
      .mutateAsync({ googleAccountId })
      .then((r) => {
        if (cancelled) return;
        if (r.success && r.data) setSpreadsheetList(r.data);
        else {
          setSpreadsheetList([]);
          setSpreadsheetsListError(r.error ?? t("destinations.sheets.listSpreadsheetsFailed"));
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setSpreadsheetList([]);
          setSpreadsheetsListError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // listSpreadsheetsMutation / t intentionally omitted — stable enough; avoids refetch loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerMode, googleAccountId, hasAccounts]);

  /** Search: debounced Drive query. */
  React.useEffect(() => {
    if (pickerMode !== "search" || googleAccountId == null || !hasAccounts) return;
    let cancelled = false;
    const h = window.setTimeout(() => {
      setSpreadsheetsListError(null);
      void listSpreadsheetsMutation
        .mutateAsync({
          googleAccountId,
          nameContains: searchDraft.trim() || undefined,
        })
        .then((r) => {
          if (cancelled) return;
          if (r.success && r.data) setSpreadsheetList(r.data);
          else {
            setSpreadsheetList([]);
            setSpreadsheetsListError(r.error ?? t("destinations.sheets.listSpreadsheetsFailed"));
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setSpreadsheetList([]);
            setSpreadsheetsListError(e instanceof Error ? e.message : String(e));
          }
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(h);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickerMode, googleAccountId, hasAccounts, searchDraft]);

  /** Sheet tabs when spreadsheet id + account ready. */
  React.useEffect(() => {
    if (googleAccountId == null || !idLooksValid) {
      setSheetTitles([]);
      setSheetTabsLoading(false);
      setSheetTabsError(null);
      return;
    }
    let cancelled = false;
    setSheetTabsLoading(true);
    setSheetTabsError(null);
    const tid = window.setTimeout(() => {
      void listSheetsMutation
        .mutateAsync({
          googleAccountId,
          spreadsheetId: spreadsheetId.trim(),
        })
        .then((r) => {
          if (cancelled) return;
          if (r.success && r.data) {
            setSheetTitles(r.data);
            setSheetTabsError(null);
          } else {
            setSheetTitles([]);
            setSheetTabsError(r.error ?? null);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setSheetTitles([]);
            setSheetTabsError(e instanceof Error ? e.message : String(e));
          }
        })
        .finally(() => {
          if (!cancelled) setSheetTabsLoading(false);
        });
    }, 450);
    return () => {
      cancelled = true;
      window.clearTimeout(tid);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleAccountId, spreadsheetId, idLooksValid]);

  /** Single tab: default sheet name. */
  React.useEffect(() => {
    if (sheetTitles.length !== 1 || sheetName.trim()) return;
    onSheetNameChange(sheetTitles[0]!);
  }, [sheetTitles, sheetName, onSheetNameChange]);

  /** If API returns tabs, decide whether the current name is a preset tab or custom. */
  React.useEffect(() => {
    if (sheetTitles.length === 0) return;
    const sn = sheetName.trim();
    if (!sn) {
      setUseManualSheetName(false);
      return;
    }
    setUseManualSheetName(!sheetTitles.includes(sn));
  }, [sheetTitles, sheetName]);

  /**
   * Tracks the popup window + its close-polling timer so the success/error
   * listener can stop polling as soon as the callback posts a message.
   */
  const popupRef = React.useRef<Window | null>(null);
  const popupPollRef = React.useRef<number | null>(null);

  const clearPopupWatch = React.useCallback(() => {
    if (popupPollRef.current != null) {
      window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
    }
    popupRef.current = null;
  }, []);

  /**
   * Listen for the integration OAuth callback message.
   * Server broadcasts on BroadcastChannel("targenix_google_oauth") AND
   * posts via window.opener.postMessage (same-origin). We handle both so
   * we stay robust across browsers that restrict either transport.
   */
  React.useEffect(() => {
    const handleSuccess = (msg: GoogleOAuthMessage) => {
      clearPopupWatch();
      setConnectBusy(false);
      if (msg.type === "google_oauth_success") {
        toast.success(
          msg.email
            ? t("destinations.sheets.connectedWithEmail", { email: msg.email })
            : t("destinations.sheets.connected"),
        );
        onAccountsRefresh();
        onGoogleAccountIdChange(msg.accountId);
      } else if (msg.type === "google_oauth_error") {
        toast.error(msg.error || t("destinations.sheets.connectFailed"));
      }
    };

    const bc = new BroadcastChannel(GOOGLE_OAUTH_CHANNEL);
    const bcHandler = (e: MessageEvent) => {
      const data = e.data as GoogleOAuthMessage | undefined;
      if (!data || typeof data !== "object") return;
      if (data.type === "google_oauth_success" || data.type === "google_oauth_error") {
        handleSuccess(data);
      }
    };
    bc.addEventListener("message", bcHandler);

    const winHandler = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as GoogleOAuthMessage | undefined;
      if (!data || typeof data !== "object") return;
      if (data.type === "google_oauth_success" || data.type === "google_oauth_error") {
        handleSuccess(data);
      }
    };
    window.addEventListener("message", winHandler);

    return () => {
      bc.removeEventListener("message", bcHandler);
      bc.close();
      window.removeEventListener("message", winHandler);
      clearPopupWatch();
    };
  }, [clearPopupWatch, onAccountsRefresh, onGoogleAccountIdChange, t]);

  async function handleConnectGoogle() {
    // Prevent double-opening while a popup is already in flight.
    if (connectBusy) return;
    setConnectBusy(true);
    try {
      const res = await fetch("/api/auth/google/initiate", { credentials: "include" });
      const data = (await res.json()) as { oauthUrl?: string; error?: string };
      if (!res.ok || !data.oauthUrl) {
        throw new Error(data.error || t("destinations.sheets.connectFailed"));
      }

      // Sized popup (not _blank) — mirrors the Login/Facebook flow.
      const width = 520;
      const height = 640;
      const left = Math.max(0, Math.floor(window.screenX + (window.outerWidth - width) / 2));
      const top = Math.max(0, Math.floor(window.screenY + (window.outerHeight - height) / 2));
      const popup = window.open(
        data.oauthUrl,
        "targenix_google_oauth_popup",
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`,
      );
      if (!popup) {
        setConnectBusy(false);
        toast.error(t("destinations.sheets.popupBlocked"));
        return;
      }
      popupRef.current = popup;

      // Poll for manual close — if the user dismisses the popup without
      // finishing auth, stop the spinner. The message listener cancels this
      // interval first on success.
      popupPollRef.current = window.setInterval(() => {
        if (popupRef.current?.closed) {
          clearPopupWatch();
          // Use functional setter so this doesn't race with success handler.
          setConnectBusy((prev) => (prev ? false : prev));
        }
      }, 600);
    } catch (err) {
      setConnectBusy(false);
      toast.error(err instanceof Error ? err.message : t("destinations.sheets.connectFailed"));
    }
  }

  async function handleLoadColumns() {
    onLoadColumnsError(null);
    const out = await onLoadColumns();
    if (!out.success) {
      onLoadColumnsError(out.error ?? t("destinations.sheets.loadColumnsFailed"));
      onSheetHeadersLoaded([]);
      return;
    }
    const headers = out.headers ?? [];
    onSheetHeadersLoaded(headers);
    if (headers.length === 0) {
      onLoadColumnsError(t("destinations.sheets.emptyHeaderRow"));
    }
  }

  const spreadsheetsLoading = listSpreadsheetsMutation.isPending;

  const sheetTabSelectValue = useManualSheetName
    ? SHEET_MANUAL_VALUE
    : sheetName.trim() && sheetTitles.includes(sheetName.trim())
      ? sheetName.trim()
      : sheetTitles.length > 1
        ? SHEET_TAB_PICK_VALUE
        : sheetTitles.length === 1
          ? sheetTitles[0]!
          : SHEET_TAB_PICK_VALUE;

  return (
    <div className="space-y-5 rounded-2xl border border-emerald-200/60 bg-card/40 p-4 shadow-sm dark:border-emerald-900/40 dark:bg-card/20">
      <div className="flex gap-3 rounded-xl border border-emerald-200/50 bg-gradient-to-br from-emerald-500/[0.08] via-background to-background p-3.5 dark:border-emerald-900/40 dark:from-emerald-950/30">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-md shadow-emerald-600/20 dark:bg-emerald-700">
          <Table2 className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold tracking-tight text-foreground">{t("destinations.sheets.title")}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("destinations.sheets.desc")}</p>
        </div>
      </div>

      {!hasAccounts && !accountsLoading ? (
        <div className="rounded-xl border border-dashed border-muted-foreground/40 bg-muted/20 p-4 text-sm">
          <p className="text-muted-foreground">{t("destinations.sheets.noAccounts")}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t("destinations.sheets.connectGoogleHint")}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="default" disabled={connectBusy} onClick={handleConnectGoogle}>
              {connectBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("destinations.sheets.connectGoogle")}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onAccountsRefresh}>
              {t("destinations.sheets.refreshAccounts")}
            </Button>
          </div>
        </div>
      ) : null}

      {hasAccounts || accountsLoading ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-sm font-medium">
              {t("destinations.sheets.googleAccount")} <span className="text-destructive">*</span>
            </Label>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onAccountsRefresh}>
              {t("destinations.sheets.refreshAccounts")}
            </Button>
          </div>
          <Select
            value={googleAccountId != null ? String(googleAccountId) : ""}
            onValueChange={(v) => onGoogleAccountIdChange(v ? parseInt(v, 10) : null)}
            disabled={accountsLoading || !hasAccounts}
          >
            <SelectTrigger className={cn("h-10", fieldErrors.googleAccountId && "border-destructive")}>
              <SelectValue placeholder={t("destinations.sheets.selectAccount")} />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {fieldErrors.googleAccountId ? (
            <p className="text-xs text-destructive">{fieldErrors.googleAccountId}</p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-2 rounded-lg border border-border/60 bg-muted/5 p-3">
        <Label className="text-sm font-medium">{t("destinations.sheets.pickerModeLabel")}</Label>
        <Select
          value={pickerMode}
          onValueChange={(v) => {
            const m = v as SpreadsheetPickerMode;
            setPickerMode(m);
            setSpreadsheetsListError(null);
            if (m === "manual") {
              setSpreadsheetList([]);
            }
          }}
          disabled={!hasAccounts && !accountsLoading}
        >
          <SelectTrigger className="h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="select">{t("destinations.sheets.pickerModeSelect")}</SelectItem>
            <SelectItem value="search">{t("destinations.sheets.pickerModeSearch")}</SelectItem>
            <SelectItem value="manual">{t("destinations.sheets.pickerModeManual")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {pickerMode === "manual" ? (
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">
            {t("destinations.sheets.spreadsheetId")} <span className="text-destructive">*</span>
          </Label>
          <Input
            className={cn("h-10 font-mono text-sm", fieldErrors.spreadsheetId && "border-destructive")}
            placeholder="1AbcXYZ..."
            value={spreadsheetId}
            onChange={(e) => onSpreadsheetIdChange(e.target.value)}
            disabled={!hasAccounts && !accountsLoading}
          />
          <p className="text-xs text-muted-foreground">{t("destinations.sheets.pasteIdHint")}</p>
          <p className="text-[11px] text-muted-foreground font-mono break-all">{t("destinations.sheets.urlExample")}</p>
          {fieldErrors.spreadsheetId ? <p className="text-xs text-destructive">{fieldErrors.spreadsheetId}</p> : null}
        </div>
      ) : (
        <div className="space-y-2">
          {pickerMode === "search" ? (
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">{t("destinations.sheets.spreadsheetSearchLabel")}</Label>
              <Input
                className="h-10"
                placeholder={t("destinations.sheets.spreadsheetSearchPlaceholder")}
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                disabled={!hasAccounts || googleAccountId == null}
              />
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Label className="text-sm font-medium shrink-0">
              {t("destinations.sheets.pickSpreadsheet")} <span className="text-destructive">*</span>
            </Label>
            {pickerMode === "select" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1"
                disabled={!hasAccounts || googleAccountId == null || spreadsheetsLoading}
                onClick={() => {
                  if (googleAccountId == null) return;
                  setSpreadsheetsListError(null);
                  void listSpreadsheetsMutation
                    .mutateAsync({ googleAccountId })
                    .then((r) => {
                      if (r.success && r.data) setSpreadsheetList(r.data);
                      else {
                        setSpreadsheetList([]);
                        setSpreadsheetsListError(r.error ?? t("destinations.sheets.listSpreadsheetsFailed"));
                      }
                    })
                    .catch((e) => {
                      setSpreadsheetList([]);
                      setSpreadsheetsListError(e instanceof Error ? e.message : String(e));
                    });
                }}
              >
                {spreadsheetsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {t("destinations.sheets.reloadSpreadsheets")}
              </Button>
            ) : null}
          </div>

          {spreadsheetsLoading ? (
            <div className="flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              {t("destinations.sheets.loadingSpreadsheets")}
            </div>
          ) : null}

          {spreadsheetsListError ? (
            <p className="text-xs text-destructive rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5">
              {spreadsheetsListError}
            </p>
          ) : null}

          {!spreadsheetsLoading && !spreadsheetsListError && spreadsheetList.length === 0 && hasAccounts && googleAccountId != null ? (
            <p className="text-xs text-muted-foreground rounded-md border border-dashed border-muted-foreground/30 bg-muted/10 px-3 py-2">
              {t("destinations.sheets.noSpreadsheets")}
            </p>
          ) : null}

          {!spreadsheetsLoading && spreadsheetList.length > 0 ? (
            <Select
              value={spreadsheetId.trim() && spreadsheetList.some((s) => s.id === spreadsheetId.trim()) ? spreadsheetId.trim() : undefined}
              onValueChange={(id) => {
                onSpreadsheetIdChange(id);
                onSheetHeadersLoaded([]);
                setUseManualSheetName(false);
              }}
              disabled={!hasAccounts || googleAccountId == null}
            >
              <SelectTrigger className={cn("h-10", fieldErrors.spreadsheetId && "border-destructive")}>
                <SelectValue placeholder={t("destinations.sheets.pickSpreadsheetPlaceholder")} />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {spreadsheetList.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="truncate">{s.name}</span>
                    <span className="ml-2 font-mono text-[10px] text-muted-foreground">{s.id.slice(0, 8)}…</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          {fieldErrors.spreadsheetId ? <p className="text-xs text-destructive">{fieldErrors.spreadsheetId}</p> : null}
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">
          {t("destinations.sheets.sheetName")} <span className="text-destructive">*</span>
        </Label>
        {sheetTabsLoading ? (
          <div className="flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            {t("destinations.sheets.loadingSheetTabs")}
          </div>
        ) : null}
        {sheetTabsError ? <p className="text-xs text-destructive">{sheetTabsError}</p> : null}

        {!sheetTabsLoading && sheetTitles.length > 0 ? (
          <div className="space-y-2">
            <Select
              value={sheetTabSelectValue}
              onValueChange={(v) => {
                if (v === SHEET_TAB_PICK_VALUE) return;
                if (v === SHEET_MANUAL_VALUE) {
                  setUseManualSheetName(true);
                  return;
                }
                setUseManualSheetName(false);
                onSheetNameChange(v);
                onSheetHeadersLoaded([]);
              }}
              disabled={!hasAccounts && !accountsLoading}
            >
              <SelectTrigger className={cn("h-10", fieldErrors.sheetName && "border-destructive")}>
                <SelectValue placeholder={t("destinations.sheets.sheetTabPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {sheetTitles.length > 1 ? (
                  <SelectItem value={SHEET_TAB_PICK_VALUE} disabled>
                    {t("destinations.sheets.sheetTabPlaceholder")}
                  </SelectItem>
                ) : null}
                {sheetTitles.map((tab) => (
                  <SelectItem key={tab} value={tab}>
                    {tab}
                  </SelectItem>
                ))}
                <SelectItem value={SHEET_MANUAL_VALUE}>{t("destinations.sheets.sheetTabManual")}</SelectItem>
              </SelectContent>
            </Select>
            {useManualSheetName ? (
              <Input
                className="h-10"
                placeholder={t("destinations.sheets.sheetCustomPlaceholder")}
                value={sheetName}
                onChange={(e) => onSheetNameChange(e.target.value)}
                disabled={!hasAccounts && !accountsLoading}
              />
            ) : null}
          </div>
        ) : (
          <Input
            className={cn("h-10", fieldErrors.sheetName && "border-destructive")}
            placeholder="Sheet1"
            value={sheetName}
            onChange={(e) => onSheetNameChange(e.target.value)}
            disabled={!hasAccounts && !accountsLoading}
          />
        )}
        {fieldErrors.sheetName ? <p className="text-xs text-destructive">{fieldErrors.sheetName}</p> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-9"
          disabled={
            loadColumnsPending ||
            !hasAccounts ||
            googleAccountId == null ||
            !spreadsheetId.trim() ||
            !sheetName.trim()
          }
          onClick={() => void handleLoadColumns()}
        >
          {loadColumnsPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("destinations.sheets.loadColumns")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("destinations.sheets.loadColumnsHint")}</p>
      </div>
      {loadColumnsError ? <p className="text-xs text-destructive">{loadColumnsError}</p> : null}
      {fieldErrors.mapping ? <p className="text-xs text-destructive">{fieldErrors.mapping}</p> : null}

      {sheetHeaders.length > 0 ? (
        <div className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3">
          <p className="text-xs font-medium text-muted-foreground">{t("destinations.sheets.columnMappingTitle")}</p>
          <ul className="space-y-2.5">
            {sheetHeaders.map((col, idx) => {
              const key = `${idx}:${col}`;
              const value = columnMapping[col] ?? NONE_VALUE;
              return (
                <li key={key} className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                  <span className="text-xs font-medium text-foreground sm:w-[40%] sm:min-w-0 sm:truncate" title={col}>
                    {t("destinations.sheets.columnLabel")}: {col || `(${t("destinations.sheets.emptyColumn")})`}
                  </span>
                  <Select value={value} onValueChange={(v) => onColumnMappingChange(col, v)}>
                    <SelectTrigger className="h-9 sm:max-w-xs">
                      <SelectValue placeholder={t("destinations.sheets.mapToField")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>{t("destinations.sheets.mapNone")}</SelectItem>
                      {GOOGLE_SHEETS_MAPPABLE_FIELDS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {t(`destinations.sheets.field.${f}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="space-y-2 border-t border-border/50 pt-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={onTestConnection}
            disabled={isTesting || !canTest}
            className="h-9 gap-2"
            title={!canTest ? t("destinations.form.testSaveFirstTitle") : undefined}
          >
            {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            {isTesting ? t("destinations.form.testing") : t("destinations.sheets.testConnection")}
          </Button>
          <p className="text-xs text-muted-foreground sm:pl-1">
            {canTest ? t("destinations.form.testDescReady") : t("destinations.form.testDescLocked")}
          </p>
        </div>
      </div>
    </div>
  );
}
