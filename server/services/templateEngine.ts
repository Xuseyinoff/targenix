/**
 * templateEngine.ts — Advanced expression engine for {{...}} placeholders.
 *
 * Syntax:
 *   {{trigger.phone}}                        — path lookup
 *   {{upper(trigger.name)}}                  — function call
 *   {{if(trigger.amount > 100, "VIP", "Normal")}}   — conditional
 *   {{concat(trigger.first, " ", trigger.last)}}    — string concat
 *   {{formatDate(trigger.createdAt, "DD.MM.YYYY")}} — date formatting
 *
 * Functions: upper, lower, trim, replace, concat, substring, split, length,
 *            contains, startsWith, endsWith, toString, toNumber, round, ceil,
 *            floor, abs, add, subtract, multiply, divide, if, switch, coalesce,
 *            not, join, first, last, get, keys, values, now, formatDate,
 *            parseJson, stringify, regexMatch, regexExtract, regexReplace
 */

export type TemplateContext = {
  trigger: Record<string, unknown>;
  steps:   Record<string | number, { output: unknown; status: string }>;
  vars:    Record<string, unknown>;
};

// ─── Tokenizer ────────────────────────────────────────────────────────────────

type Token =
  | { t: "str";  v: string }
  | { t: "num";  v: number }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "id";   v: string }
  | { t: "lp" } | { t: "rp" }
  | { t: "lb" } | { t: "rb" }
  | { t: "dot" } | { t: "comma" }
  | { t: "op";   v: string }
  | { t: "eof" };

function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }

    // String
    if (src[i] === '"' || src[i] === "'") {
      const q = src[i++]; let s = "";
      while (i < src.length && src[i] !== q) {
        s += src[i] === "\\" ? src[++i] : src[i];
        i++;
      }
      i++;
      toks.push({ t: "str", v: s }); continue;
    }

    // Number
    if (/[0-9]/.test(src[i])) {
      let n = "";
      while (i < src.length && /[0-9.]/.test(src[i])) n += src[i++];
      toks.push({ t: "num", v: parseFloat(n) }); continue;
    }

    // Two-char operators
    const two = src.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) {
      toks.push({ t: "op", v: two }); i += 2; continue;
    }

    // Single-char
    if ("+-*/<>!".includes(src[i])) { toks.push({ t: "op", v: src[i++] }); continue; }
    if (src[i] === "(") { toks.push({ t: "lp"    }); i++; continue; }
    if (src[i] === ")") { toks.push({ t: "rp"    }); i++; continue; }
    if (src[i] === "[") { toks.push({ t: "lb"    }); i++; continue; }
    if (src[i] === "]") { toks.push({ t: "rb"    }); i++; continue; }
    if (src[i] === ".") { toks.push({ t: "dot"   }); i++; continue; }
    if (src[i] === ",") { toks.push({ t: "comma" }); i++; continue; }

    // Identifier / keyword
    if (/[a-zA-Z_$]/.test(src[i])) {
      let id = "";
      while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i])) id += src[i++];
      if (id === "true")  { toks.push({ t: "bool", v: true  }); continue; }
      if (id === "false") { toks.push({ t: "bool", v: false }); continue; }
      if (id === "null")  { toks.push({ t: "null"           }); continue; }
      toks.push({ t: "id", v: id }); continue;
    }
    i++;
  }
  toks.push({ t: "eof" });
  return toks;
}

// ─── AST ──────────────────────────────────────────────────────────────────────

type Expr =
  | { k: "lit";  v: unknown }
  | { k: "path"; parts: string[] }
  | { k: "call"; name: string; args: Expr[] }
  | { k: "bin";  op: string; l: Expr; r: Expr }
  | { k: "un";   op: string; e: Expr };

const PREC: Record<string, number> = {
  "||": 1, "&&": 2,
  "==": 3, "!=": 3,
  ">": 4, "<": 4, ">=": 4, "<=": 4,
  "+": 5, "-": 5,
  "*": 6, "/": 6,
};

// ─── Parser ───────────────────────────────────────────────────────────────────

class Parser {
  private i = 0;
  constructor(private toks: Token[]) {}

  peek(): Token { return this.toks[this.i]; }
  next(): Token { return this.toks[this.i++]; }

  parse(minPrec = 0): Expr {
    let left = this.primary();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op") break;
      const prec = PREC[t.v];
      if (prec == null || prec < minPrec) break;
      this.next();
      const right = this.parse(prec + 1);
      left = { k: "bin", op: t.v, l: left, r: right };
    }
    return left;
  }

  primary(): Expr {
    const t = this.peek();

    // Unary
    if (t.t === "op" && (t.v === "!" || t.v === "-")) {
      this.next();
      return { k: "un", op: t.v, e: this.primary() };
    }

    // Literals
    if (t.t === "str")  { this.next(); return { k: "lit", v: t.v }; }
    if (t.t === "num")  { this.next(); return { k: "lit", v: t.v }; }
    if (t.t === "bool") { this.next(); return { k: "lit", v: t.v }; }
    if (t.t === "null") { this.next(); return { k: "lit", v: null }; }

    // Parenthesised group
    if (t.t === "lp") {
      this.next();
      const e = this.parse();
      if (this.peek().t === "rp") this.next();
      return e;
    }

    // Identifier → path or function call
    if (t.t === "id") {
      this.next();
      const name = t.v;

      // Function call: name(args...)
      if (this.peek().t === "lp") {
        this.next();
        const args: Expr[] = [];
        while (this.peek().t !== "rp" && this.peek().t !== "eof") {
          args.push(this.parse());
          if (this.peek().t === "comma") this.next();
        }
        if (this.peek().t === "rp") this.next();
        return { k: "call", name, args };
      }

      // Path: name.prop.prop[idx]...
      const parts: string[] = [name];
      for (;;) {
        if (this.peek().t === "dot") {
          this.next();
          const p = this.peek();
          if (p.t === "id")  { this.next(); parts.push(p.v); continue; }
          if (p.t === "num") { this.next(); parts.push(String(p.v)); continue; }
        }
        if (this.peek().t === "lb") {
          this.next();
          const p = this.peek();
          if (p.t === "num") { this.next(); parts.push(String(p.v)); }
          else if (p.t === "str") { this.next(); parts.push(p.v); }
          if (this.peek().t === "rb") this.next();
          continue;
        }
        break;
      }
      return { k: "path", parts };
    }

    return { k: "lit", v: null };
  }
}

// ─── Function library ─────────────────────────────────────────────────────────

type Fn = (args: unknown[]) => unknown;

const FN: Record<string, Fn> = {
  // String
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

  // Number
  toNumber:  a => Number(a[0]),
  round:     a => a[1] != null ? parseFloat(Number(a[0]).toFixed(Number(a[1]))) : Math.round(Number(a[0])),
  ceil:      a => Math.ceil(Number(a[0])),
  floor:     a => Math.floor(Number(a[0])),
  abs:       a => Math.abs(Number(a[0])),
  add:       a => Number(a[0]) + Number(a[1]),
  subtract:  a => Number(a[0]) - Number(a[1]),
  multiply:  a => Number(a[0]) * Number(a[1]),
  divide:    a => Number(a[1]) !== 0 ? Number(a[0]) / Number(a[1]) : null,

  // Logic
  if:       a => a[0] ? a[1] : a[2],
  not:      a => !a[0],
  coalesce: a => a.find(x => x != null) ?? null,
  switch:   a => {
    const [val, ...rest] = a;
    for (let i = 0; i + 1 < rest.length; i += 2) {
      if (val == rest[i]) return rest[i + 1];
    }
    return rest.length % 2 === 1 ? rest[rest.length - 1] : null;
  },

  // Array / Object
  join:    a => Array.isArray(a[0]) ? a[0].map(String).join(String(a[1] ?? ",")) : String(a[0] ?? ""),
  first:   a => Array.isArray(a[0]) ? a[0][0] ?? null : null,
  last:    a => Array.isArray(a[0]) ? a[0][a[0].length - 1] ?? null : null,
  slice:   a => Array.isArray(a[0]) ? a[0].slice(Number(a[1] ?? 0), a[2] != null ? Number(a[2]) : undefined) : [],
  get:     a => {
    if (Array.isArray(a[0]))  return a[0][Number(a[1])] ?? null;
    if (a[0] && typeof a[0] === "object") return (a[0] as Record<string, unknown>)[String(a[1] ?? "")] ?? null;
    return null;
  },
  keys:    a => a[0] && typeof a[0] === "object" ? Object.keys(a[0] as object) : [],
  values:  a => a[0] && typeof a[0] === "object" ? Object.values(a[0] as object) : [],
  includes: a => Array.isArray(a[0]) ? a[0].includes(a[1]) : String(a[0] ?? "").includes(String(a[1] ?? "")),

  // Date
  now:        () => new Date().toISOString(),
  formatDate: a => {
    if (a[0] == null) return "";
    const d = new Date(String(a[0]));
    if (isNaN(d.getTime())) return String(a[0]);
    return String(a[1] ?? "YYYY-MM-DD")
      .replace("YYYY", String(d.getFullYear()))
      .replace("MM",   String(d.getMonth() + 1).padStart(2, "0"))
      .replace("DD",   String(d.getDate()).padStart(2, "0"))
      .replace("HH",   String(d.getHours()).padStart(2, "0"))
      .replace("mm",   String(d.getMinutes()).padStart(2, "0"))
      .replace("ss",   String(d.getSeconds()).padStart(2, "0"));
  },
  toDate:     a => new Date(String(a[0])).toISOString(),

  // JSON
  parseJson:  a => { try { return JSON.parse(String(a[0])); } catch { return null; } },
  stringify:  a => JSON.stringify(a[0]),

  // Regex
  regexMatch:   a => new RegExp(String(a[1] ?? "")).test(String(a[0] ?? "")),
  regexExtract: a => {
    const m = String(a[0] ?? "").match(new RegExp(String(a[1] ?? "")));
    if (!m) return null;
    return a[2] != null ? m[Number(a[2])] ?? null : m[0] ?? null;
  },
  regexReplace: a => String(a[0] ?? "").replace(new RegExp(String(a[1] ?? ""), "g"), String(a[2] ?? "")),
};

// ─── Evaluator ────────────────────────────────────────────────────────────────

function resolvePath(obj: unknown, parts: string[]): unknown {
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function evalExpr(expr: Expr, ctx: TemplateContext): unknown {
  switch (expr.k) {
    case "lit":  return expr.v;

    case "path": {
      const root = { trigger: ctx.trigger, vars: ctx.vars, steps: ctx.steps } as Record<string, unknown>;
      return resolvePath(root, expr.parts) ?? null;
    }

    case "bin": {
      const l = evalExpr(expr.l, ctx);
      const r = evalExpr(expr.r, ctx);
      switch (expr.op) {
        case "+":  return typeof l === "string" || typeof r === "string"
                     ? String(l ?? "") + String(r ?? "")
                     : Number(l) + Number(r);
        case "-":  return Number(l) - Number(r);
        case "*":  return Number(l) * Number(r);
        case "/":  return Number(r) !== 0 ? Number(l) / Number(r) : null;
        case "==": return l == r;
        case "!=": return l != r;
        case ">":  return Number(l) > Number(r);
        case "<":  return Number(l) < Number(r);
        case ">=": return Number(l) >= Number(r);
        case "<=": return Number(l) <= Number(r);
        case "&&": return l && r;
        case "||": return l ?? r;
        default:   return null;
      }
    }

    case "un": {
      const v = evalExpr(expr.e, ctx);
      if (expr.op === "!") return !v;
      if (expr.op === "-") return -Number(v);
      return null;
    }

    case "call": {
      const fn = FN[expr.name];
      if (!fn) return `[fn:${expr.name}?]`;
      try { return fn(expr.args.map(a => evalExpr(a, ctx))); }
      catch { return null; }
    }
  }
}

function evalRaw(expression: string, ctx: TemplateContext): unknown {
  try {
    const tokens = tokenize(expression.trim());
    const ast    = new Parser(tokens).parse();
    return evalExpr(ast, ctx);
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;

export function resolveString(template: string, ctx: TemplateContext): string {
  return template.replace(PLACEHOLDER_RE, (_, expr: string) => {
    const val = evalRaw(expr, ctx);
    return val != null ? String(val) : "";
  });
}

export function resolveConfig(config: unknown, ctx: TemplateContext): unknown {
  if (typeof config === "string")  return resolveString(config, ctx);
  if (Array.isArray(config))       return config.map(item => resolveConfig(item, ctx));
  if (config !== null && typeof config === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
      out[k] = resolveConfig(v, ctx);
    }
    return out;
  }
  return config;
}

export function makeContext(triggerData?: Record<string, unknown>): TemplateContext {
  return { trigger: triggerData ?? {}, steps: {}, vars: {} };
}

/** Exported for tests / external use */
export { evalRaw as evaluateExpression };
