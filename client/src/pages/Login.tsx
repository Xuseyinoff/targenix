import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Workflow,
  Eye,
  EyeOff,
  Loader2,
  ArrowLeft,
  Zap,
  ShieldCheck,
  Globe2,
  Lock,
} from "lucide-react";
import { useT } from "@/hooks/useT";

export default function Login() {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fbLoading, setFbLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const t = useT();

  const utils = trpc.useUtils();

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      toast.success(t("auth.loggedInSuccess"));
      setLocation("/");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast.error(t("auth.fillAllFields"));
      return;
    }
    loginMutation.mutate({ email, password });
  };

  const onGoogleSuccess = useCallback(async () => {
    await utils.auth.me.invalidate();
    toast.success(t("auth.loggedInGoogle"));
    setLocation("/");
  }, [utils, t, setLocation]);

  const handleGoogleLogin = useCallback(async () => {
    setGoogleLoading(true);
    try {
      const res = await fetch("/api/oauth/google/initiate?mode=login", {
        credentials: "include",
      });
      const data = await res.json();
      if (!data.oauthUrl) { setGoogleLoading(false); toast.error("Failed to start Google login."); return; }

      const popup = window.open(data.oauthUrl, "google_login_popup", "width=500,height=600,scrollbars=yes");
      if (!popup) { setGoogleLoading(false); toast.error(t("auth.googleLoginCancelled")); return; }
    } catch {
      setGoogleLoading(false);
      toast.error("Failed to start Google login.");
    }
  }, [t]);

  useEffect(() => {
    const bc = new BroadcastChannel("targenix_google_login");
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "google_login_success") { setGoogleLoading(false); onGoogleSuccess(); }
      else if (e.data?.type === "google_login_error") { setGoogleLoading(false); toast.error(e.data.error || t("auth.googleLoginCancelled")); }
    };
    bc.addEventListener("message", handler);

    const msgHandler = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "google_login_success") { setGoogleLoading(false); onGoogleSuccess(); }
      else if (e.data?.type === "google_login_error") { setGoogleLoading(false); toast.error(e.data.error || t("auth.googleLoginCancelled")); }
    };
    window.addEventListener("message", msgHandler);

    return () => { bc.removeEventListener("message", handler); bc.close(); window.removeEventListener("message", msgHandler); };
  }, [onGoogleSuccess, t]);

  const onFbSuccess = useCallback(async () => {
    await utils.auth.me.invalidate();
    toast.success(t("auth.loggedInFacebook"));
    setLocation("/");
  }, [utils, t, setLocation]);

  const handleFacebookLogin = useCallback(async () => {
    setFbLoading(true);
    try {
      const res = await fetch("/api/auth/facebook/login", { credentials: "include" });
      const data = await res.json();
      if (!data.oauthUrl) { setFbLoading(false); toast.error("Failed to start Facebook login."); return; }

      const popup = window.open(data.oauthUrl, "fb_login_popup", "width=600,height=700,scrollbars=yes");
      if (!popup) { setFbLoading(false); toast.error(t("auth.fbLoginCancelled")); return; }
    } catch {
      setFbLoading(false);
      toast.error("Failed to start Facebook login.");
    }
  }, [t]);

  useEffect(() => {
    const bc = new BroadcastChannel("targenix_fb_login");
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "fb_login_success") {
        setFbLoading(false);
        onFbSuccess();
      } else if (e.data?.type === "fb_login_error") {
        setFbLoading(false);
        toast.error(e.data.error || t("auth.fbLoginCancelled"));
      }
    };
    bc.addEventListener("message", handler);

    const msgHandler = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (e.data?.type === "fb_login_success") { setFbLoading(false); onFbSuccess(); }
      else if (e.data?.type === "fb_login_error") { setFbLoading(false); toast.error(e.data.error || t("auth.fbLoginCancelled")); }
    };
    window.addEventListener("message", msgHandler);

    return () => { bc.removeEventListener("message", handler); bc.close(); window.removeEventListener("message", msgHandler); };
  }, [onFbSuccess, t]);

  const isLoading = loginMutation.isPending || fbLoading || googleLoading;

  return (
    <div className="min-h-screen bg-background flex flex-col lg:flex-row">
      {/* ── Left marketing panel ───────────────────────────────────────────── */}
      <aside className="hidden lg:flex lg:w-1/2 xl:w-[55%] relative overflow-hidden p-12 xl:p-16 flex-col justify-between bg-gradient-to-br from-emerald-50 via-white to-emerald-50/40 dark:from-emerald-950/40 dark:via-background dark:to-emerald-950/20 border-r border-slate-200/70 dark:border-border">
        {/* Subtle background grid */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{
            backgroundImage:
              `linear-gradient(rgba(16,185,129,0.4) 1px, transparent 1px), linear-gradient(90deg, rgba(16,185,129,0.4) 1px, transparent 1px)`,
            backgroundSize: "48px 48px",
          }}
        />
        {/* Emerald glow */}
        <div aria-hidden className="absolute -top-32 -left-32 w-96 h-96 bg-emerald-300/30 dark:bg-emerald-700/15 rounded-full blur-3xl pointer-events-none" />
        <div aria-hidden className="absolute bottom-0 right-0 w-96 h-96 bg-emerald-400/20 dark:bg-emerald-600/10 rounded-full blur-3xl pointer-events-none" />

        {/* Brand */}
        <div className="relative z-10 flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-primary flex items-center justify-center shadow-sm">
            <Workflow className="h-5 w-5 text-primary-foreground" strokeWidth={2.5} />
          </div>
          <span className="font-bold text-xl tracking-tight">
            Targenix<span className="text-primary">.</span>
          </span>
        </div>

        {/* Hero copy */}
        <div className="relative z-10 max-w-lg">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950/40 border border-emerald-200/60 dark:border-emerald-900/40 mb-5">
            <Zap className="h-3 w-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
            <span className="text-[10px] font-bold tracking-widest uppercase text-emerald-700 dark:text-emerald-400">
              Facebook Lead Ads automation
            </span>
          </div>
          <h2 className="text-4xl xl:text-5xl font-bold tracking-tight leading-tight">
            Capture every lead.<br />
            <span className="text-primary">Route in seconds.</span>
          </h2>
          <p className="text-base text-muted-foreground mt-4 leading-relaxed">
            Connect Facebook in one click. Every form submission flows straight into Telegram, your CRM, or any HTTP endpoint — verified, enriched, and retried automatically.
          </p>
        </div>

        {/* Feature grid (system capabilities) */}
        <div className="relative z-10 grid grid-cols-2 gap-3 max-w-lg">
          <FeatureCard
            icon={Zap}
            iconBg="bg-orange-100 dark:bg-orange-950/40"
            iconColor="text-orange-600 dark:text-orange-400"
            title="Sub-second routing"
            body="Webhook → destination in &lt; 1 s"
          />
          <FeatureCard
            icon={ShieldCheck}
            iconBg="bg-emerald-100 dark:bg-emerald-950/40"
            iconColor="text-emerald-600 dark:text-emerald-400"
            title="HMAC-SHA256"
            body="Every payload signature-verified"
          />
          <FeatureCard
            icon={Globe2}
            iconBg="bg-sky-100 dark:bg-sky-950/40"
            iconColor="text-sky-600 dark:text-sky-400"
            title="Any destination"
            body="Telegram, CRMs, HTTP webhooks"
          />
          <FeatureCard
            icon={Lock}
            iconBg="bg-violet-100 dark:bg-violet-950/40"
            iconColor="text-violet-600 dark:text-violet-400"
            title="AES-256 encrypted"
            body="Tokens never leave the server"
          />
        </div>
      </aside>

      {/* ── Right form panel ───────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col">
        {/* Mobile-only top bar: brand + back */}
        <div className="lg:hidden flex items-center justify-between px-5 pt-5">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center shadow-sm">
              <Workflow className="h-4 w-4 text-primary-foreground" strokeWidth={2.5} />
            </div>
            <span className="font-bold text-base tracking-tight">
              Targenix<span className="text-primary">.</span>
            </span>
          </div>
          <button
            onClick={() => setLocation("/")}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t("auth.backToHome")}
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center px-5 py-10 lg:px-10">
          <div className="w-full max-w-md">
            {/* Desktop back link */}
            <button
              onClick={() => setLocation("/")}
              className="hidden lg:inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors mb-8"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("auth.backToHome")}
            </button>

            {/* Heading */}
            <div className="mb-7">
              <h1 className="text-3xl font-bold tracking-tight">Welcome back</h1>
              <p className="text-sm text-muted-foreground mt-1.5">
                {t("auth.signInSubtitle") || "Sign in to manage your lead routing"}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Email */}
              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground" htmlFor="email">
                  {t("auth.email")}
                </label>
                <input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  disabled={isLoading}
                  className="w-full h-11 px-4 rounded-xl text-sm border border-input bg-background focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none transition-all disabled:opacity-50 font-medium placeholder:text-muted-foreground/60 placeholder:font-normal"
                />
              </div>

              {/* Password */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500 dark:text-muted-foreground" htmlFor="password">
                    {t("auth.password")}
                  </label>
                  <button
                    type="button"
                    onClick={() => setLocation("/forgot-password")}
                    className="text-xs text-primary hover:underline font-medium"
                  >
                    {t("auth.forgotPassword")}
                  </button>
                </div>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={isLoading}
                    className="w-full h-11 pl-4 pr-11 rounded-xl text-sm border border-input bg-background focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none transition-all disabled:opacity-50 font-medium placeholder:text-muted-foreground/60 placeholder:font-normal"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors p-1"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={isLoading}
                className="wapi-button-hover w-full h-11 mt-2 rounded-xl font-semibold text-sm bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loginMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {loginMutation.isPending ? t("auth.signingIn") : t("auth.signIn")}
              </button>
            </form>

            {/* Divider */}
            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-slate-200/70 dark:border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="px-3 text-xs font-medium text-muted-foreground bg-background">
                  {t("auth.or")}
                </span>
              </div>
            </div>

            {/* Social logins */}
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={handleFacebookLogin}
                disabled={isLoading}
                className="wapi-button-hover w-full h-11 rounded-xl font-semibold text-sm text-white bg-[#1877F2] hover:bg-[#166fe5] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2.5"
              >
                {fbLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
                  </svg>
                )}
                {t("auth.continueWithFacebook")}
              </button>

              <button
                type="button"
                onClick={handleGoogleLogin}
                disabled={isLoading}
                className="wapi-button-hover w-full h-11 rounded-xl font-semibold text-sm text-foreground bg-background border border-input hover:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2.5"
              >
                {googleLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                )}
                {t("auth.continueWithGoogle")}
              </button>
            </div>

            <p className="text-center text-sm text-muted-foreground mt-8">
              {t("auth.noAccount")}{" "}
              <button
                className="text-primary hover:underline font-semibold"
                onClick={() => setLocation("/register")}
              >
                {t("auth.createOne")}
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Feature card on the marketing panel ─────────────────────────────────────

function FeatureCard({
  icon: Icon,
  iconBg,
  iconColor,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  iconBg: string;
  iconColor: string;
  title: string;
  body: string;
}) {
  return (
    <div className="bg-white/70 dark:bg-card/60 backdrop-blur-sm border border-slate-200/70 dark:border-border rounded-2xl p-4">
      <div className={`h-9 w-9 rounded-xl flex items-center justify-center mb-3 ${iconBg}`}>
        <Icon className={`h-4 w-4 ${iconColor}`} strokeWidth={2.2} />
      </div>
      <p className="text-sm font-bold tracking-tight leading-snug">{title}</p>
      <p className="text-xs text-muted-foreground mt-0.5 leading-snug" dangerouslySetInnerHTML={{ __html: body }} />
    </div>
  );
}
