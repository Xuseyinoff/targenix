import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  FlaskConical,
  ChevronRight,
  Zap,
  Tag,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { AppIcon, appBrandIconTileClass } from "@/components/destinations/appIcons";
// ─── Category colours ─────────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  messaging: "bg-blue-100 text-blue-700",
  spreadsheet: "bg-green-100 text-green-700",
  webhook: "bg-purple-100 text-purple-700",
  ecommerce: "bg-orange-100 text-orange-700",
  affiliate: "bg-pink-100 text-pink-700",
  other: "bg-slate-100 text-slate-600",
};

// ─── Availability badges ──────────────────────────────────────────────────────

const AVAIL_BADGE: Record<string, string> = {
  stable: "bg-emerald-100 text-emerald-700",
  beta:   "bg-amber-100 text-amber-700",
  deprecated: "bg-red-100 text-red-600",
};

// ─── Test dialog ──────────────────────────────────────────────────────────────

interface TestDialogProps {
  appKey: string;
  appName: string;
  open: boolean;
  onClose: () => void;
}

function TestDialog({ appKey, appName, open, onClose }: TestDialogProps) {
  const [connectionId, setConnectionId] = useState("");
  const [configJson, setConfigJson] = useState("{}");
  const [mockName, setMockName]   = useState("Test Foydalanuvchi");
  const [mockPhone, setMockPhone] = useState("+998901234567");
  const [mockEmail, setMockEmail] = useState("test@example.com");
  const [result, setResult]       = useState<{ ok: boolean; message: string } | null>(null);

  const testMutation = trpc.apps.testConfig.useMutation({
    onSuccess(data) {
      if (data.ok) {
        setResult({ ok: true, message: "Delivery successful!" });
        toast.success(`${appName} responded OK.`);
      } else {
        const err = data.result?.error ?? "Unknown error";
        setResult({ ok: false, message: err });
        toast.error(err);
      }
    },
    onError(err) {
      setResult({ ok: false, message: err.message });
      toast.error(err.message);
    },
  });

  function handleRun() {
    setResult(null);
    let parsedConfig: Record<string, unknown> = {};
    try { parsedConfig = JSON.parse(configJson || "{}"); } catch {
      toast.error("templateConfig is not valid JSON.");
      return;
    }
    const cid = connectionId.trim() ? Number(connectionId.trim()) : undefined;
    testMutation.mutate({
      appKey,
      templateConfig: parsedConfig,
      connectionId: cid && !isNaN(cid) ? cid : undefined,
      mockLead: { fullName: mockName, phone: mockPhone, email: mockEmail },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-amber-500" />
            Test — {appName}
          </DialogTitle>
          <DialogDescription>
            Send a test delivery with a mock lead to verify your connection and config.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid gap-1.5">
            <Label>Connection ID</Label>
            <Input
              placeholder="123"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              The numeric ID of the api_key connection to use (from /connections).
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label>Template config (JSON)</Label>
            <Textarea
              className="font-mono text-xs"
              rows={6}
              value={configJson}
              onChange={(e) => setConfigJson(e.target.value)}
              placeholder='{"mobile_phone":"{{phone_number}}","message":"Yangi lead: {{full_name}}"}'
            />
          </div>

          <div className="border rounded-lg p-3 space-y-2 bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Mock lead</p>
            <div className="grid grid-cols-3 gap-2">
              <div className="grid gap-1">
                <Label className="text-xs">Name</Label>
                <Input className="h-7 text-xs" value={mockName}  onChange={(e) => setMockName(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">Phone</Label>
                <Input className="h-7 text-xs" value={mockPhone} onChange={(e) => setMockPhone(e.target.value)} />
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">Email</Label>
                <Input className="h-7 text-xs" value={mockEmail} onChange={(e) => setMockEmail(e.target.value)} />
              </div>
            </div>
          </div>

          {result && (
            <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${result.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>
              {result.ok
                ? <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
                : <XCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />}
              <span className="font-mono text-xs break-all">{result.message}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={handleRun} disabled={testMutation.isPending}>
            {testMutation.isPending
              ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Running…</>
              : <><Zap className="h-4 w-4 mr-1.5" />Run test</>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── App card ─────────────────────────────────────────────────────────────────

interface AppCardProps {
  app: {
    key: string;
    name: string;
    icon: string | null;
    category: string;
    description: string | null;
    availability: string;
    connectionType: string;
  };
}

function AppCard({ app }: AppCardProps) {
  const [testOpen, setTestOpen] = useState(false);

  return (
    <>
      <Card className="hover:shadow-md transition-shadow group">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-3">
              <div className={appBrandIconTileClass("h-10 w-10 rounded-lg")}>
                <AppIcon name={app.icon} className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">{app.name}</CardTitle>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${CAT_COLOR[app.category] ?? CAT_COLOR.other}`}>
                    {app.category}
                  </span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${AVAIL_BADGE[app.availability] ?? AVAIL_BADGE.beta}`}>
                    {app.availability}
                  </span>
                </div>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="opacity-0 group-hover:opacity-100 transition-opacity h-8"
              onClick={() => setTestOpen(true)}
            >
              <FlaskConical className="h-3.5 w-3.5 mr-1" />
              Test
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <CardDescription className="text-sm leading-relaxed">
            {app.description ?? "No description."}
          </CardDescription>
          <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
            <Tag className="h-3 w-3" />
            <span className="font-mono">{app.key}</span>
            <ChevronRight className="h-3 w-3 mx-0.5" />
            <span className="text-muted-foreground/70">{app.connectionType}</span>
          </div>
        </CardContent>
      </Card>

      <TestDialog
        appKey={app.key}
        appName={app.name}
        open={testOpen}
        onClose={() => setTestOpen(false)}
      />
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const CATEGORIES = ["all", "messaging", "spreadsheet", "webhook", "ecommerce", "other"];

export default function AdminApps() {
  const { data: apps = [], isLoading } = trpc.apps.list.useQuery();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const visible = apps.filter((a) => {
    if (filter !== "all" && a.category !== filter) return false;
    if (search && !a.name.toLowerCase().includes(search.toLowerCase()) &&
        !a.key.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="container max-w-6xl py-8 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">App Marketplace</h1>
        <p className="text-muted-foreground mt-1">
          All registered integrations. Use the Test button to verify a connection before deploying.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <Input
          placeholder="Search apps…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((cat) => (
            <Button
              key={cat}
              size="sm"
              variant={filter === cat ? "default" : "outline"}
              onClick={() => setFilter(cat)}
              className="h-8 capitalize"
            >
              {cat}
            </Button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>{apps.length} total apps</span>
        <span>·</span>
        <span>{visible.length} shown</span>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-20 text-muted-foreground">No apps match your filter.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((app) => (
            <AppCard key={app.key} app={app} />
          ))}
        </div>
      )}
    </div>
  );
}
