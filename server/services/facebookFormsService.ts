/**
 * facebookFormsService.ts
 *
 * Manages the `facebook_forms` table:
 *  - Fetch all lead forms for each connected page and upsert into DB
 *  - Enrich incoming leads with pageName + formName + platform
 *  - Fallback: fetch form/page name directly from Graph API if not in DB
 *  - If Graph API fails (expired token etc.) → return pageId/formId as fallback text
 */

import { eq, and, or } from "drizzle-orm";
import { getDb } from "../db";
import { facebookConnections, facebookForms, integrations } from "../../drizzle/schema";
import { decrypt } from "../encryption";
import { listPageLeadForms, graphRequest } from "./facebookGraphService";
import { log } from "./appLogger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LeadSourceInfo {
  pageName: string;
  formName: string;
  platform: "fb" | "ig";
}

// ─── Upsert forms for a single page ──────────────────────────────────────────

export async function upsertFormsForPage(params: {
  userId: number;
  pageId: string;
  pageName: string;
  pageAccessToken: string;
  platform?: "fb" | "ig";
}): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  let forms: Array<{ id: string; name: string }> = [];
  try {
    forms = await listPageLeadForms(params.pageId, params.pageAccessToken);
  } catch (err) {
    await log.warn("FACEBOOK", `Failed to fetch forms for page ${params.pageId}`, { error: String(err) });
    return 0;
  }

  // platform defaults to "fb" — will be updated to correct value when first lead arrives
  // (Graph API returns platform field per lead, which updates facebook_forms)
  const platform = params.platform ?? "fb";
  let upserted = 0;
  for (const form of forms) {
    try {
      await db
        .insert(facebookForms)
        .values({
          userId: params.userId,
          pageId: params.pageId,
          pageName: params.pageName,
          formId: form.id,
          formName: form.name,
          platform,
        })
        .onDuplicateKeyUpdate({
          set: { pageName: params.pageName, formName: form.name, platform },
        });
      upserted++;
    } catch (err) {
      await log.warn("FACEBOOK", `Failed to upsert form ${form.id}`, { error: String(err) });
    }
  }

  await log.info("FACEBOOK", `Upserted ${upserted}/${forms.length} forms for page ${params.pageName} (${params.pageId})`);
  return upserted;
}

// ─── Refresh all forms for a user's connected pages ───────────────────────────

export async function refreshFormsForUser(userId: number): Promise<{ pages: number; forms: number }> {
  const db = await getDb();
  if (!db) return { pages: 0, forms: 0 };

  const connections = await db
    .select()
    .from(facebookConnections)
    .where(and(eq(facebookConnections.userId, userId), eq(facebookConnections.isActive, true)));

  let totalForms = 0;
  for (const conn of connections) {
    try {
      const pageToken = decrypt(conn.accessToken);
      const count = await upsertFormsForPage({
        userId,
        pageId: conn.pageId,
        pageName: conn.pageName,
        pageAccessToken: pageToken,
        // platform not set here — will be updated when first lead arrives via Graph API platform field
      });
      totalForms += count;
    } catch (err) {
      await log.warn("FACEBOOK", `refreshFormsForUser: failed for page ${conn.pageId}`, { error: String(err) });
    }
  }

  await log.info("FACEBOOK", `refreshFormsForUser(userId=${userId}): ${connections.length} pages, ${totalForms} forms`);
  return { pages: connections.length, forms: totalForms };
}

// ─── Refresh forms for ALL users (24h scheduler) ─────────────────────────────

export async function refreshAllUsersForms(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const rows = await db
    .selectDistinct({ userId: facebookConnections.userId })
    .from(facebookConnections)
    .where(eq(facebookConnections.isActive, true));

  await log.info("FACEBOOK", `refreshAllUsersForms: refreshing ${rows.length} users`);
  for (const row of rows) {
    try {
      await refreshFormsForUser(row.userId);
    } catch (err) {
      await log.warn("FACEBOOK", `refreshAllUsersForms: failed for userId=${row.userId}`, { error: String(err) });
    }
  }
}

// ─── Enrich lead with pageName, formName, platform ────────────────────────────
//
// Priority:
//  1. facebook_forms table (fast indexed lookup)
//  2. Graph API fallback (fetch form name + page name, save to DB)
//  3. If everything fails → return pageId / formId as display text (never crash)

export async function getLeadSourceInfo(params: {
  userId: number;
  pageId: string;
  formId: string;
}): Promise<LeadSourceInfo> {
  const db = await getDb();
  if (!db) {
    return { pageName: params.pageId, formName: params.formId, platform: "fb" };
  }

  // 1. Fast DB lookup
  const [row] = await db
    .select({
      pageName: facebookForms.pageName,
      formName: facebookForms.formName,
      platform: facebookForms.platform,
    })
    .from(facebookForms)
    .where(
      and(
        eq(facebookForms.userId, params.userId),
        eq(facebookForms.pageId, params.pageId),
        eq(facebookForms.formId, params.formId)
      )
    )
    .limit(1);

  if (row) {
    return {
      pageName: row.pageName,
      formName: row.formName,
      platform: row.platform as "fb" | "ig",
    };
  }

  // 2. Graph API fallback — find page token for this user + pageId only.
  //    Never fall back to another user's connection: that would decrypt and use
  //    a different tenant's Facebook credentials.
  const [conn] = await db
    .select()
    .from(facebookConnections)
    .where(
      and(
        eq(facebookConnections.userId, params.userId),
        eq(facebookConnections.pageId, params.pageId)
      )
    )
    .limit(1);

  const connToUse = conn ?? null;

  if (!connToUse) {
    // No token available — show raw IDs
    await log.warn("FACEBOOK", `getLeadSourceInfo: no connection for pageId=${params.pageId}`, { formId: params.formId });
    return { pageName: params.pageId, formName: params.formId, platform: "fb" };
  }

  // Attempt Graph API fetch
  let formName: string = params.formId;
  let pageName: string = connToUse.pageName ?? params.pageId;
  let platform: "fb" | "ig" = "fb";

  try {
    const pageToken = decrypt(connToUse.accessToken);

    // Fetch form name
    const formData = await graphRequest<{ id: string; name?: string }>(
      "GET",
      `/${params.formId}`,
      {
        params: { access_token: pageToken, fields: "id,name" },
        logLabel: `getFormName(${params.formId})`,
      }
    );
    if (formData.name) formName = formData.name;

    // platform will be set when first lead arrives (Graph API platform field)
    // For now keep default "fb" — it will be updated by processLead

    // Save to DB for future use
    await db
      .insert(facebookForms)
      .values({
        userId: params.userId,
        pageId: params.pageId,
        pageName,
        formId: params.formId,
        formName,
        platform,
      })
      .onDuplicateKeyUpdate({ set: { pageName, formName, platform } });

    await log.info("FACEBOOK", `getLeadSourceInfo: fetched & saved form ${params.formId} → "${formName}"`);
  } catch (err) {
    // Token expired or API error — use fallback text, do NOT crash
    await log.warn("FACEBOOK", `getLeadSourceInfo: Graph API fallback failed for form ${params.formId}`, { error: String(err) });
    // Still use pageName from connection if available
  }

  return { pageName, formName, platform };
}

/** Stable key for (pageId, formId) pairs in batch maps */
export function leadSourcePairKey(pageId: string, formId: string): string {
  return `${pageId}\0${formId}`;
}

/**
 * Resolve human-readable page/form names for a batch of leads when `leads.pageName`
 * / `leads.formName` are null (webhook saved before `facebook_forms` cache existed).
 * Priority: facebook_forms → LEAD_ROUTING integrations dedicated columns.
 */
export async function batchResolvePageFormDisplayNames(
  userId: number,
  pairs: Array<{ pageId: string; formId: string }>,
): Promise<Map<string, { pageName: string | null; formName: string | null }>> {
  const out = new Map<string, { pageName: string | null; formName: string | null }>();
  const unique = new Map<string, { pageId: string; formId: string }>();
  for (const p of pairs) {
    if (!p.pageId?.trim() || !p.formId?.trim()) continue;
    const k = leadSourcePairKey(p.pageId, p.formId);
    if (!unique.has(k)) unique.set(k, { pageId: p.pageId, formId: p.formId });
  }
  if (unique.size === 0) return out;

  const db = await getDb();
  if (!db) return out;

  const pairList = Array.from(unique.values());
  const formOr = or(
    ...pairList.map((p) => and(eq(facebookForms.pageId, p.pageId), eq(facebookForms.formId, p.formId))),
  );

  const formRows = await db
    .select({
      pageId: facebookForms.pageId,
      formId: facebookForms.formId,
      pageName: facebookForms.pageName,
      formName: facebookForms.formName,
    })
    .from(facebookForms)
    .where(and(eq(facebookForms.userId, userId), formOr));

  for (const r of formRows) {
    out.set(leadSourcePairKey(r.pageId, r.formId), {
      pageName: r.pageName ?? null,
      formName: r.formName ?? null,
    });
  }

  const stillNeedIntegration = pairList.filter((p) => {
    const cur = out.get(leadSourcePairKey(p.pageId, p.formId));
    return !cur?.pageName?.trim() || !cur?.formName?.trim();
  });
  if (stillNeedIntegration.length === 0) return out;

  const intOr = or(
    ...stillNeedIntegration.map((p) =>
      and(eq(integrations.pageId, p.pageId), eq(integrations.formId, p.formId)),
    ),
  );

  const intRows = await db
    .select({
      pageId: integrations.pageId,
      formId: integrations.formId,
      pageName: integrations.pageName,
      formName: integrations.formName,
    })
    .from(integrations)
    .where(
      and(eq(integrations.userId, userId), eq(integrations.type, "LEAD_ROUTING"), intOr),
    );

  for (const r of intRows) {
    if (!r.pageId || !r.formId) continue;
    const k = leadSourcePairKey(r.pageId, r.formId);
    const prev = out.get(k) ?? { pageName: null, formName: null };
    out.set(k, {
      pageName: prev.pageName?.trim() || r.pageName?.trim() || null,
      formName: prev.formName?.trim() || r.formName?.trim() || null,
    });
  }

  return out;
}

// ─── Get all pages+forms for a user (for filter dropdowns) ───────────────────

export async function getUserFormsIndex(userId: number): Promise<Array<{
  pageId: string;
  pageName: string;
  formId: string;
  formName: string;
  platform: "fb" | "ig";
}>> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      pageId: facebookForms.pageId,
      pageName: facebookForms.pageName,
      formId: facebookForms.formId,
      formName: facebookForms.formName,
      platform: facebookForms.platform,
    })
    .from(facebookForms)
    .where(eq(facebookForms.userId, userId));

  return rows.map(r => ({ ...r, platform: r.platform as "fb" | "ig" }));
}
