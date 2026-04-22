/**
 * ApiKeyConnectDialog — in-modal credential form for admin-managed templates.
 *
 * The form is 100% schema-driven: it reads `userVisibleFields` from the
 * template row and renders one input per key. Adding a new affiliate = one
 * admin UI row, zero frontend code. Mirrors TelegramConnectDialog's lifecycle
 * (state reset on open, toast on success, router invalidation) so users don't
 * notice whether they're connecting Telegram or a UZ-CPA affiliate.
 *
 * Storage: `connections.createApiKey` on the server encrypts every secret and
 * writes a new `connections` row linked to the template via
 * `credentialsJson.templateId`. The adapter will pick this up in phase 2D;
 * today the row is already listed in the unified connections feed.
 */

import * as React from "react";
import { trpc } from "@/lib/trpc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Eye, EyeOff, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Shape of a template row passed in from the picker. We intentionally take
// only the fields we render so callers (AppPickerModal) don't have to
// reshape trpc output — just pass the row through.
export interface ApiKeyTemplate {
  id: number;
  name: string;
  /** Keys the user must fill — e.g. ["api_key"] or ["api_key", "secret"]. */
  userVisibleFields: string[];
  /** Optional accent colour matching the picker card. */
  color?: string;
}

export interface ApiKeyConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: ApiKeyTemplate | null;
  /** Fired after the server persisted the row. */
  onCreated?: (connectionId: number, displayName: string) => void;
}

// Human labels for the handful of canonical keys we already use across admin
// templates. Any key outside this map falls back to title-casing so a freshly
// added template renders sensibly without a code change.
const KEY_LABELS: Record<string, string> = {
  api_key: "API key",
  apikey: "API key",
  secret: "Secret",
  client_id: "Client ID",
  client_secret: "Client secret",
  token: "Token",
};

// Only keys that clearly hold credentials get the password/reveal treatment;
// anything else renders as a normal text input (labels, public IDs, …).
const SECRET_KEYS = new Set([
  "api_key",
  "apikey",
  "secret",
  "token",
  "client_secret",
  "password",
]);

function humaniseKey(key: string): string {
  return (
    KEY_LABELS[key] ??
    key
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim()
  );
}

export function ApiKeyConnectDialog({
  open,
  onOpenChange,
  template,
  onCreated,
}: ApiKeyConnectDialogProps) {
  const utils = trpc.useUtils();

  const [displayName, setDisplayName] = React.useState("");
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [revealed, setRevealed] = React.useState<Record<string, boolean>>({});
  const [error, setError] = React.useState<string | null>(null);

  // Re-seed the form whenever the user picks a different template. Keeps the
  // previously-entered values from leaking across apps.
  React.useEffect(() => {
    if (!open || !template) return;
    setDisplayName(`${template.name} — key`);
    const next: Record<string, string> = {};
    for (const k of template.userVisibleFields) next[k] = "";
    setValues(next);
    setRevealed({});
    setError(null);
  }, [open, template]);

  const createMutation = trpc.connections.createApiKey.useMutation({
    onSuccess: (res) => {
      toast.success(`${template?.name ?? "Connection"} saved`);
      utils.connections.list.invalidate();
      onCreated?.(res.id, displayName);
      onOpenChange(false);
    },
    onError: (err) => setError(err.message),
  });

  if (!template) return null;

  const fields = template.userVisibleFields ?? [];
  const incomplete =
    !displayName.trim() || fields.some((k) => !values[k]?.trim());

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (incomplete || createMutation.isPending) return;
    createMutation.mutate({
      templateId: template.id,
      displayName: displayName.trim(),
      secrets: Object.fromEntries(
        fields.map((k) => [k, values[k].trim()]),
      ),
    });
  };

  const accent = template.color ?? "#3B82F6";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <div className="mb-2 flex items-center gap-2">
              <span
                className="flex h-8 w-8 items-center justify-center rounded-lg"
                style={{ backgroundColor: `${accent}1A`, color: accent }}
              >
                <KeyRound className="h-4 w-4" strokeWidth={2.2} />
              </span>
              <DialogTitle className="text-base">
                Connect {template.name}
              </DialogTitle>
            </div>
            <DialogDescription>
              Paste your {template.name} credentials. They're encrypted at
              rest and reusable across every integration.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="apikey-display-name" className="text-xs">
                Connection name
              </Label>
              <Input
                id="apikey-display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={`${template.name} main key`}
                autoFocus
                className="h-10"
              />
            </div>

            {fields.map((key) => {
              const isSecret = SECRET_KEYS.has(key);
              const isOn = revealed[key] === true;
              return (
                <div key={key} className="space-y-1.5">
                  <Label
                    htmlFor={`apikey-field-${key}`}
                    className="text-xs"
                  >
                    {humaniseKey(key)}
                    <span className="text-rose-500">&nbsp;*</span>
                  </Label>
                  <div className="relative">
                    <Input
                      id={`apikey-field-${key}`}
                      type={isSecret && !isOn ? "password" : "text"}
                      value={values[key] ?? ""}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [key]: e.target.value,
                        }))
                      }
                      placeholder={
                        isSecret
                          ? "Paste the value from your provider dashboard"
                          : `Enter ${humaniseKey(key).toLowerCase()}`
                      }
                      className={cn("h-10", isSecret && "pr-10 font-mono")}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {isSecret && (
                      <button
                        type="button"
                        tabIndex={-1}
                        onClick={() =>
                          setRevealed((prev) => ({
                            ...prev,
                            [key]: !isOn,
                          }))
                        }
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {isOn ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {error && (
              <p className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                {error}
              </p>
            )}
          </div>

          <DialogFooter className="mt-5 gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={incomplete || createMutation.isPending}
            >
              {createMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save connection"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
