import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  Plus,
  Copy,
  MoreHorizontal,
  Play,
  Trash2,
  RefreshCw,
  Clock,
  Webhook,
  Calendar,
  Hand,
  Key,
  History,
  Loader2,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type TriggerType = "webhook" | "schedule" | "manual" | "api";

const TYPE_META: Record<TriggerType, { label: string; icon: React.ElementType; color: string }> = {
  webhook:  { label: "Webhook",   icon: Webhook,   color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  schedule: { label: "Schedule",  icon: Calendar,  color: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400" },
  manual:   { label: "Manual",    icon: Hand,      color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  api:      { label: "API",       icon: Key,       color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
};

const EXEC_STATUS_META = {
  received: { label: "Received", cls: "bg-blue-100 text-blue-700" },
  success:  { label: "Success",  cls: "bg-emerald-100 text-emerald-700" },
  failed:   { label: "Failed",   cls: "bg-red-100 text-red-700" },
};

// ─── Copy button ──────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// ─── Create dialog ────────────────────────────────────────────────────────────

function CreateTriggerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const [type, setType] = useState<TriggerType>("webhook");
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 * * * *");

  const create = trpc.triggers.create.useMutation({
    onSuccess: () => {
      toast.success("Trigger yaratildi");
      void utils.triggers.list.invalidate();
      onClose();
      setName("");
      setType("webhook");
      setCron("0 * * * *");
    },
    onError: (e) => toast.error(e.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { toast.error("Nom kiriting"); return; }
    if (type === "schedule") {
      create.mutate({ type, name: name.trim(), cron: cron.trim() });
    } else {
      create.mutate({ type, name: name.trim() } as Parameters<typeof create.mutate>[0]);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Yangi Trigger</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label>Turi</Label>
            <div className="grid grid-cols-2 gap-2">
              {(Object.keys(TYPE_META) as TriggerType[]).map((t) => {
                const m = TYPE_META[t];
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={cn(
                      "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                      type === t
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:bg-muted"
                    )}
                  >
                    <m.icon className="h-4 w-4" />
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="trigger-name">Nomi</Label>
            <Input
              id="trigger-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Masalan: Yangi lid keldi"
              autoFocus
            />
          </div>

          {type === "schedule" && (
            <div className="space-y-1.5">
              <Label htmlFor="trigger-cron">Cron ifoda</Label>
              <Input
                id="trigger-cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 * * * *"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                5 maydonli cron (daqiqa soat kun oy hafta)
              </p>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Bekor</Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Yaratish
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Execution history sheet ──────────────────────────────────────────────────

function ExecutionHistorySheet({
  triggerId,
  triggerName,
  open,
  onClose,
}: {
  triggerId: number;
  triggerName: string;
  open: boolean;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  const { data, isLoading } = trpc.triggers.executions.useQuery(
    { triggerId, limit: PAGE_SIZE, offset: page * PAGE_SIZE },
    { enabled: open }
  );

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 py-4 border-b">
          <SheetTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            {triggerName} — Tarix
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              Hali hech narsa qayd etilmagan
            </div>
          ) : (
            <div className="divide-y">
              {data.items.map((exec) => {
                const meta = EXEC_STATUS_META[exec.status ?? "received"] ?? EXEC_STATUS_META.received;
                return (
                  <div key={exec.id} className="px-6 py-3 flex items-start gap-3">
                    <div className="pt-0.5 shrink-0">
                      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", meta.cls)}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-xs text-muted-foreground">
                        {exec.executedAt ? new Date(exec.executedAt).toLocaleString("uz-UZ") : "—"}
                        {exec.source && <span className="ml-2 opacity-60">via {exec.source}</span>}
                      </p>
                      {exec.payload != null && (
                        <pre className="text-[11px] text-muted-foreground truncate max-w-xs">
                          {JSON.stringify(exec.payload as Record<string, unknown>).slice(0, 120)}
                        </pre>
                      )}
                      {exec.error && (
                        <p className="text-xs text-red-500 truncate">{exec.error}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-3 border-t">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Oldingi
            </Button>
            <span className="text-xs text-muted-foreground">{page + 1} / {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
              Keyingi
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Trigger row ──────────────────────────────────────────────────────────────

function TriggerRow({
  trigger,
  appUrl,
}: {
  trigger: {
    id: number;
    name: string;
    type: TriggerType;
    webhookKey: string | null;
    isActive: boolean;
    lastFiredAt: Date | null;
    execCount: number;
  };
  appUrl: string;
}) {
  const utils = trpc.useUtils();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const typeMeta = TYPE_META[trigger.type] ?? TYPE_META.manual;
  const TypeIcon = typeMeta.icon;

  const toggleActive = trpc.triggers.update.useMutation({
    onSuccess: () => void utils.triggers.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  const fire = trpc.triggers.fire.useMutation({
    onSuccess: () => {
      toast.success("Trigger ishga tushirildi");
      void utils.triggers.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const regenerateKey = trpc.triggers.regenerateKey.useMutation({
    onSuccess: (data) => {
      toast.success("Yangi key yaratildi");
      void navigator.clipboard.writeText(buildWebhookUrl(data.webhookKey));
      void utils.triggers.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteTrigger = trpc.triggers.delete.useMutation({
    onSuccess: () => {
      toast.success("Trigger o'chirildi");
      void utils.triggers.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  function buildWebhookUrl(key: string | null) {
    return key ? `${appUrl}/api/trigger/wh/${key}` : "";
  }

  const webhookUrl = buildWebhookUrl(trigger.webhookKey);

  return (
    <>
      <div className="flex items-start gap-4 px-4 py-3 rounded-lg border bg-card hover:bg-muted/20 transition-colors">
        <div className={cn("mt-0.5 flex items-center justify-center h-8 w-8 rounded-lg shrink-0", typeMeta.color)}>
          <TypeIcon className="h-4 w-4" />
        </div>

        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{trigger.name}</span>
            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", typeMeta.color)}>
              {typeMeta.label}
            </Badge>
            {!trigger.isActive && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-muted-foreground">
                Nofaol
              </Badge>
            )}
          </div>

          {(trigger.type === "webhook" || trigger.type === "api") && webhookUrl && (
            <div className="flex items-center gap-2">
              <code className="text-[11px] text-muted-foreground bg-muted/60 rounded px-1.5 py-0.5 truncate max-w-xs sm:max-w-sm">
                {webhookUrl}
              </code>
              <CopyButton text={webhookUrl} />
            </div>
          )}

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {trigger.lastFiredAt ? (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(trigger.lastFiredAt).toLocaleString("uz-UZ")}
              </span>
            ) : (
              <span className="opacity-50">Hali ishlamadi</span>
            )}
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="flex items-center gap-1 hover:text-foreground transition-colors"
            >
              <History className="h-3 w-3" />
              {trigger.execCount} ta bajarish
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={trigger.isActive}
            disabled={toggleActive.isPending}
            onCheckedChange={(v) => toggleActive.mutate({ id: trigger.id, isActive: v })}
            aria-label="Toggle active"
          />

          {(trigger.type === "manual" || trigger.type === "api") && (
            <Button
              size="sm"
              variant="outline"
              disabled={fire.isPending || !trigger.isActive}
              onClick={() => fire.mutate({ id: trigger.id })}
              title="Qo'lda ishlatish"
            >
              {fire.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </Button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                <History className="mr-2 h-4 w-4" />
                Tarixni ko'rish
              </DropdownMenuItem>
              {(trigger.type === "webhook" || trigger.type === "api") && (
                <DropdownMenuItem
                  disabled={regenerateKey.isPending}
                  onClick={() => regenerateKey.mutate({ id: trigger.id })}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Keyni yangilash
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                O'chirish
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ExecutionHistorySheet
        triggerId={trigger.id}
        triggerName={trigger.name}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trigger o'chirilsinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              "{trigger.name}" trigger va uning barcha bajarish tarixi butunlay o'chiriladi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Bekor</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteTrigger.mutate({ id: trigger.id })}
            >
              O'chirish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Triggers() {
  const [createOpen, setCreateOpen] = useState(false);
  const appUrl = window.location.origin;

  const { data: triggers, isLoading } = trpc.triggers.list.useQuery();

  return (
    <DashboardLayout>
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Triggerlar</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Webhook, jadval, qo'lda va API triggerlarini boshqaring
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Yangi trigger
          </Button>
        </div>

        {/* Type overview cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(Object.keys(TYPE_META) as TriggerType[]).map((type) => {
            const m = TYPE_META[type];
            const count = triggers?.filter((t) => t.type === type).length ?? 0;
            return (
              <Card key={type} className="border">
                <CardContent className="pt-4 pb-3">
                  <div className="flex items-center gap-2 mb-1">
                    <m.icon className={cn("h-4 w-4", m.color.split(" ").find(c => c.startsWith("text-")))} />
                    <span className="text-xs font-medium text-muted-foreground">{m.label}</span>
                  </div>
                  <p className="text-2xl font-bold">{count}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Trigger list */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Barcha triggerlar ({triggers?.length ?? 0})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0">
            {isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !triggers || triggers.length === 0 ? (
              <div className="text-center py-12 space-y-3">
                <Webhook className="h-10 w-10 text-muted-foreground/30 mx-auto" />
                <p className="text-sm text-muted-foreground">Hali trigger yo'q</p>
                <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-2 h-3.5 w-3.5" />
                  Birinchi triggerni yarating
                </Button>
              </div>
            ) : (
              triggers.map((t) => (
                <TriggerRow key={t.id} trigger={t as Parameters<typeof TriggerRow>[0]["trigger"]} appUrl={appUrl} />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <CreateTriggerDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </DashboardLayout>
  );
}
