/**
 * scripts/backfill-leads.ts
 * Fast parallel backfill — CONCURRENCY updates at once via Promise.all
 *
 * Run: railway run npx tsx scripts/backfill-leads.ts
 */

import "dotenv/config";
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { eq, isNull, or } from "drizzle-orm";
import { leads, facebookForms } from "../drizzle/schema";

const FETCH_SIZE  = 2000;  // leads fetched per SELECT page
const CONCURRENCY = 50;    // parallel UPDATEs at once
const DRY_RUN = process.env.DRY_RUN === "1";

function resolveDbUrl(): string {
  const url =
    process.env.MYSQL_PUBLIC_URL?.startsWith("mysql://") ? process.env.MYSQL_PUBLIC_URL :
    process.env.MYSQL_URL?.startsWith("mysql://")        ? process.env.MYSQL_URL :
    process.env.DATABASE_URL;
  if (!url) throw new Error("No DB URL.");
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
  const empty = { campaignId: null, campaignName: null, adsetId: null, adsetName: null, adId: null, adName: null, extraFields: null };
  if (!rawData || typeof rawData !== "object") return empty;
  const r = rawData as Record<string, unknown>;
  const fieldData = Array.isArray(r.field_data) ? (r.field_data as Array<{ name: string; values: string[] }>) : [];
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

async function main() {
  const url = resolveDbUrl();
  const pool = mysql.createPool({
    uri: url,
    connectionLimit: CONCURRENCY + 5,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
  });
  const db = drizzle(pool);

  console.log(`[Backfill] Starting${DRY_RUN ? " (DRY RUN)" : ""} concurrency=${CONCURRENCY}...`);

  // Load all leads needing backfill
  const allLeads = await db
    .select({ id: leads.id, userId: leads.userId, pageId: leads.pageId, formId: leads.formId, rawData: leads.rawData })
    .from(leads)
    .where(or(isNull(leads.pageName), isNull(leads.campaignId)));

  const total = allLeads.length;
  console.log(`[Backfill] ${total} leads to process`);
  if (total === 0) { await pool.end(); return; }

  // Load facebook_forms cache
  const formsRows = await db
    .select({ userId: facebookForms.userId, pageId: facebookForms.pageId, formId: facebookForms.formId, pageName: facebookForms.pageName, formName: facebookForms.formName, platform: facebookForms.platform })
    .from(facebookForms);

  const formsCache = new Map<string, { pageName: string; formName: string; platform: "fb" | "ig" }>();
  for (const f of formsRows) {
    formsCache.set(`${f.userId}:${f.pageId}:${f.formId}`, { pageName: f.pageName, formName: f.formName, platform: f.platform as "fb" | "ig" });
  }
  console.log(`[Backfill] ${formsCache.size} facebook_forms cached. Starting parallel updates...`);

  let updated = 0;
  let errors  = 0;
  const startMs = Date.now();

  // Process in chunks of CONCURRENCY
  for (let i = 0; i < allLeads.length; i += CONCURRENCY) {
    const chunk = allLeads.slice(i, i + CONCURRENCY);

    await Promise.all(chunk.map(async (lead) => {
      const formInfo = formsCache.get(`${lead.userId}:${lead.pageId}:${lead.formId}`) ?? null;
      const parsed   = parseRawData(lead.rawData);
      if (DRY_RUN) { updated++; return; }

      try {
        await db.update(leads).set({
          pageName:     formInfo?.pageName  ?? null,
          formName:     formInfo?.formName  ?? null,
          ...(formInfo?.platform ? { platform: formInfo.platform } : {}),
          campaignId:   parsed.campaignId,
          campaignName: parsed.campaignName,
          adsetId:      parsed.adsetId,
          adsetName:    parsed.adsetName,
          adId:         parsed.adId,
          adName:       parsed.adName,
          extraFields:  parsed.extraFields,
        }).where(eq(leads.id, lead.id));
        updated++;
      } catch (err: any) {
        errors++;
        console.error(`[Backfill] Error lead.id=${lead.id}: ${err.code ?? err.message}`);
      }
    }));

    // Progress every 1000
    if ((i + CONCURRENCY) % 1000 < CONCURRENCY || i + CONCURRENCY >= total) {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(0);
      const progress = Math.min(i + CONCURRENCY, total);
      const rate = Math.round(updated / ((Date.now() - startMs) / 1000));
      console.log(`[Backfill] ${progress}/${total} — ${updated} updated, ${errors} errors — ${rate}/s — ${elapsed}s elapsed`);
    }
  }

  await pool.end();
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[Backfill] Done. total=${total} updated=${updated} errors=${errors} time=${elapsed}s`);
}

main().catch((err) => { console.error("[Backfill] Fatal:", err); process.exit(1); });
