/**
 * Recursive-descent parser — converts a token stream into an Expr[] (template nodes).
 *
 * Precedence (low → high):
 *   binary (==, !=, <, >, <=, >=, +)
 *   primary (call, variable, string, number)
 *
 * Error recovery: on unexpected tokens the parser emits an empty string
 * node and advances, so a malformed expression never throws at runtime.
 */

import type { Token, TokenKind } from "./tokenizer";
import type { BinaryOp, Expr } from "./types";

const BINARY_OPS: Partial<Record<TokenKind, BinaryOp>> = {
  EQ: "==", NEQ: "!=", LT: "<", GT: ">", LTE: "<=", GTE: ">=", PLUS: "+",
};

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: "EOF", value: "", pos: 0 };
  }
  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }
  private advance(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length) this.pos++;
    return t ?? { kind: "EOF", value: "", pos: 0 };
  }
  private eat(kind: TokenKind): Token | null {
    if (this.at(kind)) return this.advance();
    return null;
  }

  parseTemplate(): Expr[] {
    const nodes: Expr[] = [];
    while (!this.at("EOF")) {
      if (this.at("TEXT")) {
        nodes.push({ kind: "text", value: this.advance().value });
      } else if (this.at("LBRACE")) {
        this.advance(); // consume {{
        if (!this.at("RBRACE") && !this.at("EOF")) {
          nodes.push(this.parseExpr());
        }
        this.eat("RBRACE"); // consume }}
      } else {
        this.advance(); // skip unexpected token
      }
    }
    return nodes;
  }

  private parseExpr(): Expr {
    return this.parseBinary();
  }

  private parseBinary(): Expr {
    let left = this.parsePrimary();
    while (this.peek().kind in BINARY_OPS) {
      const opTok = this.advance();
      const op = BINARY_OPS[opTok.kind as keyof typeof BINARY_OPS]!;
      const right = this.parsePrimary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    if (t.kind === "STRING") {
      this.advance();
      return { kind: "string", value: t.value };
    }

    if (t.kind === "NUMBER") {
      this.advance();
      return { kind: "number", value: parseFloat(t.value) };
    }

    if (t.kind === "IDENT") {
      this.advance();
      if (this.at("LPAREN")) {
        // function call
        this.advance(); // (
        const args: Expr[] = [];
        while (!this.at("RPAREN") && !this.at("EOF") && !this.at("RBRACE")) {
          args.push(this.parseExpr());
          this.eat("COMMA");
        }
        this.eat("RPAREN");
        return { kind: "call", fn: t.value, args };
      }
      return { kind: "var", name: t.value };
    }

    // fallback for unexpected tokens inside expressions
    this.advance();
    return { kind: "string", value: "" };
  }
}

export function parseTemplate(tokens: Token[]): Expr[] {
  return new Parser(tokens).parseTemplate();
}
