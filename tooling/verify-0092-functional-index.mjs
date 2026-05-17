/**
 * Verify the functional unique index from migration 0092 actually enforces.
 * Wraps the test INSERTs in a transaction and rolls back — no DB pollution.
 */
import "dotenv/config";
import mysql from "mysql2/promise";
const conn = await mysql.createConnection({ uri: process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL });
let exitCode = 0;
try {
  // Confirm the index is registered
  const [idx] = await conn.query(`SHOW INDEX FROM integrations WHERE Key_name = 'uniq_integrations_live_form_dest'`);
  console.log("[verify] Index rows:");
  console.table(idx.map(r => ({ Key_name: r.Key_name, Non_unique: r.Non_unique, Column_name: r.Column_name, Expression: r.Expression })));
  if (idx.length === 0) { console.error("[verify] FAIL: index missing."); process.exit(1); }
  if (idx[0].Non_unique !== 0) { console.error("[verify] FAIL: index Non_unique != 0."); process.exit(1); }

  // Test: insert two identical (userId, formId, destinationId) rows in a transaction → second must fail
  await conn.beginTransaction();
  try {
    const testUser = 99999999; // safely high; doesn't exist in prod
    const testForm = "TARGENIX_DEDUP_TEST";
    const testDest = 99999999;
    await conn.query(
      `INSERT INTO integrations (userId, type, name, config, pageId, formId, destinationId, isActive)
       VALUES (?, 'LEAD_ROUTING', 'dedup-test-A', '{}', 'P', ?, ?, 1)`,
      [testUser, testForm, testDest],
    );
    console.log("[verify] First INSERT OK (expected).");
    let secondFailed = false;
    try {
      await conn.query(
        `INSERT INTO integrations (userId, type, name, config, pageId, formId, destinationId, isActive)
         VALUES (?, 'LEAD_ROUTING', 'dedup-test-B', '{}', 'P', ?, ?, 1)`,
        [testUser, testForm, testDest],
      );
    } catch (e) {
      secondFailed = true;
      console.log(`[verify] Second INSERT BLOCKED (expected). errno=${e.errno} code=${e.code}`);
      if (e.errno !== 1062) console.warn("[verify] WARN: expected errno=1062 (ER_DUP_ENTRY), got:", e.errno);
    }
    if (!secondFailed) {
      console.error("[verify] FAIL: second INSERT was allowed — index NOT enforcing.");
      exitCode = 1;
    }

    // Test: soft-deleted rows do NOT block a new live insert with same key
    await conn.query(`UPDATE integrations SET deletedAt = NOW() WHERE userId=? AND formId=? AND destinationId=?`, [testUser, testForm, testDest]);
    try {
      await conn.query(
        `INSERT INTO integrations (userId, type, name, config, pageId, formId, destinationId, isActive)
         VALUES (?, 'LEAD_ROUTING', 'dedup-test-C', '{}', 'P', ?, ?, 1)`,
        [testUser, testForm, testDest],
      );
      console.log("[verify] Re-insert after soft-delete OK (expected — soft-deleted rows have NULL dedup_key).");
    } catch (e) {
      console.error("[verify] FAIL: re-insert after soft-delete was BLOCKED. errno=", e.errno);
      exitCode = 1;
    }
  } finally {
    await conn.rollback();
    console.log("[verify] Transaction rolled back — no prod pollution.");
  }
} catch (err) {
  console.error("[verify] FATAL:", err.message);
  exitCode = 1;
} finally {
  await conn.end();
}
console.log(exitCode === 0 ? "\n[verify] PASS." : "\n[verify] FAIL.");
process.exit(exitCode);
