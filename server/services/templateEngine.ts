/**
 * templateEngine.ts — Resolves {{path.to.value}} placeholders.
 *
 * Syntax: {{dotted.path}}
 * Context shape:
 *   {
 *     trigger: Record<string, unknown>,   // lead / webhook payload
 *     steps:   Record<string, unknown>,   // keyed by step position (0,1,2…) AND step name
 *     vars:    Record<string, unknown>,   // set_variable outputs
 *   }
 *
 * Examples:
 *   {{trigger.phone}}                 → trigger data field
 *   {{trigger.fullName}}
 *   {{steps.0.output.id}}             → step 0 output field
 *   {{steps.http_call.output.status}} → step named "http_call"
 *   {{vars.crmId}}                    → variable set by set_variable step
 */

export type TemplateContext = {
  trigger: Record<string, unknown>;
  steps:   Record<string | number, { output: unknown; status: string }>;
  vars:    Record<string, unknown>;
};

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

/**
 * Resolve a dot-path against an object. Returns undefined if any segment
 * is missing. Handles both array indices and object keys.
 */
function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * Resolve a single {{path}} expression against the context.
 * Returns the string representation, or an empty string if not found.
 */
function resolveExpression(expr: string, ctx: TemplateContext): string {
  const trimmed = expr.trim();

  // Fast paths for common prefixes
  if (trimmed.startsWith("trigger.")) {
    const field = trimmed.slice("trigger.".length);
    const val = resolvePath(ctx.trigger, field);
    return val !== undefined && val !== null ? String(val) : "";
  }

  if (trimmed.startsWith("vars.")) {
    const field = trimmed.slice("vars.".length);
    const val = resolvePath(ctx.vars, field);
    return val !== undefined && val !== null ? String(val) : "";
  }

  if (trimmed.startsWith("steps.")) {
    // steps.<key>.<rest>  — key can be a number (index) or a step name
    const rest = trimmed.slice("steps.".length);
    const dotIdx = rest.indexOf(".");
    if (dotIdx === -1) return "";
    const stepKey = rest.slice(0, dotIdx);
    const fieldPath = rest.slice(dotIdx + 1);
    const stepData = ctx.steps[stepKey] ?? ctx.steps[parseInt(stepKey, 10)];
    if (!stepData) return "";
    const val = resolvePath(stepData, fieldPath);
    return val !== undefined && val !== null ? String(val) : "";
  }

  // Top-level path fallback
  const val = resolvePath({ trigger: ctx.trigger, vars: ctx.vars, steps: ctx.steps }, trimmed);
  return val !== undefined && val !== null ? String(val) : "";
}

/**
 * Replace all {{...}} placeholders in a string value.
 */
export function resolveString(template: string, ctx: TemplateContext): string {
  return template.replace(PLACEHOLDER_RE, (_, expr: string) =>
    resolveExpression(expr, ctx)
  );
}

/**
 * Deep-clone a config object and resolve all string values containing {{...}}.
 * Non-string primitives are returned unchanged.
 * Arrays and nested objects are recursed into.
 */
export function resolveConfig(
  config: unknown,
  ctx: TemplateContext,
): unknown {
  if (typeof config === "string") {
    return resolveString(config, ctx);
  }
  if (Array.isArray(config)) {
    return config.map((item) => resolveConfig(item, ctx));
  }
  if (config !== null && typeof config === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
      out[k] = resolveConfig(v, ctx);
    }
    return out;
  }
  return config;
}

/**
 * Build an empty context (useful as starting point).
 */
export function makeContext(triggerData?: Record<string, unknown>): TemplateContext {
  return {
    trigger: triggerData ?? {},
    steps:   {},
    vars:    {},
  };
}
