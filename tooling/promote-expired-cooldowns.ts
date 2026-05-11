/**
 * One-shot: run autoPromoteExpiredCooldowns once. Useful for the initial
 * fix-up after Phase 2C deploys — destinations stuck OPEN before the
 * per-minute helper existed get unstuck immediately.
 */
import "dotenv/config";
import { getDb, closeDb } from "../server/db";
import { autoPromoteExpiredCooldowns } from "../server/services/circuitBreaker";
const db = await getDb();
if (!db) process.exit(1);
const n = await autoPromoteExpiredCooldowns(db);
console.log(`Promoted ${n} OPEN→HALF_OPEN`);
await closeDb();
