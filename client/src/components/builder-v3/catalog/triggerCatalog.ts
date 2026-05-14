/**
 * triggerCatalog — what trigger apps/events the V3 builder offers.
 *
 * Phase 1 only Facebook Lead Ads has a real implementation, but we still
 * declare the full Albato-style picker shape (Apps column + Tools column)
 * so the layout matches and we can light up Schedule/Webhook/RSS in
 * follow-up phases without restructuring.
 *
 * Why a hand-curated map instead of feeding off `trpc.apps.list`?
 *   - The trigger side is structurally different from the action side.
 *     Most manifest apps are action-only (CRMs, sheets, messengers) and
 *     surfacing them as trigger choices would mislead users.
 *   - Facebook isn't a manifest app at all — it lives behind its own router
 *     (`facebookAccounts.list`, `listPages`, `listForms`). Albato's picker
 *     treats Facebook as a normal app; we mirror that here.
 */

export type TriggerBadge = "webhook" | "api" | "clock";

export interface TriggerEvent {
  id: string;
  label: string;
  description: string;
  badge: TriggerBadge;
  /** True once the event is actually wireable. False = "Coming soon". */
  available: boolean;
}

export interface TriggerApp {
  appKey: string;
  name: string;
  /**
   * Either a lucide icon name (resolved via `resolveAppIcon`) or an absolute
   * URL / asset path (`/icons/facebook.svg`). The AppIcon component handles
   * both transparently.
   */
  icon: string;
  events: TriggerEvent[];
  /** Phase 1: only Facebook is available. */
  available: boolean;
}

export interface TriggerTool {
  id: string;
  name: string;
  /** Lucide icon name (we don't ship URL icons for tools). */
  icon: string;
  description: string;
  /** Phase 1: all tools are stubs that show "Coming soon". */
  available: boolean;
}

// ─── Apps ────────────────────────────────────────────────────────────────────

export const TRIGGER_APPS: TriggerApp[] = [
  {
    appKey: "facebook",
    name: "Facebook",
    // Lucide doesn't ship Facebook out of the box — we render with a small
    // custom SVG via the F-in-circle component. Phase 1.2 uses a URL-style
    // icon to lean on AppIcon's <img> path; once we add a brand sprite,
    // swap this to "Facebook".
    icon: "https://logo.clearbit.com/facebook.com",
    available: true,
    events: [
      {
        id: "new_lead",
        label: "Lead Ads (webhook)",
        description:
          "When creating leads in Facebook page forms, data will be transmitted through the integration.",
        badge: "webhook",
        available: true,
      },
    ],
  },
];

// ─── Tools (right-hand column in the picker) ─────────────────────────────────
// Phase 1: visual stubs so the picker matches Albato's layout. Clicking
// one shows a "Coming soon" hint in step 2 rather than advancing.

export const TRIGGER_TOOLS: TriggerTool[] = [
  {
    id: "schedule",
    name: "Schedule",
    icon: "clock",
    description: "Run on a cron-like schedule.",
    available: false,
  },
  {
    id: "webhook",
    name: "Webhook",
    icon: "webhook",
    description: "Receive a raw HTTP webhook.",
    available: false,
  },
  {
    id: "rss",
    name: "RSS",
    icon: "rss",
    description: "Poll an RSS feed for new items.",
    available: false,
  },
];

export function findTriggerApp(appKey: string | null): TriggerApp | undefined {
  if (!appKey) return undefined;
  return TRIGGER_APPS.find((a) => a.appKey === appKey);
}

export function findTriggerEvent(
  appKey: string | null,
  eventId: string | null,
): TriggerEvent | undefined {
  const app = findTriggerApp(appKey);
  if (!app || !eventId) return undefined;
  return app.events.find((e) => e.id === eventId);
}
