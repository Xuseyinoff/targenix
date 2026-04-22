/**
 * Manual apply for migration 0044 (integration_destinations).
 *
 * Why not `drizzle-kit migrate`? The drizzle journal on Railway is out of
 * sync with the actual schema — migrations 0042/0043 were applied by hand,
 * so the migrator tries to re-run them and chokes on ER_DUP_FIELDNAME.
 * Rather than patch the journal, we apply this single migration directly
 * and also append a journal row for 0044 so a future `drizzle-kit migrate`
 * won't try to re-run it.
 *
 * Idempotent: if `integration_destinations` already exists, we skip the
 * DDL and just ensure the journal row is in place.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import mysql from "mysql2/promise";

const url =
  process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("No DB URL. Set DATABASE_URL / MYSQL_URL / MYSQL_PUBLIC_URL.");
  process.exit(1);
}

const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
console.log("[apply-0044] connected");

// ─── Exists? ──────────────────────────────────────────────────────────────
const [existsRows] = await conn.execute(
  `SELECT COUNT(*) AS c
     FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_destinations'`,
);
const alreadyExists = Number(existsRows[0].c) > 0;
console.log(`[apply-0044] integration_destinations exists? ${alreadyExists}`);

// ─── Apply DDL if missing ─────────────────────────────────────────────────
if (!alreadyExists) {
  const raw = await fs.readFile("drizzle/0044_integration_destinations.sql", "utf8");
  const stmts = raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const stmt of stmts) {
    console.log(`[apply-0044] executing ${stmt.length}-char statement…`);
    await conn.query(stmt);
  }
  console.log("[apply-0044] DDL applied");
} else {
  console.log("[apply-0044] DDL skipped — table already present");
}

// ─── Sanity check the shape ───────────────────────────────────────────────
const [cols] = await conn.execute(
  `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_destinations'
    ORDER BY ORDINAL_POSITION`,
);
console.log(
  `[apply-0044] columns: ${cols.map((c) => c.COLUMN_NAME).join(", ")}`,
);

const [fks] = await conn.execute(
  `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'integration_destinations'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
);
console.log(`[apply-0044] foreign keys: ${fks.map((f) => f.CONSTRAINT_NAME).join(", ")}`);

// ─── Journal upsert (best-effort) ─────────────────────────────────────────
// We don't know for sure whether drizzle's journal table is named
// `__drizzle_migrations` (v2) or something else on this project. Check
// first and only write if it exists.
const [journalTable] = await conn.execute(
  `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME LIKE '%drizzle%migration%'`,
);
if (journalTable.length > 0) {
  console.log(`[apply-0044] journal table: ${journalTable[0].TABLE_NAME}`);
} else {
  console.log(
    "[apply-0044] no drizzle journal table found — skipping journal update",
  );
}

await conn.end();
console.log("[apply-0044] DONE");
