import { Button } from "@/components/ui/button";
import {
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import {
  leadIsRetryable,
  leadErrorTypeI18nKey,
  type LeadPipelineFields,
} from "@/lib/leadPipelineBadgeModel";
import { LeadPipelineBadge, OrderIntegrationBadge } from "@/components/leads/PipelineBadges";
import { useT } from "@/hooks/useT";

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
  /** Classified Graph error bucket — drives the inline label on failed rows. */
  dataErrorType?: string | null;
  /** Raw Facebook error message — surfaced as the cell tooltip on failed rows. */
  dataError?: string | null;
}

function LeadAvatar({ name, size = "sm" }: { name?: string | null; size?: "sm" | "md" }) {
  const initials = name?.trim() ? name.trim()[0].toUpperCase() : "?";
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold text-white",
        "bg-emerald-500 dark:bg-emerald-600",
        "transition-all duration-200",
        "group-hover:ring-4 group-hover:ring-emerald-100 dark:group-hover:ring-emerald-950/50 group-hover:scale-105",
        size === "sm" ? "h-9 w-9 text-sm" : "h-10 w-10 text-sm",
      )}
    >
      {initials}
    </div>
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

function CopyPhoneButton({ phone, title }: { phone: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
      title={title}
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
  const t = useT();
  const allSelected = leads.length > 0 && leads.every((l) => selectedIds.has(l.id));
  const someSelected = leads.some((l) => selectedIds.has(l.id));

  return (
    <div className="bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50/60 dark:bg-muted/30 border-b border-slate-200/70 dark:border-border">
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
              <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">{t("leads.table.name")}</th>
              {/* Contact col — desktop only */}
              <th className="hidden lg:table-cell text-left px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">
                {t("leads.table.contact")}
              </th>
              <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">{t("leads.table.source")}</th>
              <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground">{t("leads.table.status")}</th>
              <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground whitespace-nowrap">
                {t("leads.table.date")}
              </th>
              <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground w-[110px]">
                {t("leads.table.actions")}
              </th>
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
                    "border-b border-slate-200/70 dark:border-border last:border-0 cursor-pointer group",
                    "transition-[background-color,box-shadow] duration-200 ease-out",
                    isSelected
                      ? "bg-emerald-50/60 dark:bg-emerald-950/20 shadow-[inset_3px_0_0_0_var(--primary)]"
                      : "hover:bg-emerald-50/40 dark:hover:bg-emerald-950/15 hover:shadow-[inset_3px_0_0_0_var(--primary)]"
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
                        <LeadAvatar name={lead.fullName} />
                        <div className="min-w-0">
                          <p className="font-medium truncate max-w-[140px] transition-colors duration-200 group-hover:text-emerald-700 dark:group-hover:text-emerald-400">
                            {lead.fullName || t("leads.table.unknown")}
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
                      <div className="flex flex-col items-start gap-1 max-w-[11rem] sm:max-w-[14rem]">
                        <LeadPipelineBadge lead={lead} size="compact" />
                        {firstOrder ? <OrderIntegrationBadge status={firstOrder.status} /> : null}
                        {lead.dataStatus === "ERROR" && lead.dataErrorType ? (
                          <span
                            className="text-[10px] sm:text-[11px] font-medium text-red-700 dark:text-red-300/90 truncate max-w-full"
                            title={lead.dataError ?? undefined}
                          >
                            {t(leadErrorTypeI18nKey(lead.dataErrorType))}
                          </span>
                        ) : null}
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
                              title={t("leads.table.call")}
                              onClick={() => window.location.href = `tel:${lead.phone}`}
                            >
                              <Phone className="h-3.5 w-3.5" />
                            </Button>
                            <CopyPhoneButton phone={lead.phone} title={t("leads.table.copyPhone")} />
                          </>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          title={t("leads.table.view")}
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
                            title={t("leads.table.retry")}
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
    </div>
  );
}
