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

export interface PollingTickResult {
  forms: number;
  leadsInserted: number;
  leadsSkipped: number;
  errors: number;
  durationMs: number;
}

/**
 * Lookback window (hours) passed to `fetchLeadsFromForm` when a form has
 * NEVER produced a lead yet. Short enough to avoid reprocessing old data
 * on first activation; long enough to absorb a missed webhook burst.
 */
const DEFAULT_INITIAL_WINDOW_HOURS = 2;

/**
 * Extra slack (minutes) added on top of the derived cursor to compensate
 * for Facebook's `created_time` occasionally trailing our insert time by
 * a few minutes. Prevents edge leads from being dropped.
 */
const OVERLAP_MINUTES = 30;

/** Upper bound on forms polled per tick — safety net, logs a warning. */
const MAX_FORMS_PER_TICK = 200;

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
 *     (we DO poll `failed` subscriptions — that's the whole point).
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
    );

  return rows
    .filter((r) => r.subscriptionStatus !== "inactive")
    .map((r) => ({
      userId: r.userId,
      pageId: r.pageId,
      pageName: r.pageName,
      formId: r.formId,
      formName: r.formName,
      encryptedPageToken: r.encryptedPageToken,
    }));
}

/**
 * Derive a `hoursBack` cutoff per form from the newest lead already stored
 * for the given (userId, pageId, formId). Falls back to
 * `DEFAULT_INITIAL_WINDOW_HOURS` for forms that have never produced a lead.
 */
async function deriveHoursBack(
  db: DbClient,
  target: ActivePollingTarget,
): Promise<number> {
  const [row] = await db
    .select({ latest: sql<Date | null>`MAX(${leads.createdAt})` })
    .from(leads)
    .where(
      and(
        eq(leads.userId, target.userId),
        eq(leads.pageId, target.pageId),
        eq(leads.formId, target.formId),
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

/**
 * Returns the subset of leadgen IDs that already exist for this user.
 * Used to avoid re-dispatching leads the webhook path already handled.
 */
async function findExistingLeadgenIds(
  db: DbClient,
  userId: number,
  leadgenIds: string[],
): Promise<Set<string>> {
  if (leadgenIds.length === 0) return new Set();
  const rows = await db
    .select({ leadgenId: leads.leadgenId })
    .from(leads)
    .where(and(eq(leads.userId, userId), inArray(leads.leadgenId, leadgenIds)));
  return new Set(rows.map((r) => r.leadgenId));
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

async function pollSingleTarget(
  db: DbClient,
  target: ActivePollingTarget,
): Promise<{ inserted: number; skipped: number; error?: string }> {
  try {
    const hoursBack = await deriveHoursBack(db, target);
    const accessToken = decrypt(target.encryptedPageToken);

    const fetched = await fetchLeadsFromForm(target.formId, accessToken, {
      hoursBack,
      limit: 100,
    });

    if (fetched.length === 0) return { inserted: 0, skipped: 0 };

    const existingIds = await findExistingLeadgenIds(
      db,
      target.userId,
      fetched.map((x) => x.id),
    );

    let inserted = 0;
    let skipped = 0;
    for (const item of fetched) {
      if (existingIds.has(item.id)) {
        skipped++;
        continue;
      }
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

    if (inserted > 0 || skipped > 0) {
      await log.info(
        "FACEBOOK",
        `[Polling] form=${target.formId} inserted=${inserted} skipped=${skipped} (window=${hoursBack}h)`,
        {
          userId: target.userId,
          pageId: target.pageId,
          formId: target.formId,
          inserted,
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

    return { inserted, skipped };
  } catch (err) {
    return { inserted: 0, skipped: 0, error: String(err) };
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
    return { forms: 0, leadsInserted: 0, leadsSkipped: 0, errors: 0, durationMs: 0 };
  }

  const targets = await loadActiveTargets(db);
  if (targets.length === 0) {
    return { forms: 0, leadsInserted: 0, leadsSkipped: 0, errors: 0, durationMs: Date.now() - started };
  }

  const bounded = targets.slice(0, MAX_FORMS_PER_TICK);
  if (targets.length > MAX_FORMS_PER_TICK) {
    console.warn(
      `[LeadPolling] ${targets.length} active forms — capping to ${MAX_FORMS_PER_TICK} per tick`,
    );
  }

  let leadsInserted = 0;
  let leadsSkipped = 0;
  let errors = 0;

  for (const target of bounded) {
    const result = await pollSingleTarget(db, target);
    leadsInserted += result.inserted;
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
  if (leadsInserted > 0 || errors > 0) {
    console.log(
      `[LeadPolling] tick — forms=${bounded.length} inserted=${leadsInserted} skipped=${leadsSkipped} errors=${errors} (${durationMs}ms)`,
    );
  }

  return { forms: bounded.length, leadsInserted, leadsSkipped, errors, durationMs };
}

// ─── Scheduler ──────────────────────────────────────────────────────────────

/**
 * Interval between polling ticks. 10 minutes matches Zapier's typical
 * fallback cadence and stays well inside Facebook's Graph rate limits for
 * even 100+ forms per tick.
 */
const POLLING_INTERVAL_MS = 10 * 60 * 1000;

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
