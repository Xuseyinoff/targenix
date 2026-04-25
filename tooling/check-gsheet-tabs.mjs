/**
 * Diagnostic: print the actual tab titles inside user 2's spreadsheet
 * `1BI1UMnV6fUSkDLVSLU8m-CYm1o7TgCU3Dzr3hgmqWeY`, so we know what value
 * `sheetName` should have.
 *
 *   railway run node tooling/check-gsheet-tabs.mjs
 *
 * Pulls the integration OAuth token from oauth_tokens.id=3 (appKey=google-sheets), refreshes
 * it if expired, then GETs /v4/spreadsheets/{id}?fields=sheets.properties.title.
 */
import mysql from "mysql2/promise";
import crypto from "node:crypto";

const SPREADSHEET_ID = "1BI1UMnV6fUSkDLVSLU8m-CYm1o7TgCU3Dzr3hgmqWeY";
const OAUTH_TOKEN_ID = 3;

function pickMysqlUrl() {
  const env = process.env;
  const ordered = [env.MYSQL_PUBLIC_URL, env.MYSQL_URL, env.DATABASE_URL];
  for (const [k, v] of Object.entries(env)) {
    const name = k.replace(/\r/g, "").trim();
    if ((name === "MYSQL_PUBLIC_URL" || name === "MYSQL_URL") && typeof v === "string") {
      ordered.push(v.trim());
    }
  }
  return ordered.find((u) => typeof u === "string" && u.startsWith("mysql://") && !u.includes("railway.internal"));
}

// Mirrors server/encryption.ts — AES-256-CBC, sha256(raw) key, "iv_hex:cipher_hex".
function decrypt(cipherText, rawKey) {
  const key = crypto.createHash("sha256").update(rawKey).digest();
  const [ivHex, encHex] = String(cipherText).split(":");
  if (!ivHex || !encHex) throw new Error("Invalid ciphertext format");
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const d = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const url = pickMysqlUrl();
if (!url) { console.error("No usable MYSQL URL"); process.exit(1); }
const encKey = (process.env.ENCRYPTION_KEY || "").trim();
if (!encKey) { console.error("No ENCRYPTION_KEY in env"); process.exit(1); }

const conn = await mysql.createConnection(url);
const [rows] = await conn.execute(
  `SELECT id, email, accessTokenEncrypted, refreshTokenEncrypted, expiresAt
     FROM oauth_tokens WHERE id = ? AND appKey = 'google-sheets' LIMIT 1`,
  [OAUTH_TOKEN_ID],
);
await conn.end();
if (rows.length === 0) { console.error("oauth_tokens row not found"); process.exit(1); }
const acct = rows[0];

console.log(`Using oauth_tokens.id=${acct.id} email=${acct.email}`);
let accessToken = decrypt(acct.accessTokenEncrypted, encKey);
const refreshToken = acct.refreshTokenEncrypted ? decrypt(acct.refreshTokenEncrypted, encKey) : null;
const expiresAt = acct.expiresAt ? new Date(Number(acct.expiresAt)) : null;
const expired = expiresAt ? expiresAt.getTime() - Date.now() < 60_000 : false;

if (expired) {
  if (!refreshToken) { console.error("token expired and no refresh token available"); process.exit(1); }
  console.log("Access token expired — refreshing...");
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || "",
    client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!r.ok) { console.error("Refresh failed:", j); process.exit(1); }
  accessToken = j.access_token;
  console.log(`Refreshed. New token expires in ${j.expires_in}s.`);
}

const u = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SPREADSHEET_ID)}`);
u.searchParams.set("fields", "sheets.properties.title,properties.title");
const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
const text = await res.text();
console.log(`\nGET spreadsheets.get → HTTP ${res.status}`);
if (!res.ok) { console.error(text); process.exit(1); }
const data = JSON.parse(text);
console.log(`\nSpreadsheet title: "${data.properties?.title ?? "(unknown)"}"`);
console.log(`\nTab titles (${data.sheets?.length ?? 0}):`);
for (const s of data.sheets ?? []) {
  console.log(`   - "${s.properties?.title}"`);
}
