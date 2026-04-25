/**
 * Apply migration 0046_connection_app_specs.sql to the Railway MySQL
 * instance and record it in __drizzle_migrations so `drizzle-kit migrate`
 * sees it as already applied.
 *
 * Why not `drizzle-kit migrate`?
 *
 *   The production __drizzle_migrations table is out of sync with the
 *   file journal (historical migrations 0028..0045 were hand-applied
 *   without recording their hashes). A raw migrate would replay them
 *   and fail with ER_DUP_FIELDNAME. Healing the whole journal is a
 *   separate chore; for Stage 1 we mirror what
 *   tooling/drizzle/backfill-migration-journal-0026-0027.mjs did for
 *   its two migrations: apply one new migration, stamp one new row.
 *
 * Safety:
 *   • The migration is applied inside a single transaction, so a mid-
 *     stream failure rolls everything back.
 *   • The stamp row is inserted in the SAME transaction — no partial
 *     state where the schema changed but the journal did not.
 *   • If drizzle-kit later discovers the hash, it will skip 0046.
 *   • Re-running this script is a no-op: if the stamp row exists we
 *     abort before touching any schema.
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

const MIGRATION_PATH = "drizzle/0046_connection_app_specs.sql";
const MIGRATION_TAG = "0046_connection_app_specs";

/**
 * Hash scheme matches tooling/drizzle/backfill-migration-journal-0026-0027.mjs:
 *   sha256(fs.readFileSync(LF-normalized)).
 * We normalize CRLF → LF before hashing so the hash is stable across
 * Windows checkouts.
 */
async function sha256OfFileLF(path) {
  const buf = await readFile(path, "utf8");
  const lf = buf.replace(/\r\n/g, "\n");
  return createHash("sha256").update(lf, "utf8").digest("hex");
}

function splitStatements(sql) {
  // Split on the drizzle statement-breakpoint sentinel FIRST (do not
  // pre-strip comments — that swallowed the sentinel itself). Then per
  // chunk, drop leading `--` comment lines but leave the SQL intact.
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
  console.log(`[stage1-apply-0046] tag=${MIGRATION_TAG}`);
  console.log(`[stage1-apply-0046] sha256=${fileSha}`);

  const conn = await mysql.createConnection({ uri: url, multipleStatements: false });
  try {
    const [existing] = await conn.query(
      "SELECT id FROM `__drizzle_migrations` WHERE `hash` = ? LIMIT 1",
      [fileSha],
    );
    if (existing.length > 0) {
      console.log(
        `[stage1-apply-0046] hash already present (id=${existing[0].id}) — nothing to do`,
      );
      return;
    }

    const raw = await readFile(MIGRATION_PATH, "utf8");
    const statements = splitStatements(raw);
    console.log(
      `[stage1-apply-0046] parsed ${statements.length} SQL statement(s) to apply`,
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
        `[stage1-apply-0046] COMMITTED — stamped __drizzle_migrations at ${new Date(createdAt).toISOString()}`,
      );
    } catch (err) {
      console.error(
        "[stage1-apply-0046] FAILED — rolling back the entire migration",
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
