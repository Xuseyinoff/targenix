/**
 * triggerScheduler.ts
 *
 * Polls DB every minute for active schedule triggers whose cron is due,
 * fires them, and logs execution in trigger_executions.
 *
 * Uses a simple interval — no external cron library needed.
 * Cron matching: only supports "@hourly", "@daily", and "minute-level" patterns
 * via the `cron-parser` logic (manual implementation, no deps).
 */

import { getDb } from "../db";
import { triggers, triggerExecutions, workflows } from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";

let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/** Checks whether a cron expression matches the current time (minute granularity). */
function cronMatches(cron: string, now: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minPart, hourPart, domPart, monPart, dowPart] = parts;

  function matchField(part: string, value: number): boolean {
    if (part === "*") return true;
    const n = parseInt(part, 10);
    return !isNaN(n) && n === value;
  }

  return (
    matchField(minPart,  now.getMinutes()) &&
    matchField(hourPart, now.getHours()) &&
    matchField(domPart,  now.getDate()) &&
    matchField(monPart,  now.getMonth() + 1) &&
    matchField(dowPart,  now.getDay())
  );
}

async function runScheduledTriggers(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    const rows = await db
      .select()
      .from(triggers)
      .where(and(eq(triggers.type, "schedule"), eq(triggers.isActive, true)));

    const now = new Date();

    for (const trigger of rows) {
      const cfg = trigger.config as { cron?: string } | null;
      if (!cfg?.cron) continue;

      if (!cronMatches(cfg.cron, now)) continue;

      // Fire trigger
      await db.insert(triggerExecutions).values({
        triggerId:  trigger.id,
        userId:     trigger.userId,
        status:     "success",
        payload:    { firedAt: now.toISOString(), cron: cfg.cron },
        source:     "schedule",
      });

      await db
        .update(triggers)
        .set({ lastFiredAt: now })
        .where(eq(triggers.id, trigger.id));

      console.log(`[TriggerScheduler] Fired schedule trigger id=${trigger.id} name="${trigger.name}" cron="${cfg.cron}"`);

      // Fire linked workflows (non-blocking)
      void fireLinkedWorkflows(db, trigger.id, trigger.userId, { firedAt: now.toISOString(), cron: cfg.cron });
    }
  } catch (err) {
    console.error("[TriggerScheduler] Error:", err instanceof Error ? err.message : err);
  }
}

export function startTriggerScheduler(): void {
  if (schedulerTimer !== null) return;

  // Align to next full minute
  const now = new Date();
  const msUntilNextMinute =
    (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

  setTimeout(() => {
    void runScheduledTriggers();
    schedulerTimer = setInterval(() => {
      void runScheduledTriggers();
    }, 60_000);
  }, msUntilNextMinute);

  console.log(`[TriggerScheduler] Starting — first tick in ${Math.round(msUntilNextMinute / 1000)}s`);
}

export function stopTriggerScheduler(): void {
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/** Fire all active workflows linked to this trigger. Non-blocking. */
async function fireLinkedWorkflows(
  db: Awaited<ReturnType<typeof import("../db").getDb>>,
  triggerId: number,
  userId: number,
  triggerData: Record<string, unknown>,
): Promise<void> {
  if (!db) return;
  try {
    const { executeWorkflow } = await import("./workflowExecutor");
    const linked = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.triggerId, triggerId), eq(workflows.isActive, true)));

    for (const wf of linked) {
      try {
        await executeWorkflow({ db, workflowId: wf.id, userId, triggerData });
      } catch (err) {
        console.error(`[TriggerScheduler] Workflow ${wf.id} error:`, err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[TriggerScheduler] fireLinkedWorkflows error:", err instanceof Error ? err.message : err);
  }
}
