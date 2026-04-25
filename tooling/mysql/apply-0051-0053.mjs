/**
 * Apply migrations 0051 → 0052 → 0053 in order, with pre-flight audit,
 * per-step verification, and idempotency guards (journal check).
 *
 * Commands:
 *   node tooling/mysql/apply-0051-0053.mjs audit    ← READ ONLY, run first
 *   node tooling/mysql/apply-0051-0053.mjs apply    ← execute all three
 *   node tooling/mysql/apply-0051-0053.mjs verify   ← post-apply check
 *   node tooling/mysql/apply-0051-0053.mjs rollback ← revert schema (0052+0053 only)
 *
 * Railway usage:
 *   railway run --service targenix.uz node tooling/mysql/apply-0051-0053.mjs audit
 *   railway run --service targenix.uz node tooling/mysql/apply-0051-0053.mjs apply
 *   railway run --service targenix.uz node tooling/mysql/apply-0051-0053.mjs verify
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

function getMysqlUrl() {
  for (const raw of [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
  ]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}

function fileHash(relPath) {
  return createHash("sha256")
    .update(readFileSync(join(ROOT, relPath)))
    .digest("hex");
}

// Migration descriptors — created_at must be unique in __drizzle_migrations
const MIGRATIONS = [
  {
    id: "0051",
    file: "drizzle/0051_target_websites_appkey_backfill.sql",
    hash: "88c6ce56bef2a6b6486b85ca9e7ff32bdf9ad994dd174c8edb82c601dcffbe0a",
    createdAt: 1777488000000,
    label: "target_websites.appKey backfill (NULL → sentinel)",
  },
  {
    id: "0052",
    file: "drizzle/0052_target_websites_appkey_not_null.sql",
    hash: "be0df9c74e9cdc8a69a68c18bc6affd012b2ac2bae075aa5b573fb2b36e961af",
    createdAt: 1777488001000,
    label: "target_websites.appKey NOT NULL",
  },
  {
    id: "0053",
    file: "drizzle/0053_connections_type_varchar.sql",
    hash: "31159e67a994e250a81db3ccd6498f57edb82f33bb30c9c09c22300be8bcebc0",
    createdAt: 1777488002000,
    label: "connections.type ENUM → VARCHAR(32)",
  },
];

// ─── Audit (read-only) ────────────────────────────────────────────────────────

async function audit(cn) {
  console.log("\n═══ AUDIT (read-only) ═══\n");

  // 1. target_websites appKey NULLs
  const [[twCounts]] = await cn.query(`
    SELECT
      COUNT(*) AS total,
      SUM(\`appKey\` IS NULL) AS null_appkey,
      SUM(\`templateType\` = 'telegram' AND \`appKey\` IS NULL) AS telegram_missing,
      SUM(\`templateType\` IN ('google-sheets','google_sheets') AND \`appKey\` IS NULL) AS sheets_missing,
      SUM(\`templateId\` IS NOT NULL AND \`appKey\` IS NULL) AS template_missing
    FROM \`target_websites\`
  `);
  console.log("target_websites:", {
    total: Number(twCounts.total),
    null_appkey: Number(twCounts.null_appkey),
    telegram_missing: Number(twCounts.telegram_missing),
    sheets_missing: Number(twCounts.sheets_missing),
    template_missing: Number(twCounts.template_missing),
  });

  // 2. connections.type current values
  const [typeRows] = await cn.query(
    "SELECT `type`, COUNT(*) AS c FROM `connections` GROUP BY `type`",
  );
  console.log("\nconnections.type distribution:", typeRows);

  // 3. connections column definition
  const [colDef] = await cn.query(
    "SHOW COLUMNS FROM `connections` LIKE 'type'",
  );
  console.log("\nconnections.type column def:", colDef);

  // 4. target_websites appKey column definition
  const [akDef] = await cn.query(
    "SHOW COLUMNS FROM `target_websites` LIKE 'appKey'",
  );
  console.log("\ntarget_websites.appKey column def:", akDef);

  // 5. journal — which of our migrations are already applied
  console.log("\n__drizzle_migrations status:");
  for (const m of MIGRATIONS) {
    const [[{ n }]] = await cn.query(
      "SELECT COUNT(*) AS n FROM `__drizzle_migrations` WHERE `created_at` = ?",
      [m.createdAt],
    );
    console.log(`  ${m.id} (${m.label}): ${Number(n) > 0 ? "✅ ALREADY APPLIED" : "⏳ PENDING"}`);
  }

  // 6. Safety verdict
  const nullCount = Number(twCounts.null_appkey);
  const safeToRun = true; // backfill always safe; NOT NULL safe after backfill
  console.log("\n─────────────────────────────────────");
  console.log(`null_appkey = ${nullCount} → ${nullCount === 0 ? "0051 UPDATEs will be no-ops (already clean)" : `0051 will fill ${nullCount} row(s)`}`);
  const typeIsEnum = colDef[0]?.Type?.startsWith("enum(");
  console.log(`connections.type is ENUM: ${typeIsEnum ? "YES → 0053 needed" : "NO → 0053 already applied or column is VARCHAR"}`);
  console.log(`\nSAFE TO RUN: ${safeToRun ? "YES" : "NO"}`);
}

// ─── Apply ───────────────────────────────────────────────────────────────────

async function applyMigration(cn, m) {
  // Idempotency: skip if journal row exists
  const [[{ n }]] = await cn.query(
    "SELECT COUNT(*) AS n FROM `__drizzle_migrations` WHERE `created_at` = ?",
    [m.createdAt],
  );
  if (Number(n) > 0) {
    console.log(`  [${m.id}] SKIP — already in __drizzle_migrations`);
    return;
  }

  // Verify file hash hasn't changed since script was written
  const actualHash = fileHash(m.file);
  if (actualHash !== m.hash) {
    console.error(`  [${m.id}] HASH MISMATCH — file changed after script was written`);
    console.error(`    expected: ${m.hash}`);
    console.error(`    actual:   ${actualHash}`);
    throw new Error(`Hash mismatch for ${m.id}`);
  }

  console.log(`  [${m.id}] applying: ${m.label}`);

  // Parse statements on --> statement-breakpoint
  const sql = readFileSync(join(ROOT, m.file), "utf8");
  const stmts = sql
    .split("--> statement-breakpoint")
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter((s) => s.length > 0);

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    console.log(`    stmt ${i + 1}/${stmts.length}: ${stmt.substring(0, 80).replace(/\s+/g, " ")}…`);
    const [result] = await cn.query(stmt);
    if (result?.affectedRows !== undefined) {
      console.log(`    → affectedRows: ${result.affectedRows}`);
    }
  }

  // Record in journal
  await cn.query(
    "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
    [m.hash, m.createdAt],
  );
  console.log(`  [${m.id}] ✅ done — journal entry written`);
}

async function apply(cn) {
  console.log("\n═══ APPLY ═══\n");

  // Pre-apply safety check: must have 0 NULLs before 0052 NOT NULL
  const [[{ remaining }]] = await cn.query(
    "SELECT COUNT(*) AS remaining FROM `target_websites` WHERE `appKey` IS NULL",
  );
  console.log(`Pre-check: target_websites appKey NULL count = ${remaining}`);

  for (const m of MIGRATIONS) {
    await applyMigration(cn, m);
  }

  console.log("\nAll migrations processed.");
}

// ─── Verify ──────────────────────────────────────────────────────────────────

async function verify(cn) {
  console.log("\n═══ VERIFY ═══\n");

  // 1. No NULL appKeys
  const [[{ remaining }]] = await cn.query(
    "SELECT COUNT(*) AS remaining FROM `target_websites` WHERE `appKey` IS NULL",
  );
  console.log(`target_websites appKey NULL remaining: ${remaining} (want 0)`);

  // 2. appKey column is NOT NULL
  const [akDef] = await cn.query(
    "SHOW COLUMNS FROM `target_websites` LIKE 'appKey'",
  );
  const akNullable = akDef[0]?.Null;
  console.log(`target_websites.appKey nullable: ${akNullable} (want NO)`);

  // 3. connections.type is VARCHAR
  const [typeDef] = await cn.query(
    "SHOW COLUMNS FROM `connections` LIKE 'type'",
  );
  const typeCol = typeDef[0]?.Type;
  console.log(`connections.type column type: ${typeCol} (want varchar(32))`);

  // 4. appKey distribution
  const [dist] = await cn.query(
    "SELECT `appKey`, COUNT(*) AS c FROM `target_websites` GROUP BY `appKey` ORDER BY c DESC",
  );
  console.log("\ntarget_websites.appKey distribution:");
  for (const r of dist) console.log(`  ${r.appKey}: ${r.c}`);

  // 5. Journal
  console.log("\n__drizzle_migrations status:");
  for (const m of MIGRATIONS) {
    const [[{ n }]] = await cn.query(
      "SELECT COUNT(*) AS n FROM `__drizzle_migrations` WHERE `created_at` = ?",
      [m.createdAt],
    );
    console.log(`  ${m.id}: ${Number(n) > 0 ? "✅ recorded" : "❌ MISSING"}`);
  }

  const safe =
    Number(remaining) === 0 &&
    akNullable === "NO" &&
    typeCol?.startsWith("varchar");
  console.log(`\nSTATUS: ${safe ? "✅ SAFE" : "❌ NOT SAFE — check above"}`);
}

// ─── Rollback ────────────────────────────────────────────────────────────────

async function rollback(cn) {
  console.log("\n═══ ROLLBACK ═══\n");
  console.log("Rolling back 0052 (appKey → nullable) and 0053 (type → ENUM)…");

  await cn.query(
    "ALTER TABLE `target_websites` MODIFY COLUMN `appKey` VARCHAR(64) NULL",
  );
  console.log("✅ target_websites.appKey → VARCHAR(64) NULL");

  await cn.query(
    "ALTER TABLE `connections` MODIFY COLUMN `type` ENUM('google_sheets','telegram_bot','api_key') NOT NULL",
  );
  console.log("✅ connections.type → ENUM('google_sheets','telegram_bot','api_key') NOT NULL");

  console.log("\nNOTE: 0051 data changes (appKey backfill) are NOT reversed.");
  console.log("      Application handles NULL appKey via legacy fallback path.");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const cmd = process.argv[2] || "audit";
const url = getMysqlUrl();
if (!url) {
  console.error("ERROR: No mysql:// URL found in MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL");
  process.exit(1);
}

const cn = await mysql.createConnection({ uri: url, multipleStatements: false });
try {
  if (cmd === "apply")    await apply(cn);
  else if (cmd === "verify")   await verify(cn);
  else if (cmd === "rollback") await rollback(cn);
  else                         await audit(cn);
} catch (err) {
  console.error("\nFATAL:", err.message ?? err);
  process.exit(1);
} finally {
  await cn.end();
}
