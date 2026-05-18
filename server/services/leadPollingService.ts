/**
 * leadPollingService
 * ─────────────────────────────────────────────────────────────────────────────
 * Periodic safety net for Facebook lead webhooks.
 *
 * Webhooks are our primary ingestion path, but they can silently fail for
 * several reasons — Facebook app-level subscription issues, page token
 * expiry, HMAC mismatches after secret rotation, or even transient Meta
 * outages. When that happens, leads are lost and users only notice hours
 * later.
 *
 * This service polls every (user, page, form) combination on a cadence,
 * reusing the existing `fetchLeadsFromForm` Graph helper. Any lead that
 * the webhook path has NOT already persisted is saved and dispatched.
 *
 * Key design decisions
 * --------------------
 *   • No schema changes: the "since" cursor is derived per-form from
 *     `MAX(leads.createdAt)` for that (userId, pageId, formId). New forms
 *     fall back to a safe default window.
 *   • Dedup: `leads.UNIQUE(leadgenId, userId)` makes writes idempotent.
 *     We explicitly check before inserting so we never re-dispatch.
 *   • Throttling: per-page concurrency is 1 and Graph calls are spaced out
 *     to stay inside Facebook's per-token rate budget.
 *   • Feature flag: `ENABLE_LEAD_POLLING` env (default OFF) so we can roll
 *     this out incrementally without touching product behaviour by default.
 *   • Failure-isolated: one form's error never stops the tick; everything
 *     is logged and aggregated into the return value.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, type DbClient } from "../db";
import {
  facebookConnections,
  facebookForms,
  integrations,
  leads,
} from "../../drizzle/schema";
import { decrypt } from "../encryption";
import {
  fetchLeadsFromForm,
  extractLeadFields,
  type PollLeadItem,
} from "./facebookService";
import { dispatchLeadProcessing } from "./leadDispatch";
import { log } from "./appLogger";
import { envInt, envIntNonNegative } from "../lib/envHelpers";

export interface PollingTickResult {
  forms: number;
  leadsInserted: number;
  /**
   * Number of parked-ERROR leads the tick repaired by re-using the polling
   * payload (Graph batch endpoint returns full field_data inline, so we don't
   * need to re-fetch per-lead — the same per-lead fetch is exactly what
   * failed earlier with the auth error).
   */
  leadsReEnriched: number;
  leadsSkipped: number;
  errors: number;
  durationMs: number;
}

/**
 * Lookback window (hours) passed to `fetchLeadsFromForm` when a form has
 * NEVER produced a lead yet. Short enough to avoid reprocessing old data
 * on first activation; long enough to absorb a missed webhook burst.
 * Override via `LEAD_POLLING_INITIAL_HOURS`.
 */
const DEFAULT_INITIAL_WINDOW_HOURS = envInt("LEAD_POLLING_INITIAL_HOURS", 2);

/**
 * Hard override for per-form `hoursBack`. When > 0, every form is polled
 * with this exact window regardless of its own newest-lead cursor — useful
 * for catching up after a long outage or for a one-off wider sweep. When 0
 * (default), per-form cursor derivation is used. Override via
 * `LEAD_POLLING_LOOKBACK_HOURS`.
 */
const FORCED_LOOKBACK_HOURS = envIntNonNegative("LEAD_POLLING_LOOKBACK_HOURS", 0);

/**
 * Extra slack (minutes) added on top of the derived cursor to compensate
 * for Facebook's `created_time` occasionally trailing our insert time by
 * a few minutes. Prevents edge leads from being dropped.
 * Override via `LEAD_POLLING_OVERLAP_MINUTES`.
 */
const OVERLAP_MINUTES = envInt("LEAD_POLLING_OVERLAP_MINUTES", 30);

/**
 * Upper bound on forms polled per tick — safety net, logs a warning when hit.
 * Override via `LEAD_POLLING_MAX_FORMS_PER_TICK`.
 */
const MAX_FORMS_PER_TICK = envInt("LEAD_POLLING_MAX_FORMS_PER_TICK", 500);

/** Milliseconds to wait between consecutive form polls to smooth load. */
const DELAY_BETWEEN_FORMS_MS = 250;

interface ActivePollingTarget {
  userId: number;
  pageId: string;
  pageName: string;
  formId: string;
  formName: string;
  encryptedPageToken: string;
}

/**
 * Loads every (user, page, form) triple that is currently eligible for
 * polling. A form is eligible when:
 *   • the user still has an `isActive` connection for its page, AND
 *   • that connection's `subscriptionStatus` is not explicitly `inactive`
 *     (we DO poll `failed` subscriptions — that's the whole point), AND
 *   • at least one active LEAD_ROUTING integration is wired to this exact
 *     (user, page, form) — no point polling forms with no destination.
 *
 * The integration filter cuts the candidate set ~10× in production
 * (audit 2026-05-13: 2,083 active forms → 232 actually wired up). Without
 * it, polling burned FB Graph quota on forms whose leads would be dropped
 * anyway because no integration could route them.
 *
 * Multiple integrations on the same (user, page, form) collapse to one
 * polling target via the Map dedup below — we still only need to fetch
 * each form once per tick.
 */
async function loadActiveTargets(db: DbClient): Promise<ActivePollingTarget[]> {
  const rows = await db
    .select({
      userId: facebookForms.userId,
      pageId: facebookForms.pageId,
      pageName: facebookForms.pageName,
      formId: facebookForms.formId,
      formName: facebookForms.formName,
      encryptedPageToken: facebookConnections.accessToken,
      subscriptionStatus: facebookConnections.subscriptionStatus,
    })
    .from(facebookForms)
    .innerJoin(
      facebookConnections,
      and(
        eq(facebookConnections.userId, facebookForms.userId),
        eq(facebookConnections.pageId, facebookForms.pageId),
        eq(facebookConnections.isActive, true),
      ),
    )
    .innerJoin(
      integrations,
      and(
        eq(integrations.userId, facebookForms.userId),
        eq(integrations.pageId, facebookForms.pageId),
        eq(integrations.formId, facebookForms.formId),
        eq(integrations.isActive, true),
        eq(integrations.type, "LEAD_ROUTING"),
      ),
    );

  const dedup = new Map<string, ActivePollingTarget>();
  for (const r of rows) {
    if (r.subscriptionStatus === "inactive") continue;
    const key = `${r.userId}|${r.pageId}|${r.formId}`;
    if (dedup.has(key)) continue;
    dedup.set(key, {
      userId: r.userId,
      pageId: r.pageId,
      pageName: r.pageName,
      formId: r.formId,
      formName: r.formName,
      encryptedPageToken: r.encryptedPageToken,
    });
  }
  return Array.from(dedup.values());
}

/**
 * Derive a `hoursBack` cutoff per form from the newest *successfully
 * enriched* lead for the given (userId, pageId, formId). Falls back to
 * `DEFAULT_INITIAL_WINDOW_HOURS` for forms that have never produced a
 * successful lead.
 *
 * Why filter on `dataStatus = 'ENRICHED'` and ignore ERROR rows:
 *
 * An ERROR row exists because we WROTE a placeholder when enrichment
 * failed (token invalid, Graph 5xx, etc) — its `createdAt` reflects when
 * the failure happened, not when we last successfully ingested a lead.
 * If we anchored on it, the polling window would shrink as failures
 * accumulate, pushing older ERROR rows OUT of view and stranding them
 * permanently. By anchoring only on ENRICHED rows, the window stays wide
 * enough for the polling re-enrichment branch below to rescue every
 * parked ERROR within the same lookback budget.
 *
 * When `LEAD_POLLING_LOOKBACK_HOURS` is set (>0), it bypasses derivation
 * entirely and every form gets the same window — used to widen the sweep
 * after an outage without redeploying.
 */
async function deriveHoursBack(
  db: DbClient,
  target: ActivePollingTarget,
): Promise<number> {
  if (FORCED_LOOKBACK_HOURS > 0) return FORCED_LOOKBACK_HOURS;

  const [row] = await db
    .select({ latest: sql<Date | null>`MAX(${leads.createdAt})` })
    .from(leads)
    .where(
      and(
        eq(leads.userId, target.userId),
        eq(leads.pageId, target.pageId),
        eq(leads.formId, target.formId),
        eq(leads.dataStatus, "ENRICHED"),
      ),
    );

  const latest = row?.latest ? new Date(row.latest) : null;
  if (!latest || Number.isNaN(latest.getTime())) {
    return DEFAULT_INITIAL_WINDOW_HOURS;
  }

  const ms = Date.now() - latest.getTime() + OVERLAP_MINUTES * 60 * 1000;
  const hours = Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));
  return Math.min(hours, 24 * 7);
}

/** Shape returned by {@link findExistingLeads}. Drives the per-row routing
 *  decision in `pollSingleTarget`: SKIP / INSERT / RE-ENRICH. */
interface ExistingLeadState {
  id: number;
  dataStatus: "PENDING" | "ENRICHED" | "ERROR";
}

/**
 * For each leadgenId in the batch, return the existing leads row's id +
 * current `dataStatus`. Empty Map when none exist. Used by the polling
 * tick to classify what to do with each fetched item:
 *
 *   • not in map        → INSERT (normal path)
 *   • ENRICHED          → SKIP (already done; don't reprocess)
 *   • PENDING           → SKIP (worker is about to / mid-processing it)
 *   • ERROR             → RE-ENRICH (rescue parked lead — see
 *                          `reEnrichParkedLead`)
 */
async function findExistingLeads(
  db: DbClient,
  userId: number,
  leadgenIds: string[],
): Promise<Map<string, ExistingLeadState>> {
  if (leadgenIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: leads.id,
      leadgenId: leads.leadgenId,
      dataStatus: leads.dataStatus,
    })
    .from(leads)
    .where(and(eq(leads.userId, userId), inArray(leads.leadgenId, leadgenIds)));
  const m = new Map<string, ExistingLeadState>();
  for (const r of rows) {
    m.set(r.leadgenId, {
      id: r.id,
      dataStatus: r.dataStatus as ExistingLeadState["dataStatus"],
    });
  }
  return m;
}

/**
 * Insert a polled lead and enqueue the delivery pipeline. Mirrors the
 * shape of `saveIncomingLead` but stores the fully enriched Graph payload
 * so the worker can skip the re-fetch step.
 */
async function insertAndDispatchPolledLead(
  db: DbClient,
  target: ActivePollingTarget,
  item: PollLeadItem,
): Promise<void> {
  const platform = (item as { platform?: string }).platform === "ig" ? "ig" : "fb";
  const fields = extractLeadFields(item.field_data ?? []);

  await db.insert(leads).values({
    userId:   target.userId,
    pageId:   target.pageId,
    formId:   item.form_id || target.formId,
    leadgenId: item.id,
    fullName: fields.fullName,
    phone:    fields.phone,
    email:    fields.email,
    rawData:  item,
    platform: platform as "fb" | "ig",
    pageName: target.pageName,
    formName: target.formName,
    // We still route delivery via dispatchLeadProcessing so that all
    // existing integration logic (LEAD_ROUTING, retries, logs) kicks in.
    dataStatus: "PENDING",
    deliveryStatus: "PENDING",
  });

  const [saved] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.leadgenId, item.id), eq(leads.userId, target.userId)))
    .orderBy(desc(leads.id))
    .limit(1);

  if (!saved) return;

  await dispatchLeadProcessing({
    leadId: saved.id,
    leadgenId: item.id,
    pageId: target.pageId,
    formId: item.form_id || target.formId,
    userId: target.userId,
  });
}

/**
 * Re-enrich a parked-ERROR lead from a polling fetch payload.
 *
 * Background: when per-lead Graph enrichment fails with `auth` (e.g. FB
 * code 190 after a page-token invalidation), the policy in
 * `leadEnrichmentRetryPolicy` gives up after one follow-up retry and parks
 * the row at `dataStatus = 'ERROR'`. Once the user re-connects, the
 * retry scheduler has no signal to wake it up — the row sits forever.
 *
 * But the polling Graph endpoint returns the full `field_data` for every
 * lead inline, so we can rebuild what the per-lead fetch would have
 * returned. This helper does that and flips the row to ENRICHED.
 *
 * Atomic claim: the WHERE clause includes `dataStatus = 'ERROR'`. If
 * another recovery path (manual retry from the admin UI, a concurrent
 * scheduler claim) raced and already moved the row out of ERROR, the
 * UPDATE matches zero rows and we skip the dispatch — the other path
 * owns it.
 *
 * dataAttempts is intentionally NOT reset: it preserves the audit trail
 * of past Graph failures. deliveryStatus is NOT touched either — for a
 * parked-ERROR lead it's already PENDING (no orders were created), and
 * dispatchLeadProcessing → processLead → recalculateLeadDeliveryStatus
 * will set the right value once delivery completes.
 */
async function reEnrichParkedLead(
  db: DbClient,
  target: ActivePollingTarget,
  item: PollLeadItem,
  existingId: number,
): Promise<boolean> {
  const platform = (item as { platform?: string }).platform === "ig" ? "ig" : "fb";
  const fields = extractLeadFields(item.field_data ?? []);

  const claim = await db
    .update(leads)
    .set({
      fullName: fields.fullName,
      phone: fields.phone,
      email: fields.email,
      rawData: item,
      pageName: target.pageName,
      formName: target.formName,
      platform: platform as "fb" | "ig",
      dataStatus: "ENRICHED",
      dataError: null,
      dataNextRetryAt: null,
    })
    .where(
      and(
        eq(leads.id, existingId),
        eq(leads.userId, target.userId),
        eq(leads.dataStatus, "ERROR"),
      ),
    );

  // Drizzle MySQL surfaces affectedRows differently across driver versions
  // — coerce defensively. When zero, another path moved the row first;
  // skip dispatch to avoid double-enqueue.
  const affected = extractAffectedRows(claim);
  if (affected === 0) return false;

  await dispatchLeadProcessing({
    leadId: existingId,
    leadgenId: item.id,
    pageId: target.pageId,
    formId: item.form_id || target.formId,
    userId: target.userId,
  });

  await log.info(
    "FACEBOOK",
    `[Polling] re-enriched parked ERROR lead leadgenId=${item.id} (leadId=${existingId})`,
    {
      userId: target.userId,
      pageId: target.pageId,
      formId: target.formId,
      leadId: existingId,
      leadgenId: item.id,
    },
    existingId,
    target.pageId,
    target.userId,
    "lead_received",
    "facebook",
  );
  return true;
}

/**
 * Best-effort extraction of MySQL's affectedRows from the Drizzle update
 * result. Different driver versions surface it under slightly different
 * shapes; defaults to 1 (assume success) when the shape is unknown so
 * production traffic never deadlocks on a quirky driver upgrade.
 */
function extractAffectedRows(result: unknown): number {
  if (result == null || typeof result !== "object") return 1;
  const r = result as { affectedRows?: number; rowsAffected?: number };
  if (typeof r.affectedRows === "number") return r.affectedRows;
  if (typeof r.rowsAffected === "number") return r.rowsAffected;
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as { affectedRows?: number };
    if (typeof first?.affectedRows === "number") return first.affectedRows;
  }
  return 1;
}

async function pollSingleTarget(
  db: DbClient,
  target: ActivePollingTarget,
): Promise<{ inserted: number; reEnriched: number; skipped: number; error?: string }> {
  try {
    const hoursBack = await deriveHoursBack(db, target);
    const accessToken = decrypt(target.encryptedPageToken);

    const fetched = await fetchLeadsFromForm(target.formId, accessToken, {
      hoursBack,
      limit: 100,
    });

    if (fetched.length === 0) return { inserted: 0, reEnriched: 0, skipped: 0 };

    const existing = await findExistingLeads(
      db,
      target.userId,
      fetched.map((x) => x.id),
    );

    let inserted = 0;
    let reEnriched = 0;
    let skipped = 0;
    for (const item of fetched) {
      const existingLead = existing.get(item.id);

      if (existingLead) {
        // ENRICHED → already delivered (or in-delivery), nothing to do.
        // PENDING → worker is mid-processing it, don't race the dispatcher.
        if (existingLead.dataStatus !== "ERROR") {
          skipped++;
          continue;
        }
        // ERROR → the per-lead Graph fetch failed earlier (typically auth
        // code 190 after a token invalidation). The polling payload has
        // the full field_data, so we can repair the row in place.
        try {
          const claimed = await reEnrichParkedLead(db, target, item, existingLead.id);
          if (claimed) reEnriched++;
          else skipped++;
        } catch (err) {
          await log.warn(
            "FACEBOOK",
            `Polling re-enrichment failed for leadgenId=${item.id}`,
            {
              userId: target.userId,
              pageId: target.pageId,
              formId: target.formId,
              leadId: existingLead.id,
              error: String(err),
            },
            existingLead.id,
            target.pageId,
            target.userId,
            "error",
            "facebook",
          );
        }
        continue;
      }

      // Net-new lead: webhook never delivered it. Standard insert path.
      try {
        await insertAndDispatchPolledLead(db, target, item);
        inserted++;
      } catch (err) {
        await log.warn(
          "FACEBOOK",
          `Polling insert failed for leadgenId=${item.id}`,
          {
            userId: target.userId,
            pageId: target.pageId,
            formId: target.formId,
            error: String(err),
          },
          null,
          target.pageId,
          target.userId,
          "error",
          "facebook",
        );
      }
    }

    if (inserted > 0 || reEnriched > 0 || skipped > 0) {
      await log.info(
        "FACEBOOK",
        `[Polling] form=${target.formId} inserted=${inserted} reEnriched=${reEnriched} skipped=${skipped} (window=${hoursBack}h)`,
        {
          userId: target.userId,
          pageId: target.pageId,
          formId: target.formId,
          inserted,
          reEnriched,
          skipped,
          hoursBack,
        },
        null,
        target.pageId,
        target.userId,
        "lead_received",
        "facebook",
      );
    }

    return { inserted, reEnriched, skipped };
  } catch (err) {
    return { inserted: 0, reEnriched: 0, skipped: 0, error: String(err) };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute one polling tick across all active forms. Returns aggregated
 * counters that the scheduler logs / surfaces for admin diagnostics.
 */
export async function runLeadPollingTick(): Promise<PollingTickResult> {
  const started = Date.now();
  const db = await getDb();
  if (!db) {
    console.warn("[LeadPolling] DB not available, skipping tick");
    return {
      forms: 0,
      leadsInserted: 0,
      leadsReEnriched: 0,
      leadsSkipped: 0,
      errors: 0,
      durationMs: 0,
    };
  }

  const targets = await loadActiveTargets(db);
  if (targets.length === 0) {
    return {
      forms: 0,
      leadsInserted: 0,
      leadsReEnriched: 0,
      leadsSkipped: 0,
      errors: 0,
      durationMs: Date.now() - started,
    };
  }

  const bounded = targets.slice(0, MAX_FORMS_PER_TICK);
  if (targets.length > MAX_FORMS_PER_TICK) {
    console.warn(
      `[LeadPolling] ${targets.length} active forms — capping to ${MAX_FORMS_PER_TICK} per tick`,
    );
  }

  let leadsInserted = 0;
  let leadsReEnriched = 0;
  let leadsSkipped = 0;
  let errors = 0;

  for (const target of bounded) {
    const result = await pollSingleTarget(db, target);
    leadsInserted += result.inserted;
    leadsReEnriched += result.reEnriched;
    leadsSkipped += result.skipped;
    if (result.error) {
      errors++;
      await log.warn(
        "FACEBOOK",
        `[Polling] tick error form=${target.formId}: ${result.error}`,
        { userId: target.userId, pageId: target.pageId, formId: target.formId },
        null,
        target.pageId,
        target.userId,
        "error",
        "facebook",
      );
    }
    if (bounded.length > 1) await delay(DELAY_BETWEEN_FORMS_MS);
  }

  const durationMs = Date.now() - started;
  if (leadsInserted > 0 || leadsReEnriched > 0 || errors > 0) {
    console.log(
      `[LeadPolling] tick — forms=${bounded.length} inserted=${leadsInserted} reEnriched=${leadsReEnriched} skipped=${leadsSkipped} errors=${errors} (${durationMs}ms)`,
    );
  }

  return {
    forms: bounded.length,
    leadsInserted,
    leadsReEnriched,
    leadsSkipped,
    errors,
    durationMs,
  };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

/**
 * Interval between polling ticks. Default 10 min matches Zapier's typical
 * fallback cadence and stays well inside Facebook's Graph rate limits for
 * a few hundred forms per tick. Override via `LEAD_POLLING_INTERVAL_MIN`.
 */
const POLLING_INTERVAL_MS = envInt("LEAD_POLLING_INTERVAL_MIN", 10) * 60 * 1000;

/** Startup grace so we don't pile onto the boot-time dispatch spike. */
const POLLING_INITIAL_DELAY_MS = 60 * 1000;

let pollingTimer: ReturnType<typeof setTimeout> | null = null;

export function isLeadPollingEnabled(): boolean {
  return String(process.env.ENABLE_LEAD_POLLING ?? "").toLowerCase() === "true";
}

/**
 * Start the polling scheduler. Safe to call once at process boot; no-op
 * when the feature flag is disabled or if already running.
 */
export function startLeadPollingScheduler(): void {
  if (!isLeadPollingEnabled()) {
    console.log("[LeadPolling] disabled (ENABLE_LEAD_POLLING != 'true')");
    return;
  }
  if (pollingTimer !== null) return;

  const tickAndReschedule = () => {
    void runLeadPollingTick()
      .catch((err) => console.error("[LeadPolling] tick crashed:", err))
      .finally(() => {
        pollingTimer = setTimeout(tickAndReschedule, POLLING_INTERVAL_MS);
      });
  };

  console.log(
    `[LeadPolling] enabled — first tick in ${Math.round(POLLING_INITIAL_DELAY_MS / 1000)}s, then every ${POLLING_INTERVAL_MS / 60000} min`,
  );
  pollingTimer = setTimeout(tickAndReschedule, POLLING_INITIAL_DELAY_MS);
}

export function stopLeadPollingScheduler(): void {
  if (pollingTimer !== null) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
}
