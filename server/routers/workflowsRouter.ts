import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import {
  workflows,
  workflowSteps,
  workflowExecutions,
  workflowStepExecutions,
} from "../../drizzle/schema";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { executeWorkflow } from "../services/workflowExecutor";

// ─── Step config schemas ──────────────────────────────────────────────────────

const HttpRequestConfig = z.object({
  url:     z.string().min(1).max(2048),
  method:  z.enum(["GET","POST","PUT","PATCH","DELETE"]).default("POST"),
  headers: z.record(z.string(), z.string()).optional(),
  body:    z.string().optional(),
  timeout: z.number().min(1000).max(30_000).default(10_000),
});

const TelegramConfig = z.object({
  chatId:  z.string().min(1).max(64),
  message: z.string().min(1).max(4096),
});

const SetVariableConfig = z.object({
  key:   z.string().min(1).max(64),
  value: z.string().max(2048),
});

const ConditionConfig = z.object({
  field:    z.string().min(1).max(512),
  operator: z.enum(["eq","neq","contains","not_contains","starts_with","ends_with","gt","gte","lt","lte","exists","not_exists","in","not_in"]),
  value:    z.string().max(500).default(""),
  onFail:   z.enum(["stop","continue"]).default("stop"),
});

const StepConfigSchema = z.discriminatedUnion("__type", [
  HttpRequestConfig.extend({ __type: z.literal("http_request") }),
  TelegramConfig.extend({ __type: z.literal("telegram") }),
  SetVariableConfig.extend({ __type: z.literal("set_variable") }),
  ConditionConfig.extend({ __type: z.literal("condition") }),
]);

const StepInputSchema = z.object({
  type:           z.enum(["http_request","telegram","set_variable","condition"]),
  name:           z.string().trim().min(1).max(255),
  config:         z.record(z.string(), z.any()),
  continueOnError: z.boolean().default(false),
  position:       z.number().int().min(0),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const workflowsRouter = router({

  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select({
        id:        workflows.id,
        name:      workflows.name,
        isActive:  workflows.isActive,
        triggerId: workflows.triggerId,
        createdAt: workflows.createdAt,
        stepCount: sql<number>`(SELECT COUNT(*) FROM workflow_steps WHERE workflowId = ${workflows.id})`,
        lastRunAt: sql<Date | null>`(SELECT MAX(startedAt) FROM workflow_executions WHERE workflowId = ${workflows.id})`,
        lastStatus: sql<string | null>`(SELECT status FROM workflow_executions WHERE workflowId = ${workflows.id} ORDER BY startedAt DESC LIMIT 1)`,
      })
      .from(workflows)
      .where(eq(workflows.userId, ctx.user.id))
      .orderBy(desc(workflows.createdAt));

    return rows;
  }),

  get: protectedProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;

      const [wf] = await db
        .select()
        .from(workflows)
        .where(and(eq(workflows.id, input.id), eq(workflows.userId, ctx.user.id)))
        .limit(1);

      if (!wf) return null;

      const steps = await db
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.workflowId, wf.id))
        .orderBy(asc(workflowSteps.position), asc(workflowSteps.id));

      return { ...wf, steps };
    }),

  create: protectedProcedure
    .input(z.object({
      name:        z.string().trim().min(1).max(255),
      description: z.string().max(1000).optional(),
      triggerId:   z.number().int().positive().optional(),
      steps:       z.array(StepInputSchema).max(20),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const [ins] = await db
        .insert(workflows)
        .values({
          userId:      ctx.user.id,
          name:        input.name,
          description: input.description ?? null,
          triggerId:   input.triggerId ?? null,
          isActive:    true,
        })
        .$returningId();

      const wfId = ins.id;

      if (input.steps.length > 0) {
        await db.insert(workflowSteps).values(
          input.steps.map((s) => ({
            workflowId:      wfId,
            position:        s.position,
            type:            s.type,
            name:            s.name,
            config:          s.config,
            continueOnError: s.continueOnError,
          }))
        );
      }

      return { id: wfId };
    }),

  update: protectedProcedure
    .input(z.object({
      id:          z.number(),
      name:        z.string().trim().min(1).max(255).optional(),
      description: z.string().max(1000).optional(),
      isActive:    z.boolean().optional(),
      triggerId:   z.number().int().positive().nullable().optional(),
      steps:       z.array(StepInputSchema).max(20).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const [wf] = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, input.id), eq(workflows.userId, ctx.user.id)))
        .limit(1);
      if (!wf) throw new Error("Workflow topilmadi");

      const patch: Record<string, unknown> = {};
      if (input.name        !== undefined) patch.name        = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.isActive    !== undefined) patch.isActive    = input.isActive;
      if (input.triggerId   !== undefined) patch.triggerId   = input.triggerId;

      if (Object.keys(patch).length) {
        await db.update(workflows).set(patch).where(eq(workflows.id, input.id));
      }

      if (input.steps !== undefined) {
        await db.delete(workflowSteps).where(eq(workflowSteps.workflowId, input.id));
        if (input.steps.length > 0) {
          await db.insert(workflowSteps).values(
            input.steps.map((s) => ({
              workflowId:      input.id,
              position:        s.position,
              type:            s.type,
              name:            s.name,
              config:          s.config,
              continueOnError: s.continueOnError,
            }))
          );
        }
      }

      return { ok: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      await db
        .delete(workflows)
        .where(and(eq(workflows.id, input.id), eq(workflows.userId, ctx.user.id)));

      return { ok: true };
    }),

  // ─── Run ────────────────────────────────────────────────────────────────────

  run: protectedProcedure
    .input(z.object({
      id:          z.number(),
      triggerData: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB unavailable");

      const result = await executeWorkflow({
        db,
        workflowId:  input.id,
        userId:      ctx.user.id,
        triggerData: (input.triggerData as Record<string, unknown>) ?? {},
      });

      return result;
    }),

  // ─── Execution history ───────────────────────────────────────────────────────

  executions: protectedProcedure
    .input(z.object({
      workflowId: z.number(),
      limit:      z.number().min(1).max(50).default(20),
      offset:     z.number().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { items: [], total: 0 };

      const [wf] = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.id, input.workflowId), eq(workflows.userId, ctx.user.id)))
        .limit(1);
      if (!wf) return { items: [], total: 0 };

      const [items, [{ total }]] = await Promise.all([
        db
          .select()
          .from(workflowExecutions)
          .where(eq(workflowExecutions.workflowId, input.workflowId))
          .orderBy(desc(workflowExecutions.startedAt))
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ total: sql<number>`COUNT(*)` })
          .from(workflowExecutions)
          .where(eq(workflowExecutions.workflowId, input.workflowId)),
      ]);

      return { items, total };
    }),

  executionDetail: protectedProcedure
    .input(z.object({ executionId: z.number() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;

      const [exec] = await db
        .select()
        .from(workflowExecutions)
        .where(and(
          eq(workflowExecutions.id, input.executionId),
          eq(workflowExecutions.userId, ctx.user.id),
        ))
        .limit(1);
      if (!exec) return null;

      const steps = await db
        .select()
        .from(workflowStepExecutions)
        .where(eq(workflowStepExecutions.executionId, input.executionId))
        .orderBy(asc(workflowStepExecutions.position), asc(workflowStepExecutions.id));

      return { ...exec, steps };
    }),
});
