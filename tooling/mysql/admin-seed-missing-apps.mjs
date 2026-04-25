/**
 * admin-seed-missing-apps.mjs
 *
 * Inserts the 8 canonical app rows into the `apps` table if they are
 * absent. Safe to run multiple times (INSERT IGNORE / duplicate check).
 * These are the same rows that migration 0046/0047/0048 seeded.
 *
 * Usage (run audit first):
 *   railway run --service targenix.uz node tooling/mysql/audit-db-only-readiness.mjs
 *   # If AUDIT FAILED, run this:
 *   railway run --service targenix.uz node tooling/mysql/admin-seed-missing-apps.mjs
 *   # Then re-audit:
 *   railway run --service targenix.uz node tooling/mysql/audit-db-only-readiness.mjs
 */

import mysql from "mysql2/promise";

const CANONICAL_APPS = [
  {
    appKey: "alijahon",
    displayName: "Alijahon.uz",
    authType: "api_key",
    category: "affiliate",
    fields: [{ key: "api_key", label: "API Key", required: true, sensitive: true }],
    iconUrl: null,
    docsUrl: null,
    isActive: true,
  },
  {
    appKey: "mgoods",
    displayName: "Mgoods.uz",
    authType: "api_key",
    category: "affiliate",
    fields: [{ key: "api_key", label: "API Key", required: true, sensitive: true }],
    iconUrl: null,
    docsUrl: null,
    isActive: true,
  },
  {
    appKey: "sotuvchi",
    displayName: "Sotuvchi.com",
    authType: "api_key",
    category: "affiliate",
    fields: [{ key: "api_key", label: "API Key", required: true, sensitive: true }],
    iconUrl: null,
    docsUrl: null,
    isActive: true,
  },
  {
    appKey: "inbaza",
    displayName: "Inbaza.uz",
    authType: "api_key",
    category: "affiliate",
    fields: [{ key: "api_key", label: "API Key", required: true, sensitive: true }],
    iconUrl: null,
    docsUrl: null,
    isActive: true,
  },
  {
    appKey: "100k",
    displayName: "100k.uz",
    authType: "api_key",
    category: "affiliate",
    fields: [{ key: "api_key", label: "API Key", required: true, sensitive: true }],
    iconUrl: null,
    docsUrl: null,
    isActive: true,
  },
  {
    appKey: "open_affiliate",
    displayName: "Open Affiliate (no credentials)",
    authType: "none",
    category: "affiliate",
    fields: [],
    iconUrl: null,
    docsUrl: null,
    isActive: true,
  },
  {
    appKey: "telegram",
    displayName: "Telegram",
    authType: "bearer",
    category: "messaging",
    fields: [{ key: "bot_token", label: "Bot Token", required: true, sensitive: true }],
    iconUrl: null,
    docsUrl: null,
    isActive: true,
  },
  {
    appKey: "google-sheets",
    displayName: "Google Sheets",
    authType: "oauth2",
    category: "data",
    fields: [],
    iconUrl: null,
    docsUrl: null,
    isActive: true,
  },
];

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ABORT: DATABASE_URL not set");
    process.exit(1);
  }

  const conn = await mysql.createConnection(url);

  try {
    console.log("=== SEED MISSING CANONICAL APPS ===\n");

    const [existingRows] = await conn.execute("SELECT appKey FROM apps");
    const existingKeys = new Set(existingRows.map((r) => r.appKey));

    let inserted = 0;
    let skipped = 0;

    for (const app of CANONICAL_APPS) {
      if (existingKeys.has(app.appKey)) {
        console.log(`  SKIP   ${app.appKey} (already exists)`);
        skipped++;
        continue;
      }

      await conn.execute(
        `INSERT INTO apps (appKey, displayName, authType, category, fields, iconUrl, docsUrl, isActive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          app.appKey,
          app.displayName,
          app.authType,
          app.category,
          JSON.stringify(app.fields),
          app.iconUrl,
          app.docsUrl,
          app.isActive ? 1 : 0,
        ],
      );
      console.log(`  INSERT ${app.appKey} (${app.authType})`);
      inserted++;
    }

    console.log(`\nDone. Inserted: ${inserted}, Skipped: ${skipped}`);
    console.log("Run audit again to confirm: node tooling/mysql/audit-db-only-readiness.mjs");
  } finally {
    await conn.end();
  }
}

run().catch((err) => {
  console.error("SEED CRASHED:", err.message);
  process.exit(1);
});
