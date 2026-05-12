/**
 * Bulk-rename pass for migrations 0074+0075:
 *   adAccountsCache         → adAccounts
 *   AdAccountCache          → AdAccount
 *   InsertAdAccountCache    → InsertAdAccount
 *   campaignsCache          → campaigns
 *   CampaignCache           → Campaign
 *   InsertCampaignCache     → InsertCampaign
 *   adSetsCache             → adSets
 *   AdSetCache              → AdSet
 *   InsertAdSetCache        → InsertAdSet
 *   campaignInsightsCache   → campaignInsights
 *   CampaignInsightsCacheRow → CampaignInsights
 *   InsertCampaignInsightsCache → InsertCampaignInsights
 *   integrationHealth       → circuitBreakers
 *   integrationHealthEvents → circuitBreakerEvents
 *   IntegrationHealth       → CircuitBreaker
 *   IntegrationHealthEvent  → CircuitBreakerEvent
 *   InsertIntegrationHealth → InsertCircuitBreaker
 *   InsertIntegrationHealthEvent → InsertCircuitBreakerEvent
 *
 * Word-boundary matching (\b…\b) — never touches middle of an identifier.
 * Scope: server/, client/, shared/.
 * Excludes: drizzle/0*.sql, .claude/, tooling/, drizzle/meta/.
 *
 * Order matters: long forms first to avoid double-replacement.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude", "tooling"]);
const ROOTS = ["server", "client", "shared"];

// Order: longest pattern first (so InsertX renames before X).
const replacements = [
  // CampaignInsights — special: "Cache" is in the middle of "CampaignInsightsCache" suffix forms
  [/\bInsertCampaignInsightsCache\b/g, "InsertCampaignInsights"],
  [/\bCampaignInsightsCacheRow\b/g, "CampaignInsights"],
  [/\bcampaignInsightsCache\b/g, "campaignInsights"],

  // AdAccount
  [/\bInsertAdAccountCache\b/g, "InsertAdAccount"],
  [/\bAdAccountCache\b/g, "AdAccount"],
  [/\badAccountsCache\b/g, "adAccounts"],

  // Campaign
  [/\bInsertCampaignCache\b/g, "InsertCampaign"],
  [/\bCampaignCache\b/g, "Campaign"],
  [/\bcampaignsCache\b/g, "campaigns"],

  // AdSet
  [/\bInsertAdSetCache\b/g, "InsertAdSet"],
  [/\bAdSetCache\b/g, "AdSet"],
  [/\badSetsCache\b/g, "adSets"],

  // Circuit Breaker (events first — longer)
  [/\bInsertIntegrationHealthEvent\b/g, "InsertCircuitBreakerEvent"],
  [/\bIntegrationHealthEvent\b/g, "CircuitBreakerEvent"],
  [/\bintegrationHealthEvents\b/g, "circuitBreakerEvents"],

  [/\bInsertIntegrationHealth\b/g, "InsertCircuitBreaker"],
  [/\bIntegrationHealth\b/g, "CircuitBreaker"],
  [/\bintegrationHealth\b/g, "circuitBreakers"],
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
