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

function LeadAvatar({ name }: { name?: string | null }) {
  const initials = name?.trim() ? name.trim()[0].toUpperCase() : "?";
  return (
    <div
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold leading-none",
        "bg-sky-100 text-sky-800 dark:bg-sky-950/55 dark:text-sky-200",
      )}
    >
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
      className={cn(
        "cursor-pointer rounded-lg border border-border/70 bg-card shadow-sm shadow-black/[0.03] transition-colors touch-manipulation",
        "hover:border-border hover:shadow-md hover:shadow-black/[0.04] active:bg-muted/35 dark:shadow-black/20 dark:hover:shadow-black/25",
      )}
      onClick={onClick}
    >
      <CardContent className="space-y-1 p-2 sm:p-2.5">
        <div className="flex gap-2">
          <LeadAvatar name={lead.fullName} />
          <div className="flex min-w-0 flex-1 items-start justify-between gap-1.5">
            <div className="min-w-0 flex-1 space-y-px">
              <p className="truncate text-[13px] font-semibold leading-tight tracking-tight sm:text-sm">
                {lead.fullName || "Unknown"}
              </p>
              {lead.phone ? (
                <div className="flex items-center gap-0.5 text-[11px] leading-none text-muted-foreground">
                  <Phone className="h-2.5 w-2.5 shrink-0 opacity-80" aria-hidden />
                  <span className="min-w-0 flex-1 truncate tabular-nums">{lead.phone}</span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className={cn(
                      "flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground",
                      "hover:bg-muted hover:text-foreground active:bg-muted/80",
                    )}
                    title="Copy phone"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-row flex-wrap items-center justify-end gap-0.5">
              <LeadPipelineBadge lead={lead} size="compact" />
              {firstOrder ? <OrderIntegrationBadge status={firstOrder.status} size="compact" /> : null}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-1 text-[10px] leading-tight sm:text-[11px]">
          <div className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
            {lead.platform === "ig" ? (
              <Instagram className="h-3 w-3 shrink-0 text-pink-600 dark:text-pink-400" />
            ) : (
              <Facebook className="h-3 w-3 shrink-0 text-blue-600 dark:text-blue-400" />
            )}
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              <span className="min-w-0 truncate font-medium text-foreground/90" title={pageName}>
                {pageName}
              </span>
              {formName ? (
                <>
                  <span className="shrink-0 text-muted-foreground/80" aria-hidden>
                    ·
                  </span>
                  <span
                    className="flex min-w-0 flex-1 items-center gap-0.5 truncate text-muted-foreground"
                    title={formName}
                  >
                    <FileText className="h-2.5 w-2.5 shrink-0 opacity-80" aria-hidden />
                    <span className="truncate">{formName}</span>
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <span className="shrink-0 tabular-nums text-[9px] text-muted-foreground sm:text-[10px]">
            {formatDate(date)}
          </span>
        </div>

        {leadIsRetryable(lead) && onRetry && (
          <div className="flex justify-end pt-px" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-950/30"
              disabled={isRetrying}
              onClick={onRetry}
            >
              {isRetrying ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <RotateCcw className="h-3 w-3 mr-1" />
              )}
              Retry
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
