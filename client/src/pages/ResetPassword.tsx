import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Zap, ArrowLeft, Loader2, Eye, EyeOff, CheckCircle2 } from "lucide-react";
import { useT } from "@/hooks/useT";

export default function ResetPassword() {
  const [location, setLocation] = useLocation();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);
  const t = useT();

  const mutation = trpc.auth.resetPassword.useMutation({
    onSuccess: () => setDone(true),
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || !confirm) { toast.error(t("auth.reset.fillAllFields")); return; }
    if (password !== confirm) { toast.error(t("auth.reset.passwordsNoMatch")); return; }
    if (!token) { toast.error(t("auth.reset.invalidResetLink")); return; }
    mutation.mutate({ token, password });
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: "linear-gradient(135deg, #080a14 0%, #0d1428 50%, #080a14 100%)" }}
    >
      <div className="absolute inset-0 opacity-10" style={{ backgroundImage: `linear-gradient(rgba(59,130,246,0.2) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,0.2) 1px, transparent 1px)`, backgroundSize: "50px 50px" }} />
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 bg-blue-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 w-full max-w-sm">
        <button onClick={() => setLocation("/login")} className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors mb-8">
          <ArrowLeft className="h-3.5 w-3.5" /> {t("auth.reset.backToLogin")}
        </button>

        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="h-12 w-12 rounded-2xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
            <Zap className="h-6 w-6 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-white tracking-tight">{t("auth.reset.title")}</h1>
            <p className="text-sm text-slate-400 mt-1">{t("auth.reset.subtitle")}</p>
          </div>
        </div>

        <div className="rounded-2xl p-6" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", backdropFilter: "blur(12px)" }}>
          {done ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <CheckCircle2 className="h-10 w-10 text-green-400" />
              <p className="text-white font-medium">{t("auth.reset.successTitle")}</p>
              <p className="text-sm text-slate-400">{t("auth.reset.successBody")}</p>
              <button
                onClick={() => setLocation("/login")}
                className="mt-2 w-full py-2.5 rounded-xl font-semibold text-white text-sm transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)" }}
              >
                {t("auth.reset.goToLogin")}
              </button>
            </div>
          ) : !token ? (
            <div className="text-center py-4">
              <p className="text-red-400 text-sm">{t("auth.reset.invalidLink")}</p>
              <button onClick={() => setLocation("/forgot-password")} className="mt-3 text-sm text-blue-400 hover:text-blue-300">
                {t("auth.reset.requestNew")}
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300" htmlFor="password">{t("auth.reset.newPasswordLabel")}</label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={mutation.isPending}
                    className="w-full px-3.5 py-2.5 pr-10 rounded-xl text-sm text-white placeholder-slate-500 outline-none transition-all disabled:opacity-50"
                    style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
                    onFocus={(e) => { e.target.style.borderColor = "rgba(59,130,246,0.6)"; e.target.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.1)"; }}
                    onBlur={(e) => { e.target.style.borderColor = "rgba(255,255,255,0.1)"; e.target.style.boxShadow = "none"; }}
                  />
                  <button type="button" onClick={() => setShowPassword((v) => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors" tabIndex={-1}>
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300" htmlFor="confirm">{t("auth.reset.confirmPasswordLabel")}</label>
                <input
                  id="confirm"
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  disabled={mutation.isPending}
                  className="w-full px-3.5 py-2.5 rounded-xl text-sm text-white placeholder-slate-500 outline-none transition-all disabled:opacity-50"
                  style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
                  onFocus={(e) => { e.target.style.borderColor = "rgba(59,130,246,0.6)"; e.target.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.1)"; }}
                  onBlur={(e) => { e.target.style.borderColor = "rgba(255,255,255,0.1)"; e.target.style.boxShadow = "none"; }}
                />
              </div>

              <button
                type="submit"
                disabled={mutation.isPending}
                className="w-full py-2.5 rounded-xl font-semibold text-white text-sm transition-all duration-200 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-2"
                style={{ background: "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)" }}
              >
                {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {mutation.isPending ? t("auth.reset.updating") : t("auth.reset.updatePassword")}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
