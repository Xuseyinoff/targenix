import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Zap, ArrowLeft, Loader2, CheckCircle2 } from "lucide-react";

export default function ForgotPassword() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const mutation = trpc.emailAuth.forgotPassword.useMutation({
    onSuccess: () => setSent(true),
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) { toast.error("Please enter your email"); return; }
    mutation.mutate({ email });
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
          <ArrowLeft className="h-3.5 w-3.5" /> Back to login
        </button>

        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="h-12 w-12 rounded-2xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}>
            <Zap className="h-6 w-6 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-white tracking-tight">Forgot password?</h1>
            <p className="text-sm text-slate-400 mt-1">We'll send you a reset link</p>
          </div>
        </div>

        <div className="rounded-2xl p-6" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", backdropFilter: "blur(12px)" }}>
          {sent ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <CheckCircle2 className="h-10 w-10 text-green-400" />
              <p className="text-white font-medium">Check your email</p>
              <p className="text-sm text-slate-400">
                If an account exists for <span className="text-slate-200">{email}</span>, we've sent a password reset link. It expires in 1 hour.
              </p>
              <button onClick={() => setLocation("/login")} className="mt-2 text-sm text-blue-400 hover:text-blue-300 transition-colors">
                Back to login
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-300" htmlFor="email">Email address</label>
                <input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
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
                Send reset link
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
