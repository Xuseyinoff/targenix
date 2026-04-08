import { useParams, useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChevronLeft,
  User,
  Phone,
  Mail,
  Calendar,
  Zap,
  CheckCircle2,
  XCircle,
  Clock,
  Globe,
  ExternalLink,
  Send,
  MessageSquare,
  Link2,
  Copy,
  ChevronDown,
  ChevronUp,
  FileText,
  Facebook,
  Instagram,
  Hash,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";

function PlatformIcon({ platform }: { platform?: string | null }) {
  if (platform === "ig") {
    return (
      <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-gradient-to-br from-purple-500 via-pink-500 to-orange-400 shrink-0">
        <Instagram className="h-3 w-3 text-white" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-blue-600 shrink-0">
      <Facebook className="h-3 w-3 text-white" />
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "SENT")
    return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0">{status}</Badge>;
  if (status === "FAILED")
    return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

function IntegrationTypeIcon({ type }: { type: string | null }) {
  if (type === "TELEGRAM") return <MessageSquare className="h-4 w-4 text-blue-500" />;
  if (type === "AFFILIATE") return <Link2 className="h-4 w-4 text-purple-500" />;
  if (type === "LEAD_ROUTING") return <Send className="h-4 w-4 text-orange-500" />;
  return <Zap className="h-4 w-4 text-muted-foreground" />;
}

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
          {expanded ? <><ChevronUp className="h-3 w-3" /> Show less</> : <><ChevronDown className="h-3 w-3" /> Show more</>}
        </button>
      )}
    </div>
  );
}

export default function LeadDetail() {
  const params = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const leadId = parseInt(params.id ?? "0", 10);

  const { data, isLoading, error } = trpc.leads.getDetail.useQuery(
    { id: leadId },
    { enabled: !!leadId }
  );

  // ALL hooks must be before any early returns (Rules of Hooks)
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [techDetailsOpen, setTechDetailsOpen] = useState(false);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => toast.success(`${label} copied`));
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="space-y-4 max-w-3xl animate-pulse">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-40 bg-muted rounded-xl" />
          <div className="h-64 bg-muted rounded-xl" />
        </div>
      </DashboardLayout>
    );
  }

  if (error || !data) {
    return (
      <DashboardLayout>
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <XCircle className="h-10 w-10 text-muted-foreground/30" />
          <p className="text-muted-foreground">Lead not found or access denied.</p>
          <Button variant="outline" size="sm" onClick={() => setLocation("/leads")}>
            <ChevronLeft className="h-4 w-4 mr-1" /> Back to Leads
          </Button>
        </div>
      </DashboardLayout>
    );
  }

  const { lead, orders } = data;
  const sentCount = orders.filter(o => o.status === "SENT").length;
  const failedCount = orders.filter(o => o.status === "FAILED").length;

  // Resolve source info from enriched orders or lead fields
  const sourcePageName = (lead as any).pageName ?? lead.pageId;
  const sourceFormName = (lead as any).formName ?? lead.formId;
  const sourcePlatform = (lead as any).platform ?? "fb";
  const platformLabel = sourcePlatform === "ig" ? "Instagram" : "Facebook";

  return (
    <DashboardLayout>
      <div className="space-y-5 max-w-3xl">
        {/* Back button */}
        <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setLocation("/leads")}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back to Leads
        </Button>

        {/* Lead info card */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <User className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg leading-tight">
                    {lead.fullName || <span className="text-muted-foreground font-normal">Unknown</span>}
                  </CardTitle>
                  {/* Source line */}
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <PlatformIcon platform={sourcePlatform} />
                    <span className="text-xs text-muted-foreground font-medium">{platformLabel}</span>
                    <span className="text-muted-foreground/40 text-xs">•</span>
                    <span className="text-xs text-muted-foreground">{sourcePageName}</span>
                    <span className="text-muted-foreground/40 text-xs">•</span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <FileText className="h-3 w-3" />{sourceFormName}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground/60 mt-0.5">
                    Lead ID: #{lead.id} &nbsp;·&nbsp; {new Date(lead.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <Badge variant={lead.status === "FAILED" ? "destructive" : "secondary"} className="shrink-0">
                {lead.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {lead.phone && (
                <div className="flex items-center gap-2.5 group">
                  <Phone className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm">{lead.phone}</span>
                  <button
                    onClick={() => copyToClipboard(lead.phone!, "Phone")}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Copy className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              )}
              {lead.email && (
                <div className="flex items-center gap-2.5 group">
                  <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="text-sm">{lead.email}</span>
                  <button
                    onClick={() => copyToClipboard(lead.email!, "Email")}
                    className="opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Copy className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                </div>
              )}
            </div>

            {/* Summary pills */}
            <div className="flex items-center gap-2 mt-4 pt-4 border-t">
              <span className="text-xs text-muted-foreground">Integrations:</span>
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-muted font-medium">
                {orders.length} total
              </span>
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

            {/* Technical Details (collapsed) */}
            <div className="mt-3">
              <button
                onClick={() => setTechDetailsOpen(v => !v)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {techDetailsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                Technical Details
              </button>
              {techDetailsOpen && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 rounded-lg bg-muted/40 border text-xs">
                  <div>
                    <p className="text-muted-foreground mb-0.5">Lead ID (Leadgen)</p>
                    <code className="font-mono text-[11px] break-all">{lead.leadgenId}</code>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-0.5">Internal ID</p>
                    <code className="font-mono text-[11px]">#{lead.id}</code>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-0.5">Page ID</p>
                    <code className="font-mono text-[11px]">{lead.pageId}</code>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-0.5">Form ID</p>
                    <code className="font-mono text-[11px]">{lead.formId}</code>
                  </div>
                  {isAdmin && (lead as any).rawData && (
                    <div className="col-span-2">
                      <p className="text-muted-foreground mb-1">Raw JSON (Admin)</p>
                      <pre className="text-[10px] bg-background rounded p-2 overflow-x-auto whitespace-pre-wrap break-all max-h-40">
                        {JSON.stringify((lead as any).rawData, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Orders / Integrations */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Integration Deliveries ({orders.length})
          </h2>

          {orders.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center">
                <Clock className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                <p className="text-muted-foreground text-sm">No integrations processed yet.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {orders.map((order) => (
                <Card key={order.id} className={(order.status as string) === "FAILED" ? "border-destructive/40" : ""}>
                  <CardContent className="pt-4 pb-4">
                    {/* Order header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <IntegrationTypeIcon type={order.integrationType as string | null} />
                        <div>
                          <p className="text-sm font-medium leading-tight">{String(order.integrationName)}</p>
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
                                <span className="text-xs text-muted-foreground">{String(order.targetWebsiteName)}</span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <StatusBadge status={order.status as string} />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2.5 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(order.createdAt as Date).toLocaleString()}
                      </span>
                      {order.integrationType && (
                        <span className="flex items-center gap-1">
                          <Zap className="h-3 w-3" />
                          {String(order.integrationType)}
                        </span>
                      )}
                      {(order.retryCount as number) > 0 && (
                        <span className="text-amber-600">Retried {order.retryCount as number}×</span>
                      )}
                    </div>

                    {/* Response data */}
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
