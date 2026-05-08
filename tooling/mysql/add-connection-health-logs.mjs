/**
 * Migration: add connection_health_logs table (Phase 8 — Connection Platform)
 *
 * Safe to run multiple times (CREATE TABLE IF NOT EXISTS).
 * No existing tables or columns are touched.
 *
 * Usage:
 *   node tooling/mysql/add-connection-health-logs.mjs
 */

import mysql from "mysql2/promise";
import "dotenv/config";

const db = await mysql.createConnection(process.env.DATABASE_URL);

await db.execute(`
  CREATE TABLE IF NOT EXISTS connection_health_logs (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    connectionId INT          NOT NULL,
    userId       INT          NOT NULL,
    checkStatus  VARCHAR(16)  NOT NULL COMMENT 'ok | error | expired',
    latencyMs    INT          NULL,
    errorMessage VARCHAR(500) NULL,
    checkedAt    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_chl_connection_id  (connectionId),
    INDEX idx_chl_user_checked   (userId, checkedAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`);

console.log("✅ connection_health_logs table created (or already exists)");

await db.end();
