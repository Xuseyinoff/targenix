/**
 * Manual apply for migration 0045 (orders.destinationId + unique key swap).
 *
 * Why not `drizzle-kit migrate`? The drizzle journal on Railway is out of
 * sync with the actual schema — earlier migrations (0042/0043/0044) were
 * applied by hand, so the migrator tries to re-run them and chokes on
 * ER_DUP_FIELDNAME. We keep the same convention and apply this single
 * migration directly, idempotently.
 *
 * Idempotency: each step first inspects INFORMATION_SCHEMA and only runs
 * when the desired state isn't already present. Safe to re-run as many
 * times as needed (e.g. after a failed run).
 *
 * Usage:
 *   # Dry run — prints the plan without executing DDL
 *   railway run --service web node tooling/mysql/apply-0045.mjs --dry-run
 *
 *   # Real run
 *   railway run --service web node tooling/mysql/apply-0045.mjs
 */

import "dotenv/config";
import mysql from "mysql2/promise";

const DRY_RUN = process.argv.includes("--dry-run");

const url =
  process.env.MYSQL_PUBLIC_URL || process.env.MYSQL_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("No DB URL. Set DATABASE_URL / MYSQL_URL / MYSQL_PUBLIC_URL.");
  process.exit(1);
}

const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
console.log(`[apply-0045] connected ${DRY_RUN ? "(dry-run)" : ""}`.trim());

async function columnExists(table, column) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS c
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [table, column],
  );
  return Number(rows[0].c) > 0;
}

async function indexExists(table, indexName) {
  const [rows] = await conn.execute(
    `SELECT COUNT(*) AS c
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [table, indexName],
  );
  return Number(rows[0].c) > 0;
}

async function run(sql) {
  console.log(`[apply-0045] ${DRY_RUN ? "WOULD RUN" : "RUN"}: ${sql}`);
  if (!DRY_RUN) {
    await conn.query(sql);
  }
}

// ─── Step 1: add column ────────────────────────────────────────────────────
const hasColumn = await columnExists("orders", "destinationId");
console.log(`[apply-0045] orders.destinationId exists? ${hasColumn}`);
if (!hasColumn) {
  await run(
    "ALTER TABLE `orders` ADD COLUMN `destinationId` INT NOT NULL DEFAULT 0",
  );
} else {
  console.log("[apply-0045] step 1 skipped — column already present");
}

// ─── Step 2: drop old unique key (if still present) ───────────────────────
const hasOldUq = await indexExists("orders", "uq_orders_lead_integration");
console.log(`[apply-0045] uq_orders_lead_integration exists? ${hasOldUq}`);
if (hasOldUq) {
  await run("ALTER TABLE `orders` DROP INDEX `uq_orders_lead_integration`");
} else {
  console.log("[apply-0045] step 2 skipped — old unique key already gone");
}

// ─── Step 3: add new composite unique key ─────────────────────────────────
const hasNewUq = await indexExists("orders", "uq_orders_lead_int_dest");
console.log(`[apply-0045] uq_orders_lead_int_dest exists? ${hasNewUq}`);
if (!hasNewUq) {
  await run(
    "ALTER TABLE `orders` ADD CONSTRAINT `uq_orders_lead_int_dest` UNIQUE (`leadId`, `integrationId`, `destinationId`)",
  );
} else {
  console.log("[apply-0045] step 3 skipped — new unique key already present");
}

// ─── Step 4: secondary index on destinationId ─────────────────────────────
const hasDestIdx = await indexExists("orders", "idx_orders_destination");
console.log(`[apply-0045] idx_orders_destination exists? ${hasDestIdx}`);
if (!hasDestIdx) {
  await run(
    "ALTER TABLE `orders` ADD INDEX `idx_orders_destination` (`destinationId`)",
  );
} else {
  console.log("[apply-0045] step 4 skipped — destination index already present");
}

// ─── Sanity summary ───────────────────────────────────────────────────────
const [cols] = await conn.execute(
  `SELECT COLUMN_NAME, COLUMN_DEFAULT, IS_NULLABLE
     FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
    ORDER BY ORDINAL_POSITION`,
);
console.log(
  `[apply-0045] orders columns:\n${cols
    .map(
      (c) =>
        `    ${c.COLUMN_NAME} default=${c.COLUMN_DEFAULT} nullable=${c.IS_NULLABLE}`,
    )
    .join("\n")}`,
);

const [idx] = await conn.execute(
  `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX, NON_UNIQUE
     FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
    ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
);
console.log(
  `[apply-0045] orders indexes:\n${idx
    .map(
      (i) =>
        `    ${i.INDEX_NAME} [${i.SEQ_IN_INDEX}] ${i.COLUMN_NAME}${
          Number(i.NON_UNIQUE) === 0 ? " (UNIQUE)" : ""
        }`,
    )
    .join("\n")}`,
);

// ─── Verify invariant: no row should have destinationId <> 0 on the legacy path
// Only runs when the column actually exists in the schema — under --dry-run
// the ALTER was logged but not executed, so the column may still be missing.
if (await columnExists("orders", "destinationId")) {
  const [legacy] = await conn.execute(
    "SELECT COUNT(*) AS c FROM orders WHERE destinationId <> 0",
  );
  console.log(
    `[apply-0045] rows with destinationId != 0: ${legacy[0].c} (expected 0 at this stage)`,
  );
} else {
  console.log(
    "[apply-0045] skipping destinationId=0 invariant check (column not yet present, likely --dry-run)",
  );
}

await conn.end();
console.log(`[apply-0045] DONE ${DRY_RUN ? "(dry-run, no changes made)" : ""}`.trim());
