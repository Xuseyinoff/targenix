import { useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import {
  Activity, CheckCircle2, XCircle, Clock, Inbox,
  RefreshCw, AlertTriangle, Zap, Loader2,
  TrendingUp, Database,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

type Period = "24h" | "7d" | "30d";

// ─── Colours ──────────────────────────────────────────────────────────────────

const SENT_COLOR   = "#22c55e";
const FAILED_COLOR = "#ef4444";
const PEND_COLOR   = "#f59e0b";

const PIE_COLORS = ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#06b6d4", "#8b5cf6"];

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  icon: Icon, label, value, sub, color = "text-foreground",
}: {
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-4 pt-5">
        <div className="p-2.5 rounded-xl bg-muted">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-xs text-muted-foreground font-medium">{label}</p>
          <p className={`text-2xl font-bold leading-tight ${color}`}>{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function PeriodTabs({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  return (
    <div className="flex gap-1 border rounded-lg p-1 w-fit">
      {(["24h", "7d", "30d"] as Period[]).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`px-3 py-1 text-sm rounded-md transition-colors ${
            value === p ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

// CircuitBreakerTable removed in Sprint 1 / Item 1.3 — see
// server/integrations/dispatch.ts for the rationale.

// ─── Main page ────────────────────────────────────────────────────────────────

export default function AdminMetrics() {
  const [period, setPeriod] = useState<Period>("24h");

  const overview = trpc.metrics.overview.useQuery({ period });
  const timeSeries = trpc.metrics.timeSeries.useQuery({
    days: period === "24h" ? 1 : period === "7d" ? 7 : 30,
  });
  const adapterBreakdown  = trpc.metrics.adapterBreakdown.useQuery({ period });
  const errorDistribution = trpc.metrics.errorDistribution.useQuery({ period });
  const queueStats        = trpc.metrics.queueStats.useQuery();
  const integrationBd     = trpc.metrics.integrationBreakdown.useQuery({ period });

  const ov = overview.data;
  const qs = queueStats.data;

  return (
    <div className="container max-w-7xl py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" />
            Observability Dashboard
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Live delivery metrics, circuit breakers, and queue health.
          </p>
        </div>
        <PeriodTabs value={period} onChange={setPeriod} />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard icon={TrendingUp}    label="Total deliveries"  value={ov?.total ?? "—"}
          sub={`last ${period}`} />
        <StatCard icon={CheckCircle2}  label="Success rate"
          value={ov ? `${ov.successRate}%` : "—"}
          color={ov ? (ov.successRate >= 95 ? "text-emerald-600" : ov.successRate >= 80 ? "text-amber-600" : "text-red-600") : ""}
          sub={`${ov?.sent ?? 0} sent`} />
        <StatCard icon={XCircle}       label="Failed"    value={ov?.failed ?? "—"} color="text-red-600"
          sub={`${ov?.pending ?? 0} pending`} />
        <StatCard icon={Clock}         label="Avg latency"
          value={ov?.avgDurationMs != null ? `${ov.avgDurationMs}ms` : "—"}
          sub={ov?.p95DurationMs != null ? `p95: ${ov.p95DurationMs}ms` : undefined} />
        <StatCard icon={Inbox}         label="Queue"
          value={(qs?.pending ?? 0) + (qs?.retryable ?? 0)}
          sub={`${qs?.dlq ?? 0} in DLQ`}
          color={((qs?.dlq ?? 0) > 0) ? "text-red-600" : undefined} />
        <StatCard icon={AlertTriangle} label="DLQ"      value={qs?.dlq ?? "—"}
          color={(qs?.dlq ?? 0) > 0 ? "text-red-600" : "text-foreground"}
          sub={`${qs?.overdue ?? 0} overdue`} />
      </div>

      {/* Time series chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery volume — last {period}</CardTitle>
        </CardHeader>
        <CardContent>
          {timeSeries.isFetching ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (timeSeries.data?.length ?? 0) === 0 ? (
            <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
              No data for this period.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={timeSeries.data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--border))" }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="sent"   name="Sent"   stackId="a" fill={SENT_COLOR}   radius={[0, 0, 0, 0]} />
                <Bar dataKey="failed" name="Failed" stackId="a" fill={FAILED_COLOR} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Adapter breakdown + Error distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Adapter table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" />
              Adapter breakdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            {adapterBreakdown.isFetching ? (
              <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (adapterBreakdown.data?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No data yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground uppercase tracking-wide">
                    <th className="text-left py-2 pr-3 font-medium">Adapter</th>
                    <th className="text-right py-2 pr-3 font-medium">Total</th>
                    <th className="text-right py-2 pr-3 font-medium">Rate</th>
                    <th className="text-right py-2 font-medium">Avg ms</th>
                  </tr>
                </thead>
                <tbody>
                  {adapterBreakdown.data?.map((a) => (
                    <tr key={a.adapterKey} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-mono text-xs">{a.adapterKey}</td>
                      <td className="py-2 pr-3 text-right">{a.total}</td>
                      <td className="py-2 pr-3 text-right">
                        <span className={`font-medium ${a.successRate >= 95 ? "text-emerald-600" : a.successRate >= 80 ? "text-amber-600" : "text-red-600"}`}>
                          {a.successRate}%
                        </span>
                      </td>
                      <td className="py-2 text-right text-muted-foreground text-xs">
                        {a.avgDurationMs != null ? `${a.avgDurationMs}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Error pie chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <XCircle className="h-4 w-4 text-red-500" />
              Error type distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            {errorDistribution.isFetching ? (
              <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
            ) : (errorDistribution.data?.length ?? 0) === 0 ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                No errors in this period.
              </div>
            ) : (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width="50%" height={160}>
                  <PieChart>
                    <Pie
                      data={errorDistribution.data}
                      dataKey="count"
                      nameKey="errorType"
                      cx="50%" cy="50%"
                      outerRadius={70}
                      innerRadius={40}
                    >
                      {errorDistribution.data?.map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex flex-col gap-1.5 text-sm">
                  {errorDistribution.data?.map((e, i) => (
                    <div key={e.errorType} className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-sm flex-shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="text-muted-foreground">{e.errorType}</span>
                      <span className="font-medium ml-auto pl-2">{e.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Circuit breaker UI removed in Sprint 1 / Item 1.3 — the in-memory
          breaker was per-process and gave no protection under multi-worker
          deploys. Adapter-level 429 backoff + retry scheduler escalation
          cover the protection path. */}

      {/* Queue stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-muted-foreground font-medium">Pending</p>
            <p className="text-2xl font-bold">{qs?.pending ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-muted-foreground font-medium">Retryable</p>
            <p className="text-2xl font-bold text-amber-600">{qs?.retryable ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-muted-foreground font-medium">DLQ (permanent)</p>
            <p className={`text-2xl font-bold ${(qs?.dlq ?? 0) > 0 ? "text-red-600" : ""}`}>{qs?.dlq ?? "—"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <p className="text-xs text-muted-foreground font-medium">Overdue retries</p>
            <p className={`text-2xl font-bold ${(qs?.overdue ?? 0) > 0 ? "text-orange-600" : ""}`}>{qs?.overdue ?? "—"}</p>
          </CardContent>
        </Card>
      </div>

      {/* Integration breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-blue-500" />
            Top integrations — {period}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {integrationBd.isFetching ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (integrationBd.data?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No data yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="text-left py-2 pr-4 font-medium">Integration</th>
                  <th className="text-right py-2 pr-4 font-medium">Total</th>
                  <th className="text-right py-2 pr-4 font-medium">Sent</th>
                  <th className="text-right py-2 pr-4 font-medium">Failed</th>
                  <th className="text-right py-2 font-medium">Success %</th>
                </tr>
              </thead>
              <tbody>
                {integrationBd.data?.map((r) => (
                  <tr key={r.integrationId} className="border-b last:border-0">
                    <td className="py-2 pr-4">{r.integrationName}</td>
                    <td className="py-2 pr-4 text-right">{r.total}</td>
                    <td className="py-2 pr-4 text-right text-emerald-600">{r.sent}</td>
                    <td className="py-2 pr-4 text-right text-red-500">{r.failed}</td>
                    <td className="py-2 text-right">
                      <span className={`font-semibold ${r.successRate >= 95 ? "text-emerald-600" : r.successRate >= 80 ? "text-amber-600" : "text-red-600"}`}>
                        {r.successRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
