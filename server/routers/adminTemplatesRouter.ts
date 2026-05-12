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
import { getDb, type DbClient } from "../db";
import { appActions, destinationTemplates } from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";
import { listDestinationTemplatesWithMirrorOverlay } from "../integrations/dynamicTemplateSource";
import {
  validateTemplateContract,
  TemplateContractError,
} from "../integrations/validateTemplateContract";
import { listAppKeyOptionsForPicker } from "../integrations/listAppsSafe";

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

// ─── app_actions mirror sync ────────────────────────────────────────────────
//
// destination_templates is the authoritative table for writes/ids, but
// dispatchDelivery's dynamicTemplateAdapter reads app_actions FIRST when
// a target_websites row references it by actionId (Stage 2 mirror,
// 2026-04-12). Before this helper existed, editing a template in the
// admin UI silently left the mirror stale — a fix to a Sotuvchi URL
// would show up in the admin list but never reach the live delivery
// path until somebody manually re-ran the backfill script.
//
// On create: if no mirror row exists for (appKey, "t<id>"), we let it
//   be — the dispatcher falls back to destination_templates and the
//   admin can opt into the mirror later via adminAppActionsRouter.
// On update: upsert the mirror so the dispatcher sees the new fields
//   immediately. Skip silently when there's no existing mirror row
//   AND the template wasn't previously mirrored.
// On delete: drop the mirror row to prevent orphans.
async function syncAppActionMirror(
  db: DbClient,
  templateId: number,
  data: {
    appKey: string;
    name: string;
    endpointUrl: string;
    method: string;
    contentType: string | null;
    bodyFields: unknown;
    userFields: unknown;
    variableFields: unknown;
    autoMappedFields: unknown;
    isActive: boolean;
  },
): Promise<void> {
  const legacyKey = `t${templateId}`;
  // Look for an existing mirror under either the legacy `t<id>` key or
  // the semantic synonyms documented in dynamicTemplateSource.ts. The
  // matched row's actionKey is preserved so we don't accidentally
  // rename it.
  const [existing] = await db
    .select({ id: appActions.id })
    .from(appActions)
    .where(and(eq(appActions.appKey, data.appKey), eq(appActions.actionKey, legacyKey)))
    .limit(1);

  if (!existing) {
    // No mirror today — don't auto-create one. Templates that should be
    // mirrored are seeded explicitly; auto-create here would conflict with
    // the admin's own taxonomy decisions (actionKey naming, isDefault).
    return;
  }

  await db
    .update(appActions)
    .set({
      name: data.name,
      endpointUrl: data.endpointUrl,
      method: data.method,
      contentType: data.contentType,
      bodyFields: data.bodyFields,
      userFields: data.userFields,
      variableFields: data.variableFields,
      autoMappedFields: data.autoMappedFields,
      isActive: data.isActive,
    })
    .where(eq(appActions.id, existing.id));
}

async function deleteAppActionMirror(
  db: DbClient,
  templateId: number,
  appKey: string,
): Promise<void> {
  const legacyKey = `t${templateId}`;
  await db
    .delete(appActions)
    .where(and(eq(appActions.appKey, appKey), eq(appActions.actionKey, legacyKey)));
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

      try {
        await validateTemplateContract({
          appKey: input.appKey,
          bodyFields: input.bodyFields,
          db,
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

        try {
          await validateTemplateContract({
            appKey: mergedAppKey,
            bodyFields: mergedBodyFields,
            db,
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

      // Mirror sync (best-effort): keep app_actions in lockstep so the
      // dispatcher's overlay reads the fresh values without a manual backfill.
      // We fetch the merged row once so the helper has every field in hand.
      try {
        const [merged] = await db
          .select()
          .from(destinationTemplates)
          .where(eq(destinationTemplates.id, id))
          .limit(1);
        if (merged && merged.appKey) {
          await syncAppActionMirror(db, id, {
            appKey: merged.appKey,
            name: merged.name,
            endpointUrl: merged.endpointUrl,
            method: merged.method,
            contentType: merged.contentType,
            bodyFields: merged.bodyFields,
            userFields: merged.userVisibleFields,
            variableFields: merged.variableFields,
            autoMappedFields: merged.autoMappedFields,
            isActive: merged.isActive,
          });
        }
      } catch (err) {
        // Don't fail the user-facing mutation on mirror sync errors —
        // the authoritative row is already updated. Log so admins can
        // spot the drift; the existing backfill script reconciles.
        console.warn(
          `[adminTemplatesRouter.update] app_actions mirror sync failed for templateId=${id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      return { success: true };
    }),

  /** Delete a destination template. */
  delete: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

      // Snapshot the appKey BEFORE deleting so we know which mirror row to
      // remove. Mirror sync is best-effort: if the delete succeeds but the
      // mirror removal fails, we log and move on — the template is gone so
      // the orphan app_actions row is inert (no targetWebsites reference it).
      const [snapshot] = await db
        .select({ appKey: destinationTemplates.appKey })
        .from(destinationTemplates)
        .where(eq(destinationTemplates.id, input.id))
        .limit(1);

      await db
        .delete(destinationTemplates)
        .where(eq(destinationTemplates.id, input.id));

      if (snapshot?.appKey) {
        try {
          await deleteAppActionMirror(db, input.id, snapshot.appKey);
        } catch (err) {
          console.warn(
            `[adminTemplatesRouter.delete] app_actions mirror cleanup failed for templateId=${input.id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return { success: true };
    }),
});
