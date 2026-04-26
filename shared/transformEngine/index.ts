/**
 * Transform Engine — public API.
 *
 * Drop-in superset of the legacy `injectVariables` function:
 *   - {{varName}}                      → same behaviour as before
 *   - {{upper(name)}}                  → function call
 *   - {{concat(first, " ", last)}}     → multi-arg function
 *   - {{if(city == "Toshkent", "1", "2")}} → conditional with comparison
 *   - {{replace(phone, "+", "")}}      → text transformation
 *   - {{formatDate(createdAt, "DD.MM.YYYY")}} → date formatting
 *
 * Missing variables and unknown functions both return "" (soft miss) —
 * no exception is ever thrown from transform().
 *
 * Works identically in Node.js (server) and browser (client):
 * zero external dependencies, no Node-specific APIs.
 */

export { FUNCTIONS, FUNCTION_NAMES } from "./functions";
export type { EvalContext, Expr, PreviewResult } from "./types";

import { tokenize } from "./tokenizer";
import { parseTemplate } from "./parser";
import { evalTemplate, evalExpr } from "./evaluator";
import { FUNCTION_NAMES } from "./functions";
import type { EvalContext, Expr, PreviewResult } from "./types";

/**
 * Evaluate all {{...}} expressions in `template` and return the result string.
 * Backward compatible: {{simpleVar}} is resolved identically to the old regex path.
 */
export function transform(template: string, ctx: EvalContext): string {
  if (!template.includes("{{")) return template;
  const tokens = tokenize(template);
  const nodes = parseTemplate(tokens);
  return evalTemplate(nodes, ctx);
}

/**
 * Evaluate with diagnostics — returns output plus lists of unknown
 * variables and function names (useful for real-time preview UI).
 */
export function previewTemplate(template: string, ctx: EvalContext): PreviewResult {
  if (!template.includes("{{")) {
    return { output: template, unknownVars: [], unknownFns: [] };
  }
  const tokens = tokenize(template);
  const nodes = parseTemplate(tokens);

  const unknownVars = new Set<string>();
  const unknownFns = new Set<string>();

  function collect(expr: Expr): void {
    switch (expr.kind) {
      case "var":
        if (!(expr.name in ctx)) unknownVars.add(expr.name);
        break;
      case "call":
        if (!FUNCTION_NAMES.has(expr.fn)) unknownFns.add(expr.fn);
        expr.args.forEach(collect);
        break;
      case "binary":
        collect(expr.left);
        collect(expr.right);
        break;
    }
  }
  nodes.forEach(collect);

  return {
    output: evalTemplate(nodes, ctx),
    unknownVars: [...unknownVars],
    unknownFns: [...unknownFns],
  };
}

/**
 * Validate a template string without evaluating it.
 * Returns unknown function names (empty array = valid).
 */
export function validateTemplate(template: string): string[] {
  if (!template.includes("{{")) return [];
  const tokens = tokenize(template);
  const nodes = parseTemplate(tokens);
  const unknownFns = new Set<string>();

  function check(expr: Expr): void {
    if (expr.kind === "call") {
      if (!FUNCTION_NAMES.has(expr.fn)) unknownFns.add(expr.fn);
      expr.args.forEach(check);
    } else if (expr.kind === "binary") {
      check(expr.left);
      check(expr.right);
    }
  }
  nodes.forEach(check);
  return [...unknownFns];
}

/** Evaluate a single expression string (without surrounding {{ }}) — used by tests. */
export function evalOne(expr: string, ctx: EvalContext): string {
  return transform(`{{${expr}}}`, ctx);
}
