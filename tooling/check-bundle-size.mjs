#!/usr/bin/env node
/**
 * Bundle-size budget guard.
 *
 * Walks `dist/public/assets/` after `vite build` and asserts that the
 * gzipped size of every tracked entry stays under its budget. Catches
 * regressions before they ship — e.g. accidentally importing an entire
 * UI library into the landing page bundle.
 *
 * Budgets carry ~15% headroom over the current footprint, so small
 * iterations don't trip the alarm but a major regression (one new
 * heavy dep, a fat polyfill, a chunk-splitting misconfiguration)
 * does. When a budget legitimately grows, edit the value in this file
 * with a one-line PR.
 *
 * Usage:
 *   pnpm check:bundle-size       # exits 1 on violations
 *   pnpm check:bundle-size --json # machine-readable summary
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const ASSETS_DIR = join(process.cwd(), "dist", "public", "assets");

// File-name prefix → gzipped-size budget in KB. Vite emits hashed names
// (e.g. `index-B6TuM5mP.js`), so we match by prefix-before-the-hash.
//
// Numbers chosen 2026-05-12 from the live build output with ~15% headroom.
// Update deliberately when a chunk legitimately grows.
const BUDGETS_KB_GZIP = {
  "index": 100, // app entry, currently ~86 kb
  "vendor-charts": 135, // recharts, currently ~116 kb
  "vendor-ui": 45, // radix bundle, currently ~36 kb
  "vendor-query": 35, // tanstack-query + tRPC, currently ~27 kb
  "WorkflowCanvas": 70, // @xyflow/react, currently ~58 kb
  "landing": 55, // landing page, currently ~46 kb
  "IntegrationWizardV2": 25, // wizard, currently ~18 kb
  "TargetWebsites": 25, // destinations page, currently ~19 kb
  "Connections": 20, // connections page, currently ~16 kb
};

// Defensive ceiling for ANY chunk we don't have an explicit budget for.
// Catches accidental new chunks that bloat the build without anyone noticing.
const DEFAULT_BUDGET_KB_GZIP = 30;

const JSON_OUTPUT = process.argv.includes("--json");

function readAssetFiles() {
  try {
    return readdirSync(ASSETS_DIR).filter((f) => f.endsWith(".js"));
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      console.error(
        `bundle-size: ${ASSETS_DIR} not found — run \`vite build\` first.`,
      );
      process.exit(2);
    }
    throw err;
  }
}

function matchBudget(filename) {
  // Strip the hash + extension. Vite hashes are 8 chars from a
  // base64url-ish alphabet (alphanumeric plus `_` and `-`), so the
  // regex anchors to exactly 8 such chars before `.js`. A second
  // trim drops any trailing `-` left when a chunk name like
  // `landing` becomes `landing--xXj12Uk.js`.
  // Example: `vendor-charts-Ov59LHva.js` → `vendor-charts`
  // Example: `WorkflowCanvas-CX233I-_.js` → `WorkflowCanvas`
  // Example: `landing--xXj12Uk.js` → `landing`
  const base = filename
    .replace(/-[A-Za-z0-9_-]{8}\.js$/, "")
    .replace(/-+$/, "");
  if (Object.prototype.hasOwnProperty.call(BUDGETS_KB_GZIP, base)) {
    return { name: base, budgetKb: BUDGETS_KB_GZIP[base] };
  }
  return { name: base, budgetKb: DEFAULT_BUDGET_KB_GZIP };
}

const files = readAssetFiles();
const results = [];
let violations = 0;

for (const f of files) {
  const buf = readFileSync(join(ASSETS_DIR, f));
  const gz = gzipSync(buf, { level: 9 });
  const gzKb = gz.length / 1024;
  const rawKb = buf.length / 1024;
  const { name, budgetKb } = matchBudget(f);
  const over = gzKb > budgetKb;
  if (over) violations++;
  results.push({ file: f, name, rawKb, gzKb, budgetKb, over });
}

results.sort((a, b) => b.gzKb - a.gzKb);

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ violations, results }, null, 2));
} else {
  console.log("Bundle size report (sorted by gzip):");
  console.log("─".repeat(72));
  console.log(
    `${"File".padEnd(48)} ${"raw".padStart(8)} ${"gzip".padStart(8)} ${"budget".padStart(8)}`,
  );
  console.log("─".repeat(72));
  for (const r of results) {
    const flag = r.over ? "  ⚠ OVER" : "";
    console.log(
      `${r.file.padEnd(48)} ${r.rawKb.toFixed(1).padStart(6)}kb ${r.gzKb
        .toFixed(1)
        .padStart(6)}kb ${r.budgetKb.toFixed(0).padStart(6)}kb${flag}`,
    );
  }
  console.log("─".repeat(72));
  if (violations > 0) {
    console.error(`\n❌ ${violations} bundle(s) exceeded their gzipped budget.`);
    console.error(
      "If the growth is intentional, raise the limit in tooling/check-bundle-size.mjs with a justification in the PR description.",
    );
  } else {
    console.log("\n✅ All bundles within budget.");
  }
}

process.exit(violations > 0 ? 1 : 0);
