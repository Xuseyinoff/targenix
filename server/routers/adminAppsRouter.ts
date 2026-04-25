/**
 * adminAppsRouter — Admin CRUD for the `apps` DB table.
 *
 * Apps are the authoritative catalogue of integration platforms the system can
 * connect to (affiliate networks, APIs, messaging services). Each row defines
 * `authType` + `fields[]` — the contract that templates and connections must
 * satisfy.
 *
 * Adding a new app row makes it immediately available to:
 *   • resolveSpecSafe     — delivery-time credential resolution
 *   • listAppsSafe        — admin template editor + connection wizard picker
 *   • validateTemplatesAtBoot — re-validates active templates on next deploy
 *
 * No deploy or migration required after creating a new app.
 *
 * Security: all routes require isAdmin (via adminProcedure).
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { apps, destinationTemplates } from "../../drizzle/schema";
import { eq, and, asc } from "drizzle-orm";

// ─── Validation schemas ───────────────────────────────────────────────────────

/**
 * Matches the same character class as SECRET_TOKEN_RE to ensure every
 * field key is referenceable inside a {{SECRET:key}} token without escaping.
 */
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * appKey format — lowercase, digits, hyphens, underscores; must start with a
 * letter or digit; 3–64 chars. Mirrors APP_KEY_RE in adminTemplatesRouter.
 */
const APP_KEY_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/;

const AUTH_TYPES = ["api_key", "oauth2", "bearer", "basic", "none"] as const;
const CATEGORIES = ["affiliate", "messaging", "data", "webhooks", "crm"] as const;

export const appFieldSchema = z.object({
  key: z
    .string()
    .regex(FIELD_KEY_RE, `Field key must match ${FIELD_KEY_RE} (lowercase, digits, underscores; start with letter)`),
  label: z.string().min(1, "label required").max(128),
  required: z.boolean(),
  sensitive: z.boolean(),
  validationRegex: z.string().max(256).optional(),
  helpText: z.string().max(512).optional(),
});

/**
 * Base shape without cross-field refinements or defaults — used as the
 * foundation for both create and update schemas. Refinements are applied
 * separately so Zod v4's `.omit()` / `.partial()` can operate on a plain
 * object schema. Defaults live only on the create schema so they don't
 * bleed into update patches (where an absent field means "don't change").
 */
const appBaseSchema = z.object({
  appKey: z
    .string()
    .regex(
      APP_KEY_RE,
      "appKey must be 3–64 chars, lowercase letters/digits/hyphens/underscores, start with letter or digit",
    ),
  displayName: z.string().min(1, "displayName required").max(128),
  authType: z.enum(AUTH_TYPES),
  category: z.enum(CATEGORIES),
  fields: z.array(appFieldSchema),
  iconUrl: z.string().url("iconUrl must be a valid URL").max(512).nullable().optional(),
  docsUrl: z.string().url("docsUrl must be a valid URL").max(512).nullable().optional(),
  isActive: z.boolean(),
});

/**
 * Validates the authType='none' / no-duplicate-field-keys invariants.
 * Applied to the create schema; the update handler re-checks them inline
 * after merging the patch with the existing row.
 */
function refineAppInput(
  data: { authType?: string; fields?: { key: string }[] },
  ctx: z.RefinementCtx,
) {
  if (data.authType === "none" && (data.fields?.length ?? 0) > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "authType='none' must have fields: [] — auth-less apps carry no credentials",
      path: ["fields"],
    });
  }
  const keys = data.fields?.map((f) => f.key) ?? [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate field key '${k}'`,
        path: ["fields"],
      });
      return;
    }
    seen.add(k);
  }
}

/** Full create schema — defaults applied here, not in the base schema. */
const createAppSchema = appBaseSchema
  .extend({ fields: z.array(appFieldSchema).default([]), isActive: z.boolean().default(true) })
  .superRefine(refineAppInput);

/** Patch schema for update — appKey immutable, everything else optional. */
const updateAppSchema = appBaseSchema
  .omit({ appKey: true })
  .partial()
  .extend({ appKey: z.string().min(1).max(64) });

// ─── Router ───────────────────────────────────────────────────────────────────

export const adminAppsRouter = router({
  /**
   * List all app rows, ordered by appKey. Returns all rows regardless of
   * isActive so admins can re-activate deactivated apps.
   */
  list: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db.select().from(apps).orderBy(asc(apps.appKey));
  }),

  /**
   * Create a new app in the `apps` table.
   *
   * Rejects with CONFLICT / APP_KEY_ALREADY_EXISTS if the appKey is already
   * taken (even for an inactive row — prevents silent shadowing).
   *
   * Returns { ok: true, appKey } on success. The new row is immediately
   * visible to resolveSpecSafe and listAppsSafe without a restart.
   */
  create: adminProcedure
    .input(createAppSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB not available",
        });
      }

      // Duplicate check — includes inactive rows to prevent silent shadowing.
      const [existing] = await db
        .select({ appKey: apps.appKey })
        .from(apps)
        .where(eq(apps.appKey, input.appKey))
        .limit(1);

      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `App '${input.appKey}' already exists. Use 'update' to modify it or pick a different appKey.`,
          cause: { code: "APP_KEY_ALREADY_EXISTS", appKey: input.appKey },
        });
      }

      await db.insert(apps).values({
        appKey: input.appKey,
        displayName: input.displayName,
        authType: input.authType,
        category: input.category,
        fields: input.fields,
        iconUrl: input.iconUrl ?? null,
        docsUrl: input.docsUrl ?? null,
        isActive: input.isActive,
      });

      return { ok: true as const, appKey: input.appKey };
    }),

  /**
   * Update fields on an existing app row. Patch semantics — only provided
   * fields are written. appKey itself is immutable (use delete + create).
   */
  update: adminProcedure
    .input(updateAppSchema)
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB not available",
        });
      }

      const { appKey, ...patch } = input;

      const [existing] = await db
        .select({ appKey: apps.appKey, authType: apps.authType })
        .from(apps)
        .where(eq(apps.appKey, appKey))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `App '${appKey}' not found.`,
        });
      }

      // If authType is being changed to/from 'none', re-run the cross-field check.
      const effectiveAuthType = patch.authType ?? existing.authType;
      if (effectiveAuthType === "none" && patch.fields && patch.fields.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "authType='none' must have fields: [] — auth-less apps carry no credentials",
        });
      }

      const updates: Record<string, unknown> = {};
      if (patch.displayName !== undefined) updates.displayName = patch.displayName;
      if (patch.authType !== undefined) updates.authType = patch.authType;
      if (patch.category !== undefined) updates.category = patch.category;
      if (patch.fields !== undefined) updates.fields = patch.fields;
      if (patch.iconUrl !== undefined) updates.iconUrl = patch.iconUrl;
      if (patch.docsUrl !== undefined) updates.docsUrl = patch.docsUrl;
      if (patch.isActive !== undefined) updates.isActive = patch.isActive;

      if (Object.keys(updates).length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No fields to update.",
        });
      }

      await db.update(apps).set(updates).where(eq(apps.appKey, appKey));
      return { ok: true as const, appKey };
    }),

  /**
   * Hard-delete an app row. Blocked when any active template still references
   * this appKey — deactivate the template first (prevents orphaned templates
   * that can never be re-validated at boot).
   */
  delete: adminProcedure
    .input(z.object({ appKey: z.string().min(1).max(64) }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB not available",
        });
      }

      // Safety guard: refuse if any active template uses this appKey.
      const [usedBy] = await db
        .select({ id: destinationTemplates.id, name: destinationTemplates.name })
        .from(destinationTemplates)
        .where(
          and(
            eq(destinationTemplates.appKey, input.appKey),
            eq(destinationTemplates.isActive, true),
          ),
        )
        .limit(1);

      if (usedBy) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            `App '${input.appKey}' is still referenced by active template id=${usedBy.id} "${usedBy.name}". ` +
            "Deactivate the template first, then delete the app.",
          cause: { code: "APP_IN_USE", appKey: input.appKey, templateId: usedBy.id },
        });
      }

      await db.delete(apps).where(eq(apps.appKey, input.appKey));
      return { ok: true as const, appKey: input.appKey };
    }),
});
