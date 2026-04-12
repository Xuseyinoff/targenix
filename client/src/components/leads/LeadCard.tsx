import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Phone, Copy, Check, RotateCcw, Loader2, Facebook, Instagram, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { leadIsRetryable, type LeadPipelineFields } from "@/lib/leadPipelineBadgeModel";
import { LeadPipelineBadge, OrderIntegrationBadge } from "@/components/leads/PipelineBadges";

interface Order {
  id: number;
  status: string;
}

export interface LeadCardData extends LeadPipelineFields {
  id: number;
  fullName?: string | null;
  phone?: string | null;
  email?: string | null;
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
            <div className="flex items-start justify-between gap-2">
              <p className="font-semibold text-sm truncate min-w-0">{lead.fullName || "Unknown"}</p>
              <div className="flex flex-col items-end gap-1 shrink-0 max-w-[min(100%,11rem)] sm:max-w-[13rem]">
                <LeadPipelineBadge lead={lead} />
                {firstOrder ? <OrderIntegrationBadge status={firstOrder.status} /> : null}
              </div>
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

        {/* Row 3: Date */}
        <div className="flex items-center justify-end">
          <span className="text-[11px] text-muted-foreground tabular-nums">{formatDate(date)}</span>
        </div>

        {/* Retry button (failed only) */}
        {leadIsRetryable(lead) && onRetry && (
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
