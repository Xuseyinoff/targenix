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
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Send,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  RefreshCw,
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
      toast.success("Telegram disconnected.");
    },
    onError: (err) => toast.error(err.message),
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
      </div>
    </DashboardLayout>
  );
}
