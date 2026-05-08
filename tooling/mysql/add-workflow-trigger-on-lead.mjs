/**
 * Migration: add triggerOnLead column to workflows table.
 *
 * When triggerOnLead = true the workflow fires automatically for every
 * new lead that finishes processing for that user.
 *
 * Safe to run multiple times — checks if column already exists first.
 *
 * Usage:
 *   railway run node tooling/mysql/add-workflow-trigger-on-lead.mjs
 */

import mysql from "mysql2/promise";

const connectionUrl = process.env.MYSQL_PUBLIC_URL || process.env.DATABASE_URL;
if (!connectionUrl) {
  console.error("❌ No database URL. Set MYSQL_PUBLIC_URL or DATABASE_URL.");
  process.exit(1);
}

console.log("Connecting to:", connectionUrl.replace(/:\/\/[^@]+@/, "://***@"));

const db = await mysql.createConnection(connectionUrl);

const [cols] = await db.execute(`
  SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'workflows'
    AND COLUMN_NAME  = 'triggerOnLead'
`);

if (cols.length > 0) {
  console.log("✅ triggerOnLead already exists — nothing to do");
} else {
  await db.execute(`
    ALTER TABLE workflows
      ADD COLUMN triggerOnLead TINYINT(1) NOT NULL DEFAULT 0
      AFTER isActive
  `);
  console.log("✅ Added triggerOnLead column to workflows");
}

await db.end();
process.exit(0);
