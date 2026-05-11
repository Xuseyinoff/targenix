/**
 * Replay unprocessed webhook_events back through the lead pipeline.
 *
 * Use case: process crashed after `webhook_events` was persisted but before
 * `saveIncomingLead` ran. `webhook_events.processed = false` rows are
 * picked up here and re-driven through `saveIncomingLead` +
 * `dispatchLeadProcessing`, just like the live webhook handler does.
 *
 * Idempotency is layered:
 *   • `webhook_events.signature` UNIQUE — prevents re-persisting
 *   • `saveIncomingLead` skips an already-saved leadgenId
 *   • `orders` unique (leadId, integrationId, destinationId) — no double-send
 *
 *   pnpm exec tsx tooling/replay-webhook-events.ts                 (dry-run)
 *   pnpm exec tsx tooling/replay-webhook-events.ts --apply         (actually replay)
 *   pnpm exec tsx tooling/replay-webhook-events.ts --apply --limit=100
 *   pnpm exec tsx tooling/replay-webhook-events.ts --apply --since=2026-05-10
 */

import "dotenv/config";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../server/db";
import { webhookEvents, facebookConnections } from "../drizzle/schema";
import { saveIncomingLead } from "../server/services/leadService";
import { dispatchLeadProcessing } from "../server/services/leadDispatch";

const APPLY = process.argv.includes("--apply");
const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  return arg ? Math.max(1, parseInt(arg.slice("--limit=".length), 10) || 100) : 100;
})();
const SINCE = (() => {
  const arg = process.argv.find((a) => a.startsWith("--since="));
  return arg ? new Date(arg.slice("--since=".length)) : null;
})();

async function main(): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");

  console.log(APPLY ? "MODE: APPLY (actually replays)" : "MODE: DRY-RUN");
  console.log(`Limit: ${LIMIT}${SINCE ? `, since: ${SINCE.toISOString().slice(0, 10)}` : ""}`);

  const where = and(
    eq(webhookEvents.processed, false),
    SINCE ? gte(webhookEvents.createdAt, SINCE) : undefined,
  );

  const events = await db
    .select({
      id: webhookEvents.id,
      eventType: webhookEvents.eventType,
      payload: webhookEvents.payload,
      verified: webhookEvents.verified,
      createdAt: webhookEvents.createdAt,
    })
    .from(webhookEvents)
    .where(where)
    .limit(LIMIT);

  console.log(`Unprocessed webhook events: ${events.length}`);
  if (events.length === 0) {
    process.exit(0);
  }

  if (!APPLY) {
    console.log("\nFirst 5 events (preview):");
    for (const e of events.slice(0, 5)) {
      const p = e.payload as Record<string, unknown>;
      const entry = (p?.entry as Array<Record<string, unknown>>)?.[0];
      const change = (entry?.changes as Array<Record<string, unknown>>)?.[0];
      const value = change?.value as Record<string, unknown>;
      console.log(
        `  id=${e.id} createdAt=${e.createdAt.toISOString().slice(0, 16)} pageId=${value?.page_id ?? entry?.id} leadgenId=${value?.leadgen_id}`,
      );
    }
    console.log("\nUse --apply to actually replay.");
    process.exit(0);
  }

  let succeeded = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const payload = event.payload as Record<string, unknown>;

      // Handle sample/test webhook
      if ((payload?.sample as Record<string, unknown>)?.field === "leadgen") {
        const value = (payload.sample as Record<string, unknown>).value as Record<string, unknown>;
        const leadgenId = String(value?.leadgen_id ?? `test-${event.id}`);
        const pageId = String(value?.page_id ?? "test-page");
        const formId = String(value?.form_id ?? "test-form");

        const userIds = await resolveUserIdsForPage(db, pageId);
        for (const userId of userIds) {
          const leadId = await saveIncomingLead({
            userId,
            pageId,
            formId,
            leadgenId: `${leadgenId}-u${userId}`,
            rawData: value,
          });
          if (leadId) {
            await dispatchLeadProcessing({ leadId, leadgenId, pageId, formId, userId });
          }
        }
        await db
          .update(webhookEvents)
          .set({ processed: true })
          .where(eq(webhookEvents.id, event.id));
        succeeded++;
        continue;
      }

      // Real leadgen webhook
      if (payload?.object === "page" && Array.isArray(payload?.entry)) {
        for (const entry of payload.entry as Array<Record<string, unknown>>) {
          const pageId = String(entry.id);
          const changes = (entry.changes as Array<Record<string, unknown>>) || [];
          for (const change of changes) {
            if (change.field !== "leadgen") continue;
            const value = change.value as Record<string, unknown>;
            const leadgenId = String(value?.leadgen_id ?? "");
            const formId = String(value?.form_id ?? "");
            if (!leadgenId) continue;

            const userIds = await resolveUserIdsForPage(db, pageId);
            for (const userId of userIds) {
              const leadId = await saveIncomingLead({
                userId,
                pageId,
                formId,
                leadgenId,
                rawData: value,
              });
              if (leadId) {
                await dispatchLeadProcessing({ leadId, leadgenId, pageId, formId, userId });
              }
            }
          }
        }
        await db
          .update(webhookEvents)
          .set({ processed: true })
          .where(eq(webhookEvents.id, event.id));
        succeeded++;
        continue;
      }

      // Unknown payload shape — mark processed so we don't keep retrying it
      await db
        .update(webhookEvents)
        .set({ processed: true, error: "Unknown payload shape" })
        .where(eq(webhookEvents.id, event.id));
      console.log(`  id=${event.id}: skipped (unknown payload shape)`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  id=${event.id}: FAILED — ${msg}`);
      await db
        .update(webhookEvents)
        .set({ error: msg.slice(0, 1000) })
        .where(eq(webhookEvents.id, event.id))
        .catch(() => {});
    }
  }

  console.log(`\nReplay done — succeeded=${succeeded}, failed=${failed}, total=${events.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

async function resolveUserIdsForPage(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  pageId: string,
): Promise<number[]> {
  const rows = await db
    .select({ userId: facebookConnections.userId })
    .from(facebookConnections)
    .where(eq(facebookConnections.pageId, pageId));
  return Array.from(new Set(rows.map((r) => r.userId)));
}

void main().catch((e) => {
  console.error("xato:", e);
  process.exit(1);
});
