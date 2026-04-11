/**
 * adminTemplatesRouter — Admin CRUD for destination templates.
 *
 * These templates define how leads are sent to affiliate endpoints.
 * Admins create templates; users pick a template when creating a destination.
 *
 * Security: all routes require isAdmin (via adminProcedure).
 */

import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { destinationTemplates } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";

// ─── Shared Zod schemas ───────────────────────────────────────────────────────

const bodyFieldSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  isSecret: z.boolean().default(false),
});

const autoMappedFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
});

const templateInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#3B82F6"),
  endpointUrl: z.string().url().max(500),
  method: z.enum(["POST", "GET"]).default("POST"),
  contentType: z.string().max(100).default("application/x-www-form-urlencoded"),
  bodyFields: z.array(bodyFieldSchema).min(1),
  userVisibleFields: z.array(z.string()),
  variableFields: z.array(z.string()),
  autoMappedFields: z.array(autoMappedFieldSchema),
  isActive: z.boolean().default(true),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export const adminTemplatesRouter = router({
  /** List all destination templates (admin only). */
  list: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(destinationTemplates)
      .orderBy(desc(destinationTemplates.createdAt));
  }),

  /** Create a new destination template. */
  create: adminProcedure
    .input(templateInputSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      await db.insert(destinationTemplates).values({
        name: input.name,
        description: input.description ?? null,
        color: input.color,
        endpointUrl: input.endpointUrl,
        method: input.method,
        contentType: input.contentType,
        bodyFields: input.bodyFields,
        userVisibleFields: input.userVisibleFields,
        variableFields: input.variableFields,
        autoMappedFields: input.autoMappedFields,
        isActive: input.isActive,
      });
      return { success: true };
    }),

  /** Update a destination template. */
  update: adminProcedure
    .input(templateInputSchema.partial().extend({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");

      const { id, ...fields } = input;
      const updates: Record<string, unknown> = {};

      if (fields.name !== undefined) updates.name = fields.name;
      if (fields.description !== undefined) updates.description = fields.description;
      if (fields.color !== undefined) updates.color = fields.color;
      if (fields.endpointUrl !== undefined) updates.endpointUrl = fields.endpointUrl;
      if (fields.method !== undefined) updates.method = fields.method;
      if (fields.contentType !== undefined) updates.contentType = fields.contentType;
      if (fields.bodyFields !== undefined) updates.bodyFields = fields.bodyFields;
      if (fields.userVisibleFields !== undefined) updates.userVisibleFields = fields.userVisibleFields;
      if (fields.variableFields !== undefined) updates.variableFields = fields.variableFields;
      if (fields.autoMappedFields !== undefined) updates.autoMappedFields = fields.autoMappedFields;
      if (fields.isActive !== undefined) updates.isActive = fields.isActive;

      await db
        .update(destinationTemplates)
        .set(updates)
        .where(eq(destinationTemplates.id, id));
      return { success: true };
    }),

  /** Delete a destination template. */
  delete: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error("DB not available");
      await db
        .delete(destinationTemplates)
        .where(eq(destinationTemplates.id, input.id));
      return { success: true };
    }),
});
