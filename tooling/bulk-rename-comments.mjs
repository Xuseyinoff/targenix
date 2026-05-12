/**
 * Pure-cosmetic cleanup pass — replace remaining legacy table/column names
 * in TS/TSX comments and JSDoc.
 *
 * Rules:
 *   - target_websites              → destinations
 *   - integration_destinations     → integration_routes
 *   - targetWebsiteId  (in comments only — code identifiers already renamed)
 *                                  → destinationId
 *
 * Scope: server/, client/, shared/, drizzle/schema.ts only.
 * Excludes: .claude/, tooling/, *.sql, drizzle/meta/, drizzle/0*.sql.
 *
 * Strategy: line-by-line. A line counts as "comment" if it starts (after
 * optional whitespace) with `//`, `*`, or `/*`. Anything else is left
 * alone — protects sql`...` template literals and string constants.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude", "tooling"]);
const ROOTS = ["server", "client", "shared"];
const EXTRA_FILES = ["drizzle/schema.ts"];

const replacements = [
  { from: /target_websites/g, to: "destinations" },
  { from: /integration_destinations/g, to: "integration_routes" },
  { from: /targetWebsiteId/g, to: "destinationId" },
];

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function isCommentLine(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function rewriteLine(line) {
  if (!isCommentLine(line)) return line;
  let out = line;
  for (const { from, to } of replacements) out = out.replace(from, to);
  return out;
}

const files = [];
for (const r of ROOTS) walk(r, files);
for (const f of EXTRA_FILES) files.push(f);

let changed = 0;
let touched = 0;
for (const f of files) {
  const before = readFileSync(f, "utf8");
  const lines = before.split(/\r?\n/);
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const out = lines.map(rewriteLine);
  const after = out.join(eol);
  if (after !== before) {
    let lineChanges = 0;
    for (let i = 0; i < lines.length; i++) if (lines[i] !== out[i]) lineChanges++;
    writeFileSync(f, after);
    changed++;
    touched += lineChanges;
    console.log(`  ${f.replace(/\\/g, "/")} — ${lineChanges} comment line(s)`);
  }
}
console.log(`\nDone — ${changed} files touched, ${touched} comment lines rewritten.`);
