/**
 * Rename pass — switch function names from "...Destinations" to "...Routes".
 *
 * Replaces (word-boundary):
 *   setIntegrationDestinations      → setIntegrationRoutes
 *   resolveIntegrationDestinations  → resolveIntegrationRoutes
 *   listIntegrationDestinations     → listIntegrationRoutes
 *   countIntegrationDestinations    → countIntegrationRoutes
 *
 * Stays (intentional):
 *   syncLegacyDestination — describes the legacy 1:1 single-destination
 *     mirror semantics; the word "Legacy" carries information that
 *     "Routes" would obscure. Keep.
 *
 * Run with: node tooling/bulk-rename-functions.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude"]);

const replacements = [
  { from: /\bsetIntegrationDestinations\b/g, to: "setIntegrationRoutes" },
  { from: /\bresolveIntegrationDestinations\b/g, to: "resolveIntegrationRoutes" },
  { from: /\blistIntegrationDestinations\b/g, to: "listIntegrationRoutes" },
  { from: /\bcountIntegrationDestinations\b/g, to: "countIntegrationRoutes" },
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
      console.log(`  ${f.replace(/\\/g, "/")}  (${edits} edits)`);
    }
  }
}

console.log(`\nDone — ${totalChanged} files, ${totalEdits} total edits.`);
