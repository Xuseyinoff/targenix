/**
 * facebookPageGuard
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-tenant safety helpers for Facebook page subscriptions.
 *
 * Background
 * ----------
 * Facebook's webhook subscription is *per page* at the app level, not per
 * Targenix user. Our `facebook_connections` table, however, allows the same
 * `pageId` to be connected independently by several Targenix tenants (see
 * migration 0035_fb_multi_account_per_page.sql). Consequently:
 *
 *   • POST /{page-id}/subscribed_apps  → idempotent; calling it N times is fine.
 *   • DELETE /{page-id}/subscribed_apps → removes the subscription for ALL
 *     tenants that share the page. A single user clicking "disconnect" can
 *     silently break every other tenant's lead flow.
 *
 * This helper quantifies how many *other* active tenants still rely on a
 * given pageId so callers can skip the destructive DELETE when it would
 * harm bystanders. It is intentionally thin and DB-only — no Facebook API
 * calls — so it can be reused from any router/mutation safely.
 */
import { and, count, eq, ne } from "drizzle-orm";
import type { DbClient } from "../db";
import { facebookConnections } from "../../drizzle/schema";

/**
 * Count OTHER Targenix users (userId !== excludeUserId) whose
 * facebook_connections row for `pageId` is still `isActive = true`.
 *
 * Returns 0 when no other tenant uses the page — in that case it is safe
 * to call Facebook's unsubscribe endpoint. A value > 0 means the page is
 * shared and the caller MUST NOT invoke the destructive FB API.
 */
export async function countOtherActiveTenantsOnPage(
  db: DbClient,
  pageId: string,
  excludeUserId: number,
): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(facebookConnections)
    .where(
      and(
        eq(facebookConnections.pageId, pageId),
        eq(facebookConnections.isActive, true),
        ne(facebookConnections.userId, excludeUserId),
      ),
    );
  return Number(row?.c ?? 0);
}

/**
 * Convenience boolean: `true` when at least one other tenant is active on
 * the page and therefore the Facebook unsubscribe call must be skipped.
 */
export async function isPageSharedWithOtherTenants(
  db: DbClient,
  pageId: string,
  excludeUserId: number,
): Promise<boolean> {
  const n = await countOtherActiveTenantsOnPage(db, pageId, excludeUserId);
  return n > 0;
}
