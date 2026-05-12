/**
 * Second pass of 0074 rename — replace snake_case identifiers inside raw
 * SQL template strings that the camelCase pass missed.
 *
 *   integration_health_events → circuit_breaker_events
 *   integration_health        → circuit_breakers
 *   ad_accounts_cache         → ad_accounts
 *   campaigns_cache           → campaigns
 *   ad_sets_cache             → ad_sets
 *   campaign_insights_cache   → campaign_insights
 *
 * Word-boundary matching keeps prefix/suffix substrings safe.
 * Scope: server/, client/, shared/. Excludes tooling/, .claude/, drizzle/0*.sql.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude", "tooling"]);
const ROOTS = ["server", "client", "shared"];

// Order: longest first.
const replacements = [
  [/\bintegration_health_events\b/g, "circuit_breaker_events"],
  [/\bintegration_health\b/g, "circuit_breakers"],
  [/\bad_accounts_cache\b/g, "ad_accounts"],
  [/\bcampaigns_cache\b/g, "campaigns"],
  [/\bad_sets_cache\b/g, "ad_sets"],
  [/\bcampaign_insights_cache\b/g, "campaign_insights"],
];

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const files = [];
for (const r of ROOTS) walk(r, files);

let touched = 0;
let totalEdits = 0;
for (const f of files) {
  const before = readFileSync(f, "utf8");
  let after = before;
  let edits = 0;
  for (const [from, to] of replacements) {
    const m = after.match(from);
    if (m) { edits += m.length; after = after.replace(from, to); }
  }
  if (after !== before) {
    writeFileSync(f, after);
    touched++;
    totalEdits += edits;
    console.log(`  ${f.replace(/\\/g, "/")} — ${edits} edit(s)`);
  }
}
console.log(`\nDone — ${touched} files, ${totalEdits} total edits.`);
