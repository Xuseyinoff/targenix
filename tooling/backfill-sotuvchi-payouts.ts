/**
 * One-off backfill: pull `order.pay_for` from sotuvchi /getOrderDetails for
 * every delivered order whose payoutAmount is still NULL, and persist it.
 *
 * Why this is needed:
 *   Phase 3 widens the per-order CRM sync adapter to capture pay_for, but
 *   the sync only re-fetches orders where `isFinal = false`. Every order
 *   that already reached a final state (delivered / cancelled / …) before
 *   the adapter was widened will never be re-checked by the scheduler.
 *   This script fills those rows in.
 *
 * Scope:
 *   - Only orders matching: crmStatus = 'delivered' AND payoutAmount IS NULL
 *   - Optional --days flag (default 30) bounds the scan to recently
 *     created orders so the first run stays fast.
 *
 * Rate limiting:
 *   200 ms between calls = ~5 RPS. Sotuvchi tolerates this comfortably
 *   (the regular sync runs faster bursts than this).
 *
 * Usage:
 *   railway run pnpm exec tsx tooling/backfill-sotuvchi-payouts.ts [--days N] [--limit N]
 */
import "dotenv/config";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { decrypt } from "../server/encryption";
import { crmConnections, orders } from "../drizzle/schema";
import { crmGetOrderStatus } from "../server/services/crmService";

// ── CLI flags ────────────────────────────────────────────────────────────────
const argMap = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = a.match(/^--([\w-]+)=?(.*)$/);
    return m ? [[m[1], m[2] || "true"]] : [];
  }),
);
const DAYS = Number(argMap.days ?? "30") || 30;
const LIMIT = Number(argMap.limit ?? "5000") || 5000;
const PER_CALL_DELAY_MS = 200;

console.log(`[backfill] window=${DAYS}d, hard limit=${LIMIT}, pace=${PER_CALL_DELAY_MS}ms/call`);

const db = await getDb();
if (!db) {
  console.error("[backfill] DB unavailable");
  process.exit(1);
}

// ── Find the active sotuvchi connection ──────────────────────────────────────
const [conn] = await db
  .select({
    id: crmConnections.id,
    bearerTokenEncrypted: crmConnections.bearerTokenEncrypted,
    platformUserId: crmConnections.platformUserId,
  })
  .from(crmConnections)
  .where(and(eq(crmConnections.platform, "sotuvchi"), eq(crmConnections.status, "active")))
  .limit(1);

if (!conn) {
  console.error("[backfill] No active sotuvchi crm_connection");
  process.exit(1);
}
const bearerToken = decrypt(conn.bearerTokenEncrypted);
const platformUserId = conn.platformUserId;

// ── Candidate orders ────────────────────────────────────────────────────────
// `responseData -> $.id` is the externalId path the per-order sync also uses
// (mirrors shared/extractExternalOrderId.ts). Limited to recent rows so the
// first run is cheap; subsequent runs cover anything still NULL by widening
// --days.
const cutoff = new Date();
cutoff.setUTCDate(cutoff.getUTCDate() - DAYS);

const candidates = await db
  .select({
    id: orders.id,
    externalId: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.id'))`,
  })
  .from(orders)
  .where(
    and(
      eq(orders.crmStatus, "delivered"),
      isNull(orders.payoutAmount),
      isNotNull(orders.responseData),
      sql`JSON_UNQUOTE(JSON_EXTRACT(${orders.responseData}, '$.id')) IS NOT NULL`,
      sql`${orders.createdAt} >= ${cutoff}`,
    ),
  )
  .limit(LIMIT);

console.log(`[backfill] ${candidates.length} delivered orders missing payoutAmount`);
if (candidates.length === 0) {
  process.exit(0);
}

// ── Fetch + update loop ─────────────────────────────────────────────────────
let updated = 0;
let skipped = 0;
let errors = 0;

for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i];
  try {
    const status = await crmGetOrderStatus("sotuvchi", bearerToken, c.externalId, platformUserId);
    if (status.payoutAmount != null && status.payoutCurrency) {
      await db
        .update(orders)
        .set({
          payoutAmount: status.payoutAmount,
          payoutCurrency: status.payoutCurrency,
        })
        .where(eq(orders.id, c.id));
      updated++;
    } else {
      skipped++;
    }
  } catch (err) {
    errors++;
    // First few errors only — beyond that the log gets noisy
    if (errors <= 5) {
      console.warn(`[backfill] orderId=${c.id} err: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if ((i + 1) % 50 === 0) {
    console.log(`[backfill] progress ${i + 1}/${candidates.length} — updated=${updated} skipped=${skipped} errors=${errors}`);
  }

  if (i < candidates.length - 1) {
    await new Promise((r) => setTimeout(r, PER_CALL_DELAY_MS));
  }
}

console.log(`\n[backfill] done — updated=${updated} skipped=${skipped} errors=${errors}`);
process.exit(0);
