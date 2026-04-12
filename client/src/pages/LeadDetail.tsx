import { useParams, useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  ArrowLeft,
  Phone,
  Clock,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  CheckCircle2,
  XCircle,
  Zap,
  Send,
  MessageSquare,
  Link2,
  ExternalLink,
  Facebook,
  Instagram,
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { LeadPipelineBadge, OrderIntegrationBadge } from "@/components/leads/PipelineBadges";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(dateStr: string | Date): string {
  const d = new Date(dateStr as string);
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getInitials(name?: string | null): string {
  if (!name?.trim()) return "?";
  const parts = name.trim().split(" ");
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return parts[0][0].toUpperCase();
}

// ─── Platform badge ───────────────────────────────────────────────────────────

function PlatformBadge({ platform }: { platform?: string | null }) {
  if (platform === "ig") {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-gradient-to-r from-orange-500/10 via-pink-500/10 to-purple-500/10 border border-pink-500/25 text-orange-400">
        <Instagram className="h-3 w-3" />
        Instagram
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/10 border border-blue-500/25 text-blue-400">
      <Facebook className="h-3 w-3" />
      Facebook
    </span>
  );
}

// ─── Copy button with 2s success state ───────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className={`h-8 w-8 rounded-lg border flex items-center justify-center transition-all duration-200 ${
        copied
          ? "bg-green-500 border-green-500 text-white"
          : "bg-background border-border text-muted-foreground hover:bg-primary hover:border-primary hover:text-white"
      }`}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-5 py-4">
      <p className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground mb-3">
        {label}
      </p>
      {children}
    </div>
  );
}

// ─── Marketing row ────────────────────────────────────────────────────────────

function MarketingRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground w-20 shrink-0">{label}</span>
      <span
        className="text-sm font-medium text-right truncate max-w-[220px] cursor-default"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Integration delivery icons / status ─────────────────────────────────────

function IntegrationIcon({ type }: { type: string | null }) {
  if (type === "TELEGRAM") return <MessageSquare className="h-4 w-4 text-blue-500" />;
  if (type === "AFFILIATE") return <Link2 className="h-4 w-4 text-purple-500" />;
  if (type === "LEAD_ROUTING") return <Send className="h-4 w-4 text-orange-500" />;
  return <Zap className="h-4 w-4 text-muted-foreground" />;
}

// ─── Response block ───────────────────────────────────────────────────────────

function ResponseBlock({ data }: { data: unknown }) {
  const [expanded, setExpanded] = useState(false);
  if (!data) return <span className="text-muted-foreground text-xs">—</span>;
  const str = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const isLong = str.length > 200;
  const display = isLong && !expanded ? str.slice(0, 200) + "…" : str;
  return (
    <div className="mt-2">
      <pre className="text-xs bg-muted/60 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed">
        {display}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1 text-xs text-primary mt-1 hover:underline"
        >
          {expanded ? (
            <><ChevronUp className="h-3 w-3" /> Show less</>
          ) : (
            <><ChevronDown className="h-3 w-3" /> Show more</>
          )}
        </button>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function LeadDetail() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const leadId = parseInt(params.id ?? "0", 10);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [techOpen, setTechOpen] = useState(false);

  const { data, isLoading, error } = trpc.leads.getDetail.useQuery(
    { id: leadId },
    { enabled: !!leadId }
  );

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="max-w-lg space-y-3 animate-pulse">
          <div className="h-8 w-32 bg-muted rounded" />
          <div className="h-44 bg-muted rounded-2xl" />
          <div className="h-28 bg-muted rounded-2xl" />
          <div className="h-28 bg-muted rounded-2xl" />
        </div>
      </DashboardLayout>
    );
  }

  if (error || !data) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <XCircle className="h-10 w-10 text-muted-foreground/30" />
          <p className="text-muted-foreground text-sm">Lead not found or access denied.</p>
          <Button variant="outline" size="sm" onClick={() => setLocation("/leads")}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to Leads
          </Button>
        </div>
      </DashboardLayout>
    );
  }

  const { lead, orders } = data;
  const raw = (lead as any).rawData as Record<string, any> | null | undefined;

  // Platform
  const platform = (lead as any).platform ?? raw?.platform ?? "fb";

  // Field data from rawData
  const fieldData: Array<{ name: string; values: string[] }> =
    raw?.field_data ?? [];

  // Marketing info
  const campaignName: string = (lead as any).campaignName ?? raw?.campaign_name ?? "";
  const adsetName: string = (lead as any).adsetName ?? raw?.adset_name ?? "";
  const adName: string = (lead as any).adName ?? raw?.ad_name ?? "";
  const campaignId: string = (lead as any).campaignId ?? raw?.campaign_id ?? "";

  // Counts
  const sentCount = orders.filter(o => o.status === "SENT").length;
  const failedCount = orders.filter(o => o.status === "FAILED").length;

  return (
    <DashboardLayout>
      <div className="max-w-lg space-y-4">
        {/* Back */}
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground hover:text-foreground"
          onClick={() => setLocation("/leads")}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Leads
        </Button>

        {/* ── Main card ── */}
        <div className="rounded-2xl border bg-card overflow-hidden">

          {/* Hero */}
          <div className="flex items-start gap-4 px-5 pt-5 pb-4">
            <div className="h-14 w-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-xl font-bold text-primary/60 shrink-0 select-none">
              {getInitials(lead.fullName)}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-bold tracking-tight leading-tight">
                {lead.fullName || <span className="text-muted-foreground font-normal">Unknown</span>}
              </h1>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <PlatformBadge platform={platform} />
                {lead.leadgenId && (
                  <span className="text-xs text-muted-foreground font-mono">
                    #{lead.leadgenId}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Date row */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground px-5 pb-4">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            {formatDate(lead.createdAt)}
          </div>

          <div className="h-px bg-border mx-0" />

          <Section label="Pipeline">
            <div className="space-y-3 text-sm">
              <LeadPipelineBadge
                lead={{
                  dataStatus: (lead as { dataStatus?: string }).dataStatus ?? "PENDING",
                  deliveryStatus: (lead as { deliveryStatus?: string }).deliveryStatus ?? "PENDING",
                }}
              />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                <span className="font-medium text-foreground/80">Graph</span>{" "}
                <span className="font-mono text-[10px] sm:text-[11px]">
                  {(lead as { dataStatus?: string }).dataStatus ?? "—"}
                </span>
                <span className="mx-1.5 text-muted-foreground/50">·</span>
                <span className="font-medium text-foreground/80">Routing</span>{" "}
                <span className="font-mono text-[10px] sm:text-[11px]">
                  {(lead as { deliveryStatus?: string }).deliveryStatus ?? "—"}
                </span>
              </p>
              {(lead as { dataError?: string | null }).dataError ? (
                <p className="text-xs text-destructive leading-relaxed break-words">
                  {(lead as { dataError?: string | null }).dataError}
                </p>
              ) : null}
            </div>
          </Section>

          <div className="h-px bg-border mx-0" />

          {/* Contact */}
          {lead.phone && (
            <>
              <Section label="Contact">
                <div className="flex items-center gap-3 bg-muted/40 border rounded-xl px-4 py-3.5">
                  <div className="h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <Phone className="h-4 w-4 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-base font-medium tracking-wide">{lead.phone}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">Phone number</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <a
                      href={`tel:${lead.phone}`}
                      className="h-8 w-8 rounded-lg border border-border bg-background flex items-center justify-center text-muted-foreground hover:bg-primary hover:border-primary hover:text-white transition-all duration-200"
                    >
                      <Phone className="h-3.5 w-3.5" />
                    </a>
                    <CopyButton text={lead.phone} />
                  </div>
                </div>
              </Section>
              <div className="h-px bg-border" />
            </>
          )}

          {/* Marketing */}
          {(campaignName || adsetName || adName) && (
            <>
              <Section label="Ad info">
                <div className="space-y-2.5">
                  <MarketingRow label="Campaign" value={campaignName} />
                  <MarketingRow label="Ad Set" value={adsetName} />
                  <MarketingRow label="Ad" value={adName} />
                </div>
              </Section>
              <div className="h-px bg-border" />
            </>
          )}

          {/* Dynamic field_data */}
          {fieldData.filter(f => f.values?.[0]).length > 0 && (
            <>
              <Section label="Form data">
                <div className="space-y-2">
                  {fieldData
                    .filter(f => f.values?.[0])
                    .map(f => (
                      <div
                        key={f.name}
                        className="flex items-center bg-muted/40 border rounded-xl px-4 py-2.5 gap-3"
                      >
                        <span className="text-xs text-muted-foreground capitalize w-24 shrink-0">
                          {f.name.replace(/_/g, " ")}
                        </span>
                        <span className="text-sm font-medium flex-1 min-w-0 truncate">
                          {f.values[0]}
                        </span>
                      </div>
                    ))}
                </div>
              </Section>
              <div className="h-px bg-border" />
            </>
          )}

          {/* Technical details — collapsible */}
          <div className="px-5 py-4">
            <button
              onClick={() => setTechOpen(v => !v)}
              className="flex items-center justify-between w-full"
            >
              <p className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground">
                Technical details
              </p>
              {techOpen ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>

            {techOpen && (
              <div className="grid grid-cols-2 gap-2 mt-3">
                {[
                  { label: "Lead ID", value: lead.leadgenId },
                  { label: "Internal ID", value: String(lead.id) },
                  { label: "Form ID", value: lead.formId },
                  { label: "Page ID", value: lead.pageId },
                  ...(campaignId ? [{ label: "Campaign ID", value: campaignId }] : []),
                ].map(item => (
                  <div
                    key={item.label}
                    className="bg-muted/40 border rounded-xl px-3 py-2.5"
                  >
                    <p className="text-[10px] text-muted-foreground mb-1">{item.label}</p>
                    <code className="text-xs font-mono text-primary/80 break-all">
                      {item.value || "—"}
                    </code>
                  </div>
                ))}
                {isAdmin && raw && (
                  <div className="col-span-2 bg-muted/40 border rounded-xl px-3 py-2.5">
                    <p className="text-[10px] text-muted-foreground mb-1">Raw JSON (Admin)</p>
                    <pre className="text-[10px] font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-40 text-muted-foreground">
                      {JSON.stringify(raw, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Integration Deliveries ── */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
              Deliveries
            </h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-muted font-medium">{orders.length}</span>
            {sentCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 font-medium">
                <CheckCircle2 className="h-3 w-3" /> {sentCount} sent
              </span>
            )}
            {failedCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 font-medium">
                <XCircle className="h-3 w-3" /> {failedCount} failed
              </span>
            )}
          </div>

          {orders.length === 0 ? (
            <div className="rounded-2xl border bg-card px-5 py-10 text-center">
              <Clock className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-muted-foreground text-sm">No integrations processed yet.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {orders.map(order => (
                <Card
                  key={order.id}
                  className={`rounded-2xl ${(order.status as string) === "FAILED" ? "border-destructive/40" : ""}`}
                >
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <IntegrationIcon type={order.integrationType as string | null} />
                        <div>
                          <p className="text-sm font-medium leading-tight">
                            {String(order.integrationName)}
                          </p>
                          {order.targetWebsiteName && (
                            <div className="flex items-center gap-1 mt-0.5">
                              <span className="text-xs text-muted-foreground">→</span>
                              {order.targetWebsiteUrl ? (
                                <a
                                  href={String(order.targetWebsiteUrl)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-primary hover:underline flex items-center gap-0.5"
                                >
                                  {String(order.targetWebsiteName)}
                                  <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {String(order.targetWebsiteName)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <OrderIntegrationBadge status={order.status as string} />
                    </div>

                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDate(order.createdAt as Date)}
                      </span>
                      {order.integrationType && (
                        <span className="flex items-center gap-1">
                          <Zap className="h-3 w-3" />
                          {String(order.integrationType)}
                        </span>
                      )}
                      {(order.retryCount as number) > 0 && (
                        <span className="text-amber-600">
                          Retried {order.retryCount as number}×
                        </span>
                      )}
                    </div>

                    {order.responseData && (
                      <div className="mt-3 pt-3 border-t">
                        <p className="text-xs font-medium text-muted-foreground mb-1">Response</p>
                        <ResponseBlock data={order.responseData as unknown} />
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
