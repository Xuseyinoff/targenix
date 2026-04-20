/**
 * Google Sheets destination fields — used inside Destinations modal (configure step).
 */

import * as React from "react";
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
import { Loader2, FlaskConical, Table2 } from "lucide-react";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { GOOGLE_SHEETS_MAPPABLE_FIELDS } from "@shared/googleSheets";

const NONE_VALUE = "__none__";

export type GoogleSheetsFieldErrors = Partial<
  Record<"googleAccountId" | "spreadsheetId" | "sheetName" | "mapping", string>
>;

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

  async function handleConnectGoogle() {
    setConnectBusy(true);
    try {
      const res = await fetch("/api/auth/google/initiate", { credentials: "include" });
      const data = (await res.json()) as { oauthUrl?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.error || "Could not start Google connection");
      }
      if (data.oauthUrl) {
        window.open(data.oauthUrl, "_blank", "noopener,noreferrer");
      }
    } catch {
      /* non-fatal */
    } finally {
      setConnectBusy(false);
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

  const hasAccounts = accounts.length > 0;

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

      <div className="space-y-1.5">
        <Label className="text-sm font-medium">
          {t("destinations.sheets.sheetName")} <span className="text-destructive">*</span>
        </Label>
        <Input
          className={cn("h-10", fieldErrors.sheetName && "border-destructive")}
          placeholder="Sheet1"
          value={sheetName}
          onChange={(e) => onSheetNameChange(e.target.value)}
          disabled={!hasAccounts && !accountsLoading}
        />
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
                  <Select
                    value={value}
                    onValueChange={(v) => onColumnMappingChange(col, v)}
                  >
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
