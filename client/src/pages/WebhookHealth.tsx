import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { trpc } from "@/lib/trpc";
import {
  Activity,
  CheckCircle2,
  Copy,
  RefreshCw,
  Shield,
  ShieldCheck,
  ShieldX,
  Webhook,
  Zap,
  WifiOff,
  Clock,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

type SseEvent = {
  type: "connected" | "incoming" | "processed" | "error";
  eventId?: number;
  leadgenId?: string;
  pageId?: string;
  formId?: string;
  verified?: boolean;
  processed?: boolean;
  error?: string;
  timestamp: string;
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function LiveEventRow({ event, index }: { event: SseEvent; index: number }) {
  const isNew = index === 0;

  if (event.type === "connected") {
    return (
      <div className="flex items-center gap-3 py-2 px-3 rounded-lg bg-green-500/10 border border-green-500/20 text-sm">
        <ShieldCheck className="h-4 w-4 text-green-500 shrink-0" />
        <span className="text-green-400 font-medium">Stream connected — waiting for events</span>
        <span className="ml-auto text-muted-foreground text-xs shrink-0">{formatTime(event.timestamp)}</span>
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div className="flex items-center gap-3 py-2 px-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm">
        <XCircle className="h-4 w-4 text-red-500 shrink-0" />
        <span className="text-red-400">{event.error || "Processing error"}</span>
        <span className="ml-auto text-muted-foreground text-xs shrink-0">{formatTime(event.timestamp)}</span>
      </div>
    );
  }

  if (event.type === "incoming") {
    return (
      <div className={`flex items-start gap-3 py-2 px-3 rounded-lg border text-sm transition-all ${isNew ? "bg-blue-500/15 border-blue-500/30" : "bg-blue-500/5 border-blue-500/10"}`}>
        <Zap className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-blue-300 font-medium">Webhook received</span>
            {event.verified ? (
              <Badge variant="outline" className="text-green-400 border-green-500/40 text-xs py-0">
                <ShieldCheck className="h-3 w-3 mr-1" />Verified
              </Badge>
            ) : (
              <Badge variant="outline" className="text-yellow-400 border-yellow-500/40 text-xs py-0">
                <AlertTriangle className="h-3 w-3 mr-1" />Unverified
              </Badge>
            )}
          </div>
          {event.leadgenId && (
            <p className="text-muted-foreground text-xs mt-0.5 truncate">
              Lead ID: <code className="bg-muted px-1 rounded">{event.leadgenId}</code>
              {event.pageId && <> · Page: {event.pageId}</>}
            </p>
          )}
        </div>
        <span className="text-muted-foreground text-xs shrink-0">{formatTime(event.timestamp)}</span>
      </div>
    );
  }

  if (event.type === "processed") {
    return (
      <div className={`flex items-start gap-3 py-2 px-3 rounded-lg border text-sm transition-all ${isNew ? "bg-green-500/15 border-green-500/30" : "bg-green-500/5 border-green-500/10"}`}>
        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <span className="text-green-400 font-medium">Lead processed successfully</span>
          {event.leadgenId && (
            <p className="text-muted-foreground text-xs mt-0.5 truncate">
              Lead ID: <code className="bg-muted px-1 rounded">{event.leadgenId}</code>
              {event.pageId && <> · Page: {event.pageId}</>}
            </p>
          )}
        </div>
        <span className="text-muted-foreground text-xs shrink-0">{formatTime(event.timestamp)}</span>
      </div>
    );
  }

  return null;
}

export default function WebhookHealth() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [liveEvents, setLiveEvents] = useState<SseEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [pulse, setPulse] = useState(false);

  // Redirect non-admins immediately
  useEffect(() => {
    if (user && user.role !== "admin") {
      setLocation("/overview");
    }
  }, [user, setLocation]);

  const { data: events, isLoading, refetch } = trpc.webhook.recentEvents.useQuery(
    undefined,
    { refetchInterval: 8000, enabled: user?.role === "admin" }
  );
  const { data: stats, refetch: refetchStats } = trpc.webhook.stats.useQuery(
    undefined,
    { refetchInterval: 8000, enabled: user?.role === "admin" }
  );
  const { data: webhookInfo } = trpc.facebook.webhookUrl.useQuery();

  // SSE real-time connection
  useEffect(() => {
    const es = new EventSource(`${window.location.origin}/api/webhooks/events/stream`);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e) => {
      try {
        const event: SseEvent = JSON.parse(e.data);
        setLiveEvents((prev) => [event, ...prev].slice(0, 50));
        if (event.type === "incoming" || event.type === "processed") {
          setPulse(true);
          setTimeout(() => setPulse(false), 1500);
          // Also refresh DB stats
          refetchStats();
        }
      } catch {}
    };

    return () => es.close();
  }, [refetchStats]);

  const copyUrl = () => {
    if (webhookInfo?.url) {
      navigator.clipboard.writeText(webhookInfo.url);
      toast.success("Webhook URL copied");
    }
  };

  const copyToken = () => {
    if (webhookInfo?.verifyToken) {
      navigator.clipboard.writeText(webhookInfo.verifyToken);
      toast.success("Verify token copied");
    }
  };

  // Non-admin guard — show access denied while redirect is in progress
  if (!user || user.role !== "admin") {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-32">
          <div className="text-center">
            <Shield className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">Admin access required</p>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-5xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Webhook Health</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Real-time Facebook webhook monitoring
            </p>
          </div>
          <div className="flex items-center gap-3">
            {connected ? (
              <Badge className="bg-green-500/20 text-green-400 border border-green-500/40 gap-1.5 px-3 py-1">
                <span className={`h-2 w-2 rounded-full bg-green-400 ${pulse ? "animate-ping" : "animate-pulse"}`} />
                Live
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground gap-1.5">
                <WifiOff className="h-3 w-3" /> Disconnected
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={() => { refetch(); refetchStats(); }}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard label="Total Events" value={stats?.total ?? 0} icon={Activity} />
          <StatCard label="Verified" value={stats?.verified ?? 0} icon={ShieldCheck} positive />
          <StatCard label="Processed" value={stats?.processed ?? 0} icon={CheckCircle2} positive />
          <StatCard label="With Errors" value={stats?.failed ?? 0} icon={ShieldX} negative />
        </div>

        {/* Live Stream */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4 text-yellow-400" />
                Live Event Stream
              </CardTitle>
              <span className="text-xs text-muted-foreground">{liveEvents.length} events this session</span>
            </div>
            <CardDescription>
              Events appear here instantly when Facebook sends a webhook — no refresh needed
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64">
              <div className="space-y-2 pr-2">
                {liveEvents.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
                    <Clock className="h-8 w-8 mb-2 opacity-30" />
                    <p className="text-sm">Waiting for events...</p>
                    <p className="text-xs mt-1 opacity-60">
                      Send a test from Facebook Dashboard → Webhooks → leadgen → Test
                    </p>
                  </div>
                ) : (
                  liveEvents.map((ev, i) => <LiveEventRow key={i} event={ev} index={i} />)
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Webhook Configuration */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Webhook className="h-4 w-4 text-primary" />
              Webhook Configuration
            </CardTitle>
            <CardDescription>
              Use these values when configuring your Facebook App webhook
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Callback URL
              </label>
              <div className="flex items-center gap-2 mt-1.5">
                <code className="flex-1 text-xs bg-muted px-3 py-2 rounded-lg border truncate">
                  {webhookInfo?.url ?? "/api/webhooks/facebook"}
                </code>
                <Button variant="outline" size="sm" onClick={copyUrl}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Verify Token
              </label>
              <div className="flex items-center gap-2 mt-1.5">
                <code className="flex-1 text-xs bg-muted px-3 py-2 rounded-lg border truncate">
                  {webhookInfo?.verifyToken ?? "(set FACEBOOK_VERIFY_TOKEN)"}
                </code>
                <Button variant="outline" size="sm" onClick={copyToken}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-primary/5 border border-primary/20">
              <Shield className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <p className="text-xs text-muted-foreground">
                All incoming webhook requests are verified using{" "}
                <strong>X-Hub-Signature-256</strong> HMAC-SHA256 signature validation.
                Requests with invalid signatures are logged but not processed.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Recent Events from DB */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent Events (Database)</CardTitle>
            <CardDescription>Last 30 webhook events stored in DB</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : !events?.length ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Webhook className="h-8 w-8 text-muted-foreground/30 mb-2" />
                <p className="text-sm text-muted-foreground">No webhook events yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  Events will appear once Facebook starts sending leads
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Event Type</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Verified</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Processed</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Error</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-3">
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                            {event.eventType}
                          </code>
                        </td>
                        <td className="px-4 py-3">
                          {event.verified ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                              <ShieldCheck className="h-3.5 w-3.5" /> Valid
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                              <ShieldX className="h-3.5 w-3.5" /> Invalid
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {event.processed ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="h-3.5 w-3.5" /> Yes
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">No</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {event.error ? (
                            <span className="text-xs text-red-600 dark:text-red-400 truncate max-w-[150px] block">
                              {event.error}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          {new Date(event.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  positive,
  negative,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  positive?: boolean;
  negative?: boolean;
}) {
  const color = positive
    ? "text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-950"
    : negative
    ? "text-red-600 bg-red-50 dark:text-red-400 dark:bg-red-950"
    : "text-primary bg-primary/10";

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-muted-foreground font-medium">{label}</p>
          <div className={`h-7 w-7 rounded-lg flex items-center justify-center ${color}`}>
            <Icon className="h-3.5 w-3.5" />
          </div>
        </div>
        <p className="text-2xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}
