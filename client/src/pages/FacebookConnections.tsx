import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Facebook,
  Key,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface FormState {
  pageId: string;
  pageName: string;
  accessToken: string;
}

const DEFAULT_FORM: FormState = { pageId: "", pageName: "", accessToken: "" };

export default function FacebookConnections() {
  const utils = trpc.useUtils();
  const { data: connections, isLoading } = trpc.facebook.listConnections.useQuery();
  const { data: webhookInfo } = trpc.facebook.webhookUrl.useQuery();
  const [showDialog, setShowDialog] = useState(false);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const createMutation = trpc.facebook.createConnection.useMutation({
    onSuccess: () => {
      toast.success("Facebook page connected successfully");
      utils.facebook.listConnections.invalidate();
      setShowDialog(false);
      setForm(DEFAULT_FORM);
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.facebook.deleteConnection.useMutation({
    onSuccess: () => {
      toast.success("Connection removed");
      utils.facebook.listConnections.invalidate();
      setDeleteId(null);
    },
    onError: (err) => toast.error(err.message),
  });

  const copyUrl = () => {
    if (webhookInfo?.url) {
      navigator.clipboard.writeText(webhookInfo.url);
      toast.success("Webhook URL copied");
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 max-w-4xl">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Facebook Connections</h1>
            <p className="text-muted-foreground text-sm mt-1">
              Connect Facebook Pages to receive lead data via Long-Lived Access Tokens
            </p>
          </div>
          <Button onClick={() => setShowDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Connect Page
          </Button>
        </div>

        {/* Setup Guide */}
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-primary" />
              Setup Instructions
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-2">
            <p>To connect a Facebook Page:</p>
            <ol className="list-decimal list-inside space-y-1 ml-1">
              <li>Go to <strong>Facebook Developer Console</strong> → Your App → Webhooks</li>
              <li>Add webhook URL: <code className="bg-background px-1 rounded">{webhookInfo?.url ?? "/api/webhooks/facebook"}</code>
                <Button variant="ghost" size="sm" className="h-5 w-5 p-0 ml-1" onClick={copyUrl}>
                  <Copy className="h-3 w-3" />
                </Button>
              </li>
              <li>Set Verify Token: <code className="bg-background px-1 rounded">{webhookInfo?.verifyToken}</code></li>
              <li>Subscribe to <strong>leadgen</strong> field</li>
              <li>Generate a <strong>Long-Lived Page Access Token</strong> and add it below</li>
            </ol>
          </CardContent>
        </Card>

        {/* Connections List */}
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !connections?.length ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <Facebook className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="font-medium text-muted-foreground">No pages connected</p>
              <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">
                Connect a Facebook Page to start receiving lead data from your forms
              </p>
              <Button className="mt-4" onClick={() => setShowDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Connect your first page
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {connections.map((conn) => (
              <Card key={conn.id}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3">
                      <div className="h-10 w-10 rounded-lg bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400 flex items-center justify-center shrink-0">
                        <Facebook className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-sm">{conn.pageName}</p>
                          {conn.isActive ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              Active
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">Inactive</span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Page ID: <code className="bg-muted px-1 rounded">{conn.pageId}</code>
                        </p>
                        <div className="flex items-center gap-1 mt-0.5">
                          <Key className="h-3 w-3 text-muted-foreground" />
                          <p className="text-xs text-muted-foreground">
                            Token: <code className="bg-muted px-1 rounded">***encrypted***</code>
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground/50 mt-1">
                          Connected {new Date(conn.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                      onClick={() => setDeleteId(conn.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Connect Facebook Page</DialogTitle>
            <DialogDescription>
              Add a Long-Lived Page Access Token to enable lead data fetching
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Page ID</Label>
              <Input
                placeholder="123456789012345"
                value={form.pageId}
                onChange={(e) => setForm((f) => ({ ...f, pageId: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Found in your Facebook Page settings
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Page Name</Label>
              <Input
                placeholder="My Business Page"
                value={form.pageName}
                onChange={(e) => setForm((f) => ({ ...f, pageName: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Long-Lived Page Access Token</Label>
              <Input
                type="password"
                placeholder="EAAxxxxxxxx..."
                value={form.accessToken}
                onChange={(e) => setForm((f) => ({ ...f, accessToken: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Token is encrypted before storage. Use a Long-Lived token (never expires).
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate(form)}
              disabled={createMutation.isPending || !form.pageId || !form.pageName || !form.accessToken}
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Connect Page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Connection</DialogTitle>
            <DialogDescription>
              This will remove the page connection. Existing leads will not be affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteId && deleteMutation.mutate({ id: deleteId })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
