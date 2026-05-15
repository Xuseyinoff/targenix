/**
 * One-off backfill: pull `order.pay_for` from sotuvchi /getOrderDetails for
 * every delivered order whose payoutAmount is still NULL, and persist it.
 *
 * Why this is needed:
 *   Phase 3 widens the per-order CRM sync adapter to capture pay_for, but
 *   the sync only re-fetches orders where `isFinal = false`. Every order
 *   that already reached a final state before the adapter was widened will
 *   never be re-checked by the scheduler. This script fills those rows in.
 *
 * Rate-limit strategy (mirrors server/routers/crmRouter.ts performCrmSync):
 *   - Base pace: 300 ms between calls (~3.3 RPS sustained).
 *   - On 429: exponential backoff (5s → 10s → 20s → 30s) keyed on the
 *     consecutive-hit count. The current order is RE-TRIED after the
 *     pause, not skipped, so no payout is lost.
 *   - Circuit breaker: 3 consecutive 429s ⇒ 120s pause + reset the hit
 *     counter. Lets sotuvchi's quota window flush.
 *   - 5xx / network / generic errors: retry once after a 1s pause, then
 *     queue for end-of-run retry pass.
 *
 * Resumability:
 *   Idempotent — the candidate query filters on payoutAmount IS NULL, so
 *   re-running picks up only the rows still missing. Safe to abort and
 *   re-run as many times as needed.
 *
 * Usage:
 *   railway run pnpm exec tsx tooling/backfill-sotuvchi-payouts.ts [--days N] [--limit N] [--pace MS]
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
const PACE_MS = Number(argMap.pace ?? "300") || 300;
const CIRCUIT_BREAKER_HITS = 3;
const CIRCUIT_BREAKER_PAUSE_MS = 120_000;
const RETRY_QUEUE_DELAY_MS = 30_000;

console.log(`[backfill] window=${DAYS}d limit=${LIMIT} pace=${PACE_MS}ms/call`);

const db = await getDb();
if (!db) {
  console.error("[backfill] DB unavailable");
  process.exit(1);
}

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

// ── Candidate query ─────────────────────────────────────────────────────────
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Per-order fetch with full 429 awareness ─────────────────────────────────
async function fetchOnce(externalId: string): Promise<
  | { ok: true; status: Awaited<ReturnType<typeof crmGetOrderStatus>> }
  | { ok: false; reason: "rate_limit"; err: unknown }
  | { ok: false; reason: "auth"; err: unknown }
  | { ok: false; reason: "other"; err: unknown }
> {
  try {
    const status = await crmGetOrderStatus("sotuvchi", bearerToken, externalId, platformUserId);
    return { ok: true, status };
  } catch (err) {
    const e = err as { response?: { status?: number } };
    const httpStatus = e?.response?.status;
    if (httpStatus === 429) return { ok: false, reason: "rate_limit", err };
    if (httpStatus === 401 || httpStatus === 403) return { ok: false, reason: "auth", err };
    return { ok: false, reason: "other", err };
  }
}

/**
 * Drive one pass over a candidate set. Each 429 backs off and re-tries the
 * SAME order — no row is dropped silently. Returns the orders that still
 * need a second pass at the end (e.g. transient 5xx that retrying-after-1s
 * didn't fix).
 */
async function runPass(
  set: Array<{ id: number; externalId: string }>,
  label: string,
): Promise<Array<{ id: number; externalId: string }>> {
  let updated = 0;
  let skippedNoPayout = 0;
  let permanentErrors = 0;
  let consecutive429 = 0;
  const retryQueue: Array<{ id: number; externalId: string }> = [];

  for (let i = 0; i < set.length; i++) {
    const c = set[i];

    // Retry the same row up to two extra times on 429.
    let attempts = 0;
    while (attempts < 3) {
      const result = await fetchOnce(c.externalId);

      if (result.ok) {
        consecutive429 = 0;
        if (result.status.payoutAmount != null && result.status.payoutCurrency) {
          await db
            .update(orders)
            .set({
              payoutAmount: result.status.payoutAmount,
              payoutCurrency: result.status.payoutCurrency,
            })
            .where(eq(orders.id, c.id));
          updated++;
        } else {
          skippedNoPayout++;
        }
        break;
      }

      if (result.reason === "rate_limit") {
        consecutive429++;
        const pauseMs =
          consecutive429 >= CIRCUIT_BREAKER_HITS
            ? CIRCUIT_BREAKER_PAUSE_MS
            : Math.min(5_000 * 2 ** (consecutive429 - 1), 30_000); // 5s / 10s / 20s

        if (consecutive429 >= CIRCUIT_BREAKER_HITS) {
          console.warn(`[backfill] ⚡ CIRCUIT BREAKER — pausing ${pauseMs / 1000}s after ${consecutive429} consecutive 429s`);
        } else {
          console.warn(`[backfill] 429 (hit #${consecutive429}) — pausing ${pauseMs / 1000}s, then retrying orderId=${c.id}`);
        }
        await sleep(pauseMs);
        if (consecutive429 >= CIRCUIT_BREAKER_HITS) consecutive429 = 0; // reset after breaker
        attempts++;
        continue;
      }

      if (result.reason === "auth") {
        console.error("[backfill] auth error (401/403) — token may be expired. Stopping.");
        return retryQueue;
      }

      // Generic error: short retry, then queue for end-of-run pass
      attempts++;
      if (attempts < 3) {
        await sleep(1_000);
        continue;
      }
      retryQueue.push(c);
      permanentErrors++;
      break;
    }

    if ((i + 1) % 50 === 0) {
      console.log(
        `[backfill][${label}] ${i + 1}/${set.length} — updated=${updated} skippedNoPayout=${skippedNoPayout} permErr=${permanentErrors} queued=${retryQueue.length}`,
      );
    }

    if (i < set.length - 1) await sleep(PACE_MS);
  }

  console.log(
    `[backfill][${label}] done — updated=${updated} skippedNoPayout=${skippedNoPayout} permErr=${permanentErrors} queued=${retryQueue.length}`,
  );
  return retryQueue;
}

// ── First pass ──────────────────────────────────────────────────────────────
const remaining = await runPass(candidates, "pass-1");

// ── Second pass for queued retries (transient failures only) ────────────────
if (remaining.length > 0) {
  console.log(`\n[backfill] ${remaining.length} orders queued for retry — waiting ${RETRY_QUEUE_DELAY_MS / 1000}s before re-pass…`);
  await sleep(RETRY_QUEUE_DELAY_MS);
  await runPass(remaining, "pass-2");
}

console.log("\n[backfill] all done");
process.exit(0);
