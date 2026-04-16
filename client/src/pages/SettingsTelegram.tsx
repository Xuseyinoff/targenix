import { useEffect, useState } from "react";
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
  Users,
} from "lucide-react";
import { useLocation } from "wouter";
import { useT } from "@/hooks/useT";

export default function SettingsTelegram() {
  const t = useT();
  const utils = trpc.useUtils();
  const [, setLocation] = useLocation();

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
  const [deliveryChatIdInput, setDeliveryChatIdInput] = useState("");
  const [deliveryLinking, setDeliveryLinking] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);

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

  const disconnectMutation = trpc.telegram.disconnect.useMutation({
    onSuccess: () => {
      setConnectUrl(null);
      utils.telegram.getStatus.invalidate();
      toast.success(t("telegram.disconnected"));
    },
    onError: (err) => toast.error(err.message),
  });

  const { data: deliveryChats, refetch: refetchDeliveryChats, isFetching: deliveryFetching } =
    trpc.telegram.listDeliveryChats.useQuery(undefined, { staleTime: 5_000 });

  const { data: destinationMappings, refetch: refetchMappings, isFetching: mappingsFetching } =
    trpc.telegram.listDestinationMappings.useQuery(undefined, { staleTime: 5_000 });

  const { data: destDeliverySettings, refetch: refetchDestDeliverySettings, isFetching: settingsFetching } =
    trpc.telegram.getDestinationDeliverySettings.useQuery();

  const setDestDeliverySettingsMutation = trpc.telegram.setDestinationDeliverySettings.useMutation({
    onSuccess: async () => {
      await Promise.all([refetchDestDeliverySettings(), refetchMappings()]);
      toast.success(t("telegram.saved"));
    },
    onError: (err) => toast.error(err.message),
  });

  const deliveryMode = destDeliverySettings?.mode ?? "MANUAL";
  const [autoDefaultChatId, setAutoDefaultChatId] = useState<string>("none");

  useEffect(() => {
    const v = destDeliverySettings?.defaultChatId ? String(destDeliverySettings.defaultChatId) : "none";
    setAutoDefaultChatId(v);
  }, [destDeliverySettings?.defaultChatId]);

  const setDestinationChatMutation = trpc.telegram.setDestinationChat.useMutation({
    onSuccess: () => {
      void refetchMappings();
      toast.success(t("telegram.saved"));
    },
    onError: (err: { message?: string } | Error) =>
      toast.error(err instanceof Error ? err.message : (err.message ?? "Failed")),
  });

  const linkDeliveryChatMutation = trpc.telegram.linkDeliveryChatById.useMutation({
    onSuccess: async () => {
      setDeliveryChatIdInput("");
      setDeliveryLinking(false);
      await refetchDeliveryChats();
      toast.success(t("telegram.deliveryChatLinked"));
    },
    onError: (err) => {
      toast.error(err.message);
      setDeliveryLinking(false);
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

  const handleLinkDeliveryChat = () => {
    setDeliveryLinking(true);
    linkDeliveryChatMutation.mutate({ chatId: deliveryChatIdInput });
  };

  const isConnected = Boolean(telegramStatus?.connected);
  const hasDeliveryChats = (deliveryChats?.length ?? 0) > 0;

  return (
    <DashboardLayout>
      <div className="p-6 max-w-2xl space-y-6">
        {/* Page header */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">{t("telegram.title")}</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {t("telegram.subtitle")}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setLocation("/settings")} className="shrink-0">
            Back
          </Button>
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
                  <CardTitle className="text-base">{t("telegram.notifications")}</CardTitle>
                  <CardDescription>
                    {t("telegram.notificationsDesc")}
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
                    {t("telegram.accountConnected")}
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
                  onClick={() => setShowDisconnectDialog(true)}
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
                    {t("telegram.connectStepsTitle")}
                  </p>
                  <ol className="text-sm text-blue-700 dark:text-blue-400 space-y-1 list-decimal list-inside">
                    <li>{t("telegram.connectStep1")}</li>
                    <li>{t("telegram.connectStep2")}</li>
                    <li>{t("telegram.connectStep3")}</li>
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
                  {t("telegram.waitingConnection")}
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
                  {t("telegram.connectHint")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {isConnected && (
          <>
            {/* ─── Delivery Chats (Groups / Channels) ─────────────────────────── */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-violet-500/10 flex items-center justify-center">
                      <Users className="h-5 w-5 text-violet-600" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{t("telegram.deliveryChats")}</CardTitle>
                      <CardDescription>
                        {t("telegram.deliveryChatsDesc")}
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
                <div className="rounded-lg bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800 p-4 space-y-2">
                  <p className="text-sm font-medium text-violet-800 dark:text-violet-300">{t("telegram.stepsTitle")}</p>
                  <ol className="text-sm text-violet-700 dark:text-violet-400 space-y-1 list-decimal list-inside">
                    <li>{t("telegram.deliveryStep1")}</li>
                    <li>{t("telegram.deliveryStep2")}</li>
                    <li>{t("telegram.deliveryStep3")}</li>
                    <li>{t("telegram.deliveryStep4")}</li>
                  </ol>
                </div>

                <div className="flex items-center gap-2">
                  <Input
                    placeholder={t("telegram.chatIdPlaceholder")}
                    value={deliveryChatIdInput}
                    onChange={(e) => setDeliveryChatIdInput(e.target.value)}
                  />
                  <Button onClick={handleLinkDeliveryChat} disabled={deliveryLinking || !deliveryChatIdInput.trim()}>
                    {deliveryLinking ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Users className="h-4 w-4 mr-2" />}
                    Link
                  </Button>
                </div>

                <div className="space-y-2">
                  {!deliveryChats?.length ? (
                    <p className="text-sm text-muted-foreground">{t("telegram.noDeliveryChats")}</p>
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
            {hasDeliveryChats ? (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-base">{t("telegram.deliveryMapping")}</CardTitle>
                      <CardDescription>
                        {t("telegram.deliveryMappingDesc")}
                      </CardDescription>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => { void refetchMappings(); void refetchDeliveryChats(); void refetchDestDeliverySettings(); }}
                      disabled={mappingsFetching || deliveryFetching || settingsFetching}
                    >
                      <RefreshCw className={`h-4 w-4 mr-1.5 ${(mappingsFetching || deliveryFetching || settingsFetching) ? "animate-spin" : ""}`} />
                      Refresh
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant={deliveryMode === "ALL" ? "secondary" : "outline"}
                        size="sm"
                        className="h-9"
                        onClick={() =>
                          setDestDeliverySettingsMutation.mutate({ mode: "ALL", defaultChatId: autoDefaultChatId === "none" ? null : autoDefaultChatId })
                        }
                        disabled={setDestDeliverySettingsMutation.isPending}
                      >
                        Auto (all)
                      </Button>
                      <Button
                        type="button"
                        variant={deliveryMode === "MANUAL" ? "secondary" : "outline"}
                        size="sm"
                        className="h-9"
                        onClick={() => setDestDeliverySettingsMutation.mutate({ mode: "MANUAL" })}
                        disabled={setDestDeliverySettingsMutation.isPending}
                      >
                        Manual
                      </Button>
                    </div>
                    {deliveryMode === "ALL" && (
                      <div className="w-full sm:w-[260px]">
                        <Select value={autoDefaultChatId} onValueChange={setAutoDefaultChatId}>
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder={t("telegram.defaultChat")} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">{t("telegram.selectChat")}</SelectItem>
                            {(deliveryChats ?? []).map((c) => (
                              <SelectItem key={c.chatId} value={String(c.chatId)}>
                                {c.title ?? c.chatId}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          className="mt-2 w-full h-9"
                          onClick={() =>
                            setDestDeliverySettingsMutation.mutate({
                              mode: "ALL",
                              defaultChatId: autoDefaultChatId === "none" ? null : autoDefaultChatId,
                            })
                          }
                          disabled={setDestDeliverySettingsMutation.isPending || autoDefaultChatId === "none"}
                        >
                          {setDestDeliverySettingsMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                          Apply to all destinations
                        </Button>
                      </div>
                    )}
                  </div>

                  {deliveryMode === "MANUAL" && (
                    <>
                      {!destinationMappings?.length ? (
                        <p className="text-sm text-muted-foreground">{t("telegram.noDestinations")}</p>
                      ) : (
                        <div className="space-y-2">
                          {destinationMappings.map((dm) => {
                            const current = dm.chat?.chatId != null ? String(dm.chat.chatId) : "none";
                            return (
                              <div key={dm.id} className="flex items-center justify-between gap-3 border rounded-md px-3 py-2">
                                <div className="min-w-0">
                                  <p className="text-sm font-medium truncate">{dm.name}</p>
                                  <p className="text-xs text-muted-foreground font-mono">
                                    destinationId: {dm.id}
                                    {dm.templateId ? ` · templateId:${dm.templateId}` : ` · ${dm.templateType}`}
                                  </p>
                                </div>
                                <div className="w-[240px]">
                                  <Select
                                    value={current}
                                    onValueChange={(val) => {
                                      const chatId = val === "none" ? null : val;
                                      setDestinationChatMutation.mutate({ targetWebsiteId: dm.id, telegramChatId: chatId });
                                    }}
                                    disabled={setDestinationChatMutation.isPending}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder={t("telegram.defaultChat")} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="none">{t("telegram.noDeliveryChat")}</SelectItem>
                                      {(deliveryChats ?? []).map((c) => (
                                        <SelectItem key={c.chatId} value={String(c.chatId)}>
                                          {c.title ?? c.chatId}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {dm.chat?.chatId && (
                                    <p className="text-[11px] text-muted-foreground font-mono mt-1 truncate">
                                      {dm.chat.chatId}
                                    </p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Delivery Mapping</CardTitle>
                  <CardDescription>
                    Add at least one delivery chat first — 
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">
                    {t("telegram.deliveryMappingDisabledBody")}
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>

      {/* Disconnect Telegram Dialog */}
      <Dialog open={showDisconnectDialog} onOpenChange={(v) => setShowDisconnectDialog(v)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-destructive">{t("telegram.disconnectTitle")}</DialogTitle>
            <DialogDescription>
              {t("telegram.disconnectBody1")}
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>{t("telegram.disconnectItem1")}</li>
                <li>{t("telegram.disconnectItem2")}</li>
                <li>{t("telegram.disconnectItem3")}</li>
              </ul>
              <p className="mt-2">
                {t("telegram.disconnectBody2")}
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDisconnectDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={disconnectMutation.isPending}
              onClick={() => {
                disconnectMutation.mutate();
                setShowDisconnectDialog(false);
              }}
            >
              {disconnectMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

