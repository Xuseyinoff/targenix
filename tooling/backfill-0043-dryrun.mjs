/**
 * DRY RUN — Step 2 backfill planner.
 *
 * Reads target_websites + connections tables, analyzes what would be migrated,
 * and prints planned INSERT / UPDATE queries.
 *
 * DOES NOT modify anything. Read-only.
 */

import "dotenv/config";
import mysql from "mysql2/promise";

const candidates = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_URL,
  process.env.MYSQL_URL,
];
const url = candidates
  .map((u) => u?.trim().replace(/^=+/, ""))
  .find((u) => u?.startsWith("mysql://"));

if (!url) {
  console.error("No DB URL found");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

// ─── helpers ─────────────────────────────────────────────────────────────────

function truncate(s, n = 18) {
  if (s == null) return "null";
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n) + "…";
}

function preview(obj) {
  if (obj == null) return "null";
  try {
    const s = JSON.stringify(obj);
    return s.length <= 120 ? s : s.slice(0, 120) + "…";
  } catch {
    return String(obj);
  }
}

// ─── 0. TOTALS ────────────────────────────────────────────────────────────────

console.log("═══════════════════════════════════════════════════════════════════");
console.log("  STEP 2 — DRY RUN (read-only, no writes)");
console.log("═══════════════════════════════════════════════════════════════════");

const [[{ total }]] = await conn.execute("SELECT COUNT(*) AS total FROM target_websites");
console.log(`\nTotal target_websites rows: ${total}`);

const [byType] = await conn.execute(
  "SELECT templateType, COUNT(*) AS n FROM target_websites GROUP BY templateType ORDER BY n DESC"
);
console.log("\nBreakdown by templateType:");
for (const r of byType) console.log(`  ${String(r.templateType).padEnd(16)} ${r.n}`);

// Already-migrated check
const [[{ already }]] = await conn.execute(
  "SELECT COUNT(*) AS already FROM target_websites WHERE connectionId IS NOT NULL"
);
console.log(`\nRows with connectionId already set: ${already} (expected: 0 on first run)`);

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────

console.log("\n───────────────────────────────────────────────────────────────────");
console.log("  GOOGLE SHEETS");
console.log("───────────────────────────────────────────────────────────────────");

const [sheetsRows] = await conn.execute(`
  SELECT
    id,
    userId,
    name,
    templateConfig,
    connectionId
  FROM target_websites
  WHERE templateType = 'google-sheets'
`);

console.log(`Rows with templateType='google-sheets': ${sheetsRows.length}`);

const sheetsWithAccountId = [];
const sheetsMissingAccountId = [];
const sheetsAlreadyLinked = [];

for (const row of sheetsRows) {
  if (row.connectionId != null) {
    sheetsAlreadyLinked.push(row);
    continue;
  }
  const cfg = row.templateConfig ?? {};
  const rawGid = cfg.googleAccountId;
  const gid =
    typeof rawGid === "number" && Number.isFinite(rawGid)
      ? rawGid
      : typeof rawGid === "string" && rawGid.trim() !== ""
        ? parseInt(rawGid.trim(), 10)
        : NaN;

  if (!Number.isFinite(gid) || gid < 1) {
    sheetsMissingAccountId.push(row);
  } else {
    sheetsWithAccountId.push({ row, googleAccountId: gid });
  }
}

console.log(`  → valid googleAccountId       : ${sheetsWithAccountId.length}`);
console.log(`  → missing/invalid accountId   : ${sheetsMissingAccountId.length}`);
console.log(`  → already linked (skip)       : ${sheetsAlreadyLinked.length}`);

// Check if google_accounts still exists for each
const sheetPlan = [];
for (const { row, googleAccountId } of sheetsWithAccountId) {
  const [[gAcc]] = await conn.execute(
    "SELECT id, userId, email, type FROM google_accounts WHERE id = ? LIMIT 1",
    [googleAccountId]
  );
  if (!gAcc) {
    sheetPlan.push({ row, googleAccountId, status: "ORPHAN_GOOGLE_ACCOUNT" });
    continue;
  }
  if (gAcc.userId !== row.userId) {
    sheetPlan.push({
      row, googleAccountId, status: "OWNER_MISMATCH",
      note: `target_websites.userId=${row.userId}, google_accounts.userId=${gAcc.userId}`,
    });
    continue;
  }
  if (gAcc.type !== "integration") {
    sheetPlan.push({
      row, googleAccountId, status: "NOT_INTEGRATION_TYPE",
      note: `google_accounts.type='${gAcc.type}' (expected 'integration')`,
    });
    continue;
  }

  // Find existing connection to dedupe (re-run safety)
  const [[existingConn]] = await conn.execute(
    `SELECT id FROM connections
     WHERE userId = ? AND type = 'google_sheets' AND googleAccountId = ?
     LIMIT 1`,
    [row.userId, googleAccountId]
  );

  sheetPlan.push({
    row,
    googleAccountId,
    googleAccount: gAcc,
    existingConnectionId: existingConn?.id ?? null,
    status: "OK",
  });
}

const sheetsToInsert = sheetPlan.filter((p) => p.status === "OK" && !p.existingConnectionId);
const sheetsToReuse  = sheetPlan.filter((p) => p.status === "OK" &&  p.existingConnectionId);
const sheetsIssues   = sheetPlan.filter((p) => p.status !== "OK");

console.log(`\nGoogle Sheets PLAN:`);
console.log(`  INSERT new connections : ${sheetsToInsert.length}`);
console.log(`  REUSE existing conn    : ${sheetsToReuse.length}`);
console.log(`  ISSUES (skip + report) : ${sheetsIssues.length}`);

if (sheetsIssues.length) {
  console.log(`\n  Issues detail (up to 5):`);
  for (const p of sheetsIssues.slice(0, 5)) {
    console.log(`    twId=${p.row.id} userId=${p.row.userId} status=${p.status} ${p.note ?? ""}`);
  }
}

// Sample queries
console.log(`\n  Sample planned queries (Google Sheets, up to 2 INSERT + 2 UPDATE):`);
for (const p of sheetsToInsert.slice(0, 2)) {
  const displayName = `Google Sheets (${p.googleAccount.email})`;
  console.log(`\n  -- for target_websites.id=${p.row.id} (userId=${p.row.userId})`);
  console.log(
    `  INSERT INTO connections (userId, type, displayName, status, googleAccountId, credentialsJson, createdAt, updatedAt)`
  );
  console.log(
    `    VALUES (${p.row.userId}, 'google_sheets', ${JSON.stringify(displayName)}, 'active', ${p.googleAccountId}, NULL, NOW(), NOW());`
  );
  console.log(
    `  UPDATE target_websites SET connectionId = <LAST_INSERT_ID()> WHERE id = ${p.row.id} AND connectionId IS NULL;`
  );
}
for (const p of sheetsToReuse.slice(0, 2)) {
  console.log(`\n  -- reuse existing connectionId=${p.existingConnectionId} for twId=${p.row.id}`);
  console.log(
    `  UPDATE target_websites SET connectionId = ${p.existingConnectionId} WHERE id = ${p.row.id} AND connectionId IS NULL;`
  );
}

// ─── TELEGRAM ────────────────────────────────────────────────────────────────

console.log("\n───────────────────────────────────────────────────────────────────");
console.log("  TELEGRAM");
console.log("───────────────────────────────────────────────────────────────────");

const [tgRows] = await conn.execute(`
  SELECT
    id,
    userId,
    name,
    templateConfig,
    connectionId
  FROM target_websites
  WHERE templateType = 'telegram'
`);

console.log(`Rows with templateType='telegram': ${tgRows.length}`);

const tgPlan = [];
for (const row of tgRows) {
  if (row.connectionId != null) {
    tgPlan.push({ row, status: "ALREADY_LINKED" });
    continue;
  }
  const cfg = row.templateConfig ?? {};
  const botTokenEncrypted = typeof cfg.botTokenEncrypted === "string" ? cfg.botTokenEncrypted : null;
  const chatId = typeof cfg.chatId === "string" ? cfg.chatId : null;

  if (!botTokenEncrypted || !chatId) {
    tgPlan.push({ row, status: "MISSING_FIELDS", note: `botTokenEncrypted=${!!botTokenEncrypted}, chatId=${!!chatId}` });
    continue;
  }

  // Dedupe by (userId + botTokenEncrypted + chatId) stored in credentialsJson
  // We compare on botTokenEncrypted+chatId to avoid creating two connections for the same bot/chat combo.
  const [[existing]] = await conn.execute(
    `SELECT id FROM connections
     WHERE userId = ?
       AND type = 'telegram_bot'
       AND JSON_EXTRACT(credentialsJson, '$.botTokenEncrypted') = ?
       AND JSON_EXTRACT(credentialsJson, '$.chatId') = ?
     LIMIT 1`,
    [row.userId, botTokenEncrypted, chatId]
  );

  tgPlan.push({
    row,
    botTokenEncrypted,
    chatId,
    existingConnectionId: existing?.id ?? null,
    status: "OK",
  });
}

const tgToInsert = tgPlan.filter((p) => p.status === "OK" && !p.existingConnectionId);
const tgToReuse  = tgPlan.filter((p) => p.status === "OK" &&  p.existingConnectionId);
const tgIssues   = tgPlan.filter((p) => p.status !== "OK" && p.status !== "ALREADY_LINKED");
const tgSkipped  = tgPlan.filter((p) => p.status === "ALREADY_LINKED");

console.log(`\nTelegram PLAN:`);
console.log(`  INSERT new connections : ${tgToInsert.length}`);
console.log(`  REUSE existing conn    : ${tgToReuse.length}`);
console.log(`  ISSUES (skip + report) : ${tgIssues.length}`);
console.log(`  ALREADY_LINKED (skip)  : ${tgSkipped.length}`);

if (tgIssues.length) {
  console.log(`\n  Issues detail (up to 5):`);
  for (const p of tgIssues.slice(0, 5)) {
    console.log(`    twId=${p.row.id} userId=${p.row.userId} status=${p.status} ${p.note ?? ""}`);
  }
}

console.log(`\n  Sample planned queries (Telegram, up to 2 INSERT + 2 UPDATE):`);
for (const p of tgToInsert.slice(0, 2)) {
  const displayName = `Telegram bot → chat ${truncate(p.chatId, 18)}`;
  const credsPreview = { botTokenEncrypted: "«encrypted, masked in log»", chatId: p.chatId };
  console.log(`\n  -- for target_websites.id=${p.row.id} (userId=${p.row.userId})`);
  console.log(
    `  INSERT INTO connections (userId, type, displayName, status, googleAccountId, credentialsJson, createdAt, updatedAt)`
  );
  console.log(
    `    VALUES (${p.row.userId}, 'telegram_bot', ${JSON.stringify(displayName)}, 'active', NULL, '${JSON.stringify(credsPreview)}', NOW(), NOW());`
  );
  console.log(
    `  UPDATE target_websites SET connectionId = <LAST_INSERT_ID()> WHERE id = ${p.row.id} AND connectionId IS NULL;`
  );
}
for (const p of tgToReuse.slice(0, 2)) {
  console.log(`\n  -- reuse existing connectionId=${p.existingConnectionId} for twId=${p.row.id}`);
  console.log(
    `  UPDATE target_websites SET connectionId = ${p.existingConnectionId} WHERE id = ${p.row.id} AND connectionId IS NULL;`
  );
}

// ─── RISKS SUMMARY ───────────────────────────────────────────────────────────

console.log("\n═══════════════════════════════════════════════════════════════════");
console.log("  SUMMARY & RISKS");
console.log("═══════════════════════════════════════════════════════════════════");

const totalInserts =
  sheetsToInsert.length + tgToInsert.length;
const totalUpdates =
  sheetsToInsert.length + sheetsToReuse.length + tgToInsert.length + tgToReuse.length;

console.log(`\nConnections that would be created:`);
console.log(`  google_sheets : ${sheetsToInsert.length}`);
console.log(`  telegram_bot  : ${tgToInsert.length}`);
console.log(`  TOTAL         : ${totalInserts}`);

console.log(`\ntarget_websites rows that would be updated (connectionId set):`);
console.log(`  google-sheets : ${sheetsToInsert.length + sheetsToReuse.length}`);
console.log(`  telegram      : ${tgToInsert.length + tgToReuse.length}`);
console.log(`  TOTAL         : ${totalUpdates}`);

console.log(`\nRisks detected:`);
const risks = [];
if (sheetsIssues.some((p) => p.status === "ORPHAN_GOOGLE_ACCOUNT"))
  risks.push("• Orphan googleAccountId in templateConfig (google_accounts row deleted). SKIPPED.");
if (sheetsIssues.some((p) => p.status === "OWNER_MISMATCH"))
  risks.push("• Owner mismatch between target_websites.userId and google_accounts.userId. SKIPPED.");
if (sheetsIssues.some((p) => p.status === "NOT_INTEGRATION_TYPE"))
  risks.push("• googleAccountId points to a 'login'-type account (not integration). SKIPPED.");
if (sheetsMissingAccountId.length)
  risks.push(`• ${sheetsMissingAccountId.length} google-sheets row(s) have no googleAccountId. Cannot backfill. Delivery already broken; needs manual fix.`);
if (tgIssues.some((p) => p.status === "MISSING_FIELDS"))
  risks.push("• Telegram row missing botTokenEncrypted or chatId. SKIPPED (was broken already).");

if (risks.length === 0) {
  console.log("  ✅ No blocking risks detected.");
} else {
  for (const r of risks) console.log(`  ${r}`);
}

console.log(`\nSafety guarantees:`);
console.log(`  ✅ templateConfig will NOT be modified`);
console.log(`  ✅ connectionId is only set when currently NULL (no overwrite)`);
console.log(`  ✅ Dedupe via (userId, type, accountId/chat) prevents duplicate connections on re-run`);
console.log(`  ✅ Delivery logic unchanged — still reads from templateConfig`);

console.log("\n═══════════════════════════════════════════════════════════════════");
console.log("  DRY RUN COMPLETE — no writes performed.");
console.log("  Reply with \"APPROVE — RUN MIGRATION\" to proceed.");
console.log("═══════════════════════════════════════════════════════════════════\n");

await conn.end();
