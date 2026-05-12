import mysql from "mysql2/promise";

const id = Number(process.argv[2]);
if (!Number.isInteger(id) || id <= 0) {
  console.error("Usage: node verify-integration-dedup.mjs <integration_id>");
  process.exit(1);
}

const url = process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url || !url.startsWith("mysql://")) {
  console.error("No mysql:// URL in env");
  process.exit(1);
}

const DUPLICATE_KEYS = ["pageId", "formId", "pageName", "formName", "facebookAccountId", "targetWebsiteId"];
const EXPECTED_JSON_KEYS = ["fieldMappings", "nameField", "phoneField", "targetWebsiteName", "targetTemplateType", "variableFields"];

const conn = await mysql.createConnection(url);
try {
  const [rows] = await conn.query(
    `SELECT id, type, name, pageId, formId, pageName, formName, facebookAccountId, targetWebsiteId,
            JSON_KEYS(config) AS json_keys
     FROM integrations WHERE id = ?`,
    [id],
  );
  if (rows.length === 0) {
    console.error(`Integration id=${id} not found`);
    process.exit(2);
  }
  const r = rows[0];

  console.log(`=== Integration #${r.id} (${r.name}) ===`);
  console.log(`type: ${r.type}\n`);

  console.log("Dedicated columns:");
  for (const col of DUPLICATE_KEYS) {
    const v = r[col];
    const ok = v != null && v !== "";
    console.log(`  ${ok ? "[OK]" : "[MISS]"} ${col}: ${v ?? "NULL"}`);
  }

  // mysql2 auto-parses JSON columns, so JSON_KEYS may return either a parsed array
  // or a string depending on driver mode.
  const jsonKeys = Array.isArray(r.json_keys)
    ? r.json_keys
    : JSON.parse(r.json_keys);
  console.log(`\nJSON keys (${jsonKeys.length}): ${jsonKeys.join(", ")}\n`);

  console.log("Duplicate-key check (these MUST NOT be in JSON):");
  let leakedCount = 0;
  for (const k of DUPLICATE_KEYS) {
    const leaked = jsonKeys.includes(k);
    console.log(`  ${leaked ? "[FAIL]" : "[OK]"} ${k}: ${leaked ? "STILL IN JSON" : "absent"}`);
    if (leaked) leakedCount++;
  }

  console.log("\nExpected JSON keys (should be present):");
  let missingExpected = 0;
  for (const k of EXPECTED_JSON_KEYS) {
    const present = jsonKeys.includes(k);
    console.log(`  ${present ? "[OK]" : "[WARN]"} ${k}: ${present ? "present" : "missing"}`);
    if (!present) missingExpected++;
  }

  console.log("\n=== Verdict ===");
  if (leakedCount === 0) {
    console.log("PASS: no duplicate keys leaked into config JSON");
  } else {
    console.log(`FAIL: ${leakedCount} duplicate key(s) still in JSON`);
  }
  if (missingExpected > 0) {
    console.log(`NOTE: ${missingExpected} expected JSON key(s) missing (may be fine depending on wizard inputs)`);
  }

  process.exit(leakedCount === 0 ? 0 : 1);
} finally {
  await conn.end();
}
