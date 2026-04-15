import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

const CONFIRM_PHRASE = "DISCONNECT";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  facebookAccountId: number | null;
  accountName: string;
  /** Shown in copy; omit when unknown (e.g. legacy list page). */
  pageCount?: number;
};

function AffectedCounts({ facebookAccountId }: { facebookAccountId: number }) {
  const { data } = trpc.facebookAccounts.countAffectedOnDisconnect.useQuery(
    { id: facebookAccountId },
    { enabled: facebookAccountId > 0 }
  );
  if (!data || data.integrations === 0) return null;
  return (
    <li className="text-amber-600 dark:text-amber-400">
      {data.integrations} lead routing rule{data.integrations === 1 ? "" : "s"} tied to this account will also be deleted.
    </li>
  );
}

/**
 * Destructive confirmation: user must type DISCONNECT. DB-only disconnect (no Meta API).
 */
export function DisconnectFacebookAccountDialog({
  open,
  onOpenChange,
  facebookAccountId,
  accountName,
  pageCount,
}: Props) {
  const [phrase, setPhrase] = useState("");
  const utils = trpc.useUtils();

  const mutation = trpc.facebookAccounts.disconnect.useMutation({
    onSuccess: (data) => {
      const parts = [`${data.pagesDisconnected} page${data.pagesDisconnected === 1 ? "" : "s"}`];
      if (data.integrationsDeleted > 0) {
        parts.push(`${data.integrationsDeleted} lead routing rule${data.integrationsDeleted === 1 ? "" : "s"}`);
      }
      toast.success(`Facebook account disconnected (${parts.join(", ")} removed).`);
      void utils.facebookAccounts.getAccountsWithPages.invalidate();
      void utils.facebookAccounts.listConnectedPages.invalidate();
      void utils.facebookAccounts.list.invalidate();
      void utils.integrations.list.invalidate();
      setPhrase("");
      onOpenChange(false);
    },
    onError: (err) => toast.error(err.message),
  });

  useEffect(() => {
    if (!open) setPhrase("");
  }, [open]);

  const canSubmit = phrase === CONFIRM_PHRASE && facebookAccountId != null && facebookAccountId > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className={cn(
          "gap-0 overflow-hidden rounded-2xl border-border/80 p-0 sm:max-w-md",
          "data-[state=open]:animate-in data-[state=closed]:animate-out"
        )}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="border-b border-border/60 bg-destructive/5 px-5 py-4">
          <DialogHeader className="space-y-2 text-left">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-4 w-4 text-destructive" />
              </div>
              <div className="min-w-0 space-y-1">
                <DialogTitle className="text-lg font-semibold leading-tight">Disconnect Facebook account</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-2 pt-1 text-sm text-muted-foreground">
                    <p>
                      This removes <span className="font-medium text-foreground">{accountName || "this account"}</span>
                      {pageCount != null ? (
                        <>
                          {" "}
                          and{" "}
                          <span className="font-medium text-foreground">
                            {pageCount} connected page{pageCount === 1 ? "" : "s"}
                          </span>
                        </>
                      ) : (
                        <> and all page connections tied to it</>
                      )}{" "}
                      from Targenix.
                    </p>
                    <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed">
                      <li>New leads will stop being processed for these pages.</li>
                      <li>All related connections are removed from our database.</li>
                      {facebookAccountId != null && facebookAccountId > 0 && (
                        <AffectedCounts facebookAccountId={facebookAccountId} />
                      )}
                      <li>You can reconnect this Facebook profile anytime.</li>
                    </ul>
                    <p className="text-xs text-muted-foreground/90">
                      We do not call Meta to revoke permissions or unsubscribe webhooks — only our stored data is
                      cleared.
                    </p>
                  </div>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="space-y-2">
            <Label htmlFor="disconnect-confirm" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Type <span className="font-mono text-foreground">{CONFIRM_PHRASE}</span> to confirm
            </Label>
            <Input
              id="disconnect-confirm"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={CONFIRM_PHRASE}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              className={cn(
                "h-11 rounded-xl font-mono text-sm transition-shadow",
                phrase.length > 0 && phrase !== CONFIRM_PHRASE && "border-amber-500/60 focus-visible:ring-amber-500/30",
                phrase === CONFIRM_PHRASE && "border-emerald-600/50 focus-visible:ring-emerald-500/30"
              )}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 border-t border-border/60 bg-muted/20 px-5 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="h-11 min-w-[100px] rounded-xl"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="h-11 min-w-[140px] rounded-xl shadow-sm transition-all enabled:hover:shadow-md disabled:opacity-50"
            disabled={!canSubmit || mutation.isPending}
            onClick={() => {
              if (!canSubmit || facebookAccountId == null) return;
              mutation.mutate({ id: facebookAccountId });
            }}
          >
            {mutation.isPending ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Disconnecting…
              </span>
            ) : (
              "Disconnect account"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
