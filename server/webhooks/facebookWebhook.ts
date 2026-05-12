import type { Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { webhookEvents, facebookConnections } from "../../drizzle/schema";
import { verifyWebhookSignature } from "../services/facebookService";
import { saveIncomingLead } from "../services/leadService";
import { dispatchLeadProcessing } from "../services/leadDispatch";
import { addSseClient, emitWebhookEvent } from "./sseEmitter";
import { log } from "../services/appLogger";
import { sdk } from "../_core/sdk";
import { checkPageLeadRate } from "../lib/webhookRateLimit";

const router: Router = createRouter();

// ─── GET /api/webhooks/events/stream — SSE real-time event stream (admin only) ─
router.get("/events/stream", async (req: Request, res: Response) => {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", process.env.APP_URL || "http://localhost:3000");
  res.flushHeaders();

  // Send a heartbeat every 20s to keep the connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  res.on("close", () => clearInterval(heartbeat));

  // Register this client
  addSseClient(res);

  // Send initial connected event
  res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
});

// ─── GET /api/webhooks/facebook — Facebook hub.challenge verification ─────────
router.get("/facebook", async (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const verifyToken = process.env.FACEBOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token === verifyToken) {
    void log.info("WEBHOOK", "Facebook webhook verification successful", { mode, token: "***" }, null, null, null, "webhook_verified", "facebook");
    res.status(200).send(challenge);
  } else {
    void log.warn("WEBHOOK", "Facebook webhook verification failed — token mismatch", { mode }, null, null, null, "webhook_rejected", "facebook");
    res.status(403).json({ error: "Verification failed" });
  }
});

// ─── POST /api/webhooks/facebook — Receive lead events ───────────────────────
//
// Durability contract (Sprint 1 / Item 1.1):
//   1. Compute signature verification (cheap, no I/O).
//   2. Persist the raw payload in `webhook_events` — the durability boundary.
//   3. Only THEN ack Facebook with HTTP 200.
//   4. Process the lead in the background. If the process crashes here, the
//      `webhook_events` row remains with processed=false and the replay
//      tooling (tooling/replay-webhook-events.ts) re-runs it.
//
// Idempotency: `webhook_events.signature` carries a UNIQUE index. Facebook
// retries the same payload with the same X-Hub-Signature-256 header → INSERT
// fails with ER_DUP_ENTRY → we skip processing (the original delivery is
// either already done or in flight). Test payloads with no signature still
// flow through (MySQL unique permits multiple NULLs).
router.post("/facebook", async (req: Request, res: Response) => {
  const appSecret = process.env.FACEBOOK_APP_SECRET || "";
  const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;
  const rawBody: Buffer = (req as any).rawBody;

  const verified = rawBody
    ? verifyWebhookSignature(rawBody, signatureHeader, appSecret)
    : false;

  const payload = req.body;
  const timestamp = new Date().toISOString();

  // ── STEP 1 — Durable insert BEFORE acking Facebook ───────────────────────
  // If this fails, return 500 so Facebook retries (their retry window is
  // limited, but it's the only chance we get).
  const db = await getDb();
  let savedEventId: number | undefined;
  let isDuplicate = false;
  if (db) {
    try {
      const result = await db.insert(webhookEvents).values({
        eventType: payload?.object || "unknown",
        payload,
        signature: signatureHeader,
        verified,
        processed: false,
      });
      const insertId = (result as any)?.[0]?.insertId ?? (result as any)?.insertId;
      savedEventId = insertId && insertId > 0 ? insertId : undefined;
    } catch (err) {
      // ER_DUP_ENTRY (1062) → Facebook retry, we already have this. Ack 200
      // and skip processing. Drizzle wraps the mysql2 error so we walk the
      // .cause chain in case the duplicate marker is nested.
      const isDupError = (e: unknown): boolean => {
        if (!e || typeof e !== "object") return false;
        const o = e as { code?: string; errno?: number; cause?: unknown };
        if (o.code === "ER_DUP_ENTRY" || o.errno === 1062) return true;
        if (o.cause) return isDupError(o.cause);
        return false;
      };
      if (isDupError(err)) {
        isDuplicate = true;
        console.log("[Webhook] Duplicate signature — already received, ack only.");
      } else {
        console.error("[Webhook] CRITICAL: durable insert failed:", err);
        // Sprint 5 / Item 5.1 — escalate to Sentry. This is the one path
        // where a process crash could lose leads (Facebook retries the
        // webhook with limited attempts), so we want a page-able alert.
        const { captureCritical } = await import("../monitoring/sentry");
        captureCritical(err, {
          tags: { category: "WEBHOOK", durability: "lost" },
          extra: {
            signaturePresent: Boolean(signatureHeader),
            payloadKeys: payload ? Object.keys(payload).slice(0, 10) : [],
          },
        });
        // DB hiccup — best we can do is signal Facebook to retry. They will
        // retry a couple of times before giving up.
        res.status(500).json({ status: "error", message: "Database unavailable" });
        return;
      }
    }
  } else {
    // No DB at all — log and ack so Facebook stops retrying. Loss is
    // unavoidable here and only happens in misconfigured environments.
    console.error("[Webhook] CRITICAL: no DB connection — webhook NOT persisted.");
  }

  // ── STEP 2 — Ack Facebook ────────────────────────────────────────────────
  res.status(200).json({ status: "ok" });

  // ── STEP 3 — Side-channel logging + SSE (best-effort, post-ack) ──────────
  void log.info("HTTP", `POST /api/webhooks/facebook — verified=${verified}`, {
    ip: req.ip,
    verified,
    duplicate: isDuplicate,
    payloadPreview: JSON.stringify(payload).slice(0, 400),
  }, null, null, null, "lead_received", "facebook");

  emitWebhookEvent({
    type: "incoming",
    verified,
    pageId: payload?.entry?.[0]?.id || payload?.sample?.value?.page_id,
    formId: payload?.entry?.[0]?.changes?.[0]?.value?.form_id || payload?.sample?.value?.form_id,
    leadgenId: payload?.entry?.[0]?.changes?.[0]?.value?.leadgen_id || payload?.sample?.value?.leadgen_id,
    timestamp,
  });

  // ── STEP 4 — Skip processing on duplicate (original handler owns this) ───
  if (isDuplicate) return;

  // When FACEBOOK_APP_SECRET is configured, REQUIRE valid HMAC on ALL payloads.
  // Facebook always sends X-Hub-Signature-256 — any unsigned request is forged.
  if (appSecret && !verified) {
    const reason = signatureHeader ? "Invalid HMAC signature" : "Missing X-Hub-Signature-256 header";
    void log.warn("WEBHOOK", `${reason} — request rejected`, {
      signature: signatureHeader?.slice(0, 20),
      payloadKeys: Object.keys(payload || {}),
    });
    emitWebhookEvent({ type: "error", error: reason, timestamp: new Date().toISOString() });
    return;
  }

  // Resolve ALL userIds for a pageId from facebookConnections.
  // Multiple Targenix users can connect the same Facebook page — each gets their own lead.
  const resolveUserIdsForPage = async (pageId: string): Promise<number[]> => {
    if (!db) return [];
    try {
      const rows = await db
        .select({ userId: facebookConnections.userId })
        .from(facebookConnections)
        .where(eq(facebookConnections.pageId, pageId));
      // Deduplicate in case a user has multiple connections for the same page
      return Array.from(new Set(rows.map((r) => r.userId)));
    } catch (_) {
      return [];
    }
  };

  // ── Handle Facebook "Send to My Server" test payload ──────────────────────
  if (payload?.sample?.field === "leadgen") {
    const value = payload.sample.value;
    const leadgenId: string = value?.leadgen_id || `test-${Date.now()}`;
    const pageId: string = value?.page_id || "test-page";
    const formId: string = value?.form_id || "test-form";

    const rateDecision = checkPageLeadRate(pageId);
    if (!rateDecision.allowed) {
      void log.warn(
        "WEBHOOK",
        `Test lead throttled — pageId=${pageId} count=${rateDecision.count}/${rateDecision.cap}/min`,
        { pageId, leadgenId, count: rateDecision.count, cap: rateDecision.cap, retryAfterSec: rateDecision.retryAfterSec },
        null,
        pageId,
        null,
        "lead_throttled",
        "facebook",
      );
      return;
    }

    void log.info("WEBHOOK", `Facebook test lead received — leadgenId=${leadgenId}`, { leadgenId, pageId, formId }, null, pageId, null, "lead_received", "facebook");

    const userIds = await resolveUserIdsForPage(pageId);
    if (userIds.length === 0) {
      void log.warn("WEBHOOK", `No user found for pageId=${pageId} — test lead skipped`, { pageId, leadgenId }, null, pageId, null, "webhook_dispatched", "facebook");
      return;
    }

    void log.info("WEBHOOK", `Test lead dispatching to ${userIds.length} user(s) for pageId=${pageId}`, { userIds, leadgenId }, null, pageId, null, "webhook_dispatched", "facebook");

    for (const userId of userIds) {
      const leadId = await saveIncomingLead({ userId, pageId, formId, leadgenId: `${leadgenId}-u${userId}`, rawData: value });
      if (leadId) {
        await dispatchLeadProcessing({ leadId, leadgenId, pageId, formId, userId });
        emitWebhookEvent({ type: "processed", eventId: savedEventId, leadgenId, pageId, formId, processed: true, timestamp: new Date().toISOString() });
      }
    }

    if (db && savedEventId) {
      await db.update(webhookEvents).set({ processed: true }).where(eq(webhookEvents.id, savedEventId));
    }
    return;
  }

  // ── Handle real Facebook leadgen webhook payload ───────────────────────────
  if (payload?.object === "page" && Array.isArray(payload?.entry)) {
    for (const entry of payload.entry) {
      const pageId: string = entry.id;
      const changes: any[] = entry.changes || [];

      for (const change of changes) {
        if (change.field !== "leadgen") continue;

        const leadgenId: string = change.value?.leadgen_id;
        const formId: string = change.value?.form_id;

        if (!leadgenId) continue;

        const rateDecision = checkPageLeadRate(pageId);
        if (!rateDecision.allowed) {
          void log.warn(
            "WEBHOOK",
            `Lead throttled — pageId=${pageId} count=${rateDecision.count}/${rateDecision.cap}/min`,
            { pageId, leadgenId, count: rateDecision.count, cap: rateDecision.cap, retryAfterSec: rateDecision.retryAfterSec },
            null,
            pageId,
            null,
            "lead_throttled",
            "facebook",
          );
          continue;
        }

        void log.info("WEBHOOK", `New lead received — leadgenId=${leadgenId} pageId=${pageId}`, { leadgenId, pageId, formId }, null, pageId, null, "lead_received", "facebook");

        const userIds = await resolveUserIdsForPage(pageId);
        if (userIds.length === 0) {
          void log.warn("WEBHOOK", `No user found for pageId=${pageId} — lead skipped`, { pageId, leadgenId }, null, pageId, null, "webhook_dispatched", "facebook");
          continue;
        }

        void log.info("WEBHOOK", `Lead dispatching to ${userIds.length} user(s) for pageId=${pageId}`, { userIds, leadgenId }, null, pageId, null, "webhook_dispatched", "facebook");

        for (const userId of userIds) {
          // Each user gets their own lead record — fully isolated per tenant
          const leadId = await saveIncomingLead({ userId, pageId, formId: formId || "", leadgenId, rawData: change.value });

          if (leadId) {
            await dispatchLeadProcessing({ leadId, leadgenId, pageId, formId: formId || "", userId });
            emitWebhookEvent({ type: "processed", eventId: savedEventId, leadgenId, pageId, formId, processed: true, timestamp: new Date().toISOString() });
          }
        }

        if (db && savedEventId) {
          await db.update(webhookEvents).set({ processed: true }).where(eq(webhookEvents.id, savedEventId));
        }
      }
    }
  }
});

export default router;
