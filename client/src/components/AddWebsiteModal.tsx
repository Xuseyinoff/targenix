/**
 * Responsive shell for the Destinations / target website flow:
 * bottom sheet on mobile, centered dialog on desktop — with spec timing.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Dialog,
  DialogTitle,
  DialogDescription,
  useDialogComposition,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Briefcase,
  Building2,
  FileText,
  LayoutGrid,
  MessageSquare,
  Phone,
  Puzzle,
  Send,
  Table2,
  Webhook,
  X,
} from "lucide-react";

export type AddWebsiteFormMode =
  | "select-template"
  | "configure"
  | "configure-dynamic"
  | "edit-dynamic";

export type DestinationTemplateCategory =
  | "messaging"
  | "data"
  | "webhooks"
  | "affiliate"
  | "crm";

export interface DynTemplateListItem {
  id: number;
  name: string;
  description?: string | null;
  color: string;
  /** From API `getTemplates`; omit or legacy → treat as affiliate in filters */
  category?: DestinationTemplateCategory | string | null;
}

interface WebsiteFlowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: AddWebsiteFormMode;
  headerTitle: string;
  headerDescription?: string;
  /** Wider panel when editing / configuring full forms */
  wideDesktop?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

function WebsiteFlowDialogContent({
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  const { isComposing } = useDialogComposition();

  const handleEscapeKeyDown = React.useCallback(
    (e: KeyboardEvent) => {
      const isCurrentlyComposing =
        (e as unknown as { isComposing?: boolean }).isComposing || isComposing();
      if (isCurrentlyComposing) {
        e.preventDefault();
        return;
      }
      onEscapeKeyDown?.(e);
    },
    [isComposing, onEscapeKeyDown]
  );

  return (
    <DialogPrimitive.Content
      onEscapeKeyDown={handleEscapeKeyDown}
      {...props}
    />
  );
}

export function WebsiteFlowDialog({
  open,
  onOpenChange,
  mode,
  headerTitle,
  headerDescription,
  wideDesktop = false,
  footer,
  children,
}: WebsiteFlowDialogProps) {
  const isSelect = mode === "select-template";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black transition-opacity duration-[250ms] ease-out",
            "data-[state=open]:opacity-40 data-[state=closed]:opacity-0"
          )}
        />
        <WebsiteFlowDialogContent
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden border bg-background p-0 shadow-lg outline-none",
            // Mobile: bottom sheet
            "max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:max-h-[92vh] max-md:w-full max-md:rounded-t-[24px] max-md:border-x-0 max-md:border-b-0",
            "max-md:data-[state=open]:animate-in max-md:data-[state=closed]:animate-out",
            "max-md:data-[state=closed]:duration-300 max-md:data-[state=open]:duration-300",
            "max-md:ease-[cubic-bezier(0.32,0.72,0,1)]",
            "max-md:data-[state=open]:slide-in-from-bottom max-md:data-[state=closed]:slide-out-to-bottom",
            // Desktop: centered modal
            "md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-full md:rounded-lg md:border",
            "md:data-[state=open]:animate-in md:data-[state=closed]:animate-out",
            "md:data-[state=closed]:fade-out-0 md:data-[state=open]:fade-in-0",
            "md:data-[state=closed]:zoom-out-[0.97] md:data-[state=open]:zoom-in-[0.97]",
            "md:duration-[250ms] md:ease-in-out",
            wideDesktop ? "md:max-w-2xl" : "md:max-w-[480px]",
            "md:max-h-[85vh]"
          )}
        >
          {/* Drag handle (mobile) */}
          <div
            className="mx-auto mt-2.5 mb-1 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/25 md:hidden"
            aria-hidden
          />

          <div className="relative flex min-h-0 flex-1 flex-col">
            <DialogPrimitive.Close
              type="button"
              className="ring-offset-background focus-visible:ring-ring absolute top-3 right-3 z-10 rounded-md p-1.5 text-muted-foreground opacity-80 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden md:top-4 md:right-4 [&_svg]:pointer-events-none"
              aria-label="Close"
            >
              <X className="h-4 w-4" strokeWidth={2} />
            </DialogPrimitive.Close>

            <div
              className={cn(
                "shrink-0 border-b px-4 pt-3 pb-3 md:px-6 md:pt-4",
                isSelect ? "text-left" : "text-left"
              )}
            >
              <DialogTitle
                className={cn(
                  "pr-10 font-semibold leading-tight tracking-tight",
                  isSelect && "text-xl md:text-xl",
                  !isSelect && "text-base md:text-lg"
                )}
              >
                {headerTitle}
              </DialogTitle>
              <DialogDescription
                className={cn(
                  "mt-1.5 text-sm leading-relaxed",
                  headerDescription
                    ? "text-muted-foreground"
                    : "sr-only"
                )}
              >
                {headerDescription ?? headerTitle}
              </DialogDescription>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 md:px-6 md:py-4">
              {children}
            </div>

            {footer ? (
              <div className="shrink-0 border-t px-4 py-3 md:px-6">{footer}</div>
            ) : null}
          </div>
        </WebsiteFlowDialogContent>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}

export type AddSiteTab =
  | "messaging"
  | "data"
  | "webhooks"
  | "affiliate"
  | "crm";

/** Full labels on every breakpoint — emoji + name (scalable SaaS naming). */
const CATEGORY_TABS: { id: AddSiteTab; emoji: string; label: string }[] = [
  { id: "messaging", emoji: "📩", label: "Messaging" },
  { id: "data", emoji: "📊", label: "Data" },
  { id: "webhooks", emoji: "🌐", label: "Webhooks" },
  { id: "affiliate", emoji: "🤝", label: "Affiliate" },
  { id: "crm", emoji: "🧩", label: "CRM" },
];

function templateCategoryForFilter(t: DynTemplateListItem): DestinationTemplateCategory {
  const c = t.category;
  if (c === "messaging" || c === "data" || c === "webhooks" || c === "affiliate" || c === "crm") {
    return c;
  }
  return "affiliate";
}

interface AddWebsiteSelectStepProps<T extends DynTemplateListItem> {
  open: boolean;
  templates: T[];
  onSelectAffiliate: (tpl: T) => void;
  onSelectCustom: () => void;
  onSelectTelegram: () => void;
}

/** Shared icon container — fixed size for alignment across cards */
const CARD_ICON_WRAP =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground transition-colors duration-200 [&_svg]:h-5 [&_svg]:w-5";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground/80 mb-2 text-[10px] font-semibold uppercase tracking-[0.14em]">{children}</p>
  );
}

function ComingSoonBadge() {
  return (
    <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium">Coming soon</span>
  );
}

/** Primary CTA — button-like, not plain text */
function ConnectCta({ variant }: { variant: "primary" | "sky" }) {
  const isSky = variant === "sky";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold shadow-sm transition-all duration-200",
        isSky
          ? "bg-sky-600 text-white shadow-sky-500/25 group-hover:bg-sky-600/90 group-hover:shadow-sky-500/30 dark:bg-sky-500 dark:group-hover:bg-sky-500/90"
          : "bg-primary text-primary-foreground group-hover:bg-primary/90 group-hover:shadow-md"
      )}
    >
      Connect
      <ArrowRight className="h-3.5 w-3.5 opacity-95" aria-hidden />
    </span>
  );
}

function ComingSoonCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div
      role="note"
      aria-label={`${title} — coming soon`}
      className={cn(
        "flex w-full min-w-0 cursor-not-allowed select-none items-center gap-4 rounded-2xl border border-dashed border-muted/50 bg-muted/20 p-4 text-left backdrop-blur-[1px]",
        "opacity-55 saturate-[0.6]",
        "shadow-none transition-opacity duration-200"
      )}
    >
      <span className={cn(CARD_ICON_WRAP, "opacity-75")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold tracking-tight text-foreground/75">{title}</span>
          <ComingSoonBadge />
        </span>
        <span className="text-muted-foreground mt-1 block text-sm leading-relaxed">{description}</span>
      </span>
    </div>
  );
}

export function AddWebsiteSelectStep<T extends DynTemplateListItem>({
  open,
  templates,
  onSelectAffiliate,
  onSelectCustom,
  onSelectTelegram,
}: AddWebsiteSelectStepProps<T>) {
  const [tab, setTab] = React.useState<AddSiteTab>("affiliate");

  const affiliateTemplates = React.useMemo(
    () => templates.filter((t) => templateCategoryForFilter(t) === "affiliate"),
    [templates]
  );

  React.useEffect(() => {
    if (open) setTab("affiliate");
  }, [open]);

  return (
    <div className="space-y-6">
      {/* Category tabs — full labels; scroll on narrow viewports */}
      <div className="-mx-0.5 flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth pb-1 pt-0.5 [scrollbar-width:thin] md:mx-0 md:gap-2">
        {CATEGORY_TABS.map(({ id, emoji, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex min-h-[3.75rem] min-w-[5.25rem] shrink-0 snap-start cursor-pointer flex-col items-center justify-center rounded-2xl border px-2.5 py-2 text-center",
              "transition-all duration-200 ease-out md:min-w-0 md:flex-1 md:px-3",
              tab === id
                ? "border-primary/45 bg-primary/15 text-foreground shadow-lg shadow-primary/15 ring-2 ring-primary/25"
                : "border-border/70 bg-muted/15 text-muted-foreground hover:-translate-y-0.5 hover:scale-[1.02] hover:border-border hover:bg-muted/40 hover:text-foreground hover:shadow-md"
            )}
          >
            <span className="text-lg leading-none" aria-hidden>
              {emoji}
            </span>
            <span className="mt-1.5 max-w-[5.5rem] truncate text-[10px] font-semibold leading-tight text-inherit sm:max-w-[7rem] md:max-w-none md:text-[11px]">
              {label}
            </span>
          </button>
        ))}
      </div>

      {tab === "messaging" && (
        <div className="mx-auto mt-2 flex w-full max-w-lg flex-col gap-4 border-t border-border/35 pt-6">
          <SectionLabel>Messaging</SectionLabel>
          <button
            type="button"
            onClick={onSelectTelegram}
            className={cn(
              "group relative flex w-full min-w-0 cursor-pointer items-center gap-4 overflow-hidden rounded-2xl border p-4 text-left",
              "border-sky-400/55 bg-gradient-to-br from-sky-500/[0.14] via-background to-background",
              "shadow-md shadow-sky-500/20 ring-1 ring-sky-400/25",
              "transition-all duration-200 ease-out",
              "hover:scale-[1.01] hover:border-sky-400/80 hover:shadow-lg hover:shadow-sky-500/25",
              "active:scale-[0.995]"
            )}
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/20 text-sky-600 shadow-md shadow-sky-500/20 ring-1 ring-sky-400/35 dark:bg-sky-950/60 dark:text-sky-300">
              <Send className="h-5 w-5 shrink-0" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-semibold tracking-tight">Telegram</span>
              <span className="text-muted-foreground mt-1 block text-sm leading-relaxed">
                Deliver leads to your Telegram bot or group
              </span>
            </span>
            <ConnectCta variant="sky" />
          </button>
          <ComingSoonCard
            icon={<MessageSquare />}
            title="Discord"
            description="Send leads to a Discord channel"
          />
          <ComingSoonCard
            icon={<Phone />}
            title="WhatsApp"
            description="Business messaging integration"
          />
        </div>
      )}

      {tab === "data" && (
        <div className="mx-auto mt-2 flex w-full max-w-lg flex-col gap-4 border-t border-border/35 pt-6">
          <SectionLabel>Data &amp; spreadsheets</SectionLabel>
          <div
            role="note"
            aria-label="Google Sheets — coming soon"
            className={cn(
              "flex w-full min-w-0 cursor-not-allowed select-none items-start gap-4 rounded-2xl border border-dashed border-muted/50 bg-muted/15 p-4 text-left backdrop-blur-[1px]",
              "opacity-55 saturate-[0.6] transition-opacity duration-200"
            )}
          >
            <span className={cn(CARD_ICON_WRAP, "opacity-75")}>
              <Table2 className="shrink-0" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold tracking-tight text-foreground/75">Google Sheets</span>
                <ComingSoonBadge />
              </span>
              <span className="text-muted-foreground mt-1 block text-sm leading-relaxed">
                Connect Google account first. Routing will be available soon.
              </span>
            </span>
          </div>
          <ComingSoonCard
            icon={<LayoutGrid />}
            title="Airtable"
            description="Sync rows to an Airtable base"
          />
          <ComingSoonCard
            icon={<FileText />}
            title="Notion"
            description="Create pages or database entries from leads"
          />
        </div>
      )}

      {tab === "webhooks" && (
        <div className="mx-auto mt-2 flex w-full max-w-lg flex-col gap-4 border-t border-border/35 pt-6">
          <SectionLabel>Webhooks</SectionLabel>
          <button
            type="button"
            onClick={onSelectCustom}
            className={cn(
              "group relative flex w-full min-w-0 cursor-pointer items-center gap-4 overflow-hidden rounded-2xl border p-4 text-left",
              "border-primary/45 bg-gradient-to-br from-primary/[0.11] via-background to-background",
              "shadow-md shadow-primary/8 ring-1 ring-primary/18",
              "transition-all duration-200 ease-out",
              "hover:scale-[1.01] hover:border-primary/60 hover:shadow-lg hover:shadow-primary/12",
              "active:scale-[0.995]"
            )}
          >
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
              <Webhook className="h-5 w-5 shrink-0" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-lg font-semibold tracking-tight">Custom HTTP endpoint</span>
              <span className="text-muted-foreground mt-1 block text-sm leading-relaxed">
                POST or GET to any URL with JSON, form, or multipart body
              </span>
            </span>
            <ConnectCta variant="primary" />
          </button>
          <div
            className={cn(
              "flex gap-3 rounded-2xl border border-amber-300/70 bg-amber-50/90 p-4 transition-shadow duration-200 dark:border-amber-800/50 dark:bg-amber-950/40"
            )}
          >
            <span className="shrink-0 text-base leading-none opacity-90" aria-hidden>
              ⚠️
            </span>
            <p className="text-amber-950/95 dark:text-amber-100/90 text-sm leading-relaxed">
              Custom integration requires technical knowledge. You&apos;ll need the API endpoint, method, and body
              fields of your target system.
            </p>
          </div>
        </div>
      )}

      {tab === "affiliate" && (
        <div className="mx-auto mt-2 w-full max-w-lg border-t border-border/35 pt-6">
          <SectionLabel>Affiliate templates</SectionLabel>
          {affiliateTemplates.length === 0 ? (
            <div className="flex min-h-[10rem] flex-col items-center justify-center rounded-2xl border border-dashed border-muted/60 bg-muted/10 px-6 py-10 text-center">
              <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
                No affiliate templates available yet. Try Webhooks or contact your admin.
              </p>
            </div>
          ) : (
            <ul
              className={cn(
                "flex flex-col gap-3.5",
                affiliateTemplates.length <= 2 && "min-h-[12rem] justify-center py-2"
              )}
            >
              {affiliateTemplates.map((tpl) => (
                <li key={tpl.id} className="w-full min-w-0">
                  <button
                    type="button"
                    onClick={() => onSelectAffiliate(tpl)}
                    className={cn(
                      "group flex w-full min-w-0 cursor-pointer items-stretch gap-4 rounded-2xl border border-border/80 bg-background p-4 text-left",
                      "shadow-sm transition-all duration-200 ease-out",
                      "hover:scale-[1.01] hover:border-primary/35 hover:shadow-md hover:shadow-primary/8",
                      "active:scale-[0.995]"
                    )}
                  >
                    <span
                      className="w-1.5 shrink-0 self-stretch rounded-full opacity-95"
                      style={{ backgroundColor: tpl.color }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-lg font-semibold tracking-tight">{tpl.name}</span>
                      {tpl.description ? (
                        <span className="text-muted-foreground mt-1 line-clamp-2 block text-sm leading-relaxed">
                          {tpl.description}
                        </span>
                      ) : null}
                    </span>
                    <ConnectCta variant="primary" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === "crm" && (
        <div className="mx-auto mt-2 flex w-full max-w-lg flex-col gap-4 border-t border-border/35 pt-6">
          <SectionLabel>CRM</SectionLabel>
          <ComingSoonCard
            icon={<Briefcase />}
            title="Bitrix24"
            description="Create leads and deals in Bitrix24"
          />
          <ComingSoonCard
            icon={<Building2 />}
            title="AmoCRM"
            description="Pipeline and contact sync"
          />
          <ComingSoonCard
            icon={<Puzzle />}
            title="HubSpot"
            description="Contacts and marketing handoff"
          />
        </div>
      )}
    </div>
  );
}
