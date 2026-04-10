import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Clock,
  CheckCircle2,
  AlertCircle,
  Phone,
  Copy,
  Check,
  RotateCcw,
  Loader2,
  Facebook,
  Instagram,
  FileText,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";

interface Order {
  id: number;
  status: string;
}

export interface LeadCardData {
  id: number;
  fullName?: string | null;
  phone?: string | null;
  email?: string | null;
  status: string;
  createdAt: string | Date;
  pageId: string;
  formId: string;
  pageName?: string | null;
  formName?: string | null;
  platform?: string;
  orders?: Order[];
}

function LeadAvatar({ name, platform }: { name?: string | null; platform?: string }) {
  const initials = name?.trim() ? name.trim()[0].toUpperCase() : "?";
  const colorClass =
    platform === "ig"
      ? "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300"
      : platform === "fb"
      ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
      : "bg-primary/10 text-primary";
  return (
    <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center font-semibold text-sm shrink-0", colorClass)}>
      {initials}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; icon: React.ElementType; className: string }> = {
    PENDING: { label: "Pending", icon: Clock, className: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-400" },
    RECEIVED: { label: "Received", icon: CheckCircle2, className: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-400" },
    FAILED: { label: "Failed", icon: AlertCircle, className: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-400" },
  };
  const s = map[status] ?? { label: status, icon: Clock, className: "" };
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium", s.className)}>
      <Icon className="h-3 w-3" />
      {s.label}
    </span>
  );
}

function OrderBadge({ status }: { status: string }) {
  if (status === "SENT") {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-violet-100 text-violet-700 border border-violet-200 dark:bg-violet-950 dark:text-violet-400 font-medium">
        <Send className="h-3 w-3" />SENT
      </span>
    );
  }
  if (status === "PENDING") {
    return (
      <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-950 dark:text-amber-400 font-medium">
        <Clock className="h-3 w-3" />PENDING
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border font-medium">
      {status}
    </span>
  );
}

function formatDate(d: Date): string {
  const day = d.getDate().toString().padStart(2, "0");
  const month = d.toLocaleString("en-GB", { month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day} ${month}, ${time}`;
}

interface LeadCardProps {
  lead: LeadCardData;
  onClick: () => void;
  onRetry?: () => void;
  isRetrying?: boolean;
}

export function LeadCard({ lead, onClick, onRetry, isRetrying }: LeadCardProps) {
  const [copied, setCopied] = useState(false);
  const pageName = lead.pageName ?? lead.pageId;
  const formName = lead.formName ?? lead.formId;
  const firstOrder = lead.orders?.[0];
  const date = new Date(lead.createdAt as string);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!lead.phone) return;
    navigator.clipboard.writeText(lead.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card
      className="cursor-pointer hover:shadow-sm transition-all active:scale-[0.99] rounded-2xl"
      onClick={onClick}
    >
      <CardContent className="p-3.5 space-y-2.5">
        {/* Row 1: Avatar + Name + Phone + Status */}
        <div className="flex items-center gap-3">
          <LeadAvatar name={lead.fullName} platform={lead.platform} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold text-sm truncate">{lead.fullName || "Unknown"}</p>
              <StatusBadge status={lead.status} />
            </div>
            {lead.phone && (
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Phone className="h-3 w-3" />
                  {lead.phone}
                </span>
                <button
                  onClick={handleCopy}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title="Copy phone"
                >
                  {copied
                    ? <Check className="h-3 w-3 text-emerald-500" />
                    : <Copy className="h-3 w-3" />}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Row 2: Source block */}
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-2.5 py-1.5">
          {lead.platform === "ig" ? (
            <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 shrink-0">
              <Instagram className="h-3 w-3 text-white" />
            </span>
          ) : (
            <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-blue-600 shrink-0">
              <Facebook className="h-3 w-3 text-white" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "text-xs font-medium truncate",
                lead.platform === "ig"
                  ? "text-pink-600 dark:text-pink-400"
                  : "text-blue-600 dark:text-blue-400"
              )}
              title={pageName}
            >
              {pageName}
            </p>
            {formName && (
              <p
                className="text-[11px] text-muted-foreground truncate flex items-center gap-1"
                title={formName}
              >
                <FileText className="h-2.5 w-2.5 shrink-0" />
                {formName}
              </p>
            )}
          </div>
        </div>

        {/* Row 3: Order badge + Date */}
        <div className="flex items-center justify-between">
          <div>{firstOrder ? <OrderBadge status={firstOrder.status} /> : <span />}</div>
          <span className="text-[11px] text-muted-foreground">{formatDate(date)}</span>
        </div>

        {/* Retry button (failed only) */}
        {lead.status === "FAILED" && onRetry && (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-950/30"
              disabled={isRetrying}
              onClick={onRetry}
            >
              {isRetrying
                ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                : <RotateCcw className="h-3 w-3 mr-1" />}
              Retry
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
