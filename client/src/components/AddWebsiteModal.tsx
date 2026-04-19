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
import { ChevronRight, Send, X } from "lucide-react";

export type AddWebsiteFormMode =
  | "select-template"
  | "configure"
  | "configure-dynamic"
  | "edit-dynamic";

export interface DynTemplateListItem {
  id: number;
  name: string;
  description?: string | null;
  color: string;
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
                  "pr-10 text-lg font-semibold leading-tight tracking-tight",
                  !isSelect && "text-base md:text-lg"
                )}
              >
                {headerTitle}
              </DialogTitle>
              <DialogDescription
                className={cn(
                  "mt-1 text-sm",
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

type AddSiteTab = "affiliate" | "custom" | "telegram";

interface AddWebsiteSelectStepProps<T extends DynTemplateListItem> {
  open: boolean;
  templates: T[];
  onSelectAffiliate: (tpl: T) => void;
  onSelectCustom: () => void;
  onSelectTelegram: () => void;
}

export function AddWebsiteSelectStep<T extends DynTemplateListItem>({
  open,
  templates,
  onSelectAffiliate,
  onSelectCustom,
  onSelectTelegram,
}: AddWebsiteSelectStepProps<T>) {
  const [tab, setTab] = React.useState<AddSiteTab>("affiliate");

  React.useEffect(() => {
    if (open) setTab("affiliate");
  }, [open]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => setTab("affiliate")}
          className={cn(
            "flex min-h-[4.5rem] w-full items-start gap-2 rounded-[14px] border p-2.5 text-left transition-all duration-200",
            tab === "affiliate"
              ? "border-primary bg-primary/10"
              : "border-border bg-background hover:border-muted-foreground/30"
          )}
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-sm dark:bg-orange-950/50"
            aria-hidden
          >
            ⚡
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold">Affiliate</span>
            <span className="text-muted-foreground mt-0.5 block text-[11px] leading-snug">
              Ready-made
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setTab("custom")}
          className={cn(
            "flex min-h-[4.5rem] w-full items-start gap-2 rounded-[14px] border p-2.5 text-left transition-all duration-200",
            tab === "custom"
              ? "border-primary bg-primary/10"
              : "border-border bg-background hover:border-muted-foreground/30"
          )}
        >
          <span
            className="bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm"
            aria-hidden
          >
            ⚙️
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold">Custom</span>
            <span className="text-muted-foreground mt-0.5 block text-[11px] leading-snug">
              Your own API
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setTab("telegram")}
          className={cn(
            "flex min-h-[4.5rem] w-full items-start gap-2 rounded-[14px] border p-2.5 text-left transition-all duration-200",
            tab === "telegram"
              ? "border-sky-400 bg-sky-500/10"
              : "border-border bg-background hover:border-muted-foreground/30"
          )}
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-950/50"
            aria-hidden
          >
            <Send className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold">Telegram</span>
            <span className="text-muted-foreground mt-0.5 block text-[11px] leading-snug">
              Bot delivery
            </span>
          </span>
        </button>
      </div>

      {tab === "affiliate" ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
            Affiliate platforms
          </p>
          {templates.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">
              No affiliate platforms available yet. Try Custom or contact your
              admin.
            </p>
          ) : (
            <ul className="space-y-2">
              {templates.map((tpl) => (
                <li key={tpl.id}>
                  <button
                    type="button"
                    onClick={() => onSelectAffiliate(tpl)}
                    className={cn(
                      "group flex w-full items-stretch gap-3 rounded-[14px] border border-border bg-background p-3 text-left transition-all duration-200",
                      "hover:border-primary hover:bg-primary/5",
                      "active:scale-[0.98]"
                    )}
                  >
                    <span
                      className="w-1.5 shrink-0 self-stretch rounded-full"
                      style={{ backgroundColor: tpl.color }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">
                        {tpl.name}
                      </span>
                      {tpl.description ? (
                        <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-xs leading-snug">
                          {tpl.description}
                        </span>
                      ) : null}
                    </span>
                    <ChevronRight className="text-muted-foreground group-hover:text-primary mt-0.5 h-4 w-4 shrink-0 transition-colors" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : tab === "telegram" ? (
        <div className="space-y-3">
          <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
            Telegram Bot destination
          </p>
          <button
            type="button"
            onClick={onSelectTelegram}
            className={cn(
              "group flex w-full items-center gap-3 rounded-[14px] border border-dashed border-sky-300 bg-background p-3 text-left transition-all duration-200",
              "hover:border-sky-400 hover:bg-sky-500/5",
              "active:scale-[0.98]"
            )}
          >
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-sky-100 text-sky-600 dark:bg-sky-950/50"
              aria-hidden
            >
              <Send className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">Telegram Bot</span>
              <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">
                O&apos;z Telegram botingizga leadlarni yuboring
              </span>
            </span>
            <ChevronRight className="text-muted-foreground group-hover:text-sky-500 h-4 w-4 shrink-0 transition-colors" />
          </button>
          <div className="flex gap-2.5 rounded-[14px] border border-sky-200/80 bg-sky-50 p-3 dark:border-sky-800/60 dark:bg-sky-950/20">
            <span className="shrink-0 text-base" aria-hidden>💡</span>
            <p className="text-sky-900 dark:text-sky-100/90 text-xs leading-relaxed">
              Telegram botingiz token va chat ID kerak bo&apos;ladi. Bot @BotFather orqali yaratiladi.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
            Custom integration
          </p>
          <button
            type="button"
            onClick={onSelectCustom}
            className={cn(
              "group flex w-full items-center gap-3 rounded-[14px] border border-dashed border-border bg-background p-3 text-left transition-all duration-200",
              "hover:border-primary hover:bg-primary/5",
              "active:scale-[0.98]"
            )}
          >
            <span
              className="bg-muted text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg"
              aria-hidden
            >
              ⚙️
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">Custom</span>
              <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">
                Istalgan sayt uchun universal POST API builder
              </span>
            </span>
            <ChevronRight className="text-muted-foreground group-hover:text-primary h-4 w-4 shrink-0 transition-colors" />
          </button>

          <div
            className={cn(
              "flex gap-2.5 rounded-[14px] border border-amber-300/80 bg-amber-50 p-3 dark:border-amber-700/60 dark:bg-amber-950/35"
            )}
          >
            <span className="shrink-0 text-base" aria-hidden>
              ⚠️
            </span>
            <p className="text-amber-950 dark:text-amber-100/90 text-xs leading-relaxed">
              Custom integration requires technical knowledge. You&apos;ll need
              to know the API endpoint, method, and body fields of your target
              website.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
