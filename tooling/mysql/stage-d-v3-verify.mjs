/**
 * Stage D v3 — POST-MIGRATION VERIFY.
 *
 * Reads every target_websites row flagged by the backup, decrypts each
 * `templateConfig.secrets.*` value with the CURRENT environment's
 * ENCRYPTION_KEY, and asserts the result equals the plaintext recorded
 * in the backup. Runs after `--apply` to prove the migration landed
 * cleanly AND that the production runtime's key still decodes it.
 *
 * Does NOT mutate the DB. Safe to run repeatedly.
 *
 * Invocation:
 *   railway run --service targenix.uz node \
 *     tooling/mysql/stage-d-v3-verify.mjs \
 *     --backup=<filename> \
 *     --expected-key-hash=<prod-hash>
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mysql from "mysql2/promise";

function abort(msg) {
  console.error(`[stage-d-v3-verify] ABORT: ${msg}`);
  process.exit(1);
}

if (!process.env.RAILWAY_PROJECT_ID) {
  abort("RAILWAY_PROJECT_ID missing — run via `railway run --service targenix.uz`.");
}
const rawKey = process.env.ENCRYPTION_KEY;
if (!rawKey) abort("ENCRYPTION_KEY missing.");
if (rawKey.length !== 32) abort(`ENCRYPTION_KEY length ${rawKey.length}; must be 32.`);

const mysqlUrl =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!mysqlUrl) abort("MYSQL_PUBLIC_URL / MYSQL_URL missing.");

const KEY_HASH = crypto.createHash("sha256").update(rawKey).digest("hex");

const args = process.argv.slice(2);
const value = (n) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const BACKUP_FILE = value("backup");
const EXPECTED_KEY_HASH = value("expected-key-hash");
if (!BACKUP_FILE) abort("--backup=<filename> required.");
if (!EXPECTED_KEY_HASH) abort("--expected-key-hash=<hex> required.");
if (EXPECTED_KEY_HASH !== KEY_HASH) {
  console.error(`live KEY_HASH     = ${KEY_HASH}`);
  console.error(`expected KEY_HASH = ${EXPECTED_KEY_HASH}`);
  abort("ENCRYPTION_KEY hash mismatch.");
}

function decryptValue(ct) {
  const [ivHex, encHex] = ct.split(":");
  if (!ivHex || !encHex) throw new Error("Invalid ciphertext format");
  const iv = Buffer.from(ivHex, "hex");
  const enc = Buffer.from(encHex, "hex");
  const k = crypto.createHash("sha256").update(rawKey).digest();
  const d = crypto.createDecipheriv("aes-256-cbc", k, iv);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const backup = JSON.parse(await fs.readFile(path.resolve(process.cwd(), BACKUP_FILE), "utf8"));
if (backup.stage !== "D-v3") abort(`Backup stage is "${backup.stage}", expected "D-v3".`);
if (backup.keyHash !== KEY_HASH) abort("Backup keyHash != live keyHash.");

console.log("─".repeat(72));
console.log(`  STAGE D v3 — POST-MIGRATION VERIFY`);
console.log(`  Backup   : ${BACKUP_FILE}`);
console.log(`  Rows     : ${backup.rows.length}`);
console.log(`  KEY_HASH : ${KEY_HASH}`);
console.log("─".repeat(72));

const conn = await mysql.createConnection(mysqlUrl);
let ok = 0;
let fail = 0;
try {
  for (const r of backup.rows) {
    const [rows] = await conn.query(
      "SELECT templateConfig FROM target_websites WHERE id = ?",
      [r.id],
    );
    if (!rows.length) {
      console.log(`  ✗ id=${r.id} row missing`);
      fail++;
      continue;
    }
    const stored = rows[0].templateConfig;
    const cfg = typeof stored === "string" ? JSON.parse(stored) : stored;

    let rowOk = true;
    for (const hit of r.hits) {
      const cipher = cfg?.secrets?.[hit.fieldKey];
      if (!cipher) {
        console.log(`  ✗ id=${r.id} secrets.${hit.fieldKey} missing`);
        rowOk = false;
        break;
      }
      let decrypted;
      try {
        decrypted = decryptValue(cipher);
      } catch (err) {
        console.log(`  ✗ id=${r.id} decrypt(${hit.fieldKey}) threw: ${err.message}`);
        rowOk = false;
        break;
      }
      if (decrypted !== hit.plaintext) {
        console.log(
          `  ✗ id=${r.id} decrypt(${hit.fieldKey}) != backup plaintext`,
        );
        rowOk = false;
        break;
      }
      // Token replacement also has to be in place in the referenced slot.
      if (hit.section === "bodyFields") {
        const slotVal = cfg?.bodyFields?.[hit.index]?.value;
        if (slotVal !== `{{SECRET:${hit.fieldKey}}}`) {
          console.log(
            `  ✗ id=${r.id} bodyFields[${hit.index}].value="${slotVal}" (expected token)`,
          );
          rowOk = false;
          break;
        }
      } else if (hit.section === "headers") {
        const slotVal = cfg?.headers?.[hit.fieldHeader];
        if (slotVal !== `{{SECRET:${hit.fieldKey}}}`) {
          console.log(
            `  ✗ id=${r.id} headers["${hit.fieldHeader}"]="${slotVal}" (expected token)`,
          );
          rowOk = false;
          break;
        }
      }
    }

    if (rowOk) {
      ok++;
      console.log(`  ✓ id=${String(r.id).padStart(6)} name="${r.name}" verified`);
    } else {
      fail++;
    }
  }
} finally {
  await conn.end();
}

console.log("─".repeat(72));
console.log(`  PASS : ${ok}`);
console.log(`  FAIL : ${fail}`);
if (fail > 0) process.exit(2);
console.log("All migrated rows round-trip cleanly against live production key.");
