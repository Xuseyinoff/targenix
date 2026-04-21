/**
 * ConnectionPicker — reusable dropdown for selecting a saved connection.
 *
 * Used by destination forms (Google Sheets, Telegram) to let the user pick
 * one of their existing connections instead of re-pasting credentials every
 * time. When the list is empty the picker surfaces a "Connect new" link that
 * opens /connections in a new tab — the destination form keeps the user's
 * in-progress state, they come back and refresh.
 *
 * Props intentionally small so the component is trivially embeddable:
 *   type            — which connections are eligible (google_sheets | telegram_bot)
 *   value           — currently selected connectionId or null
 *   onChange        — fires with the new connectionId (or null when cleared)
 *   label/helpText  — i18n strings provided by the parent form
 */

import * as React from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Plus, Link as LinkIcon, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
import { trpc } from "@/lib/trpc";
import { useGoogleOAuthPopup } from "@/hooks/useGoogleOAuthPopup";

export type ConnectionPickerType = "google_sheets" | "telegram_bot";

export interface ConnectionPickerProps {
  type: ConnectionPickerType;
  value: number | null;
  onChange: (id: number | null) => void;
  /** Optional label shown above the select. Parent is responsible for i18n. */
  label?: string;
  /** Optional helper text under the select. */
  helpText?: string;
  /** Mark the field as required in the surrounding form. */
  required?: boolean;
  /** Disable selection — used while the parent form is saving. */
  disabled?: boolean;
  /** Called after the user closes the "Connect new" menu so the picker can
   *  refetch connections. Defaults to refetching inside the component. */
  onAfterConnect?: () => void;
  className?: string;
}

const NONE_VALUE = "__none__";

export function ConnectionPicker({
  type,
  value,
  onChange,
  label,
  helpText,
  required,
  disabled,
  onAfterConnect,
  className,
}: ConnectionPickerProps) {
  const t = useT();
  const { data, isLoading, refetch } = trpc.connections.list.useQuery(
    { type },
    { refetchOnWindowFocus: true },
  );

  const items = React.useMemo(() => data ?? [], [data]);

  // When the currently-selected connection disappears (deleted elsewhere)
  // we eagerly clear it so the parent form doesn't send a stale id on save.
  React.useEffect(() => {
    if (value == null) return;
    if (isLoading) return;
    if (!items.some((c) => c.id === value)) {
      onChange(null);
    }
  }, [items, value, isLoading, onChange]);

  const selectValue = value == null ? NONE_VALUE : String(value);
  const hasAny = items.length > 0;

  // Inline Google OAuth popup. After the popup completes we refetch the
  // connections list and auto-select the connection that now points at the
  // newly linked google_accounts row — this removes the "open new tab,
  // come back, pick from dropdown" three-step dance Make.com/Zapier avoid.
  const { start: startGoogleOAuth, isConnecting } = useGoogleOAuthPopup({
    onConnected: async (googleAccountId, email) => {
      toast.success(
        email
          ? t("connections.google.connectedWithEmail", { email })
          : t("connections.google.connected"),
      );
      const res = await refetch();
      const list = res.data ?? [];
      const fresh = list.find((c) => c.google?.accountId === googleAccountId);
      if (fresh) {
        onChange(fresh.id);
      }
      if (onAfterConnect) onAfterConnect();
    },
    onError: (message) => {
      toast.error(message);
    },
  });

  const supportsInlineOAuth = type === "google_sheets";

  const handleOpenConnectionsPage = () => {
    if (onAfterConnect) onAfterConnect();
    void refetch();
  };

  const handleConnectNew = () => {
    if (supportsInlineOAuth) {
      void startGoogleOAuth();
      return;
    }
    // Telegram bot connections require a manual bot token + chat id dialog
    // — that flow lives on /connections for now. Opening the tab so the
    // user can finish there, then refetch on focus-return.
    window.open("/connections", "_blank", "noreferrer");
    handleOpenConnectionsPage();
  };

  return (
    <div className={cn("space-y-2", className)}>
      {label && (
        <Label className="text-sm font-medium">
          {label}
          {required && <span className="ml-1 text-destructive">*</span>}
        </Label>
      )}

      <div className="flex items-center gap-2">
        <Select
          value={selectValue}
          disabled={disabled || isLoading}
          onValueChange={(v) => onChange(v === NONE_VALUE ? null : Number(v))}
        >
          <SelectTrigger className="h-10 flex-1">
            {isLoading ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("connections.picker.loading")}
              </span>
            ) : (
              <SelectValue placeholder={t("connections.picker.placeholder")} />
            )}
          </SelectTrigger>
          <SelectContent>
            {!hasAny ? (
              <div className="py-6 px-3 text-center text-sm text-muted-foreground">
                {t("connections.picker.empty")}
              </div>
            ) : (
              items.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate">{c.displayName}</span>
                    {c.status !== "active" ? (
                      <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800 text-[10px]">
                        <AlertTriangle className="h-3 w-3 mr-1" />
                        {c.status}
                      </Badge>
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    )}
                    {c.usageCount > 0 && (
                      <span className="text-[11px] text-muted-foreground shrink-0">
                        · {t("connections.picker.usedBy", { count: c.usageCount })}
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        {supportsInlineOAuth ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={handleConnectNew}
            disabled={disabled || isConnecting}
            title={
              hasAny
                ? t("connections.picker.manage")
                : t("connections.google.connect")
            }
          >
            {isConnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : hasAny ? (
              <LinkIcon className="h-4 w-4" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
          </Button>
        ) : (
          <Button
            asChild
            type="button"
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0"
            onClick={handleOpenConnectionsPage}
            title={t("connections.picker.manage")}
          >
            <Link href="/connections" target="_blank" rel="noreferrer">
              {hasAny ? <LinkIcon className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            </Link>
          </Button>
        )}
      </div>

      {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}

      {!isLoading && !hasAny && (
        <p className="text-xs text-muted-foreground">
          {supportsInlineOAuth ? (
            <>
              {t("connections.picker.emptyHint")}{" "}
              <button
                type="button"
                onClick={handleConnectNew}
                disabled={disabled || isConnecting}
                className="font-medium text-primary hover:underline disabled:opacity-60"
              >
                {isConnecting
                  ? t("connections.google.connecting")
                  : t("connections.google.connect")}
              </button>
            </>
          ) : (
            <>
              {t("connections.picker.emptyHint")}{" "}
              <Link
                href="/connections"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary hover:underline"
              >
                {t("connections.picker.openConnections")}
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}
