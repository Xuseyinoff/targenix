/**
 * Diagnostic: look up the "testga" Google Sheets destination (user 2)
 * and print its connection + stored sheet name, so we can see why the
 * append fails with "Unable to parse range: 'Sheet1'!A:Z".
 *
 *   railway run node tooling/check-testga-destination.mjs
 */
import mysql from "mysql2/promise";

function pickMysqlUrl() {
  const candidates = [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
  ];
  for (const [k, v] of Object.entries(process.env)) {
    const name = k.replace(/\r/g, "").trim();
    if (
      (name === "MYSQL_PUBLIC_URL" || name === "MYSQL_URL") &&
      typeof v === "string" &&
      v.trim().startsWith("mysql://")
    ) {
      candidates.push(v.trim());
    }
  }
  return candidates.find((u) => typeof u === "string" && u.startsWith("mysql://") && !u.includes("railway.internal"));
}

const url = pickMysqlUrl();
if (!url) {
  console.error("No usable MYSQL URL found in env (need public endpoint, not railway.internal)");
  process.exit(1);
}

const conn = await mysql.createConnection(url);

const [destRows] = await conn.execute(
  `SELECT id, userId, name, templateType, templateConfig, connectionId, createdAt
     FROM target_websites
    WHERE userId = 2 AND (name = 'testga' OR templateType = 'google_sheets')
    ORDER BY id DESC
    LIMIT 20`
);

console.log(`\nFound ${destRows.length} destination row(s) for userId=2:\n`);
for (const row of destRows) {
  console.log(`── id=${row.id}  name="${row.name}"  template=${row.templateType}  connectionId=${row.connectionId ?? "null"}  createdAt=${row.createdAt}`);
  try {
    const cfg = typeof row.templateConfig === "string" ? JSON.parse(row.templateConfig) : row.templateConfig;
    console.log(`   config:`, {
      googleAccountId: cfg?.googleAccountId ?? null,
      spreadsheetId:   cfg?.spreadsheetId ?? null,
      sheetName:       cfg?.sheetName ?? null,
      sheetHeaders:    cfg?.sheetHeaders ?? null,
      mappingKeys:     cfg?.mapping ? Object.keys(cfg.mapping) : null,
    });
  } catch (e) {
    console.log(`   config parse error: ${e.message}`);
  }
}

const [accts] = await conn.execute(
  `SELECT id, userId, email, appKey, createdAt
     FROM oauth_tokens WHERE userId = 2 AND appKey = 'google-sheets' ORDER BY id DESC LIMIT 10`
);
console.log(`\nGoogle oauth_tokens for userId=2: ${accts.length}`);
for (const a of accts) {
  console.log(`   oauth_tokens.id=${a.id}  email=${a.email}  appKey=${a.appKey}`);
}

const [connRows] = await conn.execute(
  `SELECT id, userId, type, oauthTokenId, displayName, status, createdAt
     FROM connections WHERE userId = 2 ORDER BY id DESC LIMIT 10`
);
console.log(`\nconnections rows for userId=2: ${connRows.length}`);
for (const c of connRows) {
  console.log(`   connections.id=${c.id}  type=${c.type}  oauthTokenId=${c.oauthTokenId ?? "null"}  display="${c.displayName}"  status=${c.status}`);
}

await conn.end();
