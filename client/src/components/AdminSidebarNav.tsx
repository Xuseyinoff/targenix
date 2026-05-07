import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import type { LucideIcon } from "lucide-react";
import { ChevronDown, ClipboardList, CircleUser, LayoutList, Shield, Users, SendHorizonal, Globe, Webhook, AlertTriangle } from "lucide-react";
import { useT } from "@/hooks/useT";

type NavLeaf = {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
};

type NavParent = {
  key: string;
  label: string;
  icon: LucideIcon;
  children: NavLeaf[];
};

type AdminNavItem = NavLeaf | NavParent;

const CRM_EXPAND_KEY = "targenix.sidebar.crmExpanded";

function isLeafActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(`${href}/`);
}

function hasActiveChild(pathname: string, parent: NavParent): boolean {
  return parent.children.some((c) => isLeafActive(pathname, c.href));
}

function readCrmExpanded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = localStorage.getItem(CRM_EXPAND_KEY);
    if (raw === null || raw === "") return true;
    return raw === "1" || raw === "true";
  } catch {
    return true;
  }
}

export function AdminSidebarNav() {
  const t = useT();
  const [location, setLocation] = useLocation();
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  const items = useMemo<AdminNavItem[]>(
    () => [
      {
        key: "crm",
        label: t("nav.adminCrm"),
        icon: ClipboardList,
        children: [
          { key: "crm-orders", label: t("nav.adminCrmOrders"), icon: LayoutList, href: "/admin/crm/orders" },
          { key: "crm-accounts", label: t("nav.adminCrmAccounts"), icon: CircleUser, href: "/admin/crm/accounts" },
        ],
      },
      { key: "webhook", label: t("nav.webhookHealth"), icon: Webhook, href: "/webhook" },
      { key: "admin-leads", label: t("nav.adminLeads"), icon: Users, href: "/admin/leads" },
      { key: "admin-logs", label: t("nav.adminLogs"), icon: Shield, href: "/admin/logs" },
      { key: "lead-backfill", label: t("nav.leadBackfill"), icon: SendHorizonal, href: "/admin/backfill" },
      { key: "dest-templates", label: t("nav.destTemplates"), icon: Globe, href: "/admin/destination-templates" },
      { key: "dlq", label: "DLQ", icon: AlertTriangle, href: "/admin/dlq" },
    ],
    [t],
  );

  const crm = items[0] as NavParent;
  const childActive = hasActiveChild(location, crm);

  const [crmExpanded, setCrmExpanded] = useState(readCrmExpanded);

  // Auto-expand when a child becomes active (parent is never "active")
  useEffect(() => {
    if (isCollapsed) return;
    if (childActive) setCrmExpanded(true);
  }, [childActive, isCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(CRM_EXPAND_KEY, crmExpanded ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [crmExpanded]);

  return (
    <SidebarMenu className="px-2 py-1">
      {/* CRM parent */}
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={false}
          onClick={() => {
            if (!isCollapsed) setCrmExpanded((v) => !v);
          }}
          tooltip={crm.label}
          type="button"
          aria-expanded={!isCollapsed ? crmExpanded : undefined}
          className={cn("h-10", isCollapsed ? "justify-center" : "")}
        >
          <crm.icon className={cn("text-violet-500", childActive ? "text-sidebar-primary" : "")} />
          {!isCollapsed && (
            <>
              <span className="flex-1 min-w-0 truncate whitespace-nowrap">{crm.label}</span>
              <ChevronDown
                className={cn(
                  "h-[18px] w-[18px] shrink-0 text-sidebar-foreground/40 transition-transform duration-200",
                  crmExpanded ? "rotate-0" : "-rotate-90",
                )}
              />
            </>
          )}
        </SidebarMenuButton>
      </SidebarMenuItem>

      {/* CRM children */}
      {!isCollapsed && (
        <div className={cn("grid transition-[grid-template-rows] duration-200 ease-in-out", crmExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
          <div className={cn("min-h-0 overflow-hidden transition-opacity duration-200 ease-in-out", crmExpanded ? "opacity-100" : "pointer-events-none opacity-0")}>
            <SidebarMenu className="pl-3 pr-0 py-0.5">
              {crm.children.map((c) => {
                const active = isLeafActive(location, c.href);
                return (
                  <SidebarMenuItem key={c.key}>
                    <SidebarMenuButton
                      isActive={active}
                      onClick={() => setLocation(c.href)}
                      tooltip={c.label}
                      className="h-10 text-sm font-normal text-sidebar-foreground/80 hover:text-sidebar-foreground"
                    >
                      <c.icon className={cn(active ? "text-sidebar-primary" : "text-violet-500/80")} />
                      <span className="min-w-0 truncate whitespace-nowrap">{c.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </div>
        </div>
      )}

      {/* Collapsed view: show CRM children as icons below */}
      {isCollapsed && (
        <SidebarMenu className="px-0 py-0.5">
          {crm.children.map((c) => {
            const active = isLeafActive(location, c.href);
            return (
              <SidebarMenuItem key={c.key}>
                <SidebarMenuButton isActive={active} onClick={() => setLocation(c.href)} tooltip={c.label} className="h-10">
                  <c.icon className={cn(active ? "text-sidebar-primary" : "text-violet-500")} />
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      )}

      {/* Other admin leaves */}
      {items.slice(1).map((it) => {
        const leaf = it as NavLeaf;
        const active = isLeafActive(location, leaf.href);
        return (
          <SidebarMenuItem key={leaf.key}>
            <SidebarMenuButton
              isActive={active}
              onClick={() => setLocation(leaf.href)}
              tooltip={leaf.label}
              className="h-10 font-normal text-sidebar-foreground/80 hover:text-sidebar-foreground"
            >
              <leaf.icon className={cn(active ? "text-sidebar-primary" : "text-violet-500")} />
              {!isCollapsed && <span className="min-w-0 truncate whitespace-nowrap">{leaf.label}</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

