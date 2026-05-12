/**
 * Rename pass — switch the Drizzle column key `targetWebsiteId` → `destinationId`.
 *
 * Replaces:
 *   .targetWebsiteId                              → .destinationId  (property access)
 *   targetWebsiteId:  (in object literals)        → destinationId:
 *
 * Does NOT touch:
 *   SQL string literals like "targetWebsiteId" or `targetWebsiteId` — the
 *   underlying SQL column name stays the same. Only TS-side property
 *   access on Drizzle rows changes.
 *
 * Drizzle schema is already updated by hand; this pass migrates every caller.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude"]);
const SKIP_FILES = new Set(["drizzle/schema.ts"]); // already manually done

const replacements = [
  { from: /\.targetWebsiteId\b/g, to: ".destinationId" },
  // Object-literal property: `targetWebsiteId:` outside of strings.
  // Lookbehind for non-string context (avoid matching inside template strings).
  { from: /(^|[^"'`a-zA-Z0-9_$])targetWebsiteId(\s*:)/g, to: "$1destinationId$2" },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const roots = ["server", "client", "shared"];
let totalChanged = 0;
let totalEdits = 0;

for (const root of roots) {
  let files = [];
  try { files = walk(root); } catch { continue; }
  for (const f of files) {
    const rel = f.replace(/\\/g, "/");
    if (SKIP_FILES.has(rel)) continue;
    const before = readFileSync(f, "utf8");
    let after = before;
    let edits = 0;
    for (const { from, to } of replacements) {
      const m = after.match(from);
      if (m) {
        edits += m.length;
        after = after.replace(from, to);
      }
    }
    if (after !== before) {
      writeFileSync(f, after);
      totalChanged++;
      totalEdits += edits;
      console.log(`  ${rel}  (${edits} edits)`);
    }
  }
}

console.log(`\nDone — ${totalChanged} files, ${totalEdits} total edits.`);
