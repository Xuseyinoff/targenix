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

const router: Router = createRouter();

router.get("/events/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", process.env.APP_URL || "http://localhost:3000");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeat);
    }
  }, 20000);

  res.on("close", () => clearInterval(heartbeat));
  addSseClient(res);
  res.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
});

router.get("/facebook", async (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const verifyToken = process.env.FACEBOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && token === verifyToken) {
    void log.info("WEBHOOK", "Facebook webhook verification successful", { mode, token: "***" }, null, null, null, "webhook_verified", "facebook");
    res.status(200).send(challenge);
  } else {
    void log.warn("WEBHOOK", "Facebook webhook verification failed - token mismatch", { mode }, null, null, null, "webhook_rejected", "facebook");
    res.status(403).json({ error: "Verification failed" });
  }
});

router.post("/facebook", async (req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });

  const appSecret = process.env.FACEBOOK_APP_SECRET || "";
  const signatureHeader = req.headers["x-hub-signature-256"] as string | undefined;
  const rawBody: Buffer = (req as any).rawBody;
  const verified = rawBody ? verifyWebhookSignature(rawBody, signatureHeader, appSecret) : false;
  const payload = req.body;
  const timestamp = new Date().toISOString();

  void log.info("HTTP", `POST /api/webhooks/facebook - verified=${verified}`, {
    ip: req.ip,
    verified,
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

  const db = await getDb();
  let savedEventId: number | undefined;
  if (db) {
    try {
      const result = await db.insert(webhookEvents).values({
        eventType: payload?.object || "unknown",
        payload,
        signature: signatureHeader,
        verified,
        processed: false,
      });
      savedEventId = (result as any)?.[0]?.insertId ?? (result as any)?.insertId;
    } catch (err) {
      console.error("[Webhook] Failed to log event:", err);
    }
  }

  const isTestPayload = !!payload?.sample;
  const isRealLeadgenEvent = payload?.object === "page" && Array.isArray(payload?.entry);

  if (!verified && appSecret && signatureHeader && !isTestPayload) {
    void log.warn("WEBHOOK", "Invalid signature - request rejected", { signature: signatureHeader?.slice(0, 20) + "..." });
    emitWebhookEvent({ type: "error", error: "Invalid signature", timestamp: new Date().toISOString() });
    return;
  }

  if (!verified && appSecret && !signatureHeader && !isTestPayload && !isRealLeadgenEvent) {
    void log.warn("WEBHOOK", "No signature and unknown payload format - request skipped", { payloadKeys: Object.keys(payload || {}) });
    emitWebhookEvent({ type: "error", error: "Unknown payload format", timestamp: new Date().toISOString() });
    return;
  }

  const resolveUserIdsForPage = async (pageId: string): Promise<number[]> => {
    if (!db) return [];
    try {
      const rows = await db
        .select({ userId: facebookConnections.userId })
        .from(facebookConnections)
        .where(eq(facebookConnections.pageId, pageId));
      return Array.from(new Set(rows.map((r) => r.userId)));
    } catch {
      return [];
    }
  };

  const dispatchLead = async (params: {
    leadId: number;
    leadgenId: string;
    pageId: string;
    formId: string;
    userId: number;
  }) => {
    await dispatchLeadProcessing(params).catch(async (err) => {
      await log.error("LEAD", `dispatchLeadProcessing failed - leadgenId=${params.leadgenId} userId=${params.userId}`, { error: String(err) }, params.leadId, params.pageId, params.userId);
    });
    emitWebhookEvent({
      type: "processed",
      eventId: savedEventId,
      leadgenId: params.leadgenId,
      pageId: params.pageId,
      formId: params.formId,
      processed: true,
      timestamp: new Date().toISOString(),
    });
  };

  if (payload?.sample?.field === "leadgen") {
    const value = payload.sample.value;
    const leadgenId: string = value?.leadgen_id || `test-${Date.now()}`;
    const pageId: string = value?.page_id || "test-page";
    const formId: string = value?.form_id || "test-form";

    void log.info("WEBHOOK", `Facebook test lead received - leadgenId=${leadgenId}`, { leadgenId, pageId, formId }, null, pageId, null, "lead_received", "facebook");

    const userIds = await resolveUserIdsForPage(pageId);
    if (userIds.length === 0) {
      void log.warn("WEBHOOK", `No user found for pageId=${pageId} - test lead skipped`, { pageId, leadgenId }, null, pageId, null, "webhook_dispatched", "facebook");
      return;
    }

    void log.info("WEBHOOK", `Test lead dispatching to ${userIds.length} user(s) for pageId=${pageId}`, { userIds, leadgenId }, null, pageId, null, "webhook_dispatched", "facebook");

    for (const userId of userIds) {
      const leadId = await saveIncomingLead({
        userId,
        pageId,
        formId,
        leadgenId: `${leadgenId}-u${userId}`,
        rawData: value,
      });
      if (leadId) {
        void dispatchLead({ leadId, leadgenId, pageId, formId, userId });
      }
    }

    if (db && savedEventId) {
      await db.update(webhookEvents).set({ processed: true }).where(eq(webhookEvents.id, savedEventId));
    }
    return;
  }

  if (payload?.object === "page" && Array.isArray(payload?.entry)) {
    for (const entry of payload.entry) {
      const pageId: string = entry.id;
      const changes: any[] = entry.changes || [];

      for (const change of changes) {
        if (change.field !== "leadgen") continue;

        const leadgenId: string = change.value?.leadgen_id;
        const formId: string = change.value?.form_id;
        if (!leadgenId) continue;

        void log.info("WEBHOOK", `New lead received - leadgenId=${leadgenId} pageId=${pageId}`, { leadgenId, pageId, formId }, null, pageId, null, "lead_received", "facebook");

        const userIds = await resolveUserIdsForPage(pageId);
        if (userIds.length === 0) {
          void log.warn("WEBHOOK", `No user found for pageId=${pageId} - lead skipped`, { pageId, leadgenId }, null, pageId, null, "webhook_dispatched", "facebook");
          continue;
        }

        void log.info("WEBHOOK", `Lead dispatching to ${userIds.length} user(s) for pageId=${pageId}`, { userIds, leadgenId }, null, pageId, null, "webhook_dispatched", "facebook");

        for (const userId of userIds) {
          const leadId = await saveIncomingLead({
            userId,
            pageId,
            formId: formId || "",
            leadgenId,
            rawData: change.value,
          });

          if (leadId) {
            void dispatchLead({ leadId, leadgenId, pageId, formId: formId || "", userId });
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
