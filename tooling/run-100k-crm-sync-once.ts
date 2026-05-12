/**
 * Bir martalik 100k.uz sahifali CRM sinxron (admin worker tugmasiz).
 * Loyihadagi `.env` dagi DB va crm_connections (platform=100k) ishlatiladi.
 *
 *   pnpm exec tsx tooling/run-100k-crm-sync-once.ts
 */

import "dotenv/config";
import { closeDb } from "../server/db";
import { performPaginationSync100k } from "../server/routers/crmRouter";

async function main(): Promise<void> {
  try {
    const r = await performPaginationSync100k();
    console.log("[run-100k-crm-sync-once] natija:", JSON.stringify(r, null, 2));
    process.exitCode = r.errors > 0 ? 1 : 0;
  } finally {
    await closeDb().catch(() => {});
  }
}

void main().catch(async (e) => {
  console.error("[run-100k-crm-sync-once] xato:", e);
  await closeDb().catch(() => {});
  process.exit(1);
});
