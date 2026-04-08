import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Facebook,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { useState, useCallback } from "react";
import { toast } from "sonner";

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";
type LogCategory = "WEBHOOK" | "LEAD" | "ORDER" | "SYSTEM" | "HTTP" | "FACEBOOK" | "TELEGRAM" | "AFFILIATE";

const PAGE_SIZE = 50;

// User-friendly category config
const CATEGORY_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  LEAD: {
    label: "Lead",
    icon: <Zap className="h-3 w-3" />,
    color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  },
  ORDER: {
    label: "Delivery",
    icon: <Send className="h-3 w-3" />,
    color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  },
  FACEBOOK: {
    label: "Facebook",
    icon: <Facebook className="h-3 w-3" />,
    color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  },
  TELEGRAM: {
    label: "Telegram",
    icon: <Send className="h-3 w-3" />,
    color: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  },
  WEBHOOK: {
    label: "Webhook",
    icon: null,
    color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  },
  AFFILIATE: {
    label: "Affiliate",
    icon: null,
    color: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300",
  },
  SYSTEM: {
    label: "System",
    icon: null,
    color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  },
  HTTP: {
    label: "HTTP",
    icon: null,
    color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300",
  },
};

const LEVEL_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  INFO: {
    icon: <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />,
    color: "",
  },
  WARN: {
    icon: <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0" />,
    color: "bg-yellow-50 dark:bg-yellow-900/10",
  },
  ERROR: {
    icon: <XCircle className="h-4 w-4 text-red-500 shrink-0" />,
    color: "bg-red-50 dark:bg-red-900/10",
  },
  DEBUG: {
    icon: <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />,
    color: "",
  },
};

// Simplify raw log messages for users
function friendlyMessage(message: string, category: string): string {
  if (category === "LEAD") {
    if (message.includes("lead_received") || message.includes("New lead received") || message.includes("leadgen_id")) {
      return "New lead received from Facebook";
    }
    if (message.includes("saved") || message.includes("Saved")) return "Lead saved successfully";
  }
  if (category === "ORDER") {
    if (message.includes("success") || message.includes("sent")) return "Lead delivered to destination";
    if (message.includes("fail") || message.includes("error") || message.includes("Error")) return "Failed to deliver lead";
    if (message.includes("retry")) return "Retrying lead delivery";
  }
  if (category === "FACEBOOK") {
    if (message.includes("verified") || message.includes("verification successful")) return "Facebook webhook verified";
    if (message.includes("token") && (message.includes("expire") || message.includes("invalid"))) return "Facebook token expired or invalid";
    if (message.includes("connected") || message.includes("subscribed")) return "Facebook page connected";
  }
  if (category === "TELEGRAM") {
    if (message.includes("sent") || message.includes("success")) return "Telegram notification sent";
    if (message.includes("fail") || message.includes("error")) return "Telegram notification failed";
  }
  // Strip technical prefixes like "[WEBHOOK]", "POST /api/..."
  return message
    .replace(/^\[.*?\]\s*/, "")
    .replace(/^(GET|POST|PUT|DELETE)\s+\/\S+\s*[-–]?\s*/i, "")
    .slice(0, 120);
}

export default function Activity() {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState<LogLevel | "ALL">("ALL");
  const [category, setCategory] = useState<LogCategory | "ALL">("ALL");
  const [page, setPage] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showClearDialog, setShowClearDialog] = useState(false);

  const queryInput = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(level !== "ALL" ? { level: level as LogLevel } : {}),
    ...(category !== "ALL" ? { category: category as LogCategory } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  };

  const { data, isLoading, isFetching, refetch } = trpc.logs.list.useQuery(queryInput, {
    refetchInterval: 15_000,
  });

  const { data: stats } = trpc.logs.stats.useQuery(undefined, {
    refetchInterval: 15_000,
  });

  const clearMutation = trpc.logs.clear.useMutation({
    onSuccess: () => {
      toast.success("Activity cleared");
      utils.logs.list.invalidate();
      utils.logs.stats.invalidate();
      setShowClearDialog(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSearch = useCallback((val: string) => { setSearch(val); setPage(0); }, []);
  const handleLevelChange = useCallback((val: string) => { setLevel(val as LogLevel | "ALL"); setPage(0); }, []);
  const handleCategoryChange = useCallback((val: string) => { setCategory(val as LogCategory | "ALL"); setPage(0); }, []);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <DashboardLayout>
      <div className="space-y-5 max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Lead arrivals, deliveries, and connection events
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={() => setShowClearDialog(true)}
            >
              <Trash2 className="h-4 w-4 mr-1.5" />
              Clear
            </Button>
          </div>
        </div>

        {/* Stats */}
        {stats && stats.total > 0 && (
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="text-muted-foreground">{stats.total} events</span>
            {stats.ERROR > 0 && (
              <span className="flex items-center gap-1 text-red-600 font-medium">
                <XCircle className="h-3.5 w-3.5" />
                {stats.ERROR} error{stats.ERROR > 1 ? "s" : ""}
              </span>
            )}
            {stats.WARN > 0 && (
              <span className="flex items-center gap-1 text-yellow-600 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                {stats.WARN} warning{stats.WARN > 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search…"
              className="pl-8"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>
          <Select value={level} onValueChange={handleLevelChange}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              <SelectItem value="INFO">Success</SelectItem>
              <SelectItem value="WARN">Warning</SelectItem>
              <SelectItem value="ERROR">Error</SelectItem>
            </SelectContent>
          </Select>
          <Select value={category} onValueChange={handleCategoryChange}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All types</SelectItem>
              <SelectItem value="LEAD">Lead</SelectItem>
              <SelectItem value="ORDER">Delivery</SelectItem>
              <SelectItem value="FACEBOOK">Facebook</SelectItem>
              <SelectItem value="TELEGRAM">Telegram</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Activity list */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : !data?.logs.length ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <CheckCircle2 className="h-10 w-10 text-muted-foreground/30 mb-3" />
                <p className="text-muted-foreground font-medium">No activity yet</p>
                <p className="text-sm text-muted-foreground/60 mt-1">
                  Events will appear here as leads arrive and are processed
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {data.logs.map((entry) => {
                  const lvl = entry.level as LogLevel;
                  const cat = entry.category as LogCategory;
                  const lc = LEVEL_CONFIG[lvl] ?? LEVEL_CONFIG.INFO;
                  const catCfg = CATEGORY_CONFIG[cat] ?? CATEGORY_CONFIG.SYSTEM;
                  const isExpanded = expandedId === entry.id;
                  const msg = friendlyMessage(entry.message, cat);

                  return (
                    <div
                      key={entry.id}
                      className={`px-4 py-3 hover:bg-muted/30 cursor-pointer transition-colors ${lc.color}`}
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    >
                      <div className="flex items-start gap-3 min-w-0">
                        {lc.icon}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${catCfg.color}`}
                            >
                              {catCfg.icon}
                              {catCfg.label}
                            </span>
                            <span className="text-sm text-foreground/90 leading-snug">{msg}</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                            {new Date(entry.createdAt).toLocaleString([], {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                            {entry.leadId != null && (
                              <span className="ml-2 opacity-60">lead #{entry.leadId}</span>
                            )}
                          </p>
                        </div>
                      </div>

                      {isExpanded && entry.meta != null && (
                        <div className="mt-2 ml-7 bg-muted rounded p-3">
                          <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words text-foreground/70">
                            {String(JSON.stringify(entry.meta, null, 2))}
                          </pre>
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
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data?.total ?? 0)} / {data?.total}
            </span>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-2">{page + 1} / {totalPages}</span>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Clear Dialog */}
      <Dialog open={showClearDialog} onOpenChange={setShowClearDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Clear Activity</DialogTitle>
            <DialogDescription>
              This will permanently delete all activity entries. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClearDialog(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => clearMutation.mutate({ olderThanDays: 0 })}
              disabled={clearMutation.isPending}
            >
              {clearMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Clear All
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
