/**
 * AST node types and shared interfaces for the transform engine.
 *
 * Grammar (simplified):
 *   template   = (text | '{{' expr '}}')*
 *   expr       = binary
 *   binary     = primary (OP primary)*
 *   primary    = call | variable | string | number
 *   call       = IDENT '(' (expr (',' expr)*)? ')'
 *   variable   = IDENT
 */

export type BinaryOp = "==" | "!=" | "<" | ">" | "<=" | ">=" | "+";

export type Expr =
  | { kind: "text"; value: string }
  | { kind: "var"; name: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "call"; fn: string; args: Expr[] }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr };

/** Context passed to the evaluator — flat key/value map of available variables. */
export type EvalContext = Record<string, string | number | boolean | null | undefined>;

export interface PreviewResult {
  output: string;
  /** Variable names referenced in the template that are absent from ctx. */
  unknownVars: string[];
  /** Function names used that are not in the whitelist. */
  unknownFns: string[];
}
