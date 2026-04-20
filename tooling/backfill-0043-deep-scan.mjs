/**
 * Deep scan — look for any row (regardless of templateType) that has
 * googleAccountId / botTokenEncrypted / chatId in its templateConfig.
 * Purely read-only; no writes.
 */

import "dotenv/config";
import mysql from "mysql2/promise";

const url = [
  process.env.MYSQL_PUBLIC_URL,
  process.env.DATABASE_URL,
  process.env.MYSQL_URL,
]
  .map((u) => u?.trim().replace(/^=+/, ""))
  .find((u) => u?.startsWith("mysql://"));

if (!url) {
  console.error("No DB URL");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

console.log("\n=== Deep scan — all target_websites templateConfig fields ===\n");

const [rows] = await conn.execute(`
  SELECT
    id,
    userId,
    name,
    templateType,
    JSON_EXTRACT(templateConfig, '$.googleAccountId')  AS gAcc,
    JSON_EXTRACT(templateConfig, '$.botTokenEncrypted') AS bot,
    JSON_EXTRACT(templateConfig, '$.chatId')           AS chatId,
    JSON_EXTRACT(templateConfig, '$.spreadsheetId')    AS spread,
    JSON_EXTRACT(templateConfig, '$.apiKeyEncrypted')  AS apiKey,
    JSON_EXTRACT(templateConfig, '$.secrets')          AS dynSecrets,
    connectionId
  FROM target_websites
  ORDER BY id
`);

console.log("id  userId  templateType     gAcc        bot?      chatId      spread?    apiKey?   secrets?  connId");
console.log("──  ──────  ───────────────  ──────────  ────────  ──────────  ─────────  ────────  ────────  ──────");

let anyHit = false;
for (const r of rows) {
  const hasG   = r.gAcc != null;
  const hasB   = r.bot != null;
  const hasC   = r.chatId != null;
  const hasS   = r.spread != null;
  const hasAK  = r.apiKey != null;
  const hasDyn = r.dynSecrets != null;
  if (hasG || hasB || hasC) anyHit = true;

  console.log(
    String(r.id).padEnd(4) +
    String(r.userId).padEnd(8) +
    String(r.templateType).padEnd(17) +
    String(hasG ? r.gAcc : "—").padEnd(12) +
    String(hasB ? "yes" : "—").padEnd(10) +
    String(hasC ? r.chatId : "—").padEnd(12) +
    String(hasS ? "yes" : "—").padEnd(11) +
    String(hasAK ? "yes" : "—").padEnd(10) +
    String(hasDyn ? "yes" : "—").padEnd(10) +
    String(r.connectionId ?? "—")
  );
}

console.log("");
if (!anyHit) {
  console.log("✅ No row (of any templateType) contains googleAccountId / botTokenEncrypted / chatId in templateConfig.");
  console.log("   → Nothing to backfill on this DB.");
} else {
  console.log("⚠️  Some rows have connection-like fields despite templateType not being google-sheets/telegram.");
  console.log("   Review before running backfill.");
}

console.log(`\nTotal rows scanned: ${rows.length}\n`);

await conn.end();
