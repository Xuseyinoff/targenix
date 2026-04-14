import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  XCircle,
  Bug,
  Clock,
  Users,
  Activity,
  Zap,
} from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { useLocation } from "wouter";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";
type LogCategory =
  | "WEBHOOK"
  | "LEAD"
  | "ORDER"
  | "SYSTEM"
  | "HTTP"
  | "FACEBOOK"
  | "TELEGRAM"
  | "AFFILIATE";
type LogType = "USER" | "SYSTEM";

const PAGE_SIZE = 50;

const LEVEL_CONFIG: Record<LogLevel, { color: string; icon: React.ReactNode }> = {
  INFO: {
    color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    icon: <Info className="h-3 w-3" />,
  },
  WARN: {
    color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  ERROR: {
    color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    icon: <XCircle className="h-3 w-3" />,
  },
  DEBUG: {
    color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    icon: <Bug className="h-3 w-3" />,
  },
};

const CATEGORY_COLORS: Record<LogCategory, string> = {
  WEBHOOK: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  LEAD: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  ORDER: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  SYSTEM: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  HTTP: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  FACEBOOK: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  TELEGRAM: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  AFFILIATE: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300",
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  lead_received: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  lead_saved: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  lead_enriched: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  sent_to_affiliate: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  sent_to_telegram: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  sent_to_target_website: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  webhook_verified: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  webhook_rejected: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  webhook_dispatched: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  error: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

// Common event types for the filter dropdown
const EVENT_TYPES = [
  "lead_received",
  "lead_saved",
  "lead_enriched",
  "lead_routing_matched",
  "sent_to_affiliate",
  "sent_to_telegram",
  "sent_to_target_website",
  "webhook_verified",
  "webhook_rejected",
  "webhook_dispatched",
  "error",
];

export default function AdminLogs() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  // Redirect non-admins
  useEffect(() => {
    if (user && user.role !== "admin") {
      setLocation("/overview");
    }
  }, [user, setLocation]);

  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<LogLevel | "ALL">("ALL");
  const [category, setCategory] = useState<LogCategory | "ALL">("ALL");
  const [logType, setLogType] = useState<LogType | "ALL">("ALL");
  const [eventType, setEventType] = useState<string>("ALL");
  const [userIdFilter, setUserIdFilter] = useState<string>("");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const queryInput = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(level !== "ALL" ? { level: level as LogLevel } : {}),
    ...(category !== "ALL" ? { category: category as LogCategory } : {}),
    ...(logType !== "ALL" ? { logType: logType as LogType } : {}),
    ...(eventType !== "ALL" ? { eventType } : {}),
    ...(userIdFilter.trim() ? { userId: parseInt(userIdFilter.trim(), 10) } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  };

  const { data, isLoading, isFetching, refetch } = trpc.logs.adminList.useQuery(queryInput, {
    refetchInterval: 15_000,
    enabled: user?.role === "admin",
  });

  const { data: stats } = trpc.logs.adminStats.useQuery(
    { since: new Date(Date.now() - 24 * 3600 * 1000) },
    { refetchInterval: 30_000, enabled: user?.role === "admin" }
  );

  const handleSearch = useCallback((val: string) => { setSearch(val); setPage(0); }, []);
  const handleLevelChange = useCallback((val: string) => { setLevel(val as LogLevel | "ALL"); setPage(0); }, []);
  const handleCategoryChange = useCallback((val: string) => { setCategory(val as LogCategory | "ALL"); setPage(0); }, []);
  const handleLogTypeChange = useCallback((val: string) => { setLogType(val as LogType | "ALL"); setPage(0); }, []);
  const handleEventTypeChange = useCallback((val: string) => { setEventType(val); setPage(0); }, []);
  const handleUserIdChange = useCallback((val: string) => { setUserIdFilter(val); setPage(0); }, []);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

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
      <div className="space-y-5 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">Admin Logs</h1>
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                <Shield className="h-3 w-3" />
                Admin only
              </span>
            </div>
            <p className="text-muted-foreground text-sm mt-1">
              All users' logs — filter by logType, eventType, userId, and more
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Stats cards — last 24h */}
        {stats && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {/* By logType */}
            {stats.byLogType.map((row) => (
              <Card key={row.logType} className="border-0 bg-muted/40">
                <CardContent className="p-3 flex items-center gap-3">
                  {row.logType === "USER" ? (
                    <Users className="h-5 w-5 text-blue-500 shrink-0" />
                  ) : (
                    <Activity className="h-5 w-5 text-gray-400 shrink-0" />
                  )}
                  <div>
                    <p className="text-xs text-muted-foreground">{row.logType} logs (24h)</p>
                    <p className="text-xl font-bold">{row.cnt}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
            {/* By level: ERROR count */}
            {stats.byLevel.filter((r) => r.level === "ERROR").map((row) => (
              <Card key="errors" className="border-0 bg-red-50 dark:bg-red-900/10">
                <CardContent className="p-3 flex items-center gap-3">
                  <XCircle className="h-5 w-5 text-red-500 shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Errors (24h)</p>
                    <p className="text-xl font-bold text-red-600 dark:text-red-400">{row.cnt}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
            {/* Top eventType */}
            {stats.byEventType.slice(0, 1).map((row) => (
              <Card key="top-event" className="border-0 bg-muted/40">
                <CardContent className="p-3 flex items-center gap-3">
                  <Zap className="h-5 w-5 text-amber-500 shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Top event (24h)</p>
                    <p className="text-sm font-semibold truncate">{row.eventType ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">{row.cnt} times</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          {/* Search */}
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search messages…"
              className="pl-8"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>

          {/* userId filter */}
          <div className="relative w-[120px]">
            <Users className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="User ID"
              className="pl-8"
              value={userIdFilter}
              onChange={(e) => handleUserIdChange(e.target.value)}
              type="number"
            />
          </div>

          {/* logType */}
          <Select value={logType} onValueChange={handleLogTypeChange}>
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder="Log type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All types</SelectItem>
              <SelectItem value="USER">USER</SelectItem>
              <SelectItem value="SYSTEM">SYSTEM</SelectItem>
            </SelectContent>
          </Select>

          {/* eventType */}
          <Select value={eventType} onValueChange={handleEventTypeChange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Event type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All events</SelectItem>
              {EVENT_TYPES.map((et) => (
                <SelectItem key={et} value={et}>{et}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* level */}
          <Select value={level} onValueChange={handleLevelChange}>
            <SelectTrigger className="w-[110px]">
              <SelectValue placeholder="Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All levels</SelectItem>
              <SelectItem value="INFO">INFO</SelectItem>
              <SelectItem value="WARN">WARN</SelectItem>
              <SelectItem value="ERROR">ERROR</SelectItem>
              <SelectItem value="DEBUG">DEBUG</SelectItem>
            </SelectContent>
          </Select>

          {/* category */}
          <Select value={category} onValueChange={handleCategoryChange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All categories</SelectItem>
              <SelectItem value="WEBHOOK">WEBHOOK</SelectItem>
              <SelectItem value="LEAD">LEAD</SelectItem>
              <SelectItem value="ORDER">ORDER</SelectItem>
              <SelectItem value="HTTP">HTTP</SelectItem>
              <SelectItem value="FACEBOOK">FACEBOOK</SelectItem>
              <SelectItem value="TELEGRAM">TELEGRAM</SelectItem>
              <SelectItem value="AFFILIATE">AFFILIATE</SelectItem>
              <SelectItem value="SYSTEM">SYSTEM</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Active filter summary */}
        {(logType !== "ALL" || eventType !== "ALL" || userIdFilter || level !== "ALL" || category !== "ALL") && (
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs text-muted-foreground">Active filters:</span>
            {logType !== "ALL" && <FilterChip label={`type: ${logType}`} onRemove={() => setLogType("ALL")} />}
            {eventType !== "ALL" && <FilterChip label={`event: ${eventType}`} onRemove={() => setEventType("ALL")} />}
            {userIdFilter && <FilterChip label={`userId: ${userIdFilter}`} onRemove={() => setUserIdFilter("")} />}
            {level !== "ALL" && <FilterChip label={`level: ${level}`} onRemove={() => setLevel("ALL")} />}
            {category !== "ALL" && <FilterChip label={`cat: ${category}`} onRemove={() => setCategory("ALL")} />}
            <button
              className="text-xs text-muted-foreground underline hover:text-foreground ml-1"
              onClick={() => { setLogType("ALL"); setEventType("ALL"); setUserIdFilter(""); setLevel("ALL"); setCategory("ALL"); setSearch(""); setPage(0); }}
            >
              Clear all
            </button>
          </div>
        )}

        {/* Result count */}
        {data && (
          <p className="text-xs text-muted-foreground">
            {data.total.toLocaleString()} log{data.total !== 1 ? "s" : ""} found
            {data.total > PAGE_SIZE && ` — page ${page + 1} of ${totalPages}`}
          </p>
        )}

        {/* Log table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !data?.logs.length ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <CheckCircle2 className="h-10 w-10 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground font-medium">No logs found</p>
                <p className="text-sm text-muted-foreground/60 mt-1">Try adjusting your filters</p>
              </div>
            ) : (
              <div className="divide-y">
                {data.logs.map((entry) => {
                  const lvl = entry.level as LogLevel;
                  const cat = entry.category as LogCategory;
                  const lc = LEVEL_CONFIG[lvl] ?? LEVEL_CONFIG.INFO;
                  const catColor = CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.SYSTEM;
                  const etColor = entry.eventType
                    ? (EVENT_TYPE_COLORS[entry.eventType] ?? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300")
                    : "";
                  const isExpanded = expandedId === entry.id;

                  return (
                    <div
                      key={entry.id}
                      className="px-4 py-2.5 hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        {/* Level */}
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono font-semibold shrink-0 mt-0.5 ${lc.color}`}>
                          {lc.icon}
                          {lvl}
                        </span>
                        {/* Category */}
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono shrink-0 mt-0.5 ${catColor}`}>
                          {cat}
                        </span>
                        {/* logType badge */}
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono shrink-0 mt-0.5 ${
                          entry.logType === "USER"
                            ? "bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400"
                            : "bg-gray-50 text-gray-500 dark:bg-gray-800/50 dark:text-gray-500"
                        }`}>
                          {entry.logType}
                        </span>
                        {/* eventType */}
                        {entry.eventType && (
                          <span className={`hidden sm:inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono shrink-0 mt-0.5 ${etColor}`}>
                            {entry.eventType}
                          </span>
                        )}
                        {/* Message */}
                        <span className="text-sm flex-1 min-w-0 break-words leading-snug mt-0.5">
                          {entry.message}
                        </span>
                        {/* Duration */}
                        {entry.duration != null && (
                          <span className="text-xs text-muted-foreground shrink-0 mt-0.5 flex items-center gap-0.5">
                            <Clock className="h-3 w-3" />
                            {entry.duration}ms
                          </span>
                        )}
                        {/* userId */}
                        {entry.userId != null && (
                          <span className="text-xs text-muted-foreground shrink-0 mt-0.5 hidden md:block">
                            uid:{entry.userId}
                          </span>
                        )}
                        {/* Timestamp */}
                        <span className="text-xs text-muted-foreground/60 shrink-0 mt-0.5 hidden sm:block">
                          {new Date(entry.createdAt).toLocaleTimeString()}
                        </span>
                      </div>

                      {/* Expanded: meta + full date + source */}
                      {isExpanded && (
                        <div className="mt-2 ml-1 space-y-1.5">
                          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                            <span>{new Date(entry.createdAt).toLocaleString()}</span>
                            {entry.source && <span>source: <strong>{entry.source}</strong></span>}
                            {entry.leadId && <span>leadId: <strong>{entry.leadId}</strong></span>}
                            {entry.pageId && <span>pageId: <strong>{entry.pageId}</strong></span>}
                            {entry.userId && <span>userId: <strong>{entry.userId}</strong></span>}
                            {entry.duration != null && <span>duration: <strong>{entry.duration}ms</strong></span>}
                          </div>
                          {entry.meta != null && (
                            <pre className="text-xs bg-muted/60 rounded p-2 overflow-x-auto max-h-48 font-mono leading-relaxed">
                              {JSON.stringify(entry.meta as Record<string, unknown>, null, 2)}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-mono">
      {label}
      <button onClick={(e) => { e.stopPropagation(); onRemove(); }} className="hover:text-foreground ml-0.5">×</button>
    </span>
  );
}
