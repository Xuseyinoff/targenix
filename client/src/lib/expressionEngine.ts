// Client-side expression evaluator — mirrors server templateEngine for live preview.
// Intentionally self-contained (no server round-trip needed for preview).

// ─── Types ────────────────────────────────────────────────────────────────────

type Tok =
  | { k: "str";  v: string }
  | { k: "num";  v: number }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "id";   v: string }
  | { k: "op";   v: string }
  | { k: "lp" } | { k: "rp" }
  | { k: "lb" } | { k: "rb" }
  | { k: "dot" }
  | { k: "comma" };

type Expr =
  | { k: "lit";  v: unknown }
  | { k: "path"; parts: string[] }
  | { k: "call"; fn: string; args: Expr[] }
  | { k: "bin";  op: string; l: Expr; r: Expr }
  | { k: "un";   op: string; e: Expr };

export interface TemplateContext {
  trigger: Record<string, unknown>;
  vars:    Record<string, unknown>;
  [key: string]: unknown;
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    // whitespace
    if (/\s/.test(c)) { i++; continue; }

    // string
    if (c === '"' || c === "'") {
      const q = c; let s = ""; i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\" && i + 1 < src.length) { i++; s += src[i]; }
        else s += src[i];
        i++;
      }
      i++; // closing quote
      toks.push({ k: "str", v: s });
      continue;
    }

    // number
    if (/\d/.test(c) || (c === "-" && /\d/.test(src[i + 1] ?? ""))) {
      let n = c; i++;
      while (i < src.length && /[\d.]/.test(src[i])) { n += src[i]; i++; }
      toks.push({ k: "num", v: parseFloat(n) });
      continue;
    }

    // two-char ops
    const two = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) {
      toks.push({ k: "op", v: two }); i += 2; continue;
    }

    // single-char ops
    if ("+-*/<>!".includes(c)) { toks.push({ k: "op", v: c }); i++; continue; }

    // delimiters
    if (c === "(") { toks.push({ k: "lp" }); i++; continue; }
    if (c === ")") { toks.push({ k: "rp" }); i++; continue; }
    if (c === "[") { toks.push({ k: "lb" }); i++; continue; }
    if (c === "]") { toks.push({ k: "rb" }); i++; continue; }
    if (c === ".") { toks.push({ k: "dot" }); i++; continue; }
    if (c === ",") { toks.push({ k: "comma" }); i++; continue; }

    // identifier / keyword
    if (/[a-zA-Z_$]/.test(c)) {
      let id = "";
      while (i < src.length && /[\w$]/.test(src[i])) { id += src[i]; i++; }
      if (id === "true")  { toks.push({ k: "bool", v: true }); continue; }
      if (id === "false") { toks.push({ k: "bool", v: false }); continue; }
      if (id === "null")  { toks.push({ k: "null" }); continue; }
      toks.push({ k: "id", v: id });
      continue;
    }

    i++; // skip unknown
  }
  return toks;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

const PREC: Record<string, number> = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3,
  ">": 4, "<": 4, ">=": 4, "<=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6,
};

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  peek(): Tok | undefined { return this.toks[this.pos]; }
  next(): Tok | undefined { return this.toks[this.pos++]; }

  eat(k: Tok["k"]): boolean {
    if (this.peek()?.k === k) { this.pos++; return true; }
    return false;
  }

  parse(minPrec = 0): Expr {
    let left = this.primary();
    while (true) {
      const t = this.peek();
      if (!t || t.k !== "op") break;
      const prec = PREC[(t as { k: "op"; v: string }).v];
      if (prec === undefined || prec <= minPrec) break;
      this.next();
      const right = this.parse(prec);
      left = { k: "bin", op: (t as { k: "op"; v: string }).v, l: left, r: right };
    }
    return left;
  }

  primary(): Expr {
    const t = this.peek();
    if (!t) return { k: "lit", v: null };

    // unary !
    if (t.k === "op" && (t as { k: "op"; v: string }).v === "!") {
      this.next();
      return { k: "un", op: "!", e: this.primary() };
    }

    // parenthesized
    if (t.k === "lp") {
      this.next();
      const e = this.parse();
      this.eat("rp");
      return e;
    }

    // literals
    if (t.k === "str")  { this.next(); return { k: "lit", v: t.v }; }
    if (t.k === "num")  { this.next(); return { k: "lit", v: t.v }; }
    if (t.k === "bool") { this.next(); return { k: "lit", v: t.v }; }
    if (t.k === "null") { this.next(); return { k: "lit", v: null }; }

    // identifier: function call OR path
    if (t.k === "id") {
      this.next();
      const name = t.v;

      // function call
      if (this.peek()?.k === "lp") {
        this.next(); // eat (
        const args: Expr[] = [];
        if (this.peek()?.k !== "rp") {
          args.push(this.parse());
          while (this.peek()?.k === "comma") { this.next(); args.push(this.parse()); }
        }
        this.eat("rp");
        return { k: "call", fn: name, args };
      }

      // path: may chain with dots
      const parts = [name];
      while (this.peek()?.k === "dot") {
        this.next();
        const n = this.next();
        if (n?.k === "id") parts.push(n.v);
        // bracket access: obj[0] or obj["key"]
        else if (n?.k === "lb" || (this.peek()?.k === "lb")) {
          if (n?.k !== "lb") this.pos--; // re-read if we consumed wrong token
          const idx = this.next();
          if (idx?.k === "num")   { parts.push(String((idx as { k: "num"; v: number }).v)); this.eat("rb"); }
          else if (idx?.k === "str") { parts.push((idx as { k: "str"; v: string }).v); this.eat("rb"); }
          else this.eat("rb");
        }
      }
      // standalone bracket access on first identifier
      while (this.peek()?.k === "lb") {
        this.next();
        const idx = this.peek();
        if (idx?.k === "num")    { parts.push(String((idx as { k: "num"; v: number }).v)); this.next(); this.eat("rb"); }
        else if (idx?.k === "str") { parts.push((idx as { k: "str"; v: string }).v); this.next(); this.eat("rb"); }
        else this.eat("rb");
      }
      return { k: "path", parts };
    }

    return { k: "lit", v: null };
  }
}

// ─── Function library ─────────────────────────────────────────────────────────

type Fn = (args: unknown[]) => unknown;

function safeDateFormat(d: unknown, fmt: string): string {
  const date = d instanceof Date ? d : new Date(String(d ?? ""));
  if (isNaN(date.getTime())) return String(d ?? "");
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return fmt
    .replace("YYYY", String(date.getFullYear()))
    .replace("MM",   p(date.getMonth() + 1))
    .replace("DD",   p(date.getDate()))
    .replace("HH",   p(date.getHours()))
    .replace("mm",   p(date.getMinutes()))
    .replace("ss",   p(date.getSeconds()));
}

const FN: Record<string, Fn> = {
  upper:        a => String(a[0] ?? "").toUpperCase(),
  lower:        a => String(a[0] ?? "").toLowerCase(),
  trim:         a => String(a[0] ?? "").trim(),
  contains:     a => String(a[0] ?? "").includes(String(a[1] ?? "")),
  startsWith:   a => String(a[0] ?? "").startsWith(String(a[1] ?? "")),
  endsWith:     a => String(a[0] ?? "").endsWith(String(a[1] ?? "")),
  replace:      a => String(a[0] ?? "").replaceAll(String(a[1] ?? ""), String(a[2] ?? "")),
  substring:    a => String(a[0] ?? "").substring(Number(a[1] ?? 0), a[2] != null ? Number(a[2]) : undefined),
  split:        a => String(a[0] ?? "").split(String(a[1] ?? ",")),
  concat:       a => a.map(x => String(x ?? "")).join(""),
  padStart:     a => String(a[0] ?? "").padStart(Number(a[1] ?? 0), String(a[2] ?? " ")),
  str:          (a: unknown[]) => String(a[0] ?? ""),
  toString:     (a: unknown[]) => String(a[0] ?? ""),
  length:       a => Array.isArray(a[0]) ? a[0].length : String(a[0] ?? "").length,

  toNumber:     a => Number(a[0]),
  abs:          a => Math.abs(Number(a[0])),
  round:        a => parseFloat(Number(a[0]).toFixed(a[1] != null ? Number(a[1]) : 0)),
  floor:        a => Math.floor(Number(a[0])),
  ceil:         a => Math.ceil(Number(a[0])),
  min:          a => Math.min(...a.map(Number)),
  max:          a => Math.max(...a.map(Number)),

  if:           a => a[0] ? a[1] : a[2],
  not:          a => !a[0],
  and:          a => a.every(Boolean),
  or:           a => a.some(Boolean),
  coalesce:     a => a.find(x => x != null && x !== "") ?? null,
  switch:       a => {
    const val = a[0];
    for (let i = 1; i + 1 < a.length; i += 2) {
      if (a[i] === val) return a[i + 1];
    }
    return a.length % 2 === 0 ? a[a.length - 1] : null;
  },
  isEmpty:      a => a[0] == null || a[0] === "" || (Array.isArray(a[0]) && a[0].length === 0),
  isNotEmpty:   a => !(a[0] == null || a[0] === "" || (Array.isArray(a[0]) && a[0].length === 0)),
  equals:       a => a[0] === a[1],
  notEquals:    a => a[0] !== a[1],

  first:        a => Array.isArray(a[0]) ? a[0][0] : undefined,
  last:         a => Array.isArray(a[0]) ? a[0][a[0].length - 1] : undefined,
  get:          a => Array.isArray(a[0]) ? a[0][Number(a[1])] : undefined,
  join:         a => (Array.isArray(a[0]) ? a[0] : []).map(x => String(x ?? "")).join(String(a[1] ?? ",")),
  slice:        a => Array.isArray(a[0]) ? a[0].slice(Number(a[1] ?? 0), a[2] != null ? Number(a[2]) : undefined) : [],
  count:        a => Array.isArray(a[0]) ? a[0].length : 0,

  formatDate:   a => safeDateFormat(a[0], String(a[1] ?? "DD.MM.YYYY")),
  now:          () => new Date().toISOString(),
  addDays:      a => { const d = new Date(String(a[0] ?? "")); d.setDate(d.getDate() + Number(a[1] ?? 0)); return d.toISOString(); },

  parseJson:    a => { try { return JSON.parse(String(a[0] ?? "null")); } catch { return null; } },
  stringify:    a => JSON.stringify(a[0] ?? null),
  keys:         a => (a[0] && typeof a[0] === "object" && !Array.isArray(a[0])) ? Object.keys(a[0] as object) : [],
  values:       a => (a[0] && typeof a[0] === "object" && !Array.isArray(a[0])) ? Object.values(a[0] as object) : [],

  regexMatch:   a => new RegExp(String(a[1] ?? "")).test(String(a[0] ?? "")),
  regexExtract: a => { const m = String(a[0] ?? "").match(new RegExp(String(a[1] ?? ""))); return m ? (m[1] ?? m[0]) : null; },
  regexReplace: a => String(a[0] ?? "").replace(new RegExp(String(a[1] ?? ""), "g"), String(a[2] ?? "")),
};

// ─── Evaluator ────────────────────────────────────────────────────────────────

function getPath(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function evalExpr(expr: Expr, ctx: TemplateContext): unknown {
  switch (expr.k) {
    case "lit":  return expr.v;
    case "path": return getPath(ctx, expr.parts);
    case "un":   {
      const v = evalExpr(expr.e, ctx);
      if (expr.op === "!") return !v;
      return v;
    }
    case "bin":  {
      const l = evalExpr(expr.l, ctx);
      // short-circuit
      if (expr.op === "&&") return l ? evalExpr(expr.r, ctx) : l;
      if (expr.op === "||") return l ? l : evalExpr(expr.r, ctx);
      const r = evalExpr(expr.r, ctx);
      switch (expr.op) {
        case "==":  return l == r;
        case "!=":  return l != r;
        case ">":   return Number(l) > Number(r);
        case "<":   return Number(l) < Number(r);
        case ">=":  return Number(l) >= Number(r);
        case "<=":  return Number(l) <= Number(r);
        case "+":   return typeof l === "string" || typeof r === "string" ? String(l ?? "") + String(r ?? "") : Number(l) + Number(r);
        case "-":   return Number(l) - Number(r);
        case "*":   return Number(l) * Number(r);
        case "/":   return Number(r) !== 0 ? Number(l) / Number(r) : null;
      }
      return null;
    }
    case "call": {
      const fn = FN[expr.fn];
      if (!fn) return `[unknown fn: ${expr.fn}]`;
      const args = expr.args.map(a => evalExpr(a, ctx));
      try { return fn(args); } catch { return null; }
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function evaluateExpression(expr: string, ctx: TemplateContext): unknown {
  try {
    const toks = tokenize(expr);
    const ast  = new Parser(toks).parse();
    return evalExpr(ast, ctx);
  } catch {
    return `[expr error]`;
  }
}

/** Resolve a `{{...}}` template string with the given context. */
export function resolveTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{([\s\S]+?)\}\}/g, (_, raw: string) => {
    const val = evaluateExpression(raw.trim(), ctx);
    return val == null ? "" : String(val);
  });
}

/** Build a context object from trigger data. */
export function makePreviewContext(triggerData?: Record<string, unknown>): TemplateContext {
  return {
    trigger: triggerData ?? {},
    vars:    {},
  };
}

// ─── Function reference catalogue (for UI popovers) ──────────────────────────

export interface FnDef {
  name:      string;
  signature: string;
  desc:      string;
  example:   string;
}

export const FN_GROUPS: { group: string; fns: FnDef[] }[] = [
  {
    group: "String",
    fns: [
      { name: "upper",      signature: "upper(text)",                  desc: "Uppercase",                        example: '{{upper(trigger.name)}}' },
      { name: "lower",      signature: "lower(text)",                  desc: "Lowercase",                        example: '{{lower(trigger.name)}}' },
      { name: "trim",       signature: "trim(text)",                   desc: "Remove whitespace",                example: '{{trim(trigger.phone)}}' },
      { name: "replace",    signature: "replace(text, find, sub)",     desc: "Replace all occurrences",          example: '{{replace(trigger.name, " ", "_")}}' },
      { name: "substring",  signature: "substring(text, start, end?)", desc: "Extract substring",                example: '{{substring(trigger.name, 0, 5)}}' },
      { name: "split",      signature: "split(text, sep)",             desc: "Split into array",                 example: '{{split(trigger.tags, ",")}}' },
      { name: "concat",     signature: "concat(a, b, ...)",            desc: "Concatenate values",               example: '{{concat(trigger.first, " ", trigger.last)}}' },
      { name: "contains",   signature: "contains(text, sub)",          desc: "Check substring",                  example: '{{contains(trigger.email, "@")}}' },
      { name: "length",     signature: "length(text|array)",           desc: "Length of text or array",          example: '{{length(trigger.name)}}' },
      { name: "padStart",   signature: "padStart(text, n, char?)",     desc: "Pad text on left",                 example: '{{padStart(trigger.id, 5, "0")}}' },
    ],
  },
  {
    group: "Number",
    fns: [
      { name: "round",   signature: "round(n, decimals?)",  desc: "Round number",       example: '{{round(trigger.amount, 2)}}' },
      { name: "floor",   signature: "floor(n)",             desc: "Round down",         example: '{{floor(trigger.price)}}' },
      { name: "ceil",    signature: "ceil(n)",              desc: "Round up",           example: '{{ceil(trigger.price)}}' },
      { name: "abs",     signature: "abs(n)",               desc: "Absolute value",     example: '{{abs(trigger.diff)}}' },
      { name: "min",     signature: "min(a, b, ...)",       desc: "Minimum",            example: '{{min(trigger.a, trigger.b)}}' },
      { name: "max",     signature: "max(a, b, ...)",       desc: "Maximum",            example: '{{max(trigger.a, trigger.b)}}' },
      { name: "toNumber",signature: "toNumber(val)",        desc: "Parse as number",    example: '{{toNumber(trigger.amount)}}' },
    ],
  },
  {
    group: "Logic",
    fns: [
      { name: "if",       signature: "if(cond, then, else)",              desc: "Conditional",                    example: '{{if(trigger.amount > 100, "VIP", "Normal")}}' },
      { name: "switch",   signature: "switch(val, k1, v1, ..., default)", desc: "Multi-case switch",              example: '{{switch(trigger.status, "new", "Yangi", "paid", "To\'langan", "Noma\'lum")}}' },
      { name: "coalesce", signature: "coalesce(a, b, ...)",               desc: "First non-empty value",          example: '{{coalesce(trigger.phone, trigger.mobile, "N/A")}}' },
      { name: "not",      signature: "not(val)",                          desc: "Boolean NOT",                    example: '{{not(trigger.active)}}' },
      { name: "isEmpty",  signature: "isEmpty(val)",                      desc: "True if null/empty",             example: '{{isEmpty(trigger.phone)}}' },
      { name: "equals",   signature: "equals(a, b)",                     desc: "Strict equality",                example: '{{equals(trigger.status, "paid")}}' },
    ],
  },
  {
    group: "Array / Object",
    fns: [
      { name: "first",   signature: "first(array)",           desc: "First element",    example: '{{first(trigger.items)}}' },
      { name: "last",    signature: "last(array)",            desc: "Last element",     example: '{{last(trigger.items)}}' },
      { name: "get",     signature: "get(array, index)",      desc: "Element by index", example: '{{get(trigger.items, 0)}}' },
      { name: "join",    signature: "join(array, sep?)",      desc: "Array to string",  example: '{{join(trigger.tags, ", ")}}' },
      { name: "slice",   signature: "slice(array, start, end?)", desc: "Sub-array",    example: '{{slice(trigger.items, 0, 3)}}' },
      { name: "count",   signature: "count(array)",           desc: "Array length",    example: '{{count(trigger.items)}}' },
      { name: "keys",    signature: "keys(object)",           desc: "Object keys",     example: '{{keys(trigger.meta)}}' },
      { name: "values",  signature: "values(object)",         desc: "Object values",   example: '{{values(trigger.meta)}}' },
    ],
  },
  {
    group: "Date",
    fns: [
      { name: "formatDate", signature: "formatDate(date, format?)",  desc: "Format date (DD.MM.YYYY)",   example: '{{formatDate(trigger.createdAt, "DD.MM.YYYY")}}' },
      { name: "now",        signature: "now()",                      desc: "Current ISO timestamp",      example: '{{now()}}' },
      { name: "addDays",    signature: "addDays(date, n)",           desc: "Add days",                   example: '{{addDays(trigger.date, 7)}}' },
    ],
  },
  {
    group: "JSON",
    fns: [
      { name: "parseJson",  signature: "parseJson(text)",   desc: "Parse JSON string",   example: '{{parseJson(trigger.data)}}' },
      { name: "stringify",  signature: "stringify(val)",    desc: "Serialize to JSON",   example: '{{stringify(trigger.meta)}}' },
    ],
  },
  {
    group: "Regex",
    fns: [
      { name: "regexMatch",   signature: "regexMatch(text, pattern)",         desc: "True if pattern matches",   example: '{{regexMatch(trigger.phone, "^\\+998")}}' },
      { name: "regexExtract", signature: "regexExtract(text, pattern)",       desc: "Extract first match",       example: '{{regexExtract(trigger.text, "\\d+")}}' },
      { name: "regexReplace", signature: "regexReplace(text, pattern, sub)",  desc: "Replace by regex",          example: '{{regexReplace(trigger.phone, "\\s", "")}}' },
    ],
  },
];
