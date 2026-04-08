/**
 * Facebook Graph API helpers for the new integration flow.
 *
 * Flow:
 *  1. User pastes a Short-Lived User Access Token (from Graph API Explorer or FB Login)
 *  2. We exchange it for a Long-Lived User Access Token (60-day)
 *  3. We fetch the user's profile (id, name)
 *  4. We list pages the user manages (each page has its own Page Access Token)
 *  5. User picks a page → we list lead forms on that page
 *  6. User picks a form → we list the form's questions/fields
 *  7. User maps name/phone fields, picks target website, enters flow + offer_id
 *  8. We POST /{page-id}/subscribed_apps to subscribe the page to our app
 */

import axios from "axios";
import { log } from "./appLogger";

const GRAPH = "https://graph.facebook.com/v21.0";

/** Mask an access token for safe logging — show only first/last 6 chars */
function maskToken(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

/** Generic Graph API request wrapper with full request/response logging */
export async function graphRequest<T>(
  method: "GET" | "POST" | "DELETE",
  endpoint: string,
  options: {
    params?: Record<string, unknown>;
    data?: unknown;
    timeout?: number;
    logLabel?: string;
  } = {}
): Promise<T> {
  const { params = {}, data, timeout = 10000, logLabel } = options;
  const label = logLabel ?? `${method} ${endpoint}`;

  // Sanitize params for logging — mask access tokens
  const safeParams: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    safeParams[k] = k === "access_token" && typeof v === "string" ? maskToken(v) : v;
  }

  await log.info("FACEBOOK", `→ ${label}`, { method, endpoint, params: safeParams });

  const startAt = Date.now();
  try {
    let res;
    if (method === "GET") {
      res = await axios.get<T>(`${GRAPH}${endpoint}`, { params, timeout });
    } else if (method === "POST") {
      res = await axios.post<T>(`${GRAPH}${endpoint}`, data ?? null, { params, timeout });
    } else {
      res = await axios.delete<T>(`${GRAPH}${endpoint}`, { params, timeout });
    }

    const duration = Date.now() - startAt;
    const responsePreview =
      typeof res.data === "object" && res.data !== null
        ? JSON.stringify(res.data).slice(0, 400)
        : String(res.data).slice(0, 400);

    await log.info("FACEBOOK", `← ${label} → ${res.status} (${duration}ms)`, {
      status: res.status,
      duration,
      responsePreview,
    });

    return res.data;
  } catch (err: unknown) {
    const duration = Date.now() - startAt;
    const axiosErr = err as { response?: { status?: number; data?: unknown }; message?: string };
    const status = axiosErr?.response?.status;
    const fbError = (axiosErr?.response?.data as { error?: { message?: string; code?: number } })?.error;
    const message = fbError?.message ?? axiosErr?.message ?? "Unknown error";

    await log.error("FACEBOOK", `← ${label} → ERROR (${duration}ms): ${message}`, {
      status,
      duration,
      fbErrorCode: fbError?.code,
      fbErrorMessage: fbError?.message,
      rawMessage: axiosErr?.message,
    });

    throw err;
  }
}

// ─── Authorization Code Exchange ────────────────────────────────────────────

/**
 * Exchange an Authorization Code for a short-lived user access token.
 * This is the server-side step in the Authorization Code Flow.
 * The code is received from Facebook's OAuth callback redirect.
 */
export async function exchangeCodeForToken(
  code: string,
  appId: string,
  appSecret: string,
  redirectUri: string
): Promise<string> {
  const result = await graphRequest<{ access_token: string; token_type: string; expires_in?: number }>(
    "GET",
    "/oauth/access_token",
    {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
      logLabel: "exchangeCodeForToken",
    }
  );
  return result.access_token;
}

// ─── Token Exchange ───────────────────────────────────────────────────────────

export interface LongLivedTokenResult {
  access_token: string;
  token_type: string;
  expires_in?: number; // seconds; absent for never-expiring tokens
}

/**
 * Exchange a short-lived user token for a long-lived one (60 days).
 * Requires FACEBOOK_APP_ID and FACEBOOK_APP_SECRET env vars.
 */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string
): Promise<LongLivedTokenResult> {
  return graphRequest<LongLivedTokenResult>("GET", "/oauth/access_token", {
    params: {
      grant_type: "fb_exchange_token",
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: shortLivedToken,
    },
    logLabel: "exchangeForLongLivedToken",
  });
}

// ─── User Profile ─────────────────────────────────────────────────────────────

export interface FbUserProfile {
  id: string;
  name: string;
}

export async function getFbUserProfile(
  accessToken: string
): Promise<FbUserProfile> {
  return graphRequest<FbUserProfile>("GET", "/me", {
    params: { access_token: accessToken, fields: "id,name" },
    logLabel: "getFbUserProfile",
  });
}

// ─── Pages ────────────────────────────────────────────────────────────────────

export interface FbPage {
  id: string;
  name: string;
  /** Page-level access token — valid for making page-scoped API calls */
  access_token: string;
  category?: string;
}

/**
 * List all Facebook Pages the user manages.
 * Returns pages with their own page-level access tokens.
 * NOTE: /me/accounts only returns pages the user "opted in" during login.
 * Use getAllGrantedPages() for a comprehensive list.
 */
export async function listUserPages(userAccessToken: string): Promise<FbPage[]> {
  const result = await graphRequest<{ data: FbPage[] }>("GET", "/me/accounts", {
    params: {
      access_token: userAccessToken,
      fields: "id,name,access_token,category",
      limit: 100,
    },
    logLabel: "listUserPages",
  });
  return result.data ?? [];
}

/**
 * Get ALL pages the user granted access to, including those not returned by /me/accounts
 * due to Facebook's "Opt-in" page selection during login.
 *
 * Strategy:
 *  1. Call /debug_token to get granular_scopes → extract all page IDs from pages_show_list
 *  2. Fetch each page directly by ID to get its page-level access token
 *  3. Merge with /me/accounts results (deduped by page ID)
 */
export async function getAllGrantedPages(
  userAccessToken: string,
  appId: string,
  appSecret: string
): Promise<FbPage[]> {
  // 1. Get page IDs from debug_token granular_scopes
  let grantedPageIds: string[] = [];
  try {
    const appToken = `${appId}|${appSecret}`;
    const debugResult = await graphRequest<{
      data: {
        granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
      };
    }>("GET", "/debug_token", {
      params: { input_token: userAccessToken, access_token: appToken },
      logLabel: "debugToken",
    });
    const pagesScope = debugResult.data?.granular_scopes?.find(
      (s) => s.scope === "pages_show_list"
    );
    grantedPageIds = pagesScope?.target_ids ?? [];
    await log.info("FACEBOOK", `debug_token: found ${grantedPageIds.length} granted page IDs`, { pageIds: grantedPageIds });
  } catch (err) {
    await log.error("FACEBOOK", "debug_token failed, falling back to /me/accounts only", { error: String(err) });
  }

  // 2. Also get pages from /me/accounts (the ones user opted in)
  const meAccountsPages = await listUserPages(userAccessToken);
  const pageMap = new Map<string, FbPage>();
  for (const p of meAccountsPages) {
    pageMap.set(p.id, p);
  }

  // 3. For any page ID from debug_token not already in the map, fetch it directly
  for (const pageId of grantedPageIds) {
    if (pageMap.has(pageId)) continue;
    try {
      const page = await graphRequest<FbPage>("GET", `/${pageId}`, {
        params: { access_token: userAccessToken, fields: "id,name,access_token,category" },
        logLabel: `getPageById(${pageId})`,
      });
      if (page.id && page.access_token) {
        pageMap.set(page.id, page);
      }
    } catch (err) {
      await log.error("FACEBOOK", `Failed to fetch page ${pageId} directly`, { error: String(err) });
    }
  }

  const allPages = Array.from(pageMap.values());
  await log.info("FACEBOOK", `getAllGrantedPages: returning ${allPages.length} total pages`, {
    pageIds: allPages.map((p) => p.id),
  });
  return allPages;
}

// ─── Business Manager Pages ─────────────────────────────────────────────────

/**
 * Fetch pages owned by the user's Business Manager accounts.
 * Requires business_management scope.
 * Merges results with personal pages for a complete list.
 */
export async function getBusinessManagerPages(
  userAccessToken: string,
  appId: string,
  appSecret: string
): Promise<FbPage[]> {
  const appToken = `${appId}|${appSecret}`;

  // 1. List all businesses the user has access to
  let businessIds: string[] = [];
  try {
    const bizResult = await graphRequest<{ data: Array<{ id: string; name: string }> }>(
      "GET",
      "/me/businesses",
      {
        params: {
          access_token: userAccessToken,
          fields: "id,name",
          limit: 100,
        },
        logLabel: "getBusinesses",
      }
    );
    businessIds = (bizResult.data ?? []).map((b) => b.id);
    await log.info("FACEBOOK", `Found ${businessIds.length} Business Manager accounts`, { businessIds });
  } catch (err) {
    await log.warn("FACEBOOK", "Failed to fetch businesses (user may not have BM access)", {
      error: String(err),
    });
    return [];
  }

  if (businessIds.length === 0) return [];

  // 2. For each business, fetch owned pages
  const pageMap = new Map<string, FbPage>();

  for (const bizId of businessIds) {
    try {
      const pagesResult = await graphRequest<{ data: Array<{ id: string; name: string }> }>(
        "GET",
        `/${bizId}/owned_pages`,
        {
          params: {
            access_token: userAccessToken,
            fields: "id,name",
            limit: 100,
          },
          logLabel: `getBizOwnedPages(${bizId})`,
        }
      );

      for (const page of pagesResult.data ?? []) {
        if (pageMap.has(page.id)) continue;
        // Fetch page-level access token for this page
        try {
          const pageWithToken = await graphRequest<FbPage>("GET", `/${page.id}`, {
            params: {
              access_token: userAccessToken,
              fields: "id,name,access_token,category",
            },
            logLabel: `getBizPageToken(${page.id})`,
          });
          if (pageWithToken.access_token) {
            pageMap.set(page.id, pageWithToken);
          }
        } catch (err) {
          await log.warn("FACEBOOK", `Failed to get token for BM page ${page.id}`, {
            error: String(err),
          });
        }
      }
    } catch (err) {
      await log.warn("FACEBOOK", `Failed to fetch pages for business ${bizId}`, {
        error: String(err),
      });
    }
  }

  const bmPages = Array.from(pageMap.values());
  await log.info("FACEBOOK", `getBusinessManagerPages: returning ${bmPages.length} BM pages`, {
    pageIds: bmPages.map((p) => p.id),
  });
  return bmPages;
}

// ─── Lead Forms ───────────────────────────────────────────────────────────────

export interface FbLeadForm {
  id: string;
  name: string;
  status?: string;
  created_time?: string;
}

/**
 * List all lead gen forms on a Facebook Page.
 */
export async function listPageLeadForms(
  pageId: string,
  pageAccessToken: string
): Promise<FbLeadForm[]> {
  const result = await graphRequest<{ data: FbLeadForm[] }>(
    "GET",
    `/${pageId}/leadgen_forms`,
    {
      params: {
        access_token: pageAccessToken,
        fields: "id,name,status,created_time",
        limit: 100,
      },
      logLabel: `listPageLeadForms(${pageId})`,
    }
  );
  return result.data ?? [];
}

// ─── Form Questions / Fields ──────────────────────────────────────────────────

export interface FbFormQuestion {
  key: string;
  label?: string;
  type?: string;
}

export interface FbFormDetails {
  id: string;
  name: string;
  questions: FbFormQuestion[];
}

/**
 * Fetch the questions (fields) defined in a lead gen form.
 */
export async function getFormFields(
  formId: string,
  pageAccessToken: string
): Promise<FbFormDetails> {
  return graphRequest<FbFormDetails>("GET", `/${formId}`, {
    params: {
      access_token: pageAccessToken,
      fields: "id,name,questions",
    },
    logLabel: `getFormFields(${formId})`,
  });
}

// ─── Subscribe Page to App ────────────────────────────────────────────────────

export interface SubscribeResult {
  success: boolean;
}

/**
 * Subscribe a Facebook Page to the app so it receives leadgen webhook events.
 * Requires the page access token and the "leads_retrieval" subscribed field.
 */
export async function subscribePageToApp(
  pageId: string,
  pageAccessToken: string
): Promise<SubscribeResult> {
  const result = await graphRequest<SubscribeResult>(
    "POST",
    `/${pageId}/subscribed_apps`,
    {
      params: {
        access_token: pageAccessToken,
        subscribed_fields: "leadgen",
      },
      logLabel: `subscribePageToApp(${pageId})`,
    }
  );
  return { success: result?.success === true };
}

/**
 * Unsubscribe a Facebook Page from the app.
 */
export async function unsubscribePageFromApp(
  pageId: string,
  pageAccessToken: string
): Promise<void> {
  await graphRequest<unknown>("DELETE", `/${pageId}/subscribed_apps`, {
    params: { access_token: pageAccessToken },
    logLabel: `unsubscribePageFromApp(${pageId})`,
  });
}
