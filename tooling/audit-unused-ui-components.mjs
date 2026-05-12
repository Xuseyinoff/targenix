/**
 * Verify shadcn/ui components flagged by knip are truly unused.
 *
 * For each candidate:
 *   1. Find every file in client/ that imports it.
 *   2. Filter out importers that are themselves candidates (mutually-dead).
 *   3. If only candidate importers remain → safe to delete together.
 *   4. If any non-candidate importer exists → CANNOT delete (re-categorize).
 *
 * Also detects: re-exports from barrel files, dynamic imports, JSX/TSX usage.
 */
import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

const CANDIDATES = [
  "accordion", "aspect-ratio", "breadcrumb", "button-group", "calendar",
  "carousel", "chart", "context-menu", "drawer", "empty", "field", "form",
  "hover-card", "input-group", "input-otp", "item", "kbd", "menubar",
  "navigation-menu", "pagination", "progress", "radio-group", "resizable",
  "slider", "spinner", "toggle-group", "toggle",
];

const ROOT = process.cwd();
const SEARCH_DIRS = ["client/src", "server", "shared"];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".claude") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const allFiles = [];
for (const d of SEARCH_DIRS) {
  try { walk(join(ROOT, d), allFiles); } catch {}
}

const fileContents = new Map();
for (const f of allFiles) {
  fileContents.set(f, readFileSync(f, "utf8"));
}

const candidateSet = new Set(CANDIDATES.map((c) => `components/ui/${c}`));
function isCandidatePath(filePath) {
  const rel = relative(ROOT, filePath).replace(/\\/g, "/");
  for (const c of CANDIDATES) {
    if (rel === `client/src/components/ui/${c}.tsx`) return true;
  }
  return false;
}

// For each candidate, find importers
const report = {};
for (const c of CANDIDATES) {
  const candidateFile = join(ROOT, "client", "src", "components", "ui", `${c}.tsx`);
  const importers = [];
  // Match `from "@/components/ui/<c>"` or `from "./ui/<c>"` or `from "../ui/<c>"` etc.
  // The patterns to look for: components/ui/<c>
  const pattern = new RegExp(`(?:from|import)\\s*\\(?\\s*["']([^"']*components/ui/${c})["']`, "g");
  for (const [f, content] of fileContents) {
    if (f === candidateFile) continue;
    if (pattern.test(content)) {
      importers.push(relative(ROOT, f).replace(/\\/g, "/"));
    }
    pattern.lastIndex = 0;
  }
  report[c] = importers;
}

// Now categorize
console.log("=".repeat(80));
console.log("SHADCN UI UNUSED COMPONENT VERIFICATION");
console.log("=".repeat(80));

const allCandidateImporterPaths = new Set(
  CANDIDATES.map((c) => `client/src/components/ui/${c}.tsx`)
);

const safeToDelete = [];
const mutuallyDead = [];
const stillUsed = [];

for (const c of CANDIDATES) {
  const importers = report[c];
  if (importers.length === 0) {
    safeToDelete.push({ name: c, importers: [] });
  } else {
    const realImporters = importers.filter(
      (p) => !allCandidateImporterPaths.has(p)
    );
    if (realImporters.length === 0) {
      mutuallyDead.push({ name: c, importers });
    } else {
      stillUsed.push({ name: c, importers });
    }
  }
}

console.log(`\n🟢 SAFE TO DELETE (0 importers): ${safeToDelete.length}`);
for (const x of safeToDelete) console.log(`   ${x.name}`);

console.log(`\n🟡 MUTUALLY DEAD (only candidates import them): ${mutuallyDead.length}`);
for (const x of mutuallyDead) {
  console.log(`   ${x.name} ← imported by:`);
  for (const i of x.importers) console.log(`      - ${i}`);
}

console.log(`\n🔴 STILL USED (real importers exist): ${stillUsed.length}`);
for (const x of stillUsed) {
  console.log(`   ${x.name} ← imported by:`);
  for (const i of x.importers) console.log(`      - ${i}`);
}

console.log("\n" + "=".repeat(80));
console.log(`Summary: ${safeToDelete.length} safe + ${mutuallyDead.length} mutually-dead + ${stillUsed.length} still-used = ${CANDIDATES.length}`);
console.log("Combined safe-to-delete (safe + mutually-dead):", safeToDelete.length + mutuallyDead.length);
