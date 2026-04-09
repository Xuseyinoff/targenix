import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import {
  Activity,
  BarChart3,
  ChevronDown,
  Facebook,
  Globe,
  LayoutDashboard,
  LogOut,
  MonitorCheck,
  PanelLeft,
  Plug,
  ScrollText,
  SendHorizonal,
  Settings,
  Shield,
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
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";
import { toast } from "sonner";

const navGroups: NavGroup[] = [
  {
    items: [
      { icon: LayoutDashboard, label: "Overview", path: "/overview" },
      { icon: Zap, label: "Leads", path: "/leads" },
    ],
  },
  {
    label: "Facebook",
    items: [
      { icon: Facebook, label: "Connections", path: "/connections" },
      { icon: Plug, label: "Integrations", path: "/integrations" },
      { icon: Globe, label: "Destinations", path: "/destinations" },
    ],
  },
  {
    items: [
      { icon: ScrollText, label: "Activity", path: "/activity" },
    ],
  },
];

const adminMenuItems = [
  { icon: Webhook, label: "Webhook Health", path: "/webhook" },
  { icon: Shield, label: "Admin Logs", path: "/admin/logs" },
  { icon: SendHorizonal, label: "Lead Backfill", path: "/admin/backfill" },
];

// Business Tools sub-menu items
const businessToolsItems = [
  {
    icon: Activity,
    label: "Ad Accounts",
    path: "/business/ad-accounts",
    active: true,
  },
  {
    icon: BarChart3,
    label: "Lead Analytics",
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

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

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
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const allItems = navGroups.flatMap((g) => g.items);
  const activeMenuItem = allItems.find((item) => item.path === location);
  const isMobile = useIsMobile();

  // Business Tools expand/collapse state — default expanded
  const [businessToolsExpanded, setBusinessToolsExpanded] = useState(false);

  const isBusinessToolsActive = businessToolsItems.some(
    (item) => location === item.path || location.startsWith("/business/")
  );


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

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar collapsible="icon" className="border-r-0" disableTransition={isResizing}>
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
            {/* Main nav groups */}
            {navGroups.map((group, gi) => (
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

            {/* Business Tools section */}
            {!isCollapsed && <div className="mx-3 my-1 border-t border-sidebar-border/50" />}
            <div className="px-2 mt-1">
              {/* Section header — collapsible */}
              <button
                onClick={() => {
                  if (!isCollapsed) setBusinessToolsExpanded((v) => !v);
                }}
                className={`
                  w-full flex items-center gap-2 px-2 py-2 rounded-lg text-left
                  transition-colors hover:bg-sidebar-accent/60
                  ${isBusinessToolsActive ? "text-sidebar-foreground" : "text-sidebar-foreground/70"}
                  ${isCollapsed ? "justify-center" : ""}
                `}
                title="Business Tools"
              >
                {/* Icon — shown in both collapsed and expanded */}
                <BarChart3
                  className={`h-4 w-4 shrink-0 ${isBusinessToolsActive ? "text-sidebar-primary" : "text-sidebar-foreground/60"}`}
                />
                {!isCollapsed && (
                  <>
                    <span className="flex-1 text-xs font-semibold uppercase tracking-widest text-sidebar-foreground/50 select-none">
                      Business Tools
                    </span>
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-sidebar-foreground/40 transition-transform duration-200 ${businessToolsExpanded ? "rotate-0" : "-rotate-90"}`}
                    />
                  </>
                )}
              </button>

              {/* Sub-menu items — animated expand/collapse */}
              {!isCollapsed && (
                <div
                  className="overflow-hidden transition-all duration-200 ease-in-out"
                  style={{
                    maxHeight: businessToolsExpanded ? `${businessToolsItems.length * 44}px` : "0px",
                    opacity: businessToolsExpanded ? 1 : 0,
                  }}
                >
                  <SidebarMenu className="pl-3 pr-0 py-0.5">
                    {businessToolsItems.map((item) => {
                      const isActive = location === item.path || location.startsWith(item.path);
                      return (
                        <SidebarMenuItem key={item.path}>
                          <SidebarMenuButton
                            isActive={isActive}
                            onClick={() => {
                              if (item.placeholder) {
                                toast.info(`${item.label} — coming soon`);
                              } else {
                                setLocation(item.path);
                              }
                              setBusinessToolsExpanded(false);
                            }}
                            tooltip={item.label}
                            className={`
                              h-8 transition-all font-normal text-sm
                              ${item.placeholder
                                ? "text-sidebar-foreground/40 cursor-default hover:text-sidebar-foreground/50 hover:bg-sidebar-accent/30"
                                : "text-sidebar-foreground/80 hover:text-sidebar-foreground"
                              }
                            `}
                          >
                            <item.icon
                              className={`h-3.5 w-3.5 ${isActive ? "text-sidebar-primary" : item.placeholder ? "text-sidebar-foreground/30" : ""}`}
                            />
                            <span className="flex items-center gap-1.5">
                              {item.label}
                              {item.placeholder && (
                                <span className="text-[9px] font-medium uppercase tracking-wide text-sidebar-foreground/30 bg-sidebar-accent/50 px-1 py-0.5 rounded">
                                  soon
                                </span>
                              )}
                            </span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </div>
              )}

              {/* Collapsed state: show sub-items as icon-only with tooltips */}
              {isCollapsed && (
                <SidebarMenu className="px-0 py-0.5">
                  {businessToolsItems.map((item) => {
                    const isActive = location === item.path;
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => {
                            if (item.placeholder) {
                              toast.info(`${item.label} — coming soon`);
                            } else {
                              setLocation(item.path);
                            }
                          }}
                          tooltip={item.label}
                          className={`h-8 ${item.placeholder ? "opacity-40" : ""}`}
                        >
                          <item.icon className={`h-3.5 w-3.5 ${isActive ? "text-sidebar-primary" : ""}`} />
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              )}
            </div>

            {/* Admin section — only visible to admins */}
            {user?.role === "admin" && (
              <>
                {!isCollapsed && <div className="mx-3 my-1 border-t border-sidebar-border/50" />}
                <div className="px-3 py-1.5 mt-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                    Admin
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
                    <span>Sign out</span>
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
        {isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-4 backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-3">
              <SidebarTrigger className="h-9 w-9 rounded-lg" />
              <span className="font-medium text-sm">{activeMenuItem?.label ?? "Dashboard"}</span>
            </div>
          </div>
        )}
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
    </>
  );
}
