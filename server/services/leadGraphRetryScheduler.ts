/**
 * Per-minute auto-retry for leads whose Facebook Graph enrichment failed.
 *
 * Mirrors `orderRetryScheduler.ts` semantics:
 *   - Claims a batch with `FOR UPDATE SKIP LOCKED` so concurrent workers
 *     each take a disjoint slice (no double-dispatch).
 *   - Atomically clears `dataNextRetryAt` inside the same transaction so a
 *     parallel run cannot re-claim the same row.
 *   - Skips leads whose `dataAttempts` has reached `LEAD_MAX_GRAPH_ATTEMPTS`.
 *   - Re-enqueues each due lead via `dispatchLeadProcessing` (BullMQ in prod).
 *
 * Replaces the old hourly `retryGraphErrorLeads` which dumped EVERY ERROR
 * row back into the queue regardless of attempts or backoff — that path
 * hammered Facebook with permanently-missing leadgenIds (code 100/33) and
 * provided no upper bound on retries per lead.
 */

import { inArray, sql } from "drizzle-orm";
import { leads } from "../../drizzle/schema";
import { getDb } from "../db";
import { dispatchLeadProcessing } from "./leadDispatch";
import { LEAD_MAX_GRAPH_ATTEMPTS } from "../lib/leadEnrichmentRetryPolicy";
import { log } from "./appLogger";
import { envInt } from "../lib/envHelpers";

/** Cap on leads claimed per per-minute tick. */
const LEAD_RETRY_BATCH_SIZE = envInt("LEAD_RETRY_BATCH_SIZE", 100);

/** Max in-flight `dispatchLeadProcessing` calls inside one tick. */
const LEAD_RETRY_CONCURRENCY = envInt("LEAD_RETRY_CONCURRENCY", 10);

export async function retryDueGraphErrorLeads(options?: {
  limit?: number;
  concurrency?: number;
}): Promise<{ retried: number }> {
  const db = await getDb();
  if (!db) {
    await log.warn("SYSTEM", "[LeadGraphRetry] DB not available, skipping tick");
    return { retried: 0 };
  }

  const limit = options?.limit ?? LEAD_RETRY_BATCH_SIZE;
  const concurrency = options?.concurrency ?? LEAD_RETRY_CONCURRENCY;
  const now = new Date();

  // Atomic claim: lock due rows with SKIP LOCKED, clear nextRetryAt inside
  // the same tx so a concurrent scheduler instance walks past them and picks
  // a different slice. The actual queue dispatch happens AFTER commit so
  // we don't hold row locks across Redis writes.
  const due = await db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      SELECT id, leadgenId, pageId, formId, userId
        FROM leads
       WHERE dataStatus = 'ERROR'
         AND platform IN ('fb','ig')
         AND dataAttempts < ${LEAD_MAX_GRAPH_ATTEMPTS}
         AND dataNextRetryAt IS NOT NULL
         AND dataNextRetryAt <= ${now}
       ORDER BY dataNextRetryAt ASC
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    `);
    const rows = ((locked as unknown as [
      Array<{ id: number; leadgenId: string; pageId: string; formId: string; userId: number }>,
      unknown,
    ])[0] ?? [])
      .map((r) => ({
        id: Number(r.id),
        leadgenId: String(r.leadgenId),
        pageId: String(r.pageId),
        formId: String(r.formId),
        userId: Number(r.userId),
      }))
      .filter((r) => Number.isFinite(r.id) && r.id > 0);
    if (rows.length === 0) return [];
    await tx
      .update(leads)
      .set({ dataNextRetryAt: null })
      .where(inArray(leads.id, rows.map((r) => r.id)));
    return rows;
  });

  if (due.length === 0) {
    return { retried: 0 };
  }

  // Bounded concurrency so we don't enqueue 100 jobs to Redis in one
  // microsecond (BullMQ handles bursts fine, but this keeps log noise
  // bounded and matches the order-retry shape for operational sanity).
  let retried = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < due.length) {
      const idx = cursor++;
      const lead = due[idx]!;
      try {
        await dispatchLeadProcessing({
          leadId: lead.id,
          leadgenId: lead.leadgenId,
          pageId: lead.pageId,
          formId: lead.formId,
          userId: lead.userId,
        });
        retried++;
      } catch (err) {
        await log.error(
          "SYSTEM",
          `[LeadGraphRetry] dispatch failed for lead ${lead.id}`,
          { leadId: lead.id, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, due.length) }, () => worker()),
  );

  console.log(
    `[LeadGraphRetry] ${new Date().toISOString()} — claimed ${due.length}, dispatched ${retried}`,
  );
  return { retried };
}
