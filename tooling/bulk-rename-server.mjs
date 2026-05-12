/**
 * Bulk rename of TS symbols in server/ for the destinations refactor.
 *
 * Replaces (with strict word-boundary regex so SQL strings stay intact):
 *   - `targetWebsites`         → `destinations`
 *   - `integrationDestinations` → `integrationRoutes`
 *   - `TargetWebsite`          → `Destination`        (type)
 *   - `IntegrationDestination` → `IntegrationRoute`   (type)
 *   - `InsertTargetWebsite`    → `InsertDestination`
 *   - `InsertIntegrationDestination` → `InsertIntegrationRoute`
 *   - `ResolvedDestination`    → leave alone (it's a service helper, not the table type)
 *
 * Does NOT touch:
 *   - SQL string literals like "target_websites" (snake_case)
 *   - the `DestinationTemplate` type (different concept)
 *   - the alias file itself (drizzle/schema.ts) — handled separately
 *   - the service file with the function aliases — handled separately
 *
 * Run with:  node tooling/bulk-rename-server.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude"]);
// schema.ts and integrationDestinations.ts keep the alias mappings — touched
// manually after the bulk pass so the aliases land at the right line.
const SKIP_FILES = new Set([
  "drizzle/schema.ts",
  "server/services/integrationDestinations.ts",
]);

const replacements = [
  // Type names — must come BEFORE the table names so InsertTargetWebsite isn't
  // partially matched by targetWebsites.
  { from: /\bInsertTargetWebsite\b/g, to: "InsertDestination" },
  { from: /\bInsertIntegrationDestination\b/g, to: "InsertIntegrationRoute" },
  { from: /\bTargetWebsite\b/g, to: "Destination" },
  { from: /\bIntegrationDestination\b/g, to: "IntegrationRoute" },
  // Table objects (camelCase)
  { from: /\btargetWebsites\b/g, to: "destinations" },
  { from: /\bintegrationDestinations\b/g, to: "integrationRoutes" },
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

const files = walk("server");
let totalChanged = 0;
let totalEdits = 0;

for (const f of files) {
  const rel = f.replace(/\\/g, "/");
  if (SKIP_FILES.has(rel)) continue;
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
    console.log(`  ${rel}  (${edits} edits)`);
  }
}

console.log("");
console.log(`Done — ${totalChanged} files, ${totalEdits} total edits.`);
