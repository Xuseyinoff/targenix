/**
 * Tokenizer for the transform engine template language.
 *
 * Two modes:
 *   OUTSIDE — accumulates plain text until {{ is encountered
 *   INSIDE  — tokenizes an expression until }} is encountered
 *
 * Tokens produced inside {{ }}:
 *   IDENT, STRING, NUMBER, LPAREN, RPAREN, COMMA,
 *   EQ(==), NEQ(!=), LTE(<=), GTE(>=), LT(<), GT(>), PLUS(+)
 *
 * Unknown characters inside expressions are silently skipped so that
 * legacy {{SECRET:key}} tokens (resolved before this point) degrade
 * gracefully to an empty string instead of throwing.
 */

export type TokenKind =
  | "TEXT"
  | "LBRACE"
  | "RBRACE"
  | "IDENT"
  | "STRING"
  | "NUMBER"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "EQ"
  | "NEQ"
  | "LTE"
  | "GTE"
  | "LT"
  | "GT"
  | "PLUS"
  | "EOF";

export interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

function isAlpha(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}
function isAlphaNum(ch: string): boolean {
  return isAlpha(ch) || (ch >= "0" && ch <= "9");
}
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let mode: "outside" | "inside" = "outside";

  while (i < source.length) {
    if (mode === "outside") {
      if (source[i] === "{" && source[i + 1] === "{") {
        tokens.push({ kind: "LBRACE", value: "{{", pos: i });
        i += 2;
        mode = "inside";
      } else {
        const start = i;
        while (i < source.length && !(source[i] === "{" && source[i + 1] === "{")) i++;
        if (i > start) tokens.push({ kind: "TEXT", value: source.slice(start, i), pos: start });
      }
      continue;
    }

    // ── INSIDE mode ───────────────────────────────────────────────────
    const ch = source[i]!;

    // whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }

    // closing }}
    if (ch === "}" && source[i + 1] === "}") {
      tokens.push({ kind: "RBRACE", value: "}}", pos: i });
      i += 2;
      mode = "outside";
      continue;
    }

    // two-char operators (check before single-char)
    if (ch === "=" && source[i + 1] === "=") { tokens.push({ kind: "EQ",  value: "==", pos: i }); i += 2; continue; }
    if (ch === "!" && source[i + 1] === "=") { tokens.push({ kind: "NEQ", value: "!=", pos: i }); i += 2; continue; }
    if (ch === "<" && source[i + 1] === "=") { tokens.push({ kind: "LTE", value: "<=", pos: i }); i += 2; continue; }
    if (ch === ">" && source[i + 1] === "=") { tokens.push({ kind: "GTE", value: ">=", pos: i }); i += 2; continue; }

    // single-char operators / punctuation
    if (ch === "<") { tokens.push({ kind: "LT",     value: "<", pos: i }); i++; continue; }
    if (ch === ">") { tokens.push({ kind: "GT",     value: ">", pos: i }); i++; continue; }
    if (ch === "+") { tokens.push({ kind: "PLUS",   value: "+", pos: i }); i++; continue; }
    if (ch === "(") { tokens.push({ kind: "LPAREN", value: "(", pos: i }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "RPAREN", value: ")", pos: i }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "COMMA",  value: ",", pos: i }); i++; continue; }

    // string literal (single or double quote)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i++;
      let str = "";
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < source.length) { i++; str += source[i++]; }
        else str += source[i++];
      }
      i++; // closing quote
      tokens.push({ kind: "STRING", value: str, pos: start });
      continue;
    }

    // number literal
    if (isDigit(ch)) {
      const start = i;
      while (i < source.length && (isDigit(source[i]!) || source[i] === ".")) i++;
      tokens.push({ kind: "NUMBER", value: source.slice(start, i), pos: start });
      continue;
    }

    // identifier
    if (isAlpha(ch)) {
      const start = i;
      while (i < source.length && isAlphaNum(source[i]!)) i++;
      tokens.push({ kind: "IDENT", value: source.slice(start, i), pos: start });
      continue;
    }

    // unknown character inside expression — skip silently (handles ':' in SECRET:key)
    i++;
  }

  tokens.push({ kind: "EOF", value: "", pos: source.length });
  return tokens;
}
