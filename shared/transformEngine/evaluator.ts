/**
 * AST evaluator — walks an Expr[] and produces a string.
 *
 * All values are coerced to strings at the boundary (every expression
 * result is a string in the output). Missing variables and unknown
 * functions both soft-miss to "" — identical to the legacy injectVariables
 * contract, so existing integrations see no behaviour change.
 */

import type { Expr, EvalContext } from "./types";
import { FUNCTIONS } from "./functions";

export function evalExpr(expr: Expr, ctx: EvalContext): string {
  switch (expr.kind) {
    case "text":
      return expr.value;

    case "string":
      return expr.value;

    case "number":
      return String(expr.value);

    case "var": {
      const v = ctx[expr.name];
      return v === null || v === undefined ? "" : String(v);
    }

    case "binary": {
      const l = evalExpr(expr.left, ctx);
      const r = evalExpr(expr.right, ctx);
      switch (expr.op) {
        case "==":  return l === r ? "true" : "false";
        case "!=":  return l !== r ? "true" : "false";
        case "<":   return parseFloat(l) <  parseFloat(r) ? "true" : "false";
        case ">":   return parseFloat(l) >  parseFloat(r) ? "true" : "false";
        case "<=":  return parseFloat(l) <= parseFloat(r) ? "true" : "false";
        case ">=":  return parseFloat(l) >= parseFloat(r) ? "true" : "false";
        case "+": {
          const ln = parseFloat(l);
          const rn = parseFloat(r);
          // numeric if both operands are valid numbers; otherwise string concat
          return !isNaN(ln) && !isNaN(rn) && l.trim() !== "" && r.trim() !== ""
            ? String(ln + rn)
            : l + r;
        }
      }
      break;
    }

    case "call": {
      const fn = FUNCTIONS[expr.fn];
      if (!fn) return ""; // unknown function → soft miss
      const args = expr.args.map((a) => evalExpr(a, ctx));
      try {
        return fn(args, args);
      } catch {
        return "";
      }
    }
  }
  return "";
}

export function evalTemplate(nodes: Expr[], ctx: EvalContext): string {
  return nodes.map((n) => evalExpr(n, ctx)).join("");
}
