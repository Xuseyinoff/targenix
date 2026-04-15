/**
 * facebookAccountsRouter
 *
 * Handles Facebook Account connections (User-level tokens) and all
 * Graph API lookups needed for the multi-step integration wizard:
 *   connect account → list pages → list forms → list form fields → subscribe page
 *
 * connectAndSubscribeAll — single call that:
 *   1. Exchanges short-lived token for long-lived
 *   2. Saves the FB account
 *   3. Fetches ALL pages for that account
 *   4. Subscribes each page to the app (leadgen field)
 *   5. Saves each page as a facebookConnection
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  facebookAccounts,
  facebookConnections,
  facebookForms,
  integrations,
  adAccountsCache,
  campaignsCache,
  adSetsCache,
  campaignInsightsCache,
} from "../../drizzle/schema";
import { eq, desc, and, inArray, count } from "drizzle-orm";
import { logEvent } from "../services/appLogger";
import { encrypt, decrypt } from "../encryption";
import {
  exchangeForLongLivedToken,
  getFbUserProfile,
  listUserPages,
  getAllGrantedPages,
  getBusinessManagerPages,
  listPageLeadForms,
  getFormFields,
  subscribePageToApp,
  unsubscribePageFromApp,
} from "../services/facebookGraphService";
import { upsertFormsForPage } from "../services/facebookFormsService";

function getAppCredentials() {
  const appId = process.env.FACEBOOK_APP_ID ?? "";
  const appSecret = process.env.FACEBOOK_APP_SECRET ?? "";
  if (!appId || !appSecret) {
    throw new Error("FACEBOOK_APP_ID and FACEBOOK_APP_SECRET must be set");
  }
  return { appId, appSecret };
}

export const facebookAccountsRouter = router({
  // ── List connected accounts ────────────────────────────────────────────────
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({
        id: facebookAccounts.id,
        fbUserId: facebookAccounts.fbUserId,
        fbUserName: facebookAccounts.fbUserName,
        tokenExpiresAt: facebookAccounts.tokenExpiresAt,
        connectedAt: facebookAccounts.connectedAt,
        createdAt: facebookAccounts.createdAt,
      })
      .from(facebookAccounts)
      .where(eq(facebookAccounts.userId, userId))
      .orderBy(desc(facebookAccounts.createdAt));
    return rows;
  }),

  // ── List all connected pages (facebookConnections) ─────────────────────────
  listConnectedPages: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({
        id: facebookConnections.id,
        pageId: facebookConnections.pageId,
        pageName: facebookConnections.pageName,
        isActive: facebookConnections.isActive,
        subscriptionStatus: facebookConnections.subscriptionStatus,
        subscriptionError: facebookConnections.subscriptionError,
        createdAt: facebookConnections.createdAt,
      })
      .from(facebookConnections)
      .where(eq(facebookConnections.userId, userId))
      .orderBy(desc(facebookConnections.createdAt));
    return rows;
  }),

  // ── Get accounts with their pages grouped ──────────────────────────────────
  getAccountsWithPages: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    const db = await getDb();
    if (!db) return [];

    // Fetch all accounts for this user
    const accounts = await db
      .select({
        id: facebookAccounts.id,
        fbUserId: facebookAccounts.fbUserId,
        fbUserName: facebookAccounts.fbUserName,
        tokenExpiresAt: facebookAccounts.tokenExpiresAt,
        connectedAt: facebookAccounts.connectedAt,
        createdAt: facebookAccounts.createdAt,
      })
      .from(facebookAccounts)
      .where(eq(facebookAccounts.userId, userId))
      .orderBy(desc(facebookAccounts.createdAt));

    // Fetch all connections for this user
    const connections = await db
      .select({
        id: facebookConnections.id,
        facebookAccountId: facebookConnections.facebookAccountId,
        pageId: facebookConnections.pageId,
        pageName: facebookConnections.pageName,
        isActive: facebookConnections.isActive,
        subscriptionStatus: facebookConnections.subscriptionStatus,
        subscriptionError: facebookConnections.subscriptionError,
        createdAt: facebookConnections.createdAt,
      })
      .from(facebookConnections)
      .where(eq(facebookConnections.userId, userId))
      .orderBy(facebookConnections.pageName);

    // Group pages by account
    return accounts.map((account) => ({
      ...account,
      pages: connections.filter((c) => c.facebookAccountId === account.id),
    }));
  }),

  // ── Connect account + auto-subscribe ALL pages (SAFE UPDATE) ─────────────
  connectAndSubscribeAll: protectedProcedure
    .input(
      z.object({
        accessToken: z.string().min(10),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const { appId, appSecret } = getAppCredentials();

      // ── Step 1: Exchange for long-lived token ──────────────────────────────
      let longLivedToken = input.accessToken;
      let expiresAt: Date | null = null;
      try {
        const exchanged = await exchangeForLongLivedToken(input.accessToken, appId, appSecret);
        longLivedToken = exchanged.access_token;
        if (exchanged.expires_in) {
          expiresAt = new Date(Date.now() + exchanged.expires_in * 1000);
        }
      } catch {
        console.warn("[FB] Token exchange failed, using token as-is");
      }

      // ── Step 2: Fetch profile ──────────────────────────────────────────────
      const profile = await getFbUserProfile(longLivedToken);
      const encryptedUserToken = encrypt(longLivedToken);
      const now = new Date();

      // ── Step 3: Upsert facebookAccounts — UPDATE token + connectedAt if exists
      const existingAccount = await db
        .select({ id: facebookAccounts.id })
        .from(facebookAccounts)
        .where(and(eq(facebookAccounts.userId, userId), eq(facebookAccounts.fbUserId, profile.id)))
        .limit(1);

      let accountId: number;
      if (existingAccount.length > 0) {
        accountId = existingAccount[0].id;
        await db
          .update(facebookAccounts)
          .set({
            fbUserName: profile.name,
            accessToken: encryptedUserToken,
            tokenExpiresAt: expiresAt ?? undefined,
            connectedAt: now,
          })
          .where(and(eq(facebookAccounts.userId, userId), eq(facebookAccounts.fbUserId, profile.id)));
      } else {
        const [inserted] = await db.insert(facebookAccounts).values({
          userId,
          fbUserId: profile.id,
          fbUserName: profile.name,
          accessToken: encryptedUserToken,
          tokenExpiresAt: expiresAt ?? undefined,
          connectedAt: now,
        });
        accountId = (inserted as unknown as { insertId: number }).insertId;
      }      // ── Step 4: Fetch ALL granted pages (personal + Business Manager) ───────
      const pages = await getAllGrantedPages(longLivedToken, appId, appSecret);

      // Also fetch Business Manager pages (requires business_management scope)
      let bmPages: typeof pages = [];
      try {
        bmPages = await getBusinessManagerPages(longLivedToken, appId, appSecret);
      } catch (err) {
        console.warn("[FB] Business Manager pages fetch failed (non-critical):", String(err));
      }

      // Merge and deduplicate pages by ID
      const mergedPageMap = new Map(pages.map((p) => [p.id, p]));
      for (const p of bmPages) {
        if (!mergedPageMap.has(p.id)) mergedPageMap.set(p.id, p);
      }
      const allPages = Array.from(mergedPageMap.values());
      const returnedPageIds = new Set(allPages.map((p) => p.id));

      const results: Array<{
        pageId: string;
        pageName: string;
        subscribed: boolean;
        isNew: boolean;
        error?: string;
      }> = [];

      // ── Step 5: Deactivate pages no longer returned by Facebook ───────────
      const existingConns = await db
        .select({ id: facebookConnections.id, pageId: facebookConnections.pageId })
        .from(facebookConnections)
        .where(and(
          eq(facebookConnections.userId, userId),
          eq(facebookConnections.facebookAccountId, accountId),
        ));

      for (const conn of existingConns) {
        if (!returnedPageIds.has(conn.pageId)) {
          await db
            .update(facebookConnections)
            .set({ isActive: false, subscriptionStatus: "inactive" })
            .where(eq(facebookConnections.id, conn.id));
        }
      }

      // ── Step 6: Subscribe each returned page and upsert connection ─────────────────
      for (const page of allPages) {
        let subscribed = false;
        let subscriptionError: string | undefined;

        try {
          await subscribePageToApp(page.id, page.access_token);
          subscribed = true;
        } catch (err) {
          subscriptionError = err instanceof Error ? err.message : String(err);
        }

        const encryptedPageToken = encrypt(page.access_token);
        const existingConn = await db
          .select({ id: facebookConnections.id })
          .from(facebookConnections)
          .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.facebookAccountId, accountId), eq(facebookConnections.pageId, page.id)))
          .limit(1);

        const isNew = existingConn.length === 0;

        if (!isNew) {
          await db
            .update(facebookConnections)
            .set({
              accessToken: encryptedPageToken,
              pageName: page.name,
              isActive: true,
              facebookAccountId: accountId,
              subscriptionStatus: subscribed ? "active" : "failed",
              subscriptionError: subscriptionError ?? null,
            })
            .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.pageId, page.id)));
        } else {
          await db.insert(facebookConnections).values({
            userId,
            facebookAccountId: accountId,
            pageId: page.id,
            pageName: page.name,
            accessToken: encryptedPageToken,
            isActive: true,
            subscriptionStatus: subscribed ? "active" : "failed",
            subscriptionError: subscriptionError ?? undefined,
          });
        }

        results.push({ pageId: page.id, pageName: page.name, subscribed, isNew, error: subscriptionError });

        // ── Step 7: Re-fetch leadgen_forms (non-blocking) ─────────────────
        if (subscribed) {
          upsertFormsForPage({
            userId,
            pageId: page.id,
            pageName: page.name,
            pageAccessToken: page.access_token,
          }).catch((err) => console.warn(`[FB] Failed to fetch forms for page ${page.id}:`, err));
        }
      }

      const failedPages = results.filter((r) => !r.subscribed);

      return {
        success: true,
        fbUserId: profile.id,
        fbUserName: profile.name,
        accountId,
        connectedAt: now,
        pages: results,
        warnings: failedPages.length > 0
          ? failedPages.map((p) => `${p.pageName}: ${p.error}`)
          : [],
      };
    }),


  // ── Toggle page active/inactive ────────────────────────────────────────────
  togglePageActive: protectedProcedure
    .input(z.object({ connectionId: z.number(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [conn] = await db
        .select()
        .from(facebookConnections)
        .where(eq(facebookConnections.id, input.connectionId))
        .limit(1);
      if (!conn || conn.userId !== userId) throw new Error("Connection not found");

      await db
        .update(facebookConnections)
        .set({ isActive: input.isActive })
        .where(eq(facebookConnections.id, input.connectionId));

      return { success: true };
    }),

  // ── Delete a page connection ───────────────────────────────────────────────
  deletePageConnection: protectedProcedure
    .input(z.object({ connectionId: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const [conn] = await db
        .select()
        .from(facebookConnections)
        .where(eq(facebookConnections.id, input.connectionId))
        .limit(1);
      if (!conn || conn.userId !== userId) throw new Error("Connection not found");

      await db
        .delete(facebookConnections)
        .where(eq(facebookConnections.id, input.connectionId));

      return { success: true };
    }),

  // ── Connect a new Facebook account (legacy — single token) ────────────────
  connect: protectedProcedure
    .input(z.object({ accessToken: z.string().min(10) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      const { appId, appSecret } = getAppCredentials();
      let longLivedToken = input.accessToken;
      let expiresAt: Date | null = null;
      try {
        const exchanged = await exchangeForLongLivedToken(input.accessToken, appId, appSecret);
        longLivedToken = exchanged.access_token;
        if (exchanged.expires_in) {
          expiresAt = new Date(Date.now() + exchanged.expires_in * 1000);
        }
      } catch {
        console.warn("[FB] Token exchange failed, using token as-is");
      }
      const profile = await getFbUserProfile(longLivedToken);
      const existing = await db
        .select({ id: facebookAccounts.id })
        .from(facebookAccounts)
        .where(and(eq(facebookAccounts.userId, userId), eq(facebookAccounts.fbUserId, profile.id)))
        .limit(1);
      const encryptedToken = encrypt(longLivedToken);
      if (existing.length > 0) {
        await db
          .update(facebookAccounts)
          .set({ fbUserName: profile.name, accessToken: encryptedToken, tokenExpiresAt: expiresAt ?? undefined })
          .where(and(eq(facebookAccounts.userId, userId), eq(facebookAccounts.fbUserId, profile.id)));
      } else {
        await db.insert(facebookAccounts).values({
          userId,
          fbUserId: profile.id,
          fbUserName: profile.name,
          accessToken: encryptedToken,
          tokenExpiresAt: expiresAt ?? undefined,
        });
      }
      return { success: true, fbUserId: profile.id, fbUserName: profile.name };
    }),

  // ── Disconnect an account ─────────────────────────────────────────────────
  disconnect: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      }

      try {
        const { pagesDisconnected, integrationsDeleted, fbUserId, fbUserName } = await db.transaction(async (tx) => {
          const [acct] = await tx
            .select()
            .from(facebookAccounts)
            .where(and(eq(facebookAccounts.id, input.id), eq(facebookAccounts.userId, userId)))
            .limit(1);

          if (!acct) {
            throw new TRPCError({ code: "NOT_FOUND", message: "Facebook account not found" });
          }

          const [countRow] = await tx
            .select({ c: count() })
            .from(facebookConnections)
            .where(
              and(eq(facebookConnections.userId, userId), eq(facebookConnections.facebookAccountId, input.id))
            );
          const pagesDisconnected = Number(countRow?.c ?? 0);

          const connections = await tx
            .select({ pageId: facebookConnections.pageId })
            .from(facebookConnections)
            .where(
              and(eq(facebookConnections.userId, userId), eq(facebookConnections.facebookAccountId, input.id))
            );
          const pageIds = Array.from(new Set(connections.map((c) => c.pageId)));

          await tx
            .delete(campaignInsightsCache)
            .where(
              and(
                eq(campaignInsightsCache.userId, userId),
                eq(campaignInsightsCache.facebookAccountId, input.id)
              )
            );

          await tx
            .delete(adSetsCache)
            .where(and(eq(adSetsCache.userId, userId), eq(adSetsCache.facebookAccountId, input.id)));

          await tx
            .delete(campaignsCache)
            .where(and(eq(campaignsCache.userId, userId), eq(campaignsCache.facebookAccountId, input.id)));

          await tx
            .delete(adAccountsCache)
            .where(and(eq(adAccountsCache.userId, userId), eq(adAccountsCache.facebookAccountId, input.id)));

          await tx
            .delete(facebookConnections)
            .where(
              and(eq(facebookConnections.userId, userId), eq(facebookConnections.facebookAccountId, input.id))
            );

          if (pageIds.length > 0) {
            // Only delete forms for pages that are no longer connected at all.
            // Otherwise disconnecting one FB account can wipe the forms cache for a page
            // that is still accessible via another connected FB account.
            const stillConnected = await tx
              .select({ pageId: facebookConnections.pageId })
              .from(facebookConnections)
              .where(and(eq(facebookConnections.userId, userId), inArray(facebookConnections.pageId, pageIds)));
            const stillConnectedSet = new Set(stillConnected.map((r) => r.pageId));
            const deletePageIds = pageIds.filter((pid) => !stillConnectedSet.has(pid));
            if (deletePageIds.length > 0) {
              await tx
                .delete(facebookForms)
                .where(and(eq(facebookForms.userId, userId), inArray(facebookForms.pageId, deletePageIds)));
            }
          }

          // Delete all LEAD_ROUTING integrations tied to this FB account (indexed column).
          // Without this, orphaned integrations remain in the DB but fail token resolution silently.
          const [intCountRow] = await tx
            .select({ c: count() })
            .from(integrations)
            .where(and(eq(integrations.userId, userId), eq(integrations.facebookAccountId, input.id)));
          const integrationsDeleted = Number(intCountRow?.c ?? 0);

          await tx
            .delete(integrations)
            .where(and(eq(integrations.userId, userId), eq(integrations.facebookAccountId, input.id)));

          await tx
            .delete(facebookAccounts)
            .where(and(eq(facebookAccounts.id, input.id), eq(facebookAccounts.userId, userId)));

          return {
            pagesDisconnected,
            integrationsDeleted,
            fbUserId: acct.fbUserId,
            fbUserName: acct.fbUserName,
          };
        });

        await logEvent({
          level: "INFO",
          category: "FACEBOOK",
          eventType: "FACEBOOK_ACCOUNT_DISCONNECTED",
          source: "manual",
          message: `FACEBOOK_ACCOUNT_DISCONNECTED: facebookAccountId=${input.id}, pages=${pagesDisconnected}, integrations=${integrationsDeleted}`,
          userId,
          meta: {
            action: "FACEBOOK_ACCOUNT_DISCONNECTED",
            facebookAccountId: input.id,
            fbUserId,
            fbUserName,
            pagesDisconnected,
            integrationsDeleted,
          },
        });

        return { success: true as const, pagesDisconnected, integrationsDeleted };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        console.error("[facebookAccounts.disconnect]", err);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "Failed to disconnect Facebook account",
        });
      }
    }),

  // ── Count pages + integrations that would be removed on disconnect ───────────
  countAffectedOnDisconnect: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) return { pages: 0, integrations: 0 };

      const [[pageRow], [intRow]] = await Promise.all([
        db
          .select({ c: count() })
          .from(facebookConnections)
          .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.facebookAccountId, input.id))),
        db
          .select({ c: count() })
          .from(integrations)
          .where(and(eq(integrations.userId, userId), eq(integrations.facebookAccountId, input.id))),
      ]);

      return {
        pages: Number(pageRow?.c ?? 0),
        integrations: Number(intRow?.c ?? 0),
      };
    }),

  // ── List pages for an account ─────────────────────────────────────────────
  // Reads from facebookConnections (DB) so ALL subscribed pages appear,
  // not just the ones /me/accounts returns (limited by Facebook Opt-in).
  listPages: protectedProcedure
    .input(z.object({ accountId: z.number() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      // Verify the account belongs to this user
      const [acct] = await db
        .select()
        .from(facebookAccounts)
        .where(eq(facebookAccounts.id, input.accountId))
        .limit(1);
      if (!acct || acct.userId !== userId) throw new Error("Account not found");
      // Return only pages connected via THIS facebook account.
      // Without this filter, the same shared page appears under every connected FB account.
      const connections = await db
        .select({
          id: facebookConnections.id,
          pageId: facebookConnections.pageId,
          pageName: facebookConnections.pageName,
          isActive: facebookConnections.isActive,
        })
        .from(facebookConnections)
        .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.facebookAccountId, input.accountId)));
      return connections.map((c) => ({
        id: c.pageId,
        name: c.pageName,
        category: "",
        isActive: c.isActive,
      }));
    }),

  // ── List lead forms for a page ────────────────────────────────────────────
  listForms: protectedProcedure
    .input(z.object({ accountId: z.number(), pageId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      // Get page token from facebookConnections (not /me/accounts)
      const [conn] = await db
        .select()
        .from(facebookConnections)
        .where(and(eq(facebookConnections.pageId, input.pageId), eq(facebookConnections.userId, userId)))
        .limit(1);
      if (!conn) throw new Error("Page not found in your connections");
      const pageToken = decrypt(conn.accessToken);
      const forms = await listPageLeadForms(input.pageId, pageToken);
      return forms;
    }),

  // ── List fields for a form ────────────────────────────────────────────────
  listFormFields: protectedProcedure
    .input(z.object({ accountId: z.number(), pageId: z.string(), formId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      // Get page token from facebookConnections (not /me/accounts)
      const [conn] = await db
        .select()
        .from(facebookConnections)
        .where(and(eq(facebookConnections.pageId, input.pageId), eq(facebookConnections.userId, userId)))
        .limit(1);
      if (!conn) throw new Error("Page not found in your connections");
      const pageToken = decrypt(conn.accessToken);
      const details = await getFormFields(input.formId, pageToken);
      return details.questions ?? [];
    }),

   // ── Subscribe page to app (single page) ──────────────────────────────────
  subscribePage: protectedProcedure
    .input(z.object({ accountId: z.number(), pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      const [acct] = await db
        .select()
        .from(facebookAccounts)
        .where(eq(facebookAccounts.id, input.accountId))
        .limit(1);
      if (!acct || acct.userId !== userId) throw new Error("Account not found");

      // Try to find the page via Facebook API first
      const userToken = decrypt(acct.accessToken);
      let pageAccessToken: string | null = null;
      let pageName: string | null = null;

      try {
        const pages = await listUserPages(userToken);
        const page = pages.find((p) => p.id === input.pageId);
        if (page) {
          pageAccessToken = page.access_token;
          pageName = page.name;
        }
      } catch (e) {
        // Facebook API call failed — fall back to DB token below
      }

      // Fall back: check if we already have a stored connection for this page
      if (!pageAccessToken) {
        const [conn] = await db
          .select()
          .from(facebookConnections)
          .where(and(eq(facebookConnections.pageId, input.pageId), eq(facebookConnections.userId, userId)))
          .limit(1);
        if (conn) {
          pageAccessToken = decrypt(conn.accessToken);
          pageName = conn.pageName ?? null;
        }
      }

      if (!pageAccessToken) {
        throw new Error("Page not found in this account. Please reconnect the Facebook account.");
      }

      const result = await subscribePageToApp(input.pageId, pageAccessToken);
      const encryptedPageToken = encrypt(pageAccessToken);

       const existing = await db
        .select({ id: facebookConnections.id })
        .from(facebookConnections)
        .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.facebookAccountId, input.accountId), eq(facebookConnections.pageId, input.pageId)))
        .limit(1);
      if (existing.length > 0) {
        await db
          .update(facebookConnections)
          .set({ accessToken: encryptedPageToken, pageName: pageName ?? undefined, isActive: true, facebookAccountId: input.accountId })
          .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.facebookAccountId, input.accountId), eq(facebookConnections.pageId, input.pageId)));
      } else {
        await db.insert(facebookConnections).values({
          userId,
          facebookAccountId: input.accountId,
          pageId: input.pageId,
          pageName: pageName ?? input.pageId,
          accessToken: encryptedPageToken,
          isActive: true,
        });
      }
      return result;
    }),

  // ── Unsubscribe page from app ─────────────────────────────────────────────
  unsubscribePage: protectedProcedure
    .input(z.object({ accountId: z.number(), pageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      const [acct] = await db
        .select()
        .from(facebookAccounts)
        .where(eq(facebookAccounts.id, input.accountId))
        .limit(1);
      if (!acct || acct.userId !== userId) throw new Error("Account not found");
      const userToken = decrypt(acct.accessToken);
      const pages = await listUserPages(userToken);
      const page = pages.find((p) => p.id === input.pageId);
      if (!page) throw new Error("Page not found in this account");
      await unsubscribePageFromApp(input.pageId, page.access_token);
      return { success: true };
    }),
});
