import { useEffect, useRef, useState } from "react";
import SettingsLayout from "@/components/SettingsLayout";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  Send,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  RefreshCw,
  Users,
  Megaphone,
  Clock,
  ChevronDown,
  SendHorizonal,
  Plus,
  Copy,
} from "lucide-react";
import { useT } from "@/hooks/useT";

export default function SettingsTelegram() {
  const t = useT();
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
  // Raw token behind connectUrl — also exposed as a copyable `/start <token>`
  // command. The `?start=` deep link only shows a START button in a *fresh*
  // bot chat; if the user has opened the bot before, the link just reopens the
  // existing chat and the token is never sent. Pasting the command always works.
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [deliveryChatIdInput, setDeliveryChatIdInput] = useState("");
  const [deliveryLinking, setDeliveryLinking] = useState(false);
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false);
  const [showManualLink, setShowManualLink] = useState(false);
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [testingChatId, setTestingChatId] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("connection");

  const generateTokenMutation = trpc.telegram.generateConnectToken.useMutation({
    onSuccess: (data) => {
      setConnectUrl(data.botUrl);
      setConnectToken(data.token);
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
      setConnectToken(null);
      utils.telegram.getStatus.invalidate();
      toast.success(t("telegram.disconnected"));
    },
    onError: (err) => toast.error(err.message),
  });

  // Native "add to group / channel" deep-links (request admin in one tap).
  const { data: botLinks } = trpc.telegram.getBotLinks.useQuery(undefined, {
    staleTime: 60 * 60_000,
  });

  // Poll delivery + pending chats so a channel the user just added shows up
  // here automatically (the my_chat_member webhook auto-links it server-side).
  const { data: deliveryChats, refetch: refetchDeliveryChats, isFetching: deliveryFetching } =
    trpc.telegram.listDeliveryChats.useQuery(undefined, { staleTime: 5_000, refetchInterval: 8_000 });

  const { data: pendingChats, refetch: refetchPendingChats } =
    trpc.telegram.listPendingChats.useQuery(undefined, { staleTime: 5_000, refetchInterval: 8_000 });

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
      await Promise.all([refetchDeliveryChats(), refetchPendingChats()]);
      toast.success(t("telegram.deliveryChatLinked"));
    },
    onError: (err) => {
      toast.error(err.message);
      setDeliveryLinking(false);
    },
  });

  const testMessageMutation = trpc.telegram.sendTestMessage.useMutation({
    onSuccess: () => {
      setTestingChatId(null);
      toast.success(t("telegram.testSent"));
    },
    onError: (err) => {
      setTestingChatId(null);
      toast.error(err.message);
    },
  });

  const handleSendTest = (chatId: string) => {
    setTestingChatId(chatId);
    testMessageMutation.mutate({ chatId });
  };

  // When status switches to connected, clear the connect URL and show toast
  useEffect(() => {
    if (telegramStatus?.connected && connectUrl) {
      setConnectUrl(null);
      setConnectToken(null);
      toast.success(
        `✅ Telegram ulandi! @${telegramStatus.username ?? telegramStatus.chatId}`
      );
    }
  }, [telegramStatus?.connected, connectUrl, telegramStatus?.username, telegramStatus?.chatId]);

  // Land on the "Channels" tab once connected (the user's main task); fall
  // back to "Connection" if they disconnect. autoTabRef makes the jump
  // one-shot so it never fights a manual tab switch.
  const autoTabRef = useRef(false);
  useEffect(() => {
    if (telegramStatus?.connected) {
      if (!autoTabRef.current) {
        autoTabRef.current = true;
        setTab("channels");
      }
    } else {
      autoTabRef.current = false;
      setTab("connection");
    }
  }, [telegramStatus?.connected]);

  // Guided "Add channel" modal: snapshot the channel count on open, then
  // detect when a newly added channel shows up via the 8s polling.
  const totalChannels = (deliveryChats?.length ?? 0) + (pendingChats?.length ?? 0);
  const channelCountSnapshot = useRef<number | null>(null);
  useEffect(() => {
    if (showAddChannel) {
      if (channelCountSnapshot.current === null) channelCountSnapshot.current = totalChannels;
    } else {
      channelCountSnapshot.current = null;
    }
  }, [showAddChannel, totalChannels]);
  const newChannelDetected =
    showAddChannel &&
    channelCountSnapshot.current !== null &&
    totalChannels > channelCountSnapshot.current;

  const handleConnect = () => {
    setConnecting(true);
    generateTokenMutation.mutate();
  };

  const handleLinkDeliveryChat = () => {
    setDeliveryLinking(true);
    linkDeliveryChatMutation.mutate({ chatId: deliveryChatIdInput });
  };

  const refreshChannels = () => {
    void refetchDeliveryChats();
    void refetchPendingChats();
  };

  const isConnected = Boolean(telegramStatus?.connected);
  const hasDeliveryChats = (deliveryChats?.length ?? 0) > 0;
  const hasAnyChannel = totalChannels > 0;

  return (
    <SettingsLayout title={t("telegram.title")} description={t("telegram.subtitle")}>
      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList>
          <TabsTrigger value="connection">{t("telegram.tabConnection")}</TabsTrigger>
          <TabsTrigger value="channels" disabled={!isConnected}>
            {t("telegram.tabChannels")}
          </TabsTrigger>
          <TabsTrigger value="routing" disabled={!isConnected}>
            {t("telegram.tabRouting")}
          </TabsTrigger>
        </TabsList>

        {/* ─── Tab: Connection ──────────────────────────────────────────────── */}
        <TabsContent value="connection" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-lg bg-[#229ED9]/10 flex items-center justify-center">
                    <Send className="h-5 w-5 text-[#229ED9]" />
                  </div>
                  <div>
                    <CardTitle className="text-base">{t("telegram.notifications")}</CardTitle>
                    <CardDescription>{t("telegram.notificationsDesc")}</CardDescription>
                  </div>
                </div>
                {statusLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : telegramStatus?.connected ? (
                  <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    {t("telegram.connected")}
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1">
                    <XCircle className="h-3 w-3" />
                    {t("telegram.notConnected")}
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
                        {t("telegram.username")}:{" "}
                        <span className="font-mono">@{telegramStatus.username}</span>
                      </p>
                    )}
                    {telegramStatus.chatId && (
                      <p className="text-sm text-green-700 dark:text-green-400">
                        {t("telegram.chatId")}:{" "}
                        <span className="font-mono">{telegramStatus.chatId}</span>
                      </p>
                    )}
                    {telegramStatus.connectedAt && (
                      <p className="text-xs text-green-600 dark:text-green-500">
                        {t("telegram.connectedAt")}{" "}
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
                    {t("telegram.disconnect")}
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
                    <Button asChild className="bg-[#229ED9] hover:bg-[#1a8bbf] text-white">
                      <a href={connectUrl} target="_blank" rel="noopener noreferrer">
                        <Send className="h-4 w-4 mr-2" />
                        {t("telegram.openBot")}
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
                      {t("telegram.checkStatus")}
                    </Button>
                  </div>

                  {/* Bulletproof fallback: the `?start=` deep link only shows
                      a START button in a fresh chat. If the user has opened the
                      bot before, they paste this command into the chat instead. */}
                  {connectToken && (
                    <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                      <p className="text-xs text-muted-foreground">{t("telegram.startCommandHint")}</p>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 min-w-0 truncate rounded-md bg-background border px-3 py-2 text-xs font-mono">
                          /start {connectToken}
                        </code>
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => {
                            void navigator.clipboard.writeText(`/start ${connectToken}`);
                            toast.success(t("telegram.startCommandCopied"));
                          }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}

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
                    {t("telegram.connectTelegram")}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t("telegram.connectHint")}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Tab: Channels ────────────────────────────────────────────────── */}
        <TabsContent value="channels" className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="text-base">{t("telegram.deliveryChats")}</CardTitle>
                  <CardDescription>{t("telegram.deliveryChatsDesc")}</CardDescription>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={refreshChannels}
                    disabled={deliveryFetching}
                  >
                    <RefreshCw className={`h-4 w-4 ${deliveryFetching ? "animate-spin" : ""}`} />
                  </Button>
                  <Button size="sm" onClick={() => setShowAddChannel(true)}>
                    <Plus className="h-4 w-4 mr-1.5" />
                    {t("telegram.addChannelBtn")}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {!hasAnyChannel ? (
                /* Empty state — hero CTA */
                <div className="flex flex-col items-center text-center py-8 gap-3">
                  <div className="h-12 w-12 rounded-full bg-[#229ED9]/10 flex items-center justify-center">
                    <Megaphone className="h-6 w-6 text-[#229ED9]" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{t("telegram.noChannelsTitle")}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 max-w-xs">
                      {t("telegram.noChannelsHint")}
                    </p>
                  </div>
                  <Button
                    onClick={() => setShowAddChannel(true)}
                    className="bg-[#229ED9] hover:bg-[#1a8bbf] text-white"
                  >
                    <Plus className="h-4 w-4 mr-1.5" />
                    {t("telegram.addChannelBtn")}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {/* Pending: bot is in the chat but not an admin yet. */}
                  {pendingChats?.map((p) => (
                    <div
                      key={p.chatId}
                      className="flex items-center gap-3 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 px-3 py-2.5"
                    >
                      <div className="h-9 w-9 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0 text-sm font-semibold">
                        {(p.title ?? "?").charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{p.title ?? `Chat ${p.chatId}`}</p>
                        <p className="text-xs text-amber-700 dark:text-amber-500">
                          {t("telegram.pendingNeedsAdmin")}
                        </p>
                      </div>
                      <Badge className="gap-1 shrink-0 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-0">
                        <Clock className="h-3 w-3" />
                        {t("telegram.pendingBadge")}
                      </Badge>
                    </div>
                  ))}

                  {/* Linked delivery channels. */}
                  {deliveryChats?.map((c) => {
                    const cid = String(c.chatId);
                    const isTesting = testingChatId === cid;
                    const label = c.title ?? `Chat ${c.chatId}`;
                    return (
                      <div
                        key={c.id}
                        className="flex items-center gap-3 border rounded-lg px-3 py-2.5"
                      >
                        <div className="h-9 w-9 rounded-full bg-[#229ED9]/10 text-[#229ED9] flex items-center justify-center shrink-0 text-sm font-semibold">
                          {label.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{label}</p>
                          <p className="text-xs text-muted-foreground font-mono truncate">{c.chatId}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 shrink-0"
                          onClick={() => handleSendTest(cid)}
                          disabled={isTesting}
                        >
                          {isTesting ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          ) : (
                            <SendHorizonal className="h-3.5 w-3.5 mr-1.5" />
                          )}
                          {t("telegram.sendTest")}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Advanced fallback: manual Chat ID entry. */}
              <Collapsible open={showManualLink} onOpenChange={setShowManualLink}>
                <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${showManualLink ? "" : "-rotate-90"}`}
                  />
                  {t("telegram.manualLinkToggle")}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3 space-y-2">
                  <p className="text-xs text-muted-foreground">{t("telegram.manualLinkHint")}</p>
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder={t("telegram.chatIdPlaceholder")}
                      value={deliveryChatIdInput}
                      onChange={(e) => setDeliveryChatIdInput(e.target.value)}
                    />
                    <Button
                      onClick={handleLinkDeliveryChat}
                      disabled={deliveryLinking || !deliveryChatIdInput.trim()}
                    >
                      {deliveryLinking ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Users className="h-4 w-4 mr-2" />
                      )}
                      {t("telegram.link")}
                    </Button>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Tab: Routing ─────────────────────────────────────────────────── */}
        <TabsContent value="routing" className="space-y-6">
          {hasDeliveryChats ? (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">{t("telegram.deliveryMapping")}</CardTitle>
                    <CardDescription>{t("telegram.deliveryMappingDesc")}</CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void refetchMappings();
                      void refetchDeliveryChats();
                      void refetchDestDeliverySettings();
                    }}
                    disabled={mappingsFetching || deliveryFetching || settingsFetching}
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${
                        mappingsFetching || deliveryFetching || settingsFetching ? "animate-spin" : ""
                      }`}
                    />
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
                        setDestDeliverySettingsMutation.mutate({
                          mode: "ALL",
                          defaultChatId: autoDefaultChatId === "none" ? null : autoDefaultChatId,
                        })
                      }
                      disabled={setDestDeliverySettingsMutation.isPending}
                    >
                      {t("telegram.autoAll")}
                    </Button>
                    <Button
                      type="button"
                      variant={deliveryMode === "MANUAL" ? "secondary" : "outline"}
                      size="sm"
                      className="h-9"
                      onClick={() => setDestDeliverySettingsMutation.mutate({ mode: "MANUAL" })}
                      disabled={setDestDeliverySettingsMutation.isPending}
                    >
                      {t("telegram.manual")}
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
                        {setDestDeliverySettingsMutation.isPending && (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        )}
                        {t("telegram.applyAll")}
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
                            <div
                              key={dm.id}
                              className="flex items-center justify-between gap-3 border rounded-md px-3 py-2"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{dm.name}</p>
                                <p className="text-xs text-muted-foreground font-mono">
                                  destinationId: {dm.id}
                                  {dm.templateId ? ` · templateId:${dm.templateId}` : ` · ${dm.appKey}`}
                                </p>
                              </div>
                              <div className="w-[240px]">
                                <Select
                                  value={current}
                                  onValueChange={(val) => {
                                    const chatId = val === "none" ? null : val;
                                    setDestinationChatMutation.mutate({
                                      destinationId: dm.id,
                                      telegramChatId: chatId,
                                    });
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
                <CardTitle className="text-base">{t("telegram.deliveryMappingDisabledTitle")}</CardTitle>
                <CardDescription>{t("telegram.deliveryMappingDisabledDesc")}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTab("channels")}
                >
                  <Plus className="h-4 w-4 mr-1.5" />
                  {t("telegram.addChannelBtn")}
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* ─── Guided "Add channel" modal ─────────────────────────────────────── */}
      <Dialog open={showAddChannel} onOpenChange={setShowAddChannel}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("telegram.addChannelTitle")}</DialogTitle>
            <DialogDescription>{t("telegram.addChannelModalDesc")}</DialogDescription>
          </DialogHeader>

          {newChannelDetected ? (
            <div className="rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 p-4 flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400 shrink-0" />
              <p className="text-sm font-medium text-green-800 dark:text-green-300">
                {t("telegram.addChannelDetected")}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-col gap-2">
                <Button asChild className="bg-[#229ED9] hover:bg-[#1a8bbf] text-white">
                  <a href={botLinks?.addToChannelUrl ?? "#"} target="_blank" rel="noopener noreferrer">
                    <Megaphone className="h-4 w-4 mr-2" />
                    {t("telegram.addToChannel")}
                    <ExternalLink className="h-3.5 w-3.5 ml-2 opacity-70" />
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <a href={botLinks?.addToGroupUrl ?? "#"} target="_blank" rel="noopener noreferrer">
                    <Users className="h-4 w-4 mr-2" />
                    {t("telegram.addToGroup")}
                    <ExternalLink className="h-3.5 w-3.5 ml-2 opacity-70" />
                  </a>
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("telegram.addChannelWaiting")}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant={newChannelDetected ? "default" : "outline"}
              onClick={() => setShowAddChannel(false)}
            >
              {newChannelDetected ? t("telegram.addChannelDone") : t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Disconnect Telegram dialog ─────────────────────────────────────── */}
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
              <p className="mt-2">{t("telegram.disconnectBody2")}</p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDisconnectDialog(false)}>
              {t("common.cancel")}
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
              {t("telegram.disconnect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsLayout>
  );
}
