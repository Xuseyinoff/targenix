import "dotenv/config";
import mysql from "mysql2/promise";
const c = await mysql.createConnection({ uri: process.env.DATABASE_URL });
const [r] = await c.query(
  `SELECT table_name, table_type FROM information_schema.tables
    WHERE table_schema=DATABASE()
      AND table_name IN ('integration_health','integration_health_events',
                         'ad_accounts_cache','campaigns_cache','ad_sets_cache','campaign_insights_cache')
    ORDER BY table_name`,
);
console.log(r);
await c.end();
