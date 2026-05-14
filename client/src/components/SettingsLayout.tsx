import type { ReactNode } from "react";
import { useLocation } from "wouter";
import DashboardLayout from "@/components/DashboardLayout";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { User, Send } from "lucide-react";

/**
 * Shared chrome for every `/settings/*` page: a left sub-navigation rail
 * (modern SaaS pattern — Linear / Vercel / Stripe style) plus a content
 * column. Each settings page renders its sections as `children` and passes
 * its own `title` / `description` / optional header `actions`.
 *
 * Adding a new settings section = one entry in `RAIL_ITEMS` + a route.
 */

type RailItem = {
  key: string;
  path: string;
  icon: React.ElementType;
  labelKey: string;
};

const RAIL_ITEMS: RailItem[] = [
  { key: "profile", path: "/settings/profile", icon: User, labelKey: "settings.profile" },
  { key: "telegram", path: "/settings/telegram", icon: Send, labelKey: "settings.telegram" },
];

export default function SettingsLayout({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const [location, setLocation] = useLocation();
  const t = useT();

  return (
    <DashboardLayout>
      <div className="p-6 max-w-5xl mx-auto">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">{t("settings.title")}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t("settings.subtitle")}</p>
        </div>

        <div className="flex flex-col md:flex-row gap-6">
          {/* Left sub-nav rail */}
          <nav className="md:w-56 shrink-0">
            <div className="flex md:flex-col gap-1 md:sticky md:top-20">
              {RAIL_ITEMS.map((item) => {
                const isActive = location === item.path;
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setLocation(item.path)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors text-left w-full",
                      isActive
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <item.icon className={cn("h-4 w-4 shrink-0", isActive && "text-primary")} />
                    <span className="truncate">{t(item.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Content column */}
          <div className="flex-1 min-w-0 space-y-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
                {description && (
                  <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
                )}
              </div>
              {actions && <div className="shrink-0">{actions}</div>}
            </div>

            {children}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
