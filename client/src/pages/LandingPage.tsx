import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useT } from "@/hooks/useT";
import { useLocale, type Locale } from "@/contexts/LocaleContext";
import {
  Zap,
  ArrowRight,
  CheckCircle,
  Link2,
  BarChart3,
  RefreshCw,
  Bell,
  Shield,
  Clock,
  Globe,
  Workflow,
  Webhook,
  Users,
  Layers,
  Database,
} from "lucide-react";

// ─── Scroll animation hook ────────────────────────────────────────────────────
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

// ─── Animated section wrapper ─────────────────────────────────────────────────
function FadeIn({ children, delay = 0, className = "" }: { children: React.ReactNode; delay?: number; className?: string }) {
  const { ref, inView } = useInView();
  return (
    <div
      ref={ref}
      className={className}
      style={{
        opacity: inView ? 1 : 0,
        transform: inView ? "translateY(0)" : "translateY(32px)",
        transition: `opacity 0.65s ease ${delay}ms, transform 0.65s ease ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ─── Navbar ───────────────────────────────────────────────────────────────────
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

  const langs: { code: Locale; label: string; flag: string }[] = [
    { code: "uz", label: "O'zbekcha", flag: "🇺🇿" },
    { code: "ru", label: "Русский", flag: "🇷🇺" },
    { code: "en", label: "English", flag: "🇬🇧" },
  ];

  const current = langs.find((l) => l.code === locale) ?? langs[0];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-sm text-slate-300 hover:text-white transition-colors px-2 py-1.5 rounded-lg hover:bg-white/5"
      >
        <Globe className="h-4 w-4" />
        <span className="hidden sm:inline">{current.flag}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-2 rounded-xl overflow-hidden shadow-xl z-50 min-w-[160px]"
          style={{ background: "rgba(15, 18, 35, 0.97)", border: "1px solid rgba(255,255,255,0.08)", backdropFilter: "blur(20px)" }}
        >
          {langs.map((l) => (
            <button
              key={l.code}
              onClick={() => { setLocale(l.code); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                locale === l.code
                  ? "text-blue-400 bg-blue-500/10"
                  : "text-slate-300 hover:text-white hover:bg-white/5"
              }`}
            >
              <span>{l.flag}</span>
              <span>{l.label}</span>
            </button>
          ))}
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
      className="fixed top-0 left-0 right-0 z-50 transition-all duration-300"
      style={{
        background: scrolled ? "rgba(8, 10, 20, 0.92)" : "transparent",
        backdropFilter: scrolled ? "blur(16px)" : "none",
        borderBottom: scrolled ? "1px solid rgba(255,255,255,0.06)" : "none",
      }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-blue-500 flex items-center justify-center">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <span className="font-bold text-white text-lg tracking-tight">Targenix.uz</span>
        </div>
        <div className="flex items-center gap-3">
          <LangSwitcher />
          <button
            onClick={() => setLocation("/login")}
            className="text-sm text-slate-300 hover:text-white transition-colors px-3 py-1.5"
          >
            {t("landing.signIn")}
          </button>
          <button
            onClick={() => setLocation("/register")}
            className="text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors"
          >
            {t("landing.getStarted")}
          </button>
        </div>
      </div>
    </nav>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────
function Hero() {
  const [, setLocation] = useLocation();
  const t = useT();
  return (
    <section
      className="relative min-h-screen flex items-center justify-center overflow-hidden"
      style={{
        background: "linear-gradient(135deg, #080a14 0%, #0d1428 40%, #0a1a3a 70%, #080a14 100%)",
      }}
    >
      {/* Grid overlay */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage: `linear-gradient(rgba(59,130,246,0.15) 1px, transparent 1px),
            linear-gradient(90deg, rgba(59,130,246,0.15) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }}
      />
      {/* Glow blobs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-blue-600/20 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/3 right-1/4 w-80 h-80 bg-indigo-600/15 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 text-center pt-24 pb-16">
        {/* Badge */}
        <div
          className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-semibold mb-8"
          style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.3)", color: "#93c5fd" }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
          {t("landing.badge")}
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold text-white leading-tight tracking-tight mb-6">
          {t("landing.heroTitle1")}{" "}
          <span
            className="relative"
            style={{
              background: "linear-gradient(135deg, #3b82f6 0%, #818cf8 50%, #a78bfa 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            {t("landing.heroTitle2")}
          </span>
          {" "}{t("landing.heroTitle3")}
        </h1>

        {/* Subheadline */}
        <p className="text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          {t("landing.heroSubtitle")}
        </p>

        {/* CTA buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <button
            onClick={() => setLocation("/register")}
            className="group flex items-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-white text-base transition-all duration-200 hover:scale-105 hover:shadow-lg hover:shadow-blue-500/25"
            style={{ background: "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)" }}
          >
            {t("landing.getStarted")}
            <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
          </button>
          <button
            onClick={() => setLocation("/login")}
            className="flex items-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-slate-300 text-base border border-slate-700 hover:border-slate-500 hover:text-white transition-all duration-200"
            style={{ background: "rgba(255,255,255,0.04)" }}
          >
            {t("landing.signIn")}
          </button>
        </div>

        {/* Trust micro-copy */}
        <p className="mt-6 text-xs text-slate-500">
          {t("landing.trustMicro")}
        </p>

        {/* Value props row (trust-friendly) */}
        <div className="mt-14 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto">
          {[
            {
              icon: Webhook,
              title: t("landing.valueProp1Title"),
              desc: t("landing.valueProp1Desc"),
              color: "#3b82f6",
            },
            {
              icon: Shield,
              title: t("landing.valueProp2Title"),
              desc: t("landing.valueProp2Desc"),
              color: "#10b981",
            },
            {
              icon: Clock,
              title: t("landing.valueProp3Title"),
              desc: t("landing.valueProp3Desc"),
              color: "#f59e0b",
            },
          ].map((it) => (
            <div
              key={it.title}
              className="rounded-2xl px-5 py-4 text-left"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
            >
              <div className="flex items-start gap-3">
                <div
                  className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: `${it.color}15`, border: `1px solid ${it.color}25` }}
                >
                  <it.icon className="h-5 w-5" style={{ color: it.color }} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-white">{it.title}</p>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">{it.desc}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom fade */}
      <div
        className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none"
        style={{ background: "linear-gradient(to bottom, transparent, #080a14)" }}
      />
    </section>
  );
}

// ─── How It Works ─────────────────────────────────────────────────────────────
function HowItWorks() {
  const t = useT();
  const steps = [
    {
      number: "01",
      icon: Link2,
      title: t("landing.step1Title"),
      description: t("landing.step1Desc"),
      color: "#3b82f6",
    },
    {
      number: "02",
      icon: BarChart3,
      title: t("landing.step2Title"),
      description: t("landing.step2Desc"),
      color: "#8b5cf6",
    },
    {
      number: "03",
      icon: Zap,
      title: t("landing.step3Title"),
      description: t("landing.step3Desc"),
      color: "#06b6d4",
    },
  ];

  return (
    <section
      className="py-24 relative"
      style={{ background: "#080a14" }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-16">
          <div
            className="inline-block text-xs font-semibold px-3 py-1 rounded-full mb-4"
            style={{ background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.3)", color: "#c4b5fd" }}
          >
            {t("landing.howBadge")}
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            {t("landing.howTitle")}
          </h2>
          <p className="text-slate-400 max-w-xl mx-auto">
            {t("landing.howSubtitle")}
          </p>
        </FadeIn>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative">
          {/* Connector line (desktop) */}
          <div
            className="hidden md:block absolute top-10 left-1/3 right-1/3 h-px"
            style={{ background: "linear-gradient(90deg, transparent, rgba(59,130,246,0.3), transparent)" }}
          />

          {steps.map((step, i) => (
            <FadeIn key={step.number} delay={i * 120}>
              <div
                className="relative p-8 rounded-2xl"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <div
                  className="text-5xl font-black mb-4 select-none"
                  style={{ color: `${step.color}18`, lineHeight: 1 }}
                >
                  {step.number}
                </div>
                <div
                  className="h-11 w-11 rounded-xl flex items-center justify-center mb-5"
                  style={{ background: `${step.color}18`, border: `1px solid ${step.color}30` }}
                >
                  <step.icon className="h-5 w-5" style={{ color: step.color }} />
                </div>
                <h3 className="text-xl font-bold text-white mb-3">{step.title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{step.description}</p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── What you get today (truth-first) ─────────────────────────────────────────
function AvailableToday() {
  const t = useT();
  const items = [
    {
      icon: Webhook,
      title: t("landing.feat1Title"),
      description: t("landing.feat1Desc"),
      color: "#3b82f6",
    },
    {
      icon: Workflow,
      title: t("landing.feat2Title"),
      description: t("landing.feat2Desc"),
      color: "#8b5cf6",
    },
    {
      icon: Bell,
      title: t("landing.feat3Title"),
      description: t("landing.feat3Desc"),
      color: "#229ED9",
    },
    {
      icon: BarChart3,
      title: t("landing.feat4Title"),
      description: t("landing.feat4Desc"),
      color: "#06b6d4",
    },
    {
      icon: RefreshCw,
      title: t("landing.feat5Title"),
      description: t("landing.feat5Desc"),
      color: "#f43f5e",
    },
    {
      icon: Shield,
      title: t("landing.feat6Title"),
      description: t("landing.feat6Desc"),
      color: "#10b981",
    },
  ];

  return (
    <section className="py-24" style={{ background: "#080a14" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-14">
          <div
            className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1 rounded-full mb-4"
            style={{ background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", color: "#6ee7b7" }}
          >
            <CheckCircle className="h-3.5 w-3.5" />
            {t("landing.availableBadge")}
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            {t("landing.availableTitle")}
          </h2>
          <p className="text-slate-400 max-w-2xl mx-auto">
            {t("landing.availableSubtitle")}
          </p>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {items.map((it, i) => (
            <FadeIn key={it.title} delay={i * 70}>
              <div
                className="p-6 rounded-2xl"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
              >
                <div
                  className="h-10 w-10 rounded-xl flex items-center justify-center mb-4"
                  style={{ background: `${it.color}15`, border: `1px solid ${it.color}25` }}
                >
                  <it.icon className="h-5 w-5" style={{ color: it.color }} />
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{it.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{it.description}</p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Roadmap / {t("landing.roadmapBadge")} (confidence without overclaim) ────────────────────
function Roadmap() {
  const t = useT();
  const upcoming = [
    {
      icon: Database,
      title: t("landing.road1Title"),
      description: t("landing.road1Desc"),
    },
    {
      icon: Users,
      title: t("landing.road2Title"),
      description: t("landing.road2Desc"),
    },
    {
      icon: Layers,
      title: t("landing.road3Title"),
      description: t("landing.road3Desc"),
    },
    {
      icon: Bell,
      title: t("landing.road4Title"),
      description: t("landing.road4Desc"),
    },
  ];

  return (
    <section className="py-24" style={{ background: "linear-gradient(180deg, #080a14 0%, #0a0d1a 100%)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-14">
          <div
            className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-1 rounded-full mb-4"
            style={{ background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.3)", color: "#c4b5fd" }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Coming soon
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            {t("landing.roadmapTitle")}
          </h2>
          <p className="text-slate-400 max-w-2xl mx-auto">
            {t("landing.roadmapSubtitle")}
          </p>
        </FadeIn>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {upcoming.map((it, i) => (
            <FadeIn key={it.title} delay={i * 80}>
              <div
                className="p-6 rounded-2xl flex items-start gap-4"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}
              >
                <div
                  className="h-11 w-11 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: "rgba(139,92,246,0.14)", border: "1px solid rgba(139,92,246,0.25)" }}
                >
                  <it.icon className="h-5 w-5" style={{ color: "#a78bfa" }} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-white">{it.title}</p>
                    <span
                      className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                      style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", color: "#cbd5e1" }}
                    >
                      {t("landing.planned")}
                    </span>
                  </div>
                  <p className="text-sm text-slate-400 mt-1 leading-relaxed">{it.description}</p>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Features ─────────────────────────────────────────────────────────────────
function Features() {
  const t = useT();
  const features = [
    {
      icon: Zap,
      title: t("landing.featA1Title"),
      description: t("landing.featA1Desc"),
      color: "#f59e0b",
    },
    {
      icon: Bell,
      title: t("landing.featA2Title"),
      description: t("landing.featA2Desc"),
      color: "#3b82f6",
    },
    {
      icon: Link2,
      title: t("landing.featA3Title"),
      description: t("landing.featA3Desc"),
      color: "#8b5cf6",
    },
    {
      icon: Shield,
      title: t("landing.featA4Title"),
      description: t("landing.featA4Desc"),
      color: "#10b981",
    },
    {
      icon: BarChart3,
      title: t("landing.featA5Title"),
      description: t("landing.featA5Desc"),
      color: "#06b6d4",
    },
    {
      icon: RefreshCw,
      title: t("landing.featA6Title"),
      description: t("landing.featA6Desc"),
      color: "#f43f5e",
    },
  ];

  return (
    <section
      className="py-24"
      style={{ background: "linear-gradient(180deg, #080a14 0%, #0a0d1a 100%)" }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-16">
          <div
            className="inline-block text-xs font-semibold px-3 py-1 rounded-full mb-4"
            style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.3)", color: "#93c5fd" }}
          >
            Features
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            {t("landing.featuresTitle")}
          </h2>
          <p className="text-slate-400 max-w-xl mx-auto">
            {t("landing.featuresSubtitle")}
          </p>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feature, i) => (
            <FadeIn key={feature.title} delay={i * 80}>
              <div
                className="p-6 rounded-2xl group hover:scale-[1.02] transition-transform duration-200"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <div
                  className="h-10 w-10 rounded-xl flex items-center justify-center mb-4"
                  style={{ background: `${feature.color}15`, border: `1px solid ${feature.color}25` }}
                >
                  <feature.icon className="h-5 w-5" style={{ color: feature.color }} />
                </div>
                <h3 className="text-base font-semibold text-white mb-2">{feature.title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{feature.description}</p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Trust / Social Proof ─────────────────────────────────────────────────────
function TrustSection() {
  const [, setLocation] = useLocation();
  const t = useT();
  const items = [
    { icon: Shield, label: t("landing.trust1"), color: "#3b82f6" },
    { icon: CheckCircle, label: t("landing.trust2"), color: "#10b981" },
    { icon: Clock, label: t("landing.trust3"), color: "#f59e0b" },
  ];

  return (
    <section
      className="py-24 relative overflow-hidden"
      style={{ background: "#0a0d1a" }}
    >
      <div className="absolute inset-0 opacity-30">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-blue-600/10 rounded-full blur-3xl" />
      </div>
      <div className="relative max-w-4xl mx-auto px-4 sm:px-6">
        <FadeIn className="text-center mb-12">
          <div
            className="inline-block text-xs font-semibold px-3 py-1 rounded-full mb-4"
            style={{ background: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)", color: "#6ee7b7" }}
          >
            Trust & Security
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            {t("landing.trustTitle")}
          </h2>
        </FadeIn>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
          {items.map((item, i) => (
            <FadeIn key={item.label} delay={i * 100}>
              <div
                className="p-6 rounded-2xl text-center"
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <div
                  className="h-12 w-12 rounded-2xl flex items-center justify-center mx-auto mb-4"
                  style={{ background: `${item.color}15`, border: `1px solid ${item.color}25` }}
                >
                  <item.icon className="h-6 w-6" style={{ color: item.color }} />
                </div>
                <p className="text-sm text-slate-300 font-medium leading-snug">{item.label}</p>
              </div>
            </FadeIn>
          ))}
        </div>

        {/* CTA block */}
        <FadeIn>
          <div
            className="rounded-2xl p-10 text-center"
            style={{
              background: "linear-gradient(135deg, rgba(37,99,235,0.15) 0%, rgba(79,70,229,0.15) 100%)",
              border: "1px solid rgba(59,130,246,0.2)",
            }}
          >
            <h3 className="text-2xl sm:text-3xl font-bold text-white mb-3">
              {t("landing.ctaTitle")}
            </h3>
            <p className="text-slate-400 mb-8 max-w-md mx-auto">
              {t("landing.ctaSubtitle")}
            </p>
            <button
              onClick={() => setLocation("/register")}
              className="group inline-flex items-center gap-2 px-8 py-3.5 rounded-xl font-semibold text-white text-base transition-all duration-200 hover:scale-105 hover:shadow-lg hover:shadow-blue-500/25"
              style={{ background: "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)" }}
            >
              {t("landing.getStarted")}
              <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
            </button>
            <p className="mt-4 text-xs text-slate-500">{t("landing.ctaNoCard")}</p>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────
const LOCALE_LABELS: Record<Locale, string> = { uz: "O'zbekcha", en: "English", ru: "Русский" };

function Footer() {
  const [, setLocation] = useLocation();
  const t = useT();
  const { locale, setLocale } = useLocale();

  return (
    <footer
      className="py-10 border-t"
      style={{ background: "#080a14", borderColor: "rgba(255,255,255,0.06)" }}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-blue-500 flex items-center justify-center">
              <Zap className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="font-bold text-white text-sm">Targenix.uz</span>
          </div>

          <div className="flex items-center gap-6 text-xs text-slate-500">
            <button onClick={() => setLocation("/privacy")} className="hover:text-slate-300 transition-colors">
              {t("landing.footerPrivacy")}
            </button>
            <button onClick={() => setLocation("/terms")} className="hover:text-slate-300 transition-colors">
              {t("landing.footerTerms")}
            </button>
            <button onClick={() => setLocation("/data-deletion")} className="hover:text-slate-300 transition-colors">
              {t("landing.footerData")}
            </button>
          </div>

          <div className="flex items-center gap-4">
            {/* Language selector */}
            <div className="relative flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-slate-500" />
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="appearance-none bg-transparent text-xs text-slate-400 hover:text-slate-200 cursor-pointer pr-4 outline-none transition-colors"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 0 center" }}
              >
                {(Object.keys(LOCALE_LABELS) as Locale[]).map((l) => (
                  <option key={l} value={l} style={{ background: "#0a0d1a", color: "#cbd5e1" }}>
                    {LOCALE_LABELS[l]}
                  </option>
                ))}
              </select>
            </div>

            <p className="text-xs text-slate-600">
              {t("landing.footerCopyright")}
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────
export default function LandingPage() {
  return (
    <div style={{ background: "#080a14" }}>
      <Navbar />
      <Hero />
      <HowItWorks />
      <AvailableToday />
      <Roadmap />
      <Features />
      <TrustSection />
      <Footer />
    </div>
  );
}
