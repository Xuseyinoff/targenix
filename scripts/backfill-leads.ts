/**
 * scripts/backfill-leads.ts
 *
 * Populates the new denormalized columns on existing leads:
 *   pageName, formName              ← from facebook_forms (tenant-safe lookup)
 *   campaignId/Name, adsetId/Name,  ← parsed from leads.rawData
 *   adId/Name, extraFields
 *
 * Run AFTER applying migration 0001_leads_denormalize.sql:
 *
 *   npx tsx scripts/backfill-leads.ts
 *
 * Multi-tenant safe:
 *   - All facebook_forms lookups include userId
 *   - Updates are scoped to leads.id (no cross-user writes possible)
 *   - Dry-run mode: set DRY_RUN=1 to preview without writing
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/mysql2";
import { eq, and, isNull, or, gt } from "drizzle-orm";
import { leads, facebookForms } from "../drizzle/schema";

const BATCH_SIZE = 500;
const DRY_RUN = process.env.DRY_RUN === "1";

// ─── DB connection ────────────────────────────────────────────────────────────

function resolveDbUrl(): string {
  const url =
    process.env.MYSQL_PUBLIC_URL?.startsWith("mysql://") ? process.env.MYSQL_PUBLIC_URL :
    process.env.MYSQL_URL?.startsWith("mysql://")        ? process.env.MYSQL_URL :
    process.env.DATABASE_URL;
  if (!url) throw new Error("No DB URL. Set MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL.");
  return url;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a named field from field_data array.
 */
function getField(fieldData: Array<{ name: string; values: string[] }>, key: string): string | null {
  return fieldData.find((f) => f.name === key)?.values?.[0] ?? null;
}

/**
 * Collect all field_data entries except known core fields into extraFields.
 */
const CORE_FIELDS = new Set(["full_name", "phone_number", "FULL_NAME", "PHONE_NUMBER"]);

function buildExtraFields(
  fieldData: Array<{ name: string; values: string[] }>
): Record<string, string> | null {
  const extra: Record<string, string> = {};
  for (const f of fieldData) {
    if (CORE_FIELDS.has(f.name)) continue;
    const val = f.values?.[0];
    if (val !== undefined && val !== null) extra[f.name] = val;
  }
  return Object.keys(extra).length > 0 ? extra : null;
}

/**
 * Parse rawData JSON into structured fields.
 * Handles both webhook payload shape and Graph API shape.
 */
function parseRawData(rawData: unknown): {
  campaignId:   string | null;
  campaignName: string | null;
  adsetId:      string | null;
  adsetName:    string | null;
  adId:         string | null;
  adName:       string | null;
  email:        string | null;
  extraFields:  Record<string, string> | null;
} {
  const empty = {
    campaignId: null, campaignName: null,
    adsetId: null, adsetName: null,
    adId: null, adName: null,
    email: null, extraFields: null,
  };

  if (!rawData || typeof rawData !== "object") return empty;
  const r = rawData as Record<string, unknown>;

  const campaignId   = (r.campaign_id   as string | null) ?? null;
  const campaignName = (r.campaign_name as string | null) ?? null;
  const adsetId      = (r.adset_id      as string | null) ?? null;
  const adsetName    = (r.adset_name    as string | null) ?? null;
  const adId         = (r.ad_id         as string | null) ?? null;
  const adName       = (r.ad_name       as string | null) ?? null;

  // field_data may be nested under the raw Graph API response
  const fieldData = Array.isArray(r.field_data)
    ? (r.field_data as Array<{ name: string; values: string[] }>)
    : [];

  const email      = getField(fieldData, "email") ?? getField(fieldData, "EMAIL");
  const extraFields = buildExtraFields(fieldData);

  return { campaignId, campaignName, adsetId, adsetName, adId, adName, email, extraFields };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = drizzle(resolveDbUrl());
  console.log(`[Backfill] Starting${DRY_RUN ? " (DRY RUN — no writes)" : ""}...`);

  // Count total leads that need backfilling (any new column still null)
  const allLeads = await db
    .select({ id: leads.id, userId: leads.userId, pageId: leads.pageId, formId: leads.formId, rawData: leads.rawData })
    .from(leads)
    .where(
      or(
        isNull(leads.pageName),
        isNull(leads.campaignId),
      )
    );

  const total = allLeads.length;
  console.log(`[Backfill] ${total} leads to process (batch size: ${BATCH_SIZE})`);

  if (total === 0) {
    console.log("[Backfill] Nothing to do — all leads already backfilled.");
    return;
  }

  // Build a cache of facebook_forms per (userId, pageId, formId)
  // Load once upfront — avoids repeated queries inside the loop
  const formsRows = await db
    .select({
      userId:   facebookForms.userId,
      pageId:   facebookForms.pageId,
      formId:   facebookForms.formId,
      pageName: facebookForms.pageName,
      formName: facebookForms.formName,
    })
    .from(facebookForms);

  const formsCache = new Map<string, { pageName: string; formName: string }>();
  for (const f of formsRows) {
    // Key: `userId:pageId:formId` — tenant-safe
    formsCache.set(`${f.userId}:${f.pageId}:${f.formId}`, {
      pageName: f.pageName,
      formName: f.formName,
    });
  }
  console.log(`[Backfill] Loaded ${formsCache.size} facebook_forms entries into cache.`);

  let processed = 0;
  let updated   = 0;
  let errors    = 0;

  // Process in batches
  for (let i = 0; i < allLeads.length; i += BATCH_SIZE) {
    const batch = allLeads.slice(i, i + BATCH_SIZE);

    for (const lead of batch) {
      try {
        // Tenant-safe form lookup
        const formKey = `${lead.userId}:${lead.pageId}:${lead.formId}`;
        const formInfo = formsCache.get(formKey) ?? null;

        const parsed = parseRawData(lead.rawData);

        if (!DRY_RUN) {
          await db
            .update(leads)
            .set({
              pageName:     formInfo?.pageName  ?? null,
              formName:     formInfo?.formName  ?? null,
              campaignId:   parsed.campaignId,
              campaignName: parsed.campaignName,
              adsetId:      parsed.adsetId,
              adsetName:    parsed.adsetName,
              adId:         parsed.adId,
              adName:       parsed.adName,
              extraFields:  parsed.extraFields,
            })
            .where(eq(leads.id, lead.id));
          updated++;
        }

        processed++;
      } catch (err) {
        errors++;
        console.error(`[Backfill] Error on lead.id=${lead.id}:`, err);
      }
    }

    const progress = Math.min(i + BATCH_SIZE, total);
    console.log(`[Backfill] ${progress}/${total} processed, ${updated} updated, ${errors} errors`);
  }

  console.log(`[Backfill] Done. total=${total} updated=${updated} errors=${errors}${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);
}

main().catch((err) => {
  console.error("[Backfill] Fatal error:", err);
  process.exit(1);
});
