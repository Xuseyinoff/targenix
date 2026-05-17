#!/usr/bin/env node
/**
 * check-journal-integrity.mjs — CI guard against migration drift.
 *
 * Wired into `pnpm check:journal` and the CI workflow.
 *
 * Fails (exit 1) if:
 *   1. Any disk `drizzle/NNNN_<tag>.sql` (excluding rollbacks and
 *      allowlisted historical orphans) has no matching entry in
 *      `drizzle/meta/_journal.json`.
 *   2. The journal's `idx` sequence is not strictly monotonic.
 *   3. Any journal entry's `tag` doesn't correspond to a disk file.
 *
 * Allowlisted orphans (see drizzle/MIGRATION_HISTORY.md):
 *   - 0025_password_reset_tokens.sql
 *   - 0027_destination_templates.sql
 *
 * Both are documented historical artifacts whose DDL was bundled into
 * the journal-listed migration of the same number; tracking them
 * separately would require backfilling the production
 * `__drizzle_migrations` table for no behavioural benefit.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const drizzleDir = join(repoRoot, "drizzle");
const journalPath = join(drizzleDir, "meta", "_journal.json");

const ALLOWLIST_MISSING = new Set([
  "0025_password_reset_tokens.sql",
  "0027_destination_templates.sql",
]);

const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const entries = journal.entries ?? [];

// Disk files: numbered NNNN_*.sql, excluding rollbacks.
const diskFiles = readdirSync(drizzleDir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.includes("_rollback_"));

const journalTags = new Set(entries.map((e) => e.tag));
const diskBaseNames = diskFiles.map((f) => f.replace(/\.sql$/, ""));

const errors = [];
const warnings = [];

// ── Check 1: every disk file has a journal entry (modulo allowlist) ─────────
for (const fileName of diskFiles) {
  const baseName = fileName.replace(/\.sql$/, "");
  if (journalTags.has(baseName)) continue;
  if (ALLOWLIST_MISSING.has(fileName)) {
    warnings.push(`allowlisted orphan: ${fileName} (see drizzle/MIGRATION_HISTORY.md)`);
    continue;
  }
  errors.push(`disk file has NO journal entry: ${fileName}`);
}

// ── Check 2: journal idx is strictly monotonic ──────────────────────────────
for (let i = 1; i < entries.length; i++) {
  const prev = entries[i - 1].idx;
  const curr = entries[i].idx;
  if (curr <= prev) {
    errors.push(`journal idx not monotonic: entry[${i}].idx=${curr} <= entry[${i - 1}].idx=${prev}`);
  }
}

// ── Check 3: every journal tag points to a real disk file ───────────────────
const diskBaseSet = new Set(diskBaseNames);
for (const entry of entries) {
  if (!diskBaseSet.has(entry.tag)) {
    errors.push(`journal entry references missing disk file: idx=${entry.idx} tag=${entry.tag}`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`[journal-check] journal entries: ${entries.length}`);
console.log(`[journal-check] disk files (non-rollback): ${diskFiles.length}`);
console.log(`[journal-check] allowlisted orphans: ${ALLOWLIST_MISSING.size}`);

if (warnings.length > 0) {
  console.log("");
  for (const w of warnings) console.log(`[journal-check] WARN: ${w}`);
}

if (errors.length > 0) {
  console.log("");
  for (const e of errors) console.error(`[journal-check] ERROR: ${e}`);
  console.error("");
  console.error(`[journal-check] FAILED — ${errors.length} integrity error(s).`);
  console.error("[journal-check] See drizzle/MIGRATION_HISTORY.md for the reconciliation process.");
  process.exit(1);
}

console.log("");
console.log("[journal-check] OK — journal and disk are consistent.");
