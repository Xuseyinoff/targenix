import { useState, useEffect } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Send,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  RefreshCw,
  Trash2,
  Users,
} from "lucide-react";

export default function Settings() {
  const utils = trpc.useUtils();

  // ─── Telegram Status ──────────────────────────────────────────────────────
  const {
    data: telegramStatus,
    isLoading: statusLoading,
    refetch: refetchStatus,
  } = trpc.telegram.getStatus.useQuery(undefined, {
    // Poll every 5 seconds while waiting for the user to press Start in Telegram
    refetchInterval: (query) => (query.state.data?.connected ? false : 5000),
  });

  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [deliveryUrl, setDeliveryUrl] = useState<string | null>(null);
  const [deliveryConnecting, setDeliveryConnecting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const generateTokenMutation = trpc.telegram.generateConnectToken.useMutation({
    onSuccess: (data) => {
      setConnectUrl(data.botUrl);
      setConnecting(false);
    },
    onError: (err) => {
      toast.error(err.message);
      setConnecting(false);
    },
  });

  const deleteAccountMutation = trpc.auth.deleteAccount.useMutation({
    onSuccess: () => {
      toast.success("Account deleted.");
      window.location.href = "/";
    },
    onError: (err) => toast.error(err.message),
  });

  const disconnectMutation = trpc.telegram.disconnect.useMutation({
    onSuccess: () => {
      setConnectUrl(null);
      utils.telegram.getStatus.invalidate();
      toast.success("Telegram disconnected.");
    },
    onError: (err) => toast.error(err.message),
  });

  const { data: deliveryChats, refetch: refetchDeliveryChats, isFetching: deliveryFetching } =
    trpc.telegram.listDeliveryChats.useQuery(undefined, { staleTime: 5_000 });

  const { data: destinationMappings, refetch: refetchMappings, isFetching: mappingsFetching } =
    trpc.telegram.listDestinationMappings.useQuery(undefined, { staleTime: 5_000 });

  const setDestinationChatMutation = trpc.telegram.setDestinationChat.useMutation({
    onSuccess: () => {
      void refetchMappings();
      toast.success("Saved.");
    },
    onError: (err: { message?: string } | Error) =>
      toast.error(err instanceof Error ? err.message : (err.message ?? "Failed")),
  });

  const generateDeliveryTokenMutation = trpc.telegram.generateDeliveryConnectToken.useMutation({
    onSuccess: (data) => {
      setDeliveryUrl(data.botUrl);
      setDeliveryConnecting(false);
      void refetchDeliveryChats();
    },
    onError: (err) => {
      toast.error(err.message);
      setDeliveryConnecting(false);
    },
  });

  // When status switches to connected, clear the connect URL and show toast
  useEffect(() => {
    if (telegramStatus?.connected && connectUrl) {
      setConnectUrl(null);
      toast.success(
        `✅ Telegram ulandi! @${telegramStatus.username ?? telegramStatus.chatId}`
      );
    }
  }, [telegramStatus?.connected, connectUrl, telegramStatus?.username, telegramStatus?.chatId]);

  const handleConnect = () => {
    setConnecting(true);
    generateTokenMutation.mutate();
  };

  const handleAddDeliveryChat = () => {
    setDeliveryConnecting(true);
    generateDeliveryTokenMutation.mutate();
  };

  return (
    <DashboardLayout>
      <div className="p-6 max-w-2xl space-y-6">
        {/* Page header */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your account integrations and notification preferences.
          </p>
        </div>

        <Separator />

        {/* ─── Telegram Notifications ─────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-[#229ED9]/10 flex items-center justify-center">
                  <Send className="h-5 w-5 text-[#229ED9]" />
                </div>
                <div>
                  <CardTitle className="text-base">Telegram Notifications</CardTitle>
                  <CardDescription>
                    Connect your Telegram account to receive lead notifications instantly
                  </CardDescription>
                </div>
              </div>
              {statusLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : telegramStatus?.connected ? (
                <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="secondary" className="gap-1">
                  <XCircle className="h-3 w-3" />
                  Not connected
                </Badge>
              )}
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            {telegramStatus?.connected ? (
              /* ── Connected state ── */
              <div className="space-y-4">
                <div className="rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 p-4 space-y-1">
                  <p className="text-sm font-medium text-green-800 dark:text-green-300">
                    ✅ Telegram account connected
                  </p>
                  {telegramStatus.username && (
                    <p className="text-sm text-green-700 dark:text-green-400">
                      Username: <span className="font-mono">@{telegramStatus.username}</span>
                    </p>
                  )}
                  {telegramStatus.chatId && (
                    <p className="text-sm text-green-700 dark:text-green-400">
                      Chat ID: <span className="font-mono">{telegramStatus.chatId}</span>
                    </p>
                  )}
                  {telegramStatus.connectedAt && (
                    <p className="text-xs text-green-600 dark:text-green-500">
                      Connected{" "}
                      {new Date(telegramStatus.connectedAt).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                  className="text-destructive hover:text-destructive"
                >
                  {disconnectMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 mr-2" />
                  )}
                  Disconnect
                </Button>
              </div>
            ) : connectUrl ? (
              /* ── Waiting for user to press Start ── */
              <div className="space-y-4">
                <div className="rounded-lg bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 p-4 space-y-3">
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-300">
                    Follow these steps to connect:
                  </p>
                  <ol className="text-sm text-blue-700 dark:text-blue-400 space-y-1 list-decimal list-inside">
                    <li>Click the button below — Telegram opens</li>
                    <li>Press <strong>Start</strong> in the Telegram chat</li>
                    <li>This page will update automatically</li>
                  </ol>
                </div>

                <div className="flex items-center gap-3">
                  <Button
                    asChild
                    className="bg-[#229ED9] hover:bg-[#1a8bbf] text-white"
                  >
                    <a href={connectUrl} target="_blank" rel="noopener noreferrer">
                      <Send className="h-4 w-4 mr-2" />
                      Open Telegram Bot
                      <ExternalLink className="h-3.5 w-3.5 ml-2" />
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => refetchStatus()}
                    className="text-muted-foreground"
                  >
                    <RefreshCw className="h-4 w-4 mr-1" />
                    Check status
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Waiting for connection… this page refreshes automatically every 5 seconds.
                </p>
              </div>
            ) : (
              /* ── Disconnected state ── */
              <div className="space-y-4">
                <Button
                  onClick={handleConnect}
                  disabled={connecting || statusLoading}
                  className="bg-[#229ED9] hover:bg-[#1a8bbf] text-white"
                >
                  {connecting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4 mr-2" />
                  )}
                  Connect Telegram
                </Button>
                <p className="text-xs text-muted-foreground">
                  Click the button → Telegram opens → Press Start → Done
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ─── Delivery Chats (Groups / Channels) ─────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-violet-500/10 flex items-center justify-center">
                  <Users className="h-5 w-5 text-violet-600" />
                </div>
                <div>
                  <CardTitle className="text-base">Delivery Chats</CardTitle>
                  <CardDescription>
                    Add a Telegram group/channel for lead delivery (leads will NOT go to your system chat)
                  </CardDescription>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => refetchDeliveryChats()} disabled={deliveryFetching}>
                <RefreshCw className={`h-4 w-4 mr-1.5 ${deliveryFetching ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {deliveryUrl ? (
              <div className="space-y-3">
                <div className="rounded-lg bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 p-4 space-y-2">
                  <p className="text-sm font-medium text-violet-800 dark:text-violet-300">
                    Steps:
                  </p>
                  <ol className="text-sm text-violet-700 dark:text-violet-400 space-y-1 list-decimal list-inside">
                    <li>Open Telegram via the button</li>
                    <li>Add bot to your group/channel</li>
                    <li>In the chat, press <strong>Confirm</strong></li>
                  </ol>
                </div>
                <Button asChild className="bg-violet-600 hover:bg-violet-700 text-white">
                  <a href={deliveryUrl} target="_blank" rel="noopener noreferrer">
                    <Users className="h-4 w-4 mr-2" />
                    Add bot to group/channel
                    <ExternalLink className="h-3.5 w-3.5 ml-2" />
                  </a>
                </Button>
                <p className="text-xs text-muted-foreground">
                  After Confirm, click Refresh to see the chat in the list.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <Button onClick={handleAddDeliveryChat} disabled={deliveryConnecting}>
                  {deliveryConnecting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Users className="h-4 w-4 mr-2" />
                  )}
                  Add delivery chat
                </Button>
                <p className="text-xs text-muted-foreground">
                  You must confirm inside the Telegram group/channel to link it.
                </p>
              </div>
            )}

            <div className="space-y-2">
              {!deliveryChats?.length ? (
                <p className="text-sm text-muted-foreground">No delivery chats connected yet.</p>
              ) : (
                <div className="space-y-2">
                  {deliveryChats.map((c) => (
                    <div key={c.id} className="flex items-center justify-between border rounded-md px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{c.title ?? `Chat ${c.chatId}`}</p>
                        <p className="text-xs text-muted-foreground font-mono truncate">{c.chatId}</p>
                      </div>
                      <Badge variant="secondary" className="font-mono text-xs">DELIVERY</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ─── Delivery Mapping (Destination/Template → Chat) ────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-base">Delivery Mapping</CardTitle>
                <CardDescription>
                  Assign a delivery chat per affiliate destination/template (leads are sent only if mapped)
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void refetchMappings(); void refetchDeliveryChats(); }}
                disabled={mappingsFetching || deliveryFetching}
              >
                <RefreshCw className={`h-4 w-4 mr-1.5 ${(mappingsFetching || deliveryFetching) ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {!destinationMappings?.length ? (
              <p className="text-sm text-muted-foreground">No destinations/templates found.</p>
            ) : (
              <div className="space-y-2">
                {destinationMappings.map((t) => {
                  const current = t.chat?.chatId != null ? String(t.chat.chatId) : "none";
                  return (
                    <div key={t.id} className="flex items-center justify-between gap-3 border rounded-md px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{t.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          destinationId: {t.id}
                          {t.templateId ? ` · templateId:${t.templateId}` : ` · ${t.templateType}`}
                        </p>
                      </div>
                      <div className="w-[240px]">
                        <Select
                          value={current}
                          onValueChange={(val) => {
                            const chatId = val === "none" ? null : val;
                            setDestinationChatMutation.mutate({ targetWebsiteId: t.id, telegramChatId: chatId });
                          }}
                          disabled={setDestinationChatMutation.isPending}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select delivery chat" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No delivery chat</SelectItem>
                            {(deliveryChats ?? []).map((c) => (
                              <SelectItem key={c.chatId} value={String(c.chatId)}>
                                {c.title ?? c.chatId}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {t.chat?.chatId && (
                          <p className="text-[11px] text-muted-foreground font-mono mt-1 truncate">
                            {t.chat.chatId}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
        <Separator />

        {/* ─── Danger Zone ────────────────────────────────────────────────── */}
        <Card className="border-destructive/40">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-destructive/10 flex items-center justify-center">
                <Trash2 className="h-5 w-5 text-destructive" />
              </div>
              <div>
                <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
                <CardDescription>
                  Permanently delete your account and all associated data
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              This will permanently delete your account, all leads, integrations, Facebook connections, destinations, and stored logs. <strong>This action cannot be undone.</strong>
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowDeleteDialog(true)}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete my account
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Delete Account Dialog */}
      <Dialog open={showDeleteDialog} onOpenChange={(v) => { setShowDeleteDialog(v); setDeleteConfirm(""); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-destructive">Delete account</DialogTitle>
            <DialogDescription>
              This will permanently delete all your data. Type <strong>DELETE</strong> to confirm.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="Type DELETE to confirm"
            value={deleteConfirm}
            onChange={(e) => setDeleteConfirm(e.target.value)}
            autoComplete="off"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowDeleteDialog(false); setDeleteConfirm(""); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteConfirm !== "DELETE" || deleteAccountMutation.isPending}
              onClick={() => deleteAccountMutation.mutate()}
            >
              {deleteAccountMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
