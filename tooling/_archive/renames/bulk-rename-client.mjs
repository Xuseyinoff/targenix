/**
 * Bulk rename of tRPC namespace + types in client/ for the destinations refactor.
 *
 *   `trpc.targetWebsites.*`       → `trpc.destinations.*`
 *   `utils.targetWebsites.*`      → `utils.destinations.*`  (react-query utils)
 *   `TargetWebsite` (type)        → `Destination`
 *   Other camelCase symbols are NOT touched on the client (the client doesn't
 *   import schema table objects directly).
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude"]);

const replacements = [
  { from: /\btrpc\.targetWebsites\b/g, to: "trpc.destinations" },
  { from: /\butils\.targetWebsites\b/g, to: "utils.destinations" },
  { from: /\bInsertTargetWebsite\b/g, to: "InsertDestination" },
  { from: /\bTargetWebsite\b/g, to: "Destination" },
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

const files = walk("client");
let totalChanged = 0;
let totalEdits = 0;

for (const f of files) {
  const before = readFileSync(f, "utf8");
  let after = before;
  let edits = 0;
  for (const { from, to } of replacements) {
    const matches = after.match(from);
    if (matches) {
      edits += matches.length;
      after = after.replace(from, to);
    }
  }
  if (after !== before) {
    writeFileSync(f, after);
    totalChanged++;
    totalEdits += edits;
    console.log(`  ${f.replace(/\\/g, "/")}  (${edits} edits)`);
  }
}

console.log(`\nDone — ${totalChanged} files, ${totalEdits} total edits.`);
