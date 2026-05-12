import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useT } from "@/hooks/useT";
import { useLocale, type Locale } from "@/contexts/LocaleContext";
import {
  Workflow,
  ArrowRight,
  ArrowDown,
  Check,
  CheckCircle2,
  XCircle,
  ChevronDown,
  Globe,
  ShieldCheck,
  Clock,
  Zap,
  Lock,
  Database,
  Send,
  RefreshCw,
  GitBranch,
  Webhook as WebhookIcon,
  Activity,
  Code2,
  Building2,
  Store,
  GraduationCap,
  Home,
  Sparkles,
} from "lucide-react";
import { Flag } from "@/components/ui/flag";

// ─── Animation primitives ────────────────────────────────────────────────────

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true); },
      { threshold }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [threshold]);
  return { ref, inView };
}

function FadeIn({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(24px)",
        transition: `opacity 0.55s ease ${delay}ms, transform 0.55s ease ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ─── Navbar ──────────────────────────────────────────────────────────────────

function LangSwitcher() {
  const { locale, setLocale } = useLocale();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const langs: { code: Locale; label: string }[] = [
    { code: "uz", label: "O‘zbekcha" },
    { code: "ru", label: "Русский" },
    { code: "en", label: "English" },
  ];

  return (
    <div ref={ref} className="relative">
      {/* Trigger — matches dashboard pill (flag SVG + locale code + chevron) */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 h-9 pl-2 pr-2.5 rounded-full border border-transparent hover:border-border hover:bg-slate-100/50 transition-colors"
      >
        <Flag code={locale} className="w-5 h-3.5" />
        <span className="text-[13px] font-medium uppercase tracking-wide">
          {locale === "uz" ? "UZ" : locale === "ru" ? "RU" : "EN"}
        </span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 p-1.5 rounded-2xl shadow-xl z-50 bg-popover border border-slate-200/70">
          {langs.map((l) => {
            const active = locale === l.code;
            return (
              <button
                key={l.code}
                onClick={() => { setLocale(l.code); setOpen(false); }}
                className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 my-0.5 transition-colors ${
                  active
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400"
                    : "hover:bg-slate-50 dark:hover:bg-muted/40"
                }`}
              >
                <Flag code={l.code} className="w-6 h-[18px]" />
                <span className={`text-sm flex-1 text-left ${active ? "font-semibold" : "font-medium"}`}>
                  {l.label}
                </span>
                {active && (
                  <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Navbar() {
  const [, setLocation] = useLocation();
  const t = useT();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handler);
    return () => window.removeEventListener("scroll", handler);
  }, []);

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-background/85 backdrop-blur-md border-b border-slate-200/70"
          : "bg-transparent border-b border-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <button
          onClick={() => setLocation("/")}
          className="flex items-center gap-2"
        >
          <div className="h-9 w-9 rounded-full bg-primary flex items-center justify-center shadow-sm">
            <Workflow className="h-4 w-4 text-primary-foreground" strokeWidth={2.5} />
          </div>
          <span className="font-bold text-lg tracking-tight">
            Targenix<span className="text-primary">.</span>
          </span>
        </button>
        <div className="flex items-center gap-1 sm:gap-2">
          <LangSwitcher />
          <button
            onClick={() => setLocation("/login")}
            className="hidden sm:inline-flex text-sm font-medium text-slate-700 hover:text-foreground transition-colors px-3 py-2 rounded-full hover:bg-slate-100"
          >
            {t("landing.signIn")}
          </button>
          <button
            onClick={() => setLocation("/register")}
            className="wapi-button-hover text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground px-4 h-10 rounded-full transition-colors inline-flex items-center gap-1.5"
          >
            {t("landing.getStarted")}
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </nav>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────────────

function Hero() {
  const [, setLocation] = useLocation();
  const t = useT();
  return (
    <section className="relative pt-32 pb-20 sm:pt-40 sm:pb-24 overflow-hidden bg-gradient-to-b from-emerald-50/60 via-white to-white dark:from-emerald-950/20 dark:via-background dark:to-background">
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.04] pointer-events-none"
        style={{
          backgroundImage:
            `linear-gradient(rgba(16,185,129,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(16,185,129,0.5) 1px, transparent 1px)`,
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse at top, black 30%, transparent 70%)",
        }}
      />
      <div aria-hidden className="absolute top-20 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-emerald-300/20 dark:bg-emerald-700/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-100 border border-emerald-200/70 dark:bg-emerald-950/40 dark:border-emerald-900/40 mb-7">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-[11px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
              {t("landing.heroEyebrow")}
            </span>
          </div>
        </FadeIn>

        <FadeIn delay={80} className="text-center">
          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05]">
            {t("landing.heroTitleA")}
            <br />
            <span className="text-primary">{t("landing.heroTitleB")}</span>
          </h1>
        </FadeIn>

        <FadeIn delay={160} className="text-center">
          <p className="text-base sm:text-lg lg:text-xl text-muted-foreground max-w-2xl mx-auto mt-6 leading-relaxed">
            {t("landing.heroSub1")}{" "}
            <strong className="text-foreground">{t("landing.heroSubStrong")}</strong>
          </p>
        </FadeIn>

        <FadeIn delay={240} className="text-center">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-9">
            <button
              onClick={() => setLocation("/register")}
              className="wapi-button-hover group flex items-center gap-2 px-6 h-12 rounded-full font-semibold text-primary-foreground bg-primary hover:bg-primary/90 text-base shadow-sm"
            >
              {t("landing.ctaStart")}
              <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
            <a
              href="#how-it-works"
              className="wapi-button-hover flex items-center gap-2 px-6 h-12 rounded-full font-semibold text-foreground bg-background border border-input hover:bg-muted/40 text-base"
            >
              {t("landing.ctaSeeHow")}
              <ArrowDown className="h-4 w-4" />
            </a>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            {t("landing.heroTrust")}
          </p>
        </FadeIn>

        <FadeIn delay={320} className="mt-16">
          <HeroFlow />
        </FadeIn>
      </div>
    </section>
  );
}

// ─── Hero visual: animated routing diagram ───────────────────────────────────

function HeroFlow() {
  const t = useT();
  return (
    <div className="relative max-w-4xl mx-auto">
      <div className="rounded-3xl bg-gradient-to-br from-white to-emerald-50/30 dark:from-card dark:to-emerald-950/15 border border-slate-200/70 dark:border-border shadow-xl shadow-emerald-100/30 dark:shadow-emerald-950/10 p-6 sm:p-10">
        <div className="flex flex-col lg:flex-row items-stretch gap-4 lg:gap-2">
          <FlowNode
            label={t("landing.flowSourceLabel")}
            badge={t("landing.flowSourceBadge")}
            color="from-blue-500 to-blue-700"
            badgeColor="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900/40 dark:text-blue-400"
            icon={
              <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
            }
            sub={t("landing.flowSourceSub")}
          />

          <FlowArrow />

          <FlowNode
            label={t("landing.flowTargenixLabel")}
            badge={t("landing.flowTargenixBadge")}
            color="from-emerald-400 to-emerald-600"
            badgeColor="bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900/40 dark:text-emerald-400"
            icon={<Workflow className="h-6 w-6 text-white" strokeWidth={2.5} />}
            sub={t("landing.flowTargenixSub")}
            isCenter
          />

          <FlowArrow />

          <div className="flex flex-col gap-2 flex-1">
            <DestRow icon={<Send className="h-3.5 w-3.5" />} label={t("landing.flowDestTelegram")} color="text-sky-600" />
            <DestRow icon={<Code2 className="h-3.5 w-3.5" />} label={t("landing.flowDestHttp")} color="text-violet-600" />
            <DestRow icon={<Building2 className="h-3.5 w-3.5" />} label={t("landing.flowDestCrm")} color="text-amber-600" />
            <DestRow icon={<Database className="h-3.5 w-3.5" />} label={t("landing.flowDestSheets")} color="text-emerald-600" />
          </div>
        </div>

        <div className="mt-6 pt-6 border-t border-slate-200/70 dark:border-border flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5 text-rose-500" />
            <span>{t("landing.flowRetry")}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            <span>{t("landing.flowEncryption")}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

function FlowNode({
  label, badge, color, badgeColor, icon, sub, isCenter,
}: {
  label: string;
  badge: string;
  color: string;
  badgeColor: string;
  icon: React.ReactNode;
  sub: string;
  isCenter?: boolean;
}) {
  return (
    <div className={`flex-1 flex flex-col items-center text-center ${isCenter ? "lg:scale-110" : ""}`}>
      <div className={`relative h-16 w-16 rounded-2xl bg-gradient-to-br ${color} flex items-center justify-center shadow-md ring-4 ring-white dark:ring-card`}>
        {icon}
        {isCenter && (
          <span className="absolute -top-1 -right-1 flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500 ring-2 ring-white dark:ring-card" />
          </span>
        )}
      </div>
      <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mt-3">{label}</p>
      <div className={`mt-1 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ${badgeColor}`}>
        {badge}
      </div>
      <p className="text-[11px] text-muted-foreground mt-1.5 font-medium">{sub}</p>
    </div>
  );
}

function FlowArrow() {
  return (
    <div className="hidden lg:flex items-center justify-center px-1">
      <ArrowRight className="h-5 w-5 text-emerald-400" strokeWidth={2.5} />
    </div>
  );
}

function DestRow({ icon, label, color }: { icon: React.ReactNode; label: string; color: string }) {
  return (
    <div className="flex items-center gap-2.5 bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-xl px-3 py-2 shadow-sm">
      <span className={`shrink-0 ${color}`}>{icon}</span>
      <span className="text-[12px] font-semibold truncate">{label}</span>
      <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-emerald-500 shrink-0" strokeWidth={2.5} />
    </div>
  );
}

// ─── The Problem ─────────────────────────────────────────────────────────────

function TheProblem() {
  const t = useT();
  return (
    <section className="py-20 sm:py-24 bg-white dark:bg-background">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-50 border border-rose-200 mb-4 dark:bg-rose-950/30 dark:border-rose-900/40">
            <span className="text-[10px] font-bold uppercase tracking-widest text-rose-600 dark:text-rose-400">
              {t("landing.problemEyebrow")}
            </span>
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            {t("landing.problemTitleA")} <span className="text-rose-500">{t("landing.problemTitleB")}</span>
          </h2>
          <p className="text-base sm:text-lg text-muted-foreground mt-4 max-w-2xl mx-auto leading-relaxed">
            {t("landing.problemSub")}
          </p>
        </FadeIn>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 max-w-3xl mx-auto">
          <FadeIn delay={80}>
            <div className="h-full rounded-2xl border-2 border-dashed border-rose-200/80 dark:border-rose-900/30 bg-rose-50/30 dark:bg-rose-950/10 p-6">
              <div className="flex items-center gap-2 mb-4">
                <div className="h-9 w-9 rounded-xl bg-rose-100 dark:bg-rose-950/40 flex items-center justify-center">
                  <XCircle className="h-4 w-4 text-rose-600 dark:text-rose-400" />
                </div>
                <h3 className="text-base font-bold text-rose-700 dark:text-rose-400 uppercase tracking-wider">{t("landing.problemWithoutTitle")}</h3>
              </div>
              <ul className="space-y-3 text-sm">
                <Bullet bad>{t("landing.problemWithout1")}</Bullet>
                <Bullet bad>{t("landing.problemWithout2")}</Bullet>
                <Bullet bad>{t("landing.problemWithout3")}</Bullet>
                <Bullet bad>{t("landing.problemWithout4")}</Bullet>
                <Bullet bad>{t("landing.problemWithout5")}</Bullet>
              </ul>
            </div>
          </FadeIn>

          <FadeIn delay={160}>
            <div className="h-full rounded-2xl border-2 border-emerald-200 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/20 dark:to-card p-6 shadow-sm shadow-emerald-100/30">
              <div className="flex items-center gap-2 mb-4">
                <div className="h-9 w-9 rounded-xl bg-emerald-100 dark:bg-emerald-950/40 flex items-center justify-center">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
                </div>
                <h3 className="text-base font-bold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">{t("landing.problemWithTitle")}</h3>
              </div>
              <ul className="space-y-3 text-sm">
                <BulletHtml good html={t("landing.problemWith1")} />
                <Bullet good>{t("landing.problemWith2")}</Bullet>
                <Bullet good>{t("landing.problemWith3")}</Bullet>
                <Bullet good>{t("landing.problemWith4")}</Bullet>
                <Bullet good>{t("landing.problemWith5")}</Bullet>
              </ul>
            </div>
          </FadeIn>
        </div>
      </div>
    </section>
  );
}

function Bullet({ children, bad, good }: { children: React.ReactNode; bad?: boolean; good?: boolean }) {
  return (
    <li className="flex items-start gap-2.5">
      {bad ? (
        <XCircle className="h-4 w-4 text-rose-500 shrink-0 mt-0.5" />
      ) : good ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" strokeWidth={2.5} />
      ) : null}
      <span className={bad ? "text-rose-900/90 dark:text-rose-200/90" : "text-foreground"}>{children}</span>
    </li>
  );
}

function BulletHtml({ html, good }: { html: string; good?: boolean }) {
  return (
    <li className="flex items-start gap-2.5">
      {good ? <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" strokeWidth={2.5} /> : null}
      <span className="text-foreground" dangerouslySetInnerHTML={{ __html: html }} />
    </li>
  );
}

// ─── How It Works — 5-stage algorithm ────────────────────────────────────────

function HowItWorks() {
  const t = useT();
  const stages = [
    { n: "01", icon: WebhookIcon, color: "bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400", title: t("landing.howStep1Title"), body: t("landing.howStep1Body"), tech: t("landing.howStep1Tech") },
    { n: "02", icon: ShieldCheck, color: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400", title: t("landing.howStep2Title"), body: t("landing.howStep2Body"), tech: t("landing.howStep2Tech") },
    { n: "03", icon: Database, color: "bg-violet-100 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400", title: t("landing.howStep3Title"), body: t("landing.howStep3Body"), tech: t("landing.howStep3Tech") },
    { n: "04", icon: GitBranch, color: "bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400", title: t("landing.howStep4Title"), body: t("landing.howStep4Body"), tech: t("landing.howStep4Tech") },
    { n: "05", icon: Send, color: "bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400", title: t("landing.howStep5Title"), body: t("landing.howStep5Body"), tech: t("landing.howStep5Tech") },
  ];

  return (
    <section id="how-it-works" className="py-20 sm:py-24 bg-slate-50/40 dark:bg-muted/15">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950/40 border border-emerald-200/60 dark:border-emerald-900/40 mb-4">
            <Activity className="h-3 w-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
            <span className="text-[10px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
              {t("landing.howEyebrow")}
            </span>
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            {t("landing.howTitleA")} <span className="text-primary">{t("landing.howTitleB")}</span>
          </h2>
          <p className="text-base sm:text-lg text-muted-foreground mt-4 max-w-2xl mx-auto leading-relaxed">
            {t("landing.howSub")}
          </p>
        </FadeIn>

        <div className="relative max-w-3xl mx-auto">
          <div aria-hidden className="absolute left-[28px] top-12 bottom-12 w-0.5 bg-gradient-to-b from-emerald-300 via-emerald-200 to-emerald-100 dark:from-emerald-800 dark:via-emerald-900/50 dark:to-transparent" />
          <ul className="space-y-5">
            {stages.map((s, i) => (
              <FadeIn key={s.n} delay={i * 80}>
                <li className="relative flex gap-5">
                  <div className="relative z-10 h-14 w-14 shrink-0 rounded-2xl bg-white dark:bg-card border border-slate-200/70 dark:border-border flex items-center justify-center shadow-sm">
                    <span className={`h-9 w-9 rounded-xl flex items-center justify-center ${s.color}`}>
                      <s.icon className="h-4 w-4" strokeWidth={2.2} />
                    </span>
                  </div>
                  <div className="flex-1 bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5 wapi-card-hover">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-[10px] font-bold tracking-widest text-emerald-600 dark:text-emerald-400">STEP {s.n}</span>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">{s.tech}</span>
                    </div>
                    <h3 className="text-lg font-bold tracking-tight">{s.title}</h3>
                    <p
                      className="text-sm text-muted-foreground mt-1 leading-relaxed"
                      dangerouslySetInnerHTML={{ __html: s.body }}
                    />
                  </div>
                </li>
              </FadeIn>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ─── Real code sample — webhook payload + delivery ───────────────────────────

function CodeSample() {
  const t = useT();
  return (
    <section className="py-20 sm:py-24 bg-white dark:bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-100 dark:bg-violet-950/40 border border-violet-200/60 dark:border-violet-900/40 mb-4">
            <Code2 className="h-3 w-3 text-violet-600 dark:text-violet-400" strokeWidth={2.5} />
            <span className="text-[10px] font-bold uppercase tracking-widest text-violet-700 dark:text-violet-400">
              {t("landing.codeEyebrow")}
            </span>
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            {t("landing.codeTitleA")} <span className="text-primary">{t("landing.codeTitleB")}</span>
          </h2>
          <p className="text-base sm:text-lg text-muted-foreground mt-4 max-w-2xl mx-auto leading-relaxed">
            {t("landing.codeSub")}
          </p>
        </FadeIn>

        <FadeIn delay={120}>
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-4 items-stretch max-w-5xl mx-auto">
            <CodeBlock
              title={t("landing.codeInTitle")}
              subtitle={t("landing.codeInSubtitle")}
              accent="text-blue-600 dark:text-blue-400"
              code={`{
  "object": "page",
  "entry": [{
    "id": "PAGE_ID",
    "time": 1747061234,
    "changes": [{
      "field": "leadgen",
      "value": {
        "leadgen_id": "1234567890",
        "page_id": "PAGE_ID",
        "form_id": "FORM_ID",
        "ad_id": "AD_ID",
        "adgroup_id": "ADSET_ID",
        "campaign_id": "CAMPAIGN_ID"
      }
    }]
  }]
}`}
            />

            <div className="hidden lg:flex items-center justify-center px-2">
              <div className="h-9 w-9 rounded-full bg-emerald-100 dark:bg-emerald-950/40 border border-emerald-200/60 flex items-center justify-center shadow-sm">
                <Workflow className="h-4 w-4 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
              </div>
            </div>

            <CodeBlock
              title={t("landing.codeOutTitle")}
              subtitle={t("landing.codeOutSubtitle")}
              accent="text-emerald-600 dark:text-emerald-400"
              code={`{
  "name": "Aziz Karimov",
  "phone": "+998901234567",
  "email": "aziz@example.com",
  "source": "Facebook Lead Ads",
  "page": "Marvarid.store",
  "form": "Spring Sale",
  "campaign_id": "CAMPAIGN_ID",
  "ad_id": "AD_ID",
  "lead_id": "1234567890",
  "received_at": "2026-05-13T15:42:11Z"
}`}
            />
          </div>
        </FadeIn>

        <FadeIn delay={200} className="mt-8">
          <div className="max-w-3xl mx-auto rounded-2xl border border-slate-200/70 dark:border-border bg-slate-50/40 dark:bg-muted/15 p-5">
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-2">{t("landing.codeVarLabel")}</p>
            <p className="text-sm leading-relaxed">
              <code className="text-xs font-mono bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded">{`{{name}}`}</code>{" "}
              <code className="text-xs font-mono bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded">{`{{phone}}`}</code>{" "}
              <code className="text-xs font-mono bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded">{`{{email}}`}</code>{" "}
              <code className="text-xs font-mono bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded">{`{{lead_id}}`}</code>{" "}
              <code className="text-xs font-mono bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 px-1.5 py-0.5 rounded">{`{{campaign_id}}`}</code>{" "}
              <span className="text-muted-foreground">{t("landing.codeVarBody")}</span>
            </p>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

function CodeBlock({ title, subtitle, accent, code }: { title: string; subtitle: string; accent: string; code: string }) {
  return (
    <div className="rounded-2xl border border-slate-200/70 dark:border-border bg-slate-50/40 dark:bg-card overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200/70 dark:border-border bg-white dark:bg-card/60">
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{title}</p>
        <p className={`text-[11px] font-mono mt-0.5 truncate ${accent}`}>{subtitle}</p>
      </div>
      <pre className="p-4 text-[11px] sm:text-xs leading-relaxed font-mono overflow-x-auto text-slate-800 dark:text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ─── Features grid ───────────────────────────────────────────────────────────

function Features() {
  const t = useT();
  const features = [
    { icon: Zap, color: "bg-orange-100 text-orange-600 dark:bg-orange-950/40 dark:text-orange-400", title: t("landing.feat1Title"), body: t("landing.feat1Body") },
    { icon: ShieldCheck, color: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400", title: t("landing.feat2Title"), body: t("landing.feat2Body") },
    { icon: Lock, color: "bg-violet-100 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400", title: t("landing.feat3Title"), body: t("landing.feat3Body") },
    { icon: RefreshCw, color: "bg-rose-100 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400", title: t("landing.feat4Title"), body: t("landing.feat4Body") },
    { icon: GitBranch, color: "bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400", title: t("landing.feat5Title"), body: t("landing.feat5Body") },
    { icon: Activity, color: "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400", title: t("landing.feat6Title"), body: t("landing.feat6Body") },
    { icon: Database, color: "bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-400", title: t("landing.feat7Title"), body: t("landing.feat7Body") },
    { icon: Send, color: "bg-cyan-100 text-cyan-600 dark:bg-cyan-950/40 dark:text-cyan-400", title: t("landing.feat8Title"), body: t("landing.feat8Body") },
    { icon: Sparkles, color: "bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-950/40 dark:text-fuchsia-400", title: t("landing.feat9Title"), body: t("landing.feat9Body") },
  ];

  return (
    <section className="py-20 sm:py-24 bg-slate-50/40 dark:bg-muted/15">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-orange-100 dark:bg-orange-950/40 border border-orange-200/60 dark:border-orange-900/40 mb-4">
            <Zap className="h-3 w-3 text-orange-600 dark:text-orange-400" strokeWidth={2.5} />
            <span className="text-[10px] font-bold uppercase tracking-widest text-orange-700 dark:text-orange-400">
              {t("landing.featuresEyebrow")}
            </span>
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            {t("landing.featuresTitleA")} <span className="text-primary">{t("landing.featuresTitleB")}</span>
          </h2>
          <p className="text-base sm:text-lg text-muted-foreground mt-4 max-w-2xl mx-auto leading-relaxed">
            {t("landing.featuresSub")}
          </p>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f, i) => (
            <FadeIn key={f.title} delay={i * 60}>
              <div className="wapi-card-hover h-full bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
                <div className={`h-11 w-11 rounded-xl flex items-center justify-center ${f.color} mb-4`}>
                  <f.icon className="h-5 w-5" strokeWidth={2.2} />
                </div>
                <h3 className="text-base font-bold tracking-tight">{f.title}</h3>
                <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">{f.body}</p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Use cases ───────────────────────────────────────────────────────────────

function UseCases() {
  const t = useT();
  const cases = [
    { icon: Store, color: "from-orange-400 to-orange-600", vertical: t("landing.case1Vertical"), flow: t("landing.case1Flow"), detail: t("landing.case1Detail") },
    { icon: Building2, color: "from-violet-400 to-violet-600", vertical: t("landing.case2Vertical"), flow: t("landing.case2Flow"), detail: t("landing.case2Detail") },
    { icon: Home, color: "from-sky-400 to-sky-600", vertical: t("landing.case3Vertical"), flow: t("landing.case3Flow"), detail: t("landing.case3Detail") },
    { icon: GraduationCap, color: "from-emerald-400 to-emerald-600", vertical: t("landing.case4Vertical"), flow: t("landing.case4Flow"), detail: t("landing.case4Detail") },
  ];

  return (
    <section className="py-20 sm:py-24 bg-white dark:bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-14">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sky-100 dark:bg-sky-950/40 border border-sky-200/60 dark:border-sky-900/40 mb-4">
            <Building2 className="h-3 w-3 text-sky-600 dark:text-sky-400" strokeWidth={2.5} />
            <span className="text-[10px] font-bold uppercase tracking-widest text-sky-700 dark:text-sky-400">
              {t("landing.casesEyebrow")}
            </span>
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            {t("landing.casesTitleA")} <span className="text-primary">{t("landing.casesTitleB")}</span>
          </h2>
        </FadeIn>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {cases.map((c, i) => (
            <FadeIn key={c.vertical} delay={i * 80}>
              <div className="wapi-card-hover h-full bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-6">
                <div className="flex items-start gap-4">
                  <div className={`h-12 w-12 shrink-0 rounded-2xl bg-gradient-to-br ${c.color} flex items-center justify-center shadow-sm`}>
                    <c.icon className="h-5 w-5 text-white" strokeWidth={2.2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">VERTICAL</p>
                    <h3 className="text-lg font-bold tracking-tight mt-0.5">{c.vertical}</h3>
                    <div className="inline-flex items-center gap-1.5 mt-2 px-2.5 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200/60 dark:border-emerald-900/40">
                      <Workflow className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                      <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">{c.flow}</span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-3 leading-relaxed">{c.detail}</p>
                  </div>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Trust / Security ────────────────────────────────────────────────────────

function TrustSection() {
  const t = useT();
  const items = [
    { icon: ShieldCheck, color: "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400", title: t("landing.sec1Title"), body: t("landing.sec1Body") },
    { icon: Lock, color: "bg-violet-100 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400", title: t("landing.sec2Title"), body: t("landing.sec2Body") },
    { icon: GitBranch, color: "bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400", title: t("landing.sec3Title"), body: t("landing.sec3Body") },
    { icon: Clock, color: "bg-amber-100 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400", title: t("landing.sec4Title"), body: t("landing.sec4Body") },
  ];

  return (
    <section className="py-20 sm:py-24 bg-slate-50/40 dark:bg-muted/15">
      <div className="max-w-5xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950/40 border border-emerald-200/60 dark:border-emerald-900/40 mb-4">
            <Lock className="h-3 w-3 text-emerald-600 dark:text-emerald-400" strokeWidth={2.5} />
            <span
              className="text-[10px] font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400"
              dangerouslySetInnerHTML={{ __html: t("landing.securityEyebrow") }}
            />
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight">
            {t("landing.securityTitleA")} <span className="text-primary">{t("landing.securityTitleB")}</span>
          </h2>
          <p className="text-base sm:text-lg text-muted-foreground mt-4 max-w-2xl mx-auto leading-relaxed">
            {t("landing.securitySub")}
          </p>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {items.map((it, i) => (
            <FadeIn key={it.title} delay={i * 80}>
              <div className="wapi-card-hover h-full bg-white dark:bg-card border border-slate-200/70 dark:border-border rounded-2xl p-5">
                <div className="flex items-start gap-4">
                  <div className={`h-11 w-11 rounded-xl flex items-center justify-center shrink-0 ${it.color}`}>
                    <it.icon className="h-5 w-5" strokeWidth={2.2} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-base font-bold tracking-tight">{it.title}</h3>
                    <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{it.body}</p>
                  </div>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Final CTA ───────────────────────────────────────────────────────────────

function FinalCTA() {
  const [, setLocation] = useLocation();
  const t = useT();
  return (
    <section className="py-20 sm:py-28 bg-background relative overflow-hidden">
      <div aria-hidden className="absolute inset-0 opacity-[0.04] pointer-events-none" style={{ backgroundImage: `linear-gradient(rgba(16,185,129,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(16,185,129,0.5) 1px, transparent 1px)`, backgroundSize: "56px 56px", maskImage: "radial-gradient(ellipse at center, black 30%, transparent 75%)" }} />
      <div aria-hidden className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[400px] bg-emerald-300/20 dark:bg-emerald-700/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative max-w-3xl mx-auto px-4 sm:px-6 text-center">
        <FadeIn>
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-tight">
            {t("landing.ctaTitleA")}
            <br />
            <span className="text-primary">{t("landing.ctaTitleB")}</span>
          </h2>
          <p className="text-base sm:text-lg text-muted-foreground mt-5 max-w-xl mx-auto leading-relaxed">
            {t("landing.ctaSub")}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-9">
            <button
              onClick={() => setLocation("/register")}
              className="wapi-button-hover group flex items-center gap-2 px-7 h-12 rounded-full font-semibold text-primary-foreground bg-primary hover:bg-primary/90 text-base shadow-sm"
            >
              {t("landing.ctaStart")}
              <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
            </button>
            <button
              onClick={() => setLocation("/login")}
              className="wapi-button-hover flex items-center gap-2 px-7 h-12 rounded-full font-semibold text-foreground bg-background border border-input hover:bg-muted/40 text-base"
            >
              {t("landing.ctaHaveAccount")}
            </button>
          </div>

          <div className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
              {t("landing.ctaTrustNoCard")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
              {t("landing.ctaTrustFast")}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
              {t("landing.ctaTrustCancel")}
            </span>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────────────

function Footer() {
  const [, setLocation] = useLocation();
  const t = useT();
  const { locale, setLocale } = useLocale();

  return (
    <footer className="py-10 border-t border-slate-200/70 dark:border-border bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center shadow-sm">
              <Workflow className="h-4 w-4 text-primary-foreground" strokeWidth={2.5} />
            </div>
            <span className="font-bold text-base">
              Targenix<span className="text-primary">.</span>
            </span>
          </div>

          <div className="flex items-center gap-5 text-xs font-medium text-muted-foreground">
            <button onClick={() => setLocation("/privacy")} className="hover:text-foreground transition-colors">
              {t("landing.footerPrivacy")}
            </button>
            <button onClick={() => setLocation("/terms")} className="hover:text-foreground transition-colors">
              {t("landing.footerTerms")}
            </button>
            <button onClick={() => setLocation("/data-deletion")} className="hover:text-foreground transition-colors">
              {t("landing.footerData")}
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 text-xs font-medium">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="appearance-none bg-transparent text-foreground/80 hover:text-foreground cursor-pointer pr-4 outline-none transition-colors"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 0 center" }}
              >
                <option value="uz">O‘zbekcha</option>
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
            </div>

            <p className="text-xs text-muted-foreground">
              {t("landing.footerCopyright")}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="bg-background">
      <Navbar />
      <Hero />
      <TheProblem />
      <HowItWorks />
      <CodeSample />
      <Features />
      <UseCases />
      <TrustSection />
      <FinalCTA />
      <Footer />
    </div>
  );
}
