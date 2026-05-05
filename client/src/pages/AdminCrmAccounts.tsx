import DashboardLayout from "@/components/DashboardLayout";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import {
  ClipboardList,
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Eye,
  EyeOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";

const PLATFORM_LABELS: Record<string, string> = {
  sotuvchi: "Sotuvchi.com",
  "100k": "100k.uz",
};

function StatusBadge({ status }: { status: string }) {
  if (status === "active")
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
        <CheckCircle className="w-3 h-3" /> Active
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
      <AlertCircle className="w-3 h-3" /> Xato
    </span>
  );
}

function timeAgo(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s oldin`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m oldin`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}s oldin`;
  return `${Math.floor(diff / 86400)}k oldin`;
}

export default function AdminCrmAccounts() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (user && user.role !== "admin") setLocation("/leads");
  }, [user, setLocation]);

  const utils = trpc.useUtils();
  const { data: accounts = [], isLoading } = trpc.adminCrm.listAccounts.useQuery(undefined, {
    enabled: user?.role === "admin",
  });

  const addMutation = trpc.adminCrm.addAccount.useMutation({
    onSuccess: () => {
      utils.adminCrm.listAccounts.invalidate();
      setForm({ platform: "sotuvchi", displayName: "", phone: "", password: "" });
      setShowForm(false);
      setError("");
    },
    onError: (err) => setError(err.message),
  });

  const deleteMutation = trpc.adminCrm.deleteAccount.useMutation({
    onSuccess: () => utils.adminCrm.listAccounts.invalidate(),
  });

  const [showForm, setShowForm] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    platform: "sotuvchi" as "sotuvchi" | "100k",
    displayName: "",
    phone: "",
    password: "",
  });

  const handleAdd = () => {
    setError("");
    if (!form.displayName.trim() || !form.phone.trim() || !form.password.trim()) {
      setError("Barcha maydonlarni to'ldiring");
      return;
    }
    addMutation.mutate(form);
  };

  return (
    <DashboardLayout>
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ClipboardList className="w-6 h-6 text-primary" />
            <div>
              <h1 className="text-xl font-semibold">CRM Akkauntlar</h1>
              <p className="text-sm text-muted-foreground">
                Sotuvchi va 100k.uz platformalari uchun kirish ma'lumotlari
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLocation("/admin/crm/orders")}
            >
              Orderlar
            </Button>
            <Button size="sm" onClick={() => setShowForm((v) => !v)}>
              <Plus className="w-4 h-4 mr-1" />
              Akkaunt qo'shish
            </Button>
          </div>
        </div>

        {/* Add form */}
        {showForm && (
          <Card>
            <CardContent className="pt-5 space-y-4">
              <p className="text-sm font-medium">Yangi akkaunt</p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Platforma</label>
                  <select
                    className="w-full border rounded-md px-3 py-2 text-sm bg-background"
                    value={form.platform}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, platform: e.target.value as "sotuvchi" | "100k", phone: "" }))
                    }
                  >
                    <option value="sotuvchi">Sotuvchi.com</option>
                    <option value="100k">100k.uz</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Nom</label>
                  <Input
                    placeholder="Asosiy akkaunt"
                    value={form.displayName}
                    onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">
                    {form.platform === "sotuvchi" ? "Email" : "Telefon"}
                  </label>
                  <Input
                    type={form.platform === "sotuvchi" ? "email" : "tel"}
                    placeholder={form.platform === "sotuvchi" ? "email@gmail.com" : "+998XXXXXXXXX"}
                    value={form.phone}
                    onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Parol</label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="••••••••"
                      value={form.password}
                      onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                      className="pr-9"
                    />
                    <button
                      type="button"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword((v) => !v)}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              {error && <p className="text-xs text-red-500">{error}</p>}

              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowForm(false);
                    setError("");
                  }}
                >
                  Bekor
                </Button>
                <Button
                  size="sm"
                  onClick={handleAdd}
                  disabled={addMutation.isPending}
                >
                  {addMutation.isPending ? (
                    <>
                      <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                      Login bo'lyapti...
                    </>
                  ) : (
                    "Saqlash"
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Accounts list */}
        {isLoading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">Yuklanmoqda...</div>
        ) : accounts.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center space-y-2">
              <ClipboardList className="w-10 h-10 mx-auto text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                Hali akkaunt qo'shilmagan.
              </p>
              <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
                <Plus className="w-4 h-4 mr-1" />
                Birinchi akkauntni qo'shing
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {accounts.map((acc) => (
              <Card key={acc.id}>
                <CardContent className="py-4 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <ClipboardList className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{acc.displayName}</span>
                        <Badge variant="outline" className="text-[11px] px-1.5 py-0">
                          {PLATFORM_LABELS[acc.platform] ?? acc.platform}
                        </Badge>
                        <StatusBadge status={acc.status} />
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                        <span>{acc.phone}</span>
                        <span>ID: {acc.platformUserId}</span>
                        <span>Login: {timeAgo(acc.lastLoginAt)}</span>
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-red-500 flex-shrink-0"
                    onClick={() => {
                      if (confirm(`"${acc.displayName}" akkauntini o'chirasizmi?`)) {
                        deleteMutation.mutate({ id: acc.id });
                      }
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
