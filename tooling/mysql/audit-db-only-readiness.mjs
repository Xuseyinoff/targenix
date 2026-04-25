/**
 * audit-db-only-readiness.mjs
 *
 * Pre-flight audit for the DB-only resolveSpecSafe cutover.
 * Confirms that every appKey the live system touches is present
 * and active in the `apps` table before disabling the TS fallback.
 *
 * Usage:
 *   railway run --service targenix.uz node tooling/mysql/audit-db-only-readiness.mjs
 *
 * Exit 0  → all clear, safe to proceed / already live
 * Exit 1  → STOP — missing appKeys found, DO NOT proceed
 *
 * Checks performed:
 *   A. Every DISTINCT appKey in target_websites     must have an active apps row
 *   B. Every DISTINCT appKey in destination_templates must have an active apps row
 *   C. Core routing appKeys (telegram, google-sheets) must be present
 *   D. apps table has ≥1 active row
 *   E. Overall coverage: coverageOk === true
 */

import mysql from "mysql2/promise";

const REQUIRED_APP_KEYS = [
  "telegram",
  "google-sheets",
  "sotuvchi",
  "inbaza",
  "100k",
  "alijahon",
  "mgoods",
  "open_affiliate",
];

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ABORT: DATABASE_URL not set");
    process.exit(1);
  }

  const conn = await mysql.createConnection(url);
  let exitCode = 0;

  try {
    console.log("=== DB-ONLY READINESS AUDIT ===\n");

    // ── A. appKeys used in target_websites ─────────────────────────────────────
    const [twRows] = await conn.execute(`
      SELECT DISTINCT appKey
      FROM target_websites
      WHERE appKey IS NOT NULL AND appKey != 'unknown'
      ORDER BY appKey
    `);
    const twKeys = twRows.map((r) => r.appKey);
    console.log(`[A] target_websites DISTINCT appKeys (${twKeys.length}):`);
    console.log("   ", twKeys.join(", ") || "(none)");

    // ── B. appKeys used in destination_templates ────────────────────────────────
    const [dtRows] = await conn.execute(`
      SELECT DISTINCT appKey
      FROM destination_templates
      WHERE appKey IS NOT NULL
      ORDER BY appKey
    `);
    const dtKeys = dtRows.map((r) => r.appKey);
    console.log(`\n[B] destination_templates DISTINCT appKeys (${dtKeys.length}):`);
    console.log("   ", dtKeys.join(", ") || "(none)");

    // ── C. apps table inventory ─────────────────────────────────────────────────
    const [appRows] = await conn.execute(`
      SELECT appKey, displayName, authType, isActive
      FROM apps
      ORDER BY appKey
    `);
    const allDbKeys = new Set(appRows.map((r) => r.appKey));
    const activeDbKeys = new Set(appRows.filter((r) => r.isActive).map((r) => r.appKey));

    console.log(`\n[C] apps table rows (${appRows.length} total, ${activeDbKeys.size} active):`);
    for (const row of appRows) {
      const status = row.isActive ? "✓ active" : "✗ inactive";
      console.log(`    ${status}  ${row.appKey} (${row.authType})  "${row.displayName}"`);
    }

    // ── Cross-check: all live appKeys must be in apps (active) ──────────────────
    const allLiveKeys = new Set([...twKeys, ...dtKeys]);
    const missingFromApps = [...allLiveKeys].filter((k) => !activeDbKeys.has(k));
    const inactiveInApps  = [...allLiveKeys].filter((k) => allDbKeys.has(k) && !activeDbKeys.has(k));

    console.log("\n─── CROSS-CHECK: live appKeys vs apps table ───");
    if (missingFromApps.length === 0) {
      console.log("    ✓ All live appKeys covered by active apps rows");
    } else {
      console.error(`    ✗ MISSING from apps (active):  ${missingFromApps.join(", ")}`);
      exitCode = 1;
    }
    if (inactiveInApps.length > 0) {
      console.error(`    ✗ FOUND but inactive in apps:  ${inactiveInApps.join(", ")}`);
      exitCode = 1;
    }

    // ── Required core appKeys ─────────────────────────────────────────────────
    console.log("\n─── REQUIRED CORE KEYS ───");
    const missingRequired = REQUIRED_APP_KEYS.filter((k) => !activeDbKeys.has(k));
    if (missingRequired.length === 0) {
      console.log("    ✓ All required core appKeys present and active");
    } else {
      console.error(`    ✗ Missing required core keys: ${missingRequired.join(", ")}`);
      exitCode = 1;
    }

    // ── Minimum row count ─────────────────────────────────────────────────────
    if (activeDbKeys.size < 1) {
      console.error("    ✗ apps table has 0 active rows — cannot proceed");
      exitCode = 1;
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log("\n═══════════════════════════════════════");
    const coverageOk = exitCode === 0;
    const result = {
      coverageOk,
      activeAppsCount: activeDbKeys.size,
      liveKeysCovered: allLiveKeys.size,
      missingFromApps,
      missingRequired,
      resolveSpecSafeStatus: coverageOk ? "DB-ONLY — safe" : "STOP — fix missing keys first",
    };
    console.log(JSON.stringify(result, null, 2));

    if (coverageOk) {
      console.log("\n✓ AUDIT PASSED — system is DB-only, no TS fallback needed");
    } else {
      console.error("\n✗ AUDIT FAILED — STOP. Insert missing rows into apps before proceeding.");
      console.error("  Use: railway run --service targenix.uz node tooling/mysql/admin-seed-missing-apps.mjs");
    }
  } finally {
    await conn.end();
  }

  process.exit(exitCode);
}

run().catch((err) => {
  console.error("AUDIT CRASHED:", err.message);
  process.exit(1);
});
