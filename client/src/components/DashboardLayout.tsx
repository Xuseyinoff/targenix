import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/useMobile";
import { useLocale } from "@/contexts/LocaleContext";
import { useTheme } from "@/contexts/ThemeContext";
import { useT } from "@/hooks/useT";
import {
  Activity,
  BarChart3,
  Bell,
  ChevronDown,
  Facebook,
  Globe,
  LayoutDashboard,
  LogOut,
  MonitorCheck,
  Moon,
  PanelLeft,
  Plug,
  Search,
  SendHorizonal,
  Settings,
  Shield,
  Sun,
  Users,
  Webhook,
  Zap,
} from "lucide-react";

type NavItem = {
  icon: React.ElementType;
  label: string;
  path: string;
};

type NavGroup = {
  label?: string;
  items: NavItem[];
};
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";

function buildNavGroups(t: (k: string) => string): NavGroup[] {
  return [
    {
      items: [
        { icon: LayoutDashboard, label: t("nav.overview"), path: "/overview" },
        { icon: Zap, label: t("nav.leads"), path: "/leads" },
      ],
    },
    {
      label: t("nav.facebook"),
      items: [
        { icon: Facebook, label: t("nav.connections"), path: "/connections" },
        { icon: Plug, label: t("nav.integrations"), path: "/integrations" },
        { icon: Globe, label: t("nav.destinations"), path: "/destinations" },
      ],
    },
  ];
}

function buildAdminMenuItems(t: (k: string) => string) {
  return [
    { icon: Webhook, label: t("nav.webhookHealth"), path: "/webhook" },
    { icon: Shield, label: t("nav.adminLogs"), path: "/admin/logs" },
    { icon: Users, label: t("nav.adminLeads"), path: "/admin/leads" },
    { icon: SendHorizonal, label: t("nav.leadBackfill"), path: "/admin/backfill" },
    { icon: Globe, label: t("nav.destTemplates"), path: "/admin/destination-templates" },
  ];
}

function buildBusinessToolsItems(t: (k: string) => string) {
  return [
    {
      icon: Activity,
      label: t("nav.adAccounts"),
      path: "/business/ad-accounts",
      active: true,
      placeholder: false,
    },
    {
      icon: BarChart3,
      label: t("nav.leadAnalytics"),
      path: "/business/analytics",
      active: true,
      placeholder: false,
    },
    {
      icon: MonitorCheck,
      label: "Integrations Health",
      path: "/business/integrations",
      active: false,
      placeholder: true,
    },
  ];
}

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const BUSINESS_TOOLS_EXPAND_KEY = "targenix.sidebar.businessToolsExpanded";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

function readBusinessToolsExpanded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(BUSINESS_TOOLS_EXPAND_KEY);
    if (raw === null || raw === "") return true;
    return raw === "1" || raw === "true";
  } catch {
    return true;
  }
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />;
  }

  if (!user) {
    // Redirect to the dedicated login page
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login") && !window.location.pathname.startsWith("/register")) {
      window.location.replace("/login");
    }
    return null;
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const { toggleTheme, theme, switchable } = useTheme();
  const { locale, setLocale } = useLocale();
  const t = useT();
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const navGroups = useMemo(() => buildNavGroups(t), [locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const adminMenuItems = useMemo(() => buildAdminMenuItems(t), [locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const businessToolsItems = useMemo(() => buildBusinessToolsItems(t), [locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const allItems = navGroups.flatMap((g) => g.items);
  const activeMenuItem = allItems.find((item) => item.path === location);
  const activeGroupLabel = useMemo(() => {
    for (const g of navGroups) {
      if (g.items.some((it) => it.path === location)) return g.label ?? t("nav.overview");
    }
    return location.startsWith("/business/") ? t("nav.businessTools") : undefined;
  }, [location, navGroups]); // eslint-disable-line react-hooks/exhaustive-deps
  const isMobile = useIsMobile();
  const [navQuery, setNavQuery] = useState("");

  /** Sidebar only lists shipped tools; placeholders stay in data for routes/flags. */
  const visibleBusinessToolsItems = useMemo(
    () => businessToolsItems.filter((item) => !item.placeholder),
    [businessToolsItems]
  );

  const [businessToolsExpanded, setBusinessToolsExpanded] = useState(
    readBusinessToolsExpanded
  );

  const isBusinessToolsActive = businessToolsItems.some(
    (item) => location === item.path || location.startsWith("/business/")
  );

  const prevLocationRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevLocationRef.current;
    prevLocationRef.current = location;
    if (isCollapsed) return;
    if (!location.startsWith("/business/")) return;
    const enteredFromOutside =
      prev === null || !prev.startsWith("/business/");
    if (enteredFromOutside) {
      setBusinessToolsExpanded(true);
    }
  }, [location, isCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(
        BUSINESS_TOOLS_EXPAND_KEY,
        businessToolsExpanded ? "1" : "0"
      );
    } catch {
      /* quota / private mode */
    }
  }, [businessToolsExpanded]);

  useEffect(() => {
    if (isCollapsed) setIsResizing(false);
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => setIsResizing(false);
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  const filteredNavGroups = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return navGroups;
    return navGroups
      .map((g) => ({
        ...g,
        items: g.items.filter((it) => it.label.toLowerCase().includes(q)),
      }))
      .filter((g) => g.items.length > 0);
  }, [navQuery, navGroups]);

  const firstNavMatch = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return null;
    const all = navGroups.flatMap((g) => g.items);
    return all.find((it) => it.label.toLowerCase().includes(q)) ?? null;
  }, [navQuery, navGroups]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar collapsible="icon" className="border-r border-sidebar-border" disableTransition={isResizing}>
          <SidebarHeader className="h-16 justify-center border-b border-sidebar-border">
            <div className="flex items-center gap-3 px-2 w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-sidebar-accent rounded-lg transition-colors focus:outline-none shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-sidebar-foreground/60" />
              </button>
              {!isCollapsed && (
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-6 w-6 rounded bg-primary flex items-center justify-center shrink-0">
                    <Zap className="h-3.5 w-3.5 text-primary-foreground" />
                  </div>
                  <span className="font-semibold text-sm text-sidebar-foreground truncate">
                    Targenix.uz
                  </span>
                </div>
              )}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0 pt-2 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            {!isCollapsed && (
              <div className="px-3 pb-2">
                <div className="relative">
                  <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                  <Input
                    value={navQuery}
                    onChange={(e) => setNavQuery(e.target.value)}
                    placeholder="Search..."
                    className="pl-9 bg-sidebar-accent/30 border-sidebar-border focus-visible:ring-0 focus-visible:ring-offset-0"
                  />
                </div>
              </div>
            )}
            {/* Main nav groups */}
            {filteredNavGroups.map((group, gi) => (
              <div key={gi}>
                {gi > 0 && !isCollapsed && (
                  <div className="mx-3 my-1 border-t border-sidebar-border/50" />
                )}
                {group.label && !isCollapsed && (
                  <div className="px-4 pt-2 pb-0.5">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                      {group.label}
                    </span>
                  </div>
                )}
                <SidebarMenu className="px-2 py-0.5">
                  {group.items.map((item) => {
                    const isActive = location === item.path;
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => setLocation(item.path)}
                          tooltip={item.label}
                          className="h-9 transition-all font-normal text-sidebar-foreground/80 hover:text-sidebar-foreground"
                        >
                          <item.icon className={`h-4 w-4 ${isActive ? "text-sidebar-primary" : ""}`} />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </div>
            ))}

            {/* Business Tools — admin-only until productized for all users */}
            {user?.role === "admin" && (
              <>
                {!isCollapsed && (
                  <div className="mx-3 my-1 border-t border-sidebar-border/50" />
                )}
                <div className="px-2 mt-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (!isCollapsed) setBusinessToolsExpanded((v) => !v);
                    }}
                    className={`
                  w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left
                  transition-colors hover:bg-sidebar-accent/60
                  ${isBusinessToolsActive ? "text-sidebar-foreground" : "text-sidebar-foreground/70"}
                  ${isCollapsed ? "justify-center" : ""}
                `}
                    title="Analytics and ad tools"
                    aria-expanded={!isCollapsed ? businessToolsExpanded : undefined}
                  >
                    <BarChart3
                      className={`h-4 w-4 shrink-0 ${isBusinessToolsActive ? "text-sidebar-primary" : "text-sidebar-foreground/60"}`}
                    />
                    {!isCollapsed && (
                      <>
                        <span className="flex-1 text-xs font-semibold uppercase tracking-widest text-sidebar-foreground/50 select-none">
                          {t("nav.businessTools")}
                        </span>
                        <ChevronDown
                          className={`h-3.5 w-3.5 text-sidebar-foreground/40 transition-transform duration-200 ${businessToolsExpanded ? "rotate-0" : "-rotate-90"}`}
                        />
                      </>
                    )}
                  </button>

                  {!isCollapsed && (
                    <div
                      className="overflow-hidden transition-all duration-200 ease-in-out"
                      style={{
                        maxHeight: businessToolsExpanded
                          ? `${visibleBusinessToolsItems.length * 44}px`
                          : "0px",
                        opacity: businessToolsExpanded ? 1 : 0,
                      }}
                    >
                      <SidebarMenu className="pl-3 pr-0 py-0.5">
                        {visibleBusinessToolsItems.map((item) => {
                          const isActive =
                            location === item.path || location.startsWith(item.path);
                          return (
                            <SidebarMenuItem key={item.path}>
                              <SidebarMenuButton
                                isActive={isActive}
                                onClick={() => setLocation(item.path)}
                                tooltip={item.label}
                                className="text-sidebar-foreground/80 hover:text-sidebar-foreground h-8 text-sm font-normal transition-all"
                              >
                                <item.icon
                                  className={`h-3.5 w-3.5 ${isActive ? "text-sidebar-primary" : ""}`}
                                />
                                <span>{item.label}</span>
                              </SidebarMenuButton>
                            </SidebarMenuItem>
                          );
                        })}
                      </SidebarMenu>
                    </div>
                  )}

                  {isCollapsed && (
                    <SidebarMenu className="px-0 py-0.5">
                      {visibleBusinessToolsItems.map((item) => {
                        const isActive = location === item.path;
                        return (
                          <SidebarMenuItem key={item.path}>
                            <SidebarMenuButton
                              isActive={isActive}
                              onClick={() => setLocation(item.path)}
                              tooltip={item.label}
                              className="h-8"
                            >
                              <item.icon
                                className={`h-3.5 w-3.5 ${isActive ? "text-sidebar-primary" : ""}`}
                              />
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  )}
                </div>
              </>
            )}

            {/* Admin section — only visible to admins */}
            {user?.role === "admin" && (
              <>
                {!isCollapsed && <div className="mx-3 my-1 border-t border-sidebar-border/50" />}
                <div className="px-3 py-1.5 mt-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                    {t("nav.admin")}
                  </span>
                </div>
                <SidebarMenu className="px-2 py-1">
                  {adminMenuItems.map((item) => {
                    const isActive = location === item.path;
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => setLocation(item.path)}
                          tooltip={item.label}
                          className="h-9 transition-all font-normal text-sidebar-foreground/80 hover:text-sidebar-foreground"
                        >
                          <item.icon
                            className={`h-4 w-4 ${isActive ? "text-sidebar-primary" : "text-violet-500"}`}
                          />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </>
            )}
          </SidebarContent>

          <SidebarFooter className="p-3 border-t border-sidebar-border">
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-sidebar-accent/50 transition-colors flex-1 min-w-0 text-left focus:outline-none">
                    <Avatar className="h-8 w-8 border border-sidebar-border shrink-0">
                      <AvatarFallback className="text-xs font-medium bg-primary/20 text-sidebar-foreground">
                        {user?.name?.charAt(0).toUpperCase() ?? "U"}
                      </AvatarFallback>
                    </Avatar>
                    {!isCollapsed && (
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate leading-none text-sidebar-foreground">
                          {user?.name || "User"}
                        </p>
                        <p className="text-xs text-sidebar-foreground/50 truncate mt-1">
                          {user?.email || ""}
                        </p>
                      </div>
                    )}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    onClick={logout}
                    className="cursor-pointer text-destructive focus:text-destructive"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    <span>{t("nav.signOut")}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {!isCollapsed && (
                <button
                  onClick={() => setLocation("/settings")}
                  className={`h-8 w-8 flex items-center justify-center rounded-lg transition-colors shrink-0 focus:outline-none
                    ${location === "/settings"
                      ? "bg-sidebar-accent text-sidebar-primary"
                      : "text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                    }`}
                  title="Settings"
                >
                  <Settings className="h-4 w-4" />
                </button>
              )}
            </div>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => { if (!isCollapsed) setIsResizing(true); }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        <div className="flex border-b h-14 items-center justify-between bg-background/85 px-4 backdrop-blur sticky top-0 z-40">
          <div className="flex items-center gap-3 min-w-0">
            {isMobile ? (
              <SidebarTrigger className="h-9 w-9 rounded-lg" />
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-lg"
                onClick={toggleSidebar}
                aria-label="Toggle sidebar"
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                {activeGroupLabel && (
                  <span className="text-xs text-muted-foreground hidden sm:inline">
                    {activeGroupLabel}
                  </span>
                )}
                {activeGroupLabel && (
                  <span className="text-muted-foreground/60 hidden sm:inline">/</span>
                )}
                <span className="font-medium text-sm truncate">
                  {activeMenuItem?.label ?? "Dashboard"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!isMobile && (
              <div className="hidden md:block w-[360px] lg:w-[440px]">
                <div className="relative">
                  <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
                  <Input
                    value={navQuery}
                    onChange={(e) => setNavQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      if (!firstNavMatch) return;
                      setLocation(firstNavMatch.path);
                    }}
                    placeholder={t("nav.search")}
                    className="pl-9 bg-background/60"
                  />
                </div>
              </div>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-9 px-2">
                  {locale === "uz" ? "🇺🇿 UZ" : locale === "ru" ? "🇷🇺 RU" : "🇬🇧 EN"}
                  <ChevronDown className="ml-1 h-4 w-4 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => setLocale("uz")} className="cursor-pointer">
                  🇺🇿 O’zbekcha
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLocale("ru")} className="cursor-pointer">
                  🇷🇺 Русский
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLocale("en")} className="cursor-pointer">
                  🇬🇧 English
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {switchable && (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-lg"
                onClick={() => toggleTheme?.()}
                aria-label="Toggle theme"
              >
                {theme === "dark" ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-lg"
              aria-label="Notifications"
              title="Notifications"
            >
              <span className="relative">
                <Bell className="h-4 w-4" />
                <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
              </span>
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-9 px-2 gap-2 rounded-lg">
                  <Avatar className="h-7 w-7 border border-border">
                    <AvatarFallback className="text-[10px] font-semibold">
                      {user?.name?.charAt(0).toUpperCase() ?? "U"}
                    </AvatarFallback>
                  </Avatar>
                  <span className="hidden sm:inline text-sm max-w-[140px] truncate">
                    {user?.name || "User"}
                  </span>
                  <ChevronDown className="h-4 w-4 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => setLocation("/settings")} className="cursor-pointer">
                  <Settings className="mr-2 h-4 w-4" />
                  {t("nav.settings")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  {t("nav.signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
    </>
  );
}
