/**
 * CRM migration — add crm_connections table + orders.crmStatus/crmSyncedAt columns.
 *
 * Usage:
 *   railway run node tooling/mysql/crm-migration.mjs
 */
import mysql from "mysql2/promise";

function getMysqlUrl() {
  for (const raw of [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
  ]) {
    const u = raw?.trim().replace(/^=+/, "");
    if (u?.startsWith("mysql://")) return u;
  }
  return null;
}

async function main() {
  const url = getMysqlUrl();
  if (!url) {
    console.error("Need mysql:// URL (MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL)");
    process.exit(1);
  }

  const cn = await mysql.createConnection(url);

  try {
    console.log("Running CRM migration...\n");

    // 1. orders: add crmStatus + crmSyncedAt
    await cn.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS crmStatus   VARCHAR(32)  NULL AFTER responseData,
        ADD COLUMN IF NOT EXISTS crmSyncedAt DATETIME(3)  NULL AFTER crmStatus
    `);
    console.log("✓ orders.crmStatus + crmSyncedAt added");

    // 2. crm_connections: create table
    await cn.query(`
      CREATE TABLE IF NOT EXISTS crm_connections (
        id                    INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        userId                INT NOT NULL,
        platform              ENUM('sotuvchi','100k') NOT NULL,
        displayName           VARCHAR(64)  NOT NULL,
        phone                 VARCHAR(32)  NOT NULL,
        passwordEncrypted     TEXT         NOT NULL,
        bearerTokenEncrypted  TEXT         NOT NULL,
        platformUserId        VARCHAR(64)  NOT NULL,
        status                ENUM('active','error') NOT NULL DEFAULT 'active',
        lastLoginAt           DATETIME(3)  NULL,
        createdAt             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updatedAt             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        INDEX idx_crm_connections_user_id (userId),
        INDEX idx_crm_connections_platform (platform)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log("✓ crm_connections table created");

    console.log("\nMigration complete.");
  } finally {
    await cn.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
