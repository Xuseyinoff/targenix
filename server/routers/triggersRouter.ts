import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { triggers, triggerExecutions } from "../../drizzle/schema";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { randomBytes } from "crypto";

// ─── Input schemas ────────────────────────────────────────────────────────────

const CreateTriggerInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("webhook"),
    name: z.string().trim().min(1).max(255),
  }),
  z.object({
    type:   z.literal("schedule"),
    name:   z.string().trim().min(1).max(255),
    cron:   z.string().trim().min(1).max(128),
  }),
  z.object({
    type: z.literal("manual"),
    name: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("api"),
    name: z.string().trim().min(1).max(255),
  }),
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateWebhookKey(): string {
  return randomBytes(20).toString("hex"); // 40-char hex
}

function generateApiSecret(): string {
  return randomBytes(32).toString("hex");
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const triggersRouter = router({

  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select({
        id:          triggers.id,
        name:        triggers.name,
        type:        triggers.type,
        webhookKey:  triggers.webhookKey,
        isActive:    triggers.isActive,
        lastFiredAt: triggers.lastFiredAt,
        createdAt:   triggers.createdAt,
        execCount:   sql<number>`(
          SELECT COUNT(*) FROM trigger_executions te
          WHERE te.triggerId = ${triggers.id}
        )`,
      })
      .from(triggers)
      .where(eq(triggers.userId, ctx.user.id))
      .orderBy(desc(triggers.createdAt));

    return rows;
  }),

  get: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;

      const [row] = await db
        .select()
        .from(triggers)
        .where(and(eq(triggers.id, input.id), eq(triggers.userId, ctx.user.id)))
        .limit(1);

      return row ?? null;
    }),

  create: protectedProcedure
    .input(CreateTriggerInput)
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const webhookKey = input.type === "webhook" ? generateWebhookKey() : null;
      const config =
        input.type === "schedule" ? { cron: input.cron }
        : input.type === "api"    ? { secretHash: generateApiSecret() }
        : null;

      await db.insert(triggers).values({
        userId:     ctx.user.id,
        name:       input.name,
        type:       input.type,
        webhookKey,
        config,
        isActive:   true,
      });

      const [created] = await db
        .select()
        .from(triggers)
        .where(and(eq(triggers.userId, ctx.user.id)))
        .orderBy(desc(triggers.createdAt))
        .limit(1);

      return created;
    }),

  update: protectedProcedure
    .input(z.object({
      id:       z.number(),
      name:     z.string().trim().min(1).max(255).optional(),
      isActive: z.boolean().optional(),
      cron:     z.string().trim().min(1).max(128).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const [existing] = await db
        .select()
        .from(triggers)
        .where(and(eq(triggers.id, input.id), eq(triggers.userId, ctx.user.id)))
        .limit(1);

      if (!existing) throw new Error("Trigger topilmadi");

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined)     patch.name     = input.name;
      if (input.isActive !== undefined) patch.isActive = input.isActive;
      if (input.cron !== undefined && existing.type === "schedule") {
        patch.config = { ...(existing.config as object ?? {}), cron: input.cron };
      }

      if (Object.keys(patch).length) {
        await db.update(triggers).set(patch).where(eq(triggers.id, input.id));
      }

      return { ok: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      await db
        .delete(triggers)
        .where(and(eq(triggers.id, input.id), eq(triggers.userId, ctx.user.id)));

      return { ok: true };
    }),

  // ─── Manual fire ───────────────────────────────────────────────────────────

  fire: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const [trigger] = await db
        .select()
        .from(triggers)
        .where(and(eq(triggers.id, input.id), eq(triggers.userId, ctx.user.id)))
        .limit(1);

      if (!trigger) throw new Error("Trigger topilmadi");
      if (!trigger.isActive) throw new Error("Trigger faol emas");

      await db.insert(triggerExecutions).values({
        triggerId:  trigger.id,
        userId:     ctx.user.id,
        status:     "success",
        payload:    { firedBy: "manual", firedAt: new Date().toISOString() },
        source:     "manual",
      });

      await db
        .update(triggers)
        .set({ lastFiredAt: new Date() })
        .where(eq(triggers.id, trigger.id));

      return { ok: true };
    }),

  // ─── Execution history ─────────────────────────────────────────────────────

  executions: protectedProcedure
    .input(z.object({
      triggerId: z.number(),
      limit:     z.number().min(1).max(100).default(50),
      offset:    z.number().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };

      // Verify ownership
      const [trigger] = await db
        .select({ id: triggers.id })
        .from(triggers)
        .where(and(eq(triggers.id, input.triggerId), eq(triggers.userId, ctx.user.id)))
        .limit(1);

      if (!trigger) return { items: [], total: 0 };

      const where = eq(triggerExecutions.triggerId, input.triggerId);

      const [items, [{ total }]] = await Promise.all([
        db
          .select()
          .from(triggerExecutions)
          .where(where)
          .orderBy(desc(triggerExecutions.executedAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ total: sql<number>`COUNT(*)` })
          .from(triggerExecutions)
          .where(where),
      ]);

      return { items, total };
    }),

  // ─── Regenerate webhook key ────────────────────────────────────────────────

  regenerateKey: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const [trigger] = await db
        .select()
        .from(triggers)
        .where(and(eq(triggers.id, input.id), eq(triggers.userId, ctx.user.id)))
        .limit(1);

      if (!trigger) throw new Error("Trigger topilmadi");
      if (trigger.type !== "webhook" && trigger.type !== "api") {
        throw new Error("Faqat webhook/api trigger uchun");
      }

      const newKey = generateWebhookKey();
      await db.update(triggers).set({ webhookKey: newKey }).where(eq(triggers.id, input.id));

      return { webhookKey: newKey };
    }),
});
