import { z } from "zod";

/**
 * Make.com-like Action Schema (MVP).
 *
 * Goals:
 * - DB-driven (no per-app hardcode in backend)
 * - Safe validation (reject malformed schema early)
 * - Enough metadata for a form builder + mapping UI
 *
 * Non-goals (later phases):
 * - Full JSON Schema compatibility
 * - Complex transforms/functions
 * - Conditional fields and dynamic schema composition
 */

export const ACTION_SCHEMA_VERSION = 1 as const;

const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export type ActionFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "enum"
  | "object"
  | "array";

const fieldUiSchema = z
  .object({
    /** Default UI widget hint; clients may ignore or override. */
    widget: z.enum(["text", "textarea", "number", "checkbox", "select", "date", "datetime"]).optional(),
    /** When widget=select, this declares how the UI should load options. */
    optionsLoaderKey: z.string().min(1).max(128).optional(),
    /** Human-readable group/section name for the form. */
    group: z.string().min(1).max(64).optional(),
    /** Display order inside group. */
    order: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const actionFieldSchema: z.ZodType<{
  key: string;
  label: string;
  type: ActionFieldType;
  required: boolean;
  helpText?: string;
  /** For type=enum */
  enumValues?: Array<{ value: string; label: string }>;
  /** For type=object */
  properties?: unknown;
  /** For type=array */
  items?: unknown;
  /** UI hints */
  ui?: unknown;
}> = z
  .object({
    key: z.string().regex(FIELD_KEY_RE),
    label: z.string().min(1).max(128),
    type: z.enum(["string", "number", "boolean", "date", "datetime", "enum", "object", "array"]),
    required: z.boolean().default(false),
    helpText: z.string().max(512).optional(),

    enumValues: z
      .array(z.object({ value: z.string().min(1).max(128), label: z.string().min(1).max(128) }))
      .optional(),

    // Recursive structure (validated loosely in MVP; can be tightened later).
    properties: z.record(z.string(), z.any()).optional(),
    items: z.any().optional(),

    ui: fieldUiSchema.optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "enum") {
      if (!f.enumValues || f.enumValues.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enumValues required for type=enum", path: ["enumValues"] });
      }
    } else if (f.enumValues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enumValues only allowed for type=enum", path: ["enumValues"] });
    }

    if (f.type === "object") {
      if (!f.properties || typeof f.properties !== "object") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "properties required for type=object", path: ["properties"] });
      }
    }
    if (f.type !== "object" && f.properties) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "properties only allowed for type=object", path: ["properties"] });
    }

    if (f.type === "array") {
      if (f.items == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "items required for type=array", path: ["items"] });
      }
    }
    if (f.type !== "array" && f.items != null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "items only allowed for type=array", path: ["items"] });
    }
  });

export const actionSchemaSchema = z
  .object({
    version: z.literal(ACTION_SCHEMA_VERSION),
    title: z.string().min(1).max(128),
    description: z.string().max(500).optional(),
    inputs: z.array(actionFieldSchema).default([]),
    outputs: z.array(actionFieldSchema).default([]),
  })
  .superRefine((s, ctx) => {
    const keys = new Set<string>();
    for (const f of s.inputs) {
      if (keys.has(f.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate input field key '${f.key}'`, path: ["inputs"] });
        return;
      }
      keys.add(f.key);
    }
  })
  .strict();

export type ActionSchema = z.infer<typeof actionSchemaSchema>;

export function parseActionSchema(input: unknown): ActionSchema {
  return actionSchemaSchema.parse(input);
}

