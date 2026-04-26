import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { appActions } from "../../drizzle/schema";
import { and, asc, eq } from "drizzle-orm";
import { parseActionSchema } from "../integrations/actionSchema";

const APP_KEY_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const ACTION_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const adminAppActionsRouter = router({
  listByApp: adminProcedure
    .input(z.object({ appKey: z.string().regex(APP_KEY_RE) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];

      return db
        .select()
        .from(appActions)
        .where(eq(appActions.appKey, input.appKey))
        .orderBy(asc(appActions.actionKey));
    }),

  get: adminProcedure
    .input(z.object({ appKey: z.string().regex(APP_KEY_RE), actionKey: z.string().regex(ACTION_KEY_RE) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      const [row] = await db
        .select()
        .from(appActions)
        .where(and(eq(appActions.appKey, input.appKey), eq(appActions.actionKey, input.actionKey)))
        .limit(1);

      return row ?? null;
    }),

  /**
   * Set / replace schema for one action.
   * This is the "no-hardcode" contract for Make.com-like forms and mapping.
   */
  setSchema: adminProcedure
    .input(
      z.object({
        appKey: z.string().regex(APP_KEY_RE),
        actionKey: z.string().regex(ACTION_KEY_RE),
        schema: z.unknown(),
        uiSchema: z.unknown().optional(),
        outputSchema: z.unknown().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      }

      const [existing] = await db
        .select({ id: appActions.id })
        .from(appActions)
        .where(and(eq(appActions.appKey, input.appKey), eq(appActions.actionKey, input.actionKey)))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Action not found: ${input.appKey}.${input.actionKey}`,
        });
      }

      // Validate the schema shape (strict).
      const parsed = parseActionSchema(input.schema);

      await db
        .update(appActions)
        .set({
          schemaVersion: parsed.version,
          inputSchema: parsed,
          outputSchema: input.outputSchema ?? null,
          uiSchema: input.uiSchema ?? null,
        })
        .where(eq(appActions.id, existing.id));

      return { ok: true as const };
    }),
});

