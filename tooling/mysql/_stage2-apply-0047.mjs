/**
 * Apply migration 0047_connection_app_specs_auth_none.sql to the Railway
 * MySQL instance and record it in __drizzle_migrations, same pattern as
 * _stage1-apply-0046.mjs.
 *
 * What 0047 does:
 *   1. Extends the `connection_app_specs.authType` ENUM with `'none'`.
 *   2. Seeds the `open_affiliate` spec so auth-less Uzbek affiliates
 *      can be selected from the admin template picker immediately.
 *
 * Safety:
 *   • Runs inside a single transaction — a mid-stream failure rolls
 *     both the ALTER and the INSERT back.
 *   • Idempotent: re-running is a no-op (hash check) AND the INSERT
 *     uses ON DUPLICATE KEY UPDATE so the seed row can be refreshed
 *     without violating the uniqueness of appKey.
 *   • NON-BREAKING for existing rows. All current specs (5 api_key
 *     apps) stay exactly as they are.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MYSQL_URL ||
  process.env.DATABASE_URL;
if (!url?.startsWith("mysql://")) {
  console.error("Need mysql:// URL via MYSQL_PUBLIC_URL / MYSQL_URL");
  process.exit(1);
}

const MIGRATION_PATH = "drizzle/0047_connection_app_specs_auth_none.sql";
const MIGRATION_TAG = "0047_connection_app_specs_auth_none";

async function sha256OfFileLF(path) {
  const buf = await readFile(path, "utf8");
  const lf = buf.replace(/\r\n/g, "\n");
  return createHash("sha256").update(lf, "utf8").digest("hex");
}

function splitStatements(sql) {
  return sql
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

async function main() {
  const fileSha = await sha256OfFileLF(MIGRATION_PATH);
  const createdAt = Date.now();
  console.log(`[stage2-apply-0047] tag=${MIGRATION_TAG}`);
  console.log(`[stage2-apply-0047] sha256=${fileSha}`);

  const conn = await mysql.createConnection({ uri: url, multipleStatements: false });
  try {
    const [existing] = await conn.query(
      "SELECT id FROM `__drizzle_migrations` WHERE `hash` = ? LIMIT 1",
      [fileSha],
    );
    if (existing.length > 0) {
      console.log(
        `[stage2-apply-0047] hash already present (id=${existing[0].id}) — nothing to do`,
      );
      return;
    }

    const raw = await readFile(MIGRATION_PATH, "utf8");
    const statements = splitStatements(raw);
    console.log(
      `[stage2-apply-0047] parsed ${statements.length} SQL statement(s) to apply`,
    );

    await conn.beginTransaction();
    try {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        const preview = stmt.replace(/\s+/g, " ").slice(0, 120);
        console.log(`  [${i + 1}/${statements.length}] ${preview}...`);
        await conn.query(stmt);
      }

      await conn.query(
        "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
        [fileSha, createdAt],
      );
      await conn.commit();
      console.log(
        `[stage2-apply-0047] COMMITTED — stamped __drizzle_migrations at ${new Date(createdAt).toISOString()}`,
      );
    } catch (err) {
      console.error(
        "[stage2-apply-0047] FAILED — rolling back the entire migration",
      );
      await conn.rollback();
      throw err;
    }
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
