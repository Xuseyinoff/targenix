/**
 * Phase 2 migration: add triggers + trigger_executions tables
 * Run: railway run --service MySQL node tooling/mysql/add-triggers.mjs
 */
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.MYSQL_URL);

await conn.execute(`
  CREATE TABLE IF NOT EXISTS triggers (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    userId      INT          NOT NULL,
    name        VARCHAR(255) NOT NULL,
    type        ENUM('webhook','schedule','manual','api') NOT NULL,
    webhookKey  VARCHAR(64)  NULL UNIQUE,
    config      JSON         NULL,
    isActive    BOOLEAN      NOT NULL DEFAULT TRUE,
    lastFiredAt TIMESTAMP    NULL,
    createdAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_triggers_user_id   (userId),
    INDEX idx_triggers_webhook_key (webhookKey)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);
console.log("✓ triggers table ready");

await conn.execute(`
  CREATE TABLE IF NOT EXISTS trigger_executions (
    id         INT AUTO_INCREMENT PRIMARY KEY,
    triggerId  INT          NOT NULL,
    userId     INT          NOT NULL,
    status     ENUM('received','success','failed') NOT NULL DEFAULT 'received',
    payload    JSON         NULL,
    source     VARCHAR(64)  NULL,
    executedAt TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    error      TEXT         NULL,
    INDEX idx_trigger_exec_trigger_id (triggerId),
    INDEX idx_trigger_exec_user_id    (userId),
    INDEX idx_trigger_exec_fired_at   (executedAt)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`);
console.log("✓ trigger_executions table ready");

await conn.end();
console.log("Migration complete.");
