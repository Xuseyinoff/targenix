/**
 * Migration: order_events table (CRM status change audit log)
 * Usage: railway run --service MySQL node tooling/mysql/add-order-events-table.mjs
 */
import mysql from "mysql2/promise";

const urls = [process.env.MYSQL_PUBLIC_URL, process.env.MYSQL_URL].filter(Boolean);
let cn;
for (const u of urls) { try { cn = await mysql.createConnection(u); break; } catch {} }
if (!cn) { console.error("No DB reachable"); process.exit(1); }

await cn.query(`
  CREATE TABLE IF NOT EXISTS order_events (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    orderId     INT NOT NULL,
    userId      INT NOT NULL,
    oldStatus   VARCHAR(32) NULL,
    newStatus   VARCHAR(32) NOT NULL,
    source      VARCHAR(32) NOT NULL DEFAULT 'sync',
    changedAt   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_order_events_order_id  (orderId),
    INDEX idx_order_events_user_id   (userId),
    INDEX idx_order_events_changed_at (changedAt)
  )
`);
console.log("✓ order_events table ready");

const [[{ cnt }]] = await cn.query("SELECT COUNT(*) as cnt FROM order_events");
console.log(`  Current rows: ${cnt}`);

await cn.end();
