import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Clock,
  CheckCircle2,
  AlertCircle,
  Phone,
  Mail,
  Copy,
  Check,
  RotateCcw,
  Loader2,
  Facebook,
  Instagram,
  FileText,
  Eye,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { leadIsRetryable, leadPipelineListBadge, type LeadPipelineFields } from "@/lib/leadPipelineUi";

interface Order {
  id: number;
  status: string;
}

export interface LeadTableData extends LeadPipelineFields {
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

function LeadAvatar({ name, platform, size = "sm" }: { name?: string | null; platform?: string; size?: "sm" | "md" }) {
  const initials = name?.trim() ? name.trim()[0].toUpperCase() : "?";
  const colorClass =
    platform === "ig"
      ? "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300"
      : platform === "fb"
      ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
      : "bg-primary/10 text-primary";
  return (
    <div
      className={cn(
        "rounded-xl flex items-center justify-center font-semibold shrink-0",
        size === "sm" ? "h-8 w-8 text-sm" : "h-9 w-9 text-sm",
        colorClass
      )}
    >
      {initials}
    </div>
  );
}

function PipelineStatusBadge({ lead }: { lead: LeadPipelineFields }) {
  const b = leadPipelineListBadge(lead);
  const Icon =
    b.key === "DELIVERED" ? CheckCircle2
    : b.key === "GRAPH_ERROR" || b.key === "FAILED" ? AlertCircle
    : b.key === "PROCESSING" ? Send
    : Clock;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium", b.className)}>
      <Icon className="h-3 w-3" />
      {b.label}
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

function PlatformIcon({ platform }: { platform?: string }) {
  if (platform === "ig") {
    return (
      <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 shrink-0">
        <Instagram className="h-2.5 w-2.5 text-white" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-blue-600 shrink-0">
      <Facebook className="h-2.5 w-2.5 text-white" />
    </span>
  );
}

function formatDate(d: Date): string {
  const day = d.getDate().toString().padStart(2, "0");
  const month = d.toLocaleString("en-GB", { month: "short" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${day} ${month}, ${time}`;
}

function CopyPhoneButton({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
      title="Copy phone"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(phone);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

interface LeadsTableProps {
  leads: LeadTableData[];
  onRowClick: (lead: LeadTableData) => void;
  retryingIds: Set<number>;
  onRetry: (id: number) => void;
  selectedIds: Set<number>;
  onSelectId: (id: number) => void;
  onSelectAll: (select: boolean) => void;
}

export function LeadsTable({
  leads, onRowClick, retryingIds, onRetry,
  selectedIds, onSelectId, onSelectAll,
}: LeadsTableProps) {
  const allSelected = leads.length > 0 && leads.every((l) => selectedIds.has(l.id));
  const someSelected = leads.some((l) => selectedIds.has(l.id));

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                {/* Checkbox col — desktop only */}
                <th className="hidden lg:table-cell px-4 py-3 w-10">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
                    onChange={(e) => onSelectAll(e.target.checked)}
                  />
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                {/* Contact col — desktop only */}
                <th className="hidden lg:table-cell text-left px-4 py-3 font-medium text-muted-foreground">Contact</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Source</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground whitespace-nowrap">Date</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground w-[110px]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => {
                const isSelected = selectedIds.has(lead.id);
                const pageName = lead.pageName ?? lead.pageId;
                const formName = lead.formName ?? lead.formId;
                const date = new Date(lead.createdAt as string);
                const firstOrder = lead.orders?.[0];

                return (
                  <tr
                    key={lead.id}
                    className={cn(
                      "border-b last:border-0 cursor-pointer transition-colors group",
                      isSelected ? "bg-primary/5" : "hover:bg-muted/30"
                    )}
                    onClick={() => onRowClick(lead)}
                  >
                    {/* Checkbox — desktop only */}
                    <td
                      className="hidden lg:table-cell px-4 py-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
                        checked={isSelected}
                        onChange={() => onSelectId(lead.id)}
                      />
                    </td>

                    {/* Name + (phone on tablet) */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <LeadAvatar name={lead.fullName} platform={lead.platform} />
                        <div className="min-w-0">
                          <p className="font-medium truncate max-w-[140px]">
                            {lead.fullName || "Unknown"}
                          </p>
                          {/* Show phone inline on tablet (md but not lg) */}
                          {lead.phone && (
                            <p className="lg:hidden text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                              <Phone className="h-3 w-3" />{lead.phone}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Contact — desktop only */}
                    <td className="hidden lg:table-cell px-4 py-3">
                      <div className="space-y-0.5">
                        {lead.phone && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Phone className="h-3 w-3" />{lead.phone}
                          </div>
                        )}
                        {lead.email && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Mail className="h-3 w-3" />{lead.email}
                          </div>
                        )}
                        {!lead.phone && !lead.email && (
                          <span className="text-xs text-muted-foreground/50">—</span>
                        )}
                      </div>
                    </td>

                    {/* Source */}
                    <td className="px-4 py-3">
                      <div className="space-y-0.5 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <PlatformIcon platform={lead.platform} />
                          <span
                            className={cn(
                              "text-xs font-medium truncate max-w-[140px]",
                              lead.platform === "ig"
                                ? "text-pink-600 dark:text-pink-400"
                                : "text-blue-600 dark:text-blue-400"
                            )}
                            title={pageName}
                          >
                            {pageName}
                          </span>
                        </div>
                        {formName && (
                          <div className="flex items-center gap-1.5 pl-0.5">
                            <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
                            <span
                              className="text-xs text-muted-foreground truncate max-w-[140px]"
                              title={formName}
                            >
                              {formName}
                            </span>
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <PipelineStatusBadge lead={lead} />
                        {firstOrder && <OrderBadge status={firstOrder.status} />}
                      </div>
                    </td>

                    {/* Date */}
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(date)}
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-0.5">
                        {lead.phone && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                              title="Call"
                              onClick={() => window.location.href = `tel:${lead.phone}`}
                            >
                              <Phone className="h-3.5 w-3.5" />
                            </Button>
                            <CopyPhoneButton phone={lead.phone} />
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="View"
                          onClick={() => onRowClick(lead)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                        {leadIsRetryable(lead) && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30 opacity-0 group-hover:opacity-100 transition-opacity"
                            disabled={retryingIds.has(lead.id)}
                            onClick={() => onRetry(lead.id)}
                            title="Retry"
                          >
                            {retryingIds.has(lead.id)
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <RotateCcw className="h-3.5 w-3.5" />}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
