import { Router } from "express";
import { getDb } from "../db";
import { triggers, triggerExecutions } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

export const triggerWebhookRouter = Router();

/**
 * POST /api/trigger/wh/:key
 *
 * Generic webhook receiver for user-created webhook triggers.
 * - Finds trigger by webhookKey
 * - Stores execution in trigger_executions
 * - Returns 200 immediately (fire-and-forget logging)
 */
triggerWebhookRouter.post("/wh/:key", async (req, res) => {
  const { key } = req.params;

  try {
    const db = await getDb();
    if (!db) {
      res.status(503).json({ ok: false, error: "service_unavailable" });
      return;
    }

    const [trigger] = await db
      .select({ id: triggers.id, userId: triggers.userId, isActive: triggers.isActive })
      .from(triggers)
      .where(eq(triggers.webhookKey, key))
      .limit(1);

    if (!trigger) {
      res.status(404).json({ ok: false, error: "trigger_not_found" });
      return;
    }

    if (!trigger.isActive) {
      res.status(200).json({ ok: false, error: "trigger_inactive" });
      return;
    }

    // Store execution — non-blocking
    void db.insert(triggerExecutions).values({
      triggerId:  trigger.id,
      userId:     trigger.userId,
      status:     "received",
      payload:    req.body ?? null,
      source:     "webhook",
    }).then(() =>
      db.update(triggers)
        .set({ lastFiredAt: new Date() })
        .where(eq(triggers.id, trigger.id))
    ).catch((err: unknown) => {
      console.error("[TriggerWebhook] Failed to log execution:", err);
    });

    res.status(200).json({ ok: true, triggerId: trigger.id });
  } catch (err) {
    console.error("[TriggerWebhook] Error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});
