import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Zap, Eye, EyeOff, Loader2, ArrowLeft, CheckCircle } from "lucide-react";
import { useT } from "@/hooks/useT";

export default function Register() {
  const [, setLocation] = useLocation();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [fbLoading, setFbLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const t = useT();

  const utils = trpc.useUtils();

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
      toast.success(t("auth.accountCreated"));
      setLocation("/");
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password || !confirmPassword) {
      toast.error(t("auth.fillAllRequired"));
      return;
    }
    if (password.length < 8) {
      toast.error(t("auth.passwordTooShort"));
      return;
    }
    if (password !== confirmPassword) {
      toast.error(t("auth.passwordsNoMatch"));
      return;
    }
    registerMutation.mutate({ email, password, name: name || undefined });
  };

  const onGoogleSuccess = useCallback(async () => {
    await utils.auth.me.invalidate();
    toast.success(t("auth.loggedInGoogle"));
    setLocation("/");
  }, [utils, t, setLocation]);

  const handleGoogleLogin = useCallback(async () => {
    setGoogleLoading(true);
    try {
      const res = await fetch("/api/auth/google/login", { credentials: "include" });
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
      if (e.data?.type === "fb_login_success") { setFbLoading(false); onFbSuccess(); }
      else if (e.data?.type === "fb_login_error") { setFbLoading(false); toast.error(e.data.error || t("auth.fbLoginCancelled")); }
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

  const passwordsMatch = confirmPassword && password === confirmPassword;
  const passwordsMismatch = confirmPassword && password !== confirmPassword;
  const isLoading = registerMutation.isPending || fbLoading || googleLoading;

  const inputStyle = {
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.1)",
  };

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = "rgba(59,130,246,0.6)";
    e.target.style.boxShadow = "0 0 0 3px rgba(59,130,246,0.1)";
  };
  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.target.style.borderColor = "rgba(255,255,255,0.1)";
    e.target.style.boxShadow = "none";
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: "linear-gradient(135deg, #080a14 0%, #0d1428 50%, #080a14 100%)" }}
    >
      {/* Background grid */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage: `linear-gradient(rgba(59,130,246,0.2) 1px, transparent 1px),
            linear-gradient(90deg, rgba(59,130,246,0.2) 1px, transparent 1px)`,
          backgroundSize: "50px 50px",
        }}
      />
      {/* Glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 w-full max-w-sm">
        {/* Back to home */}
        <button
          onClick={() => setLocation("/")}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors mb-8"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t("auth.backToHome")}
        </button>

        {/* Logo */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <div
            className="h-12 w-12 rounded-2xl flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #2563eb, #4f46e5)" }}
          >
            <Zap className="h-6 w-6 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-white tracking-tight">{t("auth.createAccountTitle")}</h1>
            <p className="text-sm text-slate-400 mt-1">{t("auth.createAccountSubtitle")}</p>
          </div>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl p-6"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            backdropFilter: "blur(12px)",
          }}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Full Name */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300" htmlFor="name">
                {t("auth.fullName")}{" "}
                <span className="text-slate-600">{t("auth.optional")}</span>
              </label>
              <input
                id="name"
                type="text"
                placeholder={t("auth.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                disabled={isLoading}
                className="w-full px-3.5 py-2.5 rounded-xl text-sm text-white placeholder-slate-500 outline-none transition-all disabled:opacity-50"
                style={inputStyle}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            {/* Email */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300" htmlFor="email">
                {t("auth.email")} <span className="text-red-400">*</span>
              </label>
              <input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                disabled={isLoading}
                className="w-full px-3.5 py-2.5 rounded-xl text-sm text-white placeholder-slate-500 outline-none transition-all disabled:opacity-50"
                style={inputStyle}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            {/* Password */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300" htmlFor="password">
                {t("auth.password")} <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder={t("auth.passwordMin")}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={isLoading}
                  className="w-full px-3.5 py-2.5 pr-10 rounded-xl text-sm text-white placeholder-slate-500 outline-none transition-all disabled:opacity-50"
                  style={inputStyle}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Confirm Password */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300" htmlFor="confirmPassword">
                {t("auth.confirmPassword")} <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <input
                  id="confirmPassword"
                  type={showConfirm ? "text" : "password"}
                  placeholder={t("auth.confirmPasswordPlaceholder")}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={isLoading}
                  className="w-full px-3.5 py-2.5 pr-10 rounded-xl text-sm text-white placeholder-slate-500 outline-none transition-all disabled:opacity-50"
                  style={{
                    ...inputStyle,
                    borderColor: passwordsMismatch
                      ? "rgba(239,68,68,0.6)"
                      : passwordsMatch
                      ? "rgba(16,185,129,0.6)"
                      : "rgba(255,255,255,0.1)",
                  }}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                  tabIndex={-1}
                >
                  {passwordsMatch ? (
                    <CheckCircle className="h-4 w-4 text-emerald-400" />
                  ) : showConfirm ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
              {passwordsMismatch && (
                <p className="text-xs text-red-400">{t("auth.passwordsNoMatch")}</p>
              )}
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={isLoading || !!passwordsMismatch}
              className="w-full py-2.5 rounded-xl font-semibold text-white text-sm transition-all duration-200 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-2"
              style={{ background: "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)" }}
            >
              {registerMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {registerMutation.isPending ? t("auth.creatingAccount") : t("auth.createAccount")}
            </button>
          </form>

          {/* Divider */}
          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }} />
            </div>
            <div className="relative flex justify-center">
              <span className="px-3 text-xs text-slate-500" style={{ background: "rgba(13,20,40,0.95)" }}>
                {t("auth.or")}
              </span>
            </div>
          </div>

          {/* Facebook Login */}
          <button
            type="button"
            onClick={handleFacebookLogin}
            disabled={isLoading}
            className="w-full py-2.5 rounded-xl font-medium text-white text-sm transition-all duration-200 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2.5"
            style={{ background: "#1877F2" }}
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

          {/* Google Login */}
          <button
            type="button"
            onClick={handleGoogleLogin}
            disabled={isLoading}
            className="w-full py-2.5 rounded-xl font-medium text-sm transition-all duration-200 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2.5 mt-2.5"
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "#e2e8f0",
            }}
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

        <p className="text-center text-sm text-slate-500 mt-6">
          {t("auth.alreadyHaveAccount")}{" "}
          <button
            className="text-blue-400 hover:text-blue-300 transition-colors font-medium"
            onClick={() => setLocation("/login")}
          >
            {t("auth.signInLink")}
          </button>
        </p>
      </div>
    </div>
  );
}
