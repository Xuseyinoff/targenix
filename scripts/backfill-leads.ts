/**
 * scripts/backfill-leads.ts
 *
 * Populates the new denormalized columns on existing leads.
 * Uses connection pool + per-row retry to survive ECONNRESET on Railway.
 *
 * Run: railway run npx tsx scripts/backfill-leads.ts
 * Dry:  DRY_RUN=1 railway run npx tsx scripts/backfill-leads.ts
 */

import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { eq, and, isNull, or } from "drizzle-orm";
import { leads, facebookForms } from "../drizzle/schema";

const BATCH_SIZE = 200;
const DRY_RUN = process.env.DRY_RUN === "1";

function resolveDbUrl(): string {
  const url =
    process.env.MYSQL_PUBLIC_URL?.startsWith("mysql://") ? process.env.MYSQL_PUBLIC_URL :
    process.env.MYSQL_URL?.startsWith("mysql://")        ? process.env.MYSQL_URL :
    process.env.DATABASE_URL;
  if (!url) throw new Error("No DB URL. Set MYSQL_PUBLIC_URL, MYSQL_URL, or DATABASE_URL.");
  return url;
}

const CORE_FIELDS = new Set(["full_name", "phone_number", "FULL_NAME", "PHONE_NUMBER"]);

function buildExtraFields(fieldData: Array<{ name: string; values: string[] }>): Record<string, string> | null {
  const extra: Record<string, string> = {};
  for (const f of fieldData) {
    if (CORE_FIELDS.has(f.name)) continue;
    const val = f.values?.[0];
    if (val !== undefined && val !== null && val !== "") extra[f.name] = val;
  }
  return Object.keys(extra).length > 0 ? extra : null;
}

function parseRawData(rawData: unknown) {
  const empty = {
    campaignId: null, campaignName: null,
    adsetId: null, adsetName: null,
    adId: null, adName: null,
    extraFields: null,
  };
  if (!rawData || typeof rawData !== "object") return empty;
  const r = rawData as Record<string, unknown>;
  const fieldData = Array.isArray(r.field_data)
    ? (r.field_data as Array<{ name: string; values: string[] }>)
    : [];
  return {
    campaignId:   (r.campaign_id   as string | null) ?? null,
    campaignName: (r.campaign_name as string | null) ?? null,
    adsetId:      (r.adset_id      as string | null) ?? null,
    adsetName:    (r.adset_name    as string | null) ?? null,
    adId:         (r.ad_id         as string | null) ?? null,
    adName:       (r.ad_name       as string | null) ?? null,
    extraFields:  buildExtraFields(fieldData),
  };
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const retriable = err.code === "ECONNRESET" || err.code === "PROTOCOL_CONNECTION_LOST" || err.code === "ECONNREFUSED";
      if (retriable && attempt < retries) {
        console.log(`  ↺ Retry ${attempt}/${retries} after ${delayMs}ms...`);
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      } else {
        throw err;
      }
    }
  }
  throw new Error("Unreachable");
}

async function main() {
  const url = resolveDbUrl();

  // Use a connection pool so dropped connections are automatically replaced
  const pool = mysql.createPool({
    uri: url,
    connectionLimit: 5,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });
  const db = drizzle(pool);

  console.log(`[Backfill] Starting${DRY_RUN ? " (DRY RUN)" : ""}...`);

  // Load all leads that still need backfilling
  const allLeads = await db
    .select({ id: leads.id, userId: leads.userId, pageId: leads.pageId, formId: leads.formId, rawData: leads.rawData })
    .from(leads)
    .where(or(isNull(leads.pageName), isNull(leads.campaignId)));

  const total = allLeads.length;
  console.log(`[Backfill] ${total} leads to process (batch: ${BATCH_SIZE})`);

  if (total === 0) {
    console.log("[Backfill] Nothing to do.");
    await pool.end();
    return;
  }

  // Load facebook_forms cache once (tenant-safe: keyed by userId:pageId:formId)
  const formsRows = await db
    .select({ userId: facebookForms.userId, pageId: facebookForms.pageId, formId: facebookForms.formId, pageName: facebookForms.pageName, formName: facebookForms.formName, platform: facebookForms.platform })
    .from(facebookForms);

  const formsCache = new Map<string, { pageName: string; formName: string; platform: "fb" | "ig" }>();
  for (const f of formsRows) {
    formsCache.set(`${f.userId}:${f.pageId}:${f.formId}`, { pageName: f.pageName, formName: f.formName, platform: f.platform as "fb" | "ig" });
  }
  console.log(`[Backfill] ${formsCache.size} facebook_forms loaded into cache.`);

  let processed = 0;
  let updated = 0;
  let errors = 0;

  for (let i = 0; i < allLeads.length; i += BATCH_SIZE) {
    const batch = allLeads.slice(i, i + BATCH_SIZE);

    for (const lead of batch) {
      try {
        const formInfo = formsCache.get(`${lead.userId}:${lead.pageId}:${lead.formId}`) ?? null;
        const parsed = parseRawData(lead.rawData);

        if (!DRY_RUN) {
          await withRetry(() =>
            db.update(leads).set({
              pageName:     formInfo?.pageName  ?? null,
              formName:     formInfo?.formName  ?? null,
              // Use facebook_forms platform as authoritative source (corrects wrong "fb" defaults)
              ...(formInfo?.platform ? { platform: formInfo.platform } : {}),
              campaignId:   parsed.campaignId,
              campaignName: parsed.campaignName,
              adsetId:      parsed.adsetId,
              adsetName:    parsed.adsetName,
              adId:         parsed.adId,
              adName:       parsed.adName,
              extraFields:  parsed.extraFields,
            })
            .where(eq(leads.id, lead.id))
          );
          updated++;
        }
        processed++;
      } catch (err: any) {
        errors++;
        console.error(`[Backfill] Error lead.id=${lead.id}: ${err.code ?? err.message}`);
      }
    }

    const progress = Math.min(i + BATCH_SIZE, total);
    console.log(`[Backfill] ${progress}/${total} processed, ${updated} updated, ${errors} errors`);
  }

  await pool.end();
  console.log(`[Backfill] Done. total=${total} updated=${updated} errors=${errors}`);
}

main().catch((err) => {
  console.error("[Backfill] Fatal:", err);
  process.exit(1);
});
