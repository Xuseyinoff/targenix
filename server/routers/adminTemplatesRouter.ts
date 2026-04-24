/**
 * adminTemplatesRouter — Admin CRUD for destination templates.
 *
 * These templates define how leads are sent to affiliate endpoints.
 * Admins create templates; users pick a template when creating a destination.
 *
 * Security: all routes require isAdmin (via adminProcedure).
 *
 * Stage 1 contract: every mutation runs `validateTemplateContract` which
 * verifies the `appKey` resolves to a known spec and that every secret
 * field is referenced via `{{SECRET:<key>}}` pointing at a declared
 * sensitive field. Literal secrets and undeclared keys are rejected
 * with TRPCError BAD_REQUEST before any DB write.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { destinationTemplates } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { listDestinationTemplatesWithMirrorOverlay } from "../integrations/dynamicTemplateSource";
import {
  validateTemplateContract,
  TemplateContractError,
} from "../integrations/validateTemplateContract";
import {
  listAppKeyOptionsForPicker,
  resolveSpecForValidation,
} from "../integrations/listAppsSafe";

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

/**
 * Product category — drives how the template is grouped in the user-facing
 * Destinations picker. Must match the mysqlEnum in drizzle/schema.ts.
 */
export const TEMPLATE_CATEGORIES = [
  "messaging",
  "data",
  "webhooks",
  "affiliate",
  "crm",
] as const;

const categorySchema = z.enum(TEMPLATE_CATEGORIES);

/**
 * Structural shape — grammatical checks on appKey happen here; semantic
 * validation (appKey exists, secret keys declared) is delegated to
 * `validateTemplateContract` which is called by create/update mutations.
 */
const APP_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const appKeySchema = z
  .string()
  .regex(APP_KEY_RE, "appKey must match /^[a-z0-9][a-z0-9_-]{0,63}$/");

const templateInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#3B82F6"),
  category: categorySchema.default("affiliate"),
  appKey: appKeySchema,
  endpointUrl: z.string().url().max(500),
  method: z.enum(["POST", "GET"]).default("POST"),
  contentType: z.string().max(100).default("application/x-www-form-urlencoded"),
  bodyFields: z.array(bodyFieldSchema).min(1),
  userVisibleFields: z.array(z.string()),
  variableFields: z.array(z.string()),
  autoMappedFields: z.array(autoMappedFieldSchema),
  isActive: z.boolean().default(true),
});

/**
 * Translate a TemplateContractError (thrown by the validator) into a
 * TRPCError so the router contract remains uniform. The structured
 * `details` and `code` are preserved as `cause` for logs.
 */
function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TemplateContractError) {
    return new TRPCError({
      code: "BAD_REQUEST",
      message: err.message,
      cause: {
        contractCode: err.code,
        ...err.details,
      } as Record<string, unknown>,
    });
  }
  if (err instanceof TRPCError) return err;
  if (err instanceof Error) {
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "unknown" });
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const adminTemplatesRouter = router({
  /** List all destination templates (admin only). */
  list: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    // Stage 2 — `destination_templates` is still authoritative for id / writes;
    // mirror rows from `app_actions` overlay name/url/body when 0048 pair exists.
    return listDestinationTemplatesWithMirrorOverlay(db);
  }),

  /**
   * List every known connection app spec. Consumed by the admin template
   * editor to render the appKey picker and surface whether the app needs
   * credentials (so the admin knows to — or not to — add secret fields).
   *
   * `requiresCredentials` is a pre-computed convenience flag: true for
   * api_key/oauth2/bearer/basic specs, false for authType='none' apps.
   * The raw authType is kept for UIs that want to render differently per
   * protocol (e.g. badge color, help text).
   */
  listAppKeys: adminProcedure.query(async () => {
    const db = await getDb();
    return listAppKeyOptionsForPicker(db);
  }),

  /** Create a new destination template. */
  create: adminProcedure
    .input(templateInputSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

      const spec = await resolveSpecForValidation(db, input.appKey);
      try {
        validateTemplateContract({
          appKey: input.appKey,
          bodyFields: input.bodyFields,
          specOverride: spec,
        });
      } catch (err) {
        throw toTrpcError(err);
      }

      await db.insert(destinationTemplates).values({
        name: input.name,
        description: input.description ?? null,
        color: input.color,
        category: input.category,
        appKey: input.appKey,
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
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

      const { id, ...fields } = input;

      // Patch semantics: an update may change appKey or bodyFields in
      // isolation, but the validator needs both together. Fetch the
      // current row and merge before validating.
      const willTouchContract =
        fields.appKey !== undefined || fields.bodyFields !== undefined;
      if (willTouchContract) {
        const [existing] = await db
          .select({
            appKey: destinationTemplates.appKey,
            bodyFields: destinationTemplates.bodyFields,
          })
          .from(destinationTemplates)
          .where(eq(destinationTemplates.id, id))
          .limit(1);
        if (!existing) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Template not found" });
        }

        const mergedAppKey = fields.appKey ?? existing.appKey ?? undefined;
        const mergedBodyFields =
          (fields.bodyFields as
            | Array<{ key: string; value: string; isSecret?: boolean }>
            | undefined) ??
          (existing.bodyFields as Array<{ key: string; value: string; isSecret?: boolean }>);

        const spec = await resolveSpecForValidation(db, mergedAppKey ?? null);
        try {
          validateTemplateContract({
            appKey: mergedAppKey,
            bodyFields: mergedBodyFields,
            specOverride: spec,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }

      const updates: Record<string, unknown> = {};
      if (fields.name !== undefined) updates.name = fields.name;
      if (fields.description !== undefined) updates.description = fields.description;
      if (fields.color !== undefined) updates.color = fields.color;
      if (fields.category !== undefined) updates.category = fields.category;
      if (fields.appKey !== undefined) updates.appKey = fields.appKey;
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
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });
      await db
        .delete(destinationTemplates)
        .where(eq(destinationTemplates.id, input.id));
      return { success: true };
    }),
});
