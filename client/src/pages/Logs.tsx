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
  Info,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
  Bug,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useState, useCallback } from "react";
import { toast } from "sonner";

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

const PAGE_SIZE = 100;

const LEVEL_CONFIG: Record<
  LogLevel,
  { label: string; color: string; icon: React.ReactNode }
> = {
  INFO: {
    label: "INFO",
    color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    icon: <Info className="h-3 w-3" />,
  },
  WARN: {
    label: "WARN",
    color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
    icon: <AlertTriangle className="h-3 w-3" />,
  },
  ERROR: {
    label: "ERROR",
    color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
    icon: <XCircle className="h-3 w-3" />,
  },
  DEBUG: {
    label: "DEBUG",
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

export default function Logs() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  // Retention window: 48h for users, 30d for admins
  const retentionLabel = isAdmin ? "30 days" : "48 hours";
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
    refetchInterval: 10_000,
  });

  const { data: stats } = trpc.logs.stats.useQuery(undefined, {
    refetchInterval: 10_000,
  });

  const clearMutation = trpc.logs.clear.useMutation({
    onSuccess: () => {
      toast.success("Logs cleared");
      utils.logs.list.invalidate();
      utils.logs.stats.invalidate();
      setShowClearDialog(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSearch = useCallback(
    (val: string) => {
      setSearch(val);
      setPage(0);
    },
    []
  );

  const handleLevelChange = useCallback((val: string) => {
    setLevel(val as LogLevel | "ALL");
    setPage(0);
  }, []);

  const handleCategoryChange = useCallback((val: string) => {
    setCategory(val as LogCategory | "ALL");
    setPage(0);
  }, []);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <DashboardLayout>
      <div className="space-y-5 max-w-7xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Application Logs</h1>
            <p className="text-muted-foreground text-sm mt-1">
              All webhook events, lead processing steps, and system activity
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span
                className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                  isAdmin
                    ? "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                }`}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-current opacity-70" />
                Logs kept for {retentionLabel} · auto-cleaned hourly
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
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

        {/* Stats row */}
        {stats && (
          <div className="flex flex-wrap gap-2">
            <StatBadge label="Total" value={stats.total} color="bg-muted text-muted-foreground" />
            <StatBadge label="INFO" value={stats.INFO} color="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" />
            <StatBadge label="WARN" value={stats.WARN} color="bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" />
            <StatBadge label="ERROR" value={stats.ERROR} color="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" />
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-2">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search messages…"
              className="pl-8"
              value={search}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>
          <Select value={level} onValueChange={handleLevelChange}>
            <SelectTrigger className="w-[120px]">
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
                <p className="text-sm text-muted-foreground/60 mt-1">
                  Logs will appear here as webhook events and leads are processed
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {data.logs.map((entry) => {
                  const lvl = entry.level as LogLevel;
                  const cat = entry.category as LogCategory;
                  const lc = LEVEL_CONFIG[lvl] ?? LEVEL_CONFIG.INFO;
                  const catColor = CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.SYSTEM;
                  const isExpanded = expandedId === entry.id;

                  return (
                    <div
                      key={entry.id}
                      className="px-4 py-2.5 hover:bg-muted/30 cursor-pointer transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    >
                      <div className="flex items-start gap-2 min-w-0">
                        {/* Level badge */}
                        <span
                          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-mono font-semibold shrink-0 mt-0.5 ${lc.color}`}
                        >
                          {lc.icon}
                          {lc.label}
                        </span>
                        {/* Category badge */}
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-mono shrink-0 mt-0.5 ${catColor}`}
                        >
                          {cat}
                        </span>
                        {/* Message */}
                        <span className="text-sm flex-1 min-w-0 break-words leading-snug mt-0.5">
                          {entry.message}
                        </span>
                        {/* Timestamp */}
                        <span className="text-xs text-muted-foreground shrink-0 mt-0.5 tabular-nums">
                          {new Date(entry.createdAt).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      </div>

                      {/* Expanded meta */}
                      {isExpanded && entry.meta != null && (
                        <div className="mt-2 ml-[calc(3.5rem+0.5rem)] bg-muted rounded p-3">
                          <p className="text-xs font-mono text-muted-foreground mb-1">
                            {new Date(entry.createdAt).toLocaleString()}
                            {entry.leadId != null ? ` · leadId=${entry.leadId}` : ""}
                            {entry.pageId ? ` · pageId=${entry.pageId}` : ""}
                          </p>
                          <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words text-foreground/80">
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
              Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, data?.total ?? 0)} of{" "}
              {data?.total} entries
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-2">
                Page {page + 1} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
              >
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
            <DialogTitle>Clear Logs</DialogTitle>
            <DialogDescription>
              This will permanently delete all log entries. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClearDialog(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => clearMutation.mutate({ olderThanDays: 0 })}
              disabled={clearMutation.isPending}
            >
              {clearMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              Clear All Logs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

function StatBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${color}`}>
      {label}
      <span className="font-bold">{value}</span>
    </span>
  );
}
