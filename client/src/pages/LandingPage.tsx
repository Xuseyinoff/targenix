import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Zap, ArrowRight, CheckCircle, Link2, BarChart3, RefreshCw, Bell, Shield, Clock } from "lucide-react";

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
function Navbar() {
  const [, setLocation] = useLocation();
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
          <button
            onClick={() => setLocation("/login")}
            className="text-sm text-slate-300 hover:text-white transition-colors px-3 py-1.5"
          >
            Sign In
          </button>
          <button
            onClick={() => setLocation("/register")}
            className="text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg transition-colors"
          >
            Get Started Free
          </button>
        </div>
      </div>
    </nav>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────────────
function Hero() {
  const [, setLocation] = useLocation();
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
          Facebook Lead Ads Automation Platform
        </div>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-extrabold text-white leading-tight tracking-tight mb-6">
          Turn Every Facebook Lead Into{" "}
          <span
            className="relative"
            style={{
              background: "linear-gradient(135deg, #3b82f6 0%, #818cf8 50%, #a78bfa 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
            }}
          >
            Revenue
          </span>
          {" "}— Automatically
        </h1>

        {/* Subheadline */}
        <p className="text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
          Connect your Facebook Lead Ads to any platform. Every lead captured, routed, and delivered in real time — without lifting a finger.
        </p>

        {/* CTA buttons */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <button
            onClick={() => setLocation("/register")}
            className="group flex items-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-white text-base transition-all duration-200 hover:scale-105 hover:shadow-lg hover:shadow-blue-500/25"
            style={{ background: "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)" }}
          >
            Get Started Free
            <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
          </button>
          <button
            onClick={() => setLocation("/login")}
            className="flex items-center gap-2 px-7 py-3.5 rounded-xl font-semibold text-slate-300 text-base border border-slate-700 hover:border-slate-500 hover:text-white transition-all duration-200"
            style={{ background: "rgba(255,255,255,0.04)" }}
          >
            Sign In
          </button>
        </div>

        {/* Trust micro-copy */}
        <p className="mt-6 text-xs text-slate-500">
          No credit card required · Free to start · Official Meta Webhooks API
        </p>

        {/* Stats row */}
        <div className="mt-14 grid grid-cols-3 gap-6 max-w-lg mx-auto">
          {[
            { value: "2,000+", label: "Leads processed" },
            { value: "< 1s", label: "Delivery time" },
            { value: "99.9%", label: "Uptime" },
          ].map(({ value, label }) => (
            <div key={label} className="text-center">
              <div className="text-2xl font-bold text-white">{value}</div>
              <div className="text-xs text-slate-500 mt-0.5">{label}</div>
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
  const steps = [
    {
      number: "01",
      icon: Link2,
      title: "Connect",
      description: "Link your Facebook account and pages in one click. We handle OAuth, tokens, and subscriptions automatically.",
      color: "#3b82f6",
    },
    {
      number: "02",
      icon: BarChart3,
      title: "Route",
      description: "Set up where your leads should go — any CRM, affiliate network, Telegram, or custom endpoint. Full control.",
      color: "#8b5cf6",
    },
    {
      number: "03",
      icon: Zap,
      title: "Automate",
      description: "Every new lead is instantly delivered. Real-time webhook processing, automatic retries, zero manual work.",
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
            How It Works
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Three steps to full automation
          </h2>
          <p className="text-slate-400 max-w-xl mx-auto">
            From zero to automated lead delivery in minutes. No code required.
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

// ─── Features ─────────────────────────────────────────────────────────────────
function Features() {
  const features = [
    {
      icon: Zap,
      title: "Real-time delivery",
      description: "Leads arrive and are sent within seconds via webhook. No polling, no delays — pure real-time.",
      color: "#f59e0b",
    },
    {
      icon: Bell,
      title: "Instant Telegram alerts",
      description: "Get notified the moment a lead comes in — directly to your Telegram with full lead details.",
      color: "#3b82f6",
    },
    {
      icon: Link2,
      title: "Any platform",
      description: "Send leads to any CRM, affiliate network, or custom endpoint. If it has an API, we can route to it.",
      color: "#8b5cf6",
    },
    {
      icon: Shield,
      title: "Secure by default",
      description: "Tokens encrypted with AES-256-CBC, X-Hub-Signature-256 verified on every request, data isolated per user.",
      color: "#10b981",
    },
    {
      icon: BarChart3,
      title: "Full visibility",
      description: "Track every lead, every order, every delivery in your dashboard. Real-time stats and detailed logs.",
      color: "#06b6d4",
    },
    {
      icon: RefreshCw,
      title: "Auto retry",
      description: "Failed deliveries are retried automatically up to 3 times. Nothing slips through the cracks.",
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
            Everything you need to automate lead flow
          </h2>
          <p className="text-slate-400 max-w-xl mx-auto">
            Built for marketers and agencies who need reliability, speed, and full control.
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
  const items = [
    { icon: Shield, label: "Built on official Meta Webhooks API", color: "#3b82f6" },
    { icon: CheckCircle, label: "X-Hub-Signature-256 verified on every request", color: "#10b981" },
    { icon: Clock, label: "Real-time processing — leads delivered in under 1 second", color: "#f59e0b" },
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
            Enterprise-grade security, built in
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
              Ready to automate your lead flow?
            </h3>
            <p className="text-slate-400 mb-8 max-w-md mx-auto">
              Join businesses already using Targenix to capture and deliver every Facebook lead automatically.
            </p>
            <button
              onClick={() => setLocation("/register")}
              className="group inline-flex items-center gap-2 px-8 py-3.5 rounded-xl font-semibold text-white text-base transition-all duration-200 hover:scale-105 hover:shadow-lg hover:shadow-blue-500/25"
              style={{ background: "linear-gradient(135deg, #2563eb 0%, #4f46e5 100%)" }}
            >
              Get Started Free
              <ArrowRight className="h-4 w-4 group-hover:translate-x-1 transition-transform" />
            </button>
            <p className="mt-4 text-xs text-slate-500">No credit card required</p>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────────────
function Footer() {
  const [, setLocation] = useLocation();
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
              Privacy Policy
            </button>
            <button onClick={() => setLocation("/terms")} className="hover:text-slate-300 transition-colors">
              Terms of Service
            </button>
            <button onClick={() => setLocation("/data-deletion")} className="hover:text-slate-300 transition-colors">
              Data Deletion
            </button>
          </div>

          <p className="text-xs text-slate-600">
            © 2026 Targenix.uz. All rights reserved.
          </p>
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
      <Features />
      <TrustSection />
      <Footer />
    </div>
  );
}
